/**
 * Project Control — presentation helpers and safety-surface guards.
 *
 * The second half of this file is a source-assertion suite. The dashboard is a read-and-record
 * surface: it must never be able to CAUSE a protected action (push, merge, deploy, migrate,
 * destructive SQL) and must never leak a secret to the browser. Those are properties of the
 * source, so they are asserted against the source.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_FILTER,
  confidenceBadgeVariant,
  describeAction,
  displayPercent,
  isFilterActive,
  layoutDependencyColumns,
  overviewQueryString,
  readinessTone,
  relativeTime,
  riskBadgeVariant,
  statusBadgeVariant,
  toggleInList,
} from "../client/src/pages/admin/project-control-helpers";
import type { NextAction } from "@shared/project-control";

const ROOT = join(__dirname, "..");
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

const ROUTES_FILE = "server/routes/admin/project-control.ts";
const SERVICE_FILE = "server/project-control/service.ts";
const SCAN_FILE = "server/project-control/repo-scan.ts";
const SEED_FILE = "server/project-control/seed.ts";
const MIGRATION_FILE = "migrations/0030_project_control.sql";

/* ------------------------------------------------------------------------------------------ */

describe("presentation helpers", () => {
  it("reserves the finished colour for production-verified work only", () => {
    expect(statusBadgeVariant("production_verified")).toBe("act");
    expect(statusBadgeVariant("deployed")).not.toBe("act");
    expect(statusBadgeVariant("blocked")).toBe("red");
  });

  it("colours contradictory evidence and critical risk as problems", () => {
    expect(confidenceBadgeVariant("contradictory")).toBe("red");
    expect(riskBadgeVariant("critical")).toBe("red");
  });

  it("never rounds a percentage up to 100", () => {
    expect(displayPercent(99.9)).toBe("99%");
    expect(displayPercent(100)).toBe("100%");
    expect(displayPercent(0)).toBe("0%");
    expect(displayPercent(Number.NaN)).toBe("0%");
    expect(displayPercent(140)).toBe("100%");
    expect(displayPercent(-5)).toBe("0%");
  });

  it("formats relative time in plain English", () => {
    const now = new Date("2026-07-25T12:00:00Z");
    expect(relativeTime("2026-07-25T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-07-25T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-07-24T12:00:00Z", now)).toBe("1 day ago");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("not-a-date", now)).toBe("unknown");
  });

  it("builds a stable, minimal query string", () => {
    expect(overviewQueryString(EMPTY_FILTER)).toBe("");
    expect(overviewQueryString({ ...EMPTY_FILTER, search: " crop ", blockedOnly: true })).toBe(
      "?search=crop&blocked=true"
    );
    expect(overviewQueryString({ ...EMPTY_FILTER, status: ["blocked", "merged"] })).toBe("?status=blocked%2Cmerged");
  });

  it("toggles filter values in and out", () => {
    expect(toggleInList(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleInList(["a", "b"], "a")).toEqual(["b"]);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, ownerActionOnly: true })).toBe(true);
  });

  it("bands readiness sensibly", () => {
    expect(readinessTone(100)).toBe("complete");
    expect(readinessTone(80)).toBe("high");
    expect(readinessTone(50)).toBe("mid");
    expect(readinessTone(5)).toBe("low");
  });

  it("explains an action in one sentence", () => {
    const base: NextAction = {
      packageKey: "a",
      packageTitle: "A",
      nodeKey: "n",
      kind: "deploy",
      headline: "Deploy: A",
      priority: 50,
      riskScore: 70,
      businessValue: 4,
      requiresOwnerApproval: true,
      blockedBy: [],
      reasons: [],
    };
    expect(describeAction({ ...base, blockedBy: ["b"] })).toContain("waiting on b");
    expect(describeAction(base)).toContain("explicit go-ahead");
    expect(describeAction({ ...base, requiresOwnerApproval: false, riskScore: 10 })).toContain("Low risk");
  });

  it("lays out a dependency graph in columns without hanging on a cycle", () => {
    const layout = layoutDependencyColumns(
      [{ key: "a" }, { key: "b" }, { key: "c" }],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ]
    );
    expect(layout).toEqual([
      { key: "a", column: 0 },
      { key: "b", column: 1 },
      { key: "c", column: 2 },
    ]);

    const cyclic = layoutDependencyColumns(
      [{ key: "x" }, { key: "y" }],
      [
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ]
    );
    expect(cyclic).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe("safety surface", () => {
  it("gates every Project Control route behind the flag AND requireSuperAdmin", () => {
    const source = read(ROUTES_FILE);
    const total = [...source.matchAll(/^\s*app\.(get|post|put|delete)\(/gm)].length;
    // Two shared gates exist: the ordinary one and the expensive one (which adds a tighter
    // limiter). Every route must use ONE of them — neither guard can be forgotten on a new route.
    const gatedRegistrations = [
      ...source.matchAll(/app\.(get|post|put|delete)\(\s*`\$\{BASE\}([^`]*)`\s*,\s*\.\.\.gated(?:Expensive)?/g),
    ];
    expect(total).toBeGreaterThan(20);
    expect(gatedRegistrations.length).toBe(total);
    expect(source).toMatch(
      /const gated = \[requireProjectControlEnabled, requireSuperAdmin, projectControlReadLimit\] as const/
    );
    expect(source).toMatch(/const gatedExpensive = \[/);
  });

  it("exposes no route that could perform a protected action", () => {
    const source = read(ROUTES_FILE).toLowerCase();
    for (const forbidden of [
      "fly deploy",
      "git push",
      "db:push",
      "drizzle-kit",
      "safe-deploy",
      "execfile",
      "spawn(",
      "exec(",
    ]) {
      expect(source, `route layer must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never writes to any pre-existing MintVault table", () => {
    const service = read(SERVICE_FILE);
    // Only match a drizzle table identifier, not a chained `.insert(` on some other builder.
    const tables = [...service.matchAll(/\b(?:tx|db)\s*\n?\s*\.(?:insert|update|delete)\((\w+)/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(5);
    for (const table of tables) {
      expect(table, `${table} is outside the pc_ namespace`).toMatch(/^pc[A-Z]/);
    }
  });

  it("keeps the audit trail append-only — nothing updates or deletes status events", () => {
    const service = read(SERVICE_FILE);
    expect(service).not.toMatch(/\.update\(pcStatusEvents/);
    expect(service).not.toMatch(/\.delete\(pcStatusEvents/);
    expect(service).toMatch(/\.insert\(pcStatusEvents/);
  });

  it("restricts the repository scanner to read-only git subcommands", () => {
    const source = read(SCAN_FILE);
    const allowlist = source.match(/ALLOWED_GIT_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/);
    expect(allowlist).toBeTruthy();
    const listed = [...allowlist![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const mutating of [
      "push",
      "commit",
      "checkout",
      "merge",
      "reset",
      "fetch",
      "pull",
      "rebase",
      "clean",
      "tag",
    ]) {
      expect(listed, `git ${mutating} must not be callable`).not.toContain(mutating);
    }
    // execFile with an argument array — never a shell string that could be injected into.
    expect(source).toMatch(/execFile/);
    expect(source).not.toMatch(/\bexec\(/);
  });

  it("reports feature flags as configured/absent and never sends a value", () => {
    const source = read(SCAN_FILE);
    expect(source).toMatch(/configured: \(process\.env\[name\] \?\? ""\)\.length > 0/);
    // The only place process.env values are read is that length check.
    const valueReads = [...source.matchAll(/process\.env\[[^\]]+\]/g)];
    expect(valueReads).toHaveLength(1);
  });

  it("keeps migration 0030 additive — it never touches data or a pre-existing object", () => {
    // Strip comments first so prose about destructive operations does not trip the check.
    const sql = read(MIGRATION_FILE)
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .toUpperCase();

    // No data statement of any kind. ("UPDATE" appears only inside BEFORE UPDATE trigger
    // definitions, which change no row, so the check targets the data form specifically.)
    for (const destructive of ["TRUNCATE", "DELETE FROM", "INSERT INTO"]) {
      expect(sql, `migration must not contain ${destructive}`).not.toContain(destructive);
    }
    expect(sql, "migration must not UPDATE any row").not.toMatch(/UPDATE\s+\w+\s+SET/);
    // ALTER is permitted ONLY to attach a foreign key to a pc_ table it just created.
    const alters = [...sql.matchAll(/ALTER TABLE (\w+)/g)].map((m) => m[1]);
    for (const table of alters) expect(table).toMatch(/^PC_/);
    // DROP is permitted ONLY for the migration's own triggers, immediately before recreating them.
    const drops = [...sql.matchAll(/DROP (\w+) IF EXISTS ([\w.]+)/g)];
    for (const [, kind, name] of drops) {
      expect(kind, `unexpected DROP ${kind}`).toBe("TRIGGER");
      expect(name).toMatch(/^TRG_PC_/);
    }
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS");
  });

  it("declares referential integrity, uniqueness and the append-only guarantee in the migration", () => {
    const sql = read(MIGRATION_FILE);
    expect((sql.match(/FOREIGN KEY/g) ?? []).length).toBeGreaterThanOrEqual(9);
    expect(sql).toMatch(/ON DELETE RESTRICT/);
    expect(sql).toMatch(/ON DELETE CASCADE/);
    expect(sql).toMatch(/ON DELETE SET NULL/);
    expect(sql).toMatch(/pc_status_events_append_only/);
    expect(sql).toMatch(/pc_prompts_immutable/);
    expect(sql).toMatch(/version\s+INTEGER NOT NULL DEFAULT 1/);
  });

  it("creates only pc_-prefixed tables in migration 0030", () => {
    const created = [...read(MIGRATION_FILE).matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(created).toHaveLength(9);
    for (const table of created) expect(table).toMatch(/^pc_/);
  });

  it("uses a migration number that does not collide with an existing file", () => {
    const files = readdirSync(join(ROOT, "migrations")).filter((f) => /^\d{4,}_/.test(f));
    const numbers = files.map((f) => f.slice(0, 4));
    const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    expect(duplicates, `duplicate migration numbers: ${duplicates.join(", ")}`).toHaveLength(0);
    expect(files).toContain("0030_project_control.sql");
  });

  it("seeds idempotently and never overwrites an edited row", () => {
    const seed = read(SEED_FILE);
    expect(seed).toMatch(/onConflictDoNothing/);
    expect(seed).not.toMatch(/onConflictDoUpdate/);
    expect(seed).not.toMatch(/\.update\(/);
    expect(seed).not.toMatch(/\.delete\(/);
  });

  it("records seeded statuses as owner statements, never as verified", () => {
    const seed = read(SEED_FILE);
    expect(seed).toContain('kind: "owner_statement"');
    expect(seed).not.toContain("automatically_verified");
  });
});
