/**
 * Lock-safety regression cover for the numbered migration runner.
 *
 * The runner wraps each transaction-safe file in ONE BEGIN..COMMIT, so every lock a file takes
 * is held for the whole file. Without a `lock_timeout`, a contended ACCESS EXCLUSIVE request
 * queues — and every reader arriving BEHIND that waiter queues too, which turns a 3 ms
 * migration into an outage. These tests pin the guard so it cannot be removed silently.
 *
 * The behavioural proof (real contention, real abort, no partial state) lives in the lock-safety
 * report at docs/partner-migration-lock-safety.md; this file pins the invariants that
 * can be checked without a cluster.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLockTimeoutDirective, parseLockTimeoutFlag } from "../scripts/db/migrate";

const MIGRATIONS = join(process.cwd(), "migrations");
const RUNNER = readFileSync(join(process.cwd(), "scripts", "db", "migrate.ts"), "utf8");

describe("migration runner lock_timeout", () => {
  it("bounds the lock wait inside every transaction-safe migration", () => {
    // SET LOCAL, not SET: it must be discarded at COMMIT/ROLLBACK so it cannot leak into the
    // journal write or the next file.
    expect(RUNNER).toMatch(
      /await client\.query\("BEGIN"\);[\s\S]{0,400}SET LOCAL lock_timeout = \$\{fileLockTimeoutMs\}/
    );
  });

  it("bounds the lock wait for non-transactional migrations too, and restores the session GUC", () => {
    // SET LOCAL would be a no-op outside a transaction, so these use session scope and must
    // put it back whatever happens.
    expect(RUNNER).toMatch(/SET lock_timeout = \$\{fileLockTimeoutMs\}/);
    expect(RUNNER).toMatch(/finally \{\s*await client\.query\("SET lock_timeout = DEFAULT"\)/);
  });

  it("has a non-zero default, so a migration added tomorrow is bounded without opting in", () => {
    const m = /const DEFAULT_LOCK_TIMEOUT_MS = ([\d_]+);/.exec(RUNNER);
    expect(m, "DEFAULT_LOCK_TIMEOUT_MS must exist").not.toBeNull();
    expect(Number(m![1].replace(/_/g, ""))).toBeGreaterThan(0);
  });

  it("reports a lock_timeout abort as a contention failure, not a broken migration", () => {
    expect(RUNNER).toContain('const LOCK_NOT_AVAILABLE = "55P03"');
    expect(RUNNER).toContain("Nothing was applied and the transaction was rolled back");
  });
});

describe("per-file and per-run overrides", () => {
  it("parses ms and s forms, and treats absence as 'use the run default'", () => {
    expect(parseLockTimeoutDirective("-- migrate:lock-timeout 30s\nSELECT 1;")).toBe(30_000);
    expect(parseLockTimeoutDirective("-- migrate:lock-timeout 2500ms\nSELECT 1;")).toBe(2500);
    expect(parseLockTimeoutDirective("-- migrate:lock-timeout 750\nSELECT 1;")).toBe(750);
    expect(parseLockTimeoutDirective("SELECT 1;")).toBeUndefined();
  });

  it("allows an explicit 0 (wait forever) only as a deliberate declaration", () => {
    expect(parseLockTimeoutDirective("-- migrate:lock-timeout 0\nSELECT 1;")).toBe(0);
  });

  it("refuses an ambiguous double declaration rather than guessing", () => {
    expect(() =>
      parseLockTimeoutDirective("-- migrate:lock-timeout 1s\n-- migrate:lock-timeout 9s\n", "0099_x.sql")
    ).toThrow(/more than once/);
  });

  it("parses --lock-timeout and rejects junk", () => {
    expect(parseLockTimeoutFlag(["node", "migrate.ts", "--apply"])).toBe(5000);
    expect(parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=30s"])).toBe(30_000);
    expect(parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=250ms"])).toBe(250);
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=soon"])).toThrow(/Invalid/);
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=99999999"])).toThrow(/out-of-range/);
  });
});

describe("rollback files that take blocking locks", () => {
  // The runner only picks up /^(\d{4,})_.+\.sql$/, so rollback-*.sql is invisible to it and gets
  // no runner-supplied bound. Any rollback taking ACCESS EXCLUSIVE must carry its own.
  const HEAVY = [
    "rollback-0049-partner-grading-work-items.sql", // ACCESS EXCLUSIVE on `certificates`
    "rollback-0047-partner-owner-invariant-tenants-rls.sql", // ACCESS EXCLUSIVE, blocks reads
  ];

  it("the runner genuinely cannot see rollback files (so the bound must live in the file)", () => {
    expect(RUNNER).toContain("const FILE_RE = /^(\\d{4,})_.+\\.sql$/");
    expect(readdirSync(MIGRATIONS).some((f) => f.startsWith("rollback-"))).toBe(true);
    expect(/^(\d{4,})_.+\.sql$/.test("rollback-0049-partner-grading-work-items.sql")).toBe(false);
  });

  for (const file of HEAVY) {
    it(`${file} bounds its lock wait on the first statement inside its own BEGIN`, () => {
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      const statements = sql
        .split("\n")
        .map((l) => l.replace(/--.*$/, "").trim())
        .filter((l) => l.length > 0);
      expect(statements[0]).toBe("BEGIN;");
      // Must be the FIRST statement after BEGIN: it has to be in force before the first lock.
      expect(statements[1]).toMatch(/^SET LOCAL lock_timeout = '\d+s';$/);
      // SET LOCAL, so it cannot leak into the operator's psql session.
      expect(sql).not.toMatch(/^\s*SET lock_timeout/m);
      // Atomicity is preserved — the file still closes its own transaction.
      expect(statements.at(-1)).toBe("COMMIT;");
    });
  }
});
