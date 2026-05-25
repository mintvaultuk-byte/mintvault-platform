/**
 * Pinterest API v5 — video pin publishing.
 *
 * Reads:
 *   PINTEREST_ACCESS_TOKEN  — OAuth bearer
 *   PINTEREST_BOARD_ID      — board ID (caller can also pass an override)
 *
 * Pinterest accepts a remote media URL via media_source.source_type =
 * "video_id" (after a separate media upload), but for short clips the
 * simplest path is to pass the source video URL directly via the
 * "image_url" + "video_url" combo on /v5/pins. We use the recommended
 * media_source pattern: source_type=video_id requires uploading first
 * (/v5/media), so we do that two-step.
 *
 * Missing creds throw TOKEN_NOT_CONFIGURED.
 */

export const TOKEN_NOT_CONFIGURED = "token_not_configured";

const PIN_BASE = "https://api.pinterest.com";

function requireToken(): string {
  const t = process.env.PINTEREST_ACCESS_TOKEN;
  if (!t) throw new Error(TOKEN_NOT_CONFIGURED);
  return t;
}

async function pinFetch(path: string, init: RequestInit & { token: string }): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${init.token}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${PIN_BASE}${path}`, { ...init, headers });
  const json = await res.json().catch(() => ({}) as any);
  if (!res.ok) throw new Error(`Pinterest ${path} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/** Upload a video to Pinterest's media service and poll until status=succeeded.
 *  Returns the media_id usable as a pin source. */
async function uploadVideoToPinterest(token: string, videoUrl: string): Promise<string> {
  // Step 1: register an upload. Response contains upload_url + upload_parameters
  // for the actual binary upload (AWS S3-style POST form).
  const reg = await pinFetch("/v5/media", {
    method: "POST",
    token,
    body: JSON.stringify({ media_type: "video" }),
  });
  const mediaId: string = reg.media_id;
  const uploadUrl: string = reg.upload_url;
  const uploadParams: Record<string, string> = reg.upload_parameters ?? {};
  if (!mediaId || !uploadUrl) throw new Error("Pinterest /media returned no upload target");

  // Fetch source.
  const src = await fetch(videoUrl);
  if (!src.ok) throw new Error(`Pinterest source fetch ${src.status}`);
  const buf = Buffer.from(await src.arrayBuffer());

  // POST multipart form to upload_url with upload_parameters + file.
  const form = new FormData();
  for (const [k, v] of Object.entries(uploadParams)) form.append(k, v);
  form.append("file", new Blob([new Uint8Array(buf)]), "video.mp4");
  const upRes = await fetch(uploadUrl, { method: "POST", body: form });
  if (!upRes.ok) {
    const t = await upRes.text().catch(() => "");
    throw new Error(`Pinterest upload ${upRes.status}: ${t.slice(0, 200)}`);
  }

  // Poll for status=succeeded.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const stat = await pinFetch(`/v5/media/${encodeURIComponent(mediaId)}`, { method: "GET", token });
    const status = String(stat.status ?? "").toLowerCase();
    if (status === "succeeded") return mediaId;
    if (status === "failed") throw new Error("Pinterest media processing failed");
    await new Promise<void>((res) => setTimeout(res, 3_000));
  }
  throw new Error("Pinterest media processing timed out");
}

export async function publishToPinterest(
  videoUrl: string,
  title: string,
  description: string,
  boardId: string
): Promise<{ postId: string }> {
  const token = requireToken();
  const board = boardId || process.env.PINTEREST_BOARD_ID;
  if (!board) throw new Error("Pinterest board id missing");

  const mediaId = await uploadVideoToPinterest(token, videoUrl);

  const pin = await pinFetch("/v5/pins", {
    method: "POST",
    token,
    body: JSON.stringify({
      board_id: board,
      title: title.slice(0, 100),
      description: description.slice(0, 800),
      media_source: { source_type: "video_id", media_id: mediaId },
    }),
  });
  const postId: string = pin.id;
  if (!postId) throw new Error("Pinterest /pins returned no id");
  return { postId };
}

export interface PinterestTokenStatus {
  valid: boolean;
  username: string | null;
}

export async function getPinterestTokenStatus(): Promise<PinterestTokenStatus> {
  const token = process.env.PINTEREST_ACCESS_TOKEN;
  if (!token) return { valid: false, username: null };
  try {
    const res = await fetch(`${PIN_BASE}/v5/user_account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { valid: false, username: null };
    const json = await res.json().catch(() => ({}) as any);
    return { valid: true, username: json?.username ?? null };
  } catch {
    return { valid: false, username: null };
  }
}

export function pinterestConfigured(): boolean {
  return !!process.env.PINTEREST_ACCESS_TOKEN;
}
