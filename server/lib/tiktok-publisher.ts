/**
 * TikTok Content Posting API (v2) — video publish.
 *
 * Reads credentials from env (Fly secrets):
 *   TIKTOK_ACCESS_TOKEN  — OAuth access token with video.publish scope
 *   TIKTOK_OPEN_ID       — the creator's open_id
 *
 * Missing tokens throw the same TOKEN_NOT_CONFIGURED sentinel the route
 * layer uses to return 200 + { error }.
 *
 * Flow per TikTok docs:
 *   POST /v2/post/publish/video/init  →  publish_id, upload_url
 *   For URL-pull publishing (PULL_FROM_URL) the init is also the upload
 *   step — TikTok fetches the URL itself. We use PULL_FROM_URL here so we
 *   don't have to stream chunks ourselves.
 *   GET  /v2/post/publish/status/fetch — poll until publish_status=PUBLISH_COMPLETE.
 */

import type { PipelineSettings } from "./pipeline-settings";

export const TOKEN_NOT_CONFIGURED = "token_not_configured";

const TIKTOK_API_BASE = "https://open.tiktokapis.com";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 180_000;

function requireToken(): string {
  const t = process.env.TIKTOK_ACCESS_TOKEN;
  if (!t) throw new Error(TOKEN_NOT_CONFIGURED);
  return t;
}

async function tiktokFetch(
  path: string,
  init: { method: "GET" | "POST"; body?: any; token: string },
): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${init.token}`,
    "Content-Type": "application/json; charset=UTF-8",
  };
  const res = await fetch(`${TIKTOK_API_BASE}${path}`, {
    method: init.method,
    headers,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json?.error && json.error.code && json.error.code !== "ok")) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`TikTok ${path}: ${msg}`);
  }
  return json;
}

export interface TiktokPublishOptions {
  privacy?: PipelineSettings["tiktok_privacy"];
  disableDuet?: boolean;
  disableStitch?: boolean;
}

export async function publishToTikTok(
  videoUrl: string,
  caption: string,
  options: TiktokPublishOptions = {},
): Promise<{ postId: string }> {
  const token = requireToken();

  const init = await tiktokFetch("/v2/post/publish/video/init/", {
    method: "POST",
    token,
    body: {
      post_info: {
        title: caption.slice(0, 150), // TikTok caption cap
        privacy_level: options.privacy ?? "PUBLIC_TO_EVERYONE",
        disable_duet: !!options.disableDuet,
        disable_stitch: !!options.disableStitch,
        disable_comment: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: videoUrl,
      },
    },
  });

  const publishId: string = init?.data?.publish_id;
  if (!publishId) throw new Error("TikTok init returned no publish_id");

  // Poll for completion. TikTok takes its time pulling + transcoding.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stat = await tiktokFetch("/v2/post/publish/status/fetch/", {
      method: "POST",
      token,
      body: { publish_id: publishId },
    });
    const status: string = String(stat?.data?.status ?? "").toUpperCase();
    if (status === "PUBLISH_COMPLETE") {
      const postId: string = stat?.data?.publicaly_available_post_id?.[0]
        ?? stat?.data?.public_post_id?.[0]
        ?? publishId;
      return { postId };
    }
    if (status === "FAILED" || status === "PUBLISH_FAILED") {
      throw new Error(`TikTok publish FAILED: ${stat?.data?.fail_reason ?? "unknown"}`);
    }
    await new Promise<void>((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`TikTok publish poll timeout after ${POLL_TIMEOUT_MS}ms`);
}

export interface TiktokTokenStatus {
  valid: boolean;
  expiresAt: string | null;
  openId: string | null;
}

export async function getTikTokTokenStatus(): Promise<TiktokTokenStatus> {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) {
    return { valid: false, expiresAt: null, openId: process.env.TIKTOK_OPEN_ID ?? null };
  }
  try {
    // Calls a cheap user-info endpoint to confirm the token is live.
    const r = await tiktokFetch(
      `/v2/user/info/?fields=open_id`,
      { method: "GET", token },
    );
    const openId = r?.data?.user?.open_id ?? process.env.TIKTOK_OPEN_ID ?? null;
    return { valid: true, expiresAt: null, openId };
  } catch {
    return { valid: false, expiresAt: null, openId: process.env.TIKTOK_OPEN_ID ?? null };
  }
}

export function tiktokConfigured(): boolean {
  return !!process.env.TIKTOK_ACCESS_TOKEN && !!process.env.TIKTOK_OPEN_ID;
}
