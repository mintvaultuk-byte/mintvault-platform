/**
 * LinkedIn API v2 — video share publishing.
 *
 * Reads:
 *   LINKEDIN_ACCESS_TOKEN   — OAuth 2.0 token with w_member_social scope
 *   LINKEDIN_PERSON_URN     — e.g. "urn:li:person:abcd1234"
 *
 * Flow (per LinkedIn docs):
 *   1. POST /v2/assets?action=registerUpload — register upload, receive
 *      asset URN + upload URL.
 *   2. PUT video bytes to the upload URL.
 *   3. POST /v2/ugcPosts — create the share referencing the asset URN.
 *
 * Missing creds throw TOKEN_NOT_CONFIGURED.
 */

export const TOKEN_NOT_CONFIGURED = "token_not_configured";

const LINKEDIN_BASE = "https://api.linkedin.com";

function requireCreds(): { token: string; personUrn: string } {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const personUrn = process.env.LINKEDIN_PERSON_URN;
  if (!token || !personUrn) throw new Error(TOKEN_NOT_CONFIGURED);
  return { token, personUrn };
}

async function liFetch(path: string, init: RequestInit & { token: string }): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${init.token}`,
    "X-Restli-Protocol-Version": "2.0.0",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${LINKEDIN_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) throw new Error(`LinkedIn ${path} ${res.status}: ${(text ?? "").slice(0, 200)}`);
  return json ?? {};
}

export async function publishToLinkedIn(videoUrl: string, text: string): Promise<{ postId: string }> {
  const { token, personUrn } = requireCreds();

  // 1. Register upload.
  const reg = await liFetch("/v2/assets?action=registerUpload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    token,
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
        owner: personUrn,
        serviceRelationships: [
          {
            relationshipType: "OWNER",
            identifier: "urn:li:userGeneratedContent",
          },
        ],
      },
    }),
  });
  const uploadMechanism = reg?.value?.uploadMechanism;
  const uploadUrl = uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
  const assetUrn = reg?.value?.asset;
  if (!uploadUrl || !assetUrn) throw new Error("LinkedIn register-upload returned no uploadUrl or asset");

  // 2. PUT video bytes.
  const src = await fetch(videoUrl);
  if (!src.ok) throw new Error(`LinkedIn source fetch ${src.status}`);
  const buf = Buffer.from(await src.arrayBuffer());
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: buf,
  });
  if (!putRes.ok) {
    const t = await putRes.text().catch(() => "");
    throw new Error(`LinkedIn upload PUT ${putRes.status}: ${t.slice(0, 200)}`);
  }

  // 3. Create share.
  const share = await liFetch("/v2/ugcPosts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    token,
    body: JSON.stringify({
      author: personUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: text.slice(0, 3000) },
          shareMediaCategory: "VIDEO",
          media: [
            {
              status: "READY",
              media: assetUrn,
            },
          ],
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  const postId: string = share?.id ?? "";
  if (!postId) throw new Error("LinkedIn ugcPosts returned no id");
  return { postId };
}

export interface LinkedInTokenStatus {
  valid: boolean;
  name: string | null;
}

export async function getLinkedInTokenStatus(): Promise<LinkedInTokenStatus> {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) return { valid: false, name: null };
  try {
    const res = await fetch(`${LINKEDIN_BASE}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { valid: false, name: null };
    const json = await res.json().catch(() => ({}) as any);
    const name = json?.name ?? json?.given_name ?? null;
    return { valid: true, name };
  } catch {
    return { valid: false, name: null };
  }
}

export function linkedinConfigured(): boolean {
  return !!process.env.LINKEDIN_ACCESS_TOKEN && !!process.env.LINKEDIN_PERSON_URN;
}
