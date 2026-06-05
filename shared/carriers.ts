/**
 * Carrier + service-level catalogue — single source of truth.
 *
 * The submission row stores carrier in `return_carrier` (free text per the
 * legacy "Mark Shipped" form) and the service-level key in `return_service`
 * (added by migrations/add-return-service.sql). The set of valid service
 * keys per carrier, their human-readable labels, and the tracking-link
 * template all live here. NEVER duplicate this list in the server endpoint,
 * the admin form, the customer view, or the shipped email — every consumer
 * imports from here, so adding a new service is a one-line edit.
 *
 * Carrier === "other" is allowed for free-text carrier capture (no service,
 * no track URL — the form hides the service select and the customer view
 * shows the tracking number as text only). All consumers must be null-safe
 * on both `service` and `trackUrl()`.
 */

export type CarrierId = "royal_mail" | "dpd" | "evri" | "other";

export interface ServiceDef {
  /** Stable key persisted to submissions.return_service. */
  key: string;
  /** Operator + customer facing label. */
  label: string;
  /** Pricing-tier-aligned bucket — drives the auto-suggest based on the
   *  submission's totalDeclaredValue. Each carrier MUST cover the three
   *  bands so the suggester always finds a match. */
  band: "standard" | "priority" | "express";
}

export interface CarrierDef {
  id: CarrierId;
  label: string;
  /** Services ordered for display (cheapest → fastest). Empty for "other". */
  services: ServiceDef[];
  /** Best-effort track URL template. Returns null when the carrier doesn't
   *  expose a stable public tracking URL (we still show the number as
   *  copyable text alongside). */
  trackUrlTemplate: ((tracking: string) => string) | null;
}

export const CARRIERS: CarrierDef[] = [
  {
    id: "royal_mail",
    label: "Royal Mail",
    services: [
      { key: "tracked_48", label: "Standard (Royal Mail Tracked 48)", band: "standard" },
      { key: "tracked_24", label: "Priority (Royal Mail Tracked 24 Signed)", band: "priority" },
      {
        key: "special_delivery",
        label: "Express (Royal Mail Special Delivery 1pm)",
        band: "express",
      },
    ],
    trackUrlTemplate: (t) => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(t)}`,
  },
  {
    id: "dpd",
    label: "DPD",
    services: [
      { key: "dpd_classic", label: "Standard (DPD Classic)", band: "standard" },
      { key: "dpd_next_day", label: "Priority (DPD Next Day)", band: "priority" },
      { key: "dpd_1200", label: "Express (DPD by 12:00)", band: "express" },
    ],
    // Best-effort — DPD's public tracker accepts the parcel number on this
    // path; failures fall back to the tracking number as plain text in the
    // UI.
    trackUrlTemplate: (t) => `https://track.dpd.co.uk/parcels/${encodeURIComponent(t)}`,
  },
  {
    id: "evri",
    label: "Evri",
    services: [
      { key: "evri_standard", label: "Standard (Evri Standard)", band: "standard" },
      { key: "evri_next_day", label: "Priority (Evri Next Day)", band: "priority" },
    ],
    // Best-effort — Evri's tracker pattern. Customer view falls back to
    // plain text if their URL changes.
    trackUrlTemplate: (t) => `https://www.evri.com/track/parcel/${encodeURIComponent(t)}`,
  },
  {
    id: "other",
    label: "Other",
    services: [],
    trackUrlTemplate: null,
  },
];

const CARRIER_BY_ID: Record<string, CarrierDef> = Object.fromEntries(CARRIERS.map((c) => [c.id, c]));

/** All services for a given carrier id. Empty array for unknown or "other".
 *  The admin form's <select> uses this directly. */
export function servicesForCarrier(carrierId: string | null | undefined): ServiceDef[] {
  if (!carrierId) return [];
  return CARRIER_BY_ID[carrierId]?.services ?? [];
}

/** Resolve a stored (carrier, service) pair to a human-readable label.
 *  Returns null when the pair is unknown so callers can decide to show
 *  the raw key, hide the chip, or omit the service line altogether. */
export function serviceLabel(
  carrierId: string | null | undefined,
  serviceKey: string | null | undefined
): string | null {
  if (!carrierId || !serviceKey) return null;
  const c = CARRIER_BY_ID[carrierId];
  if (!c) return null;
  return c.services.find((s) => s.key === serviceKey)?.label ?? null;
}

/** Build the public tracking URL for a given carrier + tracking number, or
 *  null when the carrier has no template (e.g. "other") or the tracking
 *  number is empty. Callers MUST handle null by rendering the tracking
 *  number as plain copyable text. The tracking number itself is always
 *  shown — the link is the optional add-on. */
export function trackUrl(carrierId: string | null | undefined, tracking: string | null | undefined): string | null {
  if (!carrierId || !tracking) return null;
  const c = CARRIER_BY_ID[carrierId];
  if (!c || !c.trackUrlTemplate) return null;
  return c.trackUrlTemplate(tracking.trim());
}

/** Validate that a (carrier, service) pair is acceptable for persistence.
 *  Used by the server endpoint to reject bad combinations with 400 BEFORE
 *  writing. Allows null service when carrier === "other"; rejects null
 *  service for any non-other carrier. */
export function isServiceValidForCarrier(
  carrierId: string | null | undefined,
  serviceKey: string | null | undefined
): boolean {
  if (!carrierId) return false;
  if (carrierId === "other") return !serviceKey;
  const c = CARRIER_BY_ID[carrierId];
  if (!c) return false;
  if (!serviceKey) return false;
  return c.services.some((s) => s.key === serviceKey);
}

/** Pick a default service for a carrier based on the submission's declared
 *  value. Mapping:
 *    - > £500.00 (50000p)   → express
 *    - <= £100.00 (10000p)  → standard
 *    - otherwise            → priority
 *  Returns null for carriers without services (e.g. "other").
 *
 *  Kept for callers that don't know the serviceType. For dispatch use
 *  suggestServiceForSubmission below — graded slabs default to express
 *  regardless of declared value (RM Tracked's ~£100 cover is too thin
 *  for any encapsulated card). */
export function suggestServiceForValue(
  carrierId: string | null | undefined,
  totalDeclaredValuePence: number
): string | null {
  const services = servicesForCarrier(carrierId);
  if (services.length === 0) return null;
  let band: ServiceDef["band"];
  if (totalDeclaredValuePence > 50000) band = "express";
  else if (totalDeclaredValuePence <= 10000) band = "standard";
  else band = "priority";
  // Fall back to the first service if the picked band isn't defined for
  // this carrier (defence-in-depth — current carrier defs all cover the
  // standard/priority bands; "express" only exists on RM + DPD).
  return services.find((s) => s.band === band)?.key ?? services[0].key;
}

/** Pick a default service that's aware of the submission's serviceType.
 *  Every GRADING return defaults to the carrier's express-band service
 *  regardless of declared value — RM Tracked's ~£100 cover is too low
 *  for any slab. Non-grading work (reholder/crossover/authentication)
 *  can fall back to the cheap Standard service when the card is worth
 *  under £50; everything else gets express.
 *
 *  Bands:
 *    - serviceType === "grading" (or unknown/null)  → express
 *    - other serviceType + value <  £50 (5000p)     → standard
 *    - other serviceType + value >= £50             → express
 *  Returns null for carriers without services (e.g. "other"). */
export function suggestServiceForSubmission(
  carrierId: string | null | undefined,
  serviceType: string | null | undefined,
  totalDeclaredValuePence: number
): string | null {
  const services = servicesForCarrier(carrierId);
  if (services.length === 0) return null;
  const stype = (serviceType ?? "").toLowerCase();
  const isGrading = stype === "" || stype === "grading";
  let band: ServiceDef["band"];
  if (isGrading) {
    band = "express";
  } else if (totalDeclaredValuePence < 5000) {
    band = "standard";
  } else {
    band = "express";
  }
  // Fall back to the first service if the picked band isn't defined for
  // this carrier (defence-in-depth — current carrier defs all cover the
  // standard band; "express" only exists on RM + DPD).
  return services.find((s) => s.band === band)?.key ?? services[0].key;
}

/** Carrier ids in display order, ready to render in a <select>. The legacy
 *  Mark-Shipped form's dropdown maps to these via:
 *    "Royal Mail" → "royal_mail", "DPD" → "dpd", "Evri" → "evri",
 *    "Other" → "other".
 *  Legacy stored values (free-text "Royal Mail" etc.) are normalised by
 *  carrierIdFromLegacyName below. */
export function carrierIdsInOrder(): CarrierId[] {
  return CARRIERS.map((c) => c.id);
}

/** Map a legacy free-text carrier string (as stored in older submissions)
 *  to a stable carrier id. Used by the customer view to look up the track
 *  URL on historical data captured before this change. Case-insensitive. */
export function carrierIdFromLegacyName(name: string | null | undefined): CarrierId | null {
  if (!name) return null;
  const k = name.trim().toLowerCase();
  if (k === "royal mail" || k === "royal_mail" || k === "royalmail") return "royal_mail";
  if (k === "dpd") return "dpd";
  if (k === "evri" || k === "hermes") return "evri";
  if (k === "other") return "other";
  return null;
}

/** Look up a carrier's display label (for chips, email body, etc.).
 *  Falls back to the raw stored value when unknown so historical free-text
 *  carrier names still render readable. */
export function carrierLabel(carrierId: string | null | undefined): string {
  if (!carrierId) return "";
  return CARRIER_BY_ID[carrierId]?.label ?? carrierId;
}
