import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import { db } from "../db";
import type { ProjectEvidence } from "./types";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const NOW_STALE_HOURS = 24;
const MAX_DEPLOYMENT_RESPONSE_BYTES = 16 * 1024;
const MAX_EVIDENCE_TEXT_LENGTH = 512;
const MAX_PAYLOAD_DEPTH = 4;
const MAX_PAYLOAD_ITEMS = 40;
const SENSITIVE_KEY = /(api[_-]?key|authorization|cookie|credential|password|secret|token|database[_-]?url|connection[_-]?string)/i;

function isoNow(): string {
  return new Date().toISOString();
}

function staleAfter(hours = NOW_STALE_HOURS): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: ROOT, timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

function evidence(partial: Omit<ProjectEvidence, "sourceTimestamp" | "confidenceImpact"> & { confidenceImpact?: number }): ProjectEvidence {
  return {
    ...partial,
    sourceTimestamp: isoNow(),
    confidenceImpact: partial.confidenceImpact ?? 0,
  };
}

function boundedText(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  return value.length <= MAX_EVIDENCE_TEXT_LENGTH ? value : `${value.slice(0, MAX_EVIDENCE_TEXT_LENGTH)}…`;
}

function safeLocator(value: unknown, fallback: string): string {
  const locator = boundedText(value, fallback);
  if (isAbsolute(locator) || /^[A-Za-z]:[\\/]/.test(locator) || locator.startsWith("~")) {
    return `repository-relative:${basename(locator) || "redacted"}`;
  }
  try {
    const url = new URL(locator);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return locator;
  }
}

function safePayload(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth >= MAX_PAYLOAD_DEPTH || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return {
      items: value.slice(0, MAX_PAYLOAD_ITEMS).map((item) => safePayload(item, depth + 1) ?? boundedText(item)),
      truncated: value.length > MAX_PAYLOAD_ITEMS,
    };
  }
  if (typeof value !== "object") return { value: boundedText(value, String(value ?? "unknown")) };

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_PAYLOAD_ITEMS)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof entry === "string") result[key] = boundedText(entry, "");
    else if (entry === null || typeof entry === "number" || typeof entry === "boolean") result[key] = entry;
    else result[key] = safePayload(entry, depth + 1);
  }
  return result;
}

export async function scanRepositoryEvidence(): Promise<{
  evidence: ProjectEvidence[];
  repository: Record<string, unknown>;
}> {
  const items: ProjectEvidence[] = [];
  const repository: Record<string, unknown> = {};

  try {
    const [branch, head, originMain, dirty, worktrees] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "origin/main"]),
      git(["status", "--short"]),
      git(["worktree", "list", "--porcelain"]),
    ]);
    const aheadBehind = await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]).catch(() => "unknown");
    const migrationFiles = readdirSync(join(ROOT, "migrations"))
      .filter((file) => /^\d{4,}_.+\.sql$/.test(file))
      .sort((a, b) => Number(a.slice(0, 4)) - Number(b.slice(0, 4)) || a.localeCompare(b));
    const migrationHead = migrationFiles[migrationFiles.length - 1] ?? "unknown";
    const worktreeCount = worktrees.split(/\n(?=worktree )/).filter(Boolean).length;
    const prunableCount = (worktrees.match(/\nprunable /g) ?? []).length;
    const g6dMerged = await git(["merge-base", "--is-ancestor", "codex/partner-g6d-submission-credit-integration", "origin/main"])
      .then(() => true)
      .catch(() => false);

    Object.assign(repository, {
      branch,
      head,
      originMain,
      aheadBehind,
      dirty: dirty.length > 0,
      migrationHead,
      worktreeCount,
      prunableCount,
      g6dMerged,
    });

    items.push(
      evidence({
        evidenceId: "repo-current-head",
        requirementIds: ["MEGS-REPO-001", "MEGS-PCD-002"],
        evidenceClassification: "Proven from repository",
        lifecycleState: dirty ? "blocked" : "implemented",
        sourceKind: "repository",
        sourceLocator: "git rev-parse HEAD",
        summary: `Current branch ${branch} at ${head}; origin/main ${originMain}.`,
        staleAfter: staleAfter(),
        payload: { branch, head, originMain, aheadBehind, dirty },
      }),
      evidence({
        evidenceId: "repo-worktrees",
        requirementIds: ["MEGS-REPO-002", "MEGS-AI-009"],
        evidenceClassification: "Proven from repository",
        lifecycleState: "implemented",
        sourceKind: "repository",
        sourceLocator: "git worktree list --porcelain",
        summary: `${worktreeCount} worktrees detected; ${prunableCount} prunable.`,
        staleAfter: staleAfter(),
        payload: { worktreeCount, prunableCount },
      }),
      evidence({
        evidenceId: "repo-migration-head",
        requirementIds: ["MEGS-DB-001"],
        evidenceClassification: "Proven from repository",
        lifecycleState: "implemented",
        sourceKind: "repository",
        sourceLocator: "migrations/",
        summary: `Repository migration head is ${migrationHead}.`,
        staleAfter: staleAfter(),
        payload: { migrationHead, migrationFiles },
      }),
      evidence({
        evidenceId: "repo-g6d-disposition",
        requirementIds: ["MEGS-WALLET-002", "MEGS-DEC-OPEN-010"],
        evidenceClassification: g6dMerged ? "Proven from repository" : "Open Question",
        lifecycleState: g6dMerged ? "implemented" : "blocked",
        sourceKind: "repository",
        sourceLocator: "git merge-base --is-ancestor codex/partner-g6d-submission-credit-integration origin/main",
        summary: g6dMerged ? "G6D is ancestor of origin/main." : "G6D is not proven merged into origin/main.",
        staleAfter: staleAfter(),
        payload: { g6dMerged },
      })
    );
  } catch {
    repository.error = "unavailable";
    items.push(
      evidence({
        evidenceId: "repo-scan-error",
        requirementIds: ["MEGS-REPO-001", "MEGS-PCD-002"],
        evidenceClassification: "Unknown",
        lifecycleState: "unknown",
        sourceKind: "repository",
        sourceLocator: "git",
        summary: "Repository scanner failed; readiness must remain unknown.",
        confidenceImpact: -30,
        payload: { error: "unavailable" },
      })
    );
  }

  if (existsSync(join(ROOT, ".github/workflows/ci.yml"))) {
    items.push(
      evidence({
        evidenceId: "repo-ci-workflow",
        requirementIds: ["MEGS-TEST-002", "MEGS-DB-001"],
        evidenceClassification: "Proven from repository",
        lifecycleState: "test evidence missing",
        sourceKind: "repository",
        sourceLocator: ".github/workflows/ci.yml",
        summary: "CI workflow exists; current CI run result is not ingested by this scanner.",
        staleAfter: staleAfter(),
      })
    );
  }

  return { evidence: items, repository };
}

async function fetchVersion(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_DEPLOYMENT_RESPONSE_BYTES) throw new Error("response too large");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_DEPLOYMENT_RESPONSE_BYTES) throw new Error("response too large");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return {
      commit: typeof parsed.commit === "string" && /^[0-9a-f]{7,64}$/i.test(parsed.commit) ? parsed.commit : "unknown",
      timestamp: typeof parsed.timestamp === "string" ? boundedText(parsed.timestamp) : undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function scanDeploymentEvidence(): Promise<{
  evidence: ProjectEvidence[];
  production: Record<string, unknown>;
}> {
  const targets = [
    ["production", "https://mintvault.fly.dev/api/version"],
    ["staging", "https://mintvault-v2.fly.dev/api/version"],
  ] as const;
  const items: ProjectEvidence[] = [];
  const production: Record<string, unknown> = {};

  for (const [name, url] of targets) {
    try {
      const data = await fetchVersion(url);
      production[name] = data;
      items.push(
        evidence({
          evidenceId: `deploy-${name}-version`,
          requirementIds: ["MEGS-DEPLOY-002", "MEGS-EVID-003", "MEGS-PCD-002"],
          evidenceClassification: "Proven from production",
          lifecycleState: "production verification pending",
          sourceKind: "production",
          sourceLocator: safeLocator(url, "deployment version endpoint"),
          summary: `${name} /api/version reported commit ${String(data.commit ?? "unknown")}. This proves artifact commit only.`,
          staleAfter: staleAfter(6),
          payload: safePayload(data),
        })
      );
    } catch {
      production[name] = { error: "unavailable" };
      items.push(
        evidence({
          evidenceId: `deploy-${name}-unavailable`,
          requirementIds: ["MEGS-DEPLOY-002", "MEGS-EVID-003"],
          evidenceClassification: "Unknown",
          lifecycleState: "unknown",
          sourceKind: "production",
          sourceLocator: safeLocator(url, "deployment version endpoint"),
          summary: `${name} /api/version could not be read.`,
          confidenceImpact: -20,
          payload: { error: "unavailable" },
        })
      );
    }
  }

  return { evidence: items, production };
}

export function scanTestEvidence(): ProjectEvidence[] {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const testFiles = existsSync(join(ROOT, "tests")) ? readdirSync(join(ROOT, "tests")).filter((file) => file.endsWith(".test.ts")) : [];
  return [
    evidence({
      evidenceId: "test-scripts-static",
      requirementIds: ["MEGS-TEST-001", "MEGS-TEST-002", "MEGS-TEST-003"],
      evidenceClassification: "Proven from repository",
      lifecycleState: "test evidence missing",
      sourceKind: "test",
      sourceLocator: "package.json scripts and tests/",
      summary: `Test/lint/build scripts exist and ${testFiles.length} top-level test files were found. No current pass is claimed by this static evidence.`,
      staleAfter: staleAfter(),
      payload: { scripts: packageJson.scripts, topLevelTestFiles: testFiles.length },
    }),
  ];
}

export async function scanDatabaseEvidence(): Promise<ProjectEvidence[]> {
  try {
    const identityRows = await db.execute(sql`
      SELECT current_database() AS database_name, current_user AS database_role,
             current_setting('server_version') AS server_version
    `);
    const identity = identityRows.rows[0] as { database_name?: string; database_role?: string; server_version?: string } | undefined;
    const databaseFingerprint = createHash("sha256")
      .update(`${identity?.database_name ?? "unknown"}\u0000${identity?.database_role ?? "unknown"}`)
      .digest("hex")
      .slice(0, 16);
    const rows = await db.execute(sql`
      SELECT evidence_id, requirement_id, evidence_classification, lifecycle_state,
             source_kind, source_locator, source_timestamp, summary, payload,
             stale_after, confidence_impact
        FROM project_control_evidence
       ORDER BY created_at DESC
       LIMIT 250
    `);
    return [
      evidence({
        evidenceId: "db-project-control-identity",
        requirementIds: ["MEGS-DB-001", "MEGS-PCD-009"],
        evidenceClassification: "Proven from database",
        lifecycleState: "implemented",
        sourceKind: "database",
        sourceLocator: "current_database/current_user",
        summary: "A Project Control database target was identified by a redacted fingerprint.",
        staleAfter: staleAfter(),
        payload: { databaseFingerprint, serverVersion: boundedText(identity?.server_version) },
      }),
      ...rows.rows.map((row: any) => ({
        evidenceId: boundedText(row.evidence_id, "database-evidence"),
        requirementIds: [boundedText(row.requirement_id, "MEGS-PCD-009")],
        evidenceClassification: row.evidence_classification,
        lifecycleState: row.lifecycle_state,
        sourceKind: "database" as const,
        sourceLocator: safeLocator(row.source_locator, "project_control_evidence"),
        sourceTimestamp: row.source_timestamp ? new Date(row.source_timestamp).toISOString() : isoNow(),
        summary: boundedText(row.summary, "Database evidence record."),
        payload: safePayload(row.payload),
        staleAfter: row.stale_after ? new Date(row.stale_after).toISOString() : undefined,
        confidenceImpact: Number(row.confidence_impact ?? 0),
      })),
    ];
  } catch {
    return [
      evidence({
        evidenceId: "db-project-control-evidence-unavailable",
        requirementIds: ["MEGS-DB-001", "MEGS-PCD-009"],
        evidenceClassification: "Unknown",
        lifecycleState: "unknown",
        sourceKind: "database",
        sourceLocator: "project_control_evidence",
        summary: "Project Control evidence table is unavailable or migration has not been applied.",
        confidenceImpact: -25,
        payload: { error: "unavailable" },
      }),
    ];
  }
}
