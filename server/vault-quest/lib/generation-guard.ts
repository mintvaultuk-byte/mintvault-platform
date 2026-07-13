/**
 * Durable spend gate for paid Vault Quest generation (PROV-07), Phase 10A-2.
 *
 * The ONLY existing dedup/limit was a client-side ref; nothing capped total spend
 * across reloads, tabs, admins, or the 2 Fly machines. This module enforces a
 * HARD ceiling BEFORE any provider `create`, using conservative ceilings from
 * vq_config (server/vault-quest/lib/vq-config.ts, owner-gated in prod) and live
 * hourly/daily windows summed from vq_generation_requests.
 *
 * Degrade posture (never fully open, never block prod):
 *   • vq_config absent      → conservative CODE defaults (per-request caps still on).
 *   • vq_generation_requests absent → windows treated as 0 (per-request caps still on;
 *     the cross-machine hourly/daily caps simply don't bind until the table exists).
 * So a not-yet-migrated DB keeps generating, but a single request can never exceed
 * the per-request/ per-batch credit cap.
 *
 * Scope→ceiling mapping (owner decisions D8/D9):
 *   • single / batch / card → per-request image + credit caps.
 *   • family ("one image per character in one press") → governed by the larger
 *     per-BATCH credit ceiling, NOT the 3-image cap, so a big family isn't blocked.
 *
 * The pure arithmetic lives in generation-idempotency.ts (spendDecision, unit-tested);
 * this is the DB adapter. Idempotency (double-pay protection) is a follow-up (D10).
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { vqConfig } from "@shared/vq-config-schema";
import { vqGenerationRequests } from "@shared/vq-generation-schema";
import { isUndefinedTableOrColumn } from "../production-storage";
import { resolveVqCeilings, type VqSpendCeilings } from "./vq-config";
import { spendDecision, type SpendReason } from "./generation-idempotency";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // 42P01 (table absent) or 42703 (partial migration) → degrade to conservative
    // defaults / zero windows; the per-request cap still binds and nothing 500s.
    if (isUndefinedTableOrColumn(err)) return fallback;
    throw err;
  }
}

export type GenScope = "single" | "batch" | "family";

export interface SpendVerdict {
  allow: boolean;
  reason: SpendReason;
  estimatedCredits: number;
  /** HTTP status the route should use on denial (200 when allowed). */
  http: number;
  /** Safe, admin-facing message (no secrets). */
  message: string;
}

/** Load ceilings from vq_config (degrading to code defaults on 42P01). */
async function loadCeilings(): Promise<VqSpendCeilings> {
  const rows = await safe(async () => {
    const r = await db.select({ key: vqConfig.key, value: vqConfig.value }).from(vqConfig);
    return Object.fromEntries(r.map((x) => [x.key, x.value])) as Record<string, string>;
  }, {} as Record<string, string>);
  return resolveVqCeilings(rows);
}

/** Live spend windows summed from vq_generation_requests (0 when the table is absent). */
async function loadWindows(nowMs: number): Promise<{ requestsThisHour: number; creditsThisDay: number }> {
  const hourAgo = new Date(nowMs - 60 * 60 * 1000);
  const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000);
  return safe(async () => {
    const [row] = await db
      .select({
        reqHour: sql<number>`count(*) filter (where ${vqGenerationRequests.createdAt} >= ${hourAgo})`,
        crDay: sql<number>`coalesce(sum(${vqGenerationRequests.chargedCredits}) filter (where ${vqGenerationRequests.createdAt} >= ${dayAgo}), 0)`,
      })
      .from(vqGenerationRequests);
    return { requestsThisHour: Number(row?.reqHour ?? 0), creditsThisDay: Number(row?.crDay ?? 0) };
  }, { requestsThisHour: 0, creditsThisDay: 0 });
}

function messageFor(reason: SpendReason, est: number, c: VqSpendCeilings): string {
  switch (reason) {
    case "disabled":
      return "AI generation is temporarily turned off.";
    case "too_many_images":
      return `That asks for more images than the ${c.maxImagesPerRequest}-per-request limit.`;
    case "per_request_ceiling":
      return `That would cost about ${est} credits, over the ${c.maxCreditsPerRequest}-credit per-request limit.`;
    case "hourly_limit":
      return `You've hit the hourly generation limit (${c.maxRequestsPerHour}/hour). Try again shortly.`;
    case "daily_ceiling":
      return `That would pass the daily spend ceiling of ${c.maxCreditsPerDay} credits. It resets tomorrow.`;
    default:
      return "ok";
  }
}

/**
 * Read-only snapshot of the current ceilings + live windows (Phase 10A-5 ops
 * status) — reuses the exact same DB reads/degrade path as the real gate, so the
 * numbers an operator sees are always the numbers the gate is actually using.
 * Never denies anything; purely for display.
 */
export async function getSpendSnapshot(nowMs: number): Promise<{ ceilings: VqSpendCeilings; requestsThisHour: number; creditsThisDay: number }> {
  const ceilings = await loadCeilings();
  const windows = await loadWindows(nowMs);
  return { ceilings, ...windows };
}

/**
 * The pre-provider spend gate. Resolves ceilings + live windows and runs the pure
 * spendDecision for the given scope. Call this and, on `!allow`, return
 * `res.status(verdict.http).json({ error: verdict.message, reason: verdict.reason })`
 * WITHOUT calling the provider.
 */
export async function checkGenerationSpend(input: {
  requestedImages: number;
  perImageCredits: number;
  scope: GenScope;
  nowMs: number;
}): Promise<SpendVerdict> {
  const { requestedImages, perImageCredits, scope, nowMs } = input;
  const base = await loadCeilings();
  const windows = await loadWindows(nowMs);

  // Family is a batch: cap by per-batch credits, not the small per-image count.
  const perRequestImages = scope === "family" ? Number.MAX_SAFE_INTEGER : base.maxImagesPerRequest;
  const perRequestCredits = scope === "family" ? base.maxCreditsPerBatch : base.maxCreditsPerRequest;

  const decision = spendDecision(requestedImages, perImageCredits, {
    maxImagesPerRequest: perRequestImages,
    maxCreditsPerRequest: perRequestCredits,
    requestsThisHour: windows.requestsThisHour,
    maxRequestsPerHour: base.maxRequestsPerHour,
    creditsThisDay: windows.creditsThisDay,
    maxCreditsPerDay: base.maxCreditsPerDay,
  });

  const http = decision.allow ? 200 : decision.reason === "disabled" ? 503 : 429;
  return {
    allow: decision.allow,
    reason: decision.reason,
    estimatedCredits: decision.estimatedCredits,
    http,
    message: decision.allow ? "ok" : messageFor(decision.reason, decision.estimatedCredits, base),
  };
}

/**
 * Best-effort append of a completed paid generation into vq_generation_requests so
 * the hourly/daily windows accumulate real spend. Records ACTUAL images produced
 * (what was charged), not the requested max. Never throws — a failed record must
 * not fail a generation that already succeeded; unavailability degrades silently.
 *
 * NOTE (single-admin): the check-then-record window is a benign TOCTOU — two
 * concurrent presses could both pass the gate before either records. Acceptable for
 * the single-owner tool; the reserve-before-spend idempotency lifecycle (D10 follow-up)
 * closes it. The per-request hard cap always bounds a single press regardless.
 */
export async function recordGenerationAttempt(input: {
  adminId?: string | null;
  generationType: string;
  scope: GenScope;
  imagesProduced: number;
  perImageCredits: number;
  model?: string | null;
  characterId?: string | null;
  cardId?: string | null;
  setCode?: string | null;
  providerJobId?: string | null;
  nowMs: number;
}): Promise<void> {
  const charged = Math.max(0, input.imagesProduced) * Math.max(0, input.perImageCredits);
  await safe(async () => {
    await db.insert(vqGenerationRequests).values({
      // no client idempotency key yet (D10) → a server-minted per-attempt key so the
      // unique index is satisfied and every attempt counts toward the windows.
      idempotencyKey: `srv:${input.generationType}:${input.nowMs}:${Math.round(charged * 100)}:${input.characterId ?? input.cardId ?? "?"}`,
      requestFingerprint: "unversioned",
      adminId: input.adminId ?? null,
      setCode: input.setCode ?? null,
      characterId: input.characterId ?? null,
      cardId: input.cardId ?? null,
      generationType: input.generationType,
      modelRequested: input.model ?? null,
      modelUsed: input.model ?? null,
      requestedCount: Math.max(0, input.imagesProduced),
      maxAuthorisedSpend: String(charged),
      estimatedCredits: String(charged),
      chargedCredits: String(charged),
      state: "completed",
      providerJobId: input.providerJobId ?? null,
      completedAt: new Date(input.nowMs),
    });
  }, undefined).catch(() => undefined);
}
