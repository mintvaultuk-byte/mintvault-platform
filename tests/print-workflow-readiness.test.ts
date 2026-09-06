/**
 * Print workflow readiness — disposable PostgreSQL mutation proof.
 *
 * This executes the exact predicate used by /ready and proves it fails closed
 * when critical lifecycle columns, generated identifiers/defaults, identity
 * constraints, or lookup indexes drift after migration 0022.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { COMPONENT_READINESS_REGISTRY } from "../server/lib/component-readiness-registry";
import { PRINT_WORKFLOW_READINESS_SQL, RELEASE_READINESS_SQL } from "../server/readiness";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const { Client } = pg;

const BASE_DDL = `
  CREATE TABLE certificates (
    id serial PRIMARY KEY,
    certificate_number text UNIQUE NOT NULL,
    grade_type text NOT NULL DEFAULT 'numeric',
    grade numeric(4,1),
    grade_approved_at timestamp,
    grader_status varchar(20) NOT NULL DEFAULT 'unassigned',
    deleted_at timestamptz,
    status varchar(10) NOT NULL DEFAULT 'active',
    ownership_status varchar(20) NOT NULL DEFAULT 'unclaimed',
    updated_at timestamp DEFAULT now(),
    claim_code text
  );
  CREATE TABLE label_prints (
    id serial PRIMARY KEY,
    cert_id text UNIQUE NOT NULL,
    sheet_ref text,
    queued_at timestamp NOT NULL DEFAULT now(),
    printed_at timestamp
  );
  CREATE TABLE label_overrides (
    id serial PRIMARY KEY,
    cert_id text UNIQUE NOT NULL,
    card_name_override text,
    set_override text,
    variant_override text,
    language_override text,
    year_override text,
    edited_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE reprint_log (
    id serial PRIMARY KEY,
    cert_id text NOT NULL,
    reprint_time timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE audit_log (
    id serial PRIMARY KEY,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    action text NOT NULL,
    admin_user text,
    details jsonb DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

function migration0022() {
  const migration = listMigrationFiles().find(({ filename }) => filename === "0022_print_workflow_lifecycle.sql");
  if (!migration) throw new Error("0022 print workflow migration not found");
  return migration;
}

describe("print workflow release readiness", () => {
  let cluster: DisposablePostgres17;
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    cluster = await startPostgres17("print-workflow-readiness");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
    await client.query(BASE_DDL);
    await applyMigrations(client, [migration0022()]);
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    await cluster?.stop();
  });

  async function ready(): Promise<boolean> {
    return (await client.query<{ ready: boolean }>(PRINT_WORKFLOW_READINESS_SQL)).rows[0].ready;
  }

  async function releaseReady(): Promise<{ ready: boolean; missing_relations: string[]; missing_migrations: string[] }> {
    return (
      await client.query(RELEASE_READINESS_SQL, [
        [
          "public.certificates",
          "public.print_batches",
          "public.print_events",
          "public.label_prints",
          "public.label_overrides",
          "public.reprint_log",
          "public.audit_log",
        ],
        ["0022_print_workflow_lifecycle.sql"],
        [],
        [],
        false,
      ])
    ).rows[0];
  }

  async function mutationFailsClosed(sql: string) {
    await client.query("BEGIN");
    try {
      await client.query(sql);
      expect(await ready()).toBe(false);
      expect(await releaseReady()).toMatchObject({ ready: false });
    } finally {
      await client.query("ROLLBACK");
    }
    expect(await ready()).toBe(true);
  }

  it("registers migration 0022 and every durable print relation as required release authority", () => {
    expect(COMPONENT_READINESS_REGISTRY.requiredMigrations).toContain("0022_print_workflow_lifecycle.sql");
    for (const relation of [
      "print_batches",
      "print_events",
      "label_prints",
      "label_overrides",
      "reprint_log",
      "audit_log",
    ]) {
      expect(COMPONENT_READINESS_REGISTRY.requiredRelations).toContain(`public.${relation}`);
    }
  });

  it("accepts the exact schema installed by migration 0022", async () => {
    expect(await ready()).toBe(true);
    expect(await releaseReady()).toMatchObject({ ready: true, missing_relations: [], missing_migrations: [] });
  });

  it("fails closed if a critical lifecycle column is renamed", async () => {
    await mutationFailsClosed("ALTER TABLE print_events RENAME COLUMN reason_category TO reason_category_removed");
  });

  it("fails closed if the batch id uniqueness guarantee is removed", async () => {
    await mutationFailsClosed("ALTER TABLE print_batches DROP CONSTRAINT print_batches_batch_id_key");
  });

  it("fails closed if either critical lookup index is removed", async () => {
    await mutationFailsClosed("DROP INDEX idx_certificates_print_state");
    await mutationFailsClosed("DROP INDEX idx_print_events_cert");
    await mutationFailsClosed("DROP INDEX idx_print_batches_status");
    await mutationFailsClosed("DROP INDEX idx_print_batches_created_at");
    await mutationFailsClosed("DROP INDEX idx_print_events_batch");
    await mutationFailsClosed("DROP INDEX idx_print_events_created_at");
  });

  it("fails closed if a required runtime relation or print-state default disappears", async () => {
    await mutationFailsClosed("DROP TABLE label_overrides");
    await mutationFailsClosed("ALTER TABLE certificates ALTER COLUMN print_state DROP DEFAULT");
  });

  it("fails closed if any generated identifier or omitted insert default drifts", async () => {
    for (const relation of [
      "print_batches",
      "print_events",
      "label_prints",
      "label_overrides",
      "reprint_log",
      "audit_log",
    ]) {
      await mutationFailsClosed(`ALTER TABLE ${relation} ALTER COLUMN id DROP DEFAULT`);
    }

    for (const [relation, column] of [
      ["print_batches", "kind"],
      ["print_batches", "status"],
      ["print_batches", "cert_ids"],
      ["print_batches", "cert_count"],
      ["print_batches", "success_count"],
      ["print_batches", "failure_count"],
      ["print_batches", "created_at"],
      ["print_events", "created_at"],
      ["label_prints", "queued_at"],
      ["label_overrides", "edited_at"],
      ["reprint_log", "reprint_time"],
      ["audit_log", "created_at"],
    ]) {
      await mutationFailsClosed(`ALTER TABLE ${relation} ALTER COLUMN ${column} DROP DEFAULT`);
    }
  });

  it("fails closed if an id sequence is detached, retargeted, or loses primary-key authority", async () => {
    await mutationFailsClosed("ALTER SEQUENCE audit_log_id_seq OWNED BY NONE");
    await mutationFailsClosed(`
      CREATE SCHEMA shadow_print_readiness;
      CREATE SEQUENCE shadow_print_readiness.audit_log_id_seq;
      ALTER TABLE audit_log ALTER COLUMN id
        SET DEFAULT nextval('shadow_print_readiness.audit_log_id_seq'::regclass)
    `);
    await mutationFailsClosed("ALTER TABLE audit_log DROP CONSTRAINT audit_log_pkey");
  });

  it("makes the release query report migration-journal and schema drift", async () => {
    await client.query("BEGIN");
    try {
      await client.query("UPDATE schema_migrations SET status='failed' WHERE filename='0022_print_workflow_lifecycle.sql'");
      const result = await releaseReady();
      expect(result.ready).toBe(false);
      expect(result.missing_migrations).toEqual(["0022_print_workflow_lifecycle.sql"]);
    } finally {
      await client.query("ROLLBACK");
    }

    await client.query("BEGIN");
    try {
      await client.query("ALTER TABLE label_prints RENAME COLUMN sheet_ref TO sheet_ref_removed");
      const result = await releaseReady();
      expect(result.ready).toBe(false);
      expect(result.missing_relations).toContain("public.label_prints");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
