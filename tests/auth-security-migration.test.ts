import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

function assertLocalTestDb(url: string): void {
  if (!url) throw new Error("TEST_DATABASE_URL is required for auth security migration tests");
  const parsed = new URL(url);
  const ok =
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === "55432" &&
    parsed.pathname.includes("mintvault_vq_phase10_local");
  if (!ok) {
    throw new Error(
      `REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${parsed.hostname}:${parsed.port}${parsed.pathname}`
    );
  }
}

function migrationStatements(): string[] {
  const raw = fs.readFileSync(path.resolve(process.cwd(), "migrations/add-auth-security-hardening-phase1.sql"), "utf8");
  return raw
    .split(";")
    .map((stmt) => stmt.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

describe("auth security hardening migration", () => {
  let pool: Pool;
  const schema = `auth_security_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    assertLocalTestDb(TEST_URL);
    pool = new Pool({ connectionString: TEST_URL, ssl: false, max: 2 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(`
      CREATE TABLE users (
        id text PRIMARY KEY,
        email text NOT NULL,
        password_hash text,
        pin_hash text
      )
    `);
    await pool.query(`
      CREATE TABLE certificates (
        id serial PRIMARY KEY,
        cert_number text
      )
    `);
    await pool.query(`
      INSERT INTO users (id, email, password_hash, pin_hash)
      VALUES ('staff-1', 'staff@example.com', '$2b$12$staffhash', '$2b$12$pinhash')
    `);
    await pool.query(`INSERT INTO certificates (cert_number) VALUES ('MV1')`);
    for (const stmt of migrationStatements()) {
      await pool.query(`SET search_path TO ${schema}`);
      await pool.query(stmt);
    }
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });

  it("adds only the expected auth security columns to existing users", async () => {
    const columns = await pool.query(
      `
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'users'
      ORDER BY ordinal_position
    `,
      [schema]
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "email",
      "password_hash",
      "pin_hash",
      "admin_passphrase_hash",
      "credential_version",
      "last_failed_login_at",
    ]);
    expect(columns.rows.find((row) => row.column_name === "credential_version")).toMatchObject({
      column_default: "1",
      is_nullable: "NO",
    });
  });

  it("preserves existing staff password hashes and admin PIN hashes", async () => {
    const row = await pool.query(
      `SELECT password_hash, pin_hash, credential_version FROM ${schema}.users WHERE id = $1`,
      ["staff-1"]
    );
    expect(row.rows[0]).toMatchObject({
      password_hash: "$2b$12$staffhash",
      pin_hash: "$2b$12$pinhash",
      credential_version: 1,
    });
  });

  it("can be re-run without changing rows", async () => {
    for (const stmt of migrationStatements()) {
      await pool.query(`SET search_path TO ${schema}`);
      await pool.query(stmt);
    }
    const row = await pool.query(
      `SELECT password_hash, pin_hash, credential_version FROM ${schema}.users WHERE id = $1`,
      ["staff-1"]
    );
    expect(row.rows[0]).toMatchObject({
      password_hash: "$2b$12$staffhash",
      pin_hash: "$2b$12$pinhash",
      credential_version: 1,
    });
  });

  it("does not change grading tables", async () => {
    const cert = await pool.query(`SELECT COUNT(*)::int AS n FROM ${schema}.certificates`);
    expect(cert.rows[0].n).toBe(1);
  });
});
