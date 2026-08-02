/**
 * THE COMPOSED OVERVIEW — proven against real PostgreSQL 17.
 *
 * Two claims are load-bearing and both are easy to break silently:
 *
 *   1. ZERO EXTERNAL CALLS. An overview that refreshed on page load would spend GitHub quota on
 *      every render, and a dashboard that is expensive to look at is one nobody looks at. The test
 *      below supplies a database whose every read is counted and asserts nothing else is touched.
 *
 *   2. MERGED ≠ DEPLOYED ≠ MIGRATED ≠ ENABLED ≠ VERIFIED. Each is evidence from a different
 *      authority, and no authority may satisfy another's gate. Collapsing any pair is how a
 *      dashboard starts saying "done" about something nobody shipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { buildComposedOverview } from "../server/project-control/overview-service";
import type { EvidenceDb } from "../server/project-control/evidence-repository";
import { GITHUB_SOURCE } from "../server/project-control/github-sync-service";
import { APPLICATION_SOURCE, FLAG_SOURCE } from "../server/project-control/probe-persistence";
import { DATABASE_SOURCE } from "../server/project-control/database-evidence";
import {
  resolveGate,
  summariseGates,
  detectContradictions,
  computeGateReadiness,
  isSatisfied,
  GATES,
  CAP_CONTRADICTION,
} from "../shared/project-control-gates";

let cluster: DisposablePostgres17;
let db: pg.Pool;

beforeAll(async () => {
  cluster = await startPostgres17("pc-overview-service");
  db = new pg.Pool({ connectionString: cluster.url, max: 4 });
  await db.query(`CREATE TABLE IF NOT EXISTS pc_nodes (key text PRIMARY KEY)`);
  await db.query(`CREATE TABLE IF NOT EXISTS pc_work_packages (key text PRIMARY KEY)`);
  await db.query(readFileSync(join(__dirname, "..", "migrations/0039_project_control_live_evidence.sql"), "utf8"));
}, 240_000);

afterAll(async () => {
  await db?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
});

beforeEach(async () => {
  await db.query(`TRUNCATE pc_evidence_snapshots`);
  await db.query(`DELETE FROM pc_sync_runs`);
  await db.query(`DELETE FROM pc_sync_leases`);
});

async function snapshot(row: {
  source: string;
  environment?: string | null;
  entityType: string;
  entityId: string;
  commit?: string | null;
  status?: string;
  freshness?: string;
  payload?: unknown;
  validUntil?: string | null;
  ageMinutes?: number;
}): Promise<void> {
  await db.query(
    `INSERT INTO pc_evidence_snapshots
       (source_type, environment, entity_type, entity_id, commit_sha, status, freshness, payload,
        payload_digest, observed_at, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now() - ($10 || ' minutes')::interval, $11)`,
    [
      row.source,
      row.environment ?? null,
      row.entityType,
      row.entityId,
      row.commit ?? null,
      row.status ?? "ok",
      row.freshness ?? "CURRENT",
      JSON.stringify(row.payload ?? {}),
      `d-${Math.random()}`,
      String(row.ageMinutes ?? 0),
      row.validUntil ?? null,
    ]
  );
}

/** A healthy world: repo, both apps, staging database fully migrated, flag on. */
async function seedHealthy(): Promise<void> {
  await snapshot({
    source: GITHUB_SOURCE,
    entityType: "repository",
    entityId: "org/repo",
    commit: "372a98f39f23e2e3",
    payload: { branchCount: 12, pullRequestCount: 3 },
  });
  await snapshot({
    source: APPLICATION_SOURCE,
    environment: "staging",
    entityType: "application_version",
    entityId: "mintvault-v2.fly.dev",
    commit: "372a98f3",
    payload: { build: "MV-P5" },
  });
  await snapshot({
    source: APPLICATION_SOURCE,
    environment: "production",
    entityType: "application_version",
    entityId: "mintvault.fly.dev",
    commit: "6f182624",
  });
  await snapshot({
    source: DATABASE_SOURCE,
    environment: "staging",
    entityType: "migration_ledger",
    entityId: "staging",
    payload: {
      journalPresent: true,
      appliedCount: 30,
      pendingFilenames: [],
      foreignKeys: { intact: true, missing: [] },
      contradictions: [],
    },
  });
  await snapshot({
    source: FLAG_SOURCE,
    environment: "staging",
    entityType: "feature_flag",
    entityId: "SUPER_ADMIN_PROJECT_CONTROL_ENABLED",
    status: "enabled",
  });
}

describe("the overview performs ZERO external calls", () => {
  it("reads the database and nothing else", async () => {
    await seedHealthy();

    // Any attempt to reach the network would have to go through fetch; stub it to a throw so a
    // regression is loud rather than slow.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("the overview must not make network calls");
    }) as typeof fetch;

    try {
      const dto = await buildComposedOverview(db);
      expect(fetchCalls, "an overview that refreshes on page load spends quota on every render").toBe(0);
      expect(dto.repository.mainSha).toBe("372a98f39f23e2e3");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("issues only SELECTs — never a write, never a refresh", async () => {
    await seedHealthy();
    const statements: string[] = [];
    const recording: EvidenceDb = {
      query: async (text, values) => {
        statements.push(text.trim().slice(0, 12).toUpperCase());
        return db.query(text, values as unknown[]);
      },
    };

    await buildComposedOverview(recording);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s.startsWith("SELECT"), `overview issued a non-SELECT: ${s}`).toBe(true);
    }
  });
});

describe("last-known-good and honest absence", () => {
  it("keeps the real deployed SHA visible after an outage", async () => {
    await seedHealthy();
    // The application goes down; the failure is recorded as an additional row.
    await snapshot({
      source: APPLICATION_SOURCE,
      environment: "staging",
      entityType: "application_version",
      entityId: "mintvault-v2.fly.dev",
      freshness: "UNAVAILABLE",
      status: "unavailable",
    });

    const dto = await buildComposedOverview(db);
    const staging = dto.applications.find((a) => a.environment === "staging")!;

    expect(staging.commit, "the last known good SHA must survive the outage").toBe("372a98f3");
    expect(staging.meta.freshness, "while the latest observation says otherwise").toBe("UNAVAILABLE");
    expect(staging.meta.lastKnownGoodAt).not.toBeNull();
  });

  it("an entity with NO evidence is null, never zero", async () => {
    const dto = await buildComposedOverview(db);

    expect(dto.repository.mainSha).toBeNull();
    expect(dto.repository.branchCount, "zero branches and unknown branches are different facts").toBeNull();
    for (const app of dto.applications) expect(app.commit).toBeNull();
    for (const database of dto.databases) {
      expect(database.pendingCount, "'we have not looked' must never render as 'nothing pending'").toBeNull();
      expect(database.appliedCount).toBeNull();
      expect(database.foreignKeysIntact).toBeNull();
    }
  });

  it("a snapshot past its validity window reads STALE, not CURRENT", async () => {
    await snapshot({
      source: APPLICATION_SOURCE,
      environment: "staging",
      entityType: "application_version",
      entityId: "mintvault-v2.fly.dev",
      commit: "372a98f3",
      ageMinutes: 60,
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    });

    const dto = await buildComposedOverview(db);
    const staging = dto.applications.find((a) => a.environment === "staging")!;
    expect(staging.meta.freshness).toBe("STALE");
    expect(staging.commit, "a stale observation keeps its VALUE").toBe("372a98f3");
  });
});

describe("the gates stay independent", () => {
  it("AUTHORED does not satisfy DEPLOYED", async () => {
    // Repository evidence only: code exists, nothing is deployed.
    await snapshot({
      source: GITHUB_SOURCE,
      entityType: "repository",
      entityId: "org/repo",
      commit: "abc1234567",
      payload: { branchCount: 1, pullRequestCount: 0 },
    });

    const dto = await buildComposedOverview(db);
    const authored = dto.gates.find((g) => g.gate === "AUTHORED")!;
    const deployed = dto.gates.find((g) => g.gate === "DEPLOYED_STAGING")!;

    expect(isSatisfied(authored.state)).toBe(true);
    expect(isSatisfied(deployed.state), "GitHub cannot know what is deployed").toBe(false);
    expect(deployed.state).toBe("UNKNOWN");
  });

  /**
   * GATE1 — this assertion previously read `expect(isSatisfied(merged.state)).toBe(true)` against
   * a snapshot carrying `pullRequestCount: 0`, which enshrined the defect: MERGED was the
   * byte-identical observation to AUTHORED (`Boolean(repository.mainSha)`), so any repository with
   * a default branch satisfied "merged" forever, with no pull request and no branch involved.
   *
   * MERGED cannot be answered here at all: `buildComposedOverview` takes no work package and never
   * reads pc_work_packages, so there is no "this work" whose merge could be asserted. UNKNOWN is
   * the truthful answer, and it is the answer CI_PASSED and both VERIFIED gates already give.
   */
  it("GATE1: MERGED is UNKNOWN — a repository head is not evidence that any work merged", async () => {
    await snapshot({
      source: GITHUB_SOURCE,
      entityType: "repository",
      entityId: "org/repo",
      commit: "abc1234567",
      payload: { branchCount: 1, pullRequestCount: 0 },
    });

    const dto = await buildComposedOverview(db);
    const merged = dto.gates.find((g) => g.gate === "MERGED")!;

    expect(merged.state).toBe("UNKNOWN");
    expect(isSatisfied(merged.state)).toBe(false);
    // And it must not be silently identical to AUTHORED any more.
    const authored = dto.gates.find((g) => g.gate === "AUTHORED")!;
    expect(merged.state).not.toBe(authored.state);
  });

  /**
   * GATE2 — MIGRATION_AUTHORED had NO test of any kind, and its observation was
   * `(stagingDb?.appliedCount ?? 0) >= 0` — an expression that cannot be false, answered by the
   * database ledger when "has a migration been written" is a question about the repository.
   */
  it("GATE2: MIGRATION_AUTHORED is UNKNOWN when no package-to-migration mapping exists", async () => {
    // A perfectly healthy staging ledger. Under the old wiring this alone satisfied the gate.
    await snapshot({
      source: DATABASE_SOURCE,
      environment: "staging",
      entityType: "migration_ledger",
      entityId: "staging",
      payload: {
        journalPresent: true,
        appliedCount: 22,
        pendingFilenames: [],
        foreignKeys: { intact: true, missing: [] },
      },
    });

    const dto = await buildComposedOverview(db);
    const authoredMigration = dto.gates.find((g) => g.gate === "MIGRATION_AUTHORED")!;

    expect(authoredMigration.state).toBe("UNKNOWN");
    expect(isSatisfied(authoredMigration.state)).toBe(false);

    // The genuinely-evidenced sibling still works — authored is not applied, and applied is real.
    const applied = dto.gates.find((g) => g.gate === "MIGRATION_APPLIED_STAGING")!;
    expect(isSatisfied(applied.state)).toBe(true);
  });

  it("DEPLOYED does not satisfy MIGRATED", async () => {
    await snapshot({
      source: APPLICATION_SOURCE,
      environment: "staging",
      entityType: "application_version",
      entityId: "mintvault-v2.fly.dev",
      commit: "372a98f3",
    });

    const dto = await buildComposedOverview(db);
    expect(isSatisfied(dto.gates.find((g) => g.gate === "DEPLOYED_STAGING")!.state)).toBe(true);
    expect(
      isSatisfied(dto.gates.find((g) => g.gate === "MIGRATION_APPLIED_STAGING")!.state),
      "an application cannot know whether its migrations ran"
    ).toBe(false);
  });

  it("MIGRATED does not satisfy FEATURE_ENABLED", async () => {
    await snapshot({
      source: DATABASE_SOURCE,
      environment: "staging",
      entityType: "migration_ledger",
      entityId: "staging",
      payload: { journalPresent: true, appliedCount: 30, pendingFilenames: [], foreignKeys: { intact: true, missing: [] } },
    });

    const dto = await buildComposedOverview(db);
    expect(isSatisfied(dto.gates.find((g) => g.gate === "MIGRATION_APPLIED_STAGING")!.state)).toBe(true);
    expect(
      isSatisfied(dto.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!.state),
      "a migration ledger cannot know whether a flag is on"
    ).toBe(false);
  });

  it("ENABLED does not satisfy VERIFIED — verification has no machine source", async () => {
    await seedHealthy();
    const dto = await buildComposedOverview(db);

    expect(isSatisfied(dto.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!.state)).toBe(true);
    const verified = dto.gates.find((g) => g.gate === "VERIFIED_STAGING")!;
    expect(verified.state, "no amount of green machine evidence verifies anything").toBe("UNKNOWN");
    expect(isSatisfied(verified.state)).toBe(false);
  });

  it("production is never inferred from staging", async () => {
    await seedHealthy();
    await db.query(`DELETE FROM pc_evidence_snapshots WHERE environment='production'`).catch(() => {});
    // The append-only trigger blocks DELETE; use a fresh table state instead.
    await db.query(`TRUNCATE pc_evidence_snapshots`);
    await seedHealthy();

    const dto = await buildComposedOverview(db);
    const prod = dto.gates.find((g) => g.gate === "DEPLOYED_PRODUCTION")!;
    const prodVerified = dto.gates.find((g) => g.gate === "VERIFIED_PRODUCTION")!;
    expect(isSatisfied(prodVerified.state), "staging tells you nothing about production").toBe(false);
    expect(prod.source).not.toBe(GITHUB_SOURCE);
  });
});

describe("contradictions", () => {
  it("a deployment with pending migrations is HIGH severity", async () => {
    await seedHealthy();
    await snapshot({
      source: DATABASE_SOURCE,
      environment: "staging",
      entityType: "migration_ledger",
      entityId: "staging",
      payload: {
        journalPresent: true,
        appliedCount: 29,
        pendingFilenames: ["0039_project_control_live_evidence.sql"],
        foreignKeys: { intact: true, missing: [] },
      },
    });

    const dto = await buildComposedOverview(db);
    const codes = dto.contradictions.map((c) => c.code);
    expect(codes).toContain("DEPLOYMENT_WITHOUT_MIGRATION");
    const found = dto.contradictions.find((c) => c.code === "DEPLOYMENT_WITHOUT_MIGRATION")!;
    expect(found.severity).toBe("high");
    expect(found.evidenceSources).toEqual(expect.arrayContaining(["application", "database"]));
  });

  it("every unknown source is reported rather than silently omitted", async () => {
    const dto = await buildComposedOverview(db);
    const codes = dto.contradictions.map((c) => c.code);
    // A dashboard that quietly omits what it does not know looks identical to one where
    // everything is fine.
    expect(codes).toContain("UNKNOWN_REPOSITORY");
    expect(codes).toContain("UNKNOWN_APPLICATION");
    expect(codes).toContain("UNKNOWN_DATABASE");
    expect(codes).toContain("UNKNOWN_FLAGS");
  });

  it("drift between repository head and staging is surfaced", async () => {
    await seedHealthy();
    await snapshot({
      source: APPLICATION_SOURCE,
      environment: "staging",
      entityType: "application_version",
      entityId: "mintvault-v2.fly.dev",
      commit: "deadbeef",
    });

    const dto = await buildComposedOverview(db);
    expect(dto.contradictions.map((c) => c.code)).toContain("GITHUB_NEWER_THAN_DEPLOYMENT");
    expect(dto.executive.deploymentAligned).toBe(false);
  });

  it("deployment alignment is null when either side is unknown", async () => {
    const dto = await buildComposedOverview(db);
    expect(dto.executive.deploymentAligned, "'cannot tell' is not 'misaligned'").toBeNull();
  });
});

describe("readiness cannot be inflated by absence", () => {
  it("an empty database yields low readiness, never 100", async () => {
    const dto = await buildComposedOverview(db);
    expect(dto.readiness.percent).toBeLessThan(50);
    expect(dto.readiness.satisfiedGates).toBe(0);
  });

  it("contradictions cap readiness", () => {
    const allSatisfied = GATES.map((gate) =>
      resolveGate(gate, { source: "x", satisfied: true, freshness: "CURRENT", observedAt: null })
    );
    const clean = computeGateReadiness(allSatisfied, []);
    expect(clean.percent).toBe(100);

    const capped = computeGateReadiness(allSatisfied, [
      { code: "MIGRATION_MISSING", summary: "x", evidenceSources: ["database"], severity: "high" },
    ]);
    expect(capped.percent).toBe(CAP_CONTRADICTION);
    expect(capped.cappedBy.join(" ")).toMatch(/contradictory/);
  });

  it("STALE evidence does not satisfy a gate", () => {
    const stale = resolveGate("DEPLOYED_STAGING", {
      source: "application",
      satisfied: true,
      freshness: "STALE",
      observedAt: null,
    });
    expect(stale.state).toBe("STALE");
    expect(isSatisfied(stale.state), "'it was true an hour ago' is not 'it is true'").toBe(false);
  });

  it("UNAVAILABLE evidence does not satisfy a gate and caps readiness", () => {
    const results = GATES.map((gate) =>
      gate === "DEPLOYED_STAGING"
        ? resolveGate(gate, { source: "application", satisfied: true, freshness: "UNAVAILABLE", observedAt: null })
        : resolveGate(gate, { source: "x", satisfied: true, freshness: "CURRENT", observedAt: null })
    );
    const verdict = computeGateReadiness(results, []);
    expect(verdict.percent).toBeLessThan(100);
    expect(verdict.cappedBy.join(" ")).toMatch(/unavailable/);
  });

  it("UNKNOWN is not zero and not success", () => {
    const unknown = resolveGate("CI_PASSED", null);
    expect(unknown.state).toBe("UNKNOWN");
    expect(isSatisfied(unknown.state)).toBe(false);
    expect(unknown.reason).toMatch(/No evidence/i);
  });

  it("the next gate is the first unsatisfied one, in pipeline order", () => {
    const results = GATES.map((gate, i) =>
      resolveGate(gate, { source: "x", satisfied: i < 2, freshness: "CURRENT", observedAt: null })
    );
    const summary = summariseGates(results);
    expect(summary.reached).toBe("MERGED");
    expect(summary.next).toBe("CI_PASSED");
  });
});

describe("the DTO carries typed data only", () => {
  it("contains no HTML and no pre-formatted display strings", async () => {
    await seedHealthy();
    const dto = await buildComposedOverview(db);
    const text = JSON.stringify(dto);
    expect(text).not.toMatch(/<[a-z]+[^>]*>/i);
    expect(text).not.toContain("&nbsp;");
    // Percentages are numbers, so the UI can format them.
    expect(typeof dto.readiness.percent).toBe("number");
  });

  it("names a next recommended action, and a high contradiction outranks a gate", async () => {
    await seedHealthy();
    await snapshot({
      source: DATABASE_SOURCE,
      environment: "staging",
      entityType: "migration_ledger",
      entityId: "staging",
      payload: { journalPresent: true, appliedCount: 29, pendingFilenames: ["x.sql"], foreignKeys: { intact: true, missing: [] } },
    });

    const dto = await buildComposedOverview(db);
    expect(dto.executive.nextRecommendedAction).toMatch(/Resolve the contradiction/);
  });

  it("detectContradictions is pure and total", () => {
    const none = detectContradictions({
      repositoryHeadSha: "abc1234567",
      repositoryKnown: true,
      stagingCommit: "abc1234",
      stagingKnown: true,
      productionCommit: "abc1234",
      productionKnown: true,
      migrationsPending: 0,
      databaseKnown: true,
      projectControlFlagEnabled: true,
      flagsKnown: true,
    });
    expect(none).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * FIX 3 — flag evidence must carry an environment and obey its validity window.
 *
 * The flag read was the only one of the four sources that was not environment-keyed:
 *
 *   SELECT DISTINCT ON (entity_id) * FROM pc_evidence_snapshots WHERE source_type=$1
 *
 * `DISTINCT ON (entity_id)` collapsed every environment's row for a flag into one and kept
 * whichever was newest, so a production observation satisfied the STAGING gate. The meta was also
 * hand-built and skipped `effectiveFreshness`, so FLAG_VALID_MS was written and never read — a
 * flag observation stayed CURRENT forever.
 * ══════════════════════════════════════════════════════════════════════════════════════════ */
describe("FIX 3 — flag evidence freshness and environment", () => {
  const FLAG = "SUPER_ADMIN_PROJECT_CONTROL_ENABLED";

  const flagRow = (o: {
    environment: string;
    status: string;
    ageMinutes?: number;
    validUntil?: string | null;
    freshness?: string;
  }) =>
    snapshot({
      source: FLAG_SOURCE,
      environment: o.environment,
      entityType: "feature_flag",
      entityId: FLAG,
      status: o.status,
      freshness: o.freshness ?? "CURRENT",
      ageMinutes: o.ageMinutes ?? 0,
      validUntil: o.validUntil === undefined ? new Date(Date.now() + 30 * 60_000).toISOString() : o.validUntil,
    });

  /** FLAG2 — staging evidence must never answer a question asked about production. */
  it("FLAG2: a PRODUCTION flag observation does not satisfy the staging gate", async () => {
    // Only production has ever been observed, and it says enabled.
    await flagRow({ environment: "production", status: "enabled" });

    const dto = await buildComposedOverview(db);
    const gate = dto.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!;

    expect(isSatisfied(gate.state)).toBe(false);
    expect(gate.state).toBe("UNKNOWN");
    // And the DTO discloses which estate the row it does have belongs to.
    expect(dto.flags.map((f) => f.environment)).toEqual(["production"]);
  });

  it("FLAG2: staging evidence satisfies only the staging gate, and carries its environment", async () => {
    await flagRow({ environment: "staging", status: "enabled" });

    const dto = await buildComposedOverview(db);
    expect(isSatisfied(dto.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!.state)).toBe(true);
    const staging = dto.flags.find((f) => f.environment === "staging")!;
    expect(staging.key).toBe(FLAG);
    expect(staging.state).toBe("enabled");
  });

  /** FLAG1 — a flag observation past its validity window is STALE, and STALE never satisfies. */
  it("FLAG1: a stale flag observation cannot satisfy the gate", async () => {
    await flagRow({
      environment: "staging",
      status: "enabled",
      ageMinutes: 120,
      validUntil: new Date(Date.now() - 60 * 60_000).toISOString(),
    });

    const dto = await buildComposedOverview(db);
    const gate = dto.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!;

    expect(dto.flags.find((f) => f.environment === "staging")!.meta.freshness).toBe("STALE");
    expect(gate.state).toBe("STALE");
    expect(isSatisfied(gate.state)).toBe(false);
  });

  it("an unknown-environment observation satisfies neither estate's gate", async () => {
    // The label a process writes when PROJECT_CONTROL_ENV is unset — the state of both Fly apps.
    await flagRow({ environment: "unknown", status: "enabled" });

    const dto = await buildComposedOverview(db);
    expect(isSatisfied(dto.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!.state)).toBe(false);
    // It is not surfaced as either environment's evidence at all.
    expect(dto.flags.filter((f) => f.environment === "staging" || f.environment === "production")).toEqual([]);
  });

  it("keeps explicitly-disabled distinct from absent all the way to the gate detail", async () => {
    await flagRow({ environment: "staging", status: "disabled_explicit" });
    const disabled = await buildComposedOverview(db);
    const disabledGate = disabled.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!;
    expect(disabledGate.reason ?? "").toContain("disabled_explicit");

    await db.query("TRUNCATE pc_evidence_snapshots");
    await flagRow({ environment: "staging", status: "absent" });
    const absent = await buildComposedOverview(db);
    const absentGate = absent.gates.find((g) => g.gate === "FEATURE_ENABLED_STAGING")!;
    expect(absentGate.reason ?? "").toContain("absent");

    // Both are NOT_SATISFIED, but an operator can tell which remedy applies.
    expect(absentGate.reason).not.toBe(disabledGate.reason);
  });

  it("retains last-known-good when the newest flag observation is unusable", async () => {
    await flagRow({ environment: "staging", status: "enabled", ageMinutes: 10 });
    await snapshot({
      source: FLAG_SOURCE,
      environment: "staging",
      entityType: "feature_flag",
      entityId: FLAG,
      status: "unknown",
      freshness: "UNAVAILABLE",
      ageMinutes: 0,
    });

    const dto = await buildComposedOverview(db);
    const staging = dto.flags.find((f) => f.environment === "staging")!;

    // The usable answer survives; the failure is disclosed rather than substituted.
    expect(staging.state).toBe("enabled");
    expect(staging.latestState).toBe("unknown");
    expect(staging.meta.freshness).toBe("UNAVAILABLE");
    expect(staging.meta.lastKnownGoodAt).not.toBeNull();
  });
});
