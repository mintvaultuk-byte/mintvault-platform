/**
 * Spend control for AI card identification — the grading side has no pre-call
 * ceiling today, so we add one modelled on the VQ pure `spendDecision`. The
 * decision is a pure function of a DB-sourced snapshot + ceilings, checked
 * BEFORE any provider call. Multi-machine safe (counts come from the DB, not an
 * in-process timer).
 */

/** Claude Haiku vision, ~1 resized image + short structured JSON out.
 *  Deliberately conservative so the per-request estimate never under-charges. */
export const IDENTIFY_COST_ESTIMATE_USD = 0.02;

export interface SpendCeilings {
  disabled: boolean;
  maxPerDay: number; // hard cap on identify calls/day
  maxPerHour: number;
}

export const DEFAULT_IDENTIFY_CEILINGS: SpendCeilings = {
  disabled: false,
  maxPerDay: Number(process.env.AI_CARD_ID_MAX_PER_DAY ?? 500),
  maxPerHour: Number(process.env.AI_CARD_ID_MAX_PER_HOUR ?? 120),
};

export interface SpendSnapshot {
  callsToday: number;
  callsThisHour: number;
}

export type SpendRefusal = "disabled" | "hourly_limit" | "daily_ceiling";

export interface SpendVerdict {
  allowed: boolean;
  reason: SpendRefusal | null;
  message: string | null;
  estimateUsd: number;
}

/** Pure: may this identify call proceed given the current usage snapshot? */
export function spendDecision(snapshot: SpendSnapshot, ceilings: SpendCeilings = DEFAULT_IDENTIFY_CEILINGS): SpendVerdict {
  const estimateUsd = IDENTIFY_COST_ESTIMATE_USD;
  if (ceilings.disabled) {
    return { allowed: false, reason: "disabled", message: "AI identification is turned off.", estimateUsd };
  }
  if (snapshot.callsThisHour >= ceilings.maxPerHour) {
    return { allowed: false, reason: "hourly_limit", message: "Hourly AI identification limit reached — try again later or enter manually.", estimateUsd };
  }
  if (snapshot.callsToday >= ceilings.maxPerDay) {
    return { allowed: false, reason: "daily_ceiling", message: "Daily AI identification limit reached — enter manually.", estimateUsd };
  }
  return { allowed: true, reason: null, message: null, estimateUsd };
}
