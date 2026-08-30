import { afterAll, beforeAll, describe, expect, it } from "vitest";
import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import pg from "pg";
import { readFileSync } from "node:fs";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { SESSION_STORE_READINESS_SQL } from "../server/readiness";

const FILENAME = "0119_session_store_authority.sql";
const AUTH_ROUTES_SOURCE = readFileSync(new URL("../server/routes/auth.ts", import.meta.url), "utf8");

let cluster: DisposablePostgres17;
let pool: pg.Pool;
let store: session.Store;

function migration() {
  const found = listMigrationFiles().find((candidate) => candidate.filename === FILENAME);
  if (!found) throw new Error(`${FILENAME} was not discovered by the production migration runner`);
  return found;
}

function setSession(sid: string, value: session.SessionData): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    store.set(sid, value, (error) => (error ? reject(error) : resolve()));
  });
}

function getSession(sid: string): Promise<session.SessionData | null> {
  return new Promise<session.SessionData | null>((resolve, reject) => {
    store.get(sid, (error, value) => (error ? reject(error) : resolve(value ?? null)));
  });
}

describe("0119 canonical session-store authority", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("session-store-authority");
    pool = new pg.Pool({ connectionString: cluster.url, max: 4 });
    await pool.query(`CREATE ROLE mintvault_app NOLOGIN`);
    const PgStore = connectPgSimple(session);
    store = new PgStore({ pool, createTableIfMissing: false, pruneSessionInterval: false });
  }, 60_000);

  afterAll(async () => {
    await (store as session.Store & { close: () => Promise<void> })?.close();
    await pool?.end().catch(() => {});
    await cluster?.stop();
  });

  it("fails before migration instead of creating schema at runtime", async () => {
    await expect(
      setSession("pre-migration", {
        cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000) },
        userId: "pre-migration-user",
      } as session.SessionData)
    ).rejects.toMatchObject({ code: "42P01" });
    expect((await pool.query(`SELECT to_regclass('public.session') AS relation`)).rows[0].relation).toBeNull();
  });

  it("applies through the production runner and persists a real session", async () => {
    await applyMigrations(pool, [migration()]);
    expect((await pool.query(`SELECT status FROM schema_migrations WHERE filename=$1`, [FILENAME])).rows[0]).toEqual({
      status: "applied",
    });

    const expires = new Date(Date.now() + 60_000);
    await setSession("persisted-session", {
      cookie: { originalMaxAge: 60_000, expires, httpOnly: true, sameSite: "lax" },
      userId: "customer-123",
      credentialVersion: 7,
    } as session.SessionData);
    const loaded = await getSession("persisted-session");
    expect(loaded).toMatchObject({ userId: "customer-123", credentialVersion: 7 });
    expect(loaded?.cookie.httpOnly).toBe(true);

    const contract = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name,data_type,is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='session'
        ORDER BY ordinal_position`
    );
    expect(contract.rows).toEqual([
      { column_name: "sid", data_type: "character varying", is_nullable: "NO" },
      { column_name: "sess", data_type: "json", is_nullable: "NO" },
      { column_name: "expire", data_type: "timestamp without time zone", is_nullable: "NO" },
    ]);
    expect(
      (
        await pool.query<{ definition: string }>(
          `SELECT pg_get_indexdef(indexrelid) AS definition
             FROM pg_index
            WHERE indrelid='public.session'::regclass
              AND indexrelid='public."IDX_session_expire"'::regclass`
        )
      ).rows[0].definition
    ).toMatch(/USING btree \(expire\)/);
    expect(
      (
        await pool.query<{ public_access: boolean }>(
          `SELECT has_table_privilege('public', 'public.session', 'SELECT,INSERT,UPDATE,DELETE') AS public_access`
        )
      ).rows[0].public_access
    ).toBe(false);

    expect((await pool.query<{ ready: boolean }>(SESSION_STORE_READINESS_SQL)).rows[0].ready).toBe(true);
  });

  it("revokes every session with DML-only runtime privileges and commits its audit atomically", async () => {
    const handler = AUTH_ROUTES_SOURCE.slice(
      AUTH_ROUTES_SOURCE.indexOf('app.post("/api/auth/logout-everywhere"'),
      AUTH_ROUTES_SOURCE.indexOf("// GET /api/customer/me")
    );
    expect(handler).toContain("db.transaction");
    expect(handler).toContain("DELETE FROM public.session RETURNING sid");
    expect(handler).toContain("INSERT INTO public.audit_log");
    expect(handler).not.toMatch(/\bTRUNCATE\b/);

    await pool.query(`
      CREATE TABLE public.audit_log (
        id bigserial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        admin_user text,
        details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      GRANT INSERT ON public.audit_log TO mintvault_app;
      GRANT USAGE, SELECT ON SEQUENCE public.audit_log_id_seq TO mintvault_app
    `);
    await setSession("runtime-delete-1", {
      cookie: { originalMaxAge: 60_000, expires: new Date(Date.now() + 60_000) },
      userId: "runtime-delete-user",
    } as session.SessionData);

    expect(
      (
        await pool.query<{ allowed: boolean }>(
          `SELECT has_table_privilege('mintvault_app', 'public.session', 'TRUNCATE') AS allowed`
        )
      ).rows[0].allowed
    ).toBe(false);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE mintvault_app");
      const removed = await client.query(`DELETE FROM public.session RETURNING sid`);
      await client.query(
        `INSERT INTO public.audit_log (entity_type,entity_id,action,admin_user,details)
         VALUES ('session','all','logout_everywhere','admin',jsonb_build_object('destroyed',$1::int))`,
        [removed.rowCount]
      );
      await client.query("COMMIT");
      expect(removed.rowCount).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM public.session`)).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT details FROM public.audit_log`)).rows).toEqual([
      { details: { destroyed: expect.any(Number) } },
    ]);
  });

  it("makes readiness fail closed when the session schema or expiry index drifts", async () => {
    await pool.query(`DROP INDEX public."IDX_session_expire"`);
    expect((await pool.query<{ ready: boolean }>(SESSION_STORE_READINESS_SQL)).rows[0].ready).toBe(false);
    await pool.query(`CREATE INDEX "IDX_session_expire" ON public.session (expire)`);
    expect((await pool.query<{ ready: boolean }>(SESSION_STORE_READINESS_SQL)).rows[0].ready).toBe(true);

    await pool.query(`ALTER TABLE public.session ADD COLUMN drifted text`);
    expect((await pool.query<{ ready: boolean }>(SESSION_STORE_READINESS_SQL)).rows[0].ready).toBe(false);
    await pool.query(`ALTER TABLE public.session DROP COLUMN drifted`);
    expect((await pool.query<{ ready: boolean }>(SESSION_STORE_READINESS_SQL)).rows[0].ready).toBe(true);
  });
});
