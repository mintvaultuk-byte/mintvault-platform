/**
 * Meta Graph API Instagram publisher.
 *
 * Two-step Meta protocol:
 *   1. POST /{ig-user-id}/media     → create a media container (image URL + caption)
 *   2. POLL  /{container-id}        → wait for status_code === FINISHED
 *   3. POST /{ig-user-id}/media_publish → publish the prepared container
 *
 * Meta requires the image to live at a publicly-accessible URL (R2 signed
 * URLs work, but the link MUST be reachable for at least the polling window).
 * We use a 1-hour signed URL — generous so Meta has time to fetch the image
 * during container processing.
 *
 * Gating: IG_POST_ENABLED=false short-circuits to a dry-run return ("dry-run")
 * BEFORE any external API call. This means setting the env var to anything
 * other than the literal string "true" keeps the bot silent — there is no
 * accidental publish path.
 */
import { uploadToR2, getR2SignedUrl } from "../r2";

const META_TIMEOUT_MS = 30_000;
const CONTAINER_POLL_INTERVAL_MS = 3000;
const CONTAINER_MAX_ATTEMPTS = 10;     // ≈ 30s total

export interface PostToIgArgs {
  imageBuffer: Buffer;
  caption: string;
  hashtags: string;
  r2Key?: string;  // optional — caller may have already uploaded; if not we upload here
}

export interface PostToIgResult {
  metaPostId: string;
  imageUrl: string;
  r2Key: string;
}

function metaEnv() {
  const igUserId = process.env.META_IG_USER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  const apiVersion = process.env.META_API_VERSION ?? "v19.0";
  if (!igUserId || !accessToken) {
    throw new Error(
      "Meta credentials missing — set META_IG_USER_ID and META_ACCESS_TOKEN in env",
    );
  }
  return {
    igUserId,
    accessToken,
    baseUrl: `https://graph.facebook.com/${apiVersion}`,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = META_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureImageInR2(args: PostToIgArgs): Promise<{ r2Key: string; imageUrl: string }> {
  const r2Key = args.r2Key ?? `ig/uploaded/${Date.now()}.png`;
  if (!args.r2Key) {
    await uploadToR2(r2Key, args.imageBuffer, "image/png");
  }
  // 1-hour signed URL — Meta fetches the image during container processing.
  const imageUrl = await getR2SignedUrl(r2Key, 60 * 60);
  return { r2Key, imageUrl };
}

async function createContainer(imageUrl: string, fullCaption: string): Promise<string> {
  const { igUserId, accessToken, baseUrl } = metaEnv();
  const res = await fetchWithTimeout(
    `${baseUrl}/${igUserId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url:    imageUrl,
        caption:      fullCaption,
        access_token: accessToken,
      }),
    },
  );
  const body = (await res.json()) as { id?: string; error?: { message?: string; code?: number } };
  if (!res.ok || !body.id) {
    throw new Error(`Meta container creation failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.id;
}

async function waitForContainerReady(containerId: string): Promise<void> {
  const { accessToken, baseUrl } = metaEnv();
  for (let i = 0; i < CONTAINER_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, CONTAINER_POLL_INTERVAL_MS));
    const res = await fetchWithTimeout(
      `${baseUrl}/${containerId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`,
      { method: "GET" },
    );
    const body = (await res.json()) as { status_code?: string; error?: unknown };
    if (body.status_code === "FINISHED") return;
    if (body.status_code === "ERROR") {
      throw new Error(`Meta container processing returned ERROR: ${JSON.stringify(body)}`);
    }
    // Otherwise: IN_PROGRESS / PUBLISHED / etc — keep polling.
  }
  throw new Error(`Meta container ${containerId} did not finish after ${CONTAINER_MAX_ATTEMPTS} polls`);
}

async function publishContainer(containerId: string): Promise<string> {
  const { igUserId, accessToken, baseUrl } = metaEnv();
  const res = await fetchWithTimeout(
    `${baseUrl}/${igUserId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id:  containerId,
        access_token: accessToken,
      }),
    },
  );
  const body = (await res.json()) as { id?: string; error?: unknown };
  if (!res.ok || !body.id) {
    throw new Error(`Meta publish failed: ${JSON.stringify(body.error ?? body)}`);
  }
  return body.id;
}

/**
 * Main entry. Returns either a real Meta post ID (e.g. "17841409xxxxxxxxx_18012345…")
 * or the literal sentinel "dry-run" when posting is disabled.
 *
 * Throws on any external failure — caller (the cron job) is expected to
 * catch and write the error to ig_post_queue.error_detail.
 */
export async function postToInstagram(args: PostToIgArgs): Promise<PostToIgResult | { metaPostId: "dry-run" }> {
  if (process.env.IG_POST_ENABLED !== "true") {
    console.log("[ig-meta] IG_POST_ENABLED is not 'true' — skipping live publish");
    return { metaPostId: "dry-run" };
  }
  if (process.env.IG_DRY_RUN === "true") {
    console.log("[ig-meta] IG_DRY_RUN=true — skipping live publish");
    return { metaPostId: "dry-run" };
  }

  const { r2Key, imageUrl } = await ensureImageInR2(args);
  const fullCaption = args.hashtags ? `${args.caption}\n\n${args.hashtags}` : args.caption;

  console.log(`[ig-meta] Creating container for image ${r2Key}…`);
  const containerId = await createContainer(imageUrl, fullCaption);
  console.log(`[ig-meta] Container ${containerId} created — polling for FINISHED…`);
  await waitForContainerReady(containerId);
  console.log(`[ig-meta] Container ${containerId} ready — publishing…`);
  const metaPostId = await publishContainer(containerId);
  console.log(`[ig-meta] Published as ${metaPostId}`);

  return { metaPostId, imageUrl, r2Key };
}
