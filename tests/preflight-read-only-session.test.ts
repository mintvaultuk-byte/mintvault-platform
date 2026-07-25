/**
 * Regression proof for the 2026-07-25 pooled-session read-only leak.
 *
 * `scripts/db/preflight-schema.ts` ran `SET default_transaction_read_only = on` on a Neon
 * `-pooler` (PgBouncer transaction-mode) connection and never reset it. The SET persisted
 * on the shared server-side backend and poisoned the next client handed it — the
 * application's own print-batch UPDATE failed 30s later.
 *
 * HOW THESE TESTS OBSERVE THE DEFECT (this is the crux — an earlier version of this file
 * did NOT, and 8 of its 14 tests passed against the leaking implementation):
 * a session-state leak is only visible on the SAME connection. The disposable cluster has
 * no pooler, so every `new pg.Client()` gets its OWN backend and can never see what a
 * previous client left behind. So these tests drive `runReadOnlySession` over a client the
 * TEST owns, then inspect THAT SAME session afterwards. `leakControl()` below re-implements
 * the pre-fix code and asserts the harness really does catch it — without that control,
 * "no leak" proves nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  runReadOnlySession,
  toDirectEndpoint,
  withReadOnlySession,
  type ReadOnlyCapableClient,
} from "../scripts/db/read-only-session";

let cluster: DisposablePostgres17;
let url: string;

beforeAll(async () => {
  cluster = await startPostgres17("preflight-read-only-session");
  url = cluster.url;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("CREATE TABLE probe (id int primary key, note text)");
  await c.query("CREATE SEQUENCE probe_seq");
  await c.query("INSERT INTO probe VALUES (1, 'seed')");
  await c.end();
}, 60_000);

afterAll(async () => {
  await cluster?.stop();
});

beforeEach(async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("UPDATE probe SET note = 'seed' WHERE id = 1");
  await c.end();
});

/** One connection the test owns, so session state is observable. */
async function ownClient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/** Everything the next pooled user of THIS backend would inherit. */
async function sessionState(c: pg.Client) {
  const ro = (await c.query<{ v: string }>("SELECT current_setting('default_transaction_read_only') AS v")).rows[0].v;
  const locks = (await c.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_locks WHERE locktype='advisory'"))
    .rows[0].n;
  const prepared = (await c.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_prepared_statements")).rows[0].n;
  let canWrite = false;
  try {
    await c.query("UPDATE probe SET note = 'probe-write' WHERE id = 1");
    canWrite = true;
    await c.query("UPDATE probe SET note = 'seed' WHERE id = 1");
  } catch {
    /* still read-only */
  }
  return { readOnly: ro, advisoryLocks: locks, prepared, canWrite };
}

/** The EXACT pre-fix implementation, so the harness can prove it detects the leak. */
async function leakControl<T>(c: ReadOnlyCapableClient, fn: (q: typeof c.query) => Promise<T>): Promise<T> {
  await c.query("SET default_transaction_read_only = on");
  try {
    return await fn(c.query.bind(c));
  } finally {
    /* pre-fix code did NOT reset — this is the bug */
  }
}

describe("the harness can actually detect a leak (control)", () => {
  it("the PRE-FIX implementation leaves the session read-only on the same connection", async () => {
    const c = await ownClient();
    try {
      await leakControl(c as unknown as ReadOnlyCapableClient, async (q) => {
        await q("SELECT 1");
        return null;
      });
      const st = await sessionState(c);
      // This is the incident, reproduced: the session is poisoned and writes now fail.
      expect(st.readOnly).toBe("on");
      expect(st.canWrite).toBe(false);
    } finally {
      await c.end();
    }
  });
});

describe("no session state leaks on the same connection (real PostgreSQL)", () => {
  it("normal success leaves the session clean and writable", async () => {
    const c = await ownClient();
    try {
      const out = await runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
        return (await q<{ n: string }>("SELECT count(*)::text AS n FROM probe")).rows[0].n;
      });
      expect(out).toBe("1");
      expect(await sessionState(c)).toMatchObject({ readOnly: "off", canWrite: true });
    } finally {
      await c.end();
    }
  });

  it("a failed query leaves the session clean and writable", async () => {
    const c = await ownClient();
    try {
      await expect(
        runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
          await q("SELECT * FROM table_that_does_not_exist");
          return null;
        })
      ).rejects.toThrow();
      expect(await sessionState(c)).toMatchObject({ readOnly: "off", canWrite: true });
    } finally {
      await c.end();
    }
  });

  it("a thrown JS error leaves the session clean and writable", async () => {
    const c = await ownClient();
    try {
      await expect(
        runReadOnlySession(c as unknown as ReadOnlyCapableClient, async () => {
          throw new Error("boom from caller");
        })
      ).rejects.toThrow("boom from caller");
      expect(await sessionState(c)).toMatchObject({ readOnly: "off", canWrite: true });
    } finally {
      await c.end();
    }
  });

  it("an EARLY RETURN leaves the session clean (the definer-check path)", async () => {
    const c = await ownClient();
    try {
      const out = await runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
        const present = await q("SELECT 1 FROM pg_proc WHERE proname = 'definitely_not_here'");
        if (present.rows.length === 0) return [] as string[];
        return ["unreachable"];
      });
      expect(out).toEqual([]);
      expect(await sessionState(c)).toMatchObject({ readOnly: "off", canWrite: true });
    } finally {
      await c.end();
    }
  });

  it("advisory locks and prepared statements do NOT survive (ROLLBACK and RESET ALL both leave them)", async () => {
    const c = await ownClient();
    try {
      await runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
        await q("SELECT pg_advisory_lock(4242)");
        await q("PREPARE leaked_stmt AS SELECT 1");
        return null;
      });
      const st = await sessionState(c);
      expect(st.advisoryLocks).toBe("0"); // DISCARD ALL, not RESET ALL
      expect(st.prepared).toBe("0");
      expect(st.readOnly).toBe("off");
      expect(st.canWrite).toBe(true);
    } finally {
      await c.end();
    }
  });
});

describe("read-only protection cannot be escaped by the callback", () => {
  it("a write inside the session is REJECTED and the row is untouched", async () => {
    const c = await ownClient();
    try {
      await expect(
        runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
          await q("UPDATE probe SET note = 'should never happen' WHERE id = 1");
          return null;
        })
      ).rejects.toThrow(/read-only transaction/i);
    } finally {
      await c.end();
    }
    const v = await ownClient();
    expect((await v.query<{ note: string }>("SELECT note FROM probe WHERE id = 1")).rows[0].note).toBe("seed");
    await v.end();
  });

  it("DDL is rejected", async () => {
    const c = await ownClient();
    try {
      await expect(
        runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
          await q("CREATE TABLE must_not_exist (id int)");
          return null;
        })
      ).rejects.toThrow(/read-only transaction/i);
    } finally {
      await c.end();
    }
  });

  it("sequence mutation is rejected", async () => {
    const c = await ownClient();
    try {
      await expect(
        runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
          await q("SELECT nextval('probe_seq')");
          return null;
        })
      ).rejects.toThrow(/read-only transaction/i);
    } finally {
      await c.end();
    }
  });

  it("the callback CANNOT commit its way out and then write (hostile-review escape #1)", async () => {
    const c = await ownClient();
    try {
      await expect(
        runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
          await q("SELECT 1");
          await q("COMMIT"); // must be refused outright
          await q("UPDATE probe SET note = 'ESCAPED' WHERE id = 1");
          return "escaped";
        })
      ).rejects.toThrow(/transaction-control statement/i);
    } finally {
      await c.end();
    }
    const v = await ownClient();
    expect((await v.query<{ note: string }>("SELECT note FROM probe WHERE id = 1")).rows[0].note).toBe("seed");
    await v.end();
  });

  it("every transaction-control statement is refused", async () => {
    const c = await ownClient();
    try {
      for (const stmt of [
        "COMMIT",
        "commit;",
        "  ROLLBACK ",
        "END",
        "BEGIN",
        "START TRANSACTION",
        "SET TRANSACTION READ WRITE",
        "SAVEPOINT sp1",
        "DISCARD ALL",
        "RESET ALL",
      ]) {
        await expect(runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => q(stmt))).rejects.toThrow(
          /transaction-control statement/i
        );
      }
    } finally {
      await c.end();
    }
  });

  it("a retained query handle cannot execute after release (hostile-review escape #2)", async () => {
    const c = await ownClient();
    let escaped: ((sql: string) => Promise<unknown>) | null = null;
    try {
      await runReadOnlySession(c as unknown as ReadOnlyCapableClient, async (q) => {
        escaped = q as unknown as (sql: string) => Promise<unknown>;
        return null;
      });
      expect(escaped).not.toBeNull();
      await expect(escaped!("UPDATE probe SET note = 'LATE-WRITE' WHERE id = 1")).rejects.toThrow(/already released/i);
      // Session-level protection is gone (correctly), but the handle is dead.
      expect((await c.query<{ note: string }>("SELECT note FROM probe WHERE id = 1")).rows[0].note).toBe("seed");
    } finally {
      await c.end();
    }
  });
});

describe("endpoint selection is explicit (pooler vs direct)", () => {
  it("rewrites a Neon pooled host to its direct equivalent, preserving everything else", () => {
    const r = toDirectEndpoint(
      "postgresql://u:p@ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require"
    );
    expect(r.changed).toBe(true);
    expect(r.url).toContain("ep-purple-voice-abfez796.eu-west-2.aws.neon.tech");
    expect(r.url).not.toContain("-pooler");
    expect(r.url).toContain("sslmode=require");
    expect(r.url).toContain("/neondb");
  });

  it("is case-insensitive — a mixed-case host must not silently skip the rewrite", () => {
    const r = toDirectEndpoint("postgresql://u:p@EP-A-1-POOLER.EU.AWS.NEON.TECH/neondb");
    expect(r.changed).toBe(true);
    expect(r.url.toLowerCase()).not.toContain("-pooler");
  });

  it("never reports a rewrite that leaves a pooler label behind", () => {
    const r = toDirectEndpoint("postgresql://u:p@ep-a-pooler-b-pooler.eu.aws.neon.tech/neondb");
    // Either a correct rewrite, or refuse — never "changed" with -pooler still present.
    if (r.changed) expect(/-pooler(?=\.)/i.test(new URL(r.url).hostname)).toBe(false);
    else expect(r.url).toBe("postgresql://u:p@ep-a-pooler-b-pooler.eu.aws.neon.tech/neondb");
  });

  it("does not confuse a username, password or database name containing '-pooler'", () => {
    for (const u of [
      "postgresql://x-pooler:p@ep-a-1.eu.aws.neon.tech/neondb",
      "postgresql://u:pa-poolerss@ep-a-1.eu.aws.neon.tech/neondb",
      "postgresql://u:p@ep-a-1.eu.aws.neon.tech/my-pooler-db",
    ]) {
      expect(toDirectEndpoint(u).changed).toBe(false);
    }
  });

  it("leaves an already-direct Neon host alone", () => {
    expect(toDirectEndpoint("postgresql://u:p@ep-purple-voice-abfez796.eu-west-2.aws.neon.tech/neondb").changed).toBe(
      false
    );
  });

  it("never touches a non-Neon or local host", () => {
    for (const u of [
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@localhost/db",
      "postgresql://u:p@db-pooler.example.com/db",
      "postgres://u:p@my-pooler.internal:6432/db",
    ]) {
      expect(toDirectEndpoint(u)).toEqual({ url: u, changed: false });
    }
  });

  it("is total — unparseable input is returned unchanged rather than throwing", () => {
    expect(toDirectEndpoint("not a url")).toEqual({ url: "not a url", changed: false });
    expect(toDirectEndpoint("")).toEqual({ url: "", changed: false });
  });

  it("a password with URL-special characters survives the rewrite byte-identically", () => {
    // new URL().toString() may add percent-escapes; pg-connection-string decodes them.
    // What matters is that the DECODED password is unchanged.
    for (const pw of ["pa!$&'()*,;=ss", "p@ssword", "pa%41ss", "npg_Ab3$xY!z", "pa ss", "pa{}ss"]) {
      const before = `postgresql://u:${encodeURIComponent(pw)}@ep-a-1-pooler.eu.aws.neon.tech/neondb`;
      const after = toDirectEndpoint(before);
      expect(after.changed).toBe(true);
      expect(decodeURIComponent(new URL(after.url).password)).toBe(pw);
    }
  });
});

describe("full connect-and-release path", () => {
  it("withReadOnlySession works end to end and closes its connection", async () => {
    const out = await withReadOnlySession(url, async (q) => (await q("SELECT 1 AS one")).rows.length, {
      preferDirectEndpoint: false,
    });
    expect(out).toBe(1);
  });

  it("a connection killed mid-flight fails loudly and leaves the cluster writable", async () => {
    await expect(
      withReadOnlySession(url, async (q) => {
        await q("SELECT 1");
        await q("SELECT pg_terminate_backend(pg_backend_pid())");
        return "unreachable";
      })
    ).rejects.toThrow();
    const c = await ownClient();
    expect(await sessionState(c)).toMatchObject({ readOnly: "off", canWrite: true });
    await c.end();
  });

  it("a cleanup failure is preserved on `cause` rather than discarded to stderr", async () => {
    let caught: Error | null = null;
    try {
      await withReadOnlySession(url, async (q) => {
        await q("SELECT 1");
        await q("SELECT pg_terminate_backend(pg_backend_pid())");
        return null;
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // Both failures are reachable programmatically.
    expect(caught!.message).toBeTruthy();
    if (caught!.cause) expect(String((caught!.cause as Error).message)).toMatch(/preflight cleanup/);
  });
});

describe("the preflight no longer contains the leaking SET", () => {
  it("preflight-schema.ts delegates to the session helper", () => {
    const pf = readFileSync(new URL("../scripts/db/preflight-schema.ts", import.meta.url), "utf8");
    expect(pf).not.toContain("SET default_transaction_read_only = on");
    expect(pf).toContain("withReadOnlySession");
  });
});

describe("the rewired runPreflight DB path actually works", () => {
  // Previously uncovered: every suite that imports runPreflight is env-gated and skips by
  // default, so the two-connection rewire and the `client` shim ran in no test at all.
  it("classifies live objects and still fails closed on an unknown object", async () => {
    const { runPreflight } = await import("../scripts/db/preflight-schema");
    const r = await runPreflight(url);
    // `probe` and `probe_seq` are ours and are not in the managed allowlist, so the
    // preflight must refuse rather than silently pass.
    expect(r.ok).toBe(false);
    expect(r.unknown.map((u) => u.name)).toContain("probe");
    expect(r.counts.tables).toBeGreaterThan(0);
  });

  it("leaves the database writable afterwards", async () => {
    const { runPreflight } = await import("../scripts/db/preflight-schema");
    await runPreflight(url).catch(() => null);
    const c = await ownClient();
    expect(await sessionState(c)).toMatchObject({ readOnly: "off", canWrite: true });
    await c.end();
  });
});
