/**
 * PARTNER_QUALITY_V1 — evidence handling, scoring, bands, and the search primitives.
 *
 * These are pure functions with no database, so this suite always runs and can never skip.
 *
 * The tests that matter most are the ones asserting what the rating REFUSES to do. A quality
 * rating fails dangerously when it is generous: an unmeasurable metric scored as perfect, or a
 * 5.0 minted from three cards, both read to a customer as "MintVault verified this shop is
 * excellent". Each of those has a test below whose name says which way it must break.
 */
import { describe, it, expect } from "vitest";
import {
  buildRatingEvidence,
  computeRating,
  bandFor,
  normalisePostcode,
  outwardCode,
  haversineKm,
  boundingBox,
  PARTNER_QUALITY_VERSION,
  MINIMUM_PUBLIC_SAMPLE,
  RATING_BUILDING_LABEL,
  RATING_WEIGHTS,
  REWORK_CEILING,
  RATING_WINDOW_DAYS,
  type RatingCounters,
} from "../server/partner/public-network-rating";
import { publicRatingDto } from "../server/partner/public-network-service";

const LOC = "11111111-1111-1111-1111-111111111111";

/**
 * V2 counters with the two fields these maths tests do not vary defaulted.
 * abandonedUnits: 0 keeps every pre-existing expectation numerically identical to V1 — under V2 a
 * population with no abandonment is exactly the V1 population, which is the point: V2 changes WHICH
 * units are counted, not how a counted unit scores. The abandonment cases are asserted explicitly
 * below and behaviourally in partner-public-network-behavioural.test.ts.
 */
type PartialCounters = Omit<RatingCounters, "abandonedUnits" | "windowDays"> &
  Partial<Pick<RatingCounters, "abandonedUnits" | "windowDays">>;
function full(c: PartialCounters): RatingCounters {
  return { abandonedUnits: 0, windowDays: RATING_WINDOW_DAYS, ...c };
}
function evidenceFor(c: PartialCounters) {
  return buildRatingEvidence(LOC, full(c));
}
function rate(c: PartialCounters) {
  return computeRating(evidenceFor(c));
}
/** A perfect shop with plenty of sample — the control for every "worse than this" assertion. */
const PERFECT: PartialCounters = { reviewedUnits: 40, firstPassUnits: 40, totalRedos: 0 };

describe("evidence extraction", () => {
  it("reports completed volume but never gives it a score contribution", () => {
    const ev = evidenceFor(PERFECT);
    const volume = ev.metrics.find((m) => m.metric === "completed_volume")!;
    expect(volume.available).toBe(true);
    expect(volume.rawValue).toBe(40);
    // normalised === null is what structurally prevents throughput from buying a better rating.
    expect(volume.normalised).toBeNull();
  });

  it("marks every unmeasurable metric unavailable, with a real reason", () => {
    const ev = evidenceFor(PERFECT);
    for (const key of [
      "correction_rate",
      "missed_defect_rate",
      "card_identity_error_rate",
      "grade_variance",
      "turnaround",
      "image_quality",
    ]) {
      const m = ev.metrics.find((x) => x.metric === key)!;
      expect(m.available, `${key} must be unavailable`).toBe(false);
      expect(m.rawValue, `${key} must carry no value`).toBeNull();
      expect(m.normalised, `${key} must carry no score`).toBeNull();
      // A generic "not implemented" would read as merely pending; these are statements about
      // what the schema can and cannot prove.
      expect(m.source.length, `${key} must explain itself`).toBeGreaterThan(20);
    }
  });

  it("does not invent quality evidence for a shop with no approved cards", () => {
    const ev = evidenceFor({ reviewedUnits: 0, firstPassUnits: 0, totalRedos: 0 });
    const firstPass = ev.metrics.find((m) => m.metric === "first_pass_approval_rate")!;
    // 0/0 must be "unknown", not 0% (a fabricated penalty) and not 100% (a fabricated reward).
    expect(firstPass.available).toBe(false);
    expect(firstPass.rawValue).toBeNull();
  });

  it("derives first-pass and returned-for-change as exact complements", () => {
    const ev = evidenceFor({ reviewedUnits: 10, firstPassUnits: 7, totalRedos: 5 });
    const fp = ev.metrics.find((m) => m.metric === "first_pass_approval_rate")!;
    const rc = ev.metrics.find((m) => m.metric === "returned_for_change_rate")!;
    expect(fp.rawValue).toBeCloseTo(0.7, 10);
    expect(rc.rawValue).toBeCloseTo(0.3, 10);
    // Reported for transparency, but NOT scored — scoring both would double-weight one signal.
    expect(rc.normalised).toBeNull();
  });

  it("computes rework intensity as redos per card", () => {
    const ev = evidenceFor({ reviewedUnits: 10, firstPassUnits: 7, totalRedos: 5 });
    const rw = ev.metrics.find((m) => m.metric === "rework_intensity")!;
    expect(rw.rawValue).toBeCloseTo(0.5, 10);
    expect(rw.normalised).toBeCloseTo(1 - 0.5 / REWORK_CEILING, 10);
  });
});

describe("scoring", () => {
  it("stamps the version on every result", () => {
    expect(rate(PERFECT).version).toBe(PARTNER_QUALITY_VERSION);
  });

  it("gives a flawless, well-sampled shop a published 5.0", () => {
    const r = rate(PERFECT);
    expect(r.ratingAvailable).toBe(true);
    expect(r.internalScore).toBe(100);
    expect(r.publicRating).toBe(5);
    expect(r.ratingLabel).toBe("Exceptional");
  });

  it("does NOT treat the unavailable correction metric as a perfect component (RATING2)", () => {
    const r = rate(PERFECT);
    // Only the two measurable components may appear. If correction_cleanliness were scored as 1.0
    // it would still yield 100 here — so the real proof is that it is absent from the breakdown
    // and its weight was redistributed onto the components that actually have evidence.
    expect(Object.keys(r.componentScores).sort()).toEqual(["first_pass_approval_rate", "rework_intensity"]);
    expect(r.evidenceAvailability.correction_rate).toBe(false);
    const totalWeight = Object.values(r.componentScores).reduce((s, c) => s + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 6);
    // Redistribution is PROPORTIONAL: 0.60 and 0.25 renormalise to 0.706 and 0.294.
    expect(r.componentScores.first_pass_approval_rate.weight).toBeCloseTo(0.6 / 0.85, 2);
    expect(r.componentScores.rework_intensity.weight).toBeCloseTo(0.25 / 0.85, 2);
  });

  it("penalises rework, and weights first-pass quality above it", () => {
    const bouncy = rate({ reviewedUnits: 40, firstPassUnits: 20, totalRedos: 20 });
    expect(bouncy.internalScore!).toBeLessThan(100);
    // Halving first-pass must cost more than the same proportional change in rework intensity,
    // because quality outranks rework in the documented weights.
    const onlyRework = rate({ reviewedUnits: 40, firstPassUnits: 40, totalRedos: 20 });
    expect(bouncy.internalScore!).toBeLessThan(onlyRework.internalScore!);
  });

  it("never lets volume compensate for poor quality", () => {
    const smallGood = rate({ reviewedUnits: 12, firstPassUnits: 12, totalRedos: 0 });
    const hugeBad = rate({ reviewedUnits: 5000, firstPassUnits: 2500, totalRedos: 3000 });
    expect(hugeBad.internalScore!).toBeLessThan(smallGood.internalScore!);
  });

  it("clamps a catastrophic shop to zero rather than going negative", () => {
    const r = rate({ reviewedUnits: 40, firstPassUnits: 0, totalRedos: 400 });
    expect(r.internalScore).toBe(0);
    expect(r.publicRating).toBe(0);
    expect(r.ratingLabel).toBe("Under Review");
  });
});

describe("low-sample protection (RATING3)", () => {
  it("never renders an uncalculated active listing as if its public threshold were zero", () => {
    expect(
      publicRatingDto({
        current_rating_available: false,
        current_rating_is_override: false,
        current_public_rating: null,
        current_rating_label: "Rating building",
        current_sample_size: 0,
        current_minimum_sample: 0,
        current_rating_version: null,
        current_rating_calculated_at: null,
      })
    ).toMatchObject({ available: false, rating: null, sampleSize: 0, minimumSample: MINIMUM_PUBLIC_SAMPLE });
  });

  it("withholds a rating below the minimum sample, however perfect the evidence", () => {
    const r = rate({ reviewedUnits: 1, firstPassUnits: 1, totalRedos: 0 });
    // The headline failure this prevents: 1 completed card -> 5.0 stars.
    expect(r.ratingAvailable).toBe(false);
    expect(r.publicRating).toBeNull();
    expect(r.ratingLabel).toBe(RATING_BUILDING_LABEL);
    expect(r.sampleSize).toBe(1);
    expect(r.minimumSample).toBe(MINIMUM_PUBLIC_SAMPLE);
  });

  it("still keeps the provisional internal score for HQ", () => {
    const r = rate({ reviewedUnits: 3, firstPassUnits: 3, totalRedos: 0 });
    expect(r.ratingAvailable).toBe(false);
    // HQ may look at it; the public may not. Both halves matter.
    expect(r.internalScore).toBe(100);
    expect(r.publicRating).toBeNull();
  });

  it("publishes at exactly the threshold and withholds one card below it", () => {
    const at = rate({ reviewedUnits: MINIMUM_PUBLIC_SAMPLE, firstPassUnits: MINIMUM_PUBLIC_SAMPLE, totalRedos: 0 });
    const below = rate({
      reviewedUnits: MINIMUM_PUBLIC_SAMPLE - 1,
      firstPassUnits: MINIMUM_PUBLIC_SAMPLE - 1,
      totalRedos: 0,
    });
    expect(at.ratingAvailable).toBe(true);
    expect(below.ratingAvailable).toBe(false);
  });

  it("withholds a rating entirely when there is no quality evidence at all", () => {
    const r = rate({ reviewedUnits: 0, firstPassUnits: 0, totalRedos: 0 });
    expect(r.ratingAvailable).toBe(false);
    expect(r.internalScore).toBeNull();
    expect(r.publicRating).toBeNull();
    expect(r.ratingLabel).toBe(RATING_BUILDING_LABEL);
  });
});

describe("bands", () => {
  it.each([
    [100, "Exceptional"],
    [90, "Exceptional"],
    [89.999, "Excellent"],
    [80, "Excellent"],
    [79.9, "Very Good"],
    [70, "Very Good"],
    [69.9, "Good"],
    [55, "Good"],
    [54.9, "Under Review"],
    [0, "Under Review"],
  ])("scores %s as %s", (score, label) => {
    expect(bandFor(score as number)).toBe(label);
  });

  it("uses no punitive language for ordinary variance", () => {
    const labels = [100, 85, 75, 60, 20].map((s) => bandFor(s));
    for (const l of labels) {
      expect(l).not.toMatch(/poor|bad|fail|terrible|worst/i);
    }
  });

  it("keeps the documented weights", () => {
    // Pinned so a silent re-weighting cannot ship: the weights are the published methodology.
    expect(RATING_WEIGHTS.map((w) => [w.component, w.weight])).toEqual([
      ["first_pass_approval_rate", 0.6],
      ["rework_intensity", 0.25],
      ["correction_cleanliness", 0.15],
    ]);
  });
});

describe("UK postcode normalisation", () => {
  it.each([
    ["ME2 2NG", "ME22NG"],
    ["me22ng", "ME22NG"],
    ["ME2-2NG", "ME22NG"],
    ["  sw1a 1aa ", "SW1A1AA"],
    ["M1 1AE", "M11AE"],
    ["b33 8th", "B338TH"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(normalisePostcode(raw)).toBe(expected);
  });

  it("returns null for input with no alphanumerics", () => {
    expect(normalisePostcode("   ")).toBeNull();
    expect(normalisePostcode("--")).toBeNull();
  });

  it.each([
    ["ME22NG", "ME2"],
    ["SW1A1AA", "SW1A"],
    ["M11AE", "M1"],
    ["B338TH", "B33"],
    // Already an outward code — a visitor may search the area alone.
    ["ME2", "ME2"],
    ["SW1A", "SW1A"],
  ])("derives outward %s from %s", (normalised, outward) => {
    expect(outwardCode(normalised)).toBe(outward);
  });

  it("does not fall for the greedy-regex trap that put Strood in a district that does not exist", () => {
    // '^[A-Z]{1,2}[0-9][0-9A-Z]?' matches 'ME22' here. Every UK inward code is exactly three
    // characters, so the outward code is positional, not pattern-matched.
    expect(outwardCode("ME22NG")).toBe("ME2");
    expect(outwardCode("ME22NG")).not.toBe("ME22");
  });

  it("returns null rather than a plausible fragment for a malformed postcode", () => {
    expect(outwardCode("X")).toBeNull();
    expect(outwardCode("WAYTOOLONGVALUE")).toBeNull();
  });
});

describe("distance", () => {
  // Synthetic but geographically plausible Kent coordinates, matching the test fixtures.
  const STROOD = { lat: 51.3959, lng: 0.4783 };
  const ROCHESTER = { lat: 51.3877, lng: 0.5041 };
  const MAIDSTONE = { lat: 51.2704, lng: 0.5227 };

  it("returns zero for a point against itself", () => {
    expect(haversineKm(STROOD.lat, STROOD.lng, STROOD.lat, STROOD.lng)).toBe(0);
  });

  it("puts Rochester within 3km of Strood and Maidstone well beyond it", () => {
    const near = haversineKm(STROOD.lat, STROOD.lng, ROCHESTER.lat, ROCHESTER.lng);
    const far = haversineKm(STROOD.lat, STROOD.lng, MAIDSTONE.lat, MAIDSTONE.lng);
    expect(near).toBeLessThan(3);
    expect(far).toBeGreaterThan(10);
    expect(far).toBeGreaterThan(near);
  });

  it("is symmetric", () => {
    const a = haversineKm(STROOD.lat, STROOD.lng, MAIDSTONE.lat, MAIDSTONE.lng);
    const b = haversineKm(MAIDSTONE.lat, MAIDSTONE.lng, STROOD.lat, STROOD.lng);
    expect(a).toBeCloseTo(b, 10);
  });

  it("matches a known long-distance reference (London to Edinburgh ~530km)", () => {
    const d = haversineKm(51.5074, -0.1278, 55.9533, -3.1883);
    expect(d).toBeGreaterThan(520);
    expect(d).toBeLessThan(545);
  });

  it("builds a bounding box that never excludes an in-radius point", () => {
    const radius = 25;
    const box = boundingBox(STROOD.lat, STROOD.lng, radius);
    // The box must be GENEROUS: it may admit points outside the radius (the exact distance filter
    // then discards them), but excluding an in-radius shop would silently lose it from the finder.
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const rad = (bearing * Math.PI) / 180;
      const dLat = (radius / 111.32) * Math.cos(rad);
      const dLng = (radius / (111.32 * Math.cos((STROOD.lat * Math.PI) / 180))) * Math.sin(rad);
      const pLat = STROOD.lat + dLat;
      const pLng = STROOD.lng + dLng;
      expect(pLat, `bearing ${bearing} lat`).toBeGreaterThanOrEqual(box.minLat - 1e-9);
      expect(pLat, `bearing ${bearing} lat`).toBeLessThanOrEqual(box.maxLat + 1e-9);
      expect(pLng, `bearing ${bearing} lng`).toBeGreaterThanOrEqual(box.minLng - 1e-9);
      expect(pLng, `bearing ${bearing} lng`).toBeLessThanOrEqual(box.maxLng + 1e-9);
    }
  });

  it("widens the longitude span at higher latitude", () => {
    const kent = boundingBox(51.4, 0.5, 25);
    const shetland = boundingBox(60.4, -1.2, 25);
    const kentSpan = kent.maxLng - kent.minLng;
    const shetlandSpan = shetland.maxLng - shetland.minLng;
    expect(shetlandSpan).toBeGreaterThan(kentSpan);
  });
});
