/**
 * Phase 0.5 — Database migration-safety regression tests.
 *
 * Pure/unit coverage for the protection logic (no live DB required):
 *  - host guard classification (local allowed, non-local blocked, override)
 *  - fail-closed preflight (unknown table -> fail; managed/inventoried/vq -> pass)
 *  - inventory completeness (all 30 confirmed-unmanaged prod tables are classified)
 *  - destructive-SQL linter (DROP TABLE/COLUMN, TRUNCATE, DELETE/UPDATE w/o WHERE,
 *    constraint removal, type change; safe additive SQL passes)
 *  - migration runner planning (checksum idempotency semantics)
 *
 * A DB-backed migration-runner test runs only when MIGRATION_TEST_DATABASE_URL points at
 * a disposable local database; otherwise it is skipped (never touches staging/prod).
 */
import { describe, it, expect } from "vitest";
import { classifyDbHost, dangerousOverrideEnabled } from "../scripts/db/db-host-policy";
import { evaluatePreflight } from "../scripts/db/preflight-schema";
import { managedTables, inventoriedUnmanaged, classifyLiveTables } from "../scripts/db/schema-registry";
import { lintSql, hasBlocking, stripSqlNoise } from "../scripts/db/lint-destructive-sql";

// The 30 tables confirmed live on prod (2026-07-17) and absent from shared/schema.ts.
const PROD_UNMANAGED_30 = [
  "ai_accuracy_log", "ai_grade_corrections", "ai_override_audit", "audit_logs", "bot_logs",
  "bot_seen", "bot_settings", "custom_sets", "custom_variants", "estimate_credits",
  "estimate_free_uses", "grading_records", "grading_sessions", "member_credits",
  "pending_switch_nonces", "pin_attempts", "pin_reset_tokens", "promo_codes", "promotions",
  "reholder_credits", "session", "sessions", "set_review_decisions", "stripe_webhook_events",
  "subscription_reminders", "tcgdex_sets", "value_protection_tiers", "vault_club_consents",
  "vault_club_events", "vault_club_subscriptions",
];

describe("db host policy (db:push guard)", () => {
  it("allows local/disposable hosts", () => {
    for (const url of [
      "postgresql://postgres@127.0.0.1:55499/disposable",
      "postgres://u@localhost:5432/dev",
    ]) {
      expect(classifyDbHost(url).allowedForPush).toBe(true);
    }
  });

  it("blocks any non-local host (no prod hostname hardcoded)", () => {
    const v = classifyDbHost("postgresql://u:p@ep-example-1234.eu-west-2.aws.neon.tech/neondb");
    expect(v.allowedForPush).toBe(false);
    expect(v.isLocal).toBe(false);
  });

  it("fails closed on unset/unparseable URL", () => {
    expect(classifyDbHost(undefined).allowedForPush).toBe(false);
    expect(classifyDbHost("not a url").allowedForPush).toBe(false);
  });

  it("recognises the explicit dangerous override only when exactly set", () => {
    expect(dangerousOverrideEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(dangerousOverrideEnabled({ ALLOW_DANGEROUS_DB_PUSH: "yes" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(
      dangerousOverrideEnabled({ ALLOW_DANGEROUS_DB_PUSH: "i-understand-this-can-drop-live-tables" } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("fail-closed preflight", () => {
  it("passes when every live table is managed, inventoried-unmanaged, or vq_*", () => {
    const live = [...managedTables(), ...inventoriedUnmanaged(), "vq_cards", "vq_sets"];
    const res = evaluatePreflight(live);
    expect(res.ok).toBe(true);
    expect(res.unknown).toEqual([]);
  });

  it("FAILS when an unknown table appears (never silently disposable)", () => {
    const live = [...managedTables(), "some_new_unclassified_table"];
    const res = evaluatePreflight(live);
    expect(res.ok).toBe(false);
    expect(res.unknown).toContain("some_new_unclassified_table");
  });

  it("classifies vq_* as vaultQuest, not unknown", () => {
    const res = classifyLiveTables(["vq_cards", "certificates", "member_credits"]);
    expect(res.vaultQuest).toContain("vq_cards");
    expect(res.managed).toContain("certificates");
    expect(res.unmanaged).toContain("member_credits");
    expect(res.unknown).toEqual([]);
  });
});

describe("unmanaged inventory completeness", () => {
  it("classifies all 30 confirmed-unmanaged prod tables (none treated as unknown)", () => {
    const res = classifyLiveTables(PROD_UNMANAGED_30);
    expect(res.unknown).toEqual([]);
    expect(res.unmanaged.sort()).toEqual([...PROD_UNMANAGED_30].sort());
  });

  it("managed allowlist and unmanaged inventory do not overlap", () => {
    const managed = new Set(managedTables());
    const overlap = inventoriedUnmanaged().filter((t) => managed.has(t));
    expect(overlap).toEqual([]);
  });

  it("payment/session/credit tables are all in the protected inventory", () => {
    const inv = new Set(inventoriedUnmanaged());
    for (const t of ["member_credits", "stripe_webhook_events", "promo_codes", "session", "vault_club_subscriptions"]) {
      expect(inv.has(t)).toBe(true);
    }
  });
});

describe("destructive-SQL linter", () => {
  it("blocks DROP TABLE", () => {
    const f = lintSql("DROP TABLE certificates;");
    expect(hasBlocking(f)).toBe(true);
    expect(f[0].kind).toBe("drop_table");
  });

  it("blocks DROP COLUMN", () => {
    expect(hasBlocking(lintSql("ALTER TABLE certificates DROP COLUMN grade;"))).toBe(true);
  });

  it("blocks TRUNCATE", () => {
    expect(hasBlocking(lintSql("TRUNCATE member_credits;"))).toBe(true);
  });

  it("blocks DROP CONSTRAINT", () => {
    expect(hasBlocking(lintSql("ALTER TABLE certificates DROP CONSTRAINT certificates_nfc_uid_unique;"))).toBe(true);
  });

  it("blocks DELETE without WHERE", () => {
    expect(hasBlocking(lintSql("DELETE FROM certificates;"))).toBe(true);
  });

  it("allows DELETE with WHERE", () => {
    expect(hasBlocking(lintSql("DELETE FROM certificates WHERE id = 1;"))).toBe(false);
  });

  it("flags (not blocks) a column type change", () => {
    const f = lintSql("ALTER TABLE certificates ALTER COLUMN grade TYPE integer;");
    expect(f.some((x) => x.kind === "column_type_change")).toBe(true);
    expect(hasBlocking(f)).toBe(false);
  });

  it("passes safe additive SQL", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS schema_migrations (id serial primary key);
      ALTER TABLE certificates ADD COLUMN IF NOT EXISTS tenant_id uuid;
      CREATE INDEX IF NOT EXISTS idx_x ON certificates (tenant_id);
    `;
    expect(lintSql(sql)).toEqual([]);
  });

  it("does not match destructive keywords inside comments or strings", () => {
    const sql = `
      -- DROP TABLE certificates would be bad
      INSERT INTO notes (body) VALUES ('do not DROP TABLE anything');
    `;
    expect(stripSqlNoise(sql)).not.toMatch(/certificates/);
    expect(lintSql(sql)).toEqual([]);
  });
});

describe("migration runner planning (checksum idempotency)", () => {
  it("re-applying an unchanged file is a no-op; an edited applied file is a mismatch", async () => {
    const { planMigrations } = await import("../scripts/db/migrate");
    // Fake client backed by an in-memory journal.
    const journal: { filename: string; checksum: string }[] = [];
    const client = {
      async query(sql: string, args?: unknown[]) {
        if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) return { rows: [] };
        if (/SELECT filename, checksum FROM schema_migrations/i.test(sql)) return { rows: journal.slice() };
        if (/INSERT INTO schema_migrations/i.test(sql)) {
          journal.push({ filename: String(args![0]), checksum: String(args![1]) });
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const files = [{ filename: "0001_x.sql", path: "", sql: "CREATE TABLE x();", checksum: "aaa" }];
    // First plan: pending.
    let plan = await planMigrations(client, files);
    expect(plan.pending).toEqual(["0001_x.sql"]);
    // Simulate applied.
    journal.push({ filename: "0001_x.sql", checksum: "aaa" });
    plan = await planMigrations(client, files);
    expect(plan.pending).toEqual([]);
    expect(plan.alreadyApplied).toEqual(["0001_x.sql"]);
    // Edit the file (checksum changes) -> mismatch.
    const edited = [{ ...files[0], checksum: "bbb" }];
    plan = await planMigrations(client, edited);
    expect(plan.checksumMismatches.map((m) => m.filename)).toEqual(["0001_x.sql"]);
  });
});
