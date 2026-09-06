/**
 * 0115 runtime-schema convergence — real PostgreSQL proof.
 *
 * A deliberately sparse legacy estate is upgraded through the shipped numbered
 * migration runner. No configured MintVault database is read or written.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const FILENAME = "0115_runtime_schema_convergence.sql";

let cluster: DisposablePostgres17;
let client: Client;

function migration() {
  const found = listMigrationFiles().find((candidate) => candidate.filename === FILENAME);
  if (!found) throw new Error(`${FILENAME} was not discovered by the production migration runner`);
  return found;
}

async function createLegacyEstate(): Promise<void> {
  await client.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      email text NOT NULL,
      role text,
      deleted_at timestamp,
      updated_at timestamp DEFAULT now()
    );
    CREATE TABLE submissions (
      id serial PRIMARY KEY,
      service_tier text,
      status text,
      deleted_at timestamp
    );
    CREATE TABLE cards (
      id serial PRIMARY KEY,
      submission_id integer REFERENCES submissions(id)
    );
    CREATE TABLE certificates (
      id serial PRIMARY KEY,
      certificate_number text NOT NULL UNIQUE,
      card_id integer REFERENCES cards(id),
      grade_approved_at timestamp,
      deleted_at timestamp,
      status text NOT NULL DEFAULT 'active',
      issued_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp DEFAULT now()
    );
    CREATE TABLE service_tiers (
      id serial PRIMARY KEY,
      service_type text NOT NULL,
      tier_id text NOT NULL UNIQUE,
      name text NOT NULL,
      price_per_card integer NOT NULL,
      turnaround_days integer,
      turnaround_label text,
      max_value_gbp integer,
      is_active boolean NOT NULL DEFAULT true,
      sort_order integer,
      updated_at timestamp DEFAULT now()
    );
    CREATE TABLE transfer_verifications (id serial PRIMARY KEY);
    CREATE TABLE ownership_history (id serial PRIMARY KEY);
    CREATE TABLE submission_items (id serial PRIMARY KEY);
    CREATE TABLE audit_log (
      id serial PRIMARY KEY,
      entity_type text,
      entity_id text,
      action text,
      admin_user text,
      details jsonb,
      created_at timestamp DEFAULT now()
    );
    CREATE TABLE estimate_credits (
      id serial PRIMARY KEY,
      email text NOT NULL UNIQUE,
      credits_remaining integer NOT NULL DEFAULT 0,
      credits_purchased integer NOT NULL DEFAULT 0,
      credits_used integer NOT NULL DEFAULT 0,
      created_at timestamp DEFAULT now(),
      updated_at timestamp DEFAULT now()
    );

    INSERT INTO users (id,email,role) VALUES
      ('admin','mintvaultuk@gmail.com','customer'),
      ('grader','grader@example.test','grader');
    INSERT INTO submissions (service_tier,status) VALUES ('standard','received');
    INSERT INTO cards (submission_id) VALUES (1);
    INSERT INTO certificates (certificate_number,card_id,grade_approved_at) VALUES
      ('MV1',1,now()),
      ('MV2',1,NULL);
    INSERT INTO estimate_credits (email,credits_remaining,credits_purchased,credits_used)
    VALUES ('mintvaultuk@gmail.com',999999,999999,0);
  `);
}

describe("0115 runtime schema convergence", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("runtime-schema-convergence");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
    await createLegacyEstate();
    await applyMigrations(client, [migration()]);
  }, 60_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    await cluster?.stop();
  });

  it("journals one atomic numbered migration and creates every former boot-owned relation", async () => {
    expect((await client.query("SELECT status FROM schema_migrations WHERE filename=$1", [FILENAME])).rows[0]).toEqual({
      status: "applied",
    });
    const required = [
      "member_credits",
      "estimate_credits",
      "estimate_credit_reservations",
      "grading_sessions",
      "ai_accuracy_log",
      "contact_inquiries",
      "stolen_reports",
      "marketplace_listings",
      "promotions",
      "stripe_webhook_events",
    ];
    for (const relation of required) {
      expect((await client.query("SELECT to_regclass($1) AS relation", [`public.${relation}`])).rows[0].relation).toBe(
        relation
      );
    }
  });

  it("installs archive, manual-centering, grading and staff columns before application traffic", async () => {
    const result = await client.query<{ table_name: string; column_name: string }>(`
      SELECT table_name,column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND (table_name,column_name) IN (
        ('certificates','archived_to_b2_at'),
        ('certificates','centering_outer_front'),
        ('certificates','centering_inner_back'),
        ('certificates','assigned_grader_id'),
        ('certificates','operator_subgrades'),
        ('submissions','scan_assigned_to'),
        ('users','can_grade'),
        ('users','pin_hash')
      )`);
    expect(result.rows.map((row) => `${row.table_name}.${row.column_name}`).sort()).toEqual(
      [
        "certificates.archived_to_b2_at",
        "certificates.assigned_grader_id",
        "certificates.centering_inner_back",
        "certificates.centering_outer_front",
        "certificates.operator_subgrades",
        "submissions.scan_assigned_to",
        "users.can_grade",
        "users.pin_hash",
      ].sort()
    );
    expect((await client.query("SELECT can_grade FROM users WHERE id='grader'")).rows[0].can_grade).toBe(true);
    expect((await client.query("SELECT grading_status FROM submissions WHERE id=1")).rows[0].grading_status).toBe(
      "approved"
    );
  });

  it("moves the full reference-number backfill into migration authority with the locked format", async () => {
    const refs = (await client.query("SELECT reference_number FROM certificates ORDER BY id")).rows.map(
      (row) => row.reference_number as string
    );
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
    for (const reference of refs) expect(reference).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });

  it("preserves the existing commercial seed values and installs idempotency gates", async () => {
    expect(
      (await client.query("SELECT tier_id,price_per_card,is_active FROM service_tiers ORDER BY tier_id")).rows
    ).toEqual(
      expect.arrayContaining([
        { tier_id: "standard", price_per_card: 1900, is_active: true },
        { tier_id: "priority", price_per_card: 2500, is_active: true },
        { tier_id: "gold", price_per_card: 7500, is_active: false },
      ])
    );
    expect(
      (await client.query("SELECT count(*)::int AS count FROM estimate_credits WHERE credits_remaining >= 999999"))
        .rows[0].count
    ).toBe(0);
    expect(
      (
        await client.query(
          "SELECT credits_remaining,credits_purchased,credits_used FROM estimate_credits WHERE email=$1",
          ["mintvaultuk@gmail.com"]
        )
      ).rows[0]
    ).toEqual({ credits_remaining: 0, credits_purchased: 0, credits_used: 0 });
    expect(
      (await client.query("SELECT to_regclass('public.uq_member_credits_used_for_submission') AS i")).rows[0].i
    ).toBe("uq_member_credits_used_for_submission");
  });

  it("is SQL-object idempotent when replayed independently of the journal", async () => {
    await expect(client.query(migration().sql)).resolves.toBeTruthy();
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM audit_log WHERE entity_id='0115_runtime_schema_convergence'"
        )
      ).rows[0].count
    ).toBe(1);
    expect(
      (await client.query("SELECT count(*)::int AS count FROM certificates WHERE reference_number IS NULL")).rows[0]
        .count
    ).toBe(0);
  });
});
