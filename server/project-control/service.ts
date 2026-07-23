import { sql } from "drizzle-orm";
import { db } from "../db";
import { FEATURE_FLAGS } from "../config/feature-flags";
import { loadGovernanceRequirements } from "./governance-loader";
import { scanDatabaseEvidence, scanDeploymentEvidence, scanRepositoryEvidence, scanTestEvidence } from "./scanners";
import { buildContinuationPrompt, buildSummary, calculateRequirementStatuses } from "./status-engine";
import type { ProjectEvidence } from "./types";

const SNAPSHOT_CACHE_TTL_MS = 30_000;
type ProjectControlSnapshot = Awaited<ReturnType<typeof buildUncachedProjectControlSnapshot>>;
let cachedSnapshot: { value: ProjectControlSnapshot; expiresAt: number } | null = null;
let snapshotInFlight: Promise<ProjectControlSnapshot> | null = null;

export async function isProjectControlEnabled(): Promise<boolean> {
  if (FEATURE_FLAGS.SUPER_ADMIN_PROJECT_CONTROL_ENABLED !== true) return false;
  try {
    const rows = await db.execute(sql`
      SELECT enabled
        FROM feature_overrides
       WHERE name = 'super_admin_project_control_enabled'
       LIMIT 1
    `);
    const row = rows.rows[0] as { enabled?: boolean } | undefined;
    if (!row) return true;
    return row.enabled === true;
  } catch {
    return false;
  }
}

async function buildUncachedProjectControlSnapshot() {
  const requirements = loadGovernanceRequirements();
  const [repositoryScan, deploymentScan, databaseEvidence] = await Promise.all([
    scanRepositoryEvidence(),
    scanDeploymentEvidence(),
    scanDatabaseEvidence(),
  ]);
  const evidence: ProjectEvidence[] = [
    ...repositoryScan.evidence,
    ...deploymentScan.evidence,
    ...scanTestEvidence(),
    ...databaseEvidence,
  ];
  const statuses = calculateRequirementStatuses(requirements, evidence);
  const summary = buildSummary({
    requirements,
    evidence,
    statuses,
    repository: repositoryScan.repository,
    production: deploymentScan.production,
  });
  const prompt = buildContinuationPrompt({ summary, requirements, statuses, evidence });

  return { requirements, evidence, statuses, summary, prompt };
}

/**
 * All GET endpoints share one short-lived, read-only scan. This bounds Git,
 * database, and deployment-version reads and prevents concurrent page queries
 * from producing inconsistent evidence snapshots.
 */
export async function buildProjectControlSnapshot(): Promise<ProjectControlSnapshot> {
  const now = Date.now();
  if (cachedSnapshot && cachedSnapshot.expiresAt > now) return cachedSnapshot.value;
  if (snapshotInFlight) return snapshotInFlight;

  snapshotInFlight = buildUncachedProjectControlSnapshot();
  try {
    const value = await snapshotInFlight;
    cachedSnapshot = { value, expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS };
    return value;
  } finally {
    snapshotInFlight = null;
  }
}

export function clearProjectControlSnapshotCache(): void {
  cachedSnapshot = null;
  snapshotInFlight = null;
}
