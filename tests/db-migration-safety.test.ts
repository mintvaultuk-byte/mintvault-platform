/**
 * Phase 0.5 — Database migration-safety regression tests (pure/unit; no live DB).
 *
 * DB-backed behaviours (advisory-lock concurrency, journal apply/idempotency, checksum
 * mutation, unknown-object preflight against a real DB) are exercised separately by the
 * disposable-DB validation harness (documented in the runbook), because they require a
 * throwaway Postgres. These unit tests cover all pure logic.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDbHost } from "../scripts/db/db-host-policy";
import { evaluatePreflight } from "../scripts/db/preflight-schema";
import {
  managedTables,
  inventoriedUnmanaged,
  inventoriedTables,
  inventoriedViews,
  inventoriedMatviews,
  classifyLiveObjects,
  classifyLiveTables,
  KNOWN_SCHEMAS,
  UNMANAGED_INVENTORY,
  type LiveObjects,
} from "../scripts/db/schema-registry";
import { lintSql, hasBlocking, stripSqlNoise } from "../scripts/db/lint-destructive-sql";

const PROD_UNMANAGED_TABLES_29 = [
  "ai_accuracy_log",
  "ai_grade_corrections",
  "ai_override_audit",
  "audit_logs",
  "bot_logs",
  "bot_seen",
  "bot_settings",
  "custom_sets",
  "custom_variants",
  "estimate_credits",
  "estimate_free_uses",
  "grading_records",
  "grading_sessions",
  "member_credits",
  "pending_switch_nonces",
  "pin_attempts",
  "pin_reset_tokens",
  "promo_codes",
  "promotions",
  "session",
  "sessions",
  "set_review_decisions",
  "stripe_webhook_events",
  "subscription_reminders",
  "tcgdex_sets",
  "value_protection_tiers",
  "vault_club_consents",
  "vault_club_events",
  "vault_club_subscriptions",
];

function objs(partial: Partial<LiveObjects>): LiveObjects {
  return { tables: [], views: [], matviews: [], schemas: [], orphanSequences: [], enums: [], ...partial };
}

describe("db host policy (db:push guard) — no override exists", () => {
  it("allows local/disposable hosts (v4/v6/unix-socket)", () => {
    for (const url of [
      "postgresql://postgres@127.0.0.1:55499/disposable",
      "postgres://u@localhost:5432/dev",
      "postgresql://u@[::1]:5432/dev",
      "postgresql:///dev?host=/var/run/postgresql",
    ]) {
      expect(classifyDbHost(url).allowedForPush).toBe(true);
    }
  });

  it("blocks any non-local host (no prod hostname hardcoded)", () => {
    for (const url of [
      "postgresql://u:p@ep-example-1234.eu-west-2.aws.neon.tech/appdb",
      "postgresql://u:p%40ssword@db.internal.example.com:5432/app", // percent-encoded creds
      "postgres://user@10.20.30.40:5432/app",
    ]) {
      const v = classifyDbHost(url);
      expect(v.allowedForPush).toBe(false);
      expect(v.isLocal).toBe(false);
    }
  });

  it("fails closed on unset/empty/unparseable/wrong-protocol URL", () => {
    for (const url of [undefined, "", "not a url", "mysql://u@localhost/db"]) {
      expect(classifyDbHost(url as string | undefined).allowedForPush).toBe(false);
    }
  });

  it("never prints or embeds a credential in the verdict", () => {
    const v = classifyDbHost("postgresql://user:supersecret@db.example.com:5432/app");
    expect(JSON.stringify(v)).not.toMatch(/supersecret/);
  });

  it("the dangerous override no longer exists in the policy module", async () => {
    const mod = await import("../scripts/db/db-host-policy");
    expect((mod as Record<string, unknown>).dangerousOverrideEnabled).toBeUndefined();
  });
});

describe("fail-closed preflight (all object types)", () => {
  it("passes when every object is managed / inventoried / vq_* / known-schema", () => {
    const res = evaluatePreflight(
      objs({
        tables: [...managedTables(), ...inventoriedTables(), "vq_cards"],
        views: inventoriedViews(),
        matviews: inventoriedMatviews(),
        schemas: KNOWN_SCHEMAS.map((s) => s.name),
        orphanSequences: ["ai_predictions_id_seq"],
        enums: [],
      })
    );
    expect(res.ok).toBe(true);
    expect(res.unknown).toEqual([]);
  });

  it("FAILS on an unknown table", () => {
    const res = evaluatePreflight(objs({ tables: [...managedTables(), "brand_new_table"] }));
    expect(res.ok).toBe(false);
    expect(res.unknown).toEqual([{ objectType: "table", name: "brand_new_table" }]);
  });

  it("FAILS on an unknown view, matview, schema, orphan sequence, or enum", () => {
    expect(evaluatePreflight(objs({ views: ["mystery_view"] })).ok).toBe(false);
    expect(evaluatePreflight(objs({ matviews: ["mystery_matview"] })).ok).toBe(false);
    expect(evaluatePreflight(objs({ schemas: ["public", "rogue_schema"] })).ok).toBe(false);
    expect(evaluatePreflight(objs({ orphanSequences: ["rogue_seq"] })).ok).toBe(false);
    expect(evaluatePreflight(objs({ enums: ["rogue_enum"] })).ok).toBe(false);
  });

  it("knows the three prod schemas and does not flag them", () => {
    expect(evaluatePreflight(objs({ tables: managedTables(), schemas: ["public", "drizzle", "stripe"] })).ok).toBe(
      true
    );
  });

  it("classifies vq_* as vaultQuest, not unknown", () => {
    const c = classifyLiveObjects(objs({ tables: ["vq_cards", "certificates", "member_credits"] }));
    expect(c.vaultQuest).toContain("vq_cards");
    expect(c.managed).toContain("certificates");
    expect(c.unmanaged).toContain("member_credits");
    expect(c.unknown).toEqual([]);
  });

  it("reports objects in known non-public schemas as integration-owned, not unknown (F4)", () => {
    const c = classifyLiveObjects(
      objs({
        tables: managedTables(),
        schemas: ["public", "stripe", "drizzle"],
        nonPublicObjects: [
          { schema: "stripe", name: "charges", kind: "table" },
          { schema: "drizzle", name: "__drizzle_migrations", kind: "table" },
        ],
      })
    );
    expect(c.unknown).toEqual([]);
    expect(c.integrationOwned.map((o) => `${o.schema}.${o.name}`)).toEqual([
      "stripe.charges",
      "drizzle.__drizzle_migrations",
    ]);
  });

  it("FAILS on an object in an UNKNOWN schema (F4 — never silent)", () => {
    const res = evaluatePreflight(
      objs({
        tables: managedTables(),
        schemas: ["public", "rogue"],
        nonPublicObjects: [{ schema: "rogue", name: "x", kind: "table" }],
      })
    );
    expect(res.ok).toBe(false);
    // both the unknown schema and the object in it are surfaced
    expect(res.unknown.some((u) => u.name === "rogue")).toBe(true);
    expect(res.unknown.some((u) => u.name === "rogue.x")).toBe(true);
  });
});

describe("unmanaged inventory completeness & richness", () => {
  it("classifies all 29 confirmed-unmanaged prod TABLES", () => {
    const c = classifyLiveTables(PROD_UNMANAGED_TABLES_29);
    expect(c.unknown).toEqual([]);
    expect(c.unmanaged.sort()).toEqual([...PROD_UNMANAGED_TABLES_29].sort());
  });

  it("reholder_credits is inventoried as a VIEW (not a table)", () => {
    expect(inventoriedViews()).toContain("reholder_credits");
    expect(inventoriedTables()).not.toContain("reholder_credits");
  });

  it("population_report is inventoried as a materialized view", () => {
    expect(inventoriedMatviews()).toContain("population_report");
  });

  it("managed allowlist and unmanaged inventory do not overlap", () => {
    const managed = new Set(managedTables());
    expect(inventoriedUnmanaged().filter((t) => managed.has(t))).toEqual([]);
  });

  it("every inventory entry documents the required fields", () => {
    for (const e of UNMANAGED_INVENTORY) {
      expect(e.schema).toBeTruthy();
      expect(e.name).toBeTruthy();
      expect(["table", "view", "materialized_view"]).toContain(e.objectType);
      expect(e.purpose).toBeTruthy();
      expect(typeof e.active).toBe("boolean");
      expect(e.owningSubsystem).toBeTruthy();
      expect(e.reason).toBeTruthy();
      expect(e.futureDisposition).toBeTruthy();
      expect(e.evidenceSource).toBeTruthy();
    }
  });

  it("payment/session/credit/view/matview objects are all protected", () => {
    const inv = new Set(inventoriedUnmanaged());
    for (const t of [
      "member_credits",
      "stripe_webhook_events",
      "promo_codes",
      "session",
      "vault_club_subscriptions",
      "reholder_credits",
      "population_report",
    ]) {
      expect(inv.has(t)).toBe(true);
    }
  });

  it("the runner's own schema_migrations journal is inventoried, not unknown", () => {
    expect(inventoriedUnmanaged()).toContain("schema_migrations");
    expect(classifyLiveTables(["schema_migrations", ...managedTables()]).unknown).toEqual([]);
  });

  it("records all Set Library tables as numbered-migration-owned, never runtime-managed", () => {
    const setLibrary = UNMANAGED_INVENTORY.filter((entry) =>
      ["custom_sets", "tcgdex_sets", "set_review_decisions"].includes(entry.name)
    );
    expect(setLibrary).toHaveLength(3);
    for (const entry of setLibrary) {
      expect(entry.class).toBe("numbered_migration");
      expect(entry.reason).toMatch(/migrations\/002[34]_set_library/i);
      expect(entry.futureDisposition).not.toMatch(/runtime-managed/i);
    }
  });
});

describe("partner network classification (Phase 1)", () => {
  it("classifies partner_* and field_welders as partnerNetwork, never unknown", () => {
    const c = classifyLiveObjects(
      objs({
        tables: ["partner_organisations", "partner_users", "partner_credit_ledger", "field_welders", "certificates"],
      })
    );
    expect(c.partnerNetwork.sort()).toEqual([
      "field_welders",
      "partner_credit_ledger",
      "partner_organisations",
      "partner_users",
    ]);
    expect(c.managed).toContain("certificates");
    expect(c.unknown).toEqual([]);
  });

  it("a non-partner unknown table still fails, with partner tables present", () => {
    const res = evaluatePreflight(objs({ tables: ["partner_users", "rogue_table", ...managedTables()] }));
    expect(res.ok).toBe(false);
    expect(res.unknown).toEqual([{ objectType: "table", name: "rogue_table" }]);
    expect(res.partnerNetwork).toContain("partner_users");
  });
});

describe("destructive-SQL linter (expanded object coverage)", () => {
  const blocks: [string, string][] = [
    ["DROP TABLE certificates;", "drop_table"],
    ["DROP VIEW reholder_credits;", "drop_view"],
    ["DROP MATERIALIZED VIEW population_report;", "drop_materialized_view"],
    ["DROP TYPE grade_enum;", "drop_type"],
    ["DROP SEQUENCE certificates_id_seq;", "drop_sequence"],
    ["DROP EXTENSION vector;", "drop_extension"],
    ["DROP INDEX idx_certs;", "drop_index"],
    ["DROP SCHEMA stripe;", "drop_schema"],
    ["DROP DATABASE app;", "drop_database"],
    ["ALTER TABLE certificates DROP COLUMN grade;", "drop_column"],
    ["ALTER TABLE certificates DROP CONSTRAINT certificates_pkey;", "drop_primary_key"],
    ["ALTER TABLE certificates RENAME TO certs;", "rename_table"],
    ["ALTER TABLE certificates RENAME COLUMN grade TO g;", "rename_column"],
    ["TRUNCATE member_credits;", "truncate"],
    ["DELETE FROM certificates;", "delete_without_where"],
    ["ALTER TABLE x DROP CONSTRAINT y CASCADE;", "cascade"],
    ["ALTER TYPE mood DROP VALUE 'sad';", "enum_value_removed"],
  ];
  it.each(blocks)("blocks %s", (sql, kind) => {
    const f = lintSql(sql);
    expect(hasBlocking(f)).toBe(true);
    expect(f.some((x) => x.kind === kind)).toBe(true);
  });

  it("flags (not blocks) type change, add NOT NULL, and unqualified UPDATE", () => {
    expect(hasBlocking(lintSql("ALTER TABLE c ALTER COLUMN grade TYPE integer;"))).toBe(false);
    expect(lintSql("ALTER TABLE c ALTER COLUMN grade SET NOT NULL;").some((x) => x.kind === "add_not_null")).toBe(true);
    expect(hasBlocking(lintSql("UPDATE certificates SET x = 1;"))).toBe(false);
  });

  it("does NOT block a referential ON DELETE/UPDATE CASCADE in an additive FK (F3)", () => {
    const sql =
      "CREATE TABLE IF NOT EXISTS child (id serial primary key, p int REFERENCES parent(id) ON DELETE CASCADE);";
    expect(lintSql(sql)).toEqual([]);
    // but a destructive DROP ... CASCADE is still blocked
    expect(hasBlocking(lintSql("DROP TABLE parent CASCADE;"))).toBe(true);
  });

  it("allows DELETE/UPDATE with WHERE and safe additive SQL", () => {
    expect(hasBlocking(lintSql("DELETE FROM certificates WHERE id = 1;"))).toBe(false);
    const additive = `
      CREATE TABLE IF NOT EXISTS schema_migrations (id serial primary key);
      ALTER TABLE certificates ADD COLUMN IF NOT EXISTS tenant_id uuid;
      CREATE INDEX IF NOT EXISTS idx_x ON certificates (tenant_id);`;
    expect(lintSql(additive)).toEqual([]);
  });

  it("ignores destructive keywords inside comments, strings, and dollar-quoted bodies", () => {
    const sql = `
      -- DROP TABLE certificates would be bad
      /* also DROP SCHEMA public here */
      INSERT INTO notes (body) VALUES ('do not DROP TABLE anything');
      CREATE FUNCTION f() RETURNS void AS $$ BEGIN DROP TABLE hidden; END; $$ LANGUAGE plpgsql;`;
    expect(stripSqlNoise(sql)).not.toMatch(/hidden/);
    expect(lintSql(sql)).toEqual([]);
  });

  it("handles mixed case, quoted identifiers, and multiline", () => {
    expect(hasBlocking(lintSql('dRoP   taBLE\n  "Weird Name";'))).toBe(true);
  });
});

describe("migration runner planning (pure)", () => {
  it("exports listMigrationFiles", async () => {
    const { listMigrationFiles } = await import("../scripts/db/migrate");
    expect(typeof listMigrationFiles).toBe("function");
  });

  it("rejects duplicate migration numbers before execution", async () => {
    const { listMigrationFiles } = await import("../scripts/db/migrate");
    const dir = mkdtempSync(join(tmpdir(), "mintvault-duplicate-migrations-"));
    try {
      writeFileSync(join(dir, "0001_alpha.sql"), "CREATE TABLE alpha(id integer);");
      writeFileSync(join(dir, "00001_beta.sql"), "CREATE TABLE beta(id integer);");
      let message = "";
      try {
        listMigrationFiles(dir);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("Duplicate migration number(s): 1 ->");
      expect(message).toContain("0001_alpha.sql");
      expect(message).toContain("00001_beta.sql");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts postgres connection URLs from CLI error text", async () => {
    const { redactMigrationErrorMessage } = await import("../scripts/db/migrate");
    const message =
      "connection failed for postgresql://user:supersecret@db.example.com:5432/mintvault and MINTVAULT_DATABASE_URL=postgres://u:p@host/db";
    const redacted = redactMigrationErrorMessage(message);
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("postgres://u:p@host/db");
    expect(redacted).toContain("[redacted-postgres-url]");
  });

  it("plan marks pending, detects checksum mismatch and journal inconsistency", async () => {
    const { planMigrations } = await import("../scripts/db/migrate");
    const journal: { filename: string; checksum: string; status: string }[] = [];
    const client = {
      async query(sql: string) {
        if (/to_regclass/i.test(sql)) return { rows: [{ reg: "schema_migrations" }] }; // journal exists
        if (/CREATE TABLE IF NOT EXISTS schema_migrations|ALTER TABLE schema_migrations/i.test(sql))
          return { rows: [] };
        if (/SELECT filename, checksum, status FROM schema_migrations/i.test(sql)) return { rows: journal.slice() };
        return { rows: [] };
      },
    };
    const files = [
      {
        number: "0001",
        filename: "0001_x.sql",
        path: "",
        sql: "CREATE TABLE x();",
        checksum: "aaa",
        noTransaction: false,
      },
    ];
    expect((await planMigrations(client, files)).pending).toEqual(["0001_x.sql"]);
    journal.push({ filename: "0001_x.sql", checksum: "aaa", status: "applied" });
    expect((await planMigrations(client, files)).alreadyApplied).toEqual(["0001_x.sql"]);
    const edited = [{ ...files[0], checksum: "bbb" }];
    expect((await planMigrations(client, edited)).checksumMismatches.map((m) => m.filename)).toEqual(["0001_x.sql"]);
    journal[0].status = "failed";
    expect((await planMigrations(client, files)).inconsistent.map((i) => i.filename)).toEqual(["0001_x.sql"]);
  });

  /**
   * MIG1 — the monotonic guard.
   *
   * "Pending" means "absent from the journal by filename"; the numeric sort only orders the batch.
   * So a branch carrying 0038 that merges after 0040 has landed used to be applied silently, out of
   * order, with no warning on the dry-run either. Migration 0039's own header recorded the absence
   * of this check as a known hazard.
   */
  describe("MIG1 — monotonic migration guard", () => {
    const mkFile = (number: string, name = `${number}_x.sql`) => ({
      number,
      filename: name,
      path: "",
      sql: "CREATE TABLE x();",
      checksum: `sum-${number}`,
      noTransaction: false,
    });

    const clientWith = (journal: { filename: string; checksum: string; status: string }[]) => ({
      async query(sql: string) {
        if (/to_regclass/i.test(sql)) return { rows: [{ reg: "schema_migrations" }] };
        if (/SELECT filename, checksum, status FROM schema_migrations/i.test(sql)) return { rows: journal.slice() };
        return { rows: [] };
      },
    });

    it("case 1: applied max 0040 + newly introduced 0038 → flagged out of order", async () => {
      const { planMigrations } = await import("../scripts/db/migrate");
      const journal = [{ filename: "0040_seed.sql", checksum: "sum-0040", status: "applied" }];
      const files = [mkFile("0038"), mkFile("0040", "0040_seed.sql")];
      const plan = await planMigrations(clientWith(journal), files);

      expect(plan.pending).toEqual(["0038_x.sql"]);
      expect(plan.outOfOrder.map((o) => o.filename)).toEqual(["0038_x.sql"]);
      expect(plan.outOfOrder[0].appliedWatermark).toBe(40);
    });

    it("case 2: applied max 0039 + new 0040 → allowed", async () => {
      const { planMigrations } = await import("../scripts/db/migrate");
      const journal = [{ filename: "0039_live.sql", checksum: "sum-0039", status: "applied" }];
      const files = [mkFile("0039", "0039_live.sql"), mkFile("0040")];
      const plan = await planMigrations(clientWith(journal), files);

      expect(plan.pending).toEqual(["0040_x.sql"]);
      expect(plan.outOfOrder).toEqual([]);
    });

    it("case 3: gaps below the watermark that are ALREADY journalled are allowed", async () => {
      // 0020/0021/0025/0027-0029 are reserved-but-unmerged by design. Flagging an applied gap
      // would fail every run for no reason.
      const { planMigrations } = await import("../scripts/db/migrate");
      const journal = [
        { filename: "0030_pc.sql", checksum: "sum-0030", status: "applied" },
        { filename: "0035_origin.sql", checksum: "sum-0035", status: "applied" },
      ];
      const files = [mkFile("0030", "0030_pc.sql"), mkFile("0035", "0035_origin.sql"), mkFile("0039")];
      const plan = await planMigrations(clientWith(journal), files);

      expect(plan.pending).toEqual(["0039_x.sql"]);
      expect(plan.outOfOrder).toEqual([]);
    });

    it("case 4: rollback files are ignored entirely — they never match the runner's pattern", async () => {
      const { listMigrationFiles } = await import("../scripts/db/migrate");
      const dir = mkdtempSync(join(tmpdir(), "mig-monotonic-"));
      writeFileSync(join(dir, "0040_real.sql"), "SELECT 1;");
      writeFileSync(join(dir, "rollback-0038-thing.sql"), "DROP TABLE x;");
      writeFileSync(join(dir, "_rollback_old.sql"), "DROP TABLE y;");

      const files = listMigrationFiles(dir);
      expect(files.map((f) => f.filename)).toEqual(["0040_real.sql"]);
    });

    it("case 5: a duplicate migration number still fails, independently of the watermark", async () => {
      const { listMigrationFiles } = await import("../scripts/db/migrate");
      const dir = mkdtempSync(join(tmpdir(), "mig-dup-"));
      writeFileSync(join(dir, "0039_a.sql"), "SELECT 1;");
      writeFileSync(join(dir, "0039_b.sql"), "SELECT 2;");

      expect(() => listMigrationFiles(dir)).toThrow(/Duplicate migration number/);
    });

    it("case 6: malformed filenames keep their existing behaviour — silently not migrations", async () => {
      const { listMigrationFiles } = await import("../scripts/db/migrate");
      const dir = mkdtempSync(join(tmpdir(), "mig-malformed-"));
      writeFileSync(join(dir, "0041-hyphen.sql"), "SELECT 1;");
      writeFileSync(join(dir, "add-legacy.sql"), "SELECT 2;");
      writeFileSync(join(dir, "0042_good.sql"), "SELECT 3;");

      expect(listMigrationFiles(dir).map((f) => f.filename)).toEqual(["0042_good.sql"]);
    });

    it("an empty journal never reports anything out of order", async () => {
      const { planMigrations } = await import("../scripts/db/migrate");
      const plan = await planMigrations(clientWith([]), [mkFile("0038"), mkFile("0040")]);
      expect(plan.outOfOrder).toEqual([]);
    });

    /**
     * The tests above pin DETECTION. This pins the REFUSAL.
     *
     * Without it, deleting the `if (plan.outOfOrder.length > 0) throw` block from applyMigrations
     * leaves `plan.outOfOrder` correctly populated and completely ignored — every detection test
     * stays green while out-of-order migrations apply silently. Given this repo's history of
     * 0019/0020/0022/0023 numbering collisions, that is exactly the failure the guard exists for.
     */
    it("MIG1 enforcement: applyMigrations REFUSES to apply an out-of-order migration", async () => {
      const { applyMigrations } = await import("../scripts/db/migrate");
      const journal = [{ filename: "0040_seed.sql", checksum: "sum-0040", status: "applied" }];
      const applied: string[] = [];
      const client = {
        async query(sql: string, params?: unknown[]) {
          if (/to_regclass/i.test(sql)) return { rows: [{ reg: "schema_migrations" }] };
          if (/SELECT filename, checksum, status FROM schema_migrations/i.test(sql)) return { rows: journal.slice() };
          if (/pg_backend_pid\(\) AS pid/i.test(sql)) return { rows: [{ pid: 1 }] };
          if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ got: true }] };
          if (/FROM pg_locks/i.test(sql)) return { rows: [{ pid: 1, current_pid: 1 }] };
          if (/pg_advisory_unlock/i.test(sql)) return { rows: [{ unlocked: true }] };
          if (/INSERT INTO schema_migrations/i.test(sql)) {
            applied.push(String((params ?? [])[0]));
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      await expect(
        applyMigrations(client as never, [mkFile("0038"), mkFile("0040", "0040_seed.sql")])
      ).rejects.toThrow(/[Oo]ut-of-order/);

      // And nothing was journalled — the refusal happens before any migration is executed.
      expect(applied).toEqual([]);
    });

    it("MIG1 enforcement: an in-order migration is NOT refused by the guard", async () => {
      const { planMigrations } = await import("../scripts/db/migrate");
      const journal = [{ filename: "0039_live.sql", checksum: "sum-0039", status: "applied" }];
      const plan = await planMigrations(clientWith(journal), [mkFile("0039", "0039_live.sql"), mkFile("0040")]);
      // The guard must be silent on the valid case, or it would block every legitimate deploy.
      expect(plan.outOfOrder).toEqual([]);
    });

    it("appliedWatermark ignores journal rows that are not canonical migrations", async () => {
      const { appliedWatermark } = await import("../scripts/db/migrate");
      expect(appliedWatermark(["0030_a.sql", "0040_b.sql", "rollback-0099-x.sql", "junk"])).toBe(40);
      expect(appliedWatermark([])).toBe(0);
    });
  });

  it("dry-run planMigrations issues NO mutating DDL (F1 — dry-run mutates nothing)", async () => {
    const { planMigrations } = await import("../scripts/db/migrate");
    const issued: string[] = [];
    const client = {
      async query(sql: string) {
        issued.push(sql);
        if (/to_regclass/i.test(sql)) return { rows: [{ reg: null }] }; // journal table absent
        return { rows: [] };
      },
    };
    const files = [
      {
        number: "0001",
        filename: "0001_x.sql",
        path: "",
        sql: "CREATE TABLE x();",
        checksum: "aaa",
        noTransaction: false,
      },
    ];
    const plan = await planMigrations(client, files);
    expect(plan.pending).toEqual(["0001_x.sql"]); // missing journal -> all pending
    expect(issued.some((s) => /CREATE TABLE|ALTER TABLE/i.test(s))).toBe(false); // no DDL issued
  });
});
