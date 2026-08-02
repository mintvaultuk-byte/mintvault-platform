/**
 * Super Admin Project Control API.
 *
 * Every route is (1) behind the fail-closed `super_admin_project_control_enabled` flag and
 * (2) Super-Admin only. The dashboard is a READ-AND-RECORD surface: it records what happened
 * (a deployment, a test run, a status change) but it cannot CAUSE any protected action. There is
 * no route here that pushes, merges, deploys, applies a migration, writes to production, or
 * touches any pre-existing MintVault table.
 *
 * Route inventory — 35 endpoints (kept in step with the router by a test that counts registrations):
 *   GET    /overview                                  tree + readiness + queues + drift
 *   GET    /queues                                    the nine approved queues
 *   GET    /drift                                     repository-versus-environment drift
 *   GET    /packages/:key                             one work package in detail
 *   POST   /packages                                  create
 *   PUT    /packages/:key                             update (optimistic-locked, audited)
 *   POST   /packages/:key/evidence                    record evidence
 *   POST   /packages/:key/blockers                    open a blocker
 *   POST   /blockers/:id/resolve                      resolve a blocker
 *   POST   /packages/:key/dependencies                add a dependency
 *   DELETE /packages/:key/dependencies/:dependsOn     remove a dependency
 *   POST   /packages/:key/prompt                      generate a continuation prompt
 *   GET    /packages/:key/prompts                     retrieve stored prompt snapshots
 *   GET    /prompts                                   all recent prompt snapshots
 *   GET    /repository                                read-only git/worktree/migration scan
 *   GET    /evidence-scan                             automatic database/deployment/test scan
 *   GET    /deployments                               deployment history
 *   POST   /deployments                               record a deployment that already happened
 *   GET    /tests                                     test/gate history
 *   POST   /tests                                     record a test result
 *   GET    /audit                                     append-only status history
 *   GET    /views/shop-launch                         Partner Shop Launch view
 *   GET    /views/scanner                             Scanner view
 *   GET    /views/distributed-shop-launch             live-evidence programme lanes
 *   GET    /github                                    live GitHub evidence + freshness
 *   GET    /live-evidence                             GitHub + application + flag evidence, one view
 *   POST   /sync/github                               start a durable GitHub sync (202)
 *   GET    /sync/latest                               most recent durable sync run
 *   GET    /sync/:syncId                              one durable sync run by id
 *   POST   /sync/applications                         probe + store both application versions
 *   POST   /sync/flags                                store this environment's flag evidence
 *   POST   /sync/databases                            store this environment's migration evidence
 *   GET    /composed-overview                         the composed DTO; stored evidence only
 *   GET    /seed/status                               applied seed version + drift
 *   POST   /seed/dry-run                              preview; writes nothing
 *   POST   /seed/apply                                execute a previewed plan
 *   POST   /seed/report/latest                        latest reconciliation run
 *   GET    /export                                    bounded JSON snapshot
 *   POST   /seed                                      idempotent programme-tree seed
 */
import type { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z, ZodError } from "zod";
import { classifyFreshness } from "@shared/project-control-github";
import { requireSuperAdmin } from "../../auth";
import { buildDistributedProgrammeView } from "../../project-control/distributed";
import { isGitHubConfigured, scanGitHub } from "../../project-control/github-scan";
import { resolveConnectedEnvironment } from "../../project-control/migration-scan";
import {
  SeedApplyError,
  applySeed,
  dryRunSeed,
  loadLatestRun,
  loadSeedStatus,
} from "../../project-control/seed-repository";
import { currentSeedManifest, currentSeedManifestDigest } from "../../project-control/seed-manifest-source";
import { compareDeployment, probeAllApplications } from "../../project-control/app-probe";
import { collectFlagEvidence } from "../../project-control/flag-evidence";
import { pool } from "../../db";
import { beginGitHubSync, runGitHubSync, GITHUB_SOURCE } from "../../project-control/github-sync-service";
import { getLatestRun, getRun, getActiveRun } from "../../project-control/evidence-repository";
import {
  collectApplicationEvidence,
  collectFlagEvidenceSnapshots,
} from "../../project-control/probe-persistence";
import { collectAndStoreDatabaseEvidence } from "../../project-control/database-evidence";
import { buildComposedOverview } from "../../project-control/overview-service";
import {
  BLOCKER_KINDS,
  DEPLOYMENT_RESULTS,
  DEPLOYMENT_STATES,
  ENVIRONMENTS,
  EVIDENCE_CONFIDENCES,
  EVIDENCE_KINDS,
  ISSUE_CLASSES,
  PRODUCTION_VERIFICATIONS,
  PROMPT_TARGETS,
  QUEUE_KEYS,
  READINESS_CATEGORIES,
  REVIEW_STATES,
  RISK_LEVELS,
  SECURITY_SEVERITIES,
  CATEGORY_STATES,
  TEST_RESULTS,
  WORK_STATUSES,
  assessWorkPackage,
  computeNextActions,
  computeQueues,
  computeReadiness,
  detectDrift,
  latestDeployments,
  redactSecrets,
  summariseNextActions,
  type PackageFilter,
} from "@shared/project-control";
import {
  addBlocker,
  addDependency,
  addEvidence,
  buildOverview,
  createWorkPackage,
  exportEverything,
  generateAndStorePrompt,
  loadAuditHistory,
  loadDeployments,
  loadNodes,
  loadPrompts,
  loadTestRuns,
  loadWorkPackages,
  nodePath,
  normalisePagination,
  recordDeployment,
  recordTestRun,
  removeDependency,
  resolveBlocker,
  updateWorkPackage,
} from "../../project-control/service";
import { scanRepository } from "../../project-control/repo-scan";
import { scanAllEvidence } from "../../project-control/evidence-scan";
import { seedProgrammeTree } from "../../project-control/seed";
import { isProjectControlEnabled, projectControlDisabledPayload } from "../../project-control/flag";
import { AttemptIdentityError } from "../../project-control/idempotency";

const BASE = "/api/admin/project-control";

const projectControlWriteLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many Project Control changes. Please wait a few minutes and try again." },
});

/**
 * Ordinary dashboard reads. Generous — this is a single-operator console that polls — but no
 * longer unbounded.
 */
const projectControlReadLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many Project Control requests. Please wait a moment." },
});

/**
 * Expensive operations that spawn git subprocesses or sweep the database.
 *
 * REMEDIATION: `GET /repository?refresh=true` previously bypassed the cache on every request, so
 * a held-down refresh key span up unbounded `git` subprocesses. The limiter here is the outer
 * bound; `scanRepository` additionally enforces a server-side minimum interval and coalesces
 * concurrent refreshes into a single in-flight scan.
 */
const projectControlExpensiveLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Refresh is rate limited. The repository scan is expensive, and the cached view is still current.",
  },
});

/**
 * REMEDIATION of hostile-review finding H9.
 *
 * FAIL CLOSED. Runs BEFORE requireSuperAdmin so a disabled environment cannot even be probed for
 * the existence of data, and returns 404 — a disabled feature should be indistinguishable from an
 * absent one to anyone who is not already an operator reading the body.
 */
function requireProjectControlEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (!isProjectControlEnabled()) {
    res.status(404).json(projectControlDisabledPayload());
    return;
  }
  next();
}

/** Every route is registered through this pair, so neither gate can be forgotten. */
const gated = [requireProjectControlEnabled, requireSuperAdmin, projectControlReadLimit] as const;

/** Gate for routes that spawn subprocesses or sweep whole tables. */
const gatedExpensive = [requireProjectControlEnabled, requireSuperAdmin, projectControlExpensiveLimit] as const;

/**
 * Project a run for the wire.
 *
 * Deliberately omits snapshot payloads and anything configuration-shaped. `errorCode` is a short
 * stable code chosen by the sync service, never a raw exception — a database or fetch error can
 * carry a DSN or a token, and this response is the one place a Super Admin's browser would see it.
 */
function toSyncStatus(
  run: {
    syncId: string;
    sourceType: string;
    triggerType: string;
    state: string;
    requestedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    counts: Record<string, unknown>;
    warnings: unknown[];
    errorCode: string | null;
  },
  activeSyncId: string | null
) {
  return {
    syncId: run.syncId,
    source: run.sourceType,
    trigger: run.triggerType,
    state: run.state,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    counts: run.counts,
    warnings: (run.warnings ?? []).slice(0, 20),
    errorCode: run.errorCode,
    activeSyncId,
    anotherRunActive: Boolean(activeSyncId && activeSyncId !== run.syncId),
  };
}

/** The Super Admin's email, for the run's audit trail. Never a credential. */
function actor_(req: { session?: unknown }): string {
  return ((req.session as { adminEmail?: string } | undefined)?.adminEmail || "super-admin").slice(0, 120);
}

function actor(req: Request): string {
  return (req.session as { adminEmail?: string } | undefined)?.adminEmail || "admin";
}

/**
 * Every error leaving this router is redacted BEFORE it is logged.
 *
 * A driver error can carry a full connection string, and a provider error can carry a key. The
 * response body stays deliberately generic; the log line is redacted so an operator gets a useful
 * message without a credential ending up in the log store.
 */
/**
 * Apply takes exactly one field: the confirmation issued by a dry run. Deliberately `.strict()`,
 * so a body carrying a manifest, a version, an environment or a force flag is REJECTED rather
 * than quietly ignored — a silently-dropped override reads to the caller as an accepted one.
 */
const seedApplySchema = z.object({ confirmationToken: z.string().min(16).max(200) }).strict();

/**
 * Project a seed error as a STABLE CODE.
 *
 * SeedApplyError already carries an operator-safe message and never wraps raw driver text — the
 * repository discards that at the boundary. This maps each code to the status an operator can act
 * on, and anything unrecognised falls through to the generic redacted handler rather than being
 * echoed. No SQL, stack trace, driver error, database name or connection string can leave here.
 */
function seedFail(res: Response, error: unknown): void {
  if (error instanceof SeedApplyError) {
    const status =
      error.code === "production_blocked"
        ? 403
        : error.code === "already_running"
          ? 409
          : error.code === "digest_mismatch" || error.code === "version_mismatch" || error.code === "conflicts"
            ? 409
            : error.code === "schema_absent"
              ? 503
              : 500;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  fail(res, error);
}

function fail(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Invalid request", details: error.flatten() });
    return;
  }
  /**
   * REMEDIATION H3-2. A missing or malformed attempt identity is the caller's mistake, not a
   * server fault, and it must be visible rather than silently merged into an earlier event.
   */
  if (error instanceof AttemptIdentityError) {
    res.status(400).json({ error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("[project-control]", redactSecrets(message));
  res.status(500).json({ error: "Project Control request failed" });
}

/* ------------------------------------------------------------------------------------------ */
/* Validation                                                                                  */
/* ------------------------------------------------------------------------------------------ */

const keySchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Keys are lower-case letters, numbers and hyphens.");

const reasonSchema = z.string().max(500).default("");

const acceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(2000),
  met: z.boolean().default(false),
  evidenceRef: z.string().max(200).nullable().optional(),
});

const requiredTestSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  kind: z.enum(EVIDENCE_KINDS),
});

const categoryStatesSchema = z.record(z.enum(READINESS_CATEGORIES), z.enum(CATEGORY_STATES));
const categoryNotesSchema = z.record(z.enum(READINESS_CATEGORIES), z.string().max(1000));

const packagePatchSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  summary: z.string().max(4000).optional(),
  status: z.enum(WORK_STATUSES).optional(),
  declaredCompletion: z.number().int().min(0).max(100).optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  classification: z.enum(ISSUE_CLASSES).optional(),
  reviewState: z.enum(REVIEW_STATES).optional(),
  deploymentState: z.enum(DEPLOYMENT_STATES).optional(),
  productionVerification: z.enum(PRODUCTION_VERIFICATIONS).optional(),
  businessValue: z.number().int().min(1).max(5).optional(),
  engineeringRisk: z.number().int().min(1).max(5).optional(),
  estimatedEffortDays: z.number().int().min(0).max(3650).nullable().optional(),
  remainingWork: z.string().max(8000).optional(),
  branch: z.string().max(200).nullable().optional(),
  worktreePath: z.string().max(500).nullable().optional(),
  baseCommit: z.string().max(64).nullable().optional(),
  latestCommit: z.string().max(64).nullable().optional(),
  prUrl: z.string().max(500).nullable().optional(),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100).optional(),
  requiredTests: z.array(requiredTestSchema).max(50).optional(),
  categoryStates: categoryStatesSchema.optional(),
  categoryNotes: categoryNotesSchema.optional(),
  tags: z.array(z.string().max(64)).max(30).optional(),
  archived: z.boolean().optional(),
  reason: reasonSchema,
  /**
   * Optimistic-locking token read with the row. MANDATORY on update — remediation of H-3, which
   * proved that an optional token left a last-write-wins path open.
   */
  expectedVersion: z.number().int().min(1).max(2_000_000_000),
  /** Explicit, separately audited Super Admin override for an illegal status transition. */
  overrideIllegalTransition: z.boolean().optional(),
  overrideReason: z.string().max(500).optional(),
});

const createPackageSchema = packagePatchSchema
  .omit({ expectedVersion: true, overrideIllegalTransition: true, overrideReason: true })
  .extend({
    key: keySchema,
    nodeKey: keySchema,
    title: z.string().min(1).max(160),
  });

const evidenceSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  supports: z.boolean().default(true),
  summary: z.string().min(1).max(2000),
  sourceRef: z.string().max(500).nullable().optional(),
  commitSha: z.string().max(64).nullable().optional(),
  environment: z.enum(ENVIRONMENTS).nullable().optional(),
});

const blockerSchema = z.object({
  kind: z.enum(BLOCKER_KINDS),
  description: z.string().min(1).max(2000),
  severity: z.enum(SECURITY_SEVERITIES).default("none"),
});

/**
 * `verifiedBy` and `deployedBy` are deliberately ABSENT — remediation of finding M11. Both are
 * derived from the authenticated session inside the service, so a client cannot attribute a
 * verification to another person.
 */
const deploymentSchema = z.object({
  environment: z.enum(ENVIRONMENTS),
  commitSha: z.string().min(7).max(64),
  releaseVersion: z.string().max(64).nullable().optional(),
  result: z.enum(DEPLOYMENT_RESULTS).default("succeeded"),
  migrationState: z.string().max(1000).nullable().optional(),
  packageKey: keySchema.nullable().optional(),
  verifiedAt: z.string().datetime().nullable().optional(),
  rollbackOfSha: z.string().max(64).nullable().optional(),
  notes: z.string().max(4000).default(""),
  /**
   * ATTEMPT IDENTITY (H3-2). One of `externalId` or `idempotencyKey` is REQUIRED — enforced in
   * `deploymentAttemptKey`, not here, so the service is safe when called directly too. Without
   * one there is no way to tell a retried submission from a genuine redeploy of the same commit.
   */
  externalId: z.string().max(200).nullable().optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,200}$/, "8-200 characters of letters, numbers, dot, colon, dash or underscore.")
    .nullable()
    .optional(),
});

const testRunSchema = z.object({
  packageKey: keySchema.nullable().optional(),
  kind: z.enum(EVIDENCE_KINDS),
  result: z.enum(TEST_RESULTS),
  commitSha: z.string().max(64).nullable().optional(),
  detail: z.string().max(8000).default(""),
  /** ATTEMPT IDENTITY (H3-2): one of `externalRunId` or `idempotencyKey` is REQUIRED. */
  externalRunId: z.string().max(200).nullable().optional(),
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,200}$/, "8-200 characters of letters, numbers, dot, colon, dash or underscore.")
    .nullable()
    .optional(),
});

function parseFilter(req: Request): PackageFilter {
  const list = (value: unknown): string[] | undefined => {
    if (typeof value !== "string" || value.length === 0) return undefined;
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40);
  };
  const q = req.query as Record<string, unknown>;
  const queue =
    typeof q.queue === "string" && (QUEUE_KEYS as readonly string[]).includes(q.queue)
      ? (q.queue as PackageFilter["queue"])
      : undefined;
  return {
    search: typeof q.search === "string" ? q.search.slice(0, 200) : undefined,
    statuses: list(q.status)?.filter((s): s is (typeof WORK_STATUSES)[number] =>
      (WORK_STATUSES as readonly string[]).includes(s)
    ),
    confidences: list(q.confidence)?.filter((s): s is (typeof EVIDENCE_CONFIDENCES)[number] =>
      (EVIDENCE_CONFIDENCES as readonly string[]).includes(s)
    ),
    risks: list(q.risk)?.filter((s): s is (typeof RISK_LEVELS)[number] =>
      (RISK_LEVELS as readonly string[]).includes(s)
    ),
    classifications: list(q.classification)?.filter((s): s is (typeof ISSUE_CLASSES)[number] =>
      (ISSUE_CLASSES as readonly string[]).includes(s)
    ),
    nodeKeys: list(q.node),
    tags: list(q.tag),
    queue,
    blockedOnly: q.blocked === "true",
    ownerActionOnly: q.ownerAction === "true",
  };
}

function pagination(req: Request) {
  const q = req.query as Record<string, unknown>;
  return normalisePagination(q.limit, q.offset);
}

/* ------------------------------------------------------------------------------------------ */
/* Routes                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export function registerProjectControlRoutes(app: Express): void {
  app.get(`${BASE}/overview`, ...gated, async (req, res) => {
    try {
      const scan = await scanRepository().catch(() => null);
      res.json(
        await buildOverview({
          filter: parseFilter(req),
          includeArchived: req.query.includeArchived === "true",
          pagination: pagination(req),
          repo: {
            mainSha: scan?.mainSha ?? null,
            headSha: scan?.headCommit ?? null,
            dirtyFileCount: scan?.dirtyFileCount ?? 0,
          },
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/queues`, ...gated, async (req, res) => {
    try {
      const loaded = await loadWorkPackages({ pagination: pagination(req) });
      res.json({
        generatedAt: new Date().toISOString(),
        queues: computeQueues(loaded.packages),
        pagination: { total: loaded.total, returned: loaded.packages.length, truncated: loaded.truncated },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/drift`, ...gated, async (_req, res) => {
    try {
      const [scan, deployments, loaded] = await Promise.all([
        scanRepository().catch(() => null),
        loadDeployments(),
        loadWorkPackages({}),
      ]);
      res.json(
        detectDrift({
          mainSha: scan?.mainSha ?? null,
          headSha: scan?.headCommit ?? null,
          dirtyFileCount: scan?.dirtyFileCount ?? 0,
          latestDeployments: latestDeployments(deployments),
          packages: loaded.packages,
        })
      );
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/packages/:key`, ...gated, async (req, res) => {
    try {
      const key = keySchema.parse(req.params.key);
      const [nodes, loaded] = await Promise.all([
        loadNodes(true),
        loadWorkPackages({ keys: [key], includeArchived: true }),
      ]);
      const pkg = loaded.packages.find((p) => p.key === key);
      if (!pkg) {
        res.status(404).json({ error: "Work package not found" });
        return;
      }
      const [audit, tests] = await Promise.all([loadAuditHistory(key), loadTestRuns()]);
      res.json({
        package: pkg,
        assessment: assessWorkPackage(pkg),
        readiness: computeReadiness([pkg]),
        nodePath: nodePath(nodes, pkg.nodeKey),
        nextActions: computeNextActions([pkg]),
        audit: audit.rows,
        auditTotal: audit.total,
        tests: tests.filter((t) => t.packageKey === key),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/packages`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const { reason: _reason, ...input } = createPackageSchema.parse(req.body);
      const row = await createWorkPackage(input, actor(req));
      res.status(201).json(row);
    } catch (error) {
      fail(res, error);
    }
  });

  app.put(`${BASE}/packages/:key`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const key = keySchema.parse(req.params.key);
      const { reason, expectedVersion, overrideIllegalTransition, overrideReason, ...patch } = packagePatchSchema.parse(
        req.body
      );
      const result = await updateWorkPackage(key, patch, actor(req), reason, expectedVersion, {
        overrideIllegalTransition,
        overrideReason,
      });

      if (!result.ok) {
        switch (result.code) {
          case "not_found":
            res.status(404).json({ error: "Work package not found" });
            return;
          case "invalid_version":
            res.status(400).json({ error: "expectedVersion must be a positive whole number." });
            return;
          case "override_reason_required":
            res.status(422).json({
              error: "Forcing an unusual status change requires a reason, which is recorded against your name.",
            });
            return;
          case "illegal_transition":
            res.status(409).json({
              error: `"${result.from}" cannot move straight to "${result.to}". Nothing was changed. If this is genuinely correct, resend with overrideIllegalTransition and a reason — the override is recorded separately in the history.`,
              from: result.from,
              to: result.to,
              currentVersion: result.currentVersion,
            });
            return;
          case "version_conflict":
            res.status(409).json({
              error:
                "This work package changed while you were editing it. Nothing was saved. Reload before saving so you do not overwrite someone else's change.",
              currentVersion: result.currentVersion,
            });
            return;
        }
      }
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/packages/:key/evidence`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const key = keySchema.parse(req.params.key);
      const result = await addEvidence(key, evidenceSchema.parse(req.body), actor(req));
      if (!result.ok) {
        res.status(404).json({ error: "Work package not found" });
        return;
      }
      // `evidenceId` is returned so the caller can cite this record from an acceptance criterion.
      res.status(201).json({ ok: true, evidenceId: result.evidenceId });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/packages/:key/blockers`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const key = keySchema.parse(req.params.key);
      const result = await addBlocker(key, blockerSchema.parse(req.body), actor(req));
      if (!result.ok) {
        res.status(404).json({ error: "Work package not found" });
        return;
      }
      res.status(201).json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/blockers/:id/resolve`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const id = z.coerce.number().int().positive().parse(req.params.id);
      const note = z.object({ note: z.string().max(2000).default("") }).parse(req.body).note;
      const ok = await resolveBlocker(id, note, actor(req));
      if (!ok) {
        res.status(404).json({ error: "Open blocker not found" });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/packages/:key/dependencies`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const key = keySchema.parse(req.params.key);
      const body = z.object({ dependsOnKey: keySchema, note: z.string().max(1000).default("") }).parse(req.body);
      const result = await addDependency(key, body.dependsOnKey, body.note, actor(req));
      if (!result.ok) {
        const status = result.code === "package_not_found" ? 404 : 400;
        res.status(status).json({ error: result.code });
        return;
      }
      res.status(201).json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  app.delete(`${BASE}/packages/:key/dependencies/:dependsOn`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      await removeDependency(keySchema.parse(req.params.key), keySchema.parse(req.params.dependsOn), actor(req));
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/packages/:key/prompt`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const key = keySchema.parse(req.params.key);
      const { target } = z.object({ target: z.enum(PROMPT_TARGETS) }).parse(req.body);
      const scan = await scanRepository().catch(() => null);
      const result = await generateAndStorePrompt(key, target, actor(req), { mainSha: scan?.mainSha ?? null });
      if (!result) {
        res.status(404).json({ error: "Work package not found" });
        return;
      }
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/packages/:key/prompts`, ...gated, async (req, res) => {
    try {
      res.json(await loadPrompts(keySchema.parse(req.params.key)));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/prompts`, ...gated, async (_req, res) => {
    try {
      res.json(await loadPrompts(undefined));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/repository`, ...gatedExpensive, async (req, res) => {
    try {
      res.json(await scanRepository(req.query.refresh === "true"));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/evidence-scan`, ...gatedExpensive, async (_req, res) => {
    try {
      res.json(await scanAllEvidence());
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/deployments`, ...gated, async (_req, res) => {
    try {
      res.json(await loadDeployments());
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/deployments`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const body = deploymentSchema.parse(req.body);
      const result = await recordDeployment(
        { ...body, verifiedAt: body.verifiedAt ? new Date(body.verifiedAt) : null },
        actor(req)
      );
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/tests`, ...gated, async (_req, res) => {
    try {
      res.json(await loadTestRuns());
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/tests`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const result = await recordTestRun(testRunSchema.parse(req.body), actor(req));
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/audit`, ...gated, async (req, res) => {
    try {
      const subject = typeof req.query.subject === "string" ? req.query.subject : undefined;
      const page = pagination(req);
      res.json(await loadAuditHistory(subject, page.limit, page.offset));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/views/shop-launch`, ...gated, async (_req, res) => {
    try {
      res.json(await scopedView(["partner-network"], "shop-launch"));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get(`${BASE}/views/scanner`, ...gated, async (_req, res) => {
    try {
      res.json(await scopedView(["scanner"], "scanner"));
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * The distributed Partner Shop programme.
   *
   * `gatedExpensive` rather than `gated`: this view shells out to git for every lane and reads
   * the migration ledger, so it carries the same cost profile as /repository and must share its
   * stricter rate limit. It is READ-ONLY — it records nothing and mutates nothing.
   */
  app.get(`${BASE}/views/distributed-shop-launch`, ...gatedExpensive, async (_req, res) => {
    try {
      res.json(await buildDistributedProgrammeView());
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Live repository evidence from GitHub, plus an explicit freshness verdict.
   *
   * `?refresh=true` is the manual "Refresh from GitHub" control. The reader enforces its own
   * cooldown underneath this, so the button cannot be used to exhaust the API rate limit however
   * hard it is pressed.
   *
   * `gatedExpensive`: this reaches an external API, so it shares /repository's stricter limiter.
   *
   * READ-ONLY, and it returns DATA ONLY — the GitHub token is read server-side and never appears
   * in this response, in a warning, or in an error. When GitHub is unconfigured or unreachable the
   * payload carries `freshness: "unknown"` rather than an empty-but-successful snapshot, so the
   * client can never render "nothing wrong" when the truth is "we could not look".
   */
  app.get(`${BASE}/github`, ...gatedExpensive, async (req, res) => {
    try {
      const snapshot = await scanGitHub(req.query.refresh === "true");
      res.json({
        snapshot,
        freshness: classifyFreshness(snapshot.fetchedAt),
        configured: isGitHubConfigured(),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * ONE VIEW, FOUR AUTHORITIES, NO BLENDING.
   *
   * The dashboard needs repository truth, application truth and configuration truth on one screen,
   * and it must never let one stand in for another: a merged PR is not a deployment, a reachable
   * app is not an applied migration, and an applied migration is not an enabled flag.
   *
   * So this route composes the sources and labels each one, rather than reducing them to a single
   * status. Every sub-probe fails soft on its own — one unreachable environment must not blank the
   * repository evidence beside it — and a failure is reported as UNAVAILABLE/UNKNOWN, never as a
   * zero or a success.
   */
  app.get(`${BASE}/live-evidence`, ...gatedExpensive, async (req, res) => {
    try {
      const [snapshot, probes] = await Promise.all([
        scanGitHub(req.query.refresh === "true").catch(() => null),
        probeAllApplications().catch(() => []),
      ]);
      const flags = collectFlagEvidence();

      res.json({
        observedAt: new Date().toISOString(),
        github: {
          configured: isGitHubConfigured(),
          snapshot,
          freshness: classifyFreshness(snapshot?.fetchedAt ?? null),
        },
        applications: probes,
        deployment: compareDeployment(snapshot?.defaultBranchSha ?? null, probes),
        featureFlags: flags,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * START A DURABLE GITHUB SYNC.
   *
   * Returns 202 as soon as the run is RECORDED, then lets the scan continue. The HTTP request is
   * deliberately not held open for a full GitHub scan: a scan can take tens of seconds, a
   * disconnected client would abort it midway, and the operator would have no way to learn what
   * happened. The database run and the lease are authoritative — the in-process promise below is
   * execution plumbing, not state. If this process dies, the lease expires and the work is
   * retryable; nothing is lost that the run row did not already record.
   *
   * The repository is fixed by environment. There is no owner/repo input, so this cannot be aimed
   * at an arbitrary repository by a request body.
   */
  app.post(`${BASE}/sync/github`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const actor = actor_(req);
      const outcome = await beginGitHubSync(pool, { triggerType: "manual", actor });

      if (outcome.started) {
        /*
         * Fire-and-record. The rejection handler exists so an unhandled rejection cannot take the
         * process down; the run's own error handling has already written the failure to the
         * database by the time anything lands here.
         */
        void runGitHubSync(pool, outcome.syncId).catch(() => undefined);
        return res.status(202).json({
          syncId: outcome.syncId,
          state: "QUEUED",
          accepted: true,
          alreadyRunning: false,
          unavailable: false,
          requestedAt: new Date().toISOString(),
        });
      }

      // Both non-started outcomes are 202 as well: the request was understood and a durable run
      // exists to poll. Only the flags differ, so the client never has to parse prose.
      return res.status(202).json({
        syncId: outcome.syncId,
        state: outcome.reason === "already_running" ? "RUNNING" : "UNAVAILABLE",
        accepted: false,
        alreadyRunning: outcome.reason === "already_running",
        unavailable: outcome.reason === "unavailable",
        requestedAt: new Date().toISOString(),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /** The most recent durable run, for the dashboard's "last refresh" line. */
  app.get(`${BASE}/sync/latest`, ...gated, async (_req, res) => {
    try {
      const run = await getLatestRun(pool, GITHUB_SOURCE);
      if (!run) return res.status(404).json({ error: "No sync run has been recorded yet." });
      const active = await getActiveRun(pool, GITHUB_SOURCE);
      return res.json(toSyncStatus(run, active?.syncId ?? null));
    } catch (error) {
      fail(res, error);
    }
  });

  /** One run by id, for polling after a 202. */
  app.get(`${BASE}/sync/:syncId`, ...gated, async (req, res) => {
    try {
      const syncId = String(req.params.syncId);
      // A malformed id is a 400, distinct from a well-formed id that does not exist (404) — the
      // operator needs to tell "you typed it wrong" from "it is gone".
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(syncId)) {
        return res.status(400).json({ error: "Invalid sync id." });
      }
      const run = await getRun(pool, syncId);
      if (!run) return res.status(404).json({ error: "Sync run not found." });
      const active = await getActiveRun(pool, GITHUB_SOURCE);
      return res.json(toSyncStatus(run, active?.syncId ?? null));
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Probe both allowlisted applications and store one observation each.
   *
   * Same contract as the GitHub refresh: 202 immediately, durable run is authoritative, duplicates
   * coalesce. There is no environment or URL input — the allowlist in app-probe.ts is the only
   * source of targets, so this cannot be aimed at an arbitrary host.
   */
  app.post(`${BASE}/sync/applications`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const outcome = await collectApplicationEvidence(pool, { triggerType: "manual", actor: actor_(req) });
      return res.status(202).json({
        syncId: outcome.syncId,
        state: outcome.started ? "RUNNING" : "RUNNING",
        accepted: outcome.started,
        alreadyRunning: !outcome.started,
        unavailable: false,
        requestedAt: new Date().toISOString(),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Store this environment's feature-flag evidence.
   *
   * Records only the allowlisted flag NAMES and their states — never a value, and never an
   * enumeration of the environment, which would disclose unrelated secret names.
   */
  app.post(`${BASE}/sync/flags`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const outcome = await collectFlagEvidenceSnapshots(pool, { triggerType: "manual", actor: actor_(req) });
      return res.status(202).json({
        syncId: outcome.syncId,
        state: "RUNNING",
        accepted: outcome.started,
        alreadyRunning: !outcome.started,
        unavailable: false,
        requestedAt: new Date().toISOString(),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Store migration evidence for the environment THIS PROCESS is connected to.
   *
   * Deliberately not parameterised by environment: a staging process can only observe staging, and
   * accepting a target would invite the false belief that it can speak for production. Production
   * evidence must come from a production process.
   */
  app.post(`${BASE}/sync/databases`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      const outcome = await collectAndStoreDatabaseEvidence(pool, { triggerType: "manual", actor: actor_(req) });
      return res.status(202).json({
        syncId: outcome.syncId,
        state: "RUNNING",
        accepted: outcome.started,
        alreadyRunning: !outcome.started,
        unavailable: false,
        requestedAt: new Date().toISOString(),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * THE composed overview — the only summary the UI consumes.
   *
   * Registered with the ORDINARY read gate, not `gatedExpensive`, because it makes zero external
   * calls: it reads persisted snapshots and nothing else. Refresh is a separate, explicit, audited
   * action, so looking at the dashboard can never spend GitHub quota or wake a sleeping machine.
   *
   * The frontend must never assemble the four sources itself — that would put the
   * "merged is not deployed" rule in the browser, where it could drift from this one silently.
   */
  app.get(`${BASE}/composed-overview`, ...gated, async (_req, res) => {
    try {
      res.json(await buildComposedOverview(pool));
    } catch (error) {
      fail(res, error);
    }
  });

  /* ---------------------------------------------------------------------------------------- */
  /* Seed reconciliation execution surface                                                      */
  /*                                                                                            */
  /* Four routes over the ALREADY-BUILT engine in project-control/seed-repository.ts. They add  */
  /* no reconciliation logic of their own: the planner decides, the repository executes, and    */
  /* these merely authorise, marshal and project the result.                                    */
  /*                                                                                            */
  /* NO CALLER-SUPPLIED MANIFEST, EVER. The desired structure is compiled, reviewed in a pull   */
  /* request and versioned. If a body could carry a manifest, one authenticated call could      */
  /* rewrite the whole programme with no diff and no review, so these routes accept none.       */
  /* ---------------------------------------------------------------------------------------- */

  /** Where this database stands: applied version, digest, drift against the compiled manifest. */
  app.get(`${BASE}/seed/status`, ...gated, async (_req, res) => {
    const client = await pool.connect();
    try {
      const status = await loadSeedStatus(client);
      const manifest = currentSeedManifest();
      const desiredDigest = currentSeedManifestDigest();
      const latest = status.schemaPresent ? await loadLatestRun(client) : null;
      res.json({
        environment: resolveConnectedEnvironment(),
        schemaPresent: status.schemaPresent,
        seedVersion: status.seedVersion,
        manifestDigest: status.manifestDigest,
        appliedAt: status.appliedAt,
        desiredSeedVersion: manifest.version,
        desiredManifestDigest: desiredDigest,
        // "pending" is the honest headline: never seeded, or seeded at different content.
        pending: !status.schemaPresent || status.manifestDigest !== desiredDigest,
        mode: status.seedVersion === null ? "first_seed" : "upgrade",
        counts: {
          nodes: status.nodeCount,
          packages: status.packageCount,
          superseded: status.supersededCount,
        },
        latestReportId: latest ? Number(latest.id) : null,
      });
    } catch (error) {
      seedFail(res, error);
    } finally {
      client.release();
    }
  });

  /**
   * Preview. Reads only — the engine's dry-run path contains no write statement at all, so this
   * cannot alter a row, an audit entry or a sequence. Returns a short-lived confirmation that
   * apply requires, so nothing can be applied that nobody previewed.
   */
  app.post(`${BASE}/seed/dry-run`, ...gatedExpensive, projectControlWriteLimit, async (_req, res) => {
    try {
      const preview = await dryRunSeed(pool, currentSeedManifest());
      res.json({
        confirmationToken: preview.confirmationToken,
        expiresAt: preview.expiresAt,
        noOp: preview.noOp,
        plan: {
          mode: preview.plan.mode,
          seedVersionBefore: preview.plan.seedVersionBefore,
          seedVersionAfter: preview.plan.seedVersionAfter,
          manifestDigest: preview.plan.manifestDigest,
          counts: preview.plan.counts,
          expectedFinalCounts: preview.plan.expectedFinalCounts,
          applicable: preview.plan.applicable,
          conflicts: preview.plan.conflicts,
          warnings: preview.plan.warnings,
          // Bounded: a full action list on a large programme is not a useful HTTP payload, and
          // the counts plus conflicts are what an operator decides on.
          actions: preview.plan.actions.slice(0, 500),
          actionsTruncated: preview.plan.actions.length > 500,
        },
      });
    } catch (error) {
      seedFail(res, error);
    }
  });

  /**
   * Execute a previewed plan.
   *
   * Every guard lives in the engine, not here: advisory lock, plan recomputation under that lock,
   * digest and version match against the confirmation, conflict refusal, single transaction, and
   * the production blockade. This handler supplies the actor and the SERVER-DERIVED environment
   * and nothing else — there is no request field that can influence any of it.
   */
  app.post(`${BASE}/seed/apply`, ...gatedExpensive, projectControlWriteLimit, async (req, res) => {
    try {
      const { confirmationToken } = seedApplySchema.parse(req.body);
      const result = await applySeed(pool, currentSeedManifest(), {
        actor: actor(req),
        confirmationToken,
        // Server-derived. Never from the body, never from a query string, and deliberately NOT
        // the Project Control enable flag — being able to read the dashboard is not permission to
        // rewrite production's programme structure.
        isProduction: resolveConnectedEnvironment() === "production",
      });
      res.status(200).json(result);
    } catch (error) {
      seedFail(res, error);
    }
  });

  /** The most recent reconciliation run, including refusals and failures. */
  app.post(`${BASE}/seed/report/latest`, ...gated, async (_req, res) => {
    const client = await pool.connect();
    try {
      const latest = await loadLatestRun(client);
      res.json({ report: latest });
    } catch (error) {
      seedFail(res, error);
    } finally {
      client.release();
    }
  });

  app.get(`${BASE}/export`, ...gatedExpensive, async (_req, res) => {
    try {
      res.json(await exportEverything());
    } catch (error) {
      fail(res, error);
    }
  });

  app.post(`${BASE}/seed`, ...gated, projectControlWriteLimit, async (req, res) => {
    try {
      res.json(await seedProgrammeTree(actor(req)));
    } catch (error) {
      fail(res, error);
    }
  });
}

/**
 * Build a view scoped to a subtree, plus anything carrying the view's tag.
 *
 * REMEDIATION of finding M7: the tag fallback previously matched `summary`, the wrong field, so
 * tagged work outside the subtree never appeared. It now matches the `tags` column, which is also
 * now loaded into the domain object.
 *
 * The recorded phase order is preserved — this reads the same nodes in the same `sortOrder` as
 * the main tree, so it can never drift from the approved roadmap.
 */
async function scopedView(rootKeys: string[], tag: string) {
  const [nodes, loaded] = await Promise.all([loadNodes(false), loadWorkPackages({})]);
  const packages = loaded.packages;

  const descendants = new Set<string>();
  const collect = (key: string) => {
    if (descendants.has(key)) return;
    descendants.add(key);
    nodes.filter((n) => n.parentKey === key).forEach((n) => collect(n.key));
  };
  rootKeys.forEach(collect);

  const scoped = packages.filter((p) => descendants.has(p.nodeKey) || (p.tags ?? []).includes(tag));
  const actions = computeNextActions(scoped);
  const readiness = computeReadiness(scoped);

  const phases = nodes
    .filter((n) => n.parentKey && rootKeys.includes(n.parentKey))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((n) => {
      const forNode = scoped.filter((p) => p.nodeKey === n.key);
      return {
        key: n.key,
        name: n.name,
        description: n.description,
        sortOrder: n.sortOrder,
        packages: forNode.map((p) => ({ ...p, assessment: assessWorkPackage(p) })),
        readiness: computeReadiness(forNode),
      };
    });

  const blockers = scoped.flatMap((p) =>
    p.blockers.filter((b) => !b.resolvedAt).map((b) => ({ packageKey: p.key, packageTitle: p.title, ...b }))
  );

  const nextMilestone = phases.find((ph) => ph.readiness.overall < 100) ?? null;

  return {
    generatedAt: new Date().toISOString(),
    readiness,
    phases,
    blockers,
    queues: computeQueues(scoped),
    nextMilestone: nextMilestone ? { key: nextMilestone.key, name: nextMilestone.name } : null,
    nextActions: summariseNextActions(actions),
    packages: scoped.map((p) => ({ ...p, assessment: assessWorkPackage(p) })),
  };
}
