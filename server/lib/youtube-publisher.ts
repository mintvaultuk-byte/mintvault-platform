/**
 * YouTube Data API v3 — Shorts publishing.
 *
 * Reads:
 *   YOUTUBE_ACCESS_TOKEN  — OAuth 2.0 access token with youtube.upload scope
 *   YOUTUBE_CHANNEL_ID    — channel ID (used only by status endpoint)
 *
 * Flow:
 *   1. POST /upload/youtube/v3/videos?uploadType=resumable with metadata.
 *   2. Server responds with a Location header — that's the resumable
 *      upload URL.
 *   3. PUT the video bytes (fetched from our R2/Segmind URL) to that
 *      Location. Single-shot PUT since the clips are small (<50MB).
 *
 * Missing token throws TOKEN_NOT_CONFIGURED — route layer converts to 200.
 */

export const TOKEN_NOT_CONFIGURED = "token_not_configured";

const YT_UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";
const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

function requireToken(): string {
  const t = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!t) throw new Error(TOKEN_NOT_CONFIGURED);
  return t;
}

export async function publishToYouTube(
  videoUrl: string,
  title: string,
  description: string
): Promise<{ postId: string }> {
  const token = requireToken();

  // 1. Fetch the source video bytes.
  const src = await fetch(videoUrl);
  if (!src.ok) throw new Error(`Source video fetch ${src.status}`);
  const videoBuf = Buffer.from(await src.arrayBuffer());

  // 2. Init resumable upload. The metadata goes in the body as JSON;
  // server returns a Location header to PUT the bytes to.
  const initBody = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 5000),
      categoryId: "24",
    },
    status: {
      privacyStatus: "public",
      madeForKids: false,
      selfDeclaredMadeForKids: false,
    },
  };
  const initRes = await fetch(`${YT_UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/*",
      "X-Upload-Content-Length": String(videoBuf.byteLength),
    },
    body: JSON.stringify(initBody),
  });
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => "");
    throw new Error(`YouTube init ${initRes.status}: ${text.slice(0, 200)}`);
  }
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube init: no Location header");

  // 3. Single-shot PUT.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "video/*", "Content-Length": String(videoBuf.byteLength) },
    body: videoBuf,
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => "");
    throw new Error(`YouTube PUT ${putRes.status}: ${text.slice(0, 200)}`);
  }
  const json = await putRes.json().catch(() => ({}) as any);
  const postId: string = json.id;
  if (!postId) throw new Error("YouTube PUT returned no video id");
  return { postId };
}

export interface YouTubeTokenStatus {
  valid: boolean;
  channelId: string | null;
}

export async function getYouTubeTokenStatus(): Promise<YouTubeTokenStatus> {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  const channelId = process.env.YOUTUBE_CHANNEL_ID ?? null;
  if (!token) return { valid: false, channelId };
  try {
    const res = await fetch(`${YT_API_BASE}/channels?part=id&mine=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { valid: res.ok, channelId };
  } catch {
    return { valid: false, channelId };
  }
}

export function youtubeConfigured(): boolean {
  return !!process.env.YOUTUBE_ACCESS_TOKEN;
}
