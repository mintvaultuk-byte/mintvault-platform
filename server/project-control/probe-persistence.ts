/**
 * Project Control — persisting application, migration and flag evidence.
 *
 * The probes already existed and already refused to lie (`app-probe.ts` never turns unreachable
 * into undeployed; `flag-evidence.ts` keeps absent apart from explicitly-false). What they lacked
 * was memory: every answer vanished with the request, so there was no history, no last-known-good,
 * and nothing shared between the two Fly machines.
 *
 * This module writes those answers through the append-only repository, under the same rules the
 * GitHub sync follows.
 *
 * THE RULE THAT MATTERS MOST HERE
 * -------------------------------
 * A failed observation is RECORDED, never substituted. `getLatestGoodSnapshot` filters to usable
 * freshness, so after an outage the newest row says UNAVAILABLE while the newest usable row is
 * still the real deployed SHA. That is what lets the dashboard say "staging was running 372a98f3
 * as of 20 minutes ago, and we cannot reach it right now" instead of blanking — which is the
 * difference between a tool an operator trusts and one they learn to ignore.
 *
 * WHAT IS DELIBERATELY NOT DONE
 * -----------------------------
 * No cross-source atomicity. GitHub, the applications, the databases and the flags are four
 * independent external systems; a transaction spanning them would be a lie about what can be
 * guaranteed. Each source succeeds or fails on its own and says so.
 */
import {
  resolveProjectControlEnvironment,
  type ProjectControlEnvironment,
} from "@shared/project-control-environment";
import { probeAllApplications, type AppProbeResult, type ProbeFetch } from "./app-probe";
import { collectFlagEvidence, type FlagEvidence } from "./flag-evidence";
import {
  createRun,
  completeRun,
  markRunning,
  insertSnapshot,
  getActiveRun,
  expireAbandonedRuns,
  withTransaction,
  type EvidenceDb,
} from "./evidence-repository";
import { withLease, workerIdentity, type LeaseDb } from "./sync-lease";

export const APPLICATION_SOURCE = "application";
export const FLAG_SOURCE = "feature_flag";
export const DATABASE_SOURCE = "database";

export type ProbeDb = EvidenceDb & LeaseDb;

/**
 * How long an observation stays CURRENT before a reader should treat it as ageing.
 *
 * Applications can be redeployed at any moment, so their evidence goes stale quickly. Flags change
 * only by deliberate operator action, so theirs lasts longer. Neither value causes deletion — they
 * inform the freshness label a reader applies.
 */
export const APPLICATION_VALID_MS = 10 * 60 * 1000;
export const FLAG_VALID_MS = 30 * 60 * 1000;

export type ProbeOutcome =
  | { started: true; syncId: string }
  | { started: false; reason: "already_running"; syncId: string };

/** Shared preamble: reap abandoned runs, refuse to duplicate an active one, then record the run. */
async function beginProbeRun(
  db: ProbeDb,
  sourceType: string,
  input: { triggerType: "manual" | "scheduled" | "startup"; actor?: string | null; target: string },
  env: NodeJS.ProcessEnv
): Promise<ProbeOutcome> {
  // Without this a run abandoned by a killed process would report "already running" forever.
  await expireAbandonedRuns(db, sourceType);

  const active = await getActiveRun(db, sourceType);
  if (active) return { started: false, reason: "already_running", syncId: active.syncId };

  const syncId = await createRun(db, {
    sourceType,
    triggerType: input.triggerType,
    target: input.target,
    actor: input.actor ?? null,
    workerIdentity: workerIdentity(env),
  });
  return { started: true, syncId };
}

/* ── Applications ─────────────────────────────────────────────────────────────────────────── */

/**
 * Probe both allowlisted environments and store one observation each.
 *
 * Each environment is stored independently: staging being unreachable must not stop production's
 * good answer being recorded, because they are separate facts about separate systems.
 */
export async function collectApplicationEvidence(
  db: ProbeDb,
  input: { triggerType: "manual" | "scheduled" | "startup"; actor?: string | null } = { triggerType: "manual" },
  env: NodeJS.ProcessEnv = process.env,
  http?: ProbeFetch
): Promise<ProbeOutcome> {
  const begun = await beginProbeRun(db, APPLICATION_SOURCE, { ...input, target: "fly-applications" }, env);
  if (!begun.started) return begun;
  const { syncId } = begun;

  const outcome = await withLease(db, APPLICATION_SOURCE, syncId, async () => {
    await markRunning(db, syncId);

    let probes: AppProbeResult[];
    try {
      probes = await probeAllApplications(http);
    } catch {
      // The probe module is written not to throw; this is belt-and-braces so a future change
      // cannot leave the run stuck RUNNING and wedge every later refresh.
      await completeRun(db, syncId, "FAILED", { errorCode: "application_probe_threw" });
      return;
    }

    let reachable = 0;
    await withTransaction(db, async (tx) => {
      for (const probe of probes) {
        const ok = probe.state === "current" && Boolean(probe.commit);
        if (ok) reachable += 1;
        await insertSnapshot(tx, {
          sourceType: APPLICATION_SOURCE,
          environment: probe.environment,
          entityType: "application_version",
          entityId: probe.host,
          commitSha: probe.commit,
          status: probe.state,
          // UNAVAILABLE, not STALE: a probe that resolved no commit carries no answer, and STALE
          // counts as usable — it would win the latest-good read on recency and replace the real
          // deployed SHA with a null one.
          freshness: ok ? "CURRENT" : "UNAVAILABLE",
          validUntil: ok ? new Date(Date.now() + APPLICATION_VALID_MS) : null,
          staleReason: ok ? null : (probe.reason ?? "Application version could not be established."),
          syncId,
          payload: {
            environment: probe.environment,
            host: probe.host,
            httpStatus: probe.httpStatus,
            latencyMs: probe.latencyMs,
            build: probe.build,
            timestamp: probe.timestamp,
          },
        });
      }
    });

    // PARTIAL is the honest word when one environment answered and the other did not: real
    // evidence was stored, and the view is incomplete.
    const state = reachable === probes.length ? "SUCCEEDED" : reachable > 0 ? "PARTIAL" : "UNAVAILABLE";
    await completeRun(db, syncId, state, {
      counts: { probed: probes.length, reachable },
      errorCode: reachable === 0 ? "no_application_reachable" : null,
    });
  });

  if (!outcome.ran) {
    await completeRun(db, syncId, "CANCELLED", { errorCode: "lease_held_elsewhere" });
  }
  return begun;
}

/* ── Feature flags ────────────────────────────────────────────────────────────────────────── */

/**
 * Store one observation per tracked flag.
 *
 * The environment recorded is the one this PROCESS is running in — a staging process can only
 * observe staging's environment variables. It cannot see production's, and pretending otherwise
 * would be the authority-blending this whole design exists to prevent.
 */
export async function collectFlagEvidenceSnapshots(
  db: ProbeDb,
  input: { triggerType: "manual" | "scheduled" | "startup"; actor?: string | null } = { triggerType: "manual" },
  env: NodeJS.ProcessEnv = process.env
): Promise<ProbeOutcome> {
  const environment = resolveEnvironmentName(env);
  const begun = await beginProbeRun(db, FLAG_SOURCE, { ...input, target: environment }, env);
  if (!begun.started) return begun;
  const { syncId } = begun;

  const outcome = await withLease(db, FLAG_SOURCE, syncId, async () => {
    await markRunning(db, syncId);
    const flags: FlagEvidence[] = collectFlagEvidence(env);

    await withTransaction(db, async (tx) => {
      for (const flag of flags) {
        await insertSnapshot(tx, {
          sourceType: FLAG_SOURCE,
          environment,
          entityType: "feature_flag",
          entityId: flag.name,
          status: flag.state,
          // Every flag state is a real observation, including "absent" — knowing nobody has made a
          // decision is itself the answer, so this is CURRENT rather than UNKNOWN.
          freshness: "CURRENT",
          validUntil: new Date(Date.now() + FLAG_VALID_MS),
          syncId,
          payload: { state: flag.state, source: flag.source, gates: flag.gates, note: flag.note },
        });
      }
    });

    await completeRun(db, syncId, "SUCCEEDED", { counts: { flags: flags.length } });
  });

  if (!outcome.ran) {
    await completeRun(db, syncId, "CANCELLED", { errorCode: "lease_held_elsewhere" });
  }
  return begun;
}

/**
 * Name the environment this process is connected to WITHOUT revealing a connection string.
 *
 * A Neon host is credential-adjacent, so the host never leaves the server — the same rule
 * `migration-scan.ts` already follows.
 *
 * This used to fall through to `NODE_ENV`, which every deployed Fly machine sets to `production`
 * — so a staging probe recorded its result under the label `production`. It now delegates to the
 * single strict resolver, which returns `unknown` rather than naming an estate it cannot prove.
 * Callers must check `mayWriteLabelledEvidence` before persisting under this name.
 */
export function resolveEnvironmentName(
  env: NodeJS.ProcessEnv = process.env
): ProjectControlEnvironment {
  return resolveProjectControlEnvironment(env);
}
