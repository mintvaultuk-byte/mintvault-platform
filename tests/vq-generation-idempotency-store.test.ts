/**
 * Phase 10A D10 — pure-logic tests for the idempotency store adapter's non-DB helpers:
 * classifyThrownGenerationError (message-pattern → phase/status/networkLost) and
 * idempotencyResponseFor (action → HTTP response). No DB/network.
 */
import { describe, it, expect, vi } from "vitest";
// production-storage imports server/db (needs MINTVAULT_DATABASE_URL); stub it — the
// functions under test here are pure.
vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve() } }));
import { classifyThrownGenerationError, idempotencyResponseFor } from "../server/vault-quest/lib/generation-idempotency-store";

describe("classifyThrownGenerationError", () => {
  it("extracts a 3-digit status embedded in the message", () => {
    expect(classifyThrownGenerationError(new Error("Higgsfield rejected the token (401) — expired"))).toMatchObject({ httpStatus: 401, phase: "create" });
    expect(classifyThrownGenerationError(new Error("Higgsfield create failed (429): rate limited"))).toMatchObject({ httpStatus: 429, phase: "create" });
    expect(classifyThrownGenerationError(new Error("Higgsfield create failed (500)"))).toMatchObject({ httpStatus: 500, phase: "create" });
  });
  it("credits message with no embedded code → 402", () => {
    expect(classifyThrownGenerationError(new Error("Higgsfield: not enough credits to generate an image."))).toMatchObject({ httpStatus: 402, phase: "create" });
  });
  it("post-create (poll/generation-status) failures bucket to phase 'poll' — charge already presumed", () => {
    expect(classifyThrownGenerationError(new Error("Higgsfield poll failed (500)"))).toMatchObject({ phase: "poll" });
    expect(classifyThrownGenerationError(new Error("Higgsfield generation failed"))).toMatchObject({ phase: "poll" });
    expect(classifyThrownGenerationError(new Error("Higgsfield poll kept timing out — try again"))).toMatchObject({ phase: "poll", networkLost: true });
    expect(classifyThrownGenerationError(new Error("Higgsfield did not finish in time"))).toMatchObject({ phase: "poll", networkLost: true });
  });
  it("download failures bucket to phase 'download'", () => {
    expect(classifyThrownGenerationError(new Error("Higgsfield image download failed (503)"))).toMatchObject({ httpStatus: 503, phase: "download" });
  });
  it("unrecognized message → create phase, no status (safe default → unknown_provider_state downstream)", () => {
    expect(classifyThrownGenerationError(new Error("something weird happened"))).toMatchObject({ httpStatus: null, phase: "create", networkLost: false });
  });
});

describe("idempotencyResponseFor", () => {
  const row = { candidateId: 42, chargedCredits: "3.00", state: "failed_final" } as never;
  it("replay → 200 with the stored candidateId, never a re-charge", () => {
    const r = idempotencyResponseFor("replay", row);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ replayed: true, candidateId: 42, chargedCredits: 3 });
  });
  it("accepted_pending → 202", () => {
    expect(idempotencyResponseFor("accepted_pending", row).status).toBe(202);
  });
  it("conflict → 409 with a stable machine-readable reason", () => {
    const r = idempotencyResponseFor("conflict", row);
    expect(r.status).toBe(409);
    expect((r.body as { reason?: string }).reason).toBe("idempotency_conflict");
  });
  it("manual_review → 409, never auto-resubmit", () => {
    expect(idempotencyResponseFor("manual_review", row).status).toBe(409);
  });
  it("terminal → 200, explicitly NOT replayed and NOT charged", () => {
    const r = idempotencyResponseFor("terminal", row);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, terminal: true });
  });
});
