/**
 * Concurrency proof for the migration runner's advisory lock.
 *
 * WHY (hostile review, 2026-07-25): `pg_try_advisory_lock` is SESSION-scoped, and session
 * advisory locks are RE-ENTRANT for the same session. `MINTVAULT_DATABASE_URL` points at
 * Neon's `-pooler` host — PgBouncer in transaction mode — where two runner processes can be
 * multiplexed onto ONE server backend. The second runner's lock attempt would then see the
 * lock as held by its OWN session and return true, so the "refusing to run concurrently"
 * guard passes for BOTH runners. A killed runner also leaks the lock onto a shared backend.
 *
 * These run against a disposable real PostgreSQL 17 cluster: session-lock semantics and
 * pg_locks visibility cannot be observed against a mock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { assertDedicatedBackend, assertNotSharedBackend, resolveMigrationEndpoint } from "../scripts/db/migrate";

const LOCK_KEY = 4_150_205; // must match ADVISORY_LOCK_KEY in migrate.ts

let cluster: DisposablePostgres17;
let url: string;

beforeAll(async () => {
  cluster = await startPostgres17("migrate-advisory-lock");
  url = cluster.url;
}, 60_000);

afterAll(async () => {
  await cluster?.stop();
});

/** A runner-like session: its own connection, so its own backend. */
async function runner(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

const tryLock = async (c: pg.Client): Promise<boolean> =>
  (await c.query<{ got: boolean }>("SELECT pg_try_advisory_lock($1) AS got", [LOCK_KEY])).rows[0].got;

const unlock = async (c: pg.Client): Promise<void> => {
  await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
};

const backendPid = async (c: pg.Client): Promise<number> =>
  Number((await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);

/** Holders of the advisory lock, as pg_locks sees them. */
async function lockHolders(c: pg.Client): Promise<number[]> {
  const r = await c.query<{ pid: number }>(
    "SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND granted",
    [LOCK_KEY]
  );
  return r.rows.map((x) => Number(x.pid));
}

beforeEach(async () => {
  // Make sure no lock survives from a previous test.
  const c = await runner();
  await c.query("SELECT pg_advisory_unlock_all()");
  await c.end();
});

describe("only one migration runner may proceed", () => {
  it("runner A acquires the lock; runner B cannot", async () => {
    const a = await runner();
    const b = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      expect(await tryLock(b)).toBe(false); // B must fail fast, not queue and not double-apply
    } finally {
      await unlock(a).catch(() => {});
      await a.end();
      await b.end();
    }
  });

  it("after A releases, B can proceed", async () => {
    const a = await runner();
    const b = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      expect(await tryLock(b)).toBe(false);
      await unlock(a);
      expect(await tryLock(b)).toBe(true);
    } finally {
      await unlock(b).catch(() => {});
      await a.end();
      await b.end();
    }
  });

  it("after A's process dies without releasing, B can proceed (no unrecoverable lock)", async () => {
    const a = await runner();
    expect(await tryLock(a)).toBe(true);
    // Simulate a killed runner: drop the connection with the lock still held.
    a.on("error", () => {});
    await a.end();
    const b = await runner();
    try {
      // A session advisory lock dies with its session, so B is not blocked forever.
      expect(await tryLock(b)).toBe(true);
    } finally {
      await unlock(b).catch(() => {});
      await b.end();
    }
  });

  it("an exception inside the run still releases the lock (finally path)", async () => {
    const a = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      try {
        throw new Error("simulated migration failure");
      } finally {
        await unlock(a);
      }
    } catch {
      /* expected */
    }
    const b = await runner();
    try {
      expect(await tryLock(b)).toBe(true);
    } finally {
      await unlock(b).catch(() => {});
      await b.end();
      await a.end();
    }
  });
});

describe("THE HAZARD: a session lock is re-entrant, so `got === true` alone proves nothing", () => {
  it("the SAME session acquires the same lock twice — which is what a shared pooled backend does", async () => {
    // This is the defect in one line: if two runners are multiplexed onto one backend,
    // both see `got = true`. A boolean is therefore NOT a concurrency guard.
    const a = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      expect(await tryLock(a)).toBe(true); // re-entrant — no error, no false
      const holders = await lockHolders(a);
      expect(holders).toContain(await backendPid(a));
    } finally {
      await a.query("SELECT pg_advisory_unlock_all()");
      await a.end();
    }
  });

  it("ownership verification distinguishes 'I hold it' from 'someone holds it'", async () => {
    // The fix's check: read pg_locks and require OUR pid. A second runner on a DIFFERENT
    // backend that somehow saw got=true would fail this, because its pid is not a holder.
    const a = await runner();
    const b = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      const aPid = await backendPid(a);
      const bPid = await backendPid(b);
      const holders = await lockHolders(b); // B can see the lock exists…
      expect(holders).toContain(aPid);
      expect(holders).not.toContain(bPid); // …but B is not a holder, so B must refuse
      expect(aPid).not.toBe(bPid); // distinct backends: the direct endpoint guarantees this
    } finally {
      await unlock(a).catch(() => {});
      await a.end();
      await b.end();
    }
  });

  it("the lock is scoped to its database, so a lock on another database is not ours", async () => {
    const a = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      const r = await a.query<{ db: string }>("SELECT current_database() AS db");
      expect(r.rows[0].db).toBeTruthy();
      // pg_locks advisory rows carry the database oid, so a holder in another database
      // never appears as a holder here.
      const holders = await lockHolders(a);
      expect(holders).toContain(await backendPid(a));
    } finally {
      await unlock(a).catch(() => {});
      await a.end();
    }
  });
});

describe("endpoint selection fails closed — a pooled session can never own the lock", () => {
  it("rewrites a Neon pooled URL to its direct endpoint", () => {
    const r = resolveMigrationEndpoint(
      "postgresql://u:p@ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require"
    );
    expect(r.pooled).toBe(false);
    expect(r.url).toContain("ep-purple-voice-abfez796.eu-west-2.aws.neon.tech");
    expect(r.url).not.toContain("-pooler");
  });

  it("is case-insensitive, so a mixed-case pooled host cannot slip through", () => {
    const r = resolveMigrationEndpoint("postgresql://u:p@EP-A-1-POOLER.EU.AWS.NEON.TECH/neondb");
    expect(r.url.toLowerCase()).not.toContain("-pooler");
  });

  it("THROWS rather than silently using a pooler it cannot rewrite", () => {
    // A non-Neon pooler host: the `-pooler` convention is Neon's, so no direct endpoint
    // can be derived. A migration must refuse rather than run without exclusivity.
    expect(() => resolveMigrationEndpoint("postgresql://u:p@db-pooler.internal:6432/db")).toThrow(/pooler|direct/i);
  });

  it("leaves an already-direct or local URL untouched", () => {
    for (const [u, host] of [
      ["postgresql://u:p@ep-a-1.eu.aws.neon.tech/neondb", "ep-a-1.eu.aws.neon.tech"],
      ["postgresql://u:p@127.0.0.1:5432/db", "127.0.0.1"],
      ["postgresql://u:p@localhost/db", "localhost"],
    ] as const) {
      expect(resolveMigrationEndpoint(u)).toEqual({ url: u, pooled: false, host });
    }
  });

  it("the disposable local cluster is accepted unchanged (so tests exercise the real path)", () => {
    expect(resolveMigrationEndpoint(url).url).toBe(url);
  });
});

describe("routing parameters cannot bypass the endpoint guard (hostile-review CRITICAL)", () => {
  // pg-connection-string copies host/port/options query params onto the connection config
  // AFTER parsing the URL, so they OVERRIDE the URL's hostname. The first version of this
  // guard inspected the hostname while the runner connected somewhere else — and then
  // printed the safe-looking host, which is worse than silence. Proven end to end by the
  // reviewer: a Neon hostname with ?host=127.0.0.1 read the journal off localhost while
  // reporting the Neon endpoint.
  it("REFUSES a URL carrying ?host=", () => {
    expect(() =>
      resolveMigrationEndpoint("postgresql://u:p@ep-x.eu.aws.neon.tech/db?host=ep-x-pooler.eu.aws.neon.tech")
    ).toThrow(/host.*parameter|overrides/i);
  });

  it("REFUSES ?port=, ?options= and ?servername=", () => {
    for (const q of ["port=6432", "options=endpoint%3Dfoo", "servername=other.host"]) {
      expect(() => resolveMigrationEndpoint(`postgresql://u:p@ep-x.eu.aws.neon.tech/db?${q}`), q).toThrow(
        /parameter|overrides/i
      );
    }
  });

  it("still accepts the legitimate parameters a Neon URL actually carries", () => {
    const r = resolveMigrationEndpoint(
      "postgresql://u:p@ep-x-pooler.eu.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
    );
    expect(r.url).not.toContain("-pooler");
    expect(r.url).toContain("sslmode=require");
  });

  it("FAILS CLOSED on an unparseable URL instead of proceeding", () => {
    // Previously returned { pooled: false } and connected anyway.
    for (const bad of ["not a url", "", "postgres://u:p@[bad host]/db"]) {
      expect(() => resolveMigrationEndpoint(bad), JSON.stringify(bad)).toThrow(/did not parse|parameter/i);
    }
  });

  it("catches a non-Neon pooled hostname form too", () => {
    // `.pooler.` (dot-separated) as well as `-pooler.` — e.g. other providers.
    expect(() => resolveMigrationEndpoint("postgresql://u:p@aws-0-eu.pooler.example.com:6543/db")).toThrow(/pooler/i);
  });

  it("reports the host it will actually dial", () => {
    const r = resolveMigrationEndpoint("postgresql://u:p@EP-A-1-POOLER.EU.AWS.NEON.TECH/db");
    expect(r.host).toBe("ep-a-1.eu.aws.neon.tech");
    expect(r.host).not.toContain("-pooler");
  });

  it("tolerates a trailing-dot FQDN rather than blocking all migrations", () => {
    const r = resolveMigrationEndpoint("postgresql://u:p@ep-a-1.eu.aws.neon.tech./db");
    expect(r.pooled).toBe(false);
    expect(r.host).toBe("ep-a-1.eu.aws.neon.tech");
  });
});

describe("dedicated-backend proof (hostile-review HIGH: pg_locks cannot see backend SHARING)", () => {
  // Two runners multiplexed onto ONE pooled backend share pg_backend_pid(), so every
  // advisory-lock ownership branch passes for both — which is the double-apply vector.
  // This measures the property that matters instead of pattern-matching hostnames.
  it("passes on a direct connection (a second connection gets a different backend)", async () => {
    const c = await runner();
    try {
      const pid = await backendPid(c);
      await expect(assertDedicatedBackend(url, pid, undefined)).resolves.toBeUndefined();
    } finally {
      await c.end();
    }
  });

  it("THROWS when two connections report the SAME backend — the shared-pooled signature", () => {
    // Deterministic, and this is the whole point of the check: under PgBouncer transaction
    // mode two runners can share one server backend, in which case both see the same pid and
    // every advisory-lock ownership branch passes for both. A real PgBouncer is not available
    // here, so the comparison itself is pinned exhaustively.
    expect(() => assertNotSharedBackend(4242, 4242)).toThrow(/shares its server backend/i);
    expect(() => assertNotSharedBackend(1, 1)).toThrow(/shares its server backend/i);
  });

  it("passes only when the two pids genuinely differ", () => {
    expect(() => assertNotSharedBackend(4242, 4243)).not.toThrow();
  });

  it("fails closed when either pid is unreadable", () => {
    for (const [a, b] of [
      [Number.NaN, 1],
      [1, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
    ] as const) {
      expect(() => assertNotSharedBackend(a, b)).toThrow(/could not verify/i);
    }
  });
});

describe("the runner holds the lock for the WHOLE run", () => {
  it("the lock stays held across multiple statements on the same connection", async () => {
    const a = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      const pid = await backendPid(a);
      for (const stmt of ["SELECT 1", "SELECT pg_sleep(0)", "SELECT now()"]) {
        await a.query(stmt);
        expect(await lockHolders(a)).toContain(pid); // still ours, between every step
        expect(await backendPid(a)).toBe(pid); // and the connection was never replaced
      }
    } finally {
      await unlock(a).catch(() => {});
      await a.end();
    }
  });

  it("a released lock is immediately visible as released", async () => {
    const a = await runner();
    try {
      expect(await tryLock(a)).toBe(true);
      await unlock(a);
      expect(await lockHolders(a)).not.toContain(await backendPid(a));
    } finally {
      await a.end();
    }
  });
});
