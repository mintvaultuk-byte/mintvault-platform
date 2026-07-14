/**
 * Provider job ID persistence (Phase 3A item 4) — pure unit coverage.
 * classifyAndMapThrown must extract `.jobId` off a HiggsfieldJobError-shaped
 * thrown value (duck-typed, no import of higgsfield.ts to avoid a circular
 * dependency) so a failure that happens AFTER the provider `create` call already
 * succeeded still preserves the job id for reconciliation — never to trigger a
 * retry, purely diagnostic.
 */
import { describe, it, expect, vi } from "vitest";
// generation-idempotency-store imports server/db (needs MINTVAULT_DATABASE_URL); stub
// it — classifyAndMapThrown itself is pure.
vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve() } }));
import { classifyAndMapThrown } from "../server/vault-quest/lib/generation-idempotency-store";
import { HiggsfieldJobError } from "../server/vault-quest/ai/higgsfield";

describe("classifyAndMapThrown — provider job id extraction", () => {
  it("a HiggsfieldJobError (poll timeout after create succeeded) preserves the job id", () => {
    const err = new HiggsfieldJobError("Higgsfield poll kept timing out — the job may still finish; try Regenerate in a moment.", "job-abc-123");
    const mapped = classifyAndMapThrown(err);
    expect(mapped.providerJobId).toBe("job-abc-123");
    expect(mapped.toState).toBe("unknown_provider_state");
  });

  it("a provider-resolved job failure (e.g. 'Higgsfield generation failed') preserves the job id", () => {
    const err = new HiggsfieldJobError("Higgsfield generation failed", "job-xyz-789");
    const mapped = classifyAndMapThrown(err);
    expect(mapped.providerJobId).toBe("job-xyz-789");
  });

  it("a download failure after create succeeded preserves the job id", () => {
    const err = new HiggsfieldJobError("Higgsfield image download failed (503)", "job-dl-1");
    expect(classifyAndMapThrown(err).providerJobId).toBe("job-dl-1");
  });

  it("a plain create-time Error (401/402/non-2xx before any job exists) has NO job id", () => {
    const err = new Error("Higgsfield rejected the token (401) — it has likely expired.");
    const mapped = classifyAndMapThrown(err);
    expect(mapped.providerJobId).toBeNull();
    expect(mapped.errorClass).toBe("auth");
  });

  it("a non-Error thrown value never crashes and has no job id", () => {
    const mapped = classifyAndMapThrown("some string throw");
    expect(mapped.providerJobId).toBeNull();
  });
});
