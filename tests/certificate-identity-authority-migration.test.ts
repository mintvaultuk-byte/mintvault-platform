/**
 * 0114 certificate identity authority — real PostgreSQL proof.
 *
 * The migration is exercised through the shipped migration runner against a
 * disposable PostgreSQL 17.10 cluster. No configured MintVault database is read
 * or written.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const FILENAME = "0114_certificate_identity_authority.sql";

let cluster: DisposablePostgres17;
let client: Client;

function migration() {
  const found = listMigrationFiles().find((candidate) => candidate.filename === FILENAME);
  if (!found) throw new Error(`${FILENAME} was not discovered by the production migration runner`);
  return found;
}

describe("0114 certificate identity authority", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("certificate-identity-authority");
    client = new Client({ connectionString: cluster.url });
    await client.connect();
    await client.query(`
      CREATE TABLE certificates (
        id serial PRIMARY KEY,
        certificate_number text NOT NULL UNIQUE,
        status text NOT NULL DEFAULT 'active'
      )`);
    await client.query(`
      INSERT INTO certificates (certificate_number)
      VALUES ('MV-0000000042'), ('MV104'), ('legacy-external-id')`);
    await applyMigrations(client, [migration()]);
  }, 60_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    await cluster?.stop();
  });

  it("preserves issued identities and seeds the allocator above the greatest numeric MV identity", async () => {
    expect(
      (await client.query("SELECT certificate_number FROM certificates ORDER BY id")).rows.map(
        (row) => row.certificate_number
      )
    ).toEqual(["MV-0000000042", "MV104", "legacy-external-id"]);
    expect((await client.query("SELECT id, last_issued::text FROM cert_counter")).rows).toEqual([
      { id: 1, last_issued: "104" },
    ]);
    expect((await client.query("SELECT status FROM schema_migrations WHERE filename=$1", [FILENAME])).rows[0]).toEqual({
      status: "applied",
    });
  });

  it("permits allocation and unrelated certificate edits", async () => {
    expect(
      (await client.query("UPDATE cert_counter SET last_issued=last_issued+1 WHERE id=1 RETURNING last_issued::text"))
        .rows[0].last_issued
    ).toBe("105");
    await expect(
      client.query("UPDATE certificates SET status='voided' WHERE certificate_number='MV104'")
    ).resolves.toBeTruthy();
  });

  it("rejects every route that could reuse or rewrite a permanent identity", async () => {
    await expect(client.query("UPDATE cert_counter SET last_issued=1 WHERE id=1")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(client.query("DELETE FROM cert_counter WHERE id=1")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("TRUNCATE cert_counter")).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("INSERT INTO cert_counter (id,last_issued) VALUES (2,999)")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      client.query("UPDATE certificates SET certificate_number='MV999' WHERE certificate_number='MV104'")
    ).rejects.toMatchObject({ code: "23514" });

    expect((await client.query("SELECT last_issued::text FROM cert_counter WHERE id=1")).rows[0].last_issued).toBe(
      "105"
    );
    expect(
      (await client.query("SELECT certificate_number FROM certificates ORDER BY id")).rows.map(
        (row) => row.certificate_number
      )
    ).toEqual(["MV-0000000042", "MV104", "legacy-external-id"]);
  });

  it("installs ALWAYS triggers so replication-role bypass cannot mutate identity", async () => {
    await client.query("SET session_replication_role = replica");
    try {
      await expect(
        client.query("UPDATE certificates SET certificate_number='MV777' WHERE certificate_number='MV104'")
      ).rejects.toMatchObject({ code: "23514" });
      await expect(client.query("UPDATE cert_counter SET last_issued=2 WHERE id=1")).rejects.toMatchObject({
        code: "23514",
      });
    } finally {
      await client.query("SET session_replication_role = origin");
    }
  });
});
