/**
 * Pure R2 environment-identity guard (Phase 10A hardening). Reconciliation/ops tooling
 * that can LIST/compare/copy/restore (and eventually delete) VQ objects must assert the
 * R2 account/bucket identity explicitly — a staging DB does NOT imply staging R2 (the two
 * can be split; VQ R2 identity has been UNCONFIRMED). Refuses when the expected identity
 * is missing/ambiguous or does not match the actual env. Never returns/echoes credentials
 * or signed URLs — only the bucket name + endpoint HOST (safe identifiers).
 */

export interface R2IdentityInput {
  expectedBucket?: string | null; // explicit --r2=<bucket> the operator asserts they intend
  actualBucket?: string | null; // R2_BUCKET_NAME from env
  actualEndpoint?: string | null; // R2_ENDPOINT from env
}
export interface R2IdentityResult {
  ok: boolean;
  reason: "ok" | "no_expected" | "no_actual" | "mismatch";
  bucket: string | null; // safe: bucket name only
  endpointHost: string | null; // safe: host only, never the full URL with any query
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    // endpoint may be a bare host already
    return String(url).replace(/^https?:\/\//, "").split("/")[0] || null;
  }
}

/**
 * Assert the R2 target identity. `ok` only when the operator named an expected bucket
 * AND it matches the actual env bucket. Missing/ambiguous → refuse (fail-closed).
 */
export function checkR2Identity(input: R2IdentityInput): R2IdentityResult {
  const bucket = input.actualBucket?.trim() || null;
  const endpointHost = hostOf(input.actualEndpoint);
  const expected = input.expectedBucket?.trim() || null;
  if (!expected) return { ok: false, reason: "no_expected", bucket, endpointHost };
  if (!bucket) return { ok: false, reason: "no_actual", bucket, endpointHost };
  if (expected !== bucket) return { ok: false, reason: "mismatch", bucket, endpointHost };
  return { ok: true, reason: "ok", bucket, endpointHost };
}

/** Human message for a refusal (no credentials). */
export function r2IdentityMessage(r: R2IdentityResult): string {
  switch (r.reason) {
    case "ok":
      return `R2 identity confirmed: bucket=${r.bucket} host=${r.endpointHost}`;
    case "no_expected":
      return "REFUSED: no expected R2 bucket given. Pass --r2=<bucket> to confirm the target (staging DB does NOT imply staging R2).";
    case "no_actual":
      return "REFUSED: R2_BUCKET_NAME is not set in the environment.";
    case "mismatch":
      return `REFUSED: R2 bucket mismatch — env bucket=${r.bucket} does not match the expected --r2 value. Confirm the environment before listing.`;
  }
}
