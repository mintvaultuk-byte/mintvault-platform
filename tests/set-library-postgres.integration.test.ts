import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import express from "express";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let postgres: DisposablePostgres17;
let client: Client;
let appServer: Server | undefined;
let closePool: (() => Promise<void>) | undefined;

async function applyFixtureSchema(): Promise<void> {
  await client.query(`
    CREATE TABLE custom_sets (set_id text, set_name text, card_game text, series text, ptcgo_code text, release_date date, total_cards integer, created_at timestamptz default now());
    CREATE TABLE tcgdex_sets (set_id text, set_name text, series text, ptcgo_code text, release_date date, total_cards integer);
    CREATE TABLE card_sets (set_id text, set_name text, game text, series text, release_date text, total_cards integer, is_deleted boolean default false, deleted_at timestamptz);
    CREATE TABLE card_master (set_id text, is_deleted boolean default false);
    CREATE TABLE certificates (set_name text, card_game text, deleted_at timestamptz);
    CREATE TABLE audit_log (entity_type text, entity_id text, action text, admin_user text, details jsonb);
  `);
  await client.query(await readFile("migrations/0023_set_library_schema.sql", "utf8"));
}

beforeAll(async () => {
  postgres = await startPostgres17("set-library-reconcile");
  process.env.MINTVAULT_DATABASE_URL = postgres.url;
  client = new Client({ connectionString: postgres.url });
  await client.connect();
  await applyFixtureSchema();
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer?.close(() => resolve()) ?? resolve());
  await closePool?.();
  await client?.end();
  await postgres?.stop();
});

describe("set-library reconciliation against disposable PostgreSQL", () => {
  it("serves only active public rows after 0023 and returns 503 on a query failure", async () => {
    await client.query(`
      INSERT INTO custom_sets (set_id, set_name, series, release_date, total_cards, archived)
      VALUES ('custom-live', 'Custom live', 'Base', '2023-09-22', 1, false), ('custom-old', 'Custom old', 'Base', '2023-01-01', 1, true);
      INSERT INTO tcgdex_sets (set_id, set_name, series, release_date, total_cards, archived)
      VALUES ('tcgdex-live', 'TCGdex live', 'Base', '2023-09-22', 1, false), ('tcgdex-old', 'TCGdex old', 'Base', '2023-01-01', 1, true);
    `);
    await expect(
      client.query("SELECT set_id FROM custom_sets WHERE COALESCE(archived, false) = false ORDER BY created_at DESC")
    ).resolves.toMatchObject({ rowCount: 1 });
    vi.resetModules();
    const { registerPublicRoutes } = await import("../server/routes/public");
    const { pool } = await import("../server/db");
    closePool = () => pool.end();
    const app = express();
    registerPublicRoutes(app);
    appServer = app.listen(0);
    await new Promise<void>((resolve) => appServer!.once("listening", resolve));
    const port = (appServer.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/pokemon-sets`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining(["custom-live", "tcgdex-live"]));
    expect(body.map((row: { id: string }) => row.id)).not.toEqual(expect.arrayContaining(["custom-old", "tcgdex-old"]));
    expect(Object.keys(body[0]).sort()).toEqual([
      "id",
      "name",
      "ptcgoCode",
      "releaseDate",
      "series",
      "source",
      "total",
    ]);
    expect(JSON.stringify(body)).not.toContain("linkedCertificates");
    expect(JSON.stringify(body)).not.toContain("updatedAt");
    await client.query("ALTER TABLE custom_sets DROP COLUMN archived");
    const failed = await fetch(`http://127.0.0.1:${port}/api/pokemon-sets`);
    expect(failed.status).toBe(503);
    await expect(
      client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'custom_sets' AND column_name = 'archived'"
      )
    ).resolves.toMatchObject({ rowCount: 0 });
    // Restore only through the canonical migration fixture, never through an
    // application request.
    await client.query(await readFile("migrations/0023_set_library_schema.sql", "utf8"));
  });

  it("uses raw card_sets dates in the real service compare-and-swap", async () => {
    await client.query(`
      INSERT INTO card_sets (set_id, set_name, game, series, release_date, total_cards)
      VALUES ('full-date', 'Full date', 'pokemon', 'Base', '2023-09-22', 1), ('year-only', 'Year only', 'pokemon', 'Base', '1999', 1), ('no-date', 'No date', 'pokemon', 'Base', NULL, 1);
    `);
    vi.resetModules();
    const { listSetLibrary, updateSetLibraryRecord, SetLibraryError } = await import("../server/services/set-library");
    const read = async (id: string) =>
      (await listSetLibrary({ pageSize: 100 })).sets.find((row) => row.source === "card_sets" && row.setId === id)!;
    const full = await read("full-date");
    expect((await read("full-date")).version).toBe(full.version);
    await expect(
      updateSetLibraryRecord(
        "card_sets",
        "full-date",
        { setName: "Full date corrected", reason: "Fix", version: full.version },
        { id: "a", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true });
    expect(
      (await client.query("SELECT release_date, set_id, series FROM card_sets WHERE set_id = 'full-date'")).rows[0]
    ).toMatchObject({ release_date: "2023-09-22", set_id: "full-date", series: "Base" });
    await expect(
      updateSetLibraryRecord(
        "card_sets",
        "full-date",
        { setName: "Stale", reason: "Fix", version: full.version },
        { id: "b", role: "admin" }
      )
    ).rejects.toBeInstanceOf(SetLibraryError);
    for (const id of ["year-only", "no-date"]) {
      const row = await read(id);
      await expect(
        updateSetLibraryRecord(
          "card_sets",
          id,
          { setName: `${row.setName} corrected`, reason: "Fix", version: row.version },
          { id: "a", role: "admin" }
        )
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it("preserves precise custom and TCGdex dates unless the release year genuinely changes", async () => {
    await client.query(`
      INSERT INTO custom_sets (set_id, set_name, card_game, series, release_date, total_cards, archived)
      VALUES ('custom-precise', 'Custom precise', 'pokemon', 'Base', '2023-09-22', 1, false);
      INSERT INTO custom_sets (set_id, set_name, card_game, series, release_date, total_cards, archived)
      VALUES ('custom-no-date', 'Custom no date', 'pokemon', 'Base', NULL, 1, false);
      INSERT INTO tcgdex_sets (set_id, set_name, card_game, series, release_date, total_cards, archived)
      VALUES ('tcgdex-precise', 'TCGdex precise', 'pokemon', 'Base', '2023-09-22', 1, false);
    `);
    vi.resetModules();
    const { listSetLibrary, SetLibraryError, updateSetLibraryRecord } = await import("../server/services/set-library");
    const read = async (source: "custom" | "tcgdex", id: string) =>
      (await listSetLibrary({ pageSize: 100 })).sets.find((row) => row.source === source && row.setId === id)!;

    const custom = await read("custom", "custom-precise");
    await expect(
      updateSetLibraryRecord(
        "custom",
        "custom-precise",
        { setName: "Custom renamed", releaseYear: 2023, reason: "Correct name", version: custom.version },
        { id: "a", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.query("SELECT release_date::text AS release_date FROM custom_sets WHERE set_id = 'custom-precise'")
    ).resolves.toMatchObject({
      rows: [{ release_date: "2023-09-22" }],
    });

    const tcgdex = await read("tcgdex", "tcgdex-precise");
    await expect(
      updateSetLibraryRecord(
        "tcgdex",
        "tcgdex-precise",
        { setName: "TCGdex renamed", releaseYear: 2023, reason: "Correct name", version: tcgdex.version },
        { id: "a", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.query("SELECT release_date::text AS release_date FROM tcgdex_sets WHERE set_id = 'tcgdex-precise'")
    ).resolves.toMatchObject({
      rows: [{ release_date: "2023-09-22" }],
    });

    const changedYear = await read("tcgdex", "tcgdex-precise");
    await expect(
      updateSetLibraryRecord(
        "tcgdex",
        "tcgdex-precise",
        { series: "Revised", releaseYear: 2024, reason: "Correct year", version: changedYear.version },
        { id: "a", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.query("SELECT release_date::text AS release_date FROM tcgdex_sets WHERE set_id = 'tcgdex-precise'")
    ).resolves.toMatchObject({
      rows: [{ release_date: "2024-01-01" }],
    });
    await expect(
      updateSetLibraryRecord(
        "tcgdex",
        "tcgdex-precise",
        { setName: "Stale update", reason: "Stale version test", version: tcgdex.version },
        { id: "b", role: "admin" }
      )
    ).rejects.toBeInstanceOf(SetLibraryError);

    const omitted = await read("custom", "custom-precise");
    await expect(
      updateSetLibraryRecord(
        "custom",
        "custom-precise",
        { series: "Revised", reason: "Metadata correction", version: omitted.version },
        { id: "a", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.query("SELECT release_date::text AS release_date FROM custom_sets WHERE set_id = 'custom-precise'")
    ).resolves.toMatchObject({
      rows: [{ release_date: "2023-09-22" }],
    });

    const clear = await read("custom", "custom-precise");
    await expect(
      updateSetLibraryRecord(
        "custom",
        "custom-precise",
        { releaseYear: null, reason: "Remove unknown date", version: clear.version },
        { id: "a", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.query("SELECT release_date::text AS release_date FROM custom_sets WHERE set_id = 'custom-precise'")
    ).resolves.toMatchObject({
      rows: [{ release_date: null }],
    });

    const noDate = await read("custom", "custom-no-date");
    await expect(
      updateSetLibraryRecord(
        "custom",
        "custom-no-date",
        { setName: "Custom no date renamed", reason: "Correct name", version: noDate.version },
        { id: "a", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true });
    await expect(
      client.query("SELECT release_date::text AS release_date FROM custom_sets WHERE set_id = 'custom-no-date'")
    ).resolves.toMatchObject({
      rows: [{ release_date: null }],
    });
  });

  it("rejects a custom-set write when the row changes between its version check and SQL compare-and-swap", async () => {
    await client.query(`
      INSERT INTO custom_sets (set_id, set_name, card_game, series, release_date, total_cards, archived)
      VALUES ('custom-race', 'Custom race', 'pokemon', 'Base', '2023-09-22', 1, false);
    `);
    vi.resetModules();
    const { pool } = await import("../server/db");
    const { listSetLibrary, SetLibraryError, updateSetLibraryRecord } = await import("../server/services/set-library");
    let raced = false;
    const statements: string[] = [];
    pool.once("connect", (connection) => {
      const query = connection.query.bind(connection);
      vi.spyOn(connection, "query").mockImplementation(async (...args) => {
        const result = await query(...args);
        const statement = typeof args[0] === "string" ? args[0] : args[0]?.text || "";
        statements.push(statement);
        if (!raced && statement.includes("LIMIT 5001")) {
          raced = true;
          await query(
            "UPDATE custom_sets SET series = 'Concurrent change', updated_at = NOW() WHERE set_id = 'custom-race'"
          );
        }
        return result;
      });
    });

    const row = (await listSetLibrary({ pageSize: 100 })).sets.find(
      (candidate) => candidate.source === "custom" && candidate.setId === "custom-race"
    )!;
    await expect(
      updateSetLibraryRecord(
        "custom",
        "custom-race",
        { setName: "Should not save", reason: "Race test", version: row.version },
        { id: "a", role: "admin" }
      )
    ).rejects.toBeInstanceOf(SetLibraryError);
    expect(raced).toBe(true);
    expect(statements.find((statement) => statement.includes("UPDATE custom_sets"))).toContain(
      "updated_at IS NOT DISTINCT FROM"
    );
    await expect(
      client.query("SELECT set_name, series FROM custom_sets WHERE set_id = 'custom-race'")
    ).resolves.toMatchObject({
      rows: [{ set_name: "Custom race", series: "Base" }],
    });
    closePool = () => pool.end();
  });

  it("fails closed for missing TCGdex and review-decision schema without repairing or partially writing", async () => {
    await client.query("ALTER TABLE tcgdex_sets DROP COLUMN subset");
    vi.resetModules();
    const { listSetLibrary, recordSetReviewDecision, SetLibraryError } = await import("../server/services/set-library");

    await expect(listSetLibrary()).rejects.toMatchObject({
      status: 503,
      message: "Set library schema is unavailable. Apply database migrations.",
    });
    await expect(
      client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'tcgdex_sets' AND column_name = 'subset'"
      )
    ).resolves.toMatchObject({ rowCount: 0 });

    await client.query(await readFile("migrations/0023_set_library_schema.sql", "utf8"));
    await client.query("DROP TABLE set_review_decisions");
    const auditBefore = await client.query("SELECT COUNT(*)::int AS count FROM audit_log");
    await expect(
      recordSetReviewDecision("custom", "custom-live", "missing_year", "ignore", "Not applicable", {
        id: "admin@example.com",
        role: "admin",
      })
    ).rejects.toBeInstanceOf(SetLibraryError);
    await expect(
      client.query("SELECT to_regclass('public.set_review_decisions') AS table_name")
    ).resolves.toMatchObject({ rows: [{ table_name: null }] });
    await expect(client.query("SELECT COUNT(*)::int AS count FROM audit_log")).resolves.toMatchObject({
      rows: auditBefore.rows,
    });
    await client.query(await readFile("migrations/0023_set_library_schema.sql", "utf8"));
  });
});
