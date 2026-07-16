/**
 * Data access for card identification — idempotency ledger, spend snapshot,
 * correction analytics, and the DB-backed Knowledge Engine set lookup.
 *
 * Non-PII by construction: the corrections + request tables store only catalogue
 * codes, confidence bands, provider/model and a staff actor id — never images,
 * customer data, cert numbers, or provider chain-of-thought.
 */
import { desc, gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { cardIdentificationRequests, cardIdentificationCorrections } from "@shared/schema";
import { searchSets } from "../pokemon-knowledge-store";
import type { CardCandidate, CardIdentificationSuggestionV1 } from "@shared/card-identification";
import type { SetLookup } from "./pipeline";
import type { SpendSnapshot } from "./spend";

// ── Idempotency ───────────────────────────────────────────────────────────────
export async function findByIdempotencyKey(key: string): Promise<{ result: CardIdentificationSuggestionV1 | null } | null> {
  const [row] = await db
    .select({ result: cardIdentificationRequests.result })
    .from(cardIdentificationRequests)
    .where(sql`${cardIdentificationRequests.idempotencyKey} = ${key}`)
    .limit(1);
  if (!row) return null;
  return { result: (row.result as unknown as CardIdentificationSuggestionV1) ?? null };
}

export async function recordRequest(input: {
  idempotencyKey: string;
  certId: string | null;
  provider: string;
  model: string;
  costUsd: number | null;
  result: CardIdentificationSuggestionV1;
  actor: string | null;
}): Promise<void> {
  await db
    .insert(cardIdentificationRequests)
    .values({
      idempotencyKey: input.idempotencyKey,
      certId: input.certId,
      provider: input.provider,
      model: input.model,
      costUsd: input.costUsd != null ? String(input.costUsd) : null,
      result: input.result as unknown as Record<string, unknown>,
      actor: input.actor,
    })
    .onConflictDoNothing();
}

// ── Spend snapshot (multi-machine safe — counts from the DB) ──────────────────
export async function getSpendSnapshot(): Promise<SpendSnapshot> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [day] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(cardIdentificationRequests)
    .where(gte(cardIdentificationRequests.createdAt, dayAgo));
  const [hour] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(cardIdentificationRequests)
    .where(gte(cardIdentificationRequests.createdAt, hourAgo));
  return { callsToday: Number(day?.n ?? 0), callsThisHour: Number(hour?.n ?? 0) };
}

// ── Correction analytics (non-PII) ───────────────────────────────────────────
export interface CorrectionRow {
  requestId: string;
  field: string;
  suggestedValue: string | null;
  decision: "accepted" | "rejected" | "changed";
  correctedValue: string | null;
  confidenceBand: string | null;
  setKey: string | null;
  era: string | null;
  language: string | null;
  provider: string | null;
  model: string | null;
}

// Analytics values are catalogue codes / short labels only — enforce a safe
// charset so no free-text PII (emails, notes, names) can land in this table,
// keeping "non-PII by construction" a real guarantee rather than a convention.
const SAFE_CODE = /^[A-Za-z0-9_.\- ]{0,64}$/;
function safeCode(v: string | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim().slice(0, 64);
  return SAFE_CODE.test(s) ? s || null : null;
}

export async function recordCorrections(rows: CorrectionRow[], actor: string | null): Promise<number> {
  const bounded = rows.slice(0, 40).map((r) => ({
    requestId: String(r.requestId).slice(0, 80),
    field: safeCode(r.field) ?? "unknown",
    suggestedValue: safeCode(r.suggestedValue),
    decision: r.decision,
    correctedValue: safeCode(r.correctedValue),
    confidenceBand: safeCode(r.confidenceBand),
    setKey: safeCode(r.setKey),
    era: safeCode(r.era),
    language: safeCode(r.language),
    provider: safeCode(r.provider),
    model: safeCode(r.model),
    actor: actor?.slice(0, 80) ?? null,
  }));
  if (bounded.length === 0) return 0;
  await db.insert(cardIdentificationCorrections).values(bounded);
  return bounded.length;
}

/** Accuracy dashboard foundation — bounded aggregate, no PII. */
export async function accuracySummary(): Promise<{
  totals: { decision: string; n: number }[];
  byField: { field: string; decision: string; n: number }[];
}> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const totals = await db
    .select({ decision: cardIdentificationCorrections.decision, n: sql<number>`cast(count(*) as int)` })
    .from(cardIdentificationCorrections)
    .where(gte(cardIdentificationCorrections.createdAt, thirtyDaysAgo))
    .groupBy(cardIdentificationCorrections.decision);
  const byField = await db
    .select({ field: cardIdentificationCorrections.field, decision: cardIdentificationCorrections.decision, n: sql<number>`cast(count(*) as int)` })
    .from(cardIdentificationCorrections)
    .where(gte(cardIdentificationCorrections.createdAt, thirtyDaysAgo))
    .groupBy(cardIdentificationCorrections.field, cardIdentificationCorrections.decision)
    .orderBy(desc(sql`count(*)`))
    .limit(100);
  return {
    totals: totals.map((t) => ({ decision: t.decision, n: Number(t.n) })),
    byField: byField.map((t) => ({ field: t.field, decision: t.decision, n: Number(t.n) })),
  };
}

// ── DB-backed Knowledge Engine set lookup ─────────────────────────────────────
/** Resolve candidate sets from pokemon_set_knowledge by code then name. */
export const dbSetLookup: SetLookup = async ({ setCode, name }) => {
  const candidates: CardCandidate[] = [];
  const seen = new Set<string>();
  const push = (rows: Awaited<ReturnType<typeof searchSets>>["items"], reason: string) => {
    for (const s of rows) {
      const key = `${s.setKey}:${s.language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        setId: s.setKey,
        setName: s.canonicalName,
        setCode: s.setCode,
        collectorNumber: null,
        language: s.language,
        era: s.era,
        reason,
      });
    }
  };
  try {
    if (setCode) push((await searchSets({ q: setCode, pageSize: 5 })).items, `set code "${setCode}"`);
    if (candidates.length === 0 && name) push((await searchSets({ q: name, pageSize: 5 })).items, `set name "${name}"`);
  } catch {
    // Knowledge directory unavailable — return no candidates (manual entry still works).
  }
  return candidates;
};
