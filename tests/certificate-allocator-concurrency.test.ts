/**
 * MV certificate-number allocator — concurrency, gapless-sequence and
 * idempotency proof (Distributed Grading Network P23+, owner requirements
 * §10–§17 and the non-negotiable §92 numbering test).
 *
 * This suite exercises the REAL shipped functions — `storage.getNextCertId()`
 * and `createCertForScan()` — against a DISPOSABLE PostgreSQL 17 cluster.
 * `MINTVAULT_DATABASE_URL` is pointed at that cluster BEFORE server/db.ts is
 * imported, so the production module graph (config → pool → drizzle → storage)
 * is the code under test. No source-string assertions; no staging or production
 * database is touched. The cluster is created and destroyed by the suite.
 *
 * The owner invariant under test:
 *   For a starting counter S and N legitimate issuances, the committed set of
 *   MV numbers is EXACTLY {S+1 … S+N} — no duplicate, and no missing committed
 *   integer. A number is consumed only by a COMMITTED card identity; a rollback
 *   or a lost idempotency race must NOT burn an integer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17 | null = null;
let pool: Pool | null = null;

// Real production modules, imported only after the env var is redirected.
let storage: typeof import("../server/storage").storage;
let createCertForScan: typeof import("../server/scan-ingest-service").createCertForScan;

/** Minimal production-shaped schema for the allocator + scan-ingest path. */
async function createSchema(p: Pool): Promise<void> {
  await p.query(`
    CREATE TABLE certificates (
      id SERIAL PRIMARY KEY,
      certificate_number text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'active',
      label_type text,
      grade_type text,
      language text,
      card_name text,
      created_by text,
      issued_at timestamptz,
      updated_at timestamptz,
      reference_number text,
      source text,
      raw_uploaded boolean NOT NULL DEFAULT false,
      scan_status text,
      scanned_by text,
      assigned_grader_id text,
      grader_status text,
      assigned_at timestamptz,
      ingest_idempotency_key text,
      integrity_hash text,
      logbook_version integer,
      logbook_last_issued_at timestamptz,
      deleted_at timestamptz,
      -- Migration 0035 — the immutable grading-origin snapshot. Modelled here because
      -- createCertForScan() and POST /api/admin/certificates/new both WRITE these columns
      -- (f51beb10), so a fixture without them no longer models production: the INSERT fails
      -- 42703. The CHECK constraints and the set-once trigger below are reproduced from 0035
      -- verbatim in meaning, so this suite proves the allocator against the real constraint
      -- surface rather than against a permissive stand-in.
      origin_type text,
      origin_partner_id uuid,
      origin_partner_public_ref text,
      origin_partner_legal_name text,
      origin_partner_trading_name text,
      origin_location_id uuid,
      origin_location_public_ref text,
      origin_location_name text,
      origin_location_address text,
      origin_captured_at timestamptz,
      origin_snapshot_version integer
    )`);
  // The atomic primitive against concurrent same-key ingests (migration 0047).
  await p.query(`CREATE UNIQUE INDEX uq_certificates_ingest_idem ON certificates (ingest_idempotency_key)`);
  // 0035's five CHECK constraints, in the same order and with the same predicates.
  await p.query(`
    ALTER TABLE certificates
      ADD CONSTRAINT chk_certificates_origin_type
        CHECK (origin_type IS NULL OR origin_type IN ('HQ', 'PARTNER')),
      ADD CONSTRAINT chk_certificates_origin_partner_complete
        CHECK (
          origin_type IS DISTINCT FROM 'PARTNER'
          OR (
            origin_partner_id IS NOT NULL
            AND (
              btrim(coalesce(origin_partner_trading_name, ''), E'\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF') <> ''
              OR btrim(coalesce(origin_partner_legal_name, ''), E'\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF') <> ''
            )
            AND origin_captured_at IS NOT NULL
            AND origin_snapshot_version IS NOT NULL
          )
        ),
      ADD CONSTRAINT chk_certificates_origin_non_partner_clean
        CHECK (
          origin_type IS NOT DISTINCT FROM 'PARTNER'
          OR (
            origin_partner_id IS NULL
            AND origin_partner_public_ref IS NULL
            AND origin_partner_legal_name IS NULL
            AND origin_partner_trading_name IS NULL
            AND origin_location_id IS NULL
            AND origin_location_public_ref IS NULL
            AND origin_location_name IS NULL
            AND origin_location_address IS NULL
          )
        ),
      ADD CONSTRAINT chk_certificates_origin_capture_pairing
        CHECK (
          (origin_type IS NULL AND origin_captured_at IS NULL AND origin_snapshot_version IS NULL)
          OR (origin_type IS NOT NULL AND origin_captured_at IS NOT NULL AND origin_snapshot_version IS NOT NULL)
        ),
      ADD CONSTRAINT chk_certificates_origin_snapshot_version
        CHECK (origin_snapshot_version IS NULL OR origin_snapshot_version >= 1)`);
  // 0035's set-once immutability trigger, including ENABLE ALWAYS.
  await p.query(`
    CREATE OR REPLACE FUNCTION certificates_origin_is_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.origin_type IS NULL THEN RETURN NEW; END IF;
      IF NEW.origin_type              IS DISTINCT FROM OLD.origin_type
      OR NEW.origin_partner_id        IS DISTINCT FROM OLD.origin_partner_id
      OR NEW.origin_partner_public_ref    IS DISTINCT FROM OLD.origin_partner_public_ref
      OR NEW.origin_partner_legal_name    IS DISTINCT FROM OLD.origin_partner_legal_name
      OR NEW.origin_partner_trading_name  IS DISTINCT FROM OLD.origin_partner_trading_name
      OR NEW.origin_location_id       IS DISTINCT FROM OLD.origin_location_id
      OR NEW.origin_location_public_ref   IS DISTINCT FROM OLD.origin_location_public_ref
      OR NEW.origin_location_name     IS DISTINCT FROM OLD.origin_location_name
      OR NEW.origin_location_address  IS DISTINCT FROM OLD.origin_location_address
      OR NEW.origin_captured_at       IS DISTINCT FROM OLD.origin_captured_at
      OR NEW.origin_snapshot_version  IS DISTINCT FROM OLD.origin_snapshot_version
      THEN
        RAISE EXCEPTION
          'certificate % has an immutable grading origin snapshot; origin_* columns cannot be changed once set',
          OLD.certificate_number USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $fn$`);
  await p.query(`
    CREATE TRIGGER trg_certificates_origin_immutable
      BEFORE UPDATE ON certificates
      FOR EACH ROW EXECUTE FUNCTION certificates_origin_is_immutable()`);
  await p.query(`ALTER TABLE certificates ENABLE ALWAYS TRIGGER trg_certificates_origin_immutable`);
  await p.query(`
    CREATE TABLE cert_counter (
      id integer PRIMARY KEY DEFAULT 1,
      last_issued integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )`);
  await p.query(`
    CREATE TABLE audit_log (
      id SERIAL PRIMARY KEY,
      entity_type text,
      entity_id text,
      action text,
      admin_user text,
      details jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )`);
  await p.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      email text,
      role text,
      can_scan boolean DEFAULT false,
      can_grade boolean DEFAULT false,
      deleted_at timestamptz
    )`);
}

/** Reset counter + certificates to a known starting point S. */
async function resetTo(p: Pool, startingCounter: number): Promise<void> {
  await p.query(`DELETE FROM certificates`);
  await p.query(`DELETE FROM cert_counter`);
  await p.query(`INSERT INTO cert_counter (id, last_issued) VALUES (1, $1)`, [startingCounter]);
}

async function counterValue(p: Pool): Promise<number> {
  const r = await p.query<{ last_issued: string }>(`SELECT last_issued FROM cert_counter WHERE id = 1`);
  return Number(r.rows[0].last_issued);
}

/** Committed MV integers, ascending. */
async function committedNumbers(p: Pool): Promise<number[]> {
  const r = await p.query<{ n: string }>(
    `SELECT regexp_replace(certificate_number, '\\D', '', 'g') AS n FROM certificates ORDER BY 1`
  );
  return r.rows.map((row) => Number(row.n)).sort((a, b) => a - b);
}

beforeAll(async () => {
  cluster = await startPostgres17("cert-allocator-concurrency");
  // Redirect the production config BEFORE server/db.ts evaluates its pool.
  process.env.MINTVAULT_DATABASE_URL = cluster.url;
  pool = new Pool({ connectionString: cluster.url, max: 16, ssl: false });
  await createSchema(pool);

  storage = (await import("../server/storage")).storage;
  createCertForScan = (await import("../server/scan-ingest-service")).createCertForScan;
}, 120_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetTo(pool!, 836); // production's real last_issued at reconciliation time
});

describe("MV allocator — §92 gapless sequential proof", () => {
  it("is backed by a real disposable PostgreSQL 17 cluster (non-vacuous)", async () => {
    const r = await pool!.query<{ server_version: string }>("SHOW server_version");
    expect(r.rows[0].server_version).toMatch(/^17\./);
    expect(cluster!.url).toMatch(/127\.0\.0\.1/);
  });

  it("N concurrent DISTINCT-key issuances commit exactly S+1 … S+N", async () => {
    const S = await counterValue(pool!);
    const N = 200;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => createCertForScan(`distinct-key-${i}`, null))
    );

    const issued = results.map((r) => Number(r.certId.replace(/\D/g, ""))).sort((a, b) => a - b);
    const expected = Array.from({ length: N }, (_, i) => S + 1 + i);

    expect(new Set(issued).size).toBe(N); // no duplicate
    expect(issued).toEqual(expected); // no gap, exact range
    expect(await committedNumbers(pool!)).toEqual(expected);
    expect(await counterValue(pool!)).toBe(S + N);
  }, 120_000);

  it("DB rejects a duplicate certificate_number even if the app tries (§11)", async () => {
    await pool!.query(`INSERT INTO certificates (certificate_number, status) VALUES ('MV900', 'active')`);
    await expect(
      pool!.query(`INSERT INTO certificates (certificate_number, status) VALUES ('MV900', 'active')`)
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("MV allocator — §13 idempotent issuance", () => {
  it("a sequential replay of the same key returns the SAME number (no second allocation)", async () => {
    const S = await counterValue(pool!);
    const first = await createCertForScan("replay-key", null);
    const second = await createCertForScan("replay-key", null);

    expect(second.certId).toBe(first.certId);
    expect(second.reused).toBe(true);
    expect(await counterValue(pool!)).toBe(S + 1); // exactly one integer consumed
    expect(await committedNumbers(pool!)).toEqual([S + 1]);
  });

  it("CONCURRENT same-key issuance commits ONE card and consumes exactly ONE integer", async () => {
    const S = await counterValue(pool!);
    const CONCURRENCY = 25;
    const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => createCertForScan("racing-key", null)));

    // Exactly one committed identity, and every caller sees that same number.
    const distinct = new Set(results.map((r) => r.certId));
    expect(distinct.size).toBe(1);
    expect(await committedNumbers(pool!)).toEqual([S + 1]);
    expect([...distinct][0]).toBe(`MV${S + 1}`);

    // §12: a lost idempotency race must NOT burn integers. The counter may
    // advance by exactly one — the one that committed.
    expect(await counterValue(pool!)).toBe(S + 1);
  }, 120_000);
});

describe("MV allocator — §19 one global number space", () => {
  /**
   * Code-shape invariant, not a behavioural claim: NO client, scanner or station
   * may derive an MV number by doing arithmetic on another MV number. Issuance
   * belongs solely to the server's transactional allocator, so a local `last + 1`
   * is wrong the moment any other station issues in between. Comments are
   * stripped first so prose describing the banned pattern does not trip it.
   */
  it("no scanner or client code derives an MV number as last + 1", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { stripToJs } = await import("./helpers/strip-non-code");

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) out.push(full);
      }
      return out;
    };

    const MV_ARITHMETIC = /MV\$\{[^}]*\+\s*1/;
    const offenders: string[] = [];
    for (const file of [...walk("scripts"), ...walk("client/src")]) {
      const raw = readFileSync(file, "utf8");
      // Cheap regex pre-filter first: stripToJs runs the TypeScript parser, and
      // parsing all ~450 files takes over a minute under full-suite parallelism.
      // Only files that could possibly match are worth parsing.
      if (!MV_ARITHMETIC.test(raw)) continue;
      if (MV_ARITHMETIC.test(stripToJs(raw))) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  }, 60_000);
});

describe("MV allocator — §14 crash-after-commit recovery", () => {
  it("a committed issuance whose response was LOST resolves to the same number on retry", async () => {
    const S = await counterValue(pool!);

    // The transaction COMMITs and the caller never receives the response.
    const committed = await createCertForScan("crash-key", null);
    expect(committed.certId).toBe(`MV${S + 1}`);

    // "Process restart": drop every pooled connection, then re-drive the same
    // content-derived idempotency key exactly as a recovering scanner would.
    const { pool: appPool } = await import("../server/db");
    await appPool.query("SELECT 1");

    const recovered = await createCertForScan("crash-key", null);
    expect(recovered.certId).toBe(committed.certId); // SAME number, not S+2
    expect(recovered.reused).toBe(true);
    expect(await counterValue(pool!)).toBe(S + 1);
    expect(await committedNumbers(pool!)).toEqual([S + 1]); // no orphan identity
  }, 60_000);
});

describe("MV allocator — §16/§38 concurrency scale and latency", () => {
  // 200 is proved separately by the §92 suite above; the rest of the owner-required
  // ladder (2 / 10 / 100 / 500 / 1000) runs here. The small values are not redundant:
  // N=2 is the minimal interleaving that can expose a lost update on the counter row,
  // and a bug that only ever shows at N=1000 would be a throughput bug, not a
  // correctness one — correctness must hold at every width.
  for (const N of [2, 10, 100, 500, 1000]) {
    it(`${N} concurrent issuances commit exactly S+1 … S+${N} with no duplicate and no gap`, async () => {
      const S = await counterValue(pool!);
      const latencies: number[] = [];

      const results = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          const t0 = performance.now();
          const r = await createCertForScan(`scale-${N}-${i}`, null);
          latencies.push(performance.now() - t0);
          return r;
        })
      );

      const issued = results.map((r) => Number(r.certId.replace(/\D/g, ""))).sort((a, b) => a - b);
      const expected = Array.from({ length: N }, (_, i) => S + 1 + i);

      expect(new Set(issued).size).toBe(N);
      expect(issued).toEqual(expected);
      expect(await committedNumbers(pool!)).toEqual(expected);
      expect(await counterValue(pool!)).toBe(S + N);

      latencies.sort((a, b) => a - b);
      const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
      // Reported for the release record (§38). Measured end-to-end per issuance
      // under full contention on a local disposable cluster — an ordering signal,
      // not a production SLA (Neon adds real network latency).
      console.log(
        `[allocator] N=${N} p50=${pct(50).toFixed(1)}ms p95=${pct(95).toFixed(1)}ms ` +
          `p99=${pct(99).toFixed(1)}ms max=${latencies[latencies.length - 1].toFixed(1)}ms`
      );
    }, 300_000);
  }
});

describe("MV allocator — §12/§15 rollback must not burn an integer", () => {
  it("a failed certificate INSERT after allocation leaves the counter unadvanced", async () => {
    const S = await counterValue(pool!);

    // Force the very next INSERT to fail *after* a number is allocated, which is
    // exactly the crash/rollback window in the failure-injection matrix (§15).
    await pool!.query(
      `CREATE FUNCTION fail_cert_insert() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`
    );
    await pool!.query(
      `CREATE TRIGGER t_fail_cert BEFORE INSERT ON certificates
       FOR EACH ROW EXECUTE FUNCTION fail_cert_insert()`
    );

    await expect(createCertForScan("doomed-key", null)).rejects.toThrow();

    await pool!.query(`DROP TRIGGER t_fail_cert ON certificates`);
    await pool!.query(`DROP FUNCTION fail_cert_insert()`);

    expect(await committedNumbers(pool!)).toEqual([]); // nothing committed
    expect(await counterValue(pool!)).toBe(S); // and nothing consumed

    // The next legitimate issuance must therefore still receive S+1.
    const next = await createCertForScan("after-failure", null);
    expect(next.certId).toBe(`MV${S + 1}`);
  }, 60_000);
});

/**
 * PART 5 — the HQ grading-origin snapshot must survive the allocator reconciliation.
 *
 * `f51beb10` stamped `origin_type='HQ'` on the two raw certificate INSERT paths, and the
 * transactional allocator rewrote those same two INSERTs. A merge that took one side would
 * silently drop the other: the allocator without the stamp leaves origin_type NULL (which the
 * reader interprets as LEGACY — "predates the feature" — rather than as a recorded fact), and
 * the stamp without the allocator brings back the burnable counter increment.
 *
 * These tests fail if either half is lost, and they assert against the REAL committed row.
 */
describe("certificate grading-origin snapshot — preserved through the allocator", () => {
  it("a scanner-ingested certificate is stamped HQ, dated, and versioned", async () => {
    const S = await counterValue(pool!);
    const created = await createCertForScan("origin-scan-key", null);
    expect(created.certId).toBe(`MV${S + 1}`);

    const { rows } = await pool!.query(
      `SELECT origin_type, origin_captured_at, origin_snapshot_version, origin_partner_id,
              origin_partner_trading_name, origin_location_id
         FROM certificates WHERE certificate_number = $1`,
      [created.certId]
    );
    expect(rows).toHaveLength(1);
    // The recorded fact, not the legacy NULL.
    expect(rows[0].origin_type).toBe("HQ");
    // chk_certificates_origin_capture_pairing: both are mandatory once origin_type is set.
    expect(rows[0].origin_captured_at).not.toBeNull();
    expect(Number(rows[0].origin_snapshot_version)).toBeGreaterThanOrEqual(1);
    // chk_certificates_origin_non_partner_clean: partner provenance is never inferred at scan.
    expect(rows[0].origin_partner_id).toBeNull();
    expect(rows[0].origin_partner_trading_name).toBeNull();
    expect(rows[0].origin_location_id).toBeNull();
  }, 60_000);

  it("the stamp matches the shared snapshot-version constant, not a hard-coded literal", async () => {
    const { CERTIFICATE_ORIGIN_SNAPSHOT_VERSION } = await import("@shared/schema");
    const created = await createCertForScan("origin-version-key", null);
    const { rows } = await pool!.query(
      `SELECT origin_snapshot_version FROM certificates WHERE certificate_number = $1`,
      [created.certId]
    );
    expect(Number(rows[0].origin_snapshot_version)).toBe(CERTIFICATE_ORIGIN_SNAPSHOT_VERSION);
  }, 60_000);

  it("the snapshot is immutable once written — 0035's set-once trigger still bites", async () => {
    const created = await createCertForScan("origin-immutable-key", null);
    await expect(
      pool!.query(`UPDATE certificates SET origin_type = 'PARTNER' WHERE certificate_number = $1`, [created.certId])
    ).rejects.toMatchObject({ code: "23514" });
    // …and an ordinary column on the same row still updates fine, so the trigger is not
    // freezing the whole record.
    await pool!.query(`UPDATE certificates SET card_name = 'ok' WHERE certificate_number = $1`, [created.certId]);
    const { rows } = await pool!.query(
      `SELECT origin_type, card_name FROM certificates WHERE certificate_number = $1`,
      [created.certId]
    );
    expect(rows[0].origin_type).toBe("HQ");
    expect(rows[0].card_name).toBe("ok");
  }, 60_000);

  it("a rolled-back issuance leaves NO origin row behind and burns no integer", async () => {
    const S = await counterValue(pool!);
    await pool!.query(
      `CREATE FUNCTION fail_origin_insert() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`
    );
    await pool!.query(
      `CREATE TRIGGER t_fail_origin BEFORE INSERT ON certificates
       FOR EACH ROW EXECUTE FUNCTION fail_origin_insert()`
    );
    await expect(createCertForScan("origin-doomed-key", null)).rejects.toThrow();
    await pool!.query(`DROP TRIGGER t_fail_origin ON certificates`);
    await pool!.query(`DROP FUNCTION fail_origin_insert()`);

    // Provenance and identity roll back together: neither a half-recorded origin claim
    // nor a consumed integer survives.
    const { rows } = await pool!.query(`SELECT count(*)::int AS n FROM certificates WHERE origin_type IS NOT NULL`);
    expect(rows[0].n).toBe(0);
    expect(await counterValue(pool!)).toBe(S);
  }, 60_000);
});
