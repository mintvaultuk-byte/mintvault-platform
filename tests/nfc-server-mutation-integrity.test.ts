/**
 * REM-NFC-001 — production-storage proof for atomic NFC bind/lock/clear truth.
 *
 * This uses the shipped storage singleton against disposable PostgreSQL 17,
 * with both NFC migrations applied. The database trigger remains the final
 * backstop; these tests prove the application produces truthful, audited 409-
 * capable outcomes before it ever needs that trigger to throw a generic 500.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const LOCK_METHOD = "web_nfc_make_read_only";
const RECOVERY_METHOD = "operator_verified_read_only_recovery";

let cluster: DisposablePostgres17;
let admin: pg.Client;
let appPool: pg.Pool;
let storage: typeof import("../server/storage").storage;

async function seedCertificate(uid: string | null = null): Promise<number> {
  const result = await admin.query<{ id: number }>(
    `INSERT INTO certificates (
       certificate_number, nfc_uid, nfc_enabled, nfc_chip_type, nfc_url,
       nfc_written_at, nfc_written_by
     ) VALUES (
       $1, $2::text, $2::text IS NOT NULL, CASE WHEN $2::text IS NULL THEN NULL ELSE 'NTAG215' END,
       CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END,
       CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
       CASE WHEN $2::text IS NULL THEN NULL ELSE 'writer@example.test' END
     ) RETURNING id`,
    [`MV-NFC-${Math.random().toString(16).slice(2)}`, uid, `https://mintvaultuk.com/nfc/proof`]
  );
  return result.rows[0].id;
}

async function state(id: number): Promise<{
  nfc_uid: string | null;
  nfc_locked: boolean;
  nfc_locked_at: Date | null;
  nfc_lock_pending_uid: string | null;
  nfc_lock_pending_at: Date | null;
}> {
  const result = await admin.query(
    `SELECT nfc_uid, nfc_locked, nfc_locked_at, nfc_lock_pending_uid, nfc_lock_pending_at
       FROM certificates WHERE id=$1`,
    [id]
  );
  return result.rows[0];
}

async function audits(
  id: number
): Promise<Array<{ action: string; admin_user: string; details: Record<string, unknown> }>> {
  const result = await admin.query(
    `SELECT action, admin_user, details FROM audit_log
      WHERE entity_type='certificate' AND entity_id=$1 ORDER BY id`,
    [String(id)]
  );
  return result.rows;
}

function lockEvidence(uid: string, attemptToken = "test-attempt-token") {
  return {
    uid,
    physicalLockConfirmed: true,
    lockMethod: LOCK_METHOD,
    actor: "admin@example.test",
    attemptToken,
  };
}

async function prepare(id: number, uid = "04:AA"): Promise<string> {
  const result = await storage.prepareNfcLock(id, {
    uid,
    lockMethod: LOCK_METHOD,
    actor: "admin@example.test",
  });
  expect(result.outcome).toBe("UPDATED");
  expect(result.attemptToken).toMatch(/^[A-Za-z0-9_-]+$/);
  return result.attemptToken!;
}

async function installFailingAuditTrigger(): Promise<void> {
  await admin.query(`
    CREATE FUNCTION fail_nfc_audit() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'simulated NFC audit failure';
    END
    $$ LANGUAGE plpgsql
  `);
  await admin.query(`
    CREATE TRIGGER fail_nfc_audit BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION fail_nfc_audit()
  `);
}

describe("NFC server mutation integrity (production storage, PostgreSQL 17.10)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("nfc-server-mutation-integrity");
    admin = new pg.Client({ connectionString: cluster.url });
    await admin.connect();
    await admin.query(`
      CREATE TABLE certificates (
        id serial PRIMARY KEY,
        certificate_number text NOT NULL UNIQUE,
        deleted_at timestamptz,
        nfc_uid text,
        nfc_enabled boolean DEFAULT false,
        nfc_chip_type text,
        nfc_url text,
        nfc_locked boolean DEFAULT false,
        nfc_written_at timestamptz,
        nfc_written_by text,
        nfc_locked_at timestamptz,
        nfc_last_verified_at timestamptz,
        nfc_scan_count integer DEFAULT 0,
        nfc_last_scan_at timestamptz,
        nfc_last_scan_ip text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await admin.query(`
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        admin_user text,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await admin.query(readFileSync(new URL("../migrations/0088_nfc_binding_integrity.sql", import.meta.url), "utf8"));
    await admin.query(
      readFileSync(new URL("../migrations/0116_nfc_physical_lock_integrity.sql", import.meta.url), "utf8")
    );
    const lockIntentMigration = readFileSync(
      new URL("../migrations/0118_nfc_lock_intent_reconciliation.sql", import.meta.url),
      "utf8"
    );
    await admin.query(lockIntentMigration);
    await admin.query(lockIntentMigration);

    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    const storageModule = await import("../server/storage");
    storage = storageModule.storage;
    appPool = (await import("../server/db")).pool;
  }, 90_000);

  afterAll(async () => {
    await appPool?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await admin.query(`DROP TRIGGER IF EXISTS fail_nfc_audit ON audit_log`);
    await admin.query(`DROP FUNCTION IF EXISTS fail_nfc_audit()`);
    await admin.query(`TRUNCATE certificates, audit_log RESTART IDENTITY`);
  });

  it("rejects an unconfirmed physical lock and every unsupported lock method", async () => {
    const id = await seedCertificate("04:AA");
    const token = await prepare(id);
    await expect(
      storage.lockNfc(id, { ...lockEvidence("04:AA", token), physicalLockConfirmed: false })
    ).resolves.toEqual({ outcome: "INVALID_PROOF" });
    await expect(storage.lockNfc(id, { ...lockEvidence("04:AA"), lockMethod: "operator_checkbox" })).resolves.toEqual({
      outcome: "UNSUPPORTED_METHOD",
    });
    expect(await state(id)).toMatchObject({ nfc_uid: "04:AA", nfc_locked: false, nfc_locked_at: null });
    expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_lock_prepared"]);
  });

  it("replays 0118 without duplicating or weakening its exact database objects", async () => {
    const objects = await admin.query(`
      SELECT
        (SELECT COUNT(*)::int FROM pg_constraint WHERE conrelid='public.certificates'::regclass
          AND conname='chk_certificates_nfc_lock_pending_complete' AND contype='c' AND convalidated) AS constraints,
        (SELECT COUNT(*)::int FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
          WHERE i.indrelid='public.certificates'::regclass AND i.indisvalid AND i.indisready
            AND idx.relname IN ('uq_certificates_nfc_lock_pending_token_hash','ix_certificates_nfc_lock_pending_at'))
          AS indexes,
        (SELECT COUNT(*)::int FROM pg_trigger WHERE tgrelid='public.certificates'::regclass
          AND tgname='trg_nfc_lock_intent_guards_binding' AND NOT tgisinternal AND tgenabled='A') AS triggers
    `);
    expect(objects.rows[0]).toEqual({ constraints: 1, indexes: 2, triggers: 1 });
  });

  it("fails closed instead of accepting an incompatible pre-existing pending column", async () => {
    const migration = readFileSync(
      new URL("../migrations/0118_nfc_lock_intent_reconciliation.sql", import.meta.url),
      "utf8"
    );
    await admin.query("BEGIN");
    try {
      await admin.query(`
        ALTER TABLE public.certificates RENAME COLUMN nfc_lock_pending_by TO nfc_lock_pending_by_backup;
        ALTER TABLE public.certificates ADD COLUMN nfc_lock_pending_by integer
      `);
      await expect(admin.query(migration)).rejects.toThrow(/incompatible NFC lock-intent columns/);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("requires the physically confirmed request UID to equal the stored binding", async () => {
    const id = await seedCertificate("04:AA");
    const token = await prepare(id);
    await expect(storage.lockNfc(id, lockEvidence("04:BB", token))).resolves.toEqual({ outcome: "UID_MISMATCH" });
    expect(await state(id)).toMatchObject({ nfc_uid: "04:AA", nfc_locked: false, nfc_locked_at: null });
    expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_lock_prepared"]);
  });

  it("stores only the token hash and never puts the raw confirmation capability in audit", async () => {
    const id = await seedCertificate("04:AA");
    const token = await prepare(id);
    const stored = await admin.query<{ nfc_lock_pending_token_hash: string }>(
      "SELECT nfc_lock_pending_token_hash FROM certificates WHERE id=$1",
      [id]
    );
    expect(stored.rows[0].nfc_lock_pending_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored.rows[0].nfc_lock_pending_token_hash).not.toContain(token);
    expect(JSON.stringify(await audits(id))).not.toContain(token);
    await expect(
      storage.prepareNfcLock(id, {
        uid: "04:AA",
        lockMethod: LOCK_METHOD,
        actor: "admin@example.test",
      })
    ).resolves.toEqual({ outcome: "LOCK_PENDING" });
  });

  it("locks and audits once, while an identical replay preserves the original timestamp", async () => {
    const id = await seedCertificate("04:AA");
    const token = await prepare(id);
    await expect(storage.lockNfc(id, lockEvidence("04:aa", token))).resolves.toEqual({ outcome: "UPDATED" });
    const first = await state(id);
    await expect(storage.lockNfc(id, lockEvidence("04:AA", token))).resolves.toEqual({ outcome: "UNCHANGED" });
    const replay = await state(id);
    expect(replay).toEqual(first);
    expect(await audits(id)).toEqual([
      expect.objectContaining({ action: "nfc_lock_prepared" }),
      {
        action: "nfc_locked",
        admin_user: "admin@example.test",
        details: {
          uid: "04:AA",
          lock_method: LOCK_METHOD,
          physical_lock_evidence: "browser_make_read_only_completion",
          web_nfc_make_read_only_confirmed: true,
          recovery_reason: null,
        },
      },
    ]);
  });

  it("returns LOCKED for bind, replace and clear without changing or re-auditing the binding", async () => {
    const id = await seedCertificate("04:AA");
    const token = await prepare(id);
    await storage.lockNfc(id, lockEvidence("04:AA", token));
    const locked = await state(id);
    await expect(
      storage.saveNfcData(id, {
        uid: "04:AA",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: false,
        expectedUid: "04:AA",
      })
    ).resolves.toEqual({ outcome: "LOCKED" });
    await expect(
      storage.saveNfcData(id, {
        uid: "04:BB",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: true,
        expectedUid: "04:AA",
      })
    ).resolves.toEqual({ outcome: "LOCKED" });
    await expect(storage.clearNfc(id, { actor: "admin@example.test", reason: "damaged" })).resolves.toEqual({
      outcome: "LOCKED",
    });
    expect(await state(id)).toEqual(locked);
    expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_lock_prepared", "nfc_locked"]);
  });

  it("commits bind and clear with their audit facts", async () => {
    const id = await seedCertificate();
    await expect(
      storage.saveNfcData(id, {
        uid: "04:AA",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: false,
        expectedUid: null,
      })
    ).resolves.toEqual({ outcome: "UPDATED" });
    await expect(storage.clearNfc(id, { actor: "admin@example.test", reason: "failed QA" })).resolves.toEqual({
      outcome: "UPDATED",
    });
    expect(await state(id)).toMatchObject({ nfc_uid: null, nfc_locked: false });
    expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_bound", "nfc_cleared"]);
  });

  it("rolls the lock back when its audit insert fails", async () => {
    const id = await seedCertificate("04:AA");
    const token = await prepare(id);
    await installFailingAuditTrigger();
    await expect(storage.lockNfc(id, lockEvidence("04:AA", token))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/simulated NFC audit failure/) }),
    });
    expect(await state(id)).toMatchObject({ nfc_uid: "04:AA", nfc_locked: false, nfc_locked_at: null });
    expect(await state(id)).toMatchObject({ nfc_lock_pending_uid: "04:AA" });
    expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_lock_prepared"]);
  });

  it("rolls bind and clear back when their audit fact cannot commit", async () => {
    const unbound = await seedCertificate();
    const bound = await seedCertificate("04:CLEAR");
    await installFailingAuditTrigger();
    await expect(
      storage.saveNfcData(unbound, {
        uid: "04:BIND",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: false,
        expectedUid: null,
      })
    ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/audit failure/) }) });
    await expect(storage.clearNfc(bound, { actor: "admin@example.test", reason: "failed QA" })).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/audit failure/) }),
    });
    expect(await state(unbound)).toMatchObject({ nfc_uid: null, nfc_locked: false });
    expect(await state(bound)).toMatchObject({ nfc_uid: "04:CLEAR", nfc_locked: false });
    expect(await audits(unbound)).toEqual([]);
    expect(await audits(bound)).toEqual([]);
  });

  it("rejects a stale expected binding instead of overwriting a concurrent change", async () => {
    const id = await seedCertificate("04:CURRENT");
    await expect(
      storage.saveNfcData(id, {
        uid: "04:NEW",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: true,
        expectedUid: "04:STALE",
      })
    ).resolves.toEqual({ outcome: "STALE_BINDING" });
    expect(await state(id)).toMatchObject({ nfc_uid: "04:CURRENT", nfc_locked: false });
    expect(await audits(id)).toEqual([]);
  });

  it("serializes concurrent replace and lock preparation so the physical UID is frozen before device work", async () => {
    const id = await seedCertificate("04:AA");
    const [lock, replace] = await Promise.all([
      storage.prepareNfcLock(id, { uid: "04:AA", lockMethod: LOCK_METHOD, actor: "admin@example.test" }),
      storage.saveNfcData(id, {
        uid: "04:BB",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: true,
        expectedUid: "04:AA",
      }),
    ]);
    const final = await state(id);
    if (final.nfc_lock_pending_at) {
      expect(final.nfc_uid).toBe("04:AA");
      expect([lock.outcome, replace.outcome]).toEqual(["UPDATED", "LOCK_PENDING"]);
      await expect(storage.lockNfc(id, lockEvidence("04:AA", lock.attemptToken!))).resolves.toEqual({
        outcome: "UPDATED",
      });
      expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_lock_prepared", "nfc_locked"]);
    } else {
      expect(final.nfc_uid).toBe("04:BB");
      expect([lock.outcome, replace.outcome]).toEqual(["UID_MISMATCH", "UPDATED"]);
      expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_bound"]);
    }
  });

  it("keeps pending bindings frozen, then permits token-bound audited cancellation", async () => {
    const id = await seedCertificate("04:AA");
    const token = await prepare(id);
    await expect(storage.clearNfc(id, { actor: "admin@example.test", reason: "unsafe" })).resolves.toEqual({
      outcome: "LOCK_PENDING",
    });
    await expect(
      storage.saveNfcData(id, {
        uid: "04:BB",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: true,
        expectedUid: "04:AA",
      })
    ).resolves.toEqual({ outcome: "LOCK_PENDING" });
    await expect(
      storage.cancelNfcLock(id, {
        uid: "04:AA",
        attemptToken: "wrong",
        verificationMethod: "operator_verified_writable",
        actor: "admin@example.test",
        reason: "verified writable",
      })
    ).resolves.toEqual({ outcome: "INTENT_MISMATCH" });
    await expect(
      storage.cancelNfcLock(id, {
        uid: "04:AA",
        attemptToken: token,
        verificationMethod: "operator_verified_writable",
        actor: "admin@example.test",
        reason: "verified writable with encoder",
      })
    ).resolves.toEqual({ outcome: "UPDATED" });
    expect(await state(id)).toMatchObject({ nfc_uid: "04:AA", nfc_locked: false, nfc_lock_pending_at: null });
    expect((await audits(id)).map((row) => row.action)).toEqual(["nfc_lock_prepared", "nfc_lock_cancelled"]);
  });

  it("supports distinct reasoned operator recovery without claiming browser proof", async () => {
    const id = await seedCertificate("04:AA");
    await prepare(id);
    await expect(
      storage.lockNfc(id, {
        uid: "04:AA",
        physicalLockConfirmed: false,
        operatorReadOnlyVerified: true,
        lockMethod: RECOVERY_METHOD,
        reason: "verified read-only with independent NFC tool",
        actor: "superadmin@example.test",
      })
    ).resolves.toEqual({ outcome: "UPDATED" });
    const lockedAudit = (await audits(id)).at(-1)!;
    expect(lockedAudit.details).toMatchObject({
      lock_method: RECOVERY_METHOD,
      physical_lock_evidence: "operator_verified_read_only",
      web_nfc_make_read_only_confirmed: false,
      recovery_reason: "verified read-only with independent NFC tool",
    });
  });

  it("keeps the 0088 one-live-certificate-per-UID invariant under concurrent bind", async () => {
    const first = await seedCertificate();
    const second = await seedCertificate();
    const bind = (id: number) =>
      storage.saveNfcData(id, {
        uid: "04:SAME",
        chipType: "NTAG215",
        url: "https://mintvaultuk.com/nfc/proof",
        actor: "admin@example.test",
        overwrite: false,
        expectedUid: null,
      });
    const settled = await Promise.allSettled([bind(first), bind(second)]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ cause: expect.objectContaining({ code: "23505" }) }),
    });
    const live = await admin.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM certificates WHERE lower(nfc_uid)=lower('04:SAME')`
    );
    expect(live.rows[0].count).toBe(1);
    expect(
      (await admin.query(`SELECT COUNT(*)::int AS count FROM audit_log WHERE action='nfc_bound'`)).rows[0].count
    ).toBe(1);
  });

  it("pins the admin routes to strict proof validation and 409 locked/mismatch outcomes", () => {
    const source = readFileSync("server/routes.ts", "utf8");
    const section = source.slice(
      source.indexOf("// ── NFC ADMIN ROUTES"),
      source.indexOf("// ── NFC PUBLIC SCAN ROUTE")
    );
    expect(section).toContain("/nfc/lock/prepare");
    expect(section).toContain("req.body?.physicalLockConfirmed !== true");
    expect(section).toContain("isSupportedNfcPhysicalLockMethod(lockMethod)");
    expect(section).toContain("operatorReadOnlyVerified");
    expect(section).toContain("storage.cancelNfcLock");
    expect(section).toContain('code: "NFC_LOCK_PENDING"');
    expect(section).toContain('code: "NFC_UID_MISMATCH"');
    expect(section.match(/code: "NFC_LOCKED"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(section).not.toContain("storage.writeAuditLog");
    expect(section).not.toMatch(/storage\.lockNfc\(id\)\s*[;)]/);
  });
});
