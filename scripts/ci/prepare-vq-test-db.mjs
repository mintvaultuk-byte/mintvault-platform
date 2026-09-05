#!/usr/bin/env node
// Fresh, disposable CI fixture only. No production runner bootstrap escape hatch.
import pg from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  applyMigrations,
  assertDedicatedBackend,
  listMigrationFiles,
  migrationClientConfig,
  migrationProfile,
  resolveMigrationEndpoint,
} from "../db/migrate.ts";
import { assertDisposable } from "./partner-suite-env-matrix.mjs";

export async function prepareVqTestDatabase(url) {
  assertDisposable(url, "Vault Quest CI fixture");
  const parsed = new URL(url);
  if (parsed.pathname !== "/mintvault_vq_phase10_local" || parsed.search || parsed.hash) {
    throw new Error("Vault Quest CI fixture requires the exact disposable database with no URL overrides.");
  }
  const endpoint = resolveMigrationEndpoint(url);
  const client = new pg.Client(migrationClientConfig(endpoint.url));
  await client.connect();
  try {
    const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await assertDedicatedBackend(endpoint.url, pid);
    const main = listMigrationFiles(migrationProfile().migrationsDir).filter(
      (file) => file.filename === "0121_main_runtime_role_authority.sql"
    );
    if (main.length !== 1) throw new Error("Missing immutable main runtime fixture authority.");
    // This database is already a current-shape Drizzle fixture, not a historical
    // main lineage. Journal only the SQL actually executed here. No old rows.
    const exists = (await client.query("SELECT to_regclass('public.schema_migrations') AS journal")).rows[0].journal;
    if (exists) {
      const rows = (await client.query("SELECT filename, checksum, status, completed_at FROM public.schema_migrations"))
        .rows;
      if (
        rows.length !== 1 ||
        rows[0].filename !== main[0].filename ||
        rows[0].checksum !== main[0].checksum ||
        rows[0].status !== "applied" ||
        rows[0].completed_at == null
      ) {
        throw new Error("Vault Quest CI fixture refuses another or invalid main migration lineage.");
      }
    }
    await applyMigrations(client, main);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required for the disposable VQ fixture.");
  await prepareVqTestDatabase(url);
}
