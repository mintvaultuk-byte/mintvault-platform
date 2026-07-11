/**
 * Phase 7B — pure idempotency + financial-safety logic for paid VQ generation
 * (PROV-01..07). No DB / provider — the live route wiring to vq_generation_requests
 * is Category C. These 15 cases are the financial-guarantee spec from the review.
 */
import { describe, it, expect } from "vitest";
import {
  fingerprintGeneration,
  normalizeGenerationPayload,
  idempotencyDecision,
  classifyProviderError,
  spendDecision,
  canTransitionGeneration,
  isTerminalGeneration,
  isManualReviewGeneration,
  isResumableGeneration,
  type ExistingRequest,
} from "../server/vault-quest/lib/generation-idempotency";

const fp = (over = {}) => fingerprintGeneration({ generationType: "master_portrait", characterId: "GNV-F01-S1", model: "nano_banana", count: 3, ...over });

describe("fingerprint — stable across retries, sensitive to payload", () => {
  it("is identical for the same logical action (case-insensitive, trimmed)", () => {
    expect(fingerprintGeneration({ generationType: "master_portrait", characterId: " GNV-F01-S1 ", model: "Nano_Banana", count: 3 }))
      .toBe(fingerprintGeneration({ generationType: "master_portrait", characterId: "gnv-f01-s1", model: "nano_banana", count: 3 }));
  });
  it("differs when the payload differs", () => {
    expect(fp()).not.toBe(fp({ count: 1 }));
    expect(fp()).not.toBe(fp({ characterId: "GNV-F02-S1" }));
    expect(fp()).not.toBe(fp({ model: "z_image" }));
  });
  it("clamps count in normalization", () => {
    expect(normalizeGenerationPayload({ generationType: "x", count: 0 }).count).toBe(1);
    expect(normalizeGenerationPayload({ generationType: "x", count: 999 }).count).toBe(50);
  });
});

describe("idempotencyDecision — the exactly-one-create contract", () => {
  const key = fp();
  const running: ExistingRequest = { state: "provider_processing", requestFingerprint: key };

  it("1. same key / same payload after completion → replay, no new create", () => {
    expect(idempotencyDecision({ state: "completed", requestFingerprint: key }, key)).toEqual({ action: "replay", http: 200 });
  });
  it("2. same key / different payload → 409 conflict", () => {
    expect(idempotencyDecision(running, "DIFFERENT").action).toBe("conflict");
    expect(idempotencyDecision(running, "DIFFERENT").http).toBe(409);
  });
  it("3+4. concurrent / 2nd tab while running → 202 accepted_pending, never a 2nd create", () => {
    expect(idempotencyDecision(running, key)).toEqual({ action: "accepted_pending", http: 202 });
    expect(idempotencyDecision({ state: "reserved", requestFingerprint: key }, key).action).toBe("accepted_pending");
  });
  it("5. timeout-then-retry → pending if running, replay if completed — never a 2nd create", () => {
    expect(idempotencyDecision(running, key).action).toBe("accepted_pending");
    expect(idempotencyDecision({ state: "completed", requestFingerprint: key }, key).action).toBe("replay");
  });
  it("no prior row → proceed", () => {
    expect(idempotencyDecision(null, key)).toEqual({ action: "proceed", http: 200 });
  });
  it("failed_retryable → resume; unknown_provider_state → manual review (409, no resubmit)", () => {
    expect(idempotencyDecision({ state: "failed_retryable", requestFingerprint: key }, key).action).toBe("resume");
    expect(idempotencyDecision({ state: "unknown_provider_state", requestFingerprint: key }, key)).toEqual({ action: "manual_review", http: 409 });
  });
  it("failed_final / cancelled → terminal, no silent re-charge", () => {
    expect(idempotencyDecision({ state: "failed_final", requestFingerprint: key }, key).action).toBe("terminal");
    expect(idempotencyDecision({ state: "cancelled", requestFingerprint: key }, key).action).toBe("terminal");
  });
});

describe("classifyProviderError — uncertain outcomes never auto-recreate", () => {
  it("6. provider accepted but response lost → unknown_provider_state, no auto-retry", () => {
    const r = classifyProviderError({ phase: "create", networkLost: true });
    expect(r.nextState).toBe("unknown_provider_state");
    expect(r.autoRetry).toBe(false);
  });
  it("7+8. provider completed then R2/DB failed → failed_retryable, jobId kept, resumable", () => {
    const r = classifyProviderError({ phase: "persist" });
    expect(r.nextState).toBe("failed_retryable");
    expect(r.chargePresumed).toBe(true);
    expect(r.autoRetry).toBe(true);
  });
  it("9. 401 on create → auth, failed_final, no charge, no retry", () => {
    const r = classifyProviderError({ phase: "create", httpStatus: 401 });
    expect(r).toMatchObject({ errorClass: "auth", nextState: "failed_final", chargePresumed: false, autoRetry: false });
  });
  it("10. 429 on create → rate_limit, failed_retryable", () => {
    expect(classifyProviderError({ phase: "create", httpStatus: 429 })).toMatchObject({ errorClass: "rate_limit", nextState: "failed_retryable", autoRetry: true });
  });
  it("11. 5xx pre-accept → provider_unavailable retryable; 5xx during poll → unknown", () => {
    expect(classifyProviderError({ phase: "create", httpStatus: 503 }).nextState).toBe("failed_retryable");
    expect(classifyProviderError({ phase: "poll", httpStatus: 503 }).nextState).toBe("unknown_provider_state");
  });
  it("12. unrecognised create failure → unknown_provider_state (fail closed)", () => {
    expect(classifyProviderError({ phase: "create", httpStatus: 418 }).nextState).toBe("unknown_provider_state");
  });
  it("402 on create → insufficient_credits, no charge", () => {
    expect(classifyProviderError({ phase: "create", httpStatus: 402 }).errorClass).toBe("insufficient_credits");
  });
});

describe("spendDecision — server-side ceilings before any provider call", () => {
  const base = { maxImagesPerRequest: 3, maxCreditsPerRequest: 5, requestsThisHour: 0, maxRequestsPerHour: 20, creditsThisDay: 0, maxCreditsPerDay: 50 };
  it("allows a within-limits request", () => {
    expect(spendDecision(3, 1, base)).toMatchObject({ allow: true, reason: "ok", estimatedCredits: 3 });
  });
  it("13. daily ceiling exceeded → reject", () => {
    expect(spendDecision(3, 1, { ...base, creditsThisDay: 49 })).toMatchObject({ allow: false, reason: "daily_ceiling" });
  });
  it("14. per-request ceiling exceeded → reject", () => {
    expect(spendDecision(3, 3, base)).toMatchObject({ allow: false, reason: "per_request_ceiling" });
  });
  it("15. disabled kill switch → reject before charge", () => {
    expect(spendDecision(1, 1, { ...base, disabled: true })).toMatchObject({ allow: false, reason: "disabled" });
  });
  it("too many images / hourly limit → reject", () => {
    expect(spendDecision(9, 1, base).reason).toBe("too_many_images");
    expect(spendDecision(1, 1, { ...base, requestsThisHour: 20 }).reason).toBe("hourly_limit");
  });
});

describe("generation state machine", () => {
  it("permits the reserve→submit→persist→complete happy path", () => {
    expect(canTransitionGeneration("received", "reserved")).toBe(true);
    expect(canTransitionGeneration("reserved", "provider_submitted")).toBe(true);
    expect(canTransitionGeneration("provider_completed", "persisting")).toBe(true);
    expect(canTransitionGeneration("persisting", "completed")).toBe(true);
  });
  it("never auto-transitions out of unknown_provider_state except by a human", () => {
    expect(canTransitionGeneration("unknown_provider_state", "completed")).toBe(true); // manual only
    expect(canTransitionGeneration("unknown_provider_state", "reserved")).toBe(false); // no auto resubmit
    expect(isManualReviewGeneration("unknown_provider_state")).toBe(true);
  });
  it("classifies terminal / resumable states", () => {
    expect(isTerminalGeneration("completed")).toBe(true);
    expect(isTerminalGeneration("failed_final")).toBe(true);
    expect(isResumableGeneration("failed_retryable")).toBe(true);
    expect(isResumableGeneration("completed")).toBe(false);
  });
});
