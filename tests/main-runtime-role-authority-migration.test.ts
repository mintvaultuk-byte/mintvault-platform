import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg, { Client } from "pg";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as vqSchema from "../shared/vq-schema";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { managedTables, UNMANAGED_INVENTORY } from "../scripts/db/schema-registry";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const FILENAME = "0121_main_runtime_role_authority.sql";
const SOURCE = readFileSync(join(process.cwd(), "migrations", FILENAME), "utf8");
const POST_0121_AUTHORITY_RELATIONS = new Set(["object_write_operations", "object_write_items"]);

function migration() {
  const found = listMigrationFiles().find((candidate) => candidate.filename === FILENAME);
  if (!found) throw new Error(`${FILENAME} was not discovered by the production migration runner`);
  return found;
}

function authorityClass(name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = SOURCE.match(new RegExp(`${escaped} constant text\\[\\] := ARRAY\\[([\\s\\S]*?)\\n  \\];`))?.[1];
  if (!body) throw new Error(`missing ${name} authority class`);
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
}

const CLASS_NAMES = [
  "read_only_relations",
  "append_only_tables",
  "mutable_tables",
  "deletable_tables",
  "protected_inactive_relations",
  "denied_partner_relations",
] as const;

const classes = Object.fromEntries(CLASS_NAMES.map((name) => [name, authorityClass(name)])) as Record<
  (typeof CLASS_NAMES)[number],
  string[]
>;
const granted = [
  ...classes.read_only_relations,
  ...classes.append_only_tables,
  ...classes.mutable_tables,
  ...classes.deletable_tables,
];
const classified = CLASS_NAMES.flatMap((name) => classes[name]);

let cluster: DisposablePostgres17;
let admin: Client;

function databaseUrl(database: string, role = "postgres", password?: string): string {
  const url = new URL(cluster.url);
  url.pathname = `/${database}`;
  url.username = role;
  url.password = password ?? "";
  return url.toString();
}

async function createDatabase(name: string): Promise<void> {
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
}

async function provisionAuthorityFixture(database: string): Promise<Client> {
  await createDatabase(database);
  const client = new Client({ connectionString: databaseUrl(database) });
  await client.connect();
  await client.query(`
    CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE TABLE audit_log (id bigserial PRIMARY KEY, action text NOT NULL);
    CREATE TABLE certificates (id bigserial PRIMARY KEY, status text NOT NULL);
    CREATE TABLE session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL);
    CREATE TABLE partner_applications (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE partner_organisations (id uuid PRIMARY KEY, status text NOT NULL);
    CREATE TABLE partner_rate_limit_buckets (bucket_key text PRIMARY KEY, hit_count integer, reset_at timestamptz);
    CREATE TABLE field_welders (id bigint PRIMARY KEY);
    CREATE TABLE vq_cards (id bigserial PRIMARY KEY, status text NOT NULL);
  `);
  await applyMigrations(client, [migration()]);
  await client.query(`
    CREATE ROLE mintvault_runtime_test LOGIN PASSWORD 'synthetic-runtime' INHERIT
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    GRANT mintvault_app TO mintvault_runtime_test;
    CREATE ROLE partner_runtime_test LOGIN PASSWORD 'synthetic-partner' INHERIT
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
    GRANT partner_runtime TO partner_runtime_test;
  `);
  return client;
}

beforeAll(async () => {
  cluster = await startPostgres17("main-runtime-role-authority");
  admin = new Client({ connectionString: cluster.url });
  await admin.connect();
}, 60_000);

afterAll(async () => {
  await admin?.end().catch(() => {});
  await cluster?.stop();
});

describe("0121 main runtime role authority", () => {
  it("classifies every current main, Vault Quest, legacy, and Partner relation exactly once", () => {
    expect(new Set(classified).size).toBe(classified.length);

    const expectedMain = managedTables().filter(
      (name) => !name.startsWith("partner_") || name === "partner_applications"
    );
    for (const name of expectedMain) expect(classified, `main relation ${name}`).toContain(name);
    for (const entry of UNMANAGED_INVENTORY.filter((candidate) => candidate.schema === "public")) {
      if (POST_0121_AUTHORITY_RELATIONS.has(entry.name)) continue;
      expect(classified, `registry relation ${entry.name}`).toContain(entry.name);
    }

    const expectedVq = Object.values(vqSchema)
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableName(table))
      .sort();
    expect(classified.filter((name) => name.startsWith("vq_")).sort()).toEqual(expectedVq);

    const sourceCreatedTables = new Set<string>();
    for (const directory of ["migrations", "migrations-vq"]) {
      for (const filename of readdirSync(join(process.cwd(), directory))) {
        if (!filename.endsWith(".sql") || filename.startsWith("rollback") || filename.includes("_rollback")) continue;
        const sql = readFileSync(join(process.cwd(), directory, filename), "utf8");
        for (const match of sql.matchAll(
          /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi
        )) {
          sourceCreatedTables.add(match[1]);
        }
      }
    }
    for (const name of sourceCreatedTables) {
      if (POST_0121_AUTHORITY_RELATIONS.has(name)) continue;
      expect(classified, `migration relation ${name}`).toContain(name);
    }

    expect(granted.filter((name) => name.startsWith("partner_"))).toEqual(["partner_applications"]);
    expect(classes.denied_partner_relations).toContain("field_welders");
  });

  it("gives an unprivileged inheriting LOGIN exact main DML and zero operational Partner authority", async () => {
    const owner = await provisionAuthorityFixture("runtime_authority_positive");
    const runtime = new Client({
      connectionString: databaseUrl("runtime_authority_positive", "mintvault_runtime_test", "synthetic-runtime"),
    });
    const partner = new Client({
      connectionString: databaseUrl("runtime_authority_positive", "partner_runtime_test", "synthetic-partner"),
    });
    await runtime.connect();
    await partner.connect();
    try {
      const identity = (
        await runtime.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolinherit: boolean;
          member: boolean;
        }>(`
          SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
                 pg_has_role(current_user, 'mintvault_app', 'member') AS member
            FROM pg_roles r WHERE r.rolname=current_user
        `)
      ).rows[0];
      expect(identity).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: true,
        member: true,
      });
      expect(
        (await runtime.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0]
      ).toEqual({ allowed: false });
      await expect(runtime.query("CREATE TABLE forbidden_runtime_ddl(id integer)")).rejects.toMatchObject({
        code: "42501",
      });

      await runtime.query("INSERT INTO audit_log(action) VALUES ('created')");
      await expect(runtime.query("UPDATE audit_log SET action='rewritten'")).rejects.toMatchObject({ code: "42501" });
      await expect(runtime.query("DELETE FROM audit_log")).rejects.toMatchObject({ code: "42501" });

      await runtime.query("INSERT INTO certificates(status) VALUES ('active')");
      await runtime.query("UPDATE certificates SET status='voided'");
      await expect(runtime.query("DELETE FROM certificates")).rejects.toMatchObject({ code: "42501" });

      await runtime.query("INSERT INTO session(sid,sess,expire) VALUES ('s','{}',now())");
      await runtime.query("DELETE FROM session WHERE sid='s'");
      await runtime.query("INSERT INTO public_rate_limit_buckets(bucket_key,hit_count,reset_at) VALUES ('k',1,now())");
      await runtime.query("UPDATE public_rate_limit_buckets SET hit_count=2 WHERE bucket_key='k'");
      await runtime.query("DELETE FROM public_rate_limit_buckets WHERE bucket_key='k'");

      await runtime.query(
        "INSERT INTO partner_applications(id,status) VALUES ('00000000-0000-4000-8000-000000000001','NEW')"
      );
      await runtime.query(
        "UPDATE partner_applications SET status='CONTACTED' WHERE id='00000000-0000-4000-8000-000000000001'"
      );
      await expect(runtime.query("DELETE FROM partner_applications")).rejects.toMatchObject({ code: "42501" });

      for (const relation of ["partner_organisations", "partner_rate_limit_buckets", "field_welders"]) {
        const privileges = await runtime.query<{ allowed: boolean }>(
          "SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE') AS allowed",
          [`public.${relation}`]
        );
        expect(privileges.rows[0].allowed, relation).toBe(false);
        await expect(runtime.query(`SELECT 1 FROM ${relation} LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
      }

      expect(
        (
          await partner.query(
            "SELECT has_table_privilege(current_user,'public.public_rate_limit_buckets','SELECT') AS allowed"
          )
        ).rows[0]
      ).toEqual({ allowed: false });
      await expect(partner.query("SELECT * FROM public_rate_limit_buckets")).rejects.toMatchObject({ code: "42501" });

      expect(
        (
          await owner.query<{ count: number }>(`
            SELECT count(*)::int AS count
              FROM pg_class c
              JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public'
               AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='mintvault_runtime_test')
          `)
        ).rows[0].count
      ).toBe(0);
    } finally {
      await Promise.all([runtime.end(), partner.end()]);
      await owner.end();
    }
  }, 60_000);

  it("fails atomically when a public relation is not explicitly classified", async () => {
    await createDatabase("runtime_authority_unknown");
    const client = new Client({ connectionString: databaseUrl("runtime_authority_unknown") });
    await client.connect();
    try {
      await client.query("CREATE TABLE surprise_runtime_table(id integer PRIMARY KEY)");
      await expect(applyMigrations(client, [migration()])).rejects.toThrow(
        /unclassified public relation.*surprise_runtime_table/
      );
      expect(
        (await client.query("SELECT to_regclass('public.public_rate_limit_buckets') AS relation")).rows[0]
      ).toEqual({
        relation: null,
      });
      expect(
        (await client.query("SELECT status FROM schema_migrations WHERE filename=$1", [FILENAME])).rows
      ).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
