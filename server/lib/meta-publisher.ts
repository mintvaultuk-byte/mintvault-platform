/**
 * Meta Graph API (v19.0) — Instagram + Facebook video publishing.
 *
 * Reads credentials from env (Fly secrets):
 *   META_ACCESS_TOKEN   — page access token (NOT a user token)
 *   META_IG_USER_ID     — Instagram Business / Creator account ID
 *   META_FB_PAGE_ID     — Facebook page ID
 *
 * Behaviour: missing tokens DO NOT crash. Callers can wrap in
 * tokenConfigured() to gate the call site, or the publisher throws a
 * sentinel error the route layer turns into { error: "token_not_configured" }.
 *
 * IG video publish is two-step (container → publish) per Meta's docs and
 * IG requires polling for VIDEO_AWAKE before publish. FB videos accept a
 * single POST with file_url.
 */

const META_API_BASE = "https://graph.facebook.com/v19.0";
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 120_000;

/** Sentinel error message routes can switch on for the 200/token-not-
 *  configured response. */
export const TOKEN_NOT_CONFIGURED = "token_not_configured";

interface MetaErrorResponse {
  error?: { message?: string; type?: string; code?: number };
}

function requireMetaToken(): string {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) throw new Error(TOKEN_NOT_CONFIGURED);
  return t;
}
function requireIgUser(): string {
  const id = process.env.META_IG_USER_ID;
  if (!id) throw new Error(TOKEN_NOT_CONFIGURED);
  return id;
}
function requireFbPage(): string {
  const id = process.env.META_FB_PAGE_ID;
  if (!id) throw new Error(TOKEN_NOT_CONFIGURED);
  return id;
}

async function metaPost(path: string, params: Record<string, string>): Promise<any> {
  const url = `${META_API_BASE}${path}`;
  const body = new URLSearchParams(params);
  const res = await fetch(url, { method: "POST", body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as MetaErrorResponse).error) {
    const msg = (json as MetaErrorResponse).error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Meta POST ${path}: ${msg}`);
  }
  return json;
}

async function metaGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const url = `${META_API_BASE}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as MetaErrorResponse).error) {
    const msg = (json as MetaErrorResponse).error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Meta GET ${path}: ${msg}`);
  }
  return json;
}

/** Poll IG media container status until it transitions out of IN_PROGRESS. */
async function waitForIgContainerReady(containerId: string, token: string): Promise<void> {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await metaGet(`/${containerId}`, {
      fields: "status_code,status",
      access_token: token,
    });
    const code: string = String(r.status_code ?? "").toUpperCase();
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`IG container ${containerId} status=${code}: ${r.status ?? ""}`);
    }
    // IN_PROGRESS, PUBLISHED — keep polling (PUBLISHED shouldn't appear
    // here pre-publish but treat as ready defensively).
    if (code === "PUBLISHED") return;
    await new Promise<void>((res) => setTimeout(res, VIDEO_POLL_INTERVAL_MS));
  }
  throw new Error(`IG container ${containerId} did not become ready within ${VIDEO_POLL_TIMEOUT_MS}ms`);
}

export async function publishToInstagram(
  videoUrl: string,
  caption: string,
): Promise<{ postId: string }> {
  const token = requireMetaToken();
  const igUser = requireIgUser();

  // Step 1: create the media container. Per the IG Graph API, REELS is
  // the recommended media_type for short videos.
  const container = await metaPost(`/${igUser}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    access_token: token,
  });
  const containerId: string = container.id;
  if (!containerId) throw new Error("IG container create returned no id");

  // Step 2: wait until status_code transitions away from IN_PROGRESS.
  await waitForIgContainerReady(containerId, token);

  // Step 3: publish.
  const published = await metaPost(`/${igUser}/media_publish`, {
    creation_id: containerId,
    access_token: token,
  });
  const postId: string = published.id;
  if (!postId) throw new Error("IG media_publish returned no id");
  return { postId };
}

export async function publishToFacebook(
  videoUrl: string,
  caption: string,
): Promise<{ postId: string }> {
  const token = requireMetaToken();
  const pageId = requireFbPage();

  const r = await metaPost(`/${pageId}/videos`, {
    file_url: videoUrl,
    description: caption,
    access_token: token,
  });
  const postId: string = r.id ?? r.video_id;
  if (!postId) throw new Error("FB /videos returned no id");
  return { postId };
}

export interface InstagramInsights {
  likes: number;
  views: number;
  reach: number;
  comments: number;
}

export async function getInstagramInsights(postId: string): Promise<InstagramInsights> {
  const token = requireMetaToken();
  // The metric names vary by media type — for reels, "impressions" is
  // deprecated in favour of "plays"/"video_views". We request a generous
  // set and pick whichever is present.
  const r = await metaGet(`/${postId}/insights`, {
    metric: "impressions,reach,likes,comments,plays,video_views",
    access_token: token,
  });
  // Response shape: { data: [{ name, values: [{ value }] }, …] }
  const map: Record<string, number> = {};
  for (const m of r.data ?? []) {
    const name = String(m.name ?? "");
    const value = Number(m.values?.[0]?.value ?? 0);
    map[name] = value;
  }
  return {
    likes:    map.likes    ?? 0,
    comments: map.comments ?? 0,
    reach:    map.reach    ?? 0,
    views:    map.video_views ?? map.plays ?? map.impressions ?? 0,
  };
}

export interface MetaTokenStatus {
  valid: boolean;
  expiresAt: string | null;   // ISO timestamp; null when permanent or unknown
  scopes: string[];
  igUserId: string | null;
  fbPageId: string | null;
}

export async function getMetaTokenStatus(): Promise<MetaTokenStatus> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return {
      valid: false, expiresAt: null, scopes: [],
      igUserId: process.env.META_IG_USER_ID ?? null,
      fbPageId: process.env.META_FB_PAGE_ID ?? null,
    };
  }
  try {
    await metaGet("/me", { fields: "id,name", access_token: token });
    let scopes: string[] = [];
    try {
      const perms = await metaGet("/me/permissions", { access_token: token });
      scopes = (perms.data ?? [])
        .filter((p: any) => p.status === "granted")
        .map((p: any) => String(p.permission));
    } catch {}
    let expiresAt: string | null = null;
    try {
      // The debug_token endpoint requires both the user token and an app
      // access token. Without the app secret we can't call it, so leave
      // expiresAt null. Status chip just reports valid=true.
    } catch {}
    return {
      valid: true,
      expiresAt,
      scopes,
      igUserId: process.env.META_IG_USER_ID ?? null,
      fbPageId: process.env.META_FB_PAGE_ID ?? null,
    };
  } catch {
    return {
      valid: false, expiresAt: null, scopes: [],
      igUserId: process.env.META_IG_USER_ID ?? null,
      fbPageId: process.env.META_FB_PAGE_ID ?? null,
    };
  }
}

/** Convenience: returns true iff all the env vars publishToInstagram needs
 *  are set. UI uses this for the green/red status chip. */
export function metaConfigured(): boolean {
  return !!process.env.META_ACCESS_TOKEN
      && !!process.env.META_IG_USER_ID
      && !!process.env.META_FB_PAGE_ID;
}

/** Peak-hour heuristic for smart scheduling. Reads online_followers for
 *  the IG user and returns the hour with the highest count in the most
 *  recent value. Falls back to null on any failure. Hour is UTC (Meta
 *  returns the daily insight in account timezone — we trust UTC for our
 *  purposes since the scheduler tick is UTC-based). */
export async function getInstagramPeakHour(): Promise<number | null> {
  const token = process.env.META_ACCESS_TOKEN;
  const igUser = process.env.META_IG_USER_ID;
  if (!token || !igUser) return null;
  try {
    const r = await metaGet(`/${igUser}/insights`, {
      metric: "online_followers",
      period: "lifetime",
      access_token: token,
    });
    // Response: { data: [{ values: [{ value: { "0": n, "1": n, … "23": n } }] }] }
    const valuesArr = r.data?.[0]?.values ?? [];
    if (valuesArr.length === 0) return null;
    const latest = valuesArr[valuesArr.length - 1]?.value ?? {};
    let bestHour = 0;
    let bestCount = -1;
    for (const k of Object.keys(latest)) {
      const hour = Number(k);
      const count = Number(latest[k]);
      if (Number.isFinite(hour) && hour >= 0 && hour <= 23 && count > bestCount) {
        bestCount = count;
        bestHour = hour;
      }
    }
    return bestCount >= 0 ? bestHour : null;
  } catch {
    return null;
  }
}
