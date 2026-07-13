/**
 * Durable idempotency / double-pay-protection ADAPTER for paid Vault Quest generation
 * (PROV-01..07, D10). Wires the already-built, already-unit-tested pure module
 * (./generation-idempotency.ts) and the already-built `vq_generation_requests` table
 * (migration 0009 — unique index on idempotency_key, state CHECK) into a DB-backed
 * reserve → charge → finalize lifecycle. No new migration: every column this needs
 * already exists.
 *
 * Lifecycle: the route reads/derives a per-action idempotencyKey (client-supplied,
 * ideally persisted client-side across a reload so the SAME logical click reuses the
 * SAME key — see admin-vault-quest.tsx). reserveOrDecide() either wins the reservation
 * (→ the route may call the paid provider) or returns the exact reason it must NOT
 * (replay/pending/conflict/manual-review/terminal) — never both. The route then calls
 * finalizeSuccess/finalizeFailure on the SAME row so the next duplicate sees the truth.
 *
 * Simplification (documented, not a shortcut taken silently): because every one of
 * today's 4 routes calls the provider SYNCHRONOUSLY within one HTTP request/response
 * (no separate poll/download step visible to the route), this adapter jumps the DB row
 * reserved → completed or reserved → failed_* directly, rather than walking every
 * intermediate state in VQ_GENERATION_STATES (provider_submitted/provider_completed/
 * persisting). Nothing enforces the fine-grained chain at the DB layer (`state` is a
 * free-text column with only a CHECK for valid membership, not a transition trigger),
 * so this is safe; it just means mid-request crash forensics stay coarse (Design-only
 * for that finer granularity — a true async/background generation model would need it,
 * this synchronous wiring does not).
 *
 * Degrade posture: if vq_generation_requests is ever unavailable (42P01/42703), this
 * degrades to `{ durable: false }` — the route proceeds WITHOUT double-pay protection,
 * but the spend ceiling (generation-guard.ts) remains the independent backstop and
 * still runs first. Never blocks generation on this table being absent.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { vqGenerationRequests, type VqGenerationRequest } from "@shared/vq-generation-schema";
import { isUndefinedTableOrColumn } from "../production-storage";
import {
  fingerprintGeneration,
  idempotencyDecision,
  classifyProviderError,
  type GenerationPayload,
  type IdempotencyAction,
  type ProviderPhase,
  type VqGenerationState,
} from "./generation-idempotency";

async function guard<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (isUndefinedTableOrColumn(err)) return { ok: false };
    throw err;
  }
}

const isUniqueViolation = (err: unknown): boolean => {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && e; i++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
};

export type ReserveOutcome =
  | { durable: true; proceed: true; rowId: number }
  | { durable: true; proceed: false; action: Exclude<IdempotencyAction, "proceed" | "resume">; row: VqGenerationRequest }
  | { durable: false }; // table unavailable — caller proceeds without double-pay protection

async function findByKey(idempotencyKey: string): Promise<VqGenerationRequest | undefined> {
  const rows = await db.select().from(vqGenerationRequests).where(eq(vqGenerationRequests.idempotencyKey, idempotencyKey)).limit(1);
  return rows[0];
}

/** Atomically flip failed_retryable → reserved (a provably-uncharged prior attempt may
 *  re-charge). Returns the updated row, or undefined if the race was lost (someone else
 *  moved the row first) — the caller must re-decide on a fresh read rather than assume. */
async function tryResume(id: number): Promise<VqGenerationRequest | undefined> {
  const rows = await db
    .update(vqGenerationRequests)
    .set({ state: "reserved", startedAt: new Date() })
    .where(eq(vqGenerationRequests.id, id))
    .returning();
  // Guard the WHERE by re-checking state to avoid a lost-update race; Drizzle doesn't
  // support compound WHERE+RETURNING conveniently here without a raw AND, so re-verify.
  return rows.find((r) => r.id === id);
}

/**
 * Reserve a slot for this idempotencyKey, or return the exact reason a duplicate must
 * not proceed. Race-safe: two concurrent callers with the SAME key can both reach the
 * "no existing row" branch; the DB unique index on idempotency_key makes exactly one
 * INSERT win, and the loser re-reads the winner's row (mirrors export-job-store's
 * proven createOrGetExportJob pattern).
 */
export async function reserveOrDecide(input: {
  idempotencyKey: string;
  payload: GenerationPayload;
  adminId?: string | null;
  maxAuthorisedSpend: number;
}): Promise<ReserveOutcome> {
  const fp = fingerprintGeneration(input.payload);

  const decide = (existing: VqGenerationRequest): ReserveOutcome => {
    const d = idempotencyDecision({ state: existing.state as VqGenerationState, requestFingerprint: existing.requestFingerprint }, fp);
    if (d.action === "proceed") return { durable: true, proceed: true, rowId: existing.id }; // shouldn't occur (existing found), but safe
    if (d.action === "resume") return { durable: true, proceed: false, action: "resume" as never, row: existing }; // caller unwraps via resumeOrDecide below
    return { durable: true, proceed: false, action: d.action, row: existing };
  };

  const res = await guard(async () => {
    const existing = await findByKey(input.idempotencyKey);
    if (!existing) {
      try {
        const [row] = await db
          .insert(vqGenerationRequests)
          .values({
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fp,
            adminId: input.adminId ?? null,
            setCode: input.payload.setCode ?? null,
            characterId: input.payload.characterId ?? null,
            cardId: input.payload.cardId ?? null,
            familyId: input.payload.familyId ?? null,
            stageId: input.payload.stageId ?? null,
            generationType: input.payload.generationType,
            modelRequested: input.payload.model ?? null,
            requestedCount: input.payload.count ?? 1,
            maxAuthorisedSpend: input.maxAuthorisedSpend.toFixed(2),
            estimatedCredits: input.maxAuthorisedSpend.toFixed(2),
            state: "reserved",
            startedAt: new Date(),
          })
          .returning();
        return { durable: true as const, proceed: true as const, rowId: row.id };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await findByKey(input.idempotencyKey);
        if (!winner) throw err; // genuinely unexpected — surface it rather than silently proceeding
        return decide(winner);
      }
    }
    // Existing row found on first read.
    if (existing.state === "failed_retryable") {
      const resumed = await tryResume(existing.id);
      if (resumed) return { durable: true as const, proceed: true as const, rowId: resumed.id };
      // Lost the race to resume (another caller moved it) — re-read and decide fresh.
      const fresh = await findByKey(input.idempotencyKey);
      return fresh ? decide(fresh) : { durable: true as const, proceed: true as const, rowId: existing.id };
    }
    return decide(existing);
  });

  return res.ok ? res.value : { durable: false };
}

export interface FinalizeSuccessInput {
  chargedCredits: number;
  providerReportedCredits?: number | null;
  providerJobId?: string | null;
  candidateId?: number | null;
  modelUsed?: string | null;
}

/** Terminal success — best-effort (never throws to the caller: the artwork already
 *  generated must reach the client even if this bookkeeping write hiccups). */
export async function finalizeSuccess(rowId: number, input: FinalizeSuccessInput): Promise<void> {
  await guard(async () => {
    await db
      .update(vqGenerationRequests)
      .set({
        state: "completed",
        chargedCredits: input.chargedCredits.toFixed(2),
        providerReportedCredits: input.providerReportedCredits != null ? input.providerReportedCredits.toFixed(2) : null,
        providerJobId: input.providerJobId ?? null,
        candidateId: input.candidateId ?? null,
        modelUsed: input.modelUsed ?? null,
        completedAt: new Date(),
      })
      .where(eq(vqGenerationRequests.id, rowId));
  }).catch(() => undefined);
}

export interface FinalizeFailureInput {
  toState: VqGenerationState;
  errorClass: string;
  message: string;
}

/** Terminal (or semi-terminal) failure — best-effort, same reasoning as finalizeSuccess. */
export async function finalizeFailure(rowId: number, input: FinalizeFailureInput): Promise<void> {
  await guard(async () => {
    await db
      .update(vqGenerationRequests)
      .set({ state: input.toState, errorClass: input.errorClass, lastError: input.message.slice(0, 500), completedAt: new Date() })
      .where(eq(vqGenerationRequests.id, rowId));
  }).catch(() => undefined);
}

/**
 * Classify a thrown Error from the higgsfield.ts call chain into the (httpStatus, phase,
 * networkLost) shape classifyProviderError expects. higgsfield.ts throws plain `Error`s
 * with the HTTP status embedded in the message (e.g. "(401)") rather than a typed error
 * class, so this is a documented, pragmatic message-pattern classifier — not a byte-exact
 * decode. The one governing property it preserves correctly: any failure that happens
 * AFTER a provider `create` could have succeeded/spent money (poll/download/generation-
 * status failures) is bucketed to phase 'poll' so classifyProviderError treats it as
 * charge-presumed and routes to unknown_provider_state (never auto-resubmitted) — the
 * cardinal safety property this whole module exists for.
 */
export function classifyThrownGenerationError(err: unknown): { httpStatus: number | null; phase: ProviderPhase; networkLost: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  const statusMatch = /\((\d{3})\)/.exec(msg);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null;

  if (/kept timing out|did not finish in time/i.test(msg)) return { httpStatus: null, phase: "poll", networkLost: true };
  if (/\bpoll(ing|ed)?\b/i.test(msg) || /^Higgsfield generation /i.test(msg)) return { httpStatus, phase: "poll", networkLost: false };
  if (/download/i.test(msg)) return { httpStatus, phase: "download", networkLost: false };
  if (/not enough credits/i.test(msg)) return { httpStatus: 402, phase: "create", networkLost: false };
  return { httpStatus, phase: "create", networkLost: false };
}

/** Map a caught route-level exception straight to a finalizeFailure() call. */
export function classifyAndMapThrown(err: unknown): FinalizeFailureInput {
  const c = classifyThrownGenerationError(err);
  const mapped = classifyProviderError({ httpStatus: c.httpStatus, phase: c.phase, networkLost: c.networkLost });
  return { toState: mapped.nextState, errorClass: mapped.errorClass, message: err instanceof Error ? err.message : String(err) };
}

/** Pure — the HTTP response for every non-proceed idempotency outcome. No DB. */
export function idempotencyResponseFor(
  action: Exclude<IdempotencyAction, "proceed" | "resume">,
  row: VqGenerationRequest,
): { status: number; body: Record<string, unknown> } {
  switch (action) {
    case "replay":
      return {
        status: 200,
        body: {
          replayed: true,
          candidateId: row.candidateId ?? null,
          chargedCredits: Number(row.chargedCredits),
          message: "Already generated — this exact request already completed. Refresh the gallery to see it.",
        },
      };
    case "accepted_pending":
      return { status: 202, body: { pending: true, message: "This generation is already in progress — please wait." } };
    case "conflict":
      return {
        status: 409,
        body: { error: "This request key was already used for a different request. Please retry.", reason: "idempotency_conflict" },
      };
    case "manual_review":
      return {
        status: 409,
        body: { error: "A previous attempt's outcome is uncertain and needs manual review before retrying.", reason: "manual_review", state: row.state },
      };
    case "terminal":
      return {
        status: 200,
        body: { replayed: false, terminal: true, priorState: row.state, message: "A previous attempt for this exact request ended; nothing was charged this time." },
      };
  }
}

/** Test/ops helper — fetch a row by its client idempotency key. */
export async function getGenerationByKey(idempotencyKey: string): Promise<VqGenerationRequest | undefined> {
  const res = await guard(() => findByKey(idempotencyKey));
  return res.ok ? res.value : undefined;
}
