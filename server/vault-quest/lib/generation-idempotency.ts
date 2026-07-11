/**
 * Pure, dependency-free idempotency + financial-safety logic for paid Vault Quest
 * artwork generation (PROV-01..07), Phase 7B. Server-side (node:crypto only) so no
 * DB / network / provider imports and no client bundling. Fully unit-testable.
 *
 * Why: today the ONLY dedup is a client-side in-memory ref, which does not survive
 * a reload, a 2nd tab, two admins, a network retry, or the 2 Fly machines — so a
 * reload/retry can trigger a second paid provider `create` and a duplicate
 * candidate. And a success-then-upload-failure loses the paid image because the
 * provider jobId is persisted only AFTER the R2 upload (character path never at
 * all). This module is the brain a `vq_generation_requests` table (migration 0009)
 * uses to guarantee one paid create per logical request across machines. The live
 * route wiring is Category C (needs the table on staging).
 */
import { createHash } from "node:crypto";

// ── state machine ────────────────────────────────────────────────────────────

export const VQ_GENERATION_STATES = [
  "received",
  "reserved",
  "provider_submitted",
  "provider_processing",
  "provider_completed",
  "persisting",
  "completed",
  "failed_retryable",
  "failed_final",
  "unknown_provider_state",
  "cancelled",
] as const;
export type VqGenerationState = (typeof VQ_GENERATION_STATES)[number];

const LEGAL_GEN_TRANSITIONS: Record<VqGenerationState, readonly VqGenerationState[]> = {
  received: ["reserved", "failed_final", "cancelled"],
  reserved: ["provider_submitted", "failed_final", "failed_retryable", "unknown_provider_state", "cancelled"],
  provider_submitted: ["provider_processing", "provider_completed", "failed_final", "unknown_provider_state", "cancelled"],
  provider_processing: ["provider_completed", "failed_final", "unknown_provider_state", "cancelled"],
  provider_completed: ["persisting", "unknown_provider_state", "cancelled"],
  persisting: ["completed", "failed_retryable", "cancelled"],
  // failed_retryable is the ONLY auto-resumable state; it may re-charge only when
  // there is provably no provider jobId (nothing billed) → re-reserve; else resume.
  failed_retryable: ["reserved", "persisting", "cancelled"],
  // unknown_provider_state NEVER auto-transitions — a human runs GET /jobs/{id}.
  unknown_provider_state: ["completed", "cancelled"],
  completed: [],
  failed_final: [],
  cancelled: [],
};

export function canTransitionGeneration(from: VqGenerationState, to: VqGenerationState): boolean {
  return LEGAL_GEN_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Terminal = will not process further without a human. `unknown_provider_state`
 *  is semi-terminal (manual-review only) and is treated as terminal for auto flow. */
export function isTerminalGeneration(s: VqGenerationState): boolean {
  return s === "completed" || s === "failed_final" || s === "cancelled";
}
export function isManualReviewGeneration(s: VqGenerationState): boolean {
  return s === "unknown_provider_state";
}
export function isResumableGeneration(s: VqGenerationState): boolean {
  return s === "failed_retryable";
}

// ── request fingerprint ──────────────────────────────────────────────────────

export interface GenerationPayload {
  generationType: string;
  setCode?: string | null;
  characterId?: string | null;
  cardId?: string | null;
  familyId?: string | null;
  stageId?: string | null;
  referenceType?: string | null;
  model?: string | null;
  count?: number | null;
}

/** Canonicalise a generation payload so a retry of the same user action produces
 *  the same bytes: fixed key order, trimmed/lowercased ids+model, clamped count,
 *  volatile fields (timestamps, nonces) excluded. */
export function normalizeGenerationPayload(p: GenerationPayload): Record<string, string | number> {
  const s = (v: unknown) => String(v ?? "").trim().toLowerCase();
  return {
    generationType: s(p.generationType),
    setCode: s(p.setCode),
    characterId: s(p.characterId),
    cardId: s(p.cardId),
    familyId: s(p.familyId),
    stageId: s(p.stageId),
    referenceType: s(p.referenceType),
    model: s(p.model),
    count: Math.max(1, Math.min(50, Math.trunc(Number(p.count) || 1))),
  };
}

export function fingerprintGeneration(p: GenerationPayload): string {
  const canon = normalizeGenerationPayload(p);
  const stable = Object.keys(canon)
    .sort()
    .map((k) => `${k}=${canon[k]}`)
    .join("|");
  return createHash("sha256").update(stable).digest("hex");
}

// ── idempotency decision ─────────────────────────────────────────────────────

export type IdempotencyAction =
  | "proceed" // no prior row for this key — insert winner, run, charge
  | "replay" // completed — return the existing result, no charge
  | "accepted_pending" // still running — 202, no second create
  | "resume" // failed_retryable — resume per state machine, re-charge only if no jobId
  | "conflict" // same key, different payload — 409
  | "manual_review" // unknown_provider_state — 409, human must resolve, never resubmit
  | "terminal"; // failed_final / cancelled — return stored terminal state, no re-charge

export interface ExistingRequest {
  state: VqGenerationState;
  requestFingerprint: string;
}

export function idempotencyDecision(
  existing: ExistingRequest | null | undefined,
  incomingFingerprint: string,
): { action: IdempotencyAction; http: number } {
  if (!existing) return { action: "proceed", http: 200 };
  if (existing.requestFingerprint !== incomingFingerprint) return { action: "conflict", http: 409 };
  switch (existing.state) {
    case "completed":
      return { action: "replay", http: 200 };
    case "reserved":
    case "provider_submitted":
    case "provider_processing":
    case "provider_completed":
    case "persisting":
      return { action: "accepted_pending", http: 202 };
    case "failed_retryable":
      return { action: "resume", http: 202 };
    case "unknown_provider_state":
      return { action: "manual_review", http: 409 };
    case "failed_final":
    case "cancelled":
    case "received":
    default:
      return { action: "terminal", http: 200 };
  }
}

// ── provider error classification ────────────────────────────────────────────

export type ProviderPhase = "create" | "poll" | "download" | "persist";
export type ProviderErrorClass =
  | "auth" // 401/403 — token expired/invalid
  | "insufficient_credits" // 402
  | "bad_request" // 400
  | "rate_limit" // 429
  | "provider_unavailable" // 5xx before the request was accepted
  | "unknown" // response lost / poll exhausted / post-accept failure — charge state UNKNOWN
  | "transient"; // R2/DB blip during persist

export interface ProviderErrorOutcome {
  errorClass: ProviderErrorClass;
  nextState: VqGenerationState;
  terminal: boolean;
  chargePresumed: boolean; // did money likely get spent?
  autoRetry: boolean; // may the system retry automatically (never for unknown)
}

/**
 * Map a provider failure to an error class + the state to move to. The cardinal
 * rule: an UNCERTAIN outcome (response lost, poll exhausted, any failure after the
 * request was accepted) → `unknown_provider_state`, which NEVER auto-resubmits a
 * paid create. `networkLost` marks a create whose response never arrived.
 */
export function classifyProviderError(input: {
  httpStatus?: number | null;
  phase: ProviderPhase;
  networkLost?: boolean;
}): ProviderErrorOutcome {
  const { httpStatus, phase, networkLost } = input;

  if (phase === "persist") {
    // provider already succeeded + charged; R2/DB blip is safe to resume (jobId kept)
    return { errorClass: "transient", nextState: "failed_retryable", terminal: false, chargePresumed: true, autoRetry: true };
  }

  if (networkLost) {
    // request may or may not have been accepted/charged — human must check
    return { errorClass: "unknown", nextState: "unknown_provider_state", terminal: true, chargePresumed: false, autoRetry: false };
  }

  const s = httpStatus ?? 0;
  if (phase === "create") {
    if (s === 401 || s === 403) return { errorClass: "auth", nextState: "failed_final", terminal: true, chargePresumed: false, autoRetry: false };
    if (s === 402) return { errorClass: "insufficient_credits", nextState: "failed_final", terminal: true, chargePresumed: false, autoRetry: false };
    if (s === 400) return { errorClass: "bad_request", nextState: "failed_final", terminal: true, chargePresumed: false, autoRetry: false };
    if (s === 429) return { errorClass: "rate_limit", nextState: "failed_retryable", terminal: false, chargePresumed: false, autoRetry: true };
    if (s >= 500) return { errorClass: "provider_unavailable", nextState: "failed_retryable", terminal: false, chargePresumed: false, autoRetry: true };
    return { errorClass: "unknown", nextState: "unknown_provider_state", terminal: true, chargePresumed: false, autoRetry: false };
  }

  // poll / download: the create already succeeded (charged). A failure here means
  // the job may have run — never safe to auto-recreate.
  if (s === 401 || s === 403) return { errorClass: "auth", nextState: "unknown_provider_state", terminal: true, chargePresumed: true, autoRetry: false };
  return { errorClass: "unknown", nextState: "unknown_provider_state", terminal: true, chargePresumed: true, autoRetry: false };
}

// ── spend ceilings ───────────────────────────────────────────────────────────

export interface SpendCeilings {
  maxImagesPerRequest: number;
  maxCreditsPerRequest: number;
  requestsThisHour: number;
  maxRequestsPerHour: number;
  creditsThisDay: number;
  maxCreditsPerDay: number;
  disabled?: boolean;
}

export type SpendReason =
  | "ok"
  | "disabled"
  | "too_many_images"
  | "per_request_ceiling"
  | "hourly_limit"
  | "daily_ceiling";

/** Pure ceiling arithmetic, enforced BEFORE any provider call (the SQL that
 *  supplies the window counts is Category C). No background auto-retry may spend
 *  credits invisibly: every attempt runs through this gate. */
export function spendDecision(
  requestedCount: number,
  perImageCredits: number,
  c: SpendCeilings,
): { allow: boolean; reason: SpendReason; estimatedCredits: number } {
  const estimatedCredits = Math.max(0, requestedCount) * Math.max(0, perImageCredits);
  if (c.disabled) return { allow: false, reason: "disabled", estimatedCredits };
  if (requestedCount > c.maxImagesPerRequest) return { allow: false, reason: "too_many_images", estimatedCredits };
  if (estimatedCredits > c.maxCreditsPerRequest) return { allow: false, reason: "per_request_ceiling", estimatedCredits };
  if (c.requestsThisHour + 1 > c.maxRequestsPerHour) return { allow: false, reason: "hourly_limit", estimatedCredits };
  if (c.creditsThisDay + estimatedCredits > c.maxCreditsPerDay) return { allow: false, reason: "daily_ceiling", estimatedCredits };
  return { allow: true, reason: "ok", estimatedCredits };
}
