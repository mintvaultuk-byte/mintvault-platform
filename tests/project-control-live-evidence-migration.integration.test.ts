/**
 * MIGRATION 0039 — proven against a real PostgreSQL 17, not read.
 *
 * A migration that "looks additive" is not evidence. This applies the real SQL file to a
 * disposable cluster and checks the catalogue afterwards, because the failure this repo has
 * actually suffered is a migration reporting success while an object is missing.
 *
 * The property that matters most is the append-only guarantee. The dashboard's honesty claim —
 * that a failed sync can never destroy the last good evidence — is enforced by a database trigger
 * rather than by application code, precisely so it survives a future writer who forgets. If that
 * trigger is not really there, the guarantee is decorative.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const FORWARD = join(__dirname, "..", "migrations/0039_project_control_live_evidence.sql");
const ROLLBACK = join(__dirname, "..", "migrations/rollback-0039-project-control-live-evidence.sql");

let cluster: DisposablePostgres17;
let pool: pg.Pool;

/** 0030's tables are a precondition for the rollback's "did I damage 0030?" assertion. */
async function create0030Stubs(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS pc_nodes (key text PRIMARY KEY)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pc_work_packages (key text PRIMARY KEY)`);
}

beforeAll(async () => {
  cluster = await startPostgres17("pc-live-evidence-migration");
  pool = new pg.Pool({ connectionString: cluster.url, max: 4 });
  await create0030Stubs();
}, 240_000);

afterAll(async () => {
  await pool?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

async function applyForward(): Promise<void> {
  await pool.query(readFileSync(FORWARD, "utf8"));
}
async function applyRollback(): Promise<void> {
  await pool.query(readFileSync(ROLLBACK, "utf8"));
}

describe("0039 — apply, verify, re-apply", () => {
  it("creates all four tables and the append-only trigger", async () => {
    await applyForward();

    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
        ('pc_sync_runs','pc_sync_leases','pc_sync_checkpoints','pc_evidence_snapshots')
        ORDER BY table_name`
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      "pc_evidence_snapshots",
      "pc_sync_checkpoints",
      "pc_sync_leases",
      "pc_sync_runs",
    ]);

    const trg = await pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname='trg_pc_evidence_snapshots_append_only'`
    );
    expect(trg.rowCount, "the append-only guarantee must exist in the database").toBe(1);
  });

  it("is idempotent — a second apply is a no-op, not an error", async () => {
    await expect(applyForward()).resolves.not.toThrow();
    const t = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema='public' AND table_name LIKE 'pc_sync%' OR table_name='pc_evidence_snapshots'`
    );
    expect(t.rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it("rejects a run state outside the declared set", async () => {
    await expect(
      pool.query(
        `INSERT INTO pc_sync_runs (sync_id, source_type, trigger_type, target, state)
         VALUES ('s-bad','github','manual','repo','NONSENSE')`
      )
    ).rejects.toThrow(/pc_sync_runs_state_check/);
  });

  it("rejects a freshness outside the declared set", async () => {
    await expect(
      pool.query(
        `INSERT INTO pc_evidence_snapshots (source_type, entity_type, entity_id, payload_digest, freshness)
         VALUES ('github','branch','main','d1','TOTALLY_FINE')`
      )
    ).rejects.toThrow(/freshness_check/);
  });

  it("enforces one lease row per source — the cross-machine exclusion primitive", async () => {
    await pool.query(
      `INSERT INTO pc_sync_leases (source_type, owner_token, sync_id, expires_at)
       VALUES ('github','tok-a','s-1', now() + interval '5 minutes')`
    );
    await expect(
      pool.query(
        `INSERT INTO pc_sync_leases (source_type, owner_token, sync_id, expires_at)
         VALUES ('github','tok-b','s-2', now() + interval '5 minutes')`
      )
    ).rejects.toThrow(/duplicate key|pc_sync_leases_pkey/);
    await pool.query(`DELETE FROM pc_sync_leases`);
  });
});

describe("0039 — evidence is append-only, enforced by the database", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO pc_evidence_snapshots (source_type, environment, entity_type, entity_id, commit_sha, status, payload_digest)
       VALUES ('github','n/a','branch','main','abc123','ok','digest-1')`
    );
  });

  it("a successful observation CANNOT be updated", async () => {
    await expect(
      pool.query(`UPDATE pc_evidence_snapshots SET status='tampered' WHERE entity_id='main'`)
    ).rejects.toThrow(/append-only/i);
  });

  it("a successful observation CANNOT be deleted — a failed sync must not erase it", async () => {
    await expect(pool.query(`DELETE FROM pc_evidence_snapshots WHERE entity_id='main'`)).rejects.toThrow(
      /append-only/i
    );
  });

  it("recording a FAILURE adds a row and leaves the good one intact", async () => {
    await pool.query(
      `INSERT INTO pc_evidence_snapshots (source_type, environment, entity_type, entity_id, freshness, payload_digest, stale_reason)
       VALUES ('github','n/a','branch','main','UNAVAILABLE','digest-2','GitHub unreachable')`
    );

    const rows = await pool.query(
      `SELECT freshness, commit_sha FROM pc_evidence_snapshots
        WHERE entity_id='main' ORDER BY observed_at ASC, id ASC`
    );
    expect(rows.rowCount, "the failure is additive").toBe(2);
    expect(rows.rows[0].commit_sha, "the last good observation survives the failure").toBe("abc123");
    expect(rows.rows[1].freshness).toBe("UNAVAILABLE");
  });

  it("the newest-per-entity read still returns the last GOOD commit after a failure", async () => {
    // This is the query the dashboard actually makes: latest usable evidence, not latest row.
    const latestGood = await pool.query(
      `SELECT commit_sha FROM pc_evidence_snapshots
        WHERE entity_id='main' AND freshness='CURRENT'
        ORDER BY observed_at DESC, id DESC LIMIT 1`
    );
    expect(latestGood.rows[0]?.commit_sha).toBe("abc123");
  });
});

describe("rollback-0039", () => {
  it("removes exactly its own four tables and leaves 0030's intact", async () => {
    await applyRollback();

    const gone = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN
        ('pc_sync_runs','pc_sync_leases','pc_sync_checkpoints','pc_evidence_snapshots')`
    );
    expect(gone.rows[0].n).toBe(0);

    const kept = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('pc_nodes','pc_work_packages')`
    );
    expect(kept.rows[0].n, "rollback must not touch migration 0030").toBe(2);
  });

  it("is idempotent, and the migration re-applies cleanly afterwards", async () => {
    await expect(applyRollback()).resolves.not.toThrow();
    await expect(applyForward()).resolves.not.toThrow();

    const trg = await pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname='trg_pc_evidence_snapshots_append_only'`
    );
    expect(trg.rowCount, "re-applying must restore the append-only guarantee").toBe(1);
  });
});
