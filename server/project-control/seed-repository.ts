/**
 * Project Control — seed state loader and transactional apply.
 *
 * THE DIVISION OF LABOUR
 *
 * `planReconciliation` (shared/project-control-seed-manifest.ts) decides EVERYTHING. This module
 * decides nothing. It loads the current structure, hands it to the planner, and then either
 * returns the plan (dry run) or executes exactly the plan's actions (apply). No reconciliation
 * rule is re-implemented here, so a dry run and an apply cannot disagree about what would happen.
 *
 * WHY DRY RUN ISSUES NO WRITE AT ALL
 *
 * The tempting implementation is "apply inside a transaction, then ROLLBACK". That is not a dry
 * run: it fires triggers, burns sequences, takes row locks, and writes for real on any path that
 * commits early or leaks a connection. This dry run performs SELECTs only — there is no INSERT,
 * UPDATE or DELETE on the code path, so the guarantee is structural rather than promised.
 *
 * WHY A DEDICATED CONNECTION
 *
 * `pool.query()` may run each statement on a different pooled connection, so BEGIN and COMMIT
 * issued through a pool are not one transaction — they are a BEGIN on one connection and a COMMIT
 * on another, with the real work uncommitted. Every apply therefore checks out one client and
 * runs the whole transaction on it.
 *
 * WHY THE LOCK IS TRANSACTION-SCOPED
 *
 * `pg_advisory_xact_lock` releases automatically when the transaction ends, however it ends. A
 * session-scoped lock would survive a crashed or leaked connection and permanently block every
 * future apply — a self-inflicted outage on the one operation you need during an incident.
 *
 * READ-ONLY GUARANTEE ON LOAD: `loadCurrentState` executes SELECTs only.
 */
import { randomBytes } from "node:crypto";
import {
  seedApplyRefusal,
  type ProjectControlEnvironment,
} from "@shared/project-control-environment";
import {
  isNoOp,
  manifestDigest,
  planDigest,
  planReconciliation,
  summarisePlan,
  type CurrentPackage,
  type CurrentState,
  type ReconciliationPlan,
  type SeedManifest,
} from "@shared/project-control-seed-manifest";

/* ------------------------------------------------------------------------------------------ */
/* Minimal database surface                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface SeedQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface SeedDbClient {
  query(text: string, params?: unknown[]): Promise<SeedQueryResult>;
}

export interface SeedDbPool {
  connect(): Promise<SeedDbClient & { release(): void }>;
}

/**
 * A stable advisory-lock key for seed reconciliation.
 *
 * A literal rather than a hash of a string, so it is greppable and cannot drift between
 * deployments the way a runtime-computed key could.
 */
export const SEED_RECONCILIATION_LOCK_KEY = 4150240;

/** Bound every read. A programme that outgrows these has other problems, but we fail visibly. */
const MAX_NODES = 2000;
const MAX_PACKAGES = 5000;

/* ------------------------------------------------------------------------------------------ */
/* Errors — stable codes, never raw driver text                                                 */
/* ------------------------------------------------------------------------------------------ */

export const SEED_ERROR_CODES = [
  "schema_absent",
  "conflicts",
  "digest_mismatch",
  "version_mismatch",
  "already_running",
  "production_blocked",
  /**
   * The process cannot identify which environment it is connected to.
   *
   * Distinct from `production_blocked` on purpose: "this is production" and "we do not know what
   * this is" call for different operator action, and collapsing them would hide the fact that a
   * machine is misconfigured.
   */
  "unknown_environment",
  "plan_changed",
  "internal",
] as const;
export type SeedErrorCode = (typeof SEED_ERROR_CODES)[number];

export class SeedApplyError extends Error {
  constructor(
    readonly code: SeedErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SeedApplyError";
  }
}

/**
 * A driver error can carry a connection string, a table's full contents in a constraint message,
 * or an operator's note. None of that may reach a client or an audit row, so the raw text is
 * discarded and replaced by a stable code. The full error is the caller's to log, redacted, once.
 */
function safeFailure(error: unknown): SeedApplyError {
  if (error instanceof SeedApplyError) return error;
  return new SeedApplyError(
    "internal",
    "The seed reconciliation failed and was rolled back. No structural change was committed."
  );
}

/* ------------------------------------------------------------------------------------------ */
/* State loading — SELECT only                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface SeedStatus {
  schemaPresent: boolean;
  seedVersion: number | null;
  manifestDigest: string | null;
  appliedAt: string | null;
  nodeCount: number;
  packageCount: number;
  supersededCount: number;
}

async function tableExists(client: SeedDbClient, name: string): Promise<boolean> {
  const { rows } = await client.query("SELECT to_regclass($1)::text AS reg", [`public.${name}`]);
  return rows[0]?.reg != null;
}

/**
 * Distinguish "the schema was never applied" from "the schema exists and is empty".
 *
 * They look identical to a naive count and mean opposite things: the first is a migration that has
 * not run, the second is a database ready for its first seed. Conflating them would send an
 * operator to the wrong fix.
 */
export async function loadSeedStatus(client: SeedDbClient): Promise<SeedStatus> {
  const hasState = await tableExists(client, "pc_seed_state");
  const hasPackages = await tableExists(client, "pc_work_packages");
  if (!hasState || !hasPackages) {
    return {
      schemaPresent: false,
      seedVersion: null,
      manifestDigest: null,
      appliedAt: null,
      nodeCount: 0,
      packageCount: 0,
      supersededCount: 0,
    };
  }

  const state = await client.query("SELECT seed_version, manifest_digest, applied_at FROM pc_seed_state WHERE id = 1");
  const counts = await client.query(
    `SELECT
       (SELECT count(*)::int FROM pc_nodes) AS nodes,
       (SELECT count(*)::int FROM pc_work_packages) AS packages,
       (SELECT count(*)::int FROM pc_work_packages WHERE superseded_at IS NOT NULL) AS superseded`
  );

  const row = state.rows[0];
  return {
    schemaPresent: true,
    seedVersion: row ? Number(row.seed_version) : null,
    manifestDigest: row ? String(row.manifest_digest) : null,
    appliedAt: row?.applied_at ? new Date(row.applied_at as string).toISOString() : null,
    nodeCount: Number(counts.rows[0].nodes),
    packageCount: Number(counts.rows[0].packages),
    supersededCount: Number(counts.rows[0].superseded),
  };
}

/** SELECT only. Deterministically ordered so two loads of the same database are identical. */
export async function loadCurrentState(client: SeedDbClient): Promise<CurrentState> {
  const status = await loadSeedStatus(client);
  if (!status.schemaPresent) {
    throw new SeedApplyError(
      "schema_absent",
      "The Project Control seed schema is not present in this environment. Apply the migrations before reconciling the seed."
    );
  }

  const nodes = await client.query(
    `SELECT key, parent_key, name, description, sort_order
       FROM pc_nodes ORDER BY key LIMIT ${MAX_NODES}`
  );

  const packages = await client.query(
    `SELECT p.key, p.node_key, p.title, p.summary, p.risk, p.classification,
            p.business_value, p.engineering_risk, p.remaining_work, p.tags,
            p.acceptance_criteria, p.required_tests, p.superseded_at,
            COALESCE(
              (SELECT array_agg(d.depends_on_key ORDER BY d.depends_on_key)
                 FROM pc_dependencies d WHERE d.package_key = p.key),
              ARRAY[]::text[]
            ) AS depends_on
       FROM pc_work_packages p ORDER BY p.key LIMIT ${MAX_PACKAGES}`
  );

  return {
    seedVersion: status.seedVersion,
    manifestDigest: status.manifestDigest,
    nodes: nodes.rows.map((r) => ({
      key: String(r.key),
      parentKey: r.parent_key === null ? null : String(r.parent_key),
      name: String(r.name),
      description: String(r.description),
      sortOrder: Number(r.sort_order),
    })),
    packages: packages.rows.map(toCurrentPackage),
  };
}

function toCurrentPackage(r: Record<string, unknown>): CurrentPackage {
  return {
    key: String(r.key),
    nodeKey: String(r.node_key),
    title: String(r.title),
    summary: String(r.summary),
    risk: String(r.risk),
    classification: String(r.classification),
    businessValue: Number(r.business_value),
    engineeringRisk: Number(r.engineering_risk),
    remainingWork: r.remaining_work === null ? "" : String(r.remaining_work),
    tags: (r.tags as string[]) ?? [],
    acceptanceCriteria: (r.acceptance_criteria as unknown[]) ?? [],
    requiredTests: (r.required_tests as unknown[]) ?? [],
    dependsOn: (r.depends_on as string[]) ?? [],
    supersededAt: r.superseded_at ? new Date(r.superseded_at as string).toISOString() : null,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Dry run                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface DryRunResult {
  plan: ReconciliationPlan;
  /**
   * Short-lived token proving THIS plan was previewed. Apply requires it, so a caller cannot
   * apply a plan nobody looked at. Bound to the digest and the version it was computed against.
   */
  confirmationToken: string;
  /** Digest of what this plan would DO. Surfaced so an operator can see the two runs match. */
  planDigest: string;
  expiresAt: string;
  noOp: boolean;
}

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

interface ConfirmationRecord {
  digest: string;
  /**
   * A digest of what the previewed plan would DO — the sorted action list, the conflicts and the
   * counts. `digest` above is the MANIFEST digest, which is a build-time constant and therefore
   * says nothing about database state; binding to it alone let an operator approve "already in
   * sync" and get an overwrite plus a delete. See `planDigest` for the full account.
   */
  planDigest: string;
  seedVersionBefore: number | null;
  /** The environment the preview was computed against. A staging preview cannot apply elsewhere. */
  environment: ProjectControlEnvironment;
  expiresAt: number;
}

const confirmations = new Map<string, ConfirmationRecord>();

/** Issue a confirmation for a previewed plan, and evict anything expired while we are here. */
function issueConfirmation(
  plan: ReconciliationPlan,
  environment: ProjectControlEnvironment,
  now: number
): { token: string; expiresAt: number; planDigest: string } {
  for (const [token, record] of confirmations) if (record.expiresAt <= now) confirmations.delete(token);
  const token = randomBytes(24).toString("hex");
  const expiresAt = now + CONFIRMATION_TTL_MS;
  const digestOfPlan = planDigest(plan);
  confirmations.set(token, {
    digest: plan.manifestDigest,
    planDigest: digestOfPlan,
    seedVersionBefore: plan.seedVersionBefore,
    environment,
    expiresAt,
  });
  return { token, expiresAt, planDigest: digestOfPlan };
}

export function clearConfirmations(): void {
  confirmations.clear();
}

/**
 * Preview. Performs SELECTs only — there is no write statement on this path.
 */
export async function dryRunSeed(
  pool: SeedDbPool,
  manifest: SeedManifest,
  environment: ProjectControlEnvironment = "local",
  now: number = Date.now()
): Promise<DryRunResult> {
  const client = await pool.connect();
  try {
    const current = await loadCurrentState(client);
    const plan = planReconciliation(current, manifest);
    const { token, expiresAt, planDigest: digestOfPlan } = issueConfirmation(plan, environment, now);
    return {
      plan,
      confirmationToken: token,
      planDigest: digestOfPlan,
      expiresAt: new Date(expiresAt).toISOString(),
      noOp: isNoOp(plan),
    };
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Apply                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface ApplyOptions {
  actor: string;
  confirmationToken: string;
  /**
   * Server-derived. Never taken from a request body or query string.
   *
   * This replaced a plain `isProduction: boolean`, which could only express "production" and
   * "not production" — so an environment we could not identify at all fell into "not production"
   * and was allowed to write. A laptop pointed at the production database is exactly that case.
   */
  environment: ProjectControlEnvironment;
  /** Separate, deliberately awkward, owner-controlled. NOT the Project Control enable flag. */
  productionOverride?: boolean;
  now?: number;
}

export interface ApplyResult {
  runId: number;
  mode: ReconciliationPlan["mode"];
  seedVersionBefore: number | null;
  seedVersionAfter: number;
  manifestDigest: string;
  counts: ReconciliationPlan["counts"];
  warnings: string[];
  noOp: boolean;
}

/**
 * Execute a previewed plan, atomically.
 *
 * The plan is RECOMPUTED inside the lock rather than trusted from the preview. Between preview
 * and apply the database can change — another operator edits a package, a prior apply lands — and
 * executing a stale action list would write decisions taken against a world that no longer exists.
 * Recomputing and then comparing digests is what makes "apply exactly what I reviewed" true rather
 * than merely intended.
 */
export async function applySeed(pool: SeedDbPool, manifest: SeedManifest, options: ApplyOptions): Promise<ApplyResult> {
  const now = options.now ?? Date.now();

  // ---- production blockade, before any connection is taken -----------------------------------
  //
  // Server-derived identity only. There is no request field that can flip this, and the Project
  // Control enable flag deliberately does NOT grant it — being able to LOOK at the dashboard is
  // not permission to rewrite production's programme structure.
  const refusal = seedApplyRefusal(options.environment, options.productionOverride === true);
  if (refusal === "unknown_environment") {
    throw new SeedApplyError(
      "unknown_environment",
      "Seed apply is blocked because this process cannot identify which environment it is connected to. Set PROJECT_CONTROL_ENV. Refusing is deliberate: without an identity there is no way to tell whether the production blockade applies."
    );
  }
  if (refusal === "production_blocked") {
    throw new SeedApplyError(
      "production_blocked",
      "Seed apply is blocked in production. It requires a separate, explicit owner-controlled authorisation that is not the Project Control feature flag."
    );
  }

  const confirmation = confirmations.get(options.confirmationToken);
  if (!confirmation || confirmation.expiresAt <= now) {
    confirmations.delete(options.confirmationToken);
    throw new SeedApplyError(
      "digest_mismatch",
      "This apply has no valid preview. Run a dry run and apply the plan it returns; confirmations are short-lived on purpose."
    );
  }

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;

    // Transaction-scoped: released on COMMIT or ROLLBACK, so a crashed apply cannot wedge the
    // next one. Non-blocking so a concurrent apply is refused rather than queued behind it.
    const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS locked", [SEED_RECONCILIATION_LOCK_KEY]);
    if (lock.rows[0]?.locked !== true) {
      throw new SeedApplyError(
        "already_running",
        "Another seed reconciliation is already running. Wait for it to finish and re-run the dry run."
      );
    }

    const current = await loadCurrentState(client);
    const plan = planReconciliation(current, manifest);

    if (plan.manifestDigest !== confirmation.digest || plan.seedVersionBefore !== confirmation.seedVersionBefore) {
      throw new SeedApplyError(
        "digest_mismatch",
        "The database changed since this plan was previewed, so applying it would execute decisions taken against a different state. Run a fresh dry run and review it."
      );
    }

    /**
     * The check that makes the docstring above true.
     *
     * The two comparisons above only catch a competing full apply — they compare a build-time
     * constant and a version that moves once per apply. Everything else an operator or a colleague
     * can do between preview and apply (retitle a package, add a dependency, create a package)
     * changes the PLAN while leaving both of them identical. Comparing the recomputed plan's own
     * digest is what closes that window.
     */
    if (planDigest(plan) !== confirmation.planDigest) {
      throw new SeedApplyError(
        "plan_changed",
        "The plan has changed since it was previewed — the database is no longer in the state the preview was computed against, so applying it would execute decisions you did not review. Run a fresh dry run and read the new plan."
      );
    }

    /**
     * A preview taken against one environment may not be applied against another. The confirmation
     * lives in this process's memory, so this is belt-and-braces rather than the primary control,
     * but a process whose identity changed under it (a restart with a corrected
     * PROJECT_CONTROL_ENV) must not honour a token issued under the old answer.
     */
    if (confirmation.environment !== options.environment) {
      throw new SeedApplyError(
        "unknown_environment",
        "This preview was taken against a different environment than the one now connected. Run a fresh dry run."
      );
    }

    if (!plan.applicable) {
      throw new SeedApplyError(
        "conflicts",
        `Refusing to apply: ${plan.conflicts.length} unresolved conflict(s). Reconciliation never picks a winner when the manifest and the database disagree.`
      );
    }

    const noOp = isNoOp(plan);

    // ---- execute exactly the plan ------------------------------------------------------------
    for (const action of plan.actions) {
      switch (action.kind) {
        case "INSERT_NODE": {
          const node = manifest.nodes.find((n) => n.key === action.targetKey)!;
          await client.query(
            `INSERT INTO pc_nodes (key, parent_key, name, description, sort_order)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
            [node.key, node.parentKey, node.name, node.description, node.sortOrder]
          );
          break;
        }
        case "UPDATE_NODE_SYSTEM_FIELD": {
          const node = manifest.nodes.find((n) => n.key === action.targetKey)!;
          await client.query(
            `UPDATE pc_nodes SET parent_key=$2, name=$3, description=$4, sort_order=$5, updated_at=NOW()
              WHERE key=$1`,
            [node.key, node.parentKey, node.name, node.description, node.sortOrder]
          );
          break;
        }
        case "INSERT_PACKAGE": {
          const pkg = manifest.packages.find((p) => p.key === action.targetKey)!;
          /**
           * Machine-owned columns are deliberately omitted so they take their migration
           * defaults. Naming them here — even as "not_started" — would make the seed the author
           * of a status it has no evidence for.
           */
          await client.query(
            `INSERT INTO pc_work_packages
               (key, node_key, title, summary, risk, classification, business_value,
                engineering_risk, remaining_work, tags, acceptance_criteria, required_tests,
                category_states, category_notes, created_by, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,'{}'::jsonb,'{}'::jsonb,$13,$13)
             ON CONFLICT (key) DO NOTHING`,
            [
              pkg.key,
              pkg.nodeKey,
              pkg.title,
              pkg.summary,
              pkg.risk,
              pkg.classification,
              pkg.businessValue,
              pkg.engineeringRisk,
              pkg.remainingWork ?? "",
              JSON.stringify(pkg.tags ?? []),
              JSON.stringify(pkg.acceptanceCriteria ?? []),
              JSON.stringify(pkg.requiredTests ?? []),
              options.actor,
            ]
          );
          break;
        }
        case "UPDATE_SYSTEM_FIELD": {
          // Column allowlist. A field name never reaches SQL as an identifier from the plan, so a
          // planner bug cannot become an injection, and an operator-owned column has no mapping
          // here at all — it is structurally unreachable, not merely un-called.
          const COLUMN: Record<string, string> = {
            nodeKey: "node_key",
            title: "title",
            summary: "summary",
            risk: "risk",
            classification: "classification",
            businessValue: "business_value",
            engineeringRisk: "engineering_risk",
            tags: "tags",
            acceptanceCriteria: "acceptance_criteria",
            requiredTests: "required_tests",
          };
          const column = COLUMN[action.field ?? ""];
          if (!column) break;
          const json = ["tags", "acceptance_criteria", "required_tests"].includes(column);
          await client.query(
            `UPDATE pc_work_packages SET ${column}=$2${json ? "::jsonb" : ""}, updated_at=NOW(), updated_by=$3 WHERE key=$1`,
            [action.targetKey, json ? JSON.stringify(action.to) : (action.to as string | number), options.actor]
          );
          break;
        }
        case "ADD_DEPENDENCY":
          await client.query(
            `INSERT INTO pc_dependencies (package_key, depends_on_key, note)
             VALUES ($1,$2,'Declared by the seed manifest.')
             ON CONFLICT (package_key, depends_on_key) DO NOTHING`,
            [action.targetKey, action.to as string]
          );
          break;
        case "REMOVE_DEPENDENCY":
          await client.query("DELETE FROM pc_dependencies WHERE package_key=$1 AND depends_on_key=$2", [
            action.targetKey,
            action.to as string,
          ]);
          break;
        case "SUPERSEDE":
          /**
           * A retirement is an UPDATE, never a DELETE. The row keeps its id, its operator notes,
           * its manual blockers, its evidence and its audit history; it simply stops being active
           * work. There is no DELETE on pc_work_packages anywhere in this module.
           */
          await client.query(
            `UPDATE pc_work_packages
                SET superseded_at=NOW(), superseded_by=$2, superseded_reason=$3,
                    updated_at=NOW(), updated_by=$4
              WHERE key=$1 AND superseded_at IS NULL`,
            [
              action.targetKey,
              (action.to as string | null) ?? null,
              action.reason ?? "Superseded by the seed manifest.",
              options.actor,
            ]
          );
          break;
        default:
          // NO_CHANGE, PRESERVE_OPERATOR_FIELD, CONFLICT, REJECTED_MACHINE_FIELD execute nothing.
          break;
      }
    }

    // ---- seed state and run record, inside the SAME transaction ------------------------------
    await client.query(
      `INSERT INTO pc_seed_state (id, seed_version, manifest_digest, applied_at, applied_by)
       VALUES (1,$1,$2,NOW(),$3)
       ON CONFLICT (id) DO UPDATE
         SET seed_version=EXCLUDED.seed_version,
             manifest_digest=EXCLUDED.manifest_digest,
             applied_at=EXCLUDED.applied_at,
             applied_by=EXCLUDED.applied_by`,
      [manifest.version, plan.manifestDigest, options.actor]
    );

    const run = await client.query(
      `INSERT INTO pc_seed_runs
         (mode, outcome, seed_version_before, seed_version_after, manifest_digest,
          nodes_inserted, nodes_updated, packages_inserted, packages_updated, packages_superseded,
          dependencies_added, dependencies_removed, operator_fields_preserved,
          conflict_count, warning_count, summary, actor, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
       RETURNING id`,
      [
        plan.mode,
        noOp ? "no_change" : "applied",
        plan.seedVersionBefore,
        plan.seedVersionAfter,
        plan.manifestDigest,
        plan.counts.nodesInserted,
        plan.counts.nodesUpdated,
        plan.counts.packagesInserted,
        plan.counts.packagesUpdated,
        plan.counts.packagesSuperseded,
        plan.counts.dependenciesAdded,
        plan.counts.dependenciesRemoved,
        plan.counts.operatorFieldsPreserved,
        plan.conflicts.length,
        plan.warnings.length,
        summarisePlan(plan),
        options.actor,
      ]
    );

    await client.query("COMMIT");
    inTransaction = false;

    // One-time use: a confirmation cannot be replayed into a second apply.
    confirmations.delete(options.confirmationToken);

    return {
      runId: Number(run.rows[0].id),
      mode: plan.mode,
      seedVersionBefore: plan.seedVersionBefore,
      seedVersionAfter: plan.seedVersionAfter,
      manifestDigest: plan.manifestDigest,
      counts: plan.counts,
      warnings: plan.warnings,
      noOp,
    };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw safeFailure(error);
  } finally {
    client.release();
  }
}

/** The most recent reconciliation run, for the report route. Read-only. */
export async function loadLatestRun(client: SeedDbClient): Promise<Record<string, unknown> | null> {
  if (!(await tableExists(client, "pc_seed_runs"))) return null;
  const { rows } = await client.query(
    `SELECT id, mode, outcome, seed_version_before, seed_version_after, manifest_digest,
            nodes_inserted, nodes_updated, packages_inserted, packages_updated, packages_superseded,
            dependencies_added, dependencies_removed, operator_fields_preserved,
            conflict_count, warning_count, summary, actor, started_at, completed_at
       FROM pc_seed_runs ORDER BY started_at DESC, id DESC LIMIT 1`
  );
  return rows[0] ?? null;
}

export { manifestDigest };
