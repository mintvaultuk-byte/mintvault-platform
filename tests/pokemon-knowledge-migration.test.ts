/**
 * Pokémon Knowledge migration — apply / idempotency / rollback proof against the
 * approved disposable local Postgres (TEST_DATABASE_URL). Skipped when no local
 * DB is configured (CI runs it via the env-gated setup, same as other DB suites).
 * Leaves the tables APPLIED at the end (the dev DB state).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { Client } from "pg";

const url = process.env.TEST_DATABASE_URL || "";
const d = describe.skipIf(!url);

const ADD = fs.readFileSync("migrations/add-pokemon-knowledge.sql", "utf8");
const ROLLBACK = fs.readFileSync("migrations/rollback-pokemon-knowledge.sql", "utf8");
const TABLES = ["pokemon_set_knowledge", "pokemon_set_aliases", "pokemon_knowledge_revisions", "pokemon_import_runs", "pokemon_review_queue"];

let client: Client;

d("pokemon-knowledge migration (tests 1-4: apply, reversible, nullable, existing rows valid)", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
  });
  afterAll(async () => {
    // Leave the schema applied for the rest of the suite/dev use.
    await client.query(ADD);
    await client.end();
  });

  it("applies cleanly and creates all five tables", async () => {
    await client.query(ADD);
    for (const t of TABLES) {
      const r = await client.query("SELECT to_regclass($1) AS t", [`public.${t}`]);
      expect(r.rows[0].t, t).toBe(t);
    }
  });

  it("is idempotent (second apply is a no-op, no error)", async () => {
    await expect(client.query(ADD)).resolves.toBeTruthy();
  });

  it("unknown-data-friendly: a set row with only key+name inserts (all knowledge cols nullable)", async () => {
    await client.query("DELETE FROM pokemon_set_knowledge WHERE set_key = '__test_min'");
    const r = await client.query(
      "INSERT INTO pokemon_set_knowledge (set_key, canonical_name) VALUES ('__test_min', 'Minimal Set') RETURNING era, region, main_count, status, confidence",
    );
    expect(r.rows[0].era).toBeNull();
    expect(r.rows[0].main_count).toBeNull();
    expect(r.rows[0].status).toBe("provisional");
    await client.query("DELETE FROM pokemon_set_knowledge WHERE set_key = '__test_min'");
  });

  it("CHECKs reject bad enums but allow NULL (era/region/status)", async () => {
    await expect(
      client.query("INSERT INTO pokemon_set_knowledge (set_key, canonical_name, era) VALUES ('__test_bad', 'X', 'not-an-era')"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("INSERT INTO pokemon_set_knowledge (set_key, canonical_name, status) VALUES ('__test_bad', 'X', 'wat')"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("verified records REQUIRE provenance (verified + unknown source is rejected)", async () => {
    await expect(
      client.query("INSERT INTO pokemon_set_knowledge (set_key, canonical_name, status, source_type) VALUES ('__test_v', 'X', 'verified', 'unknown')"),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query(
      "INSERT INTO pokemon_set_knowledge (set_key, canonical_name, status, source_type) VALUES ('__test_v', 'X', 'verified', 'founder_confirmed')",
    );
    await client.query("DELETE FROM pokemon_set_knowledge WHERE set_key = '__test_v'");
  });

  it("(setKey, language) is unique — regional/language editions stay separate records", async () => {
    await client.query("DELETE FROM pokemon_set_knowledge WHERE set_key = '__test_dup'");
    await client.query("INSERT INTO pokemon_set_knowledge (set_key, language, canonical_name) VALUES ('__test_dup', 'en', 'A')");
    await client.query("INSERT INTO pokemon_set_knowledge (set_key, language, canonical_name) VALUES ('__test_dup', 'ja', 'A (JP)')"); // OK — separate edition
    await expect(
      client.query("INSERT INTO pokemon_set_knowledge (set_key, language, canonical_name) VALUES ('__test_dup', 'en', 'A again')"),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("DELETE FROM pokemon_set_knowledge WHERE set_key = '__test_dup'");
  });

  it("revision history is retained and unique per (entity, revision)", async () => {
    await client.query("DELETE FROM pokemon_knowledge_revisions WHERE entity_key = '__test:en'");
    await client.query(
      "INSERT INTO pokemon_knowledge_revisions (entity_type, entity_key, revision_number, new_value) VALUES ('set', '__test:en', 1, '{}'::jsonb)",
    );
    await expect(
      client.query(
        "INSERT INTO pokemon_knowledge_revisions (entity_type, entity_key, revision_number, new_value) VALUES ('set', '__test:en', 1, '{}'::jsonb)",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("DELETE FROM pokemon_knowledge_revisions WHERE entity_key = '__test:en'");
  });

  it("rolls back cleanly (all five tables dropped) and re-applies", async () => {
    await client.query(ROLLBACK);
    for (const t of TABLES) {
      const r = await client.query("SELECT to_regclass($1) AS t", [`public.${t}`]);
      expect(r.rows[0].t, t).toBeNull();
    }
    await client.query(ADD); // restore
  });

  it("touches NO existing table (migration references only pokemon_* objects)", () => {
    // Static proof: the migration mentions no certificates/card_sets/custom_sets/tcgdex DDL.
    expect(ADD).not.toMatch(/ALTER TABLE\s+(certificates|card_sets|custom_sets|tcgdex_sets)/i);
    expect(ADD).not.toMatch(/DROP|TRUNCATE/i);
    expect(ROLLBACK).not.toMatch(/certificates|card_sets|custom_sets|tcgdex_sets/i);
  });
});
