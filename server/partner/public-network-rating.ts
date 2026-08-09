/**
 * MintVault Operational Quality Rating — evidence extraction and PARTNER_QUALITY_V1.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * -------------------------------------------------------------------------------------------
 * A metric we cannot measure is reported as UNAVAILABLE. It is never silently converted into a
 * zero, a perfect score, or an absent penalty. Every direction of "we don't know" that would make
 * a shop look BETTER than the evidence supports is closed here, in the type system and in the
 * arithmetic, and again in the database (chk_partner_public_listings_current_rating and
 * chk_partner_public_rating_snapshots_availability in migration 0058).
 *
 * This is a MintVault OPERATIONAL rating derived from our own review outcomes. It is NOT a
 * customer-review score, and nothing a partner can write feeds into it.
 *
 * WHAT THE EVIDENCE ACTUALLY IS, AND WHY
 * -------------------------------------------------------------------------------------------
 * Every figure below comes from `certificates`, attributed through the IMMUTABLE 0035 origin
 * snapshot (origin_location_id). That column has an ENABLE ALWAYS immutability trigger, so a shop
 * renaming itself, moving premises, or being suspended cannot retroactively change its own
 * evidence base. Deliberately NOT used:
 *
 *  - partner_grading_work_items.status. It is CURRENT STATE ONLY. `returned_for_change` is
 *    transient: both re-entry doors (submit-for-review in grading-routes.ts, assignment in
 *    grading-assignment.ts) blindly overwrite it, and neither increments a counter nor writes an
 *    event. After two bounces and an approval the row reads `approved` with no trace it ever
 *    bounced. A rate computed from it would be "currently returned", which is not a rate.
 *
 *  - audit_log grade_approve/grade_reject counts. Those rows are written OUTSIDE the approval
 *    transaction (server/grader.ts:1223-1238), so the log can legitimately be SHORTER than the
 *    truth. Using it as a denominator would make an audit-write failure look like better quality.
 *
 * `certificates.redo_count` is used instead: server/grader.ts:1128 increments it inside the
 * rejection CAS and nothing in the codebase ever resets it. server/grader.ts:1366 already computes
 * per-grader quality from exactly this column, so the approach is not novel here.
 *
 * DELIBERATELY UNAVAILABLE IN V1 — each with its real reason, not a placeholder:
 *
 *  - correction rate. Two writers of `cert_live_record_edit` use incompatible entity_id
 *    conventions (server/correction-mode.ts:502 writes the numeric id; server/routes.ts:2768
 *    writes certificate_number). A join drops one of them, and the resulting under-count makes a
 *    shop look BETTER than it is — the one direction we refuse. Becomes available when the writers
 *    are unified, not before.
 *  - missed-defect rate. No defect list is snapshotted at submit, so "missed" has no referent.
 *  - card-identity-error rate. Pre-approval identity fixes are not recorded at all.
 *  - grade variance vs a reference. No calibrated reference set exists.
 *  - turnaround. partner_grading_work_items has no completion timestamp, and both candidate start
 *    timestamps are destroyed by normal rework.
 *  - image quality. imagesForPartnerCert() returns a hard-coded empty quality object.
 */

/**
 * Formula identity. Persisted on every snapshot so an old score stays explainable.
 *
 * V1 is retained as a NAMED constant, not deleted, because snapshots written under it are still in
 * the history table and must stay interpretable as what they were. Nothing reinterprets a V1 row as
 * V2: the version travels with the snapshot, and only new snapshots carry V2.
 */
export const PARTNER_QUALITY_VERSION_V1 = "PARTNER_QUALITY_V1";
export const PARTNER_QUALITY_VERSION = "PARTNER_QUALITY_V2";

/**
 * Rolling rating window, in days. OWNER DECISION (locked): 180.
 *
 * A shop is rated on what it is doing NOW. Without a window, a long clean history dilutes a recent
 * decline to invisibility — a shop that graded 500 clean cards last year can bounce half of this
 * month's work and still show 4.8. The window is applied to the reviewed-unit population, and the
 * fallback below is what stops it turning into a tiny-sample rating.
 */
export const RATING_WINDOW_DAYS = 180;

/**
 * Minimum completed, approved cards before a rating is shown publicly.
 *
 * WHY 10, recorded because an unexplained threshold is an arbitrary one:
 *  - At n=10 a single bounced card moves first-pass rate by 10 percentage points — the coarsest
 *    granularity still defensible on a public page.
 *  - Below 10 one card swings the rating by >=12.5pp, which is noise presented as judgement.
 *  - 10 is reachable in a pilot shop's first weeks, so shops are not stuck in "Rating building"
 *    indefinitely.
 * Pilot volumes could not be observed (no partner-originated certificates exist in production
 * yet), so this is reasoned from the metric's sensitivity rather than from a real distribution.
 * REVISIT once genuine pilot volume exists.
 */
export const MINIMUM_PUBLIC_SAMPLE = 10;

/** Public label for the sub-threshold state. Never a number, never a star count. */
export const RATING_BUILDING_LABEL = "Rating building";

/**
 * Average redos per card at which the rework component scores zero.
 *
 * 2.0 means "every card bounced twice on average" — comfortably beyond any acceptable operation,
 * so the component degrades smoothly across the realistic range instead of saturating instantly.
 */
export const REWORK_CEILING = 2.0;

export type MetricKey =
  | "completed_volume"
  | "abandoned_unit_rate"
  | "first_pass_approval_rate"
  | "returned_for_change_rate"
  | "rework_intensity"
  | "correction_rate"
  | "missed_defect_rate"
  | "card_identity_error_rate"
  | "grade_variance"
  | "turnaround"
  | "image_quality";

export interface MetricEvidence {
  metric: MetricKey;
  available: boolean;
  /** Raw measured value in the metric's own units. null whenever `available` is false. */
  rawValue: number | null;
  /**
   * 0..1 where 1 is best, for metrics that feed the score. null when unavailable OR when the
   * metric is reported for information only (completed_volume, returned_for_change_rate).
   */
  normalised: number | null;
  /** Where the number came from, or why it cannot be produced. Surfaced to Super Admin, not to the public. */
  source: string;
  /** Rows the metric was computed over. 0 when unavailable. */
  sampleSize: number;
}

export interface RatingEvidence {
  locationId: string;
  /** Reviewed UNITS attributable to this location via the immutable origin snapshot. The denominator. */
  sampleSize: number;
  /** 180 when the rolling window supplied the population, null when it fell back to all-time. */
  windowDays: number | null;
  /**
   * ISO timestamp of the OLDEST unit inside the population, or null when there is none.
   *
   * Carried out of the measurement because it is the only thing that can answer "when could this
   * rating change with no workflow write at all" — the oldest unit is the next one to leave the
   * rolling window. The lifecycle turns it into `rating_next_recalc_at`. It is NOT a rating input
   * and nothing in computeRating reads it.
   */
  oldestEvidenceInWindow: string | null;
  metrics: MetricEvidence[];
}

/**
 * Raw per-location counters, exactly as measured. The DB layer produces this; the maths lives here.
 *
 * V2 DENOMINATOR — the anti-gaming change.
 *
 * V1 counted APPROVED cards. A unit that reached HQ review, was returned for change and was then
 * abandoned had `grade_approved_at IS NULL`, so it left the numerator AND the denominator at once —
 * abandoning your worst work raised your rating. That is limitation L1, and it was reproduced end
 * to end on the real engine (20 units, 10 bounced = 2.9; abandon those 10 = 5.0).
 *
 * V2 counts REVIEWED UNITS: a physical card that has entered the review lifecycle stays in the
 * population permanently, approved or not. The evidence was always durably present — the predicate
 * simply declined to look at it. No new events table was needed to prove this, so none was added.
 *
 * One certificate row is one physical unit, so repeated return/resubmit cycles bump `redo_count` on
 * the SAME row: the unit is counted ONCE however many times it goes round. Sample size cannot be
 * inflated by resubmission; only the quality evidence worsens.
 */
export interface RatingCounters {
  /**
   * Physical units that have entered the review lifecycle: approved, OR bounced at least once and
   * never approved. Non-deleted, active, partner-originated, attributed by the immutable 0035
   * origin snapshot. THIS is the denominator.
   */
  reviewedUnits: number;
  /** Of those, units that were APPROVED having never been bounced. An abandoned unit is never first-pass. */
  firstPassUnits: number;
  /** Sum of redo_count across all reviewed units — abandoned units keep contributing their redos. */
  totalRedos: number;
  /** Reviewed units that never reached approval. Reported to HQ as evidence; not separately scored. */
  abandonedUnits: number;
  /** 180 when the rolling window supplied the population, null when it fell back to all-time. */
  windowDays: number | null;
  /** Oldest review-clock timestamp inside the counted population, ISO, or null when empty. */
  oldestEvidenceInWindow?: string | null;
}

/** A metric that cannot be produced. Kept as a helper so every unavailable case looks identical. */
function unavailable(metric: MetricKey, source: string): MetricEvidence {
  return { metric, available: false, rawValue: null, normalised: null, source, sampleSize: 0 };
}

/**
 * Turn raw counters into structured evidence.
 *
 * Note every unavailable metric below carries a SPECIFIC reason. A generic "not implemented"
 * would let a future reader assume it is merely pending, when several of these are statements
 * about what the schema can and cannot prove.
 */
export function buildRatingEvidence(locationId: string, counters: RatingCounters): RatingEvidence {
  const { reviewedUnits, firstPassUnits, totalRedos, abandonedUnits, windowDays } = counters;
  const approvedCards = reviewedUnits;
  const firstPassCards = firstPassUnits;
  const metrics: MetricEvidence[] = [];
  const windowNote =
    windowDays === null
      ? "all-time population (fewer than the minimum sample fell inside the rolling window)"
      : `rolling ${windowDays}-day window`;

  metrics.push({
    metric: "completed_volume",
    available: true,
    rawValue: reviewedUnits,
    // Volume is NEVER a score component. It sets confidence and the sample gate only, so a shop
    // cannot buy a better rating with throughput. normalised stays null to make that structural.
    normalised: null,
    source: `certificates.origin_location_id, units that entered review (approved OR bounced-and-abandoned), ${windowNote}`,
    sampleSize: reviewedUnits,
  });

  // Abandonment is reported as evidence in its own right so HQ can SEE the behaviour the V2
  // denominator neutralises. It is deliberately not a separate scored component: the abandoned unit
  // already depresses first-pass rate and carries its redos into rework intensity, and scoring it
  // again would penalise the same fact three times.
  metrics.push({
    metric: "abandoned_unit_rate",
    available: reviewedUnits > 0,
    rawValue: reviewedUnits > 0 ? abandonedUnits / reviewedUnits : null,
    normalised: null,
    source:
      reviewedUnits > 0
        ? `certificates that entered review and never reached approval, ${windowNote}`
        : "no reviewed units attributed to this location yet",
    sampleSize: reviewedUnits,
  });

  if (approvedCards === 0) {
    // With no approved cards there is no quality evidence at all. Reporting 0% first-pass would be
    // a fabricated penalty just as surely as 100% would be a fabricated reward.
    metrics.push(unavailable("first_pass_approval_rate", "no reviewed units attributed to this location yet"));
    metrics.push(unavailable("returned_for_change_rate", "no reviewed units attributed to this location yet"));
    metrics.push(unavailable("rework_intensity", "no reviewed units attributed to this location yet"));
  } else {
    const firstPass = firstPassCards / approvedCards;
    metrics.push({
      metric: "first_pass_approval_rate",
      available: true,
      rawValue: firstPass,
      normalised: clamp01(firstPass),
      source: "approved units with certificates.redo_count = 0, over ALL reviewed units (abandoned units count against this)",
      sampleSize: approvedCards,
    });

    // The exact complement of first-pass. Reported as evidence, deliberately NOT scored — scoring
    // both would count one signal twice and silently double the weight of rework.
    metrics.push({
      metric: "returned_for_change_rate",
      available: true,
      rawValue: 1 - firstPass,
      normalised: null,
      source: "complement of first_pass_approval_rate (reported for transparency, not scored twice)",
      sampleSize: approvedCards,
    });

    const avgRedos = totalRedos / approvedCards;
    metrics.push({
      metric: "rework_intensity",
      available: true,
      rawValue: avgRedos,
      normalised: clamp01(1 - avgRedos / REWORK_CEILING),
      source: "SUM(certificates.redo_count) / reviewed units (abandoned units keep their redos)",
      sampleSize: approvedCards,
    });
  }

  metrics.push(
    unavailable(
      "correction_rate",
      "audit_log entity_id has two incompatible conventions (numeric id vs certificate_number); any join under-counts, which would flatter the shop",
    ),
  );
  metrics.push(unavailable("missed_defect_rate", "no operator defect list is snapshotted at submit, so 'missed' has no referent"));
  metrics.push(unavailable("card_identity_error_rate", "pre-approval identity corrections are not recorded"));
  metrics.push(unavailable("grade_variance", "no calibrated reference grade set exists"));
  metrics.push(unavailable("turnaround", "partner_grading_work_items has no completion timestamp"));
  metrics.push(unavailable("image_quality", "no image-quality measurement is captured"));

  return {
    locationId,
    sampleSize: reviewedUnits,
    windowDays,
    oldestEvidenceInWindow: counters.oldestEvidenceInWindow ?? null,
    metrics,
  };
}

/**
 * Score components and their DOCUMENTED weights.
 *
 * Quality outranks everything else, and speed is absent entirely — we cannot measure it honestly,
 * so it does not appear. See docs/partner-public-network-0058.md.
 */
export type ComponentKey = "first_pass_approval_rate" | "rework_intensity" | "correction_cleanliness";

/**
 * Each component names the EVIDENCE METRIC it consumes. correction_cleanliness is a distinct
 * component name from its source metric (correction_rate) because the component is the INVERSE —
 * "how clean", not "how many corrections" — and conflating the two is how a penalty silently
 * becomes a reward. Its source is unavailable in v1, so its weight is redistributed, never awarded.
 */
export const RATING_WEIGHTS: ReadonlyArray<{ component: ComponentKey; source: MetricKey; weight: number }> = [
  { component: "first_pass_approval_rate", source: "first_pass_approval_rate", weight: 0.6 },
  { component: "rework_intensity", source: "rework_intensity", weight: 0.25 },
  { component: "correction_cleanliness", source: "correction_rate", weight: 0.15 },
];

/** Minimum number of scoring components that must be available for a rating to mean anything. */
export const MIN_AVAILABLE_COMPONENTS = 2;

export interface RatingBand {
  min: number;
  label: string;
}

/** Deterministic bands on the internal 0-100 score. Ordered high to low; first match wins. */
export const RATING_BANDS: ReadonlyArray<RatingBand> = [
  { min: 90, label: "Exceptional" },
  { min: 80, label: "Excellent" },
  { min: 70, label: "Very Good" },
  { min: 55, label: "Good" },
  { min: 0, label: "Under Review" },
];

export function bandFor(internalScore: number): string {
  for (const b of RATING_BANDS) if (internalScore >= b.min) return b.label;
  // Unreachable: the last band has min 0 and the score is clamped to >= 0. Present so a future
  // edit to RATING_BANDS cannot produce `undefined` as a public label.
  return "Under Review";
}

export interface ComputedRating {
  version: string;
  /** 0-100 HQ-facing score. null when too few components are available to mean anything. */
  internalScore: number | null;
  /** 0.0-5.0 public value. null whenever ratingAvailable is false. */
  publicRating: number | null;
  ratingLabel: string;
  ratingAvailable: boolean;
  sampleSize: number;
  minimumSample: number;
  /** Per-component normalised value and the weight actually applied after redistribution. */
  componentScores: Record<string, { value: number; weight: number }>;
  /** Availability of EVERY metric, including the ones that do not feed the score. */
  evidenceAvailability: Record<string, boolean>;
}

/**
 * PARTNER_QUALITY_V1.
 *
 * Weight redistribution is the subtle part: when a component's evidence is unavailable its weight
 * is spread PROPORTIONALLY across the components that remain. It is never treated as a perfect
 * score (which would reward missing data) and never as zero (which would punish a shop for our
 * own measurement gap). If fewer than MIN_AVAILABLE_COMPONENTS survive, no rating is produced at
 * all — because a "rating" resting on one signal is not a rating.
 */
export function computeRating(evidence: RatingEvidence): ComputedRating {
  const byMetric = new Map(evidence.metrics.map((m) => [m.metric, m]));
  const evidenceAvailability: Record<string, boolean> = {};
  for (const m of evidence.metrics) evidenceAvailability[m.metric] = m.available;

  const live: Array<{ name: ComponentKey; value: number; weight: number }> = [];
  for (const { component, source, weight } of RATING_WEIGHTS) {
    const ev = byMetric.get(source);
    // Unavailable, or available-but-not-scoring (normalised === null). Either way the component is
    // EXCLUDED — never defaulted to 1 (rewarding missing data) and never to 0 (punishing a shop
    // for our own measurement gap).
    if (!ev || !ev.available || ev.normalised === null) continue;
    live.push({ name: component, value: ev.normalised, weight });
  }

  const componentScores: Record<string, { value: number; weight: number }> = {};
  const sampleSize = evidence.sampleSize;

  if (live.length < MIN_AVAILABLE_COMPONENTS) {
    return {
      version: PARTNER_QUALITY_VERSION,
      internalScore: null,
      publicRating: null,
      ratingLabel: RATING_BUILDING_LABEL,
      ratingAvailable: false,
      sampleSize,
      minimumSample: MINIMUM_PUBLIC_SAMPLE,
      componentScores,
      evidenceAvailability,
    };
  }

  const liveWeight = live.reduce((s, c) => s + c.weight, 0);
  let internal = 0;
  for (const c of live) {
    const effectiveWeight = c.weight / liveWeight; // proportional redistribution
    componentScores[c.name] = { value: round3(c.value), weight: round3(effectiveWeight) };
    internal += c.value * effectiveWeight;
  }
  const internalScore = round3(clamp01(internal) * 100);

  // THE SAMPLE GATE. The score is computed and kept for HQ, but below threshold nothing is
  // published — a mature-looking star rating off three cards is exactly the failure this prevents.
  if (sampleSize < MINIMUM_PUBLIC_SAMPLE) {
    return {
      version: PARTNER_QUALITY_VERSION,
      internalScore,
      publicRating: null,
      ratingLabel: RATING_BUILDING_LABEL,
      ratingAvailable: false,
      sampleSize,
      minimumSample: MINIMUM_PUBLIC_SAMPLE,
      componentScores,
      evidenceAvailability,
    };
  }

  return {
    version: PARTNER_QUALITY_VERSION,
    internalScore,
    // One decimal, 0.0-5.0. Math.round rather than toFixed so the stored numeric matches exactly.
    publicRating: Math.round((internalScore / 20) * 10) / 10,
    ratingLabel: bandFor(internalScore),
    ratingAvailable: true,
    sampleSize,
    minimumSample: MINIMUM_PUBLIC_SAMPLE,
    componentScores,
    evidenceAvailability,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Canonical UK postcode form: upper case, alphanumerics only.
 *
 * MUST agree with the GENERATED column in migration 0058 — the database generates
 * postcode_normalised with `upper(regexp_replace(postcode, '[^A-Za-z0-9]', '', 'g'))`, and a
 * search term normalised differently here would simply never match. That is a silent failure
 * (empty result, HTTP 200), which is why the two are pinned together by test.
 */
export function normalisePostcode(input: string): string | null {
  const cleaned = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return cleaned === "" ? null : cleaned;
}

/**
 * Outward code from a normalised postcode ('ME2' from 'ME22NG').
 *
 * POSITIONAL, NOT PATTERN-MATCHED, and it must stay that way: every UK inward code is exactly
 * three characters, so the outward code is "everything except the last three". The greedy pattern
 * `^[A-Z]{1,2}[0-9][0-9A-Z]?` returns 'ME22' for 'ME22NG' — a district that does not exist. This
 * mirrors the GENERATED column in 0058 exactly.
 *
 * A 2-4 character input is already an outward code and is returned unchanged, so a visitor can
 * search "ME2" as well as a full postcode.
 */
export function outwardCode(normalised: string): string | null {
  if (normalised.length >= 5 && normalised.length <= 7) return normalised.slice(0, normalised.length - 3);
  if (normalised.length >= 2 && normalised.length <= 4) return normalised;
  return null;
}

/** Mean Earth radius in kilometres (IUGG). */
const EARTH_RADIUS_KM = 6371.0088;

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than the spherical law of cosines: the latter loses precision catastrophically
 * for small distances because acos() of a value near 1 is ill-conditioned, and "shops near me" is
 * precisely the small-distance case.
 */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Latitude/longitude bounding box for a radius, used to pre-filter candidates on an index before
 * computing exact Haversine distance on the survivors.
 *
 * The longitude delta widens with latitude (degrees of longitude shrink toward the poles). The
 * cos() guard prevents a division by zero at the poles; the box is deliberately GENEROUS — it may
 * admit rows outside the radius, which the exact distance filter then discards. It must never
 * EXCLUDE a row inside the radius, or the finder silently loses shops.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const lngDelta = radiusKm / (111.32 * cosLat);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}
