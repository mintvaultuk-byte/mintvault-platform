/**
 * Read-only legacy variant audit (grading admin, Phase 1 foundation).
 *
 * Given the DISTINCT historical values found in `certificates.variant` (plus how
 * many certificates carry each), this module proposes how each maps onto the
 * structured catalogue and flags the ones a human must confirm. It is PURE and
 * READ-ONLY: it never mutates a certificate and never writes the review queue —
 * it only builds the proposal rows the (future) admin queue would hold.
 *
 * Nothing here is ever auto-applied. Even a high-confidence proposal stays as a
 * `pending` review row until an admin explicitly approves it.
 */
import { mapLegacyVariant, type LegacyClassification, type LegacyMapping } from "./pokemon-rarity-catalogue";
import { mapVariantTextToCode } from "./variant-derive";

export type Confidence = "high" | "medium" | "low";

export interface LegacyAuditRow {
  /** The value exactly as stored in certificates.variant. */
  legacyValue: string;
  /** The catalogue code we classified on (after normalising code/label forms). */
  normalizedCode: string;
  /** How many certificates carry this legacy value (0 when unknown / not counted). */
  recordCount: number;
  classification: LegacyClassification;
  /** Proposed canonical catalogue value (null when ambiguous / needs a human). */
  proposedValue: string | null;
  confidence: Confidence;
  reason: string;
  /** True when an admin must confirm before this mapping could ever be applied. */
  reviewRequired: boolean;
}

/** Shape of a review-queue row (mirrors insertRarityMappingReviewSchema in
 *  shared/schema.ts). Returned as plain data — Phase 1 never inserts it. */
export interface ReviewQueueRow {
  legacyValue: string;
  proposedClassification: LegacyClassification;
  proposedValue: string | null;
  confidence: Confidence;
  reason: string;
  recordCount: number;
  reviewRequired: boolean;
  status: "pending";
}

/** Normalise a raw stored value into an UPPER_SNAKE code shape (best effort). */
function toCodeShape(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Confidence from a mapping: clear -> high, best-guess value -> medium, none -> low. */
export function confidenceFor(mapping: LegacyMapping): Confidence {
  if (!mapping.ambiguous && mapping.value) return "high";
  if (mapping.value) return "medium";
  return "low";
}

/**
 * Classify one raw legacy value. Resilient to BOTH storage forms:
 *   • code form  — "REVERSE_HOLO", "FULL_ART"      (what the grader writes today)
 *   • label form — "Reverse Holo", "None / Regular" (older / manual entries)
 * We try the code-shaped value and the free-text-mapped code, and keep whichever
 * gives the more confident mapping (clear > best-guess > none).
 */
export function classifyLegacyValue(rawValue: string): Omit<LegacyAuditRow, "recordCount"> {
  const raw = String(rawValue ?? "").trim();
  const codeShape = toCodeShape(raw);
  const viaText = mapVariantTextToCode(raw); // "" | "OTHER" | a real code

  // Candidate codes to try, most-specific first, de-duplicated and non-empty.
  const candidates = [codeShape, viaText].filter((c): c is string => Boolean(c));
  const seen = new Set<string>();

  let best: { code: string; mapping: LegacyMapping } | null = null;
  for (const code of candidates) {
    if (seen.has(code)) continue;
    seen.add(code);
    const mapping = mapLegacyVariant(code);
    if (!best) best = { code, mapping };
    // A clear mapping wins immediately.
    if (!mapping.ambiguous && mapping.value) {
      best = { code, mapping };
      break;
    }
    // Otherwise prefer any mapping that at least proposes a value.
    if (mapping.value && !best.mapping.value) best = { code, mapping };
  }

  // Empty input, or nothing to try -> ambiguous by definition.
  const code = best?.code ?? codeShape;
  const mapping = best?.mapping ?? mapLegacyVariant(codeShape);
  const confidence = confidenceFor(mapping);

  const reason =
    mapping.note ??
    (mapping.value
      ? `Maps to ${mapping.classification} "${mapping.value}".`
      : `No confident structured mapping — needs admin review.`);

  return {
    legacyValue: raw,
    normalizedCode: code,
    classification: mapping.classification,
    proposedValue: mapping.value,
    confidence,
    // High-confidence clear mappings do not force review; everything ambiguous does.
    reviewRequired: mapping.ambiguous,
    reason,
  };
}

/**
 * Build the full audit over the distinct legacy values + their record counts.
 * Sorted by record count (desc) then value, so the highest-impact values lead.
 */
export function buildAuditRows(valueCounts: ReadonlyArray<{ value: string; count: number }>): LegacyAuditRow[] {
  return valueCounts
    .filter((vc) => vc.value != null && String(vc.value).trim() !== "")
    .map((vc) => ({ ...classifyLegacyValue(vc.value), recordCount: Number(vc.count) || 0 }))
    .sort((a, b) => b.recordCount - a.recordCount || a.legacyValue.localeCompare(b.legacyValue));
}

/** Turn audit rows into pending review-queue rows (plain data — never inserted here). */
export function buildReviewQueueRows(rows: ReadonlyArray<LegacyAuditRow>): ReviewQueueRow[] {
  return rows.map((row) => ({
    legacyValue: row.legacyValue,
    proposedClassification: row.classification,
    proposedValue: row.proposedValue,
    confidence: row.confidence,
    reason: row.reason,
    recordCount: row.recordCount,
    reviewRequired: row.reviewRequired,
    status: "pending",
  }));
}

export interface AuditSummary {
  distinctValues: number;
  totalRecords: number;
  high: number;
  medium: number;
  low: number;
  reviewRequired: number;
}

/** Roll audit rows up into the headline counts used by the report. */
export function summariseAudit(rows: ReadonlyArray<LegacyAuditRow>): AuditSummary {
  return rows.reduce<AuditSummary>(
    (acc, row) => {
      acc.distinctValues += 1;
      acc.totalRecords += row.recordCount;
      acc[row.confidence] += 1;
      if (row.reviewRequired) acc.reviewRequired += 1;
      return acc;
    },
    { distinctValues: 0, totalRecords: 0, high: 0, medium: 0, low: 0, reviewRequired: 0 },
  );
}
