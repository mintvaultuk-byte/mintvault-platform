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
import {
  describeMigrationFailure,
  hasNoTransactionDirective,
  parseLockTimeoutDirective,
  parseLockTimeoutFlag,
  parseToFlag,
} from "../scripts/db/migrate";

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
    expect(parseLockTimeoutDirective("SELECT 1;")).toBeUndefined();
  });

  it("REJECTS a unit-less directive instead of silently reading it as milliseconds", () => {
    // `-- migrate:lock-timeout 30` used to mean 30 MILLISECONDS, which aborts essentially every
    // migration. The author plainly meant seconds. An ambiguous bound is worse than none because
    // it looks configured.
    expect(() => parseLockTimeoutDirective("-- migrate:lock-timeout 30\n", "0099_x.sql")).toThrow(/without a unit/);
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
    // Out-of-range is still caught, but the value must carry a unit to get that far.
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=99999999ms"])).toThrow(/out-of-range/);
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=7200s"])).toThrow(/out-of-range/);
  });

  it("accepts the SPACE form too — it used to be ignored silently", () => {
    // `--lock-timeout 30s` matched no `startsWith("--lock-timeout=")`, so it fell back to 5000 ms
    // with no error: an operator who believed they had widened the maintenance window had not.
    expect(parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout", "30s"])).toBe(30_000);
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout"])).toThrow(/requires a value/);
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout", "--apply"])).toThrow(/requires a value/);
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=1s", "--lock-timeout", "2s"])).toThrow(
      /twice/
    );
  });

  it("rejects a unit-less --lock-timeout, but allows a bare 0", () => {
    expect(() => parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=30"])).toThrow(/unit is required/);
    expect(parseLockTimeoutFlag(["node", "migrate.ts", "--lock-timeout=0"])).toBe(0);
  });

  it("--to truncates the pending tail and never reorders or skips", () => {
    expect(parseToFlag(["node", "migrate.ts", "--apply"])).toBeUndefined();
    expect(parseToFlag(["node", "migrate.ts", "--to=0048"])).toBe(48);
    expect(parseToFlag(["node", "migrate.ts", "--to", "0048"])).toBe(48);
    expect(() => parseToFlag(["node", "migrate.ts", "--to=junk"])).toThrow(/Invalid --to/);
    expect(() => parseToFlag(["node", "migrate.ts", "--to"])).toThrow(/requires a migration number/);
    // Filtering is `<= toNumber` over the ALREADY numerically ordered pending list, so the
    // journal can only ever be a gap-free prefix. Pin the comparison, not just the parser.
    expect(RUNNER).toContain("plan.pending.filter((name) => Number(byName.get(name)!.number) <= opts.toNumber!)");
  });
});

describe("migrate:no-transaction directive must be anchored", () => {
  it("matches only a comment line of its own", () => {
    expect(hasNoTransactionDirective("-- migrate:no-transaction\nSELECT 1;")).toBe(true);
    expect(hasNoTransactionDirective("  --  migrate:no-transaction  \nSELECT 1;")).toBe(true);
    expect(hasNoTransactionDirective("SELECT 1;")).toBe(false);
  });

  it("does NOT match prose that merely mentions the directive", () => {
    // The exact defect: 0022's own header explains it needs "no CONCURRENTLY, no
    // migrate:no-transaction directive needed" and the sentence wraps, so a line BEGINS with the
    // directive text. The unanchored detector took a 12-statement DDL migration out of the
    // runner's transaction.
    expect(hasNoTransactionDirective("-- migrate:no-transaction directive needed).\n")).toBe(false);
    expect(hasNoTransactionDirective("-- we need no migrate:no-transaction here\n")).toBe(false);
  });

  it("0022 is transactional again, and its explanatory prose is untouched", () => {
    const sql = readFileSync(join(MIGRATIONS, "0022_print_workflow_lifecycle.sql"), "utf8");
    expect(sql, "the prose that triggered the bug must still be there").toMatch(/migrate:no-transaction directive/);
    expect(hasNoTransactionDirective(sql)).toBe(false);
  });

  it("0018 — a real CONCURRENTLY migration — is still detected", () => {
    const sql = readFileSync(join(MIGRATIONS, "0018_correction_audit_index.sql"), "utf8");
    expect(hasNoTransactionDirective(sql)).toBe(true);
  });

  it("exactly one migration in the repo opts out of the transaction", () => {
    const optedOut = readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4,}_.+\.sql$/.test(f))
      .filter((f) => hasNoTransactionDirective(readFileSync(join(MIGRATIONS, f), "utf8")));
    expect(optedOut).toEqual(["0018_correction_audit_index.sql"]);
  });
});

describe("no-transaction failures tell the truth and stay recoverable", () => {
  const LOCK_ERR = { code: "55P03", message: "canceling statement due to lock timeout" };

  it("the transactional path may claim nothing was applied", () => {
    const msg = describeMigrationFailure(LOCK_ERR, { lockTimeoutMs: 5000, transactional: true });
    expect(msg).toContain("Nothing was applied and the transaction was rolled back");
    expect(msg).toContain("no journal row was written");
  });

  it("the no-transaction path must NOT claim that — there is no transaction to roll back", () => {
    const msg = describeMigrationFailure(LOCK_ERR, {
      lockTimeoutMs: 5000,
      transactional: false,
      selfHealing: true,
      indexName: "public.idx_audit_log_cert_correction_recent",
    });
    expect(msg).not.toContain("Nothing was applied");
    expect(msg).toContain("ran OUTSIDE a transaction");
    expect(msg).toContain("HAS taken effect");
    // An invalid index is maintained on every write and used for no read — say so, and name it.
    expect(msg).toContain("INVALID index (public.idx_audit_log_cert_correction_recent)");
    // And tell the operator it recovers by itself, so nobody hand-edits the journal in an incident.
    expect(msg).toContain("REPAIR it automatically on the next run");
    expect(msg).toContain("No manual journal edit is needed");
  });

  it("a non-self-healing no-transaction failure says the runner cannot prove what survived", () => {
    const msg = describeMigrationFailure(LOCK_ERR, { lockTimeoutMs: 5000, transactional: false, selfHealing: false });
    expect(msg).toContain("cannot prove what survived");
    expect(msg).toContain("protected action");
    expect(msg).not.toContain("REPAIR it automatically");
  });

  it("a non-lock error is passed through untouched on both paths", () => {
    const other = { code: "42P07", message: 'relation "x" already exists' };
    expect(describeMigrationFailure(other, { lockTimeoutMs: 5000, transactional: true })).toBe(other.message);
    expect(describeMigrationFailure(other, { lockTimeoutMs: 5000, transactional: false })).toBe(other.message);
  });

  it("only a self-healing file may be resumed, and only at an unchanged checksum", () => {
    // Fail-closed is narrowed, not removed: everything the runner cannot verifiably repair stays
    // fatal. Pin both halves of the condition.
    expect(RUNNER).toContain("if (isSelfHealing(f) && row.checksum === f.checksum) {");
    expect(RUNNER).toContain("plan.resumable.push({ filename: f.filename, status: row.status });");
    expect(RUNNER).toContain("return f.noTransaction && ensureValidConcurrentIndexTarget(f.sql) !== null;");
  });

  it("a resumed row's checksum is refreshed, so a later run cannot compare against a stale one", () => {
    expect(RUNNER).toContain("checksum=EXCLUDED.checksum");
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
