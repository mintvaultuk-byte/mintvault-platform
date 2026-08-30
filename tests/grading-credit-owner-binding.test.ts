/**
 * PKG-1 — customer grading-credit identity binding (financial integrity).
 *
 * Confirms the security invariant that a grading credit applied to a checkout is
 * consumed ONLY against the authenticated user who reserved it — never against a
 * user derived from the customer-supplied submission email. Exercised end-to-end
 * against a real PostgreSQL 17.10 cluster through the exported checkout/fulfilment
 * surface (reserveCredit + fulfilPaidSubmission) with the production SQL.
 *
 * The credit primitives and fulfilPaidSubmission accept an injected SQL executor /
 * storage purely so these tests can run against a disposable local cluster (no
 * SSL) — production callers pass nothing and use the real db + storage. No runtime
 * behaviour is changed by the injection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

// Never send real confirmation emails during fulfilment.
vi.mock("../server/email", () => ({
  sendSubmissionConfirmation: vi.fn(async () => {}),
  sendSubmissionConfirmationV2: vi.fn(async () => {}),
}));
// Avoid needing signing secrets for the (fire-and-forget) packing-slip token.
vi.mock("../server/lib/pdf-token", () => ({
  generatePdfToken: vi.fn(() => "test-token"),
  verifyPdfToken: vi.fn(() => true),
}));

let cluster: DisposablePostgres17;
let admin: pg.Client;
let pool: pg.Pool;
let testDb: ReturnType<typeof drizzle>;
let submissions: typeof import("../server/routes/submissions");

let userSeq = 0;

/** Audit rows captured by the fake store, for reconciliation assertions. */
interface CapturedAudit {
  entityType: string;
  entityId: string;
  action: string;
  details: Record<string, unknown>;
}

/** A minimal, DB-backed fake of the storage surface fulfilPaidSubmission uses.
 *  markSubmissionAsPaid hits the real cluster so the atomic paid-transition gate
 *  (idempotency / concurrency) is genuinely exercised, not simulated in JS. */
function makeFakeStore(audits: CapturedAudit[]) {
  return {
    async markSubmissionAsPaid(id: number): Promise<boolean> {
      const r = await pool.query(
        `UPDATE submissions SET payment_status='paid'
           WHERE id=$1 AND (payment_status IS NULL OR payment_status<>'paid')
         RETURNING id`,
        [id]
      );
      return (r.rowCount ?? 0) > 0;
    },
    async setEstimatedCompletionDate(_id: number): Promise<void> {},
    async writeAuditLog(
      entityType: string,
      entityId: string,
      action: string,
      _adminUser: string | null,
      details: Record<string, unknown> = {}
    ): Promise<void> {
      audits.push({ entityType, entityId, action, details });
    },
    async getUserByEmail(email: string): Promise<any> {
      const r = await pool.query(`SELECT id, email FROM users WHERE email=$1 LIMIT 1`, [email.toLowerCase()]);
      return r.rows[0];
    },
    async createUser(u: { email: string }): Promise<any> {
      const r = await pool.query(`INSERT INTO users (email) VALUES ($1) RETURNING id, email`, [u.email.toLowerCase()]);
      return r.rows[0];
    },
    async updateSubmission(_id: number, _patch: Record<string, unknown>): Promise<void> {},
  } as unknown as typeof import("../server/storage").storage;
}

async function seedUser(): Promise<{ id: string; email: string }> {
  const email = `pkg1-user-${++userSeq}@example.test`;
  const r = await admin.query<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [email]);
  return { id: r.rows[0].id, email };
}

/** Grant one available (unused, unexpired, unreserved) credit; returns its id. */
async function grantCredit(userId: string, creditType = "member"): Promise<number> {
  const r = await admin.query<{ id: number }>(
    `INSERT INTO member_credits (user_id, credit_type, expires_at, source)
     VALUES ($1, $2, NOW() + INTERVAL '30 days', 'test') RETURNING id`,
    [userId, creditType]
  );
  return r.rows[0].id;
}

async function newSubmissionRow(): Promise<number> {
  const r = await admin.query<{ id: number }>(
    `INSERT INTO submissions (payment_status) VALUES (NULL) RETURNING id`,
    []
  );
  return r.rows[0].id;
}

async function countUnused(userId: string): Promise<number> {
  const r = await admin.query<{ cnt: string }>(
    `SELECT COUNT(*) cnt FROM member_credits WHERE user_id=$1 AND used_at IS NULL`,
    [userId]
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function creditUsedForSubmission(creditId: number): Promise<number | null> {
  const r = await admin.query<{ used_for_submission_id: number | null }>(
    `SELECT used_for_submission_id FROM member_credits WHERE id=$1`,
    [creditId]
  );
  return r.rows[0]?.used_for_submission_id ?? null;
}

/** Build a paid-grading PaymentIntent-style metadata bag with the credit binding. */
function creditMeta(opts: {
  reservedCreditId?: number | null;
  creditOwnerUserId?: string | null;
  creditType?: string;
}): Record<string, string> {
  const meta: Record<string, string> = {
    creditApplied: "true",
    creditType: opts.creditType ?? "member",
    creditAmountPence: "1500",
  };
  if (opts.reservedCreditId != null) meta.reservedCreditId = String(opts.reservedCreditId);
  if (opts.creditOwnerUserId != null) meta.creditOwnerUserId = opts.creditOwnerUserId;
  return meta;
}

describe("PKG-1 grading-credit owner binding (PostgreSQL 17.10)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("pkg1-credit-owner-binding");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();

    await admin.query(`
      CREATE TABLE users (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar UNIQUE,
        first_name text,
        last_name text,
        vault_club_tier text,
        vault_club_status text,
        deleted_at timestamptz
      )`);
    await admin.query(`
      CREATE TABLE member_credits (
        id serial PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        credit_type text NOT NULL DEFAULT 'member',
        granted_at timestamptz DEFAULT NOW(),
        expires_at timestamptz,
        used_at timestamptz,
        used_for_submission_id integer,
        source text,
        reserved_at timestamptz,
        reserved_until timestamptz,
        reserved_for_tracking_number text
      )`);
    await admin.query(`
      CREATE TABLE submissions (
        id serial PRIMARY KEY,
        payment_status text,
        user_id varchar
      )`);

    pool = new pg.Pool({ connectionString: cluster.url, max: 6 });
    testDb = drizzle(pool);

    // The module reads MINTVAULT_DATABASE_URL at import; point it at the cluster so
    // the (unused, injected-over) default db pool constructs without throwing.
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    submissions = await import("../server/routes/submissions");
  }, 90_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  // ── reserveCredit primitive ──────────────────────────────────────────────
  describe("reserveCredit", () => {
    it("reserves exactly one available credit and refuses a second when none remain", async () => {
      const a = await seedUser();
      const creditId = await grantCredit(a.id);
      const firstSubmissionId = await newSubmissionRow();
      const secondSubmissionId = await newSubmissionRow();

      const first = await submissions.reserveCredit(a.id, "member", `MV-SUB-${firstSubmissionId}`, testDb);
      expect(first).toBe(creditId);

      // The user's only credit is now reserved — a concurrent checkout gets nothing.
      const second = await submissions.reserveCredit(a.id, "member", `MV-SUB-${secondSubmissionId}`, testDb);
      expect(second).toBeNull();
    });

    it("returns null for a user with no credit (guest-equivalent)", async () => {
      const a = await seedUser();
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb);
      expect(reserved).toBeNull();
    });

    it("never reuses an elapsed reservation while its original PaymentIntent can still be paid", async () => {
      const a = await seedUser();
      const creditId = await grantCredit(a.id);
      const firstSubmissionId = await newSubmissionRow();
      const secondSubmissionId = await newSubmissionRow();

      expect(await submissions.reserveCredit(a.id, "member", `MV-SUB-${firstSubmissionId}`, testDb)).toBe(creditId);
      await admin.query(`UPDATE member_credits SET reserved_until=NOW() - INTERVAL '1 minute' WHERE id=$1`, [creditId]);

      expect(await submissions.reserveCredit(a.id, "member", `MV-SUB-${secondSubmissionId}`, testDb)).toBeNull();
      const binding = await admin.query<{ reserved_for_tracking_number: string }>(
        `SELECT reserved_for_tracking_number FROM member_credits WHERE id=$1`,
        [creditId]
      );
      expect(binding.rows[0].reserved_for_tracking_number).toBe(`MV-SUB-${firstSubmissionId}`);
    });
  });

  // ── fulfilPaidSubmission credit consumption ──────────────────────────────
  describe("fulfilPaidSubmission credit consumption", () => {
    let audits: CapturedAudit[];
    let store: ReturnType<typeof makeFakeStore>;

    beforeEach(() => {
      audits = [];
      store = makeFakeStore(audits);
    });

    it("(1) same-user success: consumes the reserving user's exact reserved credit once", async () => {
      const a = await seedUser();
      const creditId = await grantCredit(a.id);
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb);
      expect(reserved).toBe(creditId);

      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: a.email },
        creditMeta({ reservedCreditId: reserved, creditOwnerUserId: a.id }),
        1500,
        { storage: store, exec: testDb }
      );

      expect(res.fulfilled).toBe(true);
      expect(await countUnused(a.id)).toBe(0);
      expect(await creditUsedForSubmission(creditId)).toBe(subId);
      expect(audits.filter((x) => x.action === "CREDIT_CONSUME_FAILED")).toHaveLength(0);
    });

    it("(2) cross-user email attack: submission email = User B never consumes B's credit", async () => {
      const attacker = await seedUser(); // reserving session user (A)
      const victim = await seedUser(); // owns a credit; email points here
      const attackerCredit = await grantCredit(attacker.id);
      const victimCredit = await grantCredit(victim.id);
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(attacker.id, "member", `MV-SUB-${subId}`, testDb);
      expect(reserved).toBe(attackerCredit);

      // Submission email belongs to the VICTIM; owner metadata is the ATTACKER (server-bound).
      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: victim.email },
        creditMeta({ reservedCreditId: reserved, creditOwnerUserId: attacker.id }),
        1500,
        { storage: store, exec: testDb }
      );

      expect(res.fulfilled).toBe(true);
      // Attacker's own reserved credit was burned…
      expect(await creditUsedForSubmission(attackerCredit)).toBe(subId);
      // …and the victim's credit is completely untouched.
      expect(await countUnused(victim.id)).toBe(1);
      expect(await creditUsedForSubmission(victimCredit)).toBeNull();
    });

    it("(3a) email with no account but valid reservation: still consumes the owner's reserved credit", async () => {
      const a = await seedUser();
      const creditId = await grantCredit(a.id);
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb);
      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: "nobody-no-account@example.test" },
        creditMeta({ reservedCreditId: reserved, creditOwnerUserId: a.id }),
        1500,
        { storage: store, exec: testDb }
      );

      expect(res.fulfilled).toBe(true);
      expect(await creditUsedForSubmission(creditId)).toBe(subId);
      expect(audits.filter((x) => x.action === "CREDIT_CONSUME_FAILED")).toHaveLength(0);
    });

    it("(3b) discount without a live reservation: fails closed and records reconciliation evidence", async () => {
      const a = await seedUser();
      const creditId = await grantCredit(a.id);
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb);
      // The reserved row is consumed by another order before this fulfilment runs.
      await admin.query(`UPDATE member_credits SET used_at=NOW() WHERE id=$1`, [creditId]);

      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: "nobody@example.test" },
        creditMeta({ reservedCreditId: reserved, creditOwnerUserId: a.id }),
        1500,
        { storage: store, exec: testDb }
      );

      // Charge already succeeded so the submission is still marked paid, but NO
      // second credit is claimed and a reconciliation audit row is written.
      expect(res.fulfilled).toBe(true);
      const failed = audits.filter((x) => x.action === "CREDIT_CONSUME_FAILED");
      expect(failed).toHaveLength(1);
      expect(failed[0].details.reason).toBe("reserved_credit_unavailable");
      expect(failed[0].details.reservedCreditId).toBe(reserved);
    });

    it("(4) tamper/mismatch: reserved row that does not belong to the bound owner is not consumed", async () => {
      const a = await seedUser();
      const b = await seedUser();
      const aCredit = await grantCredit(a.id);
      const bCredit = await grantCredit(b.id);
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb); // A's row
      expect(reserved).toBe(aCredit);

      // Owner bound to B but the reserved id is A's row — the owner pin must reject it.
      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: a.email },
        creditMeta({ reservedCreditId: reserved, creditOwnerUserId: b.id }),
        1500,
        { storage: store, exec: testDb }
      );

      expect(res.fulfilled).toBe(true);
      // Neither A's nor B's credit is consumed — fail closed.
      expect(await creditUsedForSubmission(aCredit)).toBeNull();
      expect(await creditUsedForSubmission(bCredit)).toBeNull();
      expect(audits.filter((x) => x.action === "CREDIT_CONSUME_FAILED")).toHaveLength(1);
    });

    it("(5) webhook replay: replaying the same paid event does not consume a second credit", async () => {
      const a = await seedUser();
      const reservedCredit = await grantCredit(a.id);
      const spareCredit = await grantCredit(a.id); // A has TWO credits
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb);
      expect(reserved).toBe(reservedCredit);

      const meta = creditMeta({ reservedCreditId: reserved, creditOwnerUserId: a.id });
      const submission = { id: subId, submissionId: `MV-SUB-${subId}`, email: a.email };

      const first = await submissions.fulfilPaidSubmission(submission, meta, 1500, { storage: store, exec: testDb });
      const second = await submissions.fulfilPaidSubmission(submission, meta, 1500, { storage: store, exec: testDb });

      expect(first.fulfilled).toBe(true);
      expect(second.fulfilled).toBe(false); // idempotent no-op
      // Exactly the reserved credit consumed; the spare remains available.
      expect(await creditUsedForSubmission(reservedCredit)).toBe(subId);
      expect(await creditUsedForSubmission(spareCredit)).toBeNull();
      expect(await countUnused(a.id)).toBe(1);
    });

    it("(6) concurrent fulfilment: two simultaneous attempts consume only one credit", async () => {
      const a = await seedUser();
      const reservedCredit = await grantCredit(a.id);
      const spareCredit = await grantCredit(a.id);
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb);
      const meta = creditMeta({ reservedCreditId: reserved, creditOwnerUserId: a.id });
      const submission = { id: subId, submissionId: `MV-SUB-${subId}`, email: a.email };

      const [r1, r2] = await Promise.all([
        submissions.fulfilPaidSubmission(submission, meta, 1500, { storage: store, exec: testDb }),
        submissions.fulfilPaidSubmission(submission, meta, 1500, { storage: store, exec: testDb }),
      ]);

      // Exactly one caller wins the atomic paid transition.
      expect([r1.fulfilled, r2.fulfilled].filter(Boolean)).toHaveLength(1);
      expect(await creditUsedForSubmission(reservedCredit)).toBe(subId);
      expect(await creditUsedForSubmission(spareCredit)).toBeNull();
      expect(await countUnused(a.id)).toBe(1);
    });

    it("(7) guest / no-credit checkout: no credit metadata means no consumption and no audit", async () => {
      const subId = await newSubmissionRow();
      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: "guest@example.test" },
        { serviceType: "grading" }, // no creditApplied
        1500,
        { storage: store, exec: testDb }
      );
      expect(res.fulfilled).toBe(true);
      expect(audits.filter((x) => x.action === "CREDIT_CONSUME_FAILED")).toHaveLength(0);
    });

    it("(8) logged-in checkout that applies no credit is unchanged", async () => {
      const a = await seedUser();
      await grantCredit(a.id); // owns a credit but did NOT apply it
      const subId = await newSubmissionRow();
      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: a.email },
        { serviceType: "grading" },
        1500,
        { storage: store, exec: testDb }
      );
      expect(res.fulfilled).toBe(true);
      expect(await countUnused(a.id)).toBe(1); // untouched
      expect(audits.filter((x) => x.action === "CREDIT_CONSUME_FAILED")).toHaveLength(0);
    });

    it("(in-flight) reserved PI with no owner binding consumes the exact reserved row by id alone, never email", async () => {
      const a = await seedUser(); // reserving user
      const victim = await seedUser(); // email points here
      const aCredit = await grantCredit(a.id);
      const victimCredit = await grantCredit(victim.id);
      const subId = await newSubmissionRow();
      const reserved = await submissions.reserveCredit(a.id, "member", `MV-SUB-${subId}`, testDb);
      expect(reserved).toBe(aCredit);

      // reservedCreditId present, creditOwnerUserId ABSENT (a PI created just before
      // owner-binding shipped). Email belongs to the victim and must be ignored.
      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: victim.email },
        creditMeta({ reservedCreditId: reserved }),
        1500,
        { storage: store, exec: testDb }
      );
      expect(res.fulfilled).toBe(true);
      expect(await creditUsedForSubmission(aCredit)).toBe(subId); // A's reserved row burned
      expect(await creditUsedForSubmission(victimCredit)).toBeNull(); // victim untouched
    });

    it("(legacy) PI without owner binding falls back to the email-derived user", async () => {
      const a = await seedUser();
      const creditId = await grantCredit(a.id);
      const subId = await newSubmissionRow();
      // No reservedCreditId, no creditOwnerUserId — a pre-binding legacy PI.
      const res = await submissions.fulfilPaidSubmission(
        { id: subId, submissionId: `MV-SUB-${subId}`, email: a.email },
        { creditApplied: "true", creditType: "member", creditAmountPence: "1500" },
        1500,
        { storage: store, exec: testDb }
      );
      expect(res.fulfilled).toBe(true);
      expect(await creditUsedForSubmission(creditId)).toBe(subId);
    });
  });
});
