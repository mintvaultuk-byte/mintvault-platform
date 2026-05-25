/**
 * Twitter / X API v2 — video tweet via chunked v1.1 media upload + v2
 * tweet create. The user-context endpoints still want OAuth 1.0a request
 * signing, so we build the signature inline using node:crypto (no extra
 * deps — `oauth-1.0a` etc. would be cleaner but adding a package needs
 * approval).
 *
 * Reads:
 *   TWITTER_API_KEY        — consumer key
 *   TWITTER_API_SECRET     — consumer secret
 *   TWITTER_ACCESS_TOKEN   — user access token
 *   TWITTER_ACCESS_SECRET  — user access secret
 *
 * Chunked upload flow per Twitter docs:
 *   1. INIT     POST media/upload.json  (command=INIT, total_bytes, media_type, media_category=tweet_video)
 *   2. APPEND   POST media/upload.json  (command=APPEND, media_id, segment_index, media)
 *   3. FINALIZE POST media/upload.json  (command=FINALIZE, media_id)
 *   4. STATUS   GET  media/upload.json  (command=STATUS, media_id) — poll until succeeded
 *   5. POST /2/tweets with media.media_ids = [media_id]
 *
 * Missing creds throw TOKEN_NOT_CONFIGURED.
 */

import { createHmac, randomBytes } from "node:crypto";

export const TOKEN_NOT_CONFIGURED = "token_not_configured";

const TWITTER_V2_BASE = "https://api.twitter.com/2";
const TWITTER_MEDIA_URL = "https://upload.twitter.com/1.1/media/upload.json";
const TWITTER_USERS_ME = "https://api.twitter.com/2/users/me";

const CHUNK_SIZE = 4 * 1024 * 1024; // Twitter's published limit per APPEND
const STATUS_POLL_INTERVAL_MS = 3_000;
const STATUS_POLL_TIMEOUT_MS = 120_000;

function requireCreds(): {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
} {
  const consumerKey = process.env.TWITTER_API_KEY;
  const consumerSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!consumerKey || !consumerSecret || !accessToken || !accessSecret) {
    throw new Error(TOKEN_NOT_CONFIGURED);
  }
  return { consumerKey, consumerSecret, accessToken, accessSecret };
}

// ── OAuth 1.0a signing helpers ─────────────────────────────────────────────

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthHeader(opts: {
  method: "GET" | "POST";
  url: string;
  bodyParams?: Record<string, string>; // form-encoded params (not multipart)
  queryParams?: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: opts.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: opts.accessToken,
    oauth_version: "1.0",
  };

  const allParams: Record<string, string> = {
    ...oauthParams,
    ...(opts.queryParams ?? {}),
    ...(opts.bodyParams ?? {}),
  };

  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  const baseString = [opts.method.toUpperCase(), percentEncode(opts.url), percentEncode(paramString)].join("&");

  const signingKey = `${percentEncode(opts.consumerSecret)}&${percentEncode(opts.accessSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  const header =
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ");
  return header;
}

// ── Media upload (multi-step) ──────────────────────────────────────────────

async function mediaInit(
  creds: ReturnType<typeof requireCreds>,
  totalBytes: number,
  mediaType: string
): Promise<string> {
  const bodyParams = {
    command: "INIT",
    total_bytes: String(totalBytes),
    media_type: mediaType,
    media_category: "tweet_video",
  };
  const header = oauthHeader({
    method: "POST",
    url: TWITTER_MEDIA_URL,
    bodyParams,
    consumerKey: creds.consumerKey,
    consumerSecret: creds.consumerSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });
  const res = await fetch(TWITTER_MEDIA_URL, {
    method: "POST",
    headers: { Authorization: header, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams).toString(),
  });
  const json = await res.json().catch(() => ({}) as any);
  if (!res.ok) throw new Error(`Twitter INIT ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const mediaId = json.media_id_string ?? String(json.media_id ?? "");
  if (!mediaId) throw new Error("Twitter INIT returned no media id");
  return mediaId;
}

async function mediaAppend(
  creds: ReturnType<typeof requireCreds>,
  mediaId: string,
  segmentIndex: number,
  chunk: Buffer
): Promise<void> {
  // APPEND is multipart/form-data. OAuth signature does NOT include
  // multipart body params — only the query string + oauth params.
  const header = oauthHeader({
    method: "POST",
    url: TWITTER_MEDIA_URL,
    consumerKey: creds.consumerKey,
    consumerSecret: creds.consumerSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });
  const form = new FormData();
  form.append("command", "APPEND");
  form.append("media_id", mediaId);
  form.append("segment_index", String(segmentIndex));
  form.append("media", new Blob([new Uint8Array(chunk)]), `chunk-${segmentIndex}`);
  const res = await fetch(TWITTER_MEDIA_URL, {
    method: "POST",
    headers: { Authorization: header },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Twitter APPEND ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function mediaFinalize(creds: ReturnType<typeof requireCreds>, mediaId: string): Promise<any> {
  const bodyParams = { command: "FINALIZE", media_id: mediaId };
  const header = oauthHeader({
    method: "POST",
    url: TWITTER_MEDIA_URL,
    bodyParams,
    consumerKey: creds.consumerKey,
    consumerSecret: creds.consumerSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });
  const res = await fetch(TWITTER_MEDIA_URL, {
    method: "POST",
    headers: { Authorization: header, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams).toString(),
  });
  const json = await res.json().catch(() => ({}) as any);
  if (!res.ok) throw new Error(`Twitter FINALIZE ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function mediaStatus(creds: ReturnType<typeof requireCreds>, mediaId: string): Promise<any> {
  const queryParams = { command: "STATUS", media_id: mediaId };
  const header = oauthHeader({
    method: "GET",
    url: TWITTER_MEDIA_URL,
    queryParams,
    consumerKey: creds.consumerKey,
    consumerSecret: creds.consumerSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });
  const url = `${TWITTER_MEDIA_URL}?${new URLSearchParams(queryParams).toString()}`;
  const res = await fetch(url, { headers: { Authorization: header } });
  const json = await res.json().catch(() => ({}) as any);
  if (!res.ok) throw new Error(`Twitter STATUS ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function postTweetV2(creds: ReturnType<typeof requireCreds>, text: string, mediaId: string): Promise<string> {
  // POST /2/tweets accepts a JSON body. Twitter API v2 supports OAuth 1.0a
  // user context — we sign with the same flow but the body params don't
  // participate (JSON body).
  const url = TWITTER_V2_BASE + "/tweets";
  const header = oauthHeader({
    method: "POST",
    url,
    consumerKey: creds.consumerKey,
    consumerSecret: creds.consumerSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: header, "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 280), media: { media_ids: [mediaId] } }),
  });
  const json = await res.json().catch(() => ({}) as any);
  if (!res.ok) throw new Error(`Twitter POST /2/tweets ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  const id = json?.data?.id;
  if (!id) throw new Error("Twitter v2 tweet returned no id");
  return String(id);
}

export async function publishToTwitter(videoUrl: string, text: string): Promise<{ postId: string }> {
  const creds = requireCreds();

  // Pull the video bytes once.
  const src = await fetch(videoUrl);
  if (!src.ok) throw new Error(`Twitter source fetch ${src.status}`);
  const buf = Buffer.from(await src.arrayBuffer());
  const mediaType = src.headers.get("content-type") ?? "video/mp4";

  const mediaId = await mediaInit(creds, buf.byteLength, mediaType);

  for (let i = 0, idx = 0; i < buf.byteLength; i += CHUNK_SIZE, idx += 1) {
    const chunk = buf.subarray(i, Math.min(i + CHUNK_SIZE, buf.byteLength));
    await mediaAppend(creds, mediaId, idx, chunk);
  }

  let finalize = await mediaFinalize(creds, mediaId);
  // FINALIZE returns processing_info.check_after_secs when async; poll
  // until state=succeeded.
  if (finalize.processing_info) {
    const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const stat = await mediaStatus(creds, mediaId);
      const state = stat.processing_info?.state ?? "succeeded";
      if (state === "succeeded") {
        finalize = stat;
        break;
      }
      if (state === "failed")
        throw new Error(`Twitter media STATUS failed: ${stat.processing_info?.error?.message ?? "unknown"}`);
      await new Promise<void>((res) => setTimeout(res, STATUS_POLL_INTERVAL_MS));
    }
  }

  const tweetId = await postTweetV2(creds, text, mediaId);
  return { postId: tweetId };
}

export interface TwitterTokenStatus {
  valid: boolean;
  username: string | null;
}

export async function getTwitterTokenStatus(): Promise<TwitterTokenStatus> {
  let creds: ReturnType<typeof requireCreds>;
  try {
    creds = requireCreds();
  } catch {
    return { valid: false, username: null };
  }
  try {
    const header = oauthHeader({
      method: "GET",
      url: TWITTER_USERS_ME,
      consumerKey: creds.consumerKey,
      consumerSecret: creds.consumerSecret,
      accessToken: creds.accessToken,
      accessSecret: creds.accessSecret,
    });
    const res = await fetch(TWITTER_USERS_ME, { headers: { Authorization: header } });
    if (!res.ok) return { valid: false, username: null };
    const json = await res.json().catch(() => ({}) as any);
    return { valid: true, username: json?.data?.username ?? null };
  } catch {
    return { valid: false, username: null };
  }
}

export function twitterConfigured(): boolean {
  return !!(
    process.env.TWITTER_API_KEY &&
    process.env.TWITTER_API_SECRET &&
    process.env.TWITTER_ACCESS_TOKEN &&
    process.env.TWITTER_ACCESS_SECRET
  );
}
