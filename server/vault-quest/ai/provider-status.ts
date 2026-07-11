/**
 * Pure, dependency-free classification for the Higgsfield provider (P6-R3-01),
 * Phase 7C. No network, no secrets — maps an HTTP status to a typed failure kind
 * and derives a safe admin status enum from config + the last observed outcome,
 * WITHOUT ever making a paid call. Unit-testable in isolation.
 *
 * Root cause context: HIGGSFIELD_API_KEY holds a short-lived `oat_` OAuth *access*
 * token minted by hand via the CLI; the server has no refresh path, so it expires
 * on a fixed cadence. The concrete bug this classification fixes is that the admin
 * panel currently reports "connected" whenever the env var is merely non-empty —
 * so an already-expired token still shows green. `deriveHiggsfieldStatus` requires
 * a real observed outcome before it will claim `connected`.
 */

/** Typed failure kind thrown from the provider path. 401/403 must be distinguished
 *  from a generic provider failure so the route never auto-retries a paid create. */
export type HiggsfieldFailureKind =
  | "auth_expired"
  | "rate_limited"
  | "insufficient_credits"
  | "provider_unavailable"
  | "unknown";

export function classifyHiggsfieldStatus(httpStatus: number | null | undefined): HiggsfieldFailureKind {
  const s = httpStatus ?? 0;
  if (s === 401 || s === 403) return "auth_expired";
  if (s === 402) return "insufficient_credits";
  if (s === 429) return "rate_limited";
  if (s >= 500) return "provider_unavailable";
  return "unknown";
}

/** A typed provider error carrying the classified kind, so callers switch on
 *  `.kind` instead of regex-matching a message. */
export class HiggsfieldError extends Error {
  readonly kind: HiggsfieldFailureKind;
  readonly httpStatus?: number;
  constructor(kind: HiggsfieldFailureKind, message: string, httpStatus?: number) {
    super(message);
    this.name = "HiggsfieldError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

/** The canonical 7-state admin-facing provider status (Phase 10A D6). One central
 *  type — no duplicate enums. `connected` is only claimed after a real successful
 *  outcome, never from "the env var is set". */
export type HiggsfieldStatus =
  | "not_configured"
  | "configured_unverified"
  | "connected"
  | "authentication_invalid"
  | "provider_unavailable"
  | "rate_limited"
  | "disabled_by_owner";

/** The last observed provider outcome (recorded best-effort on each call; must
 *  never itself fail a generation). `null`/absent = no call observed yet. */
export type ProviderLastOutcome = { ok: true } | { ok: false; kind: HiggsfieldFailureKind } | null | undefined;

/** HTTP status the route should return for each admin status (503 = temporary,
 *  429 = rate limited). Exhaustive switch — extend all consumers together. */
export function httpForHiggsfieldStatus(status: HiggsfieldStatus): number {
  switch (status) {
    case "connected":
    case "configured_unverified":
      return 200;
    case "rate_limited":
      return 429;
    case "not_configured":
    case "authentication_invalid":
    case "provider_unavailable":
    case "disabled_by_owner":
      return 503;
  }
}

/**
 * Derive the admin status from config (`connected` = HIGGSFIELD_API_KEY present),
 * the last observed outcome, and the owner feature-flag (composed in). No network
 * call. Precedence: owner-disabled → disabled_by_owner (highest); no key →
 * not_configured; key but no call yet → configured_unverified; last 401 →
 * authentication_invalid; last 429 → rate_limited; other failure →
 * provider_unavailable; last ok (or out-of-credits, creds still valid) → connected.
 */
export function deriveHiggsfieldStatus(
  conn: { connected: boolean },
  last?: ProviderLastOutcome,
  opts?: { disabledByOwner?: boolean },
): HiggsfieldStatus {
  if (opts?.disabledByOwner) return "disabled_by_owner"; // owner/provider feature control wins
  if (!conn.connected) return "not_configured";
  if (!last) return "configured_unverified";
  if (last.ok) return "connected";
  if (last.kind === "auth_expired") return "authentication_invalid";
  if (last.kind === "rate_limited") return "rate_limited";
  if (last.kind === "insufficient_credits") return "connected"; // credentials work; account just out of credits (surface separately)
  return "provider_unavailable";
}
