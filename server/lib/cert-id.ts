/**
 * Canonical cert-id normalization (single source of truth).
 *
 * Cert IDs are stored padded — "MV-0000000001" — but display and look up in
 * canonical form "MV1": drop the "MV"/"MV-" prefix and the leading zeros.
 *
 * ReDoS-safe (#113): the previous regex `/^MV-?0*(\d+)$/i` had OVERLAPPING
 * quantifiers — `0*` and `\d+` both match "0" — so a long all-zeros input that
 * ultimately fails to match backtracked in ~O(n^2). This uses a single,
 * non-overlapping `\d+` capture plus an input-length bound, then strips the
 * leading zeros in code. Same outputs as before, linear time.
 */

// Real cert ids are "MV" + ~10 digits (≤13 chars). Anything longer is not a cert
// id, so we reject it up front — this also caps the regex's input length.
const MAX_CERT_ID_LEN = 32;

// Linear: a single `\d+` group, no overlap with the literal prefix.
const MV_ID = /^MV-?(\d+)$/i;
// Linear: strip leading zeros but always keep at least one digit (all-zero → "0").
const LEADING_ZEROS = /^0+(?=\d)/;

/**
 * The numeric part of an MV cert id with leading zeros stripped
 * (e.g. "MV-0000000042" → "42", "MV0" → "0"), or `null` if `raw` is not an
 * MV-number id (or is implausibly long).
 */
export function certNumberFromId(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CERT_ID_LEN) {
    return null;
  }
  const m = MV_ID.exec(raw);
  if (!m) return null;
  return m[1].replace(LEADING_ZEROS, "");
}

/**
 * Normalize an MV cert id to canonical "MV<n>" form. Non-MV input (e.g.
 * "PSA-123") is returned unchanged.
 */
export function normalizeCertId(raw: string): string {
  const n = certNumberFromId(raw);
  return n === null ? raw : `MV${n}`;
}
