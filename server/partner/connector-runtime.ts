/**
 * Trusted Intake Connector — production driver (WP-3).
 *
 * The connector chain G1–G3F is code-complete but was runtime-INERT: nothing in the deployed server
 * ever called `ensureConnectorRecordForHandoff` or `runConnectorWorkerPool`, so a submitted Partner
 * handoff sat `pending` forever. This module is the missing lifecycle owner — and NOTHING else. It
 * introduces no new state machine, no new exactly-once mechanism, and no new write path: every
 * mutation it performs is a call to an existing, audited, version-guarded G1–G3F service, and the
 * database UNIQUE/version constraints remain the final control.
 *
 * ── Gating (fail closed, three independent conditions) ────────────────────────────────────────────
 *  1. PARTNER_CONNECTOR_DATABASE_URL must be configured. If it is not, `startConnectorRuntime()`
 *     returns after ONE log line and never arms a timer — a MintVault deployment without the Partner
 *     connector env behaves exactly as it did before this file existed.
 *  2. The privileged admin connection must actually be able to see across tenants (BYPASSRLS). The
 *     discovery sweep reads `partner_submission_handoffs`, which is FORCE ROW LEVEL SECURITY with a
 *     `tenant_id = partner_current_tenant()` policy: a non-BYPASSRLS role would return ZERO rows for
 *     every tenant and the sweep would silently do nothing forever. That is checked explicitly (the
 *     existing `getPartnerAdminCapability` probe) and a failure parks the runtime in a VISIBLE
 *     `stopped` state with a reason, rather than looping on a silent no-op.
 *  3. The global `partner_connector_enabled` flag must be ON and `partner_emergency_stop` OFF. This
 *     is resolved at start AND again at the top of EVERY cycle, so an operator flag flip is observed
 *     within one cycle with no restart. It is belt-and-braces: every underlying service re-checks the
 *     same two flags inside its own transaction (`assertConnectorActive`), so even a flag that flips
 *     mid-cycle fails the very next claim closed.
 *
 * ── One cycle ────────────────────────────────────────────────────────────────────────────────────
 *  A. SWEEP    — create the canonical connector record for every *unprocessed* handoff.
 *  B. PROCESS  — claim → validate → import, using the existing services.
 *  C. RECOVER  — the existing bounded worker pool sweeps up `ready_for_import` records whose lease
 *                expired (i.e. a previous process died mid-flight), which is what makes a crash
 *                restart safe without any new recovery mechanism.
 *
 * ── "Unprocessed handoff" ────────────────────────────────────────────────────────────────────────
 * Derived ENTIRELY from existing columns — no new column, no new flag:
 *     partner_submission_handoffs.status = 'pending'
 *     AND NOT EXISTS (partner_connector_records WHERE handoff_id = h.id)
 * `status = 'pending'` is the same readiness predicate `ensureConnectorRecordForHandoff` itself
 * enforces (it rejects any other status with `handoff_not_ready`), and the NOT EXISTS mirrors the
 * DB-enforced `UNIQUE(handoff_id)` on partner_connector_records. The join is therefore an OPTIMISATION
 * and a bound, never the correctness guarantee: re-running the sweep against an already-processed
 * handoff is a no-op even if the join were removed, because the unique constraint makes
 * `ensureConnectorRecordForHandoff` idempotent.
 *
 * ── Why the discovery read uses the privileged admin pool ─────────────────────────────────────────
 * The connector pool's role (`partner_connector_runtime`) is NOBYPASSRLS by construction (migration
 * 0008 asserts it), and `partner_submission_handoffs` / `partner_organisations` are both FORCE RLS.
 * There is therefore NO query on the connector pool that can enumerate work across tenants — the
 * connector pool can only ever see one tenant at a time, and only after the caller already knows
 * which tenant to name. Discovery consequently runs on the same privileged, cross-tenant read path
 * G4's connector-ops reads already use (`partnerAdminQuery`), and is STRICTLY READ-ONLY.
 *
 * Tenant binding is NOT trusted from that read: the (tenantId, handoffId) pair is handed to
 * `ensureConnectorRecordForHandoff`, which re-reads the handoff on the connector pool inside a
 * transaction with `app.tenant_id` set to the claimed tenant. RLS then re-proves the binding — a
 * mismatched tenant sees zero rows and fails `handoff_not_found`. The database, not this file, is
 * what enforces tenant isolation on the creation path.
 */
import { partnerAdminQuery } from "./db";
import { getPartnerAdminCapability } from "./admin-capability";
import { connectorDbConfigured, connectorQuery } from "./connector-db";
import { resolveGlobalFlag } from "./flags";
import { ConnectorError } from "./connector-errors";
import {
  ensureConnectorRecordForHandoff,
  claimNextConnectorRecord,
  transitionConnectorState,
  type ConnectorState,
} from "./connector-service";
import { validateConnectorRecord } from "./connector-validation-service";
import { importValidatedConnector } from "./connector-import-service";
import { runConnectorWorkerPool, type WorkerPoolResult } from "./connector-worker";

// ---------------------------------------------------------------------------
// Configuration (all env-tunable, all with production-safe defaults)
// ---------------------------------------------------------------------------
function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

export interface ConnectorRuntimeOptions {
  /** Delay between cycles when the previous cycle succeeded. Default 15s. */
  pollIntervalMs?: number;
  /** Maximum handoffs converted into connector records per sweep. Default 100. */
  sweepLimit?: number;
  /** Maximum records claimed+validated+imported per processing pass. Default 50. */
  processLimit?: number;
  /** Worker count for the recovery pass (existing bounded pool). Default 2. */
  workerCount?: number;
  /** Claim lease length in seconds. Default 300 (the connector service default). */
  leaseSeconds?: number;
  /** First backoff after a cycle-level failure. Default 5s, doubled per consecutive failure. */
  backoffBaseMs?: number;
  /** Backoff ceiling. Default 5 minutes. */
  backoffMaxMs?: number;
  /** Consecutive cycle failures after which the runtime parks in `stopped`. Default 10. */
  maxConsecutiveFailures?: number;
  /** TEST-ONLY: run exactly one cycle instead of arming a repeating timer. */
  singleCycle?: boolean;
}

interface ResolvedOptions extends Required<Omit<ConnectorRuntimeOptions, "singleCycle">> {
  singleCycle: boolean;
}

function resolveOptions(opts: ConnectorRuntimeOptions = {}): ResolvedOptions {
  return {
    pollIntervalMs: opts.pollIntervalMs ?? intEnv("PARTNER_CONNECTOR_POLL_INTERVAL_MS", 15_000, 10),
    sweepLimit: opts.sweepLimit ?? intEnv("PARTNER_CONNECTOR_SWEEP_LIMIT", 100, 1),
    processLimit: opts.processLimit ?? intEnv("PARTNER_CONNECTOR_PROCESS_LIMIT", 50, 1),
    workerCount: opts.workerCount ?? intEnv("PARTNER_CONNECTOR_WORKERS", 2, 1),
    leaseSeconds: opts.leaseSeconds ?? intEnv("PARTNER_CONNECTOR_LEASE_SECONDS", 300, 1),
    backoffBaseMs: opts.backoffBaseMs ?? intEnv("PARTNER_CONNECTOR_BACKOFF_BASE_MS", 5_000, 1),
    backoffMaxMs: opts.backoffMaxMs ?? intEnv("PARTNER_CONNECTOR_BACKOFF_MAX_MS", 300_000, 1),
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? intEnv("PARTNER_CONNECTOR_MAX_FAILURES", 10, 1),
    singleCycle: opts.singleCycle ?? false,
  };
}

// ---------------------------------------------------------------------------
// In-process observable state (no new table — this is the only in-memory part)
// ---------------------------------------------------------------------------
export type ConnectorRuntimeStatus = "not_configured" | "running" | "draining" | "stopped";

/** Why the runtime is not doing work right now. `null` when it is processing normally. */
export type ConnectorRuntimeIdleReason =
  | "flag_disabled"
  | "emergency_stop"
  | "admin_capability_unavailable"
  | "failure_budget_exhausted"
  | "not_started"
  | "shutting_down";

export interface SweepStats {
  candidates: number;
  created: number;
  /** Handoff no longer eligible when the creation was attempted (raced / status moved on). */
  skipped: number;
  failed: number;
}

export interface ProcessStats {
  claimed: number;
  validated: number;
  rejected: number;
  imported: number;
  alreadyImported: number;
  failed: number;
}

export interface CycleStats {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  gateOpen: boolean;
  sweep: SweepStats;
  process: ProcessStats;
  recovery: Pick<WorkerPoolResult, "claimed" | "imported" | "alreadyCompleted" | "stale"> | null;
}

export interface ConnectorRuntimeSnapshot {
  status: ConnectorRuntimeStatus;
  idleReason: ConnectorRuntimeIdleReason | null;
  startedAt: string | null;
  cyclesCompleted: number;
  consecutiveFailures: number;
  inFlight: boolean;
  lastCycle: CycleStats | null;
  /** Stable error CODE only — never a SQL string, stack, or provider message. */
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

interface RuntimeState {
  status: ConnectorRuntimeStatus;
  idleReason: ConnectorRuntimeIdleReason | null;
  startedAt: string | null;
  cyclesCompleted: number;
  consecutiveFailures: number;
  lastCycle: CycleStats | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  timer: NodeJS.Timeout | null;
  stopRequested: boolean;
  /** Resolves when the currently-executing cycle (if any) has finished. */
  inFlight: Promise<void> | null;
  options: ResolvedOptions;
}

const state: RuntimeState = {
  status: "not_configured",
  idleReason: "not_started",
  startedAt: null,
  cyclesCompleted: 0,
  consecutiveFailures: 0,
  lastCycle: null,
  lastErrorCode: null,
  lastErrorAt: null,
  timer: null,
  stopRequested: false,
  inFlight: null,
  options: resolveOptions(),
};

/** The claimant identity this process presents to the connector services. */
function claimantId(): string {
  return `runtime:${process.pid}`;
}

function logLine(event: string, detail: Record<string, unknown> = {}): void {
  // Ids/states/counters only — never customer PII, never a raw DB error string.
  console.log("[partner-connector-runtime]", JSON.stringify({ event, ...detail }));
}

function errorCodeOf(err: unknown): string {
  return err instanceof ConnectorError ? err.code : "unknown_error";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

// ---------------------------------------------------------------------------
// Gate — the same two global flags every connector service checks internally.
// ---------------------------------------------------------------------------
interface Gate {
  open: boolean;
  reason: ConnectorRuntimeIdleReason | null;
}

async function resolveGate(): Promise<Gate> {
  const [stopped, enabled] = await Promise.all([
    resolveGlobalFlag("partner_emergency_stop"),
    resolveGlobalFlag("partner_connector_enabled"),
  ]);
  if (stopped) return { open: false, reason: "emergency_stop" };
  if (!enabled) return { open: false, reason: "flag_disabled" };
  return { open: true, reason: null };
}

// ---------------------------------------------------------------------------
// A. Sweep — unprocessed handoffs → canonical connector records (idempotent).
// ---------------------------------------------------------------------------
interface HandoffCandidate {
  id: string;
  tenant_id: string;
}

/**
 * Read-only, bounded, cross-tenant discovery of unprocessed handoffs. See the file header for why
 * this read (and ONLY this read) uses the privileged admin pool, and why the tenant binding it
 * reports is re-proved by RLS on the creation path rather than trusted here.
 */
export async function listUnprocessedHandoffs(limit: number): Promise<HandoffCandidate[]> {
  const { rows } = await partnerAdminQuery<HandoffCandidate>(
    `SELECT h.id, h.tenant_id
       FROM partner_submission_handoffs h
      WHERE h.status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM partner_connector_records r WHERE r.handoff_id = h.id)
      ORDER BY h.created_at ASC, h.id ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function sweepUnprocessedHandoffs(limit: number): Promise<SweepStats> {
  const candidates = await listUnprocessedHandoffs(limit);
  const stats: SweepStats = { candidates: candidates.length, created: 0, skipped: 0, failed: 0 };
  for (const candidate of candidates) {
    if (state.stopRequested) break;
    try {
      await ensureConnectorRecordForHandoff({ tenantId: candidate.tenant_id, handoffId: candidate.id });
      stats.created += 1;
    } catch (err) {
      const code = errorCodeOf(err);
      // Fail closed on a flag flip: stop the sweep immediately rather than hammering a disabled
      // connector once per candidate.
      if (code === "feature_disabled" || code === "emergency_stop") throw err;
      // The handoff moved on (or never belonged to the reported tenant) between the discovery read
      // and the guarded creation — not an error, just no longer eligible.
      if (code === "handoff_not_ready" || code === "handoff_not_found") {
        stats.skipped += 1;
        continue;
      }
      stats.failed += 1;
      logLine("sweep_create_failed", { handoffId: candidate.id, code });
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// B. Process — claim → validate → import, via the existing services only.
// ---------------------------------------------------------------------------
interface RecordProjection {
  state: ConnectorState;
  version: number;
}

/**
 * Narrow read-only projection on the connector pool (same primitive `getConnectorStatus` uses).
 * Needed because `validateConnectorRecord` returns the validation RUN, not the record's new version,
 * and the importer requires an exact `expectedVersion`. Reading it is strictly safer than inferring
 * it arithmetically from another module's internal transition count.
 */
async function readRecordProjection(connectorId: string): Promise<RecordProjection | null> {
  const { rows } = await connectorQuery<{ state: string; version: number }>(
    `SELECT state, version FROM partner_connector_records WHERE id = $1`,
    [connectorId]
  );
  if (rows.length === 0) return null;
  return { state: rows[0].state as ConnectorState, version: rows[0].version };
}

/**
 * Claim up to `limit` records and drive each as far as it can legally go this cycle.
 *
 * A freshly-swept record is `queued`; claiming moves it to `claimed`; the record is then explicitly
 * entered into `validating` and validated. Validation lands it in `ready_for_import` (valid),
 * `rejected` (invalid), `cancelled` or `failed` — all written by the existing validation service in
 * its own transaction. When it reaches `ready_for_import` the SAME claim is used to import it
 * immediately: the claim is still live and held by this process, so handing the record to the
 * recovery pool instead would simply stall it for a full lease period.
 *
 * `claimNextConnectorRecord` also returns records whose lease expired while already in
 * `ready_for_import` (a crashed predecessor) WITHOUT downgrading their state — those go straight to
 * the importer, which is exactly the intended G3E recovery path.
 */
export async function runProcessingPass(limit: number, leaseSeconds: number): Promise<ProcessStats> {
  const stats: ProcessStats = {
    claimed: 0,
    validated: 0,
    rejected: 0,
    imported: 0,
    alreadyImported: 0,
    failed: 0,
  };
  const claimant = claimantId();

  for (let i = 0; i < limit; i += 1) {
    if (state.stopRequested) break;

    // A flag flip / emergency stop surfaces here as feature_disabled / emergency_stop and is
    // rethrown to the cycle, which records it as a closed gate — "halts within one cycle".
    const record = await claimNextConnectorRecord(claimant, leaseSeconds);
    if (record == null) break; // no claimable work left
    stats.claimed += 1;

    try {
      let current: RecordProjection = { state: record.state, version: record.version };

      if (current.state === "claimed") {
        const validating = await transitionConnectorState({
          connectorId: record.id,
          claimant,
          tenantId: record.tenantId,
          expectedVersion: current.version,
          toState: "validating",
          eventType: "validation_started",
        });
        await validateConnectorRecord({
          connectorId: record.id,
          claimant,
          expectedVersion: validating.version,
          tenantId: record.tenantId,
        });
        const after = await readRecordProjection(record.id);
        if (after == null) {
          stats.failed += 1;
          continue;
        }
        current = after;
        if (current.state === "ready_for_import") stats.validated += 1;
        else if (current.state === "rejected") stats.rejected += 1;
      }

      if (current.state !== "ready_for_import") continue;

      const outcome = await importValidatedConnector({
        connectorId: record.id,
        claimant,
        expectedVersion: current.version,
        tenantId: record.tenantId,
      });
      if (outcome.outcome === "imported") stats.imported += 1;
      else if (outcome.outcome === "already_completed") stats.alreadyImported += 1;
    } catch (err) {
      const code = errorCodeOf(err);
      // Fail closed — a disabled flag or emergency stop ends the pass immediately.
      if (code === "feature_disabled" || code === "emergency_stop" || code === "import_emergency_stopped") {
        throw err;
      }
      stats.failed += 1;
      // Record-level failure only: the record keeps its lease (which expires and makes it
      // reclaimable) or was already moved to a terminal/failed state inside the service's own
      // transaction. Nothing is force-transitioned from out here.
      logLine("record_failed", { connectorId: record.id, code });
    }
  }
  return stats;
}

// ---------------------------------------------------------------------------
// One cycle
// ---------------------------------------------------------------------------
export async function runConnectorCycle(options?: ConnectorRuntimeOptions): Promise<CycleStats> {
  const opts = options ? resolveOptions(options) : state.options;
  const startedAt = new Date();
  const t0 = performance.now();

  const gate = await resolveGate();
  let sweep: SweepStats = { candidates: 0, created: 0, skipped: 0, failed: 0 };
  let processed: ProcessStats = { claimed: 0, validated: 0, rejected: 0, imported: 0, alreadyImported: 0, failed: 0 };
  let recovery: CycleStats["recovery"] = null;

  if (gate.open) {
    try {
      sweep = await sweepUnprocessedHandoffs(opts.sweepLimit);
      processed = await runProcessingPass(opts.processLimit, opts.leaseSeconds);
      if (!state.stopRequested) {
        const pool = await runConnectorWorkerPool({
          workerCount: opts.workerCount,
          leaseSeconds: opts.leaseSeconds,
          shouldStop: () => state.stopRequested,
        });
        recovery = {
          claimed: pool.claimed,
          imported: pool.imported,
          alreadyCompleted: pool.alreadyCompleted,
          stale: pool.stale,
        };
      }
    } catch (err) {
      const code = errorCodeOf(err);
      // A mid-cycle flag flip is NOT a runtime failure — it is the connector being switched off,
      // which is exactly the designed fail-closed behaviour. Everything else is a real failure.
      if (code !== "feature_disabled" && code !== "emergency_stop" && code !== "import_emergency_stopped") {
        throw err;
      }
      logLine("cycle_halted_by_flag", { code });
    }
  }

  const finished = new Date();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.round(performance.now() - t0),
    gateOpen: gate.open,
    sweep,
    process: processed,
    recovery,
  };
}

// ---------------------------------------------------------------------------
// Supervisor — start / stop / status
// ---------------------------------------------------------------------------
function scheduleNext(delayMs: number): void {
  if (state.stopRequested || state.options.singleCycle) return;
  state.timer = setTimeout(() => {
    void tick();
  }, delayMs);
  state.timer.unref?.();
}

function backoffFor(consecutiveFailures: number): number {
  const { backoffBaseMs, backoffMaxMs } = state.options;
  const scaled = backoffBaseMs * 2 ** Math.max(0, consecutiveFailures - 1);
  return Math.min(backoffMaxMs, scaled);
}

async function tick(): Promise<void> {
  if (state.stopRequested) return;
  state.timer = null;

  const run = (async () => {
    try {
      const cycle = await runConnectorCycle();
      state.lastCycle = cycle;
      state.cyclesCompleted += 1;
      state.consecutiveFailures = 0;
      state.idleReason = cycle.gateOpen ? null : (await resolveGate()).reason;
      scheduleNext(state.options.pollIntervalMs);
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastErrorCode = errorCodeOf(err);
      state.lastErrorAt = new Date().toISOString();
      logLine("cycle_failed", { code: state.lastErrorCode, consecutiveFailures: state.consecutiveFailures });
      if (state.consecutiveFailures >= state.options.maxConsecutiveFailures) {
        // Give up into a VISIBLE stopped state rather than looping hot forever.
        state.status = "stopped";
        state.idleReason = "failure_budget_exhausted";
        logLine("stopped_failure_budget_exhausted", {
          consecutiveFailures: state.consecutiveFailures,
          code: state.lastErrorCode,
        });
        return;
      }
      scheduleNext(backoffFor(state.consecutiveFailures));
    }
  })();

  state.inFlight = run;
  try {
    await run;
  } finally {
    if (state.inFlight === run) state.inFlight = null;
  }
}

/**
 * Arm the connector runtime. Idempotent, non-throwing, and never blocks the caller: every failure
 * mode resolves into a logged, observable `stopped` state instead of propagating into boot.
 *
 * Call this AFTER the HTTP server is listening — a connector problem must never delay or fail the
 * main application.
 */
export function startConnectorRuntime(options: ConnectorRuntimeOptions = {}): void {
  if (state.status === "running" || state.status === "draining") return;

  state.options = resolveOptions(options);
  state.stopRequested = false;
  state.consecutiveFailures = 0;
  state.lastErrorCode = null;
  state.lastErrorAt = null;

  if (!connectorDbConfigured()) {
    // Exactly one line, then silence — a deployment without the Partner connector env is unchanged.
    state.status = "not_configured";
    state.idleReason = "not_started";
    logLine("not_configured");
    return;
  }

  state.status = "running";
  state.startedAt = new Date().toISOString();
  state.idleReason = null;

  // Preflight + first cycle are deliberately fire-and-forget: boot never awaits the connector.
  void (async () => {
    try {
      const capability = await getPartnerAdminCapability();
      if (!capability.ok) {
        // Without a cross-tenant read the sweep would return zero rows for every tenant, forever,
        // and look healthy. Park visibly instead.
        state.status = "stopped";
        state.idleReason = "admin_capability_unavailable";
        state.lastErrorCode = capability.code;
        state.lastErrorAt = new Date().toISOString();
        logLine("stopped_admin_capability", { code: capability.code });
        return;
      }
      const gate = await resolveGate();
      state.idleReason = gate.reason;
      logLine("started", {
        gateOpen: gate.open,
        idleReason: gate.reason,
        pollIntervalMs: state.options.pollIntervalMs,
        workerCount: state.options.workerCount,
      });
      await tick();
    } catch (err) {
      state.status = "stopped";
      state.lastErrorCode = errorCodeOf(err);
      state.lastErrorAt = new Date().toISOString();
      logLine("stopped_start_failed", { code: state.lastErrorCode });
    }
  })();
}

/**
 * Cooperative shutdown. Cancels the next scheduled cycle, asks the in-flight cycle to stop taking
 * NEW work, and waits for it to finish. In-flight transactions are never force-killed — each one
 * commits or rolls back atomically inside its own `withConnectorTx`, so no lease is leaked: a claim
 * whose work did not complete simply expires and becomes reclaimable, which is the same path the
 * crash-restart case already uses.
 */
export async function stopConnectorRuntime(timeoutMs = 10_000): Promise<void> {
  if (state.status === "not_configured" && state.inFlight == null) {
    state.stopRequested = true;
    return;
  }
  state.stopRequested = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.status === "running") {
    state.status = "draining";
    state.idleReason = "shutting_down";
  }
  const inFlight = state.inFlight;
  if (inFlight) {
    await Promise.race([inFlight.catch(() => undefined), sleep(timeoutMs)]);
  }
  state.status = "stopped";
  state.idleReason = "shutting_down";
  state.inFlight = null;
  logLine("stopped", { cyclesCompleted: state.cyclesCompleted });
}

/** In-process runtime state for the super-admin observability surface. No DB access. */
export function getConnectorRuntimeSnapshot(): ConnectorRuntimeSnapshot {
  return {
    status: state.status,
    idleReason: state.idleReason,
    startedAt: state.startedAt,
    cyclesCompleted: state.cyclesCompleted,
    consecutiveFailures: state.consecutiveFailures,
    inFlight: state.inFlight != null,
    lastCycle: state.lastCycle,
    lastErrorCode: state.lastErrorCode,
    lastErrorAt: state.lastErrorAt,
  };
}

/** TEST-ONLY: reset the module singleton between suites. Never called by production code. */
export function __resetConnectorRuntimeForTest(): void {
  if (state.timer) clearTimeout(state.timer);
  state.status = "not_configured";
  state.idleReason = "not_started";
  state.startedAt = null;
  state.cyclesCompleted = 0;
  state.consecutiveFailures = 0;
  state.lastCycle = null;
  state.lastErrorCode = null;
  state.lastErrorAt = null;
  state.timer = null;
  state.stopRequested = false;
  state.inFlight = null;
  state.options = resolveOptions();
}
