/**
 * DURABLE SYNC LEASE — two-machine behaviour, proven against real PostgreSQL 17.
 *
 * The claim under test is the one the process-level `inFlight` promise could never make: that two
 * Fly machines racing produce ONE sync. Every test here uses two independent pools against the
 * same database, which is the closest faithful model of two machines available in-process — a
 * shared promise cannot leak between them, so the only coordination is the one in the database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  acquireLease,
  releaseLease,
  renewLease,
  withLease,
  workerIdentity,
} from "../server/project-control/sync-lease";

let cluster: DisposablePostgres17;
/** Two pools = two machines. Nothing in-process is shared between them but the database. */
let machineA: pg.Pool;
let machineB: pg.Pool;

beforeAll(async () => {
  cluster = await startPostgres17("pc-sync-lease");
  machineA = new pg.Pool({ connectionString: cluster.url, max: 3 });
  machineB = new pg.Pool({ connectionString: cluster.url, max: 3 });
  await machineA.query(`CREATE TABLE IF NOT EXISTS pc_nodes (key text PRIMARY KEY)`);
  await machineA.query(`CREATE TABLE IF NOT EXISTS pc_work_packages (key text PRIMARY KEY)`);
  await machineA.query(readFileSync(join(__dirname, "..", "migrations/0039_project_control_live_evidence.sql"), "utf8"));
}, 240_000);

afterAll(async () => {
  await machineA?.end().catch(() => {});
  await machineB?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

beforeEach(async () => {
  await machineA.query(`DELETE FROM pc_sync_leases`);
});

describe("two machines produce one sync", () => {
  it("the second machine is refused and learns WHICH sync is already running", async () => {
    const a = await acquireLease(machineA, "github", "sync-A");
    expect(a.acquired).toBe(true);

    const b = await acquireLease(machineB, "github", "sync-B");
    expect(b.acquired, "a live lease must exclude the second machine").toBe(false);
    if (!b.acquired) {
      // Not a bare "busy": the caller needs the active id so a duplicate refresh can show the
      // run already in progress rather than a dead-end error.
      expect(b.activeSyncId).toBe("sync-A");
      expect(b.expiresAt).toBeInstanceOf(Date);
    }
  });

  it("a simultaneous race is resolved by the database — exactly one winner", async () => {
    const [r1, r2, r3, r4] = await Promise.all([
      acquireLease(machineA, "github", "s1"),
      acquireLease(machineB, "github", "s2"),
      acquireLease(machineA, "github", "s3"),
      acquireLease(machineB, "github", "s4"),
    ]);
    const winners = [r1, r2, r3, r4].filter((r) => r.acquired);
    expect(winners, "four concurrent claims, one lease").toHaveLength(1);

    const rows = await machineA.query(`SELECT count(*)::int AS n FROM pc_sync_leases`);
    expect(rows.rows[0].n).toBe(1);
  });

  it("different sources do not block each other", async () => {
    const gh = await acquireLease(machineA, "github", "s-gh");
    const app = await acquireLease(machineB, "application", "s-app");
    expect(gh.acquired).toBe(true);
    expect(app.acquired, "per-source leases must be independent").toBe(true);
  });
});

describe("crash recovery", () => {
  it("an EXPIRED lease is taken over — a dead process cannot wedge sync forever", async () => {
    const a = await acquireLease(machineA, "github", "sync-dead", 60_000);
    expect(a.acquired).toBe(true);

    // Simulate the holder dying: nothing releases, and the clock passes the expiry.
    await machineA.query(`UPDATE pc_sync_leases SET expires_at = now() - interval '1 second'`);

    const b = await acquireLease(machineB, "github", "sync-live");
    expect(b.acquired, "expiry is the crash-recovery mechanism").toBe(true);

    const rows = await machineA.query(`SELECT sync_id, count(*) OVER ()::int AS n FROM pc_sync_leases`);
    expect(rows.rows[0].sync_id).toBe("sync-live");
    expect(rows.rows[0].n, "takeover replaces, it does not duplicate").toBe(1);
  });

  it("a lease that has NOT expired is never taken over", async () => {
    await acquireLease(machineA, "github", "sync-alive", 60_000);
    const b = await acquireLease(machineB, "github", "sync-intruder");
    expect(b.acquired).toBe(false);
  });
});

describe("the owner token prevents a stale holder releasing someone else's lease", () => {
  it("a superseded machine cannot release the new holder's lease", async () => {
    const a = await acquireLease(machineA, "github", "sync-slow", 60_000);
    expect(a.acquired).toBe(true);
    const slowLease = a.acquired ? a.lease : null;

    // A expires; B takes over.
    await machineA.query(`UPDATE pc_sync_leases SET expires_at = now() - interval '1 second'`);
    const b = await acquireLease(machineB, "github", "sync-new");
    expect(b.acquired).toBe(true);

    // A finally finishes and tries to clean up. It must NOT free B's lease.
    const released = await releaseLease(machineA, slowLease!);
    expect(released, "an unconditional release here would be a silent double-sync").toBe(false);

    const still = await machineA.query(`SELECT sync_id FROM pc_sync_leases`);
    expect(still.rows[0].sync_id).toBe("sync-new");
  });

  it("the rightful holder can release, and the source is then free", async () => {
    const a = await acquireLease(machineA, "github", "sync-ok");
    expect(a.acquired).toBe(true);
    expect(await releaseLease(machineA, a.acquired ? a.lease : ({} as never))).toBe(true);

    const b = await acquireLease(machineB, "github", "sync-next");
    expect(b.acquired).toBe(true);
  });

  it("renew extends only for the rightful holder, and never resurrects an expired lease", async () => {
    const a = await acquireLease(machineA, "github", "sync-long", 60_000);
    const lease = a.acquired ? a.lease : null;
    expect(await renewLease(machineA, lease!)).toBe(true);

    await machineA.query(`UPDATE pc_sync_leases SET expires_at = now() - interval '1 second'`);
    expect(
      await renewLease(machineA, lease!),
      "resurrecting an expired lease could create two live holders"
    ).toBe(false);
  });
});

describe("withLease", () => {
  it("releases even when the work THROWS — a failure must not lock out refresh", async () => {
    await expect(
      withLease(machineA, "github", "sync-boom", async () => {
        throw new Error("sync exploded");
      })
    ).rejects.toThrow(/exploded/);

    const rows = await machineA.query(`SELECT count(*)::int AS n FROM pc_sync_leases`);
    expect(rows.rows[0].n, "a thrown sync must not hold the lease until expiry").toBe(0);
  });

  it("reports 'did not run' distinctly from 'ran and returned nothing'", async () => {
    const held = await acquireLease(machineA, "github", "sync-holding", 60_000);
    expect(held.acquired).toBe(true);

    const outcome = await withLease(machineB, "github", "sync-blocked", async () => "work done");
    expect(outcome.ran).toBe(false);
    if (!outcome.ran) expect(outcome.activeSyncId).toBe("sync-holding");
  });

  it("runs the work and returns its result when the lease is free", async () => {
    const outcome = await withLease(machineA, "github", "sync-free", async () => 42);
    expect(outcome.ran).toBe(true);
    if (outcome.ran) expect(outcome.result).toBe(42);
  });
});

describe("worker identity", () => {
  it("prefers the Fly machine id, so the two machines are distinguishable", () => {
    expect(workerIdentity({ FLY_MACHINE_ID: "683720eb5127d8" } as NodeJS.ProcessEnv)).toBe("683720eb5127d8");
    expect(workerIdentity({ HOSTNAME: "box" } as NodeJS.ProcessEnv)).toBe("box");
    expect(workerIdentity({} as NodeJS.ProcessEnv)).toBe("local");
  });

  it("is recorded on the lease row", async () => {
    await acquireLease(machineA, "github", "sync-id", 60_000, { FLY_MACHINE_ID: "machine-A" } as NodeJS.ProcessEnv);
    const rows = await machineA.query(`SELECT worker_identity FROM pc_sync_leases`);
    expect(rows.rows[0].worker_identity).toBe("machine-A");
  });
});
