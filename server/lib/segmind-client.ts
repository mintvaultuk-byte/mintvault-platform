/**
 * Segmind API client — Higgsfield dop-lite image-to-video.
 *
 * Used by the weekly-reel job to convert per-card display PNGs into short
 * cinematic clips that get stitched (later) into a single weekly highlight
 * reel. The job persists only the per-card video URLs in a JSON manifest;
 * actual reel assembly is out of scope for this version.
 *
 * Usage:
 *   const url = await imageToVideo(sourceImageUrl, "Cinematic slow reveal...");
 *
 * Behaviour:
 *   - POST https://api.segmind.com/v1/hfai-dop-lite with { image, prompt }
 *   - If the API responds synchronously with an output url, return it.
 *   - If the API responds with a request handle (request_id / poll_url),
 *     poll every POLL_INTERVAL_MS until status === "COMPLETED" (or "FAILED",
 *     or POLL_TIMEOUT_MS expires).
 *
 * SEGMIND_API_KEY comes from env. Throws on missing key, FAILED status,
 * non-2xx HTTP, or polling timeout — caller catches and logs per-card.
 */

const SEGMIND_BASE_URL = "https://api.segmind.com/v1";
const SEGMIND_MODEL_SLUG = "hfai-dop-lite";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

interface SegmindAsyncResponse {
  // Async-style response shape (best-effort — Segmind's API surface varies
  // per model). At least one of these fields is expected to be present.
  request_id?: string;
  poll_url?: string;
  status?: string;
  // Sync-style — some endpoints return the output URL directly on the POST.
  output?: string | { url?: string };
  video_url?: string;
  url?: string;
  // Echoed back for debugging.
  message?: string;
  error?: string;
}

interface SegmindPollResponse {
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | string;
  output?: string | { url?: string };
  video_url?: string;
  url?: string;
  error?: string;
  message?: string;
}

function requireKey(): string {
  const key = process.env.SEGMIND_API_KEY;
  if (!key) {
    throw new Error("SEGMIND_API_KEY missing — cannot call Segmind. Set the env var (Fly secret).");
  }
  return key;
}

// Pulls the "output video URL" out of whichever shape Segmind returned.
function extractOutputUrl(body: SegmindAsyncResponse | SegmindPollResponse): string | null {
  // Common shapes we accept:
  //   { output: "https://..." }
  //   { output: { url: "https://..." } }
  //   { video_url: "https://..." }
  //   { url: "https://..." }
  if (typeof body.output === "string") return body.output;
  if (body.output && typeof body.output === "object" && typeof body.output.url === "string") return body.output.url;
  if (typeof body.video_url === "string") return body.video_url;
  if (typeof body.url === "string") return body.url;
  return null;
}

async function postJson(url: string, body: object, apiKey: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function getJson(url: string, apiKey: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });
  let parsed: any;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function pollUntilDone(pollUrl: string, apiKey: string, deadlineMs: number): Promise<string> {
  // Returns the output URL when status === "COMPLETED". Throws on FAILED
  // status or when Date.now() crosses deadlineMs.
  while (true) {
    const { status, body } = await getJson(pollUrl, apiKey);
    if (status < 200 || status >= 300) {
      throw new Error(`Segmind poll non-2xx: ${status} ${JSON.stringify(body)}`);
    }
    const respStatus = String(body?.status ?? "").toUpperCase();
    if (respStatus === "COMPLETED") {
      const out = extractOutputUrl(body as SegmindPollResponse);
      if (!out) throw new Error(`Segmind COMPLETED but no output URL in response: ${JSON.stringify(body)}`);
      return out;
    }
    if (respStatus === "FAILED") {
      const reason = body?.error ?? body?.message ?? "unknown";
      throw new Error(`Segmind job FAILED: ${reason}`);
    }
    // QUEUED / PROCESSING / anything-else — keep polling within deadline.
    if (Date.now() > deadlineMs) {
      throw new Error(`Segmind poll timeout after ${POLL_TIMEOUT_MS}ms (last status=${respStatus})`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function imageToVideo(imageUrl: string, prompt: string): Promise<string> {
  const apiKey = requireKey();
  const url = `${SEGMIND_BASE_URL}/${SEGMIND_MODEL_SLUG}`;

  // Payload field naming follows Segmind convention — `image` for the
  // source URL, `prompt` for the text guidance. Exact accepted fields
  // may vary; if the API returns a 4xx flagging unknown fields, this is
  // the place to tweak.
  const { status, body } = await postJson(url, { image: imageUrl, prompt }, apiKey);
  if (status < 200 || status >= 300) {
    const reason = body?.error ?? body?.message ?? `HTTP ${status}`;
    throw new Error(`Segmind POST failed: ${reason}`);
  }

  // Sync-success path: some Segmind endpoints return the output URL on POST.
  const initialStatus = String(body?.status ?? "").toUpperCase();
  if (initialStatus === "" || initialStatus === "COMPLETED") {
    const direct = extractOutputUrl(body as SegmindAsyncResponse);
    if (direct) return direct;
  }
  if (initialStatus === "FAILED") {
    const reason = body?.error ?? body?.message ?? "unknown";
    throw new Error(`Segmind job FAILED on submit: ${reason}`);
  }

  // Async-poll path. We accept either an explicit poll_url or a request_id
  // we can construct the poll URL from. The Segmind convention is
  //   GET /v1/requests/{request_id}
  // but we honour an explicit poll_url if the API provides one (future-
  // proofs against breaking changes to the endpoint shape).
  const pollUrl = body?.poll_url
    ?? (body?.request_id ? `${SEGMIND_BASE_URL}/requests/${body.request_id}` : null);
  if (!pollUrl) {
    throw new Error(`Segmind response has no output, poll_url, or request_id: ${JSON.stringify(body)}`);
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  return pollUntilDone(pollUrl, apiKey, deadline);
}
