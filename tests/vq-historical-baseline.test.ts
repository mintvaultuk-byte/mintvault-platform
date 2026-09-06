import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  applyScopedMigration,
  listMigrationFiles,
  migrationProfile,
  planMigrations,
} from "../scripts/db/migrate";
import {
  VQ_BASELINE_FINGERPRINT,
  VQ_BASELINE_AUTHORITY_FILE,
  VQ_BASELINE_RELATIONS,
  VQ_BASELINE_MIGRATION_SET_SHA256,
  VQ_SCHEMA_CATALOG_SQL,
  vqSchemaFingerprint,
  VQ_RUNTIME_MIGRATIONS,
  evaluateVqRuntimeEvidence,
  VQ_RUNTIME_EVIDENCE_SQL,
} from "../server/lib/vq-schema-contract";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { checkVqRuntimeReadiness, checkReleaseReadiness, RELEASE_READINESS_SQL } from "../server/readiness";

let cluster: DisposablePostgres17;
let db: pg.Client;
let expected: string;
const files = listMigrationFiles(migrationProfile("vault-quest").migrationsDir).filter((f) => Number(f.number) <= 15);
const fingerprint = async () => vqSchemaFingerprint((await db.query(VQ_SCHEMA_CATALOG_SQL)).rows[0].catalog);

beforeAll(async () => {
  cluster = await startPostgres17("vq-catalog");
  db = new pg.Client({ connectionString: cluster.url });
  await db.connect();
  await applyMigrations(db, files, { estate: "vault-quest" });
  expected = await fingerprint();
}, 60_000);
afterAll(async () => {
  await db?.end();
  await cluster?.stop();
});

async function withHistorical(work: (client: pg.Client, url: string) => Promise<void>, mainRole = true) {
  const owned = await startPostgres17("vq-history");
  const client = new pg.Client({ connectionString: owned.url });
  await client.connect();
  try {
    // Reproduce the former raw-SQL installation without inventing execution rows.
    for (const file of files) await client.query(file.sql);
    if (mainRole) await client.query(readFileSync("migrations/0121_main_runtime_role_authority.sql", "utf8"));
    await client.query(
      "INSERT INTO vq_export_jobs (kind,owner_admin_id,idempotency_key) VALUES ('test','synthetic','preserve-history')"
    );
    await work(client, owned.url);
  } finally {
    await client.end();
    await owned.stop();
  }
}

describe("VQ runtime evidence contract", () => {
  const fresh = () => ({
    journalPresent: true,
    receiptPresent: true,
    catalogFingerprint: VQ_BASELINE_FINGERPRINT,
    runtimeAuthorityReady: true,
    journal: listMigrationFiles(migrationProfile("vault-quest").migrationsDir).map(({ filename, checksum }) => ({
      filename,
      checksum,
      status: "applied",
      completed: true,
    })),
    receipts: [] as Array<Record<string, unknown>>,
  });
  const historical = () => ({
    ...fresh(),
    journal: fresh().journal.filter((row) => row.filename === VQ_BASELINE_AUTHORITY_FILE),
    receipts: [
      {
        baseline_id: "vq-0000-0015-v1",
        evidence_kind: "observed_schema-v1",
        source_sha256: VQ_BASELINE_MIGRATION_SET_SHA256,
        schema_sha256: VQ_BASELINE_FINGERPRINT,
        observed: true,
        observer: "synthetic-migration-owner",
      },
    ],
  });

  it("pins deeply frozen release expectations to every actual shipped SQL checksum", () => {
    expect(VQ_RUNTIME_MIGRATIONS).toEqual(fresh().journal.map(({ filename, checksum }) => ({ filename, checksum })));
    expect(Object.isFrozen(VQ_RUNTIME_MIGRATIONS)).toBe(true);
    expect(VQ_RUNTIME_MIGRATIONS.every(Object.isFrozen)).toBe(true);
  });

  it("accepts only complete fresh execution or exact observed historical lineage", () => {
    expect(evaluateVqRuntimeEvidence(fresh())).toEqual({ ready: true, lineage: "fresh" });
    expect(evaluateVqRuntimeEvidence(historical())).toEqual({ ready: true, lineage: "historical" });
    expect(evaluateVqRuntimeEvidence({ ...fresh(), journal: fresh().journal.reverse() })).toEqual({
      ready: true,
      lineage: "fresh",
    });
  });

  it("refuses every missing, changed, duplicate or incomplete execution row", () => {
    for (let index = 0; index < fresh().journal.length; index++) {
      for (const mutation of [
        (rows: ReturnType<typeof fresh>["journal"]) => rows.splice(index, 1),
        (rows: ReturnType<typeof fresh>["journal"]) => rows.push({ ...rows[index] }),
        (rows: ReturnType<typeof fresh>["journal"]) => {
          rows[index].checksum = "0".repeat(64);
        },
        (rows: ReturnType<typeof fresh>["journal"]) => {
          rows[index].status = "applying";
        },
        (rows: ReturnType<typeof fresh>["journal"]) => {
          rows[index].completed = false;
        },
        (rows: ReturnType<typeof fresh>["journal"]) => {
          rows[index].filename = "unknown.sql";
        },
      ]) {
        const evidence = fresh();
        mutation(evidence.journal);
        expect(evaluateVqRuntimeEvidence(evidence)).toEqual({ ready: false, lineage: null });
      }
    }
  });

  it("refuses mixed, empty, forged or incomplete historical evidence", () => {
    const history = historical();
    for (const evidence of [
      { ...history, journal: fresh().journal },
      { ...history, journal: [] },
      { ...history, receipts: [] },
      { ...history, receipts: [...history.receipts, ...history.receipts] },
      ...Object.keys(history.receipts[0]).map((key) => ({
        ...history,
        receipts: [{ ...history.receipts[0], [key]: null }],
      })),
      { ...history, receipts: [{ ...history.receipts[0], observer: " " }] },
      { ...history, receipts: [{ ...history.receipts[0], extra: true }] },
      { ...history, journal: [{ ...history.journal[0], completed: false }] },
      { ...history, journal: [{ ...history.journal[0], checksum: "0".repeat(64) }] },
    ])
      expect(evaluateVqRuntimeEvidence(evidence)).toEqual({ ready: false, lineage: null });
  });

  it("never treats unavailable or malformed observations as readiness", () => {
    for (const evidence of [
      null,
      {},
      [],
      true,
      ...[
        "journalPresent",
        "receiptPresent",
        "runtimeAuthorityReady",
        "catalogFingerprint",
        "journal",
        "receipts",
      ].flatMap((key) => [null, undefined, "true", false].map((value) => ({ ...fresh(), [key]: value }))),
      { ...fresh(), catalogFingerprint: "0".repeat(64) },
      { ...fresh(), journal: [null] },
      { ...fresh(), receipts: [null] },
      { ...fresh(), journal: fresh().journal.map((row) => ({ ...row, completed: "true" })) },
    ])
      expect(evaluateVqRuntimeEvidence(evidence)).toEqual({ ready: false, lineage: null });
  });
});

describe("read-only runtime VQ observation", () => {
  it("refuses malformed or unavailable query results without leaking details", async () => {
    for (const rows of [[], [null], [true], [{ catalog: null }], [{ catalog: [] }, { catalog: [] }]]) {
      expect(await checkVqRuntimeReadiness({ query: async () => ({ rows }) }, true)).toEqual({
        ready: false,
        queryFailed: true,
      });
    }
    expect(
      await checkVqRuntimeReadiness(
        {
          query: async () => {
            throw new Error("secret database detail");
          },
        },
        true
      )
    ).toEqual({ ready: false, queryFailed: true });
  });
  it.each([false, true])(
    "observes actual low-privilege lineage (historical=%s)",
    async (historical) => {
      const owned = await startPostgres17("vq-runtime");
      const owner = new pg.Client({ connectionString: owned.url });
      await owner.connect();
      let runtime: pg.Client | undefined;
      try {
        await owner.query(readFileSync("migrations/0121_main_runtime_role_authority.sql", "utf8"));
        if (historical) for (const file of files) await owner.query(file.sql);
        await applyMigrations(owner, listMigrationFiles(migrationProfile("vault-quest").migrationsDir), {
          estate: "vault-quest",
          historicalBaseline: historical,
        });
        await owner.query("CREATE ROLE vq_readiness_test LOGIN INHERIT; GRANT mintvault_app TO vq_readiness_test");
        const url = new URL(owned.url);
        url.username = "vq_readiness_test";
        runtime = new pg.Client({ connectionString: url.toString() });
        await runtime.connect();
        const readiness = (client: pg.Client, production = true) =>
          checkVqRuntimeReadiness(
            {
              query: (sql, params) => client.query(sql, params ? [...params] : undefined),
            },
            production
          );
        // Existing suites prove the main SQL. Only that result is stubbed here;
        // the global combiner, VQ query, fingerprint and evaluator are all real.
        const releaseReadiness = async (client: pg.Client) => {
          const calls: string[] = [];
          const result = await checkReleaseReadiness(
            {
              query: (sql, params) => {
                calls.push(sql);
                if (sql === RELEASE_READINESS_SQL)
                  return Promise.resolve({
                    rows: [{ ready: true, missing_relations: [], missing_migrations: [], missing_triggers: [] }],
                  });
                expect(sql).toBe(VQ_RUNTIME_EVIDENCE_SQL);
                expect(params).toEqual([false]);
                return client.query(sql, params ? [...params] : undefined);
              },
            },
            { NODE_ENV: "test" }
          );
          expect(calls).toEqual([RELEASE_READINESS_SQL, VQ_RUNTIME_EVIDENCE_SQL]);
          return result;
        };
        const observe = async () => {
          const result = await runtime!.query(VQ_RUNTIME_EVIDENCE_SQL, [true]);
          expect(result.rows).toHaveLength(1);
          const { catalog, ...evidence } = result.rows[0];
          return evaluateVqRuntimeEvidence({ ...evidence, catalogFingerprint: vqSchemaFingerprint(catalog) });
        };
        expect(await observe()).toEqual({ ready: true, lineage: historical ? "historical" : "fresh" });
        expect(await readiness(runtime)).toEqual({ ready: true, queryFailed: false });
        expect(await releaseReadiness(runtime)).toMatchObject({ ok: true, queryFailed: false, unavailableRuntime: [] });
        expect(await readiness(owner)).toEqual({ ready: false, queryFailed: false });
        expect(await readiness(owner, false)).toEqual({ ready: true, queryFailed: false });
        for (const mutation of [
          "GRANT DELETE ON vq_export_jobs TO mintvault_app",
          "GRANT USAGE ON SCHEMA drizzle TO mintvault_app WITH GRANT OPTION",
          "GRANT USAGE ON SCHEMA drizzle TO PUBLIC; REVOKE USAGE ON SCHEMA drizzle FROM mintvault_app",
          "GRANT mintvault_app TO vq_readiness_test WITH ADMIN OPTION",
          "GRANT UPDATE ON vq_card_revisions TO mintvault_app",
          "GRANT SELECT ON drizzle.vq_schema_migrations TO vq_readiness_test",
          "GRANT USAGE ON SEQUENCE drizzle.vq_schema_migrations_id_seq TO vq_readiness_test",
          "GRANT SELECT ON vq_export_jobs TO PUBLIC",
          "GRANT UPDATE(id) ON vq_card_revisions TO vq_readiness_test",
          "ALTER ROLE vq_readiness_test CREATEDB",
          "CREATE SEQUENCE public.vq_schema_migrations_id_seq",
          "ALTER TABLE vq_export_jobs ALTER COLUMN attempt_count SET DEFAULT 9",
          "UPDATE drizzle.vq_schema_migrations SET checksum=repeat('0',64)",
          "UPDATE drizzle.vq_schema_migrations SET completed_at=NULL",
          "UPDATE drizzle.vq_schema_migrations SET status='applying'",
          "INSERT INTO drizzle.vq_schema_migrations(filename,checksum,status,completed_at) VALUES('0017_test_dependency.sql',repeat('0',64),'applied',now())",
          ...(historical
            ? [
                "UPDATE drizzle.vq_schema_baselines SET observed_by=' '",
                "ALTER TABLE drizzle.vq_schema_baselines DROP CONSTRAINT vq_schema_baselines_schema_sha256_check; UPDATE drizzle.vq_schema_baselines SET schema_sha256=repeat('0',64)",
                "DELETE FROM drizzle.vq_schema_baselines",
              ]
            : [
                `INSERT INTO drizzle.vq_schema_baselines(baseline_id,evidence_kind,source_sha256,schema_sha256,observed_by) VALUES('vq-0000-0015-v1','observed_schema-v1','${VQ_BASELINE_MIGRATION_SET_SHA256}','${VQ_BASELINE_FINGERPRINT}','synthetic')`,
              ]),
        ]) {
          await owner.query("BEGIN");
          try {
            await owner.query(mutation);
            // SET ROLE on the owner connection observes its own uncommitted DDL.
            await owner.query("SET LOCAL ROLE vq_readiness_test");
            const { catalog, ...evidence } = (await owner.query(VQ_RUNTIME_EVIDENCE_SQL, [true])).rows[0];
            expect(
              evaluateVqRuntimeEvidence({ ...evidence, catalogFingerprint: vqSchemaFingerprint(catalog) }),
              mutation
            ).toEqual({ ready: false, lineage: null });
            expect(await readiness(owner), mutation).toEqual({ ready: false, queryFailed: false });
            // LOGIN flags are production-only; all schema/evidence mutations
            // must additionally veto the always-required development contract.
            if (!mutation.includes("ALTER ROLE vq_readiness_test") && !mutation.includes("TO vq_readiness_test")) {
              expect(await releaseReadiness(owner), mutation).toMatchObject({
                ok: false,
                queryFailed: false,
                unavailableRuntime: ["vault_quest_database_authority"],
              });
            }
          } finally {
            await owner.query("ROLLBACK");
          }
          expect(await observe()).toEqual({ ready: true, lineage: historical ? "historical" : "fresh" });
        }
        for (const mutation of [
          "DROP TABLE drizzle.vq_schema_baselines",
          "REVOKE SELECT ON drizzle.vq_schema_migrations FROM mintvault_app",
        ]) {
          await owner.query("BEGIN");
          try {
            await owner.query(mutation);
            await owner.query("SET LOCAL ROLE vq_readiness_test");
            expect(await readiness(owner), mutation).toEqual({ ready: false, queryFailed: true });
            expect(await releaseReadiness(owner), mutation).toMatchObject({
              ok: false,
              queryFailed: true,
              unavailableRuntime: ["vault_quest_database_authority"],
            });
          } finally {
            await owner.query("ROLLBACK");
          }
          expect(await readiness(runtime)).toEqual({ ready: true, queryFailed: false });
        }
        // Immutable 0016 forbids PUBLIC CREATE, not PUBLIC USAGE on drizzle.
        await owner.query("GRANT USAGE ON SCHEMA drizzle TO PUBLIC");
        expect(await readiness(runtime)).toEqual({ ready: true, queryFailed: false });
      } finally {
        await runtime?.end();
        await owner.end();
        await owned.stop();
      }
    },
    60_000
  );
});

describe("honest historical VQ admission", () => {
  const release = () => listMigrationFiles(migrationProfile("vault-quest").migrationsDir);
  it("refuses ordinary plan/apply before creating metadata on unjournalled business data", async () => {
    await withHistorical(async (client) => {
      const before = (await client.query("SELECT * FROM vq_export_jobs")).rows;
      await expect(planMigrations(client, release(), "vault-quest")).rejects.toThrow(/unjournalled/);
      await expect(applyMigrations(client, release(), { estate: "vault-quest" })).rejects.toThrow(/unjournalled/);
      expect(
        (await client.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal
      ).toBeNull();
      expect((await client.query("SELECT * FROM vq_export_jobs")).rows).toEqual(before);
    });
  }, 60_000);

  it("attests shape without executing old SQL, preserves rows, and converges exact runtime grants", async () => {
    await withHistorical(async (client) => {
      // Simulate overly broad historical grants; convergence must remove them.
      await client.query("GRANT ALL ON vq_export_jobs TO PUBLIC, mintvault_app");
      await client.query("GRANT UPDATE(id) ON vq_card_revisions TO PUBLIC, mintvault_app");
      const before = (await client.query("SELECT * FROM vq_export_jobs")).rows;
      const result = await applyMigrations(client, release(), { estate: "vault-quest", historicalBaseline: true });
      expect(result.applied).toEqual([VQ_BASELINE_AUTHORITY_FILE]);
      expect(
        (
          await client.query(
            "SELECT filename, status, completed_at IS NOT NULL complete FROM drizzle.vq_schema_migrations"
          )
        ).rows
      ).toEqual([{ filename: VQ_BASELINE_AUTHORITY_FILE, status: "applied", complete: true }]);
      const receipt = (await client.query("SELECT * FROM drizzle.vq_schema_baselines")).rows;
      expect(receipt).toHaveLength(1);
      expect(receipt[0]).toMatchObject({
        evidence_kind: "observed_schema-v1",
        source_sha256: VQ_BASELINE_MIGRATION_SET_SHA256,
        schema_sha256: VQ_BASELINE_FINGERPRINT,
      });
      const plan = await planMigrations(client, release(), "vault-quest");
      expect(plan.attestedNotApplied).toEqual(files.map((file) => file.filename));
      expect(plan.alreadyApplied).toEqual([VQ_BASELINE_AUTHORITY_FILE]);
      expect(plan.pending).toEqual([]);
      await client.query("UPDATE drizzle.vq_schema_migrations SET completed_at=NULL");
      await expect(planMigrations(client, release(), "vault-quest")).rejects.toThrow(/incomplete/);
      await client.query("UPDATE drizzle.vq_schema_migrations SET completed_at=now()");
      expect(await applyMigrations(client, release(), { estate: "vault-quest" })).toEqual({ applied: [] });
      expect((await client.query("SELECT * FROM drizzle.vq_schema_baselines")).rows).toEqual(receipt);
      expect((await client.query("SELECT * FROM vq_export_jobs")).rows).toEqual(before);
      for (const table of VQ_BASELINE_RELATIONS) {
        const append = ["vq_artwork_revision_events", "vq_card_revisions", "vq_character_revisions"].includes(table);
        const acl = (
          await client.query(
            "SELECT has_table_privilege('mintvault_app',$1,'SELECT') s, has_table_privilege('mintvault_app',$1,'INSERT') i, has_table_privilege('mintvault_app',$1,'UPDATE') u, has_table_privilege('mintvault_app',$1,'DELETE') d, has_table_privilege('mintvault_app',$1,'TRUNCATE') t, has_table_privilege('mintvault_app',$1,'TRIGGER') trigger, has_table_privilege('mintvault_app',$1,'REFERENCES') ref",
            [`public.${table}`]
          )
        ).rows[0];
        expect(acl, table).toEqual({ s: true, i: true, u: !append, d: false, t: false, trigger: false, ref: false });
      }
      await client.query("SET ROLE mintvault_app");
      expect(
        (
          await client.query(
            "SELECT has_column_privilege(current_user,'public.vq_card_revisions','id','UPDATE') allowed"
          )
        ).rows[0].allowed
      ).toBe(false);
      expect((await client.query("SELECT * FROM drizzle.vq_schema_baselines")).rowCount).toBe(1);
      await expect(client.query("UPDATE drizzle.vq_schema_baselines SET observed_by='fake'")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        client.query("INSERT INTO drizzle.vq_schema_migrations (filename,checksum) VALUES ('fake','fake')")
      ).rejects.toMatchObject({ code: "42501" });
      await expect(client.query("DELETE FROM vq_export_jobs")).rejects.toMatchObject({ code: "42501" });
      await client.query("RESET ROLE");
      await expect(
        applyMigrations(client, release(), { estate: "vault-quest", historicalBaseline: true })
      ).rejects.toThrow(/absent VQ control/);
      await expect(
        applyScopedMigration(client, files[0].filename, { files: release(), estate: "vault-quest" })
      ).rejects.toThrow(/attested/);
    });
  }, 60_000);

  it.each([
    ["shape", "ALTER TABLE vq_export_jobs ALTER COLUMN attempt_count SET DEFAULT 9"],
    ["partial journal", "CREATE SCHEMA drizzle; CREATE TABLE drizzle.vq_schema_migrations (id integer)"],
    ["receipt", "CREATE SCHEMA drizzle; CREATE TABLE drizzle.vq_schema_baselines (id integer)"],
    ["public residue", "CREATE SEQUENCE public.vq_schema_migrations_id_seq"],
    ["unrestricted role", "ALTER ROLE mintvault_app SUPERUSER"],
  ])(
    "refuses %s without creating new history",
    async (_name, mutation) => {
      await withHistorical(async (client) => {
        await client.query(mutation);
        const before = (
          await client.query(
            "SELECT to_regclass('drizzle.vq_schema_migrations') journal, to_regclass('drizzle.vq_schema_baselines') receipt"
          )
        ).rows;
        const data = (await client.query("SELECT * FROM vq_export_jobs")).rows;
        await expect(
          applyMigrations(client, release(), { estate: "vault-quest", historicalBaseline: true })
        ).rejects.toThrow();
        expect(
          (
            await client.query(
              "SELECT to_regclass('drizzle.vq_schema_migrations') journal, to_regclass('drizzle.vq_schema_baselines') receipt"
            )
          ).rows
        ).toEqual(before);
        expect((await client.query("SELECT * FROM vq_export_jobs")).rows).toEqual(data);
      });
    },
    60_000
  );

  it("refuses absent runtime authority and changed source without new metadata", async () => {
    await withHistorical(async (client) => {
      await expect(
        applyMigrations(client, release(), { estate: "vault-quest", historicalBaseline: true })
      ).rejects.toThrow(/existing main runtime role/);
      const changed = release().map((file, index) => (index === 0 ? { ...file, checksum: "changed" } : file));
      await expect(
        applyMigrations(client, changed, { estate: "vault-quest", historicalBaseline: true })
      ).rejects.toThrow(/source inventory/);
      expect(
        (await client.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal
      ).toBeNull();
    }, false);
  }, 60_000);

  it("rolls back the whole new control state when receipt persistence fails", async () => {
    await withHistorical(async (client) => {
      const failing = {
        async query(sql: string, args?: unknown[]) {
          if (sql.startsWith("INSERT INTO drizzle.vq_schema_baselines")) throw new Error("injected receipt failure");
          return client.query(sql, args);
        },
      };
      await expect(
        applyMigrations(failing, release(), { estate: "vault-quest", historicalBaseline: true })
      ).rejects.toThrow(/injected/);
      expect(
        (
          await client.query(
            "SELECT to_regclass('drizzle.vq_schema_migrations') journal, to_regclass('drizzle.vq_schema_baselines') receipt"
          )
        ).rows[0]
      ).toEqual({ journal: null, receipt: null });
      expect((await client.query("SELECT count(*)::int n FROM vq_export_jobs")).rows[0].n).toBe(1);
    });
  }, 60_000);

  it("runs the actual historical CLI and resumes without rewriting observation or execution history", async () => {
    await withHistorical(async (client, url) => {
      const run = (historical: boolean) =>
        execFileSync(
          process.execPath,
          [
            "node_modules/tsx/dist/cli.mjs",
            "scripts/db/migrate.ts",
            "--estate",
            "vault-quest",
            "--apply",
            ...(historical ? ["--historical-baseline-v1"] : []),
          ],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              LANG: "C",
              LC_ALL: "C",
              NODE_ENV: "test",
              MINTVAULT_MIGRATION_DATABASE_URL: url,
            },
            timeout: 30_000,
          }
        );
      expect(run(true)).toContain("Old SQL is attested, not applied");
      const before = (await client.query("SELECT * FROM drizzle.vq_schema_baselines")).rows;
      expect(run(false)).toContain("Applied 0:");
      expect((await client.query("SELECT * FROM drizzle.vq_schema_baselines")).rows).toEqual(before);
      expect((await client.query("SELECT count(*)::int n FROM drizzle.vq_schema_migrations")).rows[0].n).toBe(1);
    });
  }, 60_000);

  it.each(["DELETE FROM drizzle.vq_schema_baselines", "DROP TABLE drizzle.vq_schema_baselines"])(
    "refuses lost historical evidence instead of replaying old SQL: %s",
    async (mutation) => {
      await withHistorical(async (client) => {
        await applyMigrations(client, release(), { estate: "vault-quest", historicalBaseline: true });
        const before = (await client.query("SELECT * FROM drizzle.vq_schema_migrations")).rows;
        const data = (await client.query("SELECT * FROM vq_export_jobs")).rows;
        await client.query(mutation);
        await expect(planMigrations(client, release(), "vault-quest")).rejects.toThrow(/receipt/);
        await expect(applyMigrations(client, release(), { estate: "vault-quest" })).rejects.toThrow(/receipt/);
        expect((await client.query("SELECT * FROM drizzle.vq_schema_migrations")).rows).toEqual(before);
        expect((await client.query("SELECT * FROM vq_export_jobs")).rows).toEqual(data);
      });
    },
    60_000
  );

  it("retains baseline provenance through an explicit forward schema cut and rejects mixed history", async () => {
    await withHistorical(async (client) => {
      await applyMigrations(client, release(), { estate: "vault-quest", historicalBaseline: true });
      const before = (await client.query("SELECT * FROM drizzle.vq_schema_baselines")).rows;
      const sql = "ALTER TABLE vq_export_jobs ADD COLUMN proof_generation integer DEFAULT 0";
      const future = {
        ...release().at(-1)!,
        number: "0017",
        filename: "0017_test_dependency.sql",
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
      const evolved = [...release(), future];
      expect(await applyMigrations(client, evolved, { estate: "vault-quest" })).toEqual({ applied: [future.filename] });
      expect(await applyMigrations(client, evolved, { estate: "vault-quest" })).toEqual({ applied: [] });
      expect((await client.query("SELECT * FROM drizzle.vq_schema_baselines")).rows).toEqual(before);
      expect((await planMigrations(client, evolved, "vault-quest")).attestedNotApplied).toHaveLength(16);
      await client.query(
        "INSERT INTO drizzle.vq_schema_migrations(filename,checksum,status,completed_at) VALUES($1,$2,'applied',now())",
        [files[0].filename, files[0].checksum]
      );
      await expect(planMigrations(client, evolved, "vault-quest")).rejects.toThrow(/mixed/);
    });
  }, 60_000);

  it("revalidates the historical receipt under the scoped lock", async () => {
    await withHistorical(async (client) => {
      await applyMigrations(client, release(), { estate: "vault-quest", historicalBaseline: true });
      const sql = "ALTER TABLE vq_export_jobs ADD COLUMN raced integer";
      const next = {
        ...release().at(-1)!,
        number: "0017",
        filename: "0017_test_dependency.sql",
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
      const before = (await client.query("SELECT * FROM drizzle.vq_schema_migrations")).rows;
      let injected = false;
      const racing = {
        async query(statement: string, args?: unknown[]) {
          if (!injected && statement.includes("pg_try_advisory_lock")) {
            injected = true;
            await client.query("DELETE FROM drizzle.vq_schema_baselines");
          }
          return client.query(statement, args);
        },
      };
      await expect(
        applyScopedMigration(racing, next.filename, { estate: "vault-quest", files: [...release(), next] })
      ).rejects.toThrow(/receipt/);
      expect(injected).toBe(true);
      expect((await client.query("SELECT * FROM drizzle.vq_schema_migrations")).rows).toEqual(before);
      expect(
        (
          await client.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='vq_export_jobs' AND column_name='raced'"
          )
        ).rowCount
      ).toBe(0);
    });
  }, 60_000);

  it("holds table/index and sequence DDL locks through the final observation without consuming sequence values", async () => {
    await withHistorical(async (client, url) => {
      const peer = new pg.Client({ connectionString: url });
      await peer.connect();
      try {
        await peer.query("SET lock_timeout='100ms'");
        const before = (await client.query("SELECT * FROM public.vq_export_jobs_id_seq")).rows;
        let reads = 0;
        const outcomes: string[] = [];
        const observed = {
          async query(sql: string, args?: unknown[]) {
            const result = await client.query(sql, args);
            if (sql === VQ_SCHEMA_CATALOG_SQL && ++reads === 2) {
              for (const ddl of [
                "ALTER SEQUENCE public.vq_export_jobs_id_seq INCREMENT BY 2",
                "CREATE INDEX vq_locked_proof_idx ON vq_export_jobs(kind)",
              ]) {
                try {
                  await peer.query(ddl);
                  outcomes.push("unexpected-success");
                } catch (error) {
                  outcomes.push((error as { code: string }).code);
                }
              }
            }
            return result;
          },
        };
        await applyMigrations(observed, release(), { estate: "vault-quest", historicalBaseline: true });
        expect(outcomes).toEqual(["55P03", "55P03"]);
        expect((await client.query("SELECT * FROM public.vq_export_jobs_id_seq")).rows).toEqual(before);
        expect(vqSchemaFingerprint((await client.query(VQ_SCHEMA_CATALOG_SQL)).rows[0].catalog)).toBe(
          VQ_BASELINE_FINGERPRINT
        );
      } finally {
        await peer.end();
      }
    });
  }, 60_000);
});
beforeEach(async () => {
  await db.query("BEGIN");
});
afterEach(async () => {
  await db.query("ROLLBACK");
});

describe("immutable VQ historical schema catalog", () => {
  it("remains compatible with immutable main runtime authority after VQ creation", async () => {
    await db.query(
      "INSERT INTO vq_export_jobs (kind,owner_admin_id,idempotency_key) VALUES ('test','synthetic','main-after-vq')"
    );
    const before = (await db.query("SELECT * FROM vq_export_jobs")).rows;
    await db.query(readFileSync("migrations/0121_main_runtime_role_authority.sql", "utf8"));
    expect((await db.query("SELECT * FROM vq_export_jobs")).rows).toEqual(before);
    expect(await fingerprint()).toBe(VQ_BASELINE_FINGERPRINT);
    expect(
      (
        await db.query(
          "SELECT has_table_privilege('mintvault_app','public.vq_export_jobs','INSERT') insert_ok, has_table_privilege('mintvault_app','public.vq_export_jobs','DELETE') delete_ok"
        )
      ).rows[0]
    ).toEqual({ insert_ok: true, delete_ok: false });
  });
  it("pins source inventory and structural evidence, not a fabricated migration history", async () => {
    expect(files).toHaveLength(16);
    const sourceHash = createHash("sha256")
      .update(files.map((f) => `${f.filename}:${f.checksum}`).join("\n"))
      .digest("hex");
    expect({ sourceHash, expected }).toEqual({
      sourceHash: VQ_BASELINE_MIGRATION_SET_SHA256,
      expected: VQ_BASELINE_FINGERPRINT,
    });
    const catalog = (await db.query(VQ_SCHEMA_CATALOG_SQL)).rows[0].catalog;
    expect(catalog).toHaveLength(26);
    expect(catalog.map((relation: { name: string }) => relation.name)).toEqual(VQ_BASELINE_RELATIONS);
  });

  it.each([
    ["column", "ALTER TABLE vq_export_jobs DROP COLUMN ids"],
    ["column type", "ALTER TABLE vq_export_jobs ALTER COLUMN output_size TYPE numeric"],
    ["nullability", "ALTER TABLE vq_export_jobs ALTER COLUMN owner_admin_id DROP NOT NULL"],
    ["default", "ALTER TABLE vq_export_jobs ALTER COLUMN attempt_count SET DEFAULT 1"],
    ["index", "DROP INDEX vq_export_jobs_idem_active_uq"],
    ["constraint", "ALTER TABLE vq_export_jobs DROP CONSTRAINT vq_export_jobs_attempt_nonneg"],
    ["sequence", "ALTER SEQUENCE vq_export_jobs_id_seq INCREMENT BY 2"],
    ["unexpected table", "CREATE TABLE vq_unexpected (id integer)"],
    ["missing table", "DROP TABLE vq_feature_flags"],
    ["row policy state", "ALTER TABLE vq_export_jobs ENABLE ROW LEVEL SECURITY"],
    [
      "unvalidated constraint",
      "ALTER TABLE vq_export_jobs DROP CONSTRAINT vq_export_jobs_attempt_nonneg; ALTER TABLE vq_export_jobs ADD CONSTRAINT vq_export_jobs_attempt_nonneg CHECK (attempt_count >= 0) NOT VALID",
    ],
    [
      "trigger",
      "CREATE FUNCTION vq_test_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER vq_test BEFORE INSERT ON vq_export_jobs FOR EACH ROW EXECUTE FUNCTION vq_test_trigger()",
    ],
  ])("detects changed %s without a baseline or schema write of its own", async (_name, mutation) => {
    await db.query(mutation);
    expect(await fingerprint()).not.toBe(expected);
    expect((await db.query("SELECT to_regclass('drizzle.vq_schema_baselines') receipt")).rows[0].receipt).toBeNull();
    expect((await db.query("SELECT count(*)::int count FROM drizzle.vq_schema_migrations")).rows[0].count).toBe(16);
  });

  it("ignores row contents and sequence consumption, not structural changes", async () => {
    await db.query(
      "INSERT INTO vq_export_jobs (kind,owner_admin_id,idempotency_key) VALUES ('test','synthetic','catalog-proof')"
    );
    await db.query("UPDATE vq_export_jobs SET completed_count=1");
    expect(await fingerprint()).toBe(expected);
  });

  it("rejects malformed catalogs and never treats an empty catalog as the baseline", () => {
    expect(() => vqSchemaFingerprint(null)).toThrow(/array/);
    expect(() => vqSchemaFingerprint([undefined])).toThrow(/Invalid/);
    expect(vqSchemaFingerprint([])).not.toBe(VQ_BASELINE_FINGERPRINT);
    expect(vqSchemaFingerprint([{ a: 1, b: 2 }])).toBe(vqSchemaFingerprint([{ b: 2, a: 1 }]));
  });

  it("does not mistake the main journal or any execution ledger for schema evidence", async () => {
    await db.query("DROP TABLE drizzle.vq_schema_migrations");
    await db.query("CREATE TABLE schema_migrations (filename text)");
    expect(await fingerprint()).toBe(expected);
    expect((await db.query("SELECT count(*)::int count FROM schema_migrations")).rows[0].count).toBe(0);
    expect((await db.query("SELECT to_regclass('drizzle.vq_schema_migrations') journal")).rows[0].journal).toBeNull();
  });
});
