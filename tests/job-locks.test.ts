import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Inventory guard (M2): every mutating scheduled job is wrapped in a Postgres
 * advisory lock with a stable, UNIQUE name, so two Fly machines can't run the
 * same tick concurrently.
 *
 * The behavioural semantics — a HELD lock prevents the wrapped tick from
 * executing, and the lock is RELEASED after both success and failure — are
 * proven against the shared primitive in tests/advisory-lock.test.ts. This test
 * asserts the jobs actually USE that primitive and that the lock names don't
 * collide, so dropping a guard (or adding a new unlocked job) trips CI.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const EXPECTED_LOCKS = [
  "pre-grade-cleanup",
  "vault-club-grace-sweep",
  "transfer-v2-sweep",
  "archival-sweep",
  "scan-reconciler",
  "embed-corpus",
  "ig-daily-post",
  "weekly-reel",
].sort();

// index.ts wraps its jobs via the local guard(name, fn) helper.
function indexLockNames(): string[] {
  const src = read("server/index.ts");
  const out: string[] = [];
  const re = /guard\(\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

// A self-scheduling job file wraps its tick via withAdvisoryLock(pool, CONST, ...)
// where CONST is a `const CONST = "name"` literal.
function jobLockName(file: string): string | null {
  const src = read(file);
  const call = src.match(/withAdvisoryLock\(\s*pool\s*,\s*([A-Za-z0-9_]+)\s*,/);
  if (!call) return null;
  const c = src.match(new RegExp(`const\\s+${call[1]}\\s*=\\s*"([^"]+)"`));
  return c ? c[1] : null;
}

describe("scheduled-job advisory-lock inventory", () => {
  const names = [
    ...indexLockNames(),
    jobLockName("server/jobs/ig-daily-post.ts"),
    jobLockName("server/jobs/weekly-reel.ts"),
  ].filter((n): n is string => !!n);

  it("wraps the three newly-locked jobs (embed-corpus, ig-daily-post, weekly-reel)", () => {
    expect(names).toContain("embed-corpus");
    expect(names).toContain("ig-daily-post");
    expect(names).toContain("weekly-reel");
    expect(read("server/jobs/ig-daily-post.ts")).toMatch(/withAdvisoryLock\(\s*pool\s*,/);
    expect(read("server/jobs/weekly-reel.ts")).toMatch(/withAdvisoryLock\(\s*pool\s*,/);
  });

  it("covers every expected mutating scheduled job", () => {
    expect([...new Set(names)].sort()).toEqual(EXPECTED_LOCKS);
  });

  it("uses stable, unique lock names (no collisions)", () => {
    expect(names.length).toBe(new Set(names).size);
    expect(names.length).toBe(EXPECTED_LOCKS.length);
  });
});
