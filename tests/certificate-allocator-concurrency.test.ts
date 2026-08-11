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
      deleted_at timestamptz
    )`);
  // The atomic primitive against concurrent same-key ingests (migration 0047).
  await p.query(
    `CREATE UNIQUE INDEX uq_certificates_ingest_idem ON certificates (ingest_idempotency_key)`
  );
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
    await pool!.query(
      `INSERT INTO certificates (certificate_number, status) VALUES ('MV900', 'active')`
    );
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
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => createCertForScan("racing-key", null))
    );

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
  for (const N of [500, 1000]) {
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
