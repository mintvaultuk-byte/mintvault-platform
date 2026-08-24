/**
 * Phase 10A D10 — durable idempotency/double-pay-protection integration tests against
 * the ISOLATED LOCAL Postgres (TEST_DATABASE_URL, hard-pinned; skipped without it — never
 * touches staging/prod). Proves the exact properties the owner's requirements list:
 * true-parallel single-winner, completed-replay, in-progress-replay, failed-then-fresh-
 * key retry, cross-machine (two independent callers on the shared table), and different
 * payloads under different keys never colliding.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === (process.env.MINTVAULT_TEST_PG16_PORT || "55432") && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});

const run = TEST_URL ? describe : describe.skip;

import { reserveOrDecide, finalizeSuccess, finalizeFailure, getGenerationByKey } from "../server/vault-quest/lib/generation-idempotency-store";
import type { GenerationPayload } from "../server/vault-quest/lib/generation-idempotency";
import { pool } from "../server/db";

const OWNER = "itest-gen-idem";
const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<unknown> }).query(s, a);

function payload(characterId: string, overrides: Partial<GenerationPayload> = {}): GenerationPayload {
  return { generationType: "character-artwork-single", characterId, referenceType: "master_portrait", model: "nano_banana", count: 3, ...overrides };
}
const key = (suffix: string) => `itest-${OWNER}-${suffix}-${Math.random().toString(36).slice(2)}`;

run("generation idempotency store — local Postgres", () => {
  beforeEach(() => q("DELETE FROM vq_generation_requests WHERE admin_id = $1", [OWNER]));
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests WHERE admin_id = $1", [OWNER]);
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("fresh key with no existing row → proceed (reserved)", async () => {
    const k = key("fresh");
    const r = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-1"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(r.durable).toBe(true);
    if (r.durable) expect(r.proceed).toBe(true);
    const row = await getGenerationByKey(k);
    expect(row?.state).toBe("reserved");
  });

  it("TRUE-PARALLEL: 8 concurrent identical requests → exactly ONE proceeds, the rest are told to wait (no double charge)", async () => {
    const k = key("parallel");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveOrDecide({ idempotencyKey: k, payload: payload("C-PAR"), adminId: OWNER, maxAuthorisedSpend: 6 })),
    );
    const proceeders = results.filter((r) => r.durable && r.proceed);
    const pending = results.filter((r) => r.durable && !r.proceed && r.action === "accepted_pending");
    expect(proceeders.length).toBe(1); // exactly one paid create may happen
    expect(pending.length).toBe(7); // the other 7 concurrent duplicates are told to wait, not charged
  });

  it("CROSS-MACHINE simulation: two independent callers racing on the SAME shared table → single winner (identical to 2-Fly-machine reality — there is no machine-scoped state, only the shared Postgres row)", async () => {
    const k = key("xmachine");
    const [machineA, machineB] = await Promise.all([
      reserveOrDecide({ idempotencyKey: k, payload: payload("C-XM"), adminId: OWNER, maxAuthorisedSpend: 6 }),
      reserveOrDecide({ idempotencyKey: k, payload: payload("C-XM"), adminId: OWNER, maxAuthorisedSpend: 6 }),
    ]);
    const outcomes = [machineA, machineB];
    expect(outcomes.filter((r) => r.durable && r.proceed).length).toBe(1);
    expect(outcomes.filter((r) => r.durable && !r.proceed && r.action === "accepted_pending").length).toBe(1);
  });

  it("COMPLETED REPLAY: after finalizeSuccess, the SAME key returns the stored result — no recharge", async () => {
    const k = key("replay");
    const first = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-REP"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(first.durable && first.proceed).toBe(true);
    if (!first.durable || !first.proceed) return;
    await finalizeSuccess(first.rowId, { chargedCredits: 6, candidateId: 999 });

    const second = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-REP"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(second.durable).toBe(true);
    if (second.durable) {
      expect(second.proceed).toBe(false);
      if (!second.proceed) {
        expect(second.action).toBe("replay");
        expect(second.row.candidateId).toBe(999); // the ORIGINAL result, reconstructable
        expect(Number(second.row.chargedCredits)).toBe(6);
      }
    }
  });

  it("IN-PROGRESS REPLAY (pending): while still 'reserved', the SAME key is told to wait, never charged again", async () => {
    const k = key("pending");
    const first = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-PEND"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(first.durable && first.proceed).toBe(true);
    // Do NOT finalize — simulate "still generating" (reload/2nd tab hits this while in flight).
    const second = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-PEND"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(second.durable).toBe(true);
    if (second.durable) {
      expect(second.proceed).toBe(false);
      if (!second.proceed) expect(second.action).toBe("accepted_pending");
    }
  });

  it("FAILED-FINAL then a NEW key (simulates client clearing the stored key) → a fresh, real retry is allowed", async () => {
    const k1 = key("failfinal-1");
    const first = await reserveOrDecide({ idempotencyKey: k1, payload: payload("C-FAIL"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(first.durable && first.proceed).toBe(true);
    if (!first.durable || !first.proceed) return;
    await finalizeFailure(first.rowId, { toState: "failed_final", errorClass: "auth", message: "token expired (401)" });

    // The SAME old key resent (e.g. a stray retry that didn't clear its key) must NOT recharge.
    const sameKeyRetry = await reserveOrDecide({ idempotencyKey: k1, payload: payload("C-FAIL"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(sameKeyRetry.durable && !sameKeyRetry.proceed && !sameKeyRetry.proceed && sameKeyRetry.action === "terminal").toBe(true);

    // A FRESH key (what the client mints after seeing the terminal failure) charges again normally.
    const k2 = key("failfinal-2");
    const freshRetry = await reserveOrDecide({ idempotencyKey: k2, payload: payload("C-FAIL"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(freshRetry.durable && freshRetry.proceed).toBe(true);
  });

  it("FAILED-RETRYABLE (provably uncharged) → the SAME key auto-resumes and may proceed", async () => {
    const k = key("retryable");
    const first = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-RETRY"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(first.durable && first.proceed).toBe(true);
    if (!first.durable || !first.proceed) return;
    await finalizeFailure(first.rowId, { toState: "failed_retryable", errorClass: "provider_unavailable", message: "Higgsfield create failed (500)" });

    const resumed = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-RETRY"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(resumed.durable && resumed.proceed).toBe(true); // safe to retry — nothing was charged
    const row = await getGenerationByKey(k);
    expect(row?.state).toBe("reserved"); // flipped back from failed_retryable
  });

  it("DIFFERENT PAYLOADS use SEPARATE keys in normal operation (no collision)", async () => {
    const k1 = key("diffA");
    const k2 = key("diffB");
    const a = await reserveOrDecide({ idempotencyKey: k1, payload: payload("C-DIFF-1"), adminId: OWNER, maxAuthorisedSpend: 6 });
    const b = await reserveOrDecide({ idempotencyKey: k2, payload: payload("C-DIFF-2"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(a.durable && a.proceed).toBe(true);
    expect(b.durable && b.proceed).toBe(true); // independent — neither blocks the other
  });

  it("CONFLICT: the SAME key reused for a genuinely DIFFERENT payload is refused, not charged (defence-in-depth)", async () => {
    const k = key("conflict");
    const first = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-CONF-1"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(first.durable && first.proceed).toBe(true);
    // Still 'reserved' (not finalized) — reuse the SAME key with a DIFFERENT characterId.
    const second = await reserveOrDecide({ idempotencyKey: k, payload: payload("C-CONF-2"), adminId: OWNER, maxAuthorisedSpend: 6 });
    expect(second.durable).toBe(true);
    if (second.durable) {
      expect(second.proceed).toBe(false);
      if (!second.proceed) expect(second.action).toBe("conflict");
    }
  });
});
