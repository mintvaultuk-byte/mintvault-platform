/**
 * Super Admin Project Control API.
 *
 * Every route is (1) behind the fail-closed `super_admin_project_control_enabled` flag and
 * (2) Super-Admin only. The dashboard is a READ-AND-RECORD surface: it records what happened
 * (a deployment, a test run, a status change) but it cannot CAUSE any protected action. There is
 * no route here that pushes, merges, deploys, applies a migration, writes to production, or
 * touches any pre-existing MintVault table.
 *
 * Route inventory — 27 endpoints (kept in step with the router by a test that counts registrations):
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
import { compareDeployment, probeAllApplications } from "../../project-control/app-probe";
import { collectFlagEvidence } from "../../project-control/flag-evidence";
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
