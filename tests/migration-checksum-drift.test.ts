/**
 * Migration journal checksum drift — the refusal branch, executed for real.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The drift assertion inside
 * tests/partner-grading-bridge-migration.test.ts cannot prove the refusal: that suite's `beforeAll`
 * re-applies the full migration set, so a checksum corrupted from inside a test is overwritten
 * before the planner ever sees it. I tried exactly that and the test stayed green — the corruption
 * never survived setup. An assertion that cannot be made to fail is not evidence.
 *
 * So this suite owns its whole lifecycle in ONE test body: provision, apply, corrupt, plan. Nothing
 * runs between the corruption and the planner call, which is the only ordering under which the
 * mismatch branch is genuinely reachable.
 *
 * The branch under test is scripts/db/migrate.ts:447 — applyMigrations refuses outright when
 * plan.checksumMismatches is non-empty, because a non-empty list means a migration file was edited
 * AFTER being applied to that database. That is the guard standing between an edited migration and
 * a silently divergent production schema.
 *
 * SELF-PROVISIONING: starts its own PostgreSQL 17. Needs POSTGRES17_BIN or docker. Never skips.
 */
import { describe, it, expect, afterAll } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { applyMigrations, planMigrations, listMigrationFiles } from "../scripts/db/migrate";

let cluster: DisposablePostgres17 | undefined;

/** The first few numbered migrations — enough to populate a real journal, cheap to apply. */
function firstMigrations(n: number) {
  return listMigrationFiles().slice(0, n);
}

describe("migration journal checksum drift", () => {
  afterAll(async () => {
    await cluster?.stop().catch(() => {});
  });

  it("a checksum edited AFTER apply is detected by the planner and refused by the runner", async () => {
    cluster = await startPostgres17("migration-checksum-drift");
    const admin = new Client({ connectionString: cluster.url });
    await admin.connect();

    try {
      const files = firstMigrations(3);
      expect(files.length, "need real migration files to journal").toBe(3);

      await applyMigrations(admin as never, files, { allowDestructive: true });

      // Positive control BEFORE corrupting: a clean journal must plan clean. Without this, a
      // planner that reported drift unconditionally would satisfy the assertion below for the
      // wrong reason.
      const clean = await planMigrations(admin as never, files);
      expect(clean.alreadyApplied, "all three must be journalled as applied").toHaveLength(3);
      expect(clean.checksumMismatches, "an untouched journal must show no drift").toEqual([]);

      // Corrupt ONE stored checksum. Nothing re-applies migrations after this point — that is the
      // whole reason this test owns its own lifecycle instead of living in the bridge suite.
      const victim = files[1].filename;
      const forged = "d".repeat(64);
      const updated = await admin.query("UPDATE schema_migrations SET checksum=$1 WHERE filename=$2", [forged, victim]);
      expect(updated.rowCount, "the corruption must actually land, or the rest proves nothing").toBe(1);
      const stored = await admin.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename=$1",
        [victim]
      );
      expect(stored.rows[0].checksum, "the forged checksum must still be present at plan time").toBe(forged);

      // 1) The planner SEES the drift, and attributes it to the right file.
      const drifted = await planMigrations(admin as never, files);
      expect(drifted.checksumMismatches).toHaveLength(1);
      expect(drifted.checksumMismatches[0].filename).toBe(victim);
      expect(drifted.checksumMismatches[0].storedChecksum).toBe(forged);
      expect(drifted.checksumMismatches[0].currentChecksum).toBe(files[1].checksum);
      expect(drifted.checksumMismatches[0].currentChecksum).not.toBe(forged);

      // 2) The runner REFUSES rather than proceeding. Asserting the message text as well as the
      // throw, so a differently-caused failure cannot be mistaken for this guard firing.
      await expect(applyMigrations(admin as never, files, { allowDestructive: true })).rejects.toThrow(
        /Checksum mismatch on already-applied migration\(s\)/
      );
      await expect(applyMigrations(admin as never, files, { allowDestructive: true })).rejects.toThrow(victim);
    } finally {
      await admin.end().catch(() => {});
    }
  }, 180_000);
});
