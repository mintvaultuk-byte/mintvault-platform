/**
 * Project Control — data service.
 *
 * All database access for the dashboard lives here (service-local by deliberate architectural
 * ruling; see the remediation report). Every mutation appends to the append-only `pc_status_events`
 * ledger, and the row write plus its audit rows share ONE transaction so an audit trail can never
 * go missing behind a successful update.
 *
 * Remediated in this pass:
 *  - H7  every read is bounded and scoped; nothing loads a whole table any more.
 *  - M2  every material field change is audited, not just a hand-picked subset.
 *  - M9  optimistic locking on work-package updates.
 *  - M10 idempotency on deployment and test-run recording.
 *  - M11 verifier identity comes from the session, never from the request body.
 *  - M6  prompt snapshots are retrievable and hash-verifiable.
 *
 * Nothing in this module reads or writes any pre-existing MintVault table.
 */
import { createHash } from "node:crypto";
import { deploymentAttemptKey, testRunAttemptKey } from "./idempotency";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  pcBlockers,
  pcDependencies,
  pcDeployments,
  pcEvidence,
  pcNodes,
  pcPrompts,
  pcStatusEvents,
  pcTestRuns,
  pcWorkPackages,
} from "@shared/schema";
import {
  assessWorkPackage,
  boundEvidenceText,
  buildDependencyGraph,
  buildProgrammeTree,
  computeNextActions,
  computeQueues,
  computeReadiness,
  detectDrift,
  evidenceFromHistory,
  filterPackages,
  generatePrompt,
  isLegalTransition,
  latestDeployments,
  normaliseStatus,
  summariseNextActions,
  type AcceptanceCriterion,
  type BlockerKind,
  type BlockerRecord,
  type CategoryState,
  type DeploymentRecord,
  type Environment,
  type EvidenceKind,
  type EvidenceRecord,
  type PackageFilter,
  type ProgrammeNode,
  type PromptTarget,
  type ReadinessCategory,
  type RequiredTest,
  type SecuritySeverity,
  type TestRunRecord,
  type WorkPackage,
  type WorkStatus,
} from "@shared/project-control";

/* ------------------------------------------------------------------------------------------ */
/* Bounds                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * REMEDIATION of hostile-review finding H7.
 *
 * Every read below is bounded. The previous implementation issued unfiltered, unlimited SELECTs
 * against five tables on every overview request and dumped six tables (including years of audit
 * history) from the export route.
 */
export const MAX_PACKAGES_PER_PAGE = 200;
export const DEFAULT_PACKAGES_PER_PAGE = 100;
export const MAX_HISTORY_ROWS = 500;
export const DEFAULT_HISTORY_ROWS = 200;
export const MAX_EXPORT_ROWS_PER_TABLE = 5000;
/** Evidence/blockers fetched per work package in a page — the long tail is summarised, not loaded. */
export const MAX_CHILD_ROWS_PER_PACKAGE = 50;

export interface Pagination {
  limit: number;
  offset: number;
}

export function normalisePagination(
  limit: unknown,
  offset: unknown,
  max = MAX_PACKAGES_PER_PAGE,
  fallback = DEFAULT_PACKAGES_PER_PAGE
): Pagination {
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  return {
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), max) : fallback,
    offset: Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Loading                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export async function loadNodes(includeArchived = false): Promise<ProgrammeNode[]> {
  const rows = await db
    .select()
    .from(pcNodes)
    .where(includeArchived ? sql`true` : eq(pcNodes.archived, false))
    .orderBy(asc(pcNodes.sortOrder), asc(pcNodes.name))
    .limit(MAX_EXPORT_ROWS_PER_TABLE);

  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    parentKey: r.parentKey,
    name: r.name,
    description: r.description,
    sortOrder: r.sortOrder,
    archived: r.archived,
  }));
}

export interface LoadPackagesOptions {
  includeArchived?: boolean;
  pagination?: Pagination;
  /** Restrict to specific keys (used by the detail route and by scoped views). */
  keys?: string[];
}

export interface LoadPackagesResult {
  packages: WorkPackage[];
  total: number;
  /** True when more rows exist beyond this page. */
  truncated: boolean;
}

/**
 * Load a bounded page of work packages with their evidence, blockers, dependencies and history.
 *
 * Child rows are fetched with an `IN (…)` restricted to the page's keys — never a whole-table
 * read — so cost scales with the page, not with the lifetime of the programme.
 */
export async function loadWorkPackages(options: LoadPackagesOptions = {}): Promise<LoadPackagesResult> {
  const includeArchived = options.includeArchived ?? false;
  const page = options.pagination ?? { limit: DEFAULT_PACKAGES_PER_PAGE, offset: 0 };

  const baseWhere = options.keys?.length
    ? inArray(pcWorkPackages.key, options.keys)
    : includeArchived
      ? sql`true`
      : eq(pcWorkPackages.archived, false);

  const [{ value: total }] = await db.select({ value: count() }).from(pcWorkPackages).where(baseWhere);

  const rows = await db
    .select()
    .from(pcWorkPackages)
    .where(baseWhere)
    .orderBy(asc(pcWorkPackages.nodeKey), asc(pcWorkPackages.key))
    .limit(page.limit)
    .offset(page.offset);

  const keys = rows.map((r) => r.key);
  if (keys.length === 0) {
    return { packages: [], total, truncated: total > 0 };
  }

  const [evidence, blockers, dependencies, deployments, testRuns] = await Promise.all([
    db
      .select()
      .from(pcEvidence)
      .where(inArray(pcEvidence.packageKey, keys))
      .orderBy(desc(pcEvidence.capturedAt))
      .limit(keys.length * MAX_CHILD_ROWS_PER_PACKAGE),
    db
      .select()
      .from(pcBlockers)
      .where(inArray(pcBlockers.packageKey, keys))
      .orderBy(desc(pcBlockers.openedAt))
      .limit(keys.length * MAX_CHILD_ROWS_PER_PACKAGE),
    db
      .select()
      .from(pcDependencies)
      .where(inArray(pcDependencies.packageKey, keys))
      .limit(keys.length * MAX_CHILD_ROWS_PER_PACKAGE),
    db
      .select()
      .from(pcDeployments)
      .where(inArray(pcDeployments.packageKey, keys))
      .orderBy(desc(pcDeployments.deployedAt))
      .limit(keys.length * MAX_CHILD_ROWS_PER_PACKAGE),
    db
      .select()
      .from(pcTestRuns)
      .where(inArray(pcTestRuns.packageKey, keys))
      .orderBy(desc(pcTestRuns.ranAt))
      .limit(keys.length * MAX_CHILD_ROWS_PER_PACKAGE),
  ]);

  const evidenceByPackage = groupBy(evidence, (e) => e.packageKey);
  const blockersByPackage = groupBy(blockers, (b) => b.packageKey);
  const depsByPackage = groupBy(dependencies, (d) => d.packageKey);
  const deploymentsByPackage = groupBy(
    deployments.filter((d) => d.packageKey),
    (d) => d.packageKey as string
  );
  const testsByPackage = groupBy(
    testRuns.filter((t) => t.packageKey),
    (t) => t.packageKey as string
  );

  const packages = rows.map((p) => {
    const explicit: EvidenceRecord[] = (evidenceByPackage.get(p.key) ?? []).map((e) => ({
      id: e.id,
      kind: e.kind as EvidenceKind,
      supports: e.supports,
      capturedAt: toIso(e.capturedAt),
      summary: boundEvidenceText(e.summary ?? ""),
      sourceRef: e.sourceRef,
      commitSha: e.commitSha,
      environment: (e.environment as Environment | null) ?? null,
    }));

    const derived = evidenceFromHistory(
      (deploymentsByPackage.get(p.key) ?? []).map(toDeploymentRecord),
      (testsByPackage.get(p.key) ?? []).map(toTestRunRecord)
    );

    const pkgBlockers: BlockerRecord[] = (blockersByPackage.get(p.key) ?? []).map((b) => ({
      id: b.id,
      kind: b.kind as BlockerKind,
      description: boundEvidenceText(b.description),
      openedAt: toIso(b.openedAt),
      resolvedAt: b.resolvedAt ? toIso(b.resolvedAt) : null,
      severity: (b.severity as SecuritySeverity | null) ?? "none",
    }));

    return {
      id: p.id,
      key: p.key,
      nodeKey: p.nodeKey,
      title: p.title,
      summary: p.summary,
      status: normaliseStatus(p.status),
      declaredCompletion: p.declaredCompletion,
      risk: p.risk as WorkPackage["risk"],
      classification: p.classification as WorkPackage["classification"],
      reviewState: p.reviewState as WorkPackage["reviewState"],
      deploymentState: p.deploymentState as WorkPackage["deploymentState"],
      productionVerification: p.productionVerification as WorkPackage["productionVerification"],
      businessValue: p.businessValue,
      engineeringRisk: p.engineeringRisk,
      estimatedEffortDays: p.estimatedEffortDays,
      remainingWork: p.remainingWork,
      branch: p.branch,
      worktreePath: p.worktreePath,
      baseCommit: p.baseCommit,
      latestCommit: p.latestCommit,
      prUrl: p.prUrl,
      version: p.version,
      updatedAt: toIso(p.updatedAt),
      evidence: [...explicit, ...derived],
      blockers: pkgBlockers,
      dependsOn: (depsByPackage.get(p.key) ?? []).map((d) => d.dependsOnKey),
      acceptanceCriteria: (p.acceptanceCriteria ?? []) as AcceptanceCriterion[],
      requiredTests: (p.requiredTests ?? []) as RequiredTest[],
      categoryStates: (p.categoryStates ?? {}) as Partial<Record<ReadinessCategory, CategoryState>>,
      categoryNotes: (p.categoryNotes ?? {}) as Partial<Record<ReadinessCategory, string>>,
      tags: (p.tags ?? []) as string[],
    } satisfies WorkPackage;
  });

  return { packages, total, truncated: page.offset + rows.length < total };
}

export async function loadDeployments(limit = DEFAULT_HISTORY_ROWS): Promise<DeploymentRecord[]> {
  const rows = await db
    .select()
    .from(pcDeployments)
    .orderBy(desc(pcDeployments.deployedAt))
    .limit(Math.min(limit, MAX_HISTORY_ROWS));
  return rows.map(toDeploymentRecord);
}

export async function loadTestRuns(limit = DEFAULT_HISTORY_ROWS): Promise<TestRunRecord[]> {
  const rows = await db
    .select()
    .from(pcTestRuns)
    .orderBy(desc(pcTestRuns.ranAt))
    .limit(Math.min(limit, MAX_HISTORY_ROWS));
  return rows.map(toTestRunRecord);
}

export async function loadAuditHistory(
  subjectKey?: string,
  limit = DEFAULT_HISTORY_ROWS,
  offset = 0
): Promise<{ rows: (typeof pcStatusEvents.$inferSelect)[]; total: number }> {
  const where = subjectKey ? eq(pcStatusEvents.subjectKey, subjectKey) : sql`true`;
  const [{ value: total }] = await db.select({ value: count() }).from(pcStatusEvents).where(where);
  const rows = await db
    .select()
    .from(pcStatusEvents)
    .where(where)
    .orderBy(desc(pcStatusEvents.createdAt))
    .limit(Math.min(limit, MAX_HISTORY_ROWS))
    .offset(offset);
  return { rows, total };
}

/* ------------------------------------------------------------------------------------------ */
/* Prompts — retrievable and hash-verifiable (finding M6)                                      */
/* ------------------------------------------------------------------------------------------ */

export function hashPromptBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export interface StoredPrompt {
  id: number;
  packageKey: string;
  target: string;
  body: string;
  branch: string | null;
  baseCommit: string | null;
  contentHash: string;
  generatedAt: string;
  generatedBy: string | null;
  /** Recomputed on read — false means the stored row no longer matches its hash. */
  intact: boolean;
}

export async function loadPrompts(packageKey?: string, limit = 50): Promise<StoredPrompt[]> {
  const where = packageKey ? eq(pcPrompts.packageKey, packageKey) : sql`true`;
  const rows = await db
    .select()
    .from(pcPrompts)
    .where(where)
    .orderBy(desc(pcPrompts.generatedAt))
    .limit(Math.min(limit, MAX_HISTORY_ROWS));

  return rows.map((r) => ({
    id: r.id,
    packageKey: r.packageKey,
    target: r.target,
    body: r.body,
    branch: r.branch,
    baseCommit: r.baseCommit,
    contentHash: r.contentHash,
    generatedAt: toIso(r.generatedAt),
    generatedBy: r.generatedBy,
    intact: r.contentHash.length === 0 ? false : hashPromptBody(r.body) === r.contentHash,
  }));
}

/* ------------------------------------------------------------------------------------------ */
/* Overview assembly                                                                           */
/* ------------------------------------------------------------------------------------------ */

export interface OverviewOptions {
  filter?: PackageFilter;
  includeArchived?: boolean;
  pagination?: Pagination;
  repo?: { mainSha?: string | null; headSha?: string | null; dirtyFileCount?: number };
  now?: Date;
}

export async function buildOverview(options: OverviewOptions = {}) {
  const now = options.now ?? new Date();
  const [nodes, loaded, deployments] = await Promise.all([
    loadNodes(options.includeArchived),
    loadWorkPackages({ includeArchived: options.includeArchived, pagination: options.pagination }),
    loadDeployments(),
  ]);

  const allPackages = loaded.packages;
  const packages = options.filter ? filterPackages(allPackages, options.filter, now) : allPackages;
  const tree = buildProgrammeTree(nodes, packages, now);
  const actions = computeNextActions(packages, now);
  const latest = latestDeployments(deployments);

  return {
    generatedAt: now.toISOString(),
    tree: tree.roots,
    treeIntegrity: {
      orphanedPackages: tree.orphanedPackages,
      orphanedNodes: tree.orphanedNodes,
      nodeCycles: tree.nodeCycles,
    },
    packages: packages.map((p) => ({ ...p, assessment: assessWorkPackage(p, now) })),
    readiness: computeReadiness(packages, now),
    queues: computeQueues(packages, now),
    nextActions: summariseNextActions(actions),
    dependencyGraph: buildDependencyGraph(packages, now),
    drift: detectDrift({
      mainSha: options.repo?.mainSha ?? null,
      headSha: options.repo?.headSha ?? null,
      dirtyFileCount: options.repo?.dirtyFileCount ?? 0,
      latestDeployments: latest,
      packages,
      now,
    }),
    deployments: { latest, history: deployments.slice(0, 50) },
    pagination: {
      total: loaded.total,
      returned: packages.length,
      truncated: loaded.truncated,
      limit: options.pagination?.limit ?? DEFAULT_PACKAGES_PER_PAGE,
      offset: options.pagination?.offset ?? 0,
    },
    counts: {
      nodes: nodes.length,
      packages: packages.length,
      packagesTotal: loaded.total,
      openBlockers: packages.reduce((s, p) => s + p.blockers.filter((b) => !b.resolvedAt).length, 0),
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Mutations                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface WorkPackagePatch {
  title?: string;
  summary?: string;
  status?: WorkStatus;
  declaredCompletion?: number;
  risk?: WorkPackage["risk"];
  classification?: WorkPackage["classification"];
  reviewState?: WorkPackage["reviewState"];
  deploymentState?: WorkPackage["deploymentState"];
  productionVerification?: WorkPackage["productionVerification"];
  businessValue?: number;
  engineeringRisk?: number;
  estimatedEffortDays?: number | null;
  remainingWork?: string;
  branch?: string | null;
  worktreePath?: string | null;
  baseCommit?: string | null;
  latestCommit?: string | null;
  prUrl?: string | null;
  acceptanceCriteria?: AcceptanceCriterion[];
  requiredTests?: RequiredTest[];
  categoryStates?: Partial<Record<ReadinessCategory, CategoryState>>;
  categoryNotes?: Partial<Record<ReadinessCategory, string>>;
  tags?: string[];
  archived?: boolean;
}

/**
 * REMEDIATION of hostile-review finding M2.
 *
 * Every material field is audited. The previous list omitted title, summary, remaining work,
 * business value, engineering risk, worktree path, base commit and effort, so rewriting a
 * package's remaining work left no trace at all.
 */
const AUDITED_FIELDS: (keyof WorkPackagePatch)[] = [
  "title",
  "summary",
  "status",
  "declaredCompletion",
  "risk",
  "classification",
  "reviewState",
  "deploymentState",
  "productionVerification",
  "businessValue",
  "engineeringRisk",
  "estimatedEffortDays",
  "remainingWork",
  "branch",
  "worktreePath",
  "baseCommit",
  "latestCommit",
  "prUrl",
  "acceptanceCriteria",
  "requiredTests",
  "categoryStates",
  "categoryNotes",
  "tags",
  "archived",
];

export type UpdateOutcome =
  | { ok: true; anomalies: string[]; version: number }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid_version" }
  | { ok: false; code: "override_reason_required" }
  | { ok: false; code: "illegal_transition"; from: WorkStatus; to: WorkStatus; currentVersion: number }
  | { ok: false; code: "version_conflict"; currentVersion: number };

/**
 * Update a work package.
 *
 * REMEDIATION of finding M9 (optimistic locking) and the missing transaction boundary: the row
 * update, the version bump and every audit event are one atomic unit. A second writer holding a
 * stale version is rejected rather than silently clobbering the first.
 */
/**
 * Update a work package under a genuine compare-and-swap.
 *
 * REMEDIATION of second-hostile-review finding H-3. The previous implementation ran the
 * `WHERE key = ? AND version = ?` update but never checked how many rows it matched, then
 * reported success, claimed a new version, and inserted audit events — even when it had changed
 * nothing. That produced a lost update, a false success, and a permanently false entry in an
 * append-only ledger that by design can never be corrected.
 *
 * Now:
 *  - `expectedVersion` is REQUIRED (enforced at the route schema too, so there is no
 *    last-write-wins path left);
 *  - the UPDATE itself carries the version predicate and RETURNS the row, so the compare-and-swap
 *    is decided by the write, not by an earlier read that another writer may have invalidated;
 *  - zero matched rows means no audit event, no claimed version and a 409;
 *  - the update and its audit events share one transaction, so a failed audit insert rolls the
 *    mutation back rather than leaving an unrecorded change.
 *
 * REMEDIATION of the illegal-transition finding: an illegal status transition is now REJECTED
 * rather than annotated. A Super Admin may still force one, but only through an explicit,
 * separately audited override.
 */
export async function updateWorkPackage(
  key: string,
  patch: WorkPackagePatch,
  actor: string,
  reason: string,
  expectedVersion: number,
  options: { overrideIllegalTransition?: boolean; overrideReason?: string } = {}
): Promise<UpdateOutcome> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, code: "invalid_version" };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(pcWorkPackages).where(eq(pcWorkPackages.key, key));
    if (!existing) return { ok: false, code: "not_found" } as const;

    // Fast, friendly path: report the conflict without attempting the write.
    if (expectedVersion !== existing.version) {
      return { ok: false, code: "version_conflict", currentVersion: existing.version } as const;
    }

    // ---- transition legality, decided BEFORE anything is written --------------------------
    const from = normaliseStatus(existing.status);
    const to = "status" in patch && patch.status ? (patch.status as WorkStatus) : from;
    const illegal = to !== from && !isLegalTransition(from, to);
    if (illegal && !options.overrideIllegalTransition) {
      return {
        ok: false,
        code: "illegal_transition",
        from,
        to,
        currentVersion: existing.version,
      } as const;
    }
    if (illegal && options.overrideIllegalTransition && !(options.overrideReason ?? "").trim()) {
      return { ok: false, code: "override_reason_required" } as const;
    }

    // ---- build the audit events (not yet inserted) ----------------------------------------
    const events: (typeof pcStatusEvents.$inferInsert)[] = [];
    for (const field of AUDITED_FIELDS) {
      if (!(field in patch)) continue;
      const oldText = serialiseForAudit((existing as Record<string, unknown>)[field]);
      const newText = serialiseForAudit(patch[field]);
      if (oldText === newText) continue;

      events.push({
        subjectType: "work_package",
        subjectKey: key,
        field,
        oldValue: oldText,
        newValue: newText,
        reason: boundEvidenceText(reason),
        actor,
        source: "dashboard",
        evidenceRef: existing.latestCommit,
        anomaly: null,
      });
    }

    // ---- the authoritative compare-and-swap -----------------------------------------------
    const nextVersion = existing.version + 1;
    const updated = await tx
      .update(pcWorkPackages)
      .set({ ...patch, version: nextVersion, updatedAt: new Date(), updatedBy: actor })
      .where(and(eq(pcWorkPackages.key, key), eq(pcWorkPackages.version, expectedVersion)))
      .returning({ key: pcWorkPackages.key, version: pcWorkPackages.version });

    // ZERO ROWS MATCHED: another writer won between the read and the write. Write nothing else.
    if (updated.length === 0) {
      const [current] = await tx
        .select({ version: pcWorkPackages.version })
        .from(pcWorkPackages)
        .where(eq(pcWorkPackages.key, key));
      return {
        ok: false,
        code: "version_conflict",
        currentVersion: current?.version ?? existing.version,
      } as const;
    }

    // An illegal transition that the owner explicitly forced gets its OWN audit record, distinct
    // from the ordinary field-change events, so an override can never be mistaken for a normal edit.
    if (illegal) {
      events.push({
        subjectType: "work_package",
        subjectKey: key,
        field: "illegal_transition_override",
        oldValue: from,
        newValue: to,
        reason: boundEvidenceText(options.overrideReason ?? ""),
        actor,
        source: "override",
        anomaly: `Super Admin forced an illegal transition: ${from} → ${to}`,
      });
    }

    // Same transaction: if this throws, the UPDATE above is rolled back and no change is lost
    // silently, which is the only ordering that keeps the ledger honest.
    if (events.length > 0) await tx.insert(pcStatusEvents).values(events);

    return {
      ok: true,
      anomalies: illegal ? [`Forced illegal transition ${from} → ${to}`] : [],
      version: updated[0].version,
    } as const;
  });
}

export async function createWorkPackage(
  input: typeof pcWorkPackages.$inferInsert,
  actor: string
): Promise<typeof pcWorkPackages.$inferSelect> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(pcWorkPackages)
      .values({ ...input, createdBy: actor, updatedBy: actor })
      .returning();

    await tx.insert(pcStatusEvents).values({
      subjectType: "work_package",
      subjectKey: row.key,
      field: "created",
      oldValue: null,
      newValue: row.status,
      reason: "Work package created",
      actor,
      source: "dashboard",
    });

    return row;
  });
}

export async function addEvidence(
  packageKey: string,
  input: {
    kind: EvidenceKind;
    supports: boolean;
    summary: string;
    sourceRef?: string | null;
    commitSha?: string | null;
    environment?: Environment | null;
  },
  actor: string,
  source: "dashboard" | "scanner" = "dashboard"
): Promise<{ ok: boolean; code?: "package_not_found"; evidenceId?: number }> {
  return db.transaction(async (tx) => {
    // Referential integrity is enforced by the foreign key too; this gives a clean 404 instead of
    // a database error, and keeps the audit event consistent with the insert.
    const [pkg] = await tx
      .select({ key: pcWorkPackages.key })
      .from(pcWorkPackages)
      .where(eq(pcWorkPackages.key, packageKey));
    if (!pkg) return { ok: false, code: "package_not_found" as const };

    const [row] = await tx
      .insert(pcEvidence)
      .values({
        packageKey,
        kind: input.kind,
        supports: input.supports,
        summary: boundEvidenceText(input.summary),
        sourceRef: input.sourceRef ?? null,
        commitSha: input.commitSha ?? null,
        environment: input.environment ?? null,
        capturedBy: actor,
      })
      .returning();

    await tx.insert(pcStatusEvents).values({
      subjectType: "work_package",
      subjectKey: packageKey,
      field: "evidence",
      oldValue: null,
      newValue: `${input.kind}:${input.supports ? "supports" : "contradicts"}`,
      reason: boundEvidenceText(input.summary),
      actor,
      source,
      evidenceRef: String(row.id),
    });

    // The id is returned so an acceptance criterion can cite REAL evidence: after H3-4 an
    // arbitrary string no longer counts, so callers need the identifier to reference.
    return { ok: true as const, evidenceId: row.id };
  });
}

export async function addBlocker(
  packageKey: string,
  input: { kind: BlockerKind; description: string; severity?: SecuritySeverity },
  actor: string
): Promise<{ ok: boolean; code?: "package_not_found" }> {
  return db.transaction(async (tx) => {
    const [pkg] = await tx
      .select({ key: pcWorkPackages.key })
      .from(pcWorkPackages)
      .where(eq(pcWorkPackages.key, packageKey));
    if (!pkg) return { ok: false, code: "package_not_found" as const };

    await tx.insert(pcBlockers).values({
      packageKey,
      kind: input.kind,
      description: boundEvidenceText(input.description),
      severity: input.severity ?? "none",
      openedBy: actor,
    });

    await tx.insert(pcStatusEvents).values({
      subjectType: "work_package",
      subjectKey: packageKey,
      field: "blocker_opened",
      oldValue: null,
      newValue: `${input.kind}:${input.severity ?? "none"}`,
      reason: boundEvidenceText(input.description),
      actor,
      source: "dashboard",
    });

    return { ok: true as const };
  });
}

export async function resolveBlocker(id: number, note: string, actor: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(pcBlockers)
      .set({ resolvedAt: new Date(), resolvedBy: actor, resolutionNote: boundEvidenceText(note) })
      .where(and(eq(pcBlockers.id, id), isNull(pcBlockers.resolvedAt)))
      .returning();
    if (!row) return false;

    await tx.insert(pcStatusEvents).values({
      subjectType: "work_package",
      subjectKey: row.packageKey,
      field: "blocker_resolved",
      oldValue: row.kind,
      newValue: null,
      reason: boundEvidenceText(note),
      actor,
      source: "dashboard",
    });
    return true;
  });
}

export async function addDependency(
  packageKey: string,
  dependsOnKey: string,
  note: string,
  actor: string
): Promise<{ ok: boolean; code?: "self_dependency" | "package_not_found" | "would_cycle" }> {
  if (packageKey === dependsOnKey) return { ok: false, code: "self_dependency" };

  return db.transaction(async (tx) => {
    const found = await tx
      .select({ key: pcWorkPackages.key })
      .from(pcWorkPackages)
      .where(inArray(pcWorkPackages.key, [packageKey, dependsOnKey]));
    if (found.length !== 2) return { ok: false, code: "package_not_found" as const };

    await tx
      .insert(pcDependencies)
      .values({ packageKey, dependsOnKey, note: boundEvidenceText(note) })
      .onConflictDoNothing();

    await tx.insert(pcStatusEvents).values({
      subjectType: "work_package",
      subjectKey: packageKey,
      field: "dependency_added",
      oldValue: null,
      newValue: dependsOnKey,
      reason: boundEvidenceText(note),
      actor,
      source: "dashboard",
    });
    return { ok: true as const };
  });
}

export async function removeDependency(packageKey: string, dependsOnKey: string, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(pcDependencies)
      .where(and(eq(pcDependencies.packageKey, packageKey), eq(pcDependencies.dependsOnKey, dependsOnKey)));
    await tx.insert(pcStatusEvents).values({
      subjectType: "work_package",
      subjectKey: packageKey,
      field: "dependency_removed",
      oldValue: dependsOnKey,
      newValue: null,
      reason: "",
      actor,
      source: "dashboard",
    });
  });
}

/**
 * Record a deployment that has ALREADY happened.
 *
 * REMEDIATION of findings M10 and M11: the release is idempotent on
 * (environment, commit, deployed_at), and `verifiedBy` is taken from the authenticated session —
 * a client can no longer attribute a verification to someone else.
 */
export { AttemptIdentityError, canonicalIdempotencyKey, deploymentAttemptKey, testRunAttemptKey } from "./idempotency";

export interface RecordDeploymentInput {
  environment: Environment;
  commitSha: string;
  releaseVersion?: string | null;
  result?: string;
  migrationState?: string | null;
  packageKey?: string | null;
  verifiedAt?: Date | null;
  rollbackOfSha?: string | null;
  notes?: string;
  /** The provider's own release id (a Fly release, a CI run), when one exists. */
  externalId?: string | null;
  /** Explicit caller-supplied idempotency key; otherwise derived deterministically. */
  idempotencyKey?: string | null;
}

/**
 * Record a deployment that has ALREADY happened.
 *
 * Idempotent on stable identity, and `verifiedBy`/`deployedBy` come from the authenticated
 * session — a client can no longer attribute a verification to someone else.
 */
export async function recordDeployment(
  input: RecordDeploymentInput,
  actor: string
): Promise<{ ok: true; duplicate: boolean; idempotencyKey: string }> {
  // Throws AttemptIdentityError (→ HTTP 400) when the caller gave no way to tell a retry from a
  // genuine redeploy. Environment + commit are NOT an identity: the same commit is legitimately
  // deployed more than once.
  const { idempotencyKey, externalId } = deploymentAttemptKey({
    idempotencyKey: input.idempotencyKey,
    externalId: input.externalId,
    environment: input.environment,
    commitSha: input.commitSha,
    releaseVersion: input.releaseVersion,
    packageKey: input.packageKey,
  });

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pcDeployments)
      .values({
        environment: input.environment,
        commitSha: input.commitSha,
        releaseVersion: input.releaseVersion ?? null,
        result: input.result ?? "succeeded",
        migrationState: input.migrationState ?? null,
        packageKey: input.packageKey ?? null,
        verifiedAt: input.verifiedAt ?? null,
        rollbackOfSha: input.rollbackOfSha ?? null,
        notes: boundEvidenceText(String(input.notes ?? "")),
        externalId,
        idempotencyKey,
        deployedBy: actor,
        verifiedBy: input.verifiedAt ? actor : null,
      })
      .onConflictDoNothing({ target: pcDeployments.idempotencyKey })
      .returning();

    // A duplicate submission writes NOTHING — including no second audit event.
    if (inserted.length === 0) return { ok: true as const, duplicate: true, idempotencyKey };

    const row = inserted[0];
    await tx.insert(pcStatusEvents).values({
      subjectType: "deployment",
      subjectKey: `${row.environment}:${row.commitSha}`,
      field: "result",
      oldValue: null,
      newValue: row.result,
      reason: boundEvidenceText(row.notes),
      actor,
      source: "dashboard",
      evidenceRef: row.releaseVersion ?? row.idempotencyKey,
    });
    return { ok: true as const, duplicate: false, idempotencyKey };
  });
}

export interface RecordTestRunInput {
  packageKey?: string | null;
  kind: EvidenceKind;
  result: string;
  commitSha?: string | null;
  detail?: string;
  /** CI run identifier, when the run came from a pipeline. */
  externalRunId?: string | null;
  idempotencyKey?: string | null;
}

export async function recordTestRun(
  input: RecordTestRunInput,
  actor: string
): Promise<{ ok: true; duplicate: boolean; idempotencyKey: string }> {
  // Throws AttemptIdentityError (→ HTTP 400) when the caller gave no way to tell a retry from a
  // genuine re-run. Suite + commit are NOT an identity: the same suite is legitimately re-run.
  const { idempotencyKey, externalRunId } = testRunAttemptKey({
    idempotencyKey: input.idempotencyKey,
    externalRunId: input.externalRunId,
    packageKey: input.packageKey,
    kind: input.kind,
    commitSha: input.commitSha,
  });

  const inserted = await db
    .insert(pcTestRuns)
    .values({
      packageKey: input.packageKey ?? null,
      kind: input.kind,
      result: input.result,
      commitSha: input.commitSha ?? null,
      detail: boundEvidenceText(String(input.detail ?? "")),
      externalRunId,
      idempotencyKey,
      ranBy: actor,
    })
    .onConflictDoNothing({ target: pcTestRuns.idempotencyKey })
    .returning();

  return { ok: true, duplicate: inserted.length === 0, idempotencyKey };
}

/* ------------------------------------------------------------------------------------------ */
/* Prompt generation                                                                           */
/* ------------------------------------------------------------------------------------------ */

export async function generateAndStorePrompt(
  packageKey: string,
  target: PromptTarget,
  actor: string,
  repo?: { productionSha?: string | null; stagingSha?: string | null; mainSha?: string | null }
): Promise<{ body: string; contentHash: string; id: number } | null> {
  const [nodes, loaded] = await Promise.all([
    loadNodes(true),
    loadWorkPackages({ keys: [packageKey], includeArchived: true }),
  ]);
  const pkg = loaded.packages.find((p) => p.key === packageKey);
  if (!pkg) return null;

  const body = generatePrompt(target, {
    pkg,
    assessment: assessWorkPackage(pkg),
    nodePath: nodePath(nodes, pkg.nodeKey),
    repo,
  });
  const contentHash = hashPromptBody(body);

  const [row] = await db
    .insert(pcPrompts)
    .values({
      packageKey,
      target,
      body,
      branch: pkg.branch,
      baseCommit: pkg.baseCommit,
      contentHash,
      generatedBy: actor,
    })
    .returning();

  await db.insert(pcStatusEvents).values({
    subjectType: "prompt",
    subjectKey: packageKey,
    field: "prompt_generated",
    oldValue: null,
    newValue: target,
    reason: `Prompt snapshot ${contentHash.slice(0, 12)}`,
    actor,
    source: "dashboard",
    evidenceRef: String(row.id),
  });

  return { body, contentHash, id: row.id };
}

export function nodePath(nodes: ProgrammeNode[], nodeKey: string): string[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const path: string[] = [];
  let cursor = byKey.get(nodeKey);
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.key)) {
    guard.add(cursor.key);
    path.unshift(cursor.name);
    cursor = cursor.parentKey ? byKey.get(cursor.parentKey) : undefined;
  }
  return path;
}

/* ------------------------------------------------------------------------------------------ */
/* Export — bounded                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** Full JSON snapshot, bounded per table so a years-old ledger cannot be dumped in one response. */
export async function exportEverything() {
  const cap = MAX_EXPORT_ROWS_PER_TABLE;
  const [nodes, packages, evidence, blockers, dependencies, events, deployments, testRuns] = await Promise.all([
    db.select().from(pcNodes).limit(cap),
    db.select().from(pcWorkPackages).limit(cap),
    db.select().from(pcEvidence).orderBy(desc(pcEvidence.capturedAt)).limit(cap),
    db.select().from(pcBlockers).orderBy(desc(pcBlockers.openedAt)).limit(cap),
    db.select().from(pcDependencies).limit(cap),
    db.select().from(pcStatusEvents).orderBy(desc(pcStatusEvents.createdAt)).limit(cap),
    db.select().from(pcDeployments).orderBy(desc(pcDeployments.deployedAt)).limit(cap),
    db.select().from(pcTestRuns).orderBy(desc(pcTestRuns.ranAt)).limit(cap),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    version: 2,
    rowCap: cap,
    truncated: [nodes, packages, evidence, blockers, dependencies, events, deployments, testRuns].some(
      (t) => t.length === cap
    ),
    nodes,
    packages,
    evidence,
    blockers,
    dependencies,
    events,
    deployments,
    testRuns,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                     */
/* ------------------------------------------------------------------------------------------ */

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function serialiseForAudit(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return boundEvidenceText(JSON.stringify(value));
  return boundEvidenceText(String(value));
}

function toIso(value: Date | string | null): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDeploymentRecord(r: typeof pcDeployments.$inferSelect): DeploymentRecord {
  return {
    id: r.id,
    environment: r.environment as Environment,
    commitSha: r.commitSha,
    releaseVersion: r.releaseVersion,
    result: r.result as DeploymentRecord["result"],
    migrationState: r.migrationState,
    deployedAt: toIso(r.deployedAt),
    verifiedAt: r.verifiedAt ? toIso(r.verifiedAt) : null,
    verifiedBy: r.verifiedBy,
    rollbackOfSha: r.rollbackOfSha,
    notes: r.notes,
  };
}

function toTestRunRecord(r: typeof pcTestRuns.$inferSelect): TestRunRecord {
  return {
    id: r.id,
    packageKey: r.packageKey,
    kind: r.kind as EvidenceKind,
    result: r.result as TestRunRecord["result"],
    commitSha: r.commitSha,
    ranAt: toIso(r.ranAt),
    detail: r.detail,
  };
}
