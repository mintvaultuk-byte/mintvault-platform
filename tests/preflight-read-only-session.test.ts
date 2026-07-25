/**
 * Regression proof for the 2026-07-25 pooled-session read-only leak.
 *
 * `scripts/db/preflight-schema.ts` ran `SET default_transaction_read_only = on` on a
 * Neon `-pooler` (PgBouncer transaction-mode) connection and never reset it. The SET
 * persisted on the shared server-side backend and poisoned the next client to be handed
 * it — the application's own print-batch UPDATE failed 30s after a preflight with
 * `cannot execute UPDATE in a read-only transaction`.
 *
 * These tests run against a disposable real PostgreSQL 17 cluster, because the whole
 * defect is about what a *server session* retains after the client is done with it.
 * A mocked client could not observe it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { toDirectEndpoint, withReadOnlySession } from "../scripts/db/read-only-session";

let cluster: DisposablePostgres17;
let url: string;

beforeAll(async () => {
  cluster = await startPostgres17("preflight-read-only-session");
  url = cluster.url;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("CREATE TABLE probe (id int primary key, note text)");
  await c.query("INSERT INTO probe VALUES (1, 'seed')");
  await c.end();
}, 60_000);

afterAll(async () => {
  await cluster?.stop();
});

/** Read the session default the way the incident was diagnosed. */
async function sessionReadOnly(): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<{ v: string }>("SELECT current_setting('default_transaction_read_only') AS v")).rows[0].v;
  } finally {
    await c.end();
  }
}

/** Can a brand-new client still write? This is what actually broke on staging. */
async function writeStillWorks(): Promise<boolean> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("UPDATE probe SET note = 'written' WHERE id = 1");
    await c.query("ROLLBACK");
    return true;
  } catch {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* already aborted */
    }
    return false;
  } finally {
    await c.end();
  }
}

describe("endpoint selection is explicit (pooler vs direct)", () => {
  it("rewrites a Neon pooled host to its direct equivalent", () => {
    const r = toDirectEndpoint("postgresql://u:p@ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require");
    expect(r.changed).toBe(true);
    expect(r.url).toContain("ep-purple-voice-abfez796.eu-west-2.aws.neon.tech");
    expect(r.url).not.toContain("-pooler");
    // Credentials and the rest of the URL are preserved untouched.
    expect(r.url).toContain("sslmode=require");
    expect(r.url).toContain("/neondb");
  });

  it("leaves an already-direct Neon host alone", () => {
    const r = toDirectEndpoint("postgresql://u:p@ep-purple-voice-abfez796.eu-west-2.aws.neon.tech/neondb");
    expect(r.changed).toBe(false);
  });

  it("never touches a non-Neon or local host (the -pooler convention is Neon's)", () => {
    for (const u of [
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@localhost/db",
      "postgresql://u:p@db-pooler.example.com/db",
      "postgres://u:p@my-pooler.internal:6432/db",
    ]) {
      expect(toDirectEndpoint(u)).toEqual({ url: u, changed: false });
    }
  });

  it("is total — an unparseable value is returned unchanged rather than throwing", () => {
    expect(toDirectEndpoint("not a url")).toEqual({ url: "not a url", changed: false });
    expect(toDirectEndpoint("")).toEqual({ url: "", changed: false });
  });
});

describe("no session-level read-only setting leaks (real PostgreSQL)", () => {
  it("normal success leaves the session clean and later writes unaffected", async () => {
    const out = await withReadOnlySession(url, async (q) => {
      const r = await q<{ n: string }>("SELECT count(*)::text AS n FROM probe");
      return r.rows[0].n;
    });
    expect(out).toBe("1");
    expect(await sessionReadOnly()).toBe("off");
    expect(await writeStillWorks()).toBe(true);
  });

  it("a thrown query still leaves the session clean", async () => {
    await expect(
      withReadOnlySession(url, async (q) => {
        await q("SELECT * FROM table_that_does_not_exist");
        return "unreachable";
      }),
    ).rejects.toThrow();
    expect(await sessionReadOnly()).toBe("off");
    expect(await writeStillWorks()).toBe(true);
  });

  it("a thrown JS error (not a query error) still leaves the session clean", async () => {
    await expect(
      withReadOnlySession(url, async () => {
        throw new Error("boom from caller");
      }),
    ).rejects.toThrow("boom from caller");
    expect(await sessionReadOnly()).toBe("off");
    expect(await writeStillWorks()).toBe(true);
  });

  it("an EARLY RETURN still leaves the session clean (the definer-check path)", async () => {
    // fetchDefinerViolations returns early when the partner functions are absent; the
    // pre-fix code put cleanup in a finally on the caller, which this shape must match.
    const out = await withReadOnlySession(url, async (q) => {
      const present = await q("SELECT 1 FROM pg_proc WHERE proname = 'definitely_not_here'");
      if (present.rows.length === 0) return [] as string[];
      return ["unreachable"];
    });
    expect(out).toEqual([]);
    expect(await sessionReadOnly()).toBe("off");
    expect(await writeStillWorks()).toBe(true);
  });

  it("the pooled path is equally clean (preferDirectEndpoint disabled)", async () => {
    const out = await withReadOnlySession(url, async (q) => (await q("SELECT 1 AS one")).rows.length, {
      preferDirectEndpoint: false,
    });
    expect(out).toBe(1);
    expect(await sessionReadOnly()).toBe("off");
    expect(await writeStillWorks()).toBe(true);
  });
});

describe("read-only protection is not weakened", () => {
  it("a write attempted inside the session is REJECTED by the transaction", async () => {
    await expect(
      withReadOnlySession(url, async (q) => {
        await q("UPDATE probe SET note = 'should never happen' WHERE id = 1");
        return "wrote";
      }),
    ).rejects.toThrow(/read-only transaction/i);
    // And the row is untouched.
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const r = await c.query<{ note: string }>("SELECT note FROM probe WHERE id = 1");
    await c.end();
    expect(r.rows[0].note).toBe("seed");
  });

  it("DDL is rejected too", async () => {
    await expect(
      withReadOnlySession(url, async (q) => {
        await q("CREATE TABLE must_not_exist (id int)");
        return "created";
      }),
    ).rejects.toThrow(/read-only transaction/i);
  });
});

describe("fail closed", () => {
  it("a connection killed mid-flight fails loudly and leaves the cluster writable", async () => {
    // Genuine failure injection: kill this session's own backend from inside the
    // callback, so the work statement AND every cleanup statement fail on a dead
    // socket. The helper must reject — never resolve — and must not leave anything
    // behind that could affect another client.
    await expect(
      withReadOnlySession(url, async (q) => {
        await q("SELECT 1");
        await q("SELECT pg_terminate_backend(pg_backend_pid())");
        return "unreachable";
      }),
    ).rejects.toThrow();
    // The point of the whole fix: everyone else is unaffected.
    expect(await sessionReadOnly()).toBe("off");
    expect(await writeStillWorks()).toBe(true);
  });

  it("the helper never returns a value when cleanup verification fails", async () => {
    // Contract assertion: cleanupError alone is thrown (see read-only-session.ts).
    const src = (await import("node:fs")).readFileSync(
      new URL("../scripts/db/read-only-session.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("if (cleanupError) throw cleanupError;");
    expect(src).toContain("await client.end();");
    // And the leaking session-level SET must be gone from the preflight entirely.
    const pf = (await import("node:fs")).readFileSync(
      new URL("../scripts/db/preflight-schema.ts", import.meta.url),
      "utf8",
    );
    expect(pf).not.toContain('SET default_transaction_read_only = on');
    expect(pf).toContain("withReadOnlySession");
  });
});

describe("the preflight itself still cannot mutate application data", () => {
  it("uses a READ ONLY transaction rather than a session-level default", async () => {
    const src = (await import("node:fs")).readFileSync(
      new URL("../scripts/db/read-only-session.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("BEGIN TRANSACTION READ ONLY");
    expect(src).toContain('await client.query("ROLLBACK")');
    // No COMMIT anywhere — a read-only transaction has nothing to commit.
    expect(src).not.toContain('query("COMMIT")');
  });
});
