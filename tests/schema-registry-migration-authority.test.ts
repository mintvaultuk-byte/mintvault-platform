import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { managedTables, UNMANAGED_INVENTORY } from "../scripts/db/schema-registry";

const MIGRATION_0115 = "migrations/0115_runtime_schema_convergence.sql";

function createdTables(filename: string): string[] {
  const sql = readFileSync(filename, "utf8");
  return [...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)].map(
    (match) => match[1]
  );
}

describe("schema registry migration authority", () => {
  it("classifies every 0115-created table as Drizzle-managed or 0115 migration-owned", () => {
    const managed = new Set(managedTables());
    const inventory = new Map(UNMANAGED_INVENTORY.map((entry) => [entry.name, entry]));
    const unclassified: string[] = [];

    for (const table of createdTables(MIGRATION_0115)) {
      if (managed.has(table)) continue;

      const entry = inventory.get(table);
      if (!entry) {
        unclassified.push(table);
        continue;
      }

      expect(entry.class, table).toBe("numbered_migration");
      expect(entry.reason, table).toContain(MIGRATION_0115);
      expect(entry.evidenceSource, table).toMatch(/migration 0115/i);
      expect(entry.futureDisposition, table).not.toMatch(/runtime-managed|hand-applied/i);
    }

    expect(unclassified).toEqual([]);
  });

  it("keeps the 0115 marketplace schema in the Drizzle-managed authority", () => {
    const managed = new Set(managedTables());
    const marketplaceTables = createdTables(MIGRATION_0115).filter((table) => table.startsWith("marketplace_"));

    expect(marketplaceTables.length).toBeGreaterThan(0);
    expect(marketplaceTables.filter((table) => !managed.has(table))).toEqual([]);
  });

  it("records public.session as migration 0119 authority, not runtime DDL", () => {
    const session = UNMANAGED_INVENTORY.find((entry) => entry.name === "session");

    expect(session).toMatchObject({
      schema: "public",
      objectType: "table",
      class: "numbered_migration",
      reason: "migrations/0119_session_store_authority.sql",
    });
    expect(session?.evidenceSource).toMatch(/migration 0119/i);
    expect(session?.futureDisposition).not.toMatch(/runtime-managed|out-of-band/i);
  });

  it("does not claim any active runtime-created schema after boot DDL removal", () => {
    expect(
      UNMANAGED_INVENTORY.filter(
        (entry) => entry.active && /runtime-created|runtime migrate|created by runtime/i.test(entry.reason)
      )
    ).toEqual([]);

    for (const name of ["vault_club_subscriptions", "vault_club_consents", "subscription_reminders"]) {
      expect(UNMANAGED_INVENTORY.find((entry) => entry.name === name)).toMatchObject({
        active: false,
        class: "unknown_investigate",
      });
    }
  });
});
