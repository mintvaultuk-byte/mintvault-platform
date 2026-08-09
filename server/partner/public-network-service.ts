/**
 * Public Partner Network — data access for the shop finder, the public shop profile, and rating
 * recalculation.
 *
 * POOL CHOICE IS LOAD-BEARING, and gets its own note because getting it wrong fails silently:
 *
 *   FINDER / PROFILE (anonymous)  -> partnerPublicQuery. No tenant GUC. The rows come back only
 *                                    because 0058 gives partner_public_listings an explicit
 *                                    `FOR SELECT USING (listing_status='ACTIVE')` policy. If that
 *                                    policy were ever dropped, every query here would return an
 *                                    empty array behind an HTTP 200 rather than an error.
 *
 *   PARTNER SELF-SERVICE          -> withTenant (partner_runtime, tenant GUC set). MUST NOT use the
 *                                    admin pool: the whole enforcement of "a partner may edit its
 *                                    phone but not its rating" is a COLUMN-LEVEL GRANT on
 *                                    partner_runtime. The admin pool is BYPASSRLS and holds owner
 *                                    privileges, so routing a self-service write through it
 *                                    silently discards the entire protection.
 *
 *   RATING RECALC / ADMIN         -> partnerAdminQuery / withPartnerAdminTransaction. Recalculation
 *                                    reads `certificates` (which partner_runtime cannot see) and
 *                                    writes rating columns partner_runtime has no grant on.
 *
 * Every public read builds an EXPLICIT allowlist DTO. There is no `SELECT *` to JSON anywhere in
 * this file, and the SELECT column lists are written out in full so that adding a column to
 * partner_public_listings can never widen a public response by accident.
 */
import type { PoolClient } from "pg";
import { partnerPublicQuery, partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import {
  buildRatingEvidence,
  computeRating,
  haversineKm,
  boundingBox,
  normalisePostcode,
  outwardCode,
  MINIMUM_PUBLIC_SAMPLE,
  RATING_WINDOW_DAYS,
  type ComputedRating,
  type RatingEvidence,
} from "./public-network-rating";

/** Hard ceiling on finder page size. A public endpoint must not let a caller ask for the world. */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;
/** Radius applied when a caller supplies coordinates without one. */
export const DEFAULT_RADIUS_KM = 40;
export const MAX_RADIUS_KM = 250;
/** Cards shown on a public shop profile. */
export const RECENT_CARDS_LIMIT = 12;

export class PublicNetworkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "PublicNetworkError";
  }
}

/**
 * The public columns of a listing, written out in full.
 *
 * DELIBERATELY EXCLUDED, and each for a reason: `id` and `tenant_id` and `location_id` (internal
 * identifiers a visitor has no use for and which would leak the tenant graph), `created_by`,
 * `verified_by`, `approved_by` (staff identities), `current_rating_snapshot_id` (internal join
 * key). `public_ref` is excluded too — support quotes it, the website does not need it.
 */
/**
 * OVERRIDE EXPIRY AND ELIGIBILITY NOW LIVE IN THE DATABASE.
 *
 * Both rules used to be re-stated here in TypeScript. They are now carried by
 * partner_public_shop_projection (0061), which is the only relation the public reader can see, and
 * 0061's completeness assertions fail the migration if either gate goes missing from the view
 * definition. Restating them here as well would create two places to forget one.
 */
const PUBLIC_LISTING_COLUMNS = `
  slug,
  public_display_name,
  trading_name_snapshot,
  address_line_1,
  address_line_2,
  town_city,
  county,
  postcode,
  country,
  latitude,
  longitude,
  public_phone,
  public_email,
  public_website,
  public_opening_info,
  public_description,
  listing_status,
  verified_at,
  public_since,
  current_rating_version,
  current_public_rating,
  current_rating_label,
  current_rating_available,
  current_rating_is_override,
  current_sample_size,
  current_minimum_sample,
  current_rating_calculated_at
`;

export interface PublicRatingDto {
  available: boolean;
  /**
   * True when a Super Admin override is what the visitor is seeing. Published because a rating a
   * human typed and a rating the formula produced are different claims, and a consumer that cannot
   * tell them apart is being misled — `version` is null in that case for the same reason.
   */
  isOverride: boolean;
  /** 0.0-5.0, or null while the rating is still building. */
  rating: number | null;
  label: string;
  sampleSize: number;
  minimumSample: number;
  version: string | null;
  calculatedAt: string | null;
}

export interface PublicShopSummaryDto {
  slug: string;
  displayName: string;
  tradingName: string | null;
  townCity: string | null;
  county: string | null;
  postcode: string | null;
  country: string;
  /** null when the shop has no approved coordinates. Never fabricated. */
  latitude: number | null;
  longitude: number | null;
  /** Kilometres from the caller's point, or null when either side lacks coordinates. */
  distanceKm: number | null;
  verified: boolean;
  rating: PublicRatingDto;
}

export interface PublicShopProfileDto extends PublicShopSummaryDto {
  addressLine1: string | null;
  addressLine2: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  openingInfo: string | null;
  description: string | null;
  publicSince: string | null;
  stats: { cardsGraded: number };
  recentCards: PublicRecentCardDto[];
}

export interface PublicRecentCardDto {
  certId: string;
  cardName: string | null;
  cardSet: string | null;
  cardYear: string | null;
  cardNumber: string | null;
  grade: string | null;
  gradedDate: string | null;
  /** Same-origin proxy path, NOT a presigned URL — see getRecentCards for why. */
  frontImageUrl: string | null;
}

function ratingDto(r: Record<string, unknown>): PublicRatingDto {
  const available = r.current_rating_available === true;
  const isOverride = r.current_rating_is_override === true;
  return {
    available,
    isOverride,
    // Belt and braces over the DB CHECK: never emit a number when the rating is not available.
    rating: available && r.current_public_rating !== null ? Number(r.current_public_rating) : null,
    label: String(r.current_rating_label ?? "Rating building"),
    sampleSize: Number(r.current_sample_size ?? 0),
    minimumSample: Number(r.current_minimum_sample ?? MINIMUM_PUBLIC_SAMPLE),
    // A hand-set override must NOT be attributed to PARTNER_QUALITY_V1 — the formula did not
    // produce it.
    version: available && !isOverride ? ((r.current_rating_version as string | null) ?? null) : null,
    calculatedAt: iso(r.current_rating_calculated_at),
  };
}

function summaryDto(r: Record<string, unknown>, distanceKm: number | null): PublicShopSummaryDto {
  return {
    slug: String(r.slug),
    displayName: String(r.public_display_name),
    tradingName: (r.trading_name_snapshot as string | null) ?? null,
    townCity: (r.town_city as string | null) ?? null,
    county: (r.county as string | null) ?? null,
    postcode: (r.postcode as string | null) ?? null,
    country: String(r.country ?? "GB"),
    latitude: r.latitude === null || r.latitude === undefined ? null : Number(r.latitude),
    longitude: r.longitude === null || r.longitude === undefined ? null : Number(r.longitude),
    distanceKm,
    verified: r.verified_at !== null && r.verified_at !== undefined,
    rating: ratingDto(r),
  };
}

function iso(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export type FinderSort = "distance" | "quality" | "name";

export interface FinderQuery {
  q?: string;
  postcode?: string;
  town?: string;
  county?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  page: number;
  pageSize: number;
  sort?: FinderSort;
}

export interface FinderResult {
  rows: PublicShopSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** What the server actually did, so the UI never has to guess why the order looks as it does. */
  appliedSort: FinderSort;
  /** True when a coordinate-based search ran. */
  geo: boolean;
}

/**
 * Shop finder.
 *
 * ONLY ACTIVE LISTINGS, enforced twice: the SQL says so, and the RLS policy says so. The belt is
 * not redundant with the braces — the SQL predicate keeps the query on the partial indexes, and
 * the policy is what protects the surface if a future query forgets.
 *
 * TWO EXECUTION SHAPES:
 *  - GEO (caller supplied lat/lng): pre-filter on a bounding box using the coords index, compute
 *    exact Haversine in JS on the survivors, then sort and paginate. Distance cannot be indexed
 *    directly, and the box is generous by construction so it can never exclude an in-radius shop.
 *  - TEXT: filter in SQL, sort in SQL, paginate in SQL with an id tiebreak.
 *
 * The bounded page size and the ACTIVE-only partial indexes matter more than usual here: the
 * runtime pool has max 8 connections and a 3s query timeout, so an unindexed scan on this path is
 * a hard failure under load, not a slow page.
 */
export async function findShops(query: FinderQuery): Promise<FinderResult> {
  const geo = typeof query.lat === "number" && typeof query.lng === "number";
  const sort: FinderSort = query.sort ?? (geo ? "distance" : "quality");
  if (sort === "distance" && !geo) {
    throw new PublicNetworkError("DISTANCE_REQUIRES_COORDINATES", "Sorting by distance requires lat and lng.", 400);
  }

  // PUBLIC ELIGIBILITY (0059). All three conjuncts, not just listing_status: an organisation or
  // location that has lost its standing must vanish from the finder with no second manual action.
  // These are SNAPSHOT columns maintained by ENABLE ALWAYS triggers, not a join — the anonymous
  // connection has no tenant GUC and both source tables are FORCE RLS, so a join would match zero
  // rows and hide every shop. The RLS policy carries the identical predicate as the second layer.
  // Gates live in partner_public_shop_projection (0061): the view returns only ACTIVE listings
  // whose organisation AND location are ACTIVE, so no row reaching this query is ineligible.
  const where: string[] = ["true"];
  const params: unknown[] = [];
  const add = (v: unknown) => `$${params.push(v)}`;

  if (query.q) {
    // Name search only. Deliberately not a full-text search across every column: a visitor typing
    // "Strood" should match the town filter, not accidentally match a shop whose description
    // mentions Strood.
    where.push(`lower(public_display_name) LIKE ${add(`%${query.q.toLowerCase()}%`)}`);
  }
  if (query.town) where.push(`lower(town_city) = ${add(query.town.toLowerCase())}`);
  if (query.county) where.push(`lower(county) = ${add(query.county.toLowerCase())}`);

  if (query.postcode) {
    const normalised = normalisePostcode(query.postcode);
    if (normalised) {
      const outward = outwardCode(normalised);
      // A full postcode matches exactly OR by its area; a partial input ("ME2") matches every
      // postcode in that outward code. Both sides use the DB-generated canonical columns, so
      // "ME2 2NG", "me22ng" and "ME2-2NG" are the same search.
      if (normalised.length >= 5) {
        where.push(`(postcode_normalised = ${add(normalised)} OR postcode_outward = ${add(outward)})`);
      } else if (outward) {
        where.push(`postcode_outward = ${add(outward)}`);
      }
    }
  }

  if (geo) {
    const radius = Math.min(MAX_RADIUS_KM, Math.max(1, query.radiusKm ?? DEFAULT_RADIUS_KM));
    const box = boundingBox(query.lat!, query.lng!, radius);
    where.push("latitude IS NOT NULL AND longitude IS NOT NULL");
    where.push(`latitude BETWEEN ${add(box.minLat)} AND ${add(box.maxLat)}`);
    where.push(`longitude BETWEEN ${add(box.minLng)} AND ${add(box.maxLng)}`);
  }

  const whereSql = where.join(" AND ");

  if (geo) {
    // Bounded by the box + a hard LIMIT so a caller cannot pull the whole estate into memory by
    // asking for a 250km radius.
    const { rows } = await partnerPublicQuery<Record<string, unknown>>(
      `SELECT ${PUBLIC_LISTING_COLUMNS} FROM partner_public_shop_projection
        WHERE ${whereSql}
        ORDER BY slug
        LIMIT 500`,
      params,
    );
    const radius = Math.min(MAX_RADIUS_KM, Math.max(1, query.radiusKm ?? DEFAULT_RADIUS_KM));
    const withDistance = rows
      .map((r) => ({
        row: r,
        distanceKm: haversineKm(query.lat!, query.lng!, Number(r.latitude), Number(r.longitude)),
      }))
      .filter((x) => x.distanceKm <= radius);

    withDistance.sort((a, b) => {
      if (sort === "name") return String(a.row.public_display_name).localeCompare(String(b.row.public_display_name));
      if (sort === "quality") return compareQuality(a.row, b.row);
      // distance, with slug as the deterministic tiebreak — without it, equal distances make page
      // boundaries plan-dependent and rows silently repeat or vanish across pages.
      return a.distanceKm - b.distanceKm || String(a.row.slug).localeCompare(String(b.row.slug));
    });

    const total = withDistance.length;
    const start = (query.page - 1) * query.pageSize;
    const pageRows = withDistance.slice(start, start + query.pageSize);
    return {
      rows: pageRows.map((x) => summaryDto(x.row, Math.round(x.distanceKm * 10) / 10)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      appliedSort: sort,
      geo: true,
    };
  }

  // NON-GEO. Rated shops always precede unrated ones under `quality`: a shop still building a
  // rating must never outrank a rated shop, and NULLS LAST on a DESC sort is what guarantees it.
  const orderSql =
    sort === "name"
      ? "lower(public_display_name) ASC, slug ASC"
      : "current_rating_available DESC, current_public_rating DESC NULLS LAST, lower(public_display_name) ASC, slug ASC";

  const countRes = await partnerPublicQuery<{ n: string }>(
    `SELECT count(*)::text n FROM partner_public_shop_projection WHERE ${whereSql}`,
    params,
  );
  const total = Number(countRes.rows[0]?.n ?? 0);

  const offset = (query.page - 1) * query.pageSize;
  const { rows } = await partnerPublicQuery<Record<string, unknown>>(
    `SELECT ${PUBLIC_LISTING_COLUMNS} FROM partner_public_shop_projection
      WHERE ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ${add(query.pageSize)} OFFSET ${add(offset)}`,
    params,
  );

  return {
    rows: rows.map((r) => summaryDto(r, null)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    appliedSort: sort,
    geo: false,
  };
}

function compareQuality(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aAvail = a.current_rating_available === true;
  const bAvail = b.current_rating_available === true;
  if (aAvail !== bAvail) return aAvail ? -1 : 1;
  const av = aAvail ? Number(a.current_public_rating) : -1;
  const bv = bAvail ? Number(b.current_public_rating) : -1;
  return bv - av || String(a.slug).localeCompare(String(b.slug));
}

/**
 * Public shop profile by slug.
 *
 * Returns null for any listing that is not ACTIVE — including PAUSED and SUSPENDED — because the
 * RLS public policy admits only ACTIVE rows. The route turns that into a 404 rather than a 403:
 * telling an anonymous caller "this shop exists but is suspended" is itself a disclosure.
 */
export async function getShopProfile(slug: string): Promise<PublicShopProfileDto | null> {
  const { rows } = await partnerPublicQuery<Record<string, unknown>>(
    `SELECT ${PUBLIC_LISTING_COLUMNS}, location_id
       FROM partner_public_shop_projection
      WHERE slug = $1
      LIMIT 1`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;

  const locationId = String(row.location_id);
  const [recentCards, cardsGraded] = await Promise.all([getRecentCards(locationId), countPublicCards(locationId)]);

  return {
    ...summaryDto(row, null),
    addressLine1: (row.address_line_1 as string | null) ?? null,
    addressLine2: (row.address_line_2 as string | null) ?? null,
    phone: (row.public_phone as string | null) ?? null,
    email: (row.public_email as string | null) ?? null,
    website: (row.public_website as string | null) ?? null,
    openingInfo: (row.public_opening_info as string | null) ?? null,
    description: (row.public_description as string | null) ?? null,
    publicSince: iso(row.public_since),
    stats: { cardsGraded },
    recentCards,
  };
}

/**
 * The publication predicate for a card on a shop profile.
 *
 * THIS IS DELIBERATELY THE STRICTEST PREDICATE ALREADY SHIPPED, copied from
 * server/slab-showcase.ts getRecentGradedItems — not the looser one used by /api/cert/:id.
 *
 * The difference matters: /api/cert/:id intentionally serves VOIDED certificates (status='voided')
 * so a voided slab remains verifiable-as-void when someone scans its QR code. That is right for a
 * verification endpoint and wrong for a shop's showcase, which would otherwise advertise voided
 * work as a credential. Using the stricter predicate means this feature can only ever NARROW
 * publication, never broaden it — which is the property required of it.
 */
/**
 * EXPORTED so a test can execute the exact shipped column list against a real PostgreSQL. An
 * assertion that merely re-types these names in the test would prove nothing — the defect this
 * guards against is a name that TypeScript cannot check because it lives inside a SQL string.
 */
export const RECENT_CARD_COLUMNS =
  "certificate_number, card_name, set_name, year_text, card_number_display, grade, grade_approved_at";

/**
 * The complete public-visibility gate for a shop listing.
 *
 * org_status and location_status are 0059 snapshot columns kept in step with partner_organisations
 * and partner_locations by ENABLE ALWAYS triggers. Eligibility is ACTIVE on both: PENDING is not
 * eligible, because a shop whose organisation was never activated has no business on a public map.
 *
 * KEEP THIS IDENTICAL to the partner_public_listings_public_read RLS policy in 0059. They are two
 * layers of the same rule, and a query that quietly disagreed with the policy would either serve
 * suspended shops or serve none at all.
 */
export const PUBLIC_ELIGIBILITY_PREDICATE =
  "listing_status = 'ACTIVE' AND org_status = 'ACTIVE' AND location_status = 'ACTIVE'";

export const PUBLIC_CARD_PREDICATE = `
  deleted_at IS NULL
  AND status = 'active'
  AND grade IS NOT NULL
  AND grade_approved_at IS NOT NULL
`;

/**
 * THE V2 RATING DENOMINATOR — units that have entered the review lifecycle.
 *
 * Deliberately WIDER than PUBLIC_CARD_PREDICATE, and the difference is the entire anti-gaming fix.
 * PUBLIC_CARD_PREDICATE answers "may this card be shown publicly"; this answers "did this shop's
 * work reach HQ review", which is a question abandonment cannot un-answer.
 *
 *   grade_approved_at IS NOT NULL  -> reached approval
 *   redo_count > 0                 -> was returned for change at least once
 *
 * The second arm is what keeps an abandoned unit in the population: it has no approval timestamp,
 * but server/grader.ts increments redo_count inside the rejection CAS and NOTHING in the codebase
 * ever resets it, so the bounce is permanent evidence. `grade IS NOT NULL` is intentionally absent —
 * an abandoned unit may never have been graded, and requiring a grade would reopen the exact hole.
 *
 * This is a per-CERTIFICATE predicate, and a certificate is one physical unit. Repeated
 * return/resubmit cycles raise redo_count on the same row, so the unit is counted once no matter
 * how many attempts it took.
 */
export const REVIEWED_UNIT_PREDICATE = `
  deleted_at IS NULL
  AND status = 'active'
  AND (grade_approved_at IS NOT NULL OR redo_count > 0)
`;

/**
 * Cards graded by this shop.
 *
 * ATTRIBUTION IS HISTORICAL, NOT CURRENT. origin_location_id is the immutable 0035 snapshot taken
 * at grading time, so a shop that moves premises keeps exactly the cards it actually graded, and
 * the cards keep the address they were graded at. Nothing here reads the listing's current
 * address, and nothing here can write to certificates.
 *
 * IMAGES ARE PROXY PATHS, NOT PRESIGNED URLS. Presigning per card would (a) make the response
 * uncacheable, because it would embed a shared, expiring credential in a public payload, and
 * (b) cost two HMAC signings per card. The proxy path re-checks the public gate itself when the
 * image is fetched, so the visibility rule is enforced twice, independently.
 */
export async function getRecentCards(locationId: string): Promise<PublicRecentCardDto[]> {
  const { rows } = await partnerPublicQuery<Record<string, unknown>>(
    // COLUMN NAMES ARE NOT THE OBVIOUS ONES. On `certificates` the set is `set_name`, the year is
    // `year_text` and the card number is `card_number_display` — `card_set`/`card_year` belong to
    // partner_submission_cards and do not exist here at all. An earlier revision of this query used
    // those names: it type-checked perfectly and 500'd every single shop profile at runtime, because
    // nothing in TypeScript knows what a raw SQL string means. Verified against shared/schema.ts.
    `SELECT ${RECENT_CARD_COLUMNS}
       FROM partner_public_card_projection
      WHERE origin_location_id = $1
      ORDER BY grade_approved_at DESC
      LIMIT ${RECENT_CARDS_LIMIT}`,
    [locationId],
  );
  return rows.map((r) => ({
    certId: String(r.certificate_number),
    cardName: (r.card_name as string | null) ?? null,
    cardSet: (r.set_name as string | null) ?? null,
    cardYear: r.year_text === null || r.year_text === undefined ? null : String(r.year_text),
    cardNumber: (r.card_number_display as string | null) ?? null,
    grade: r.grade === null || r.grade === undefined ? null : String(r.grade),
    gradedDate: iso(r.grade_approved_at),
    // `scan`, not `front`. server/routes.ts:3217-3232 accepts exactly front-label | back-label |
    // scan and 404s anything else, so `/front` produced a dead image on every card — and, worse,
    // meant the "the proxy re-checks the gate" second layer claimed above was never exercised.
    // `scan` is what slab-showcase.ts:118 uses, and its gate matches PUBLIC_CARD_PREDICATE.
    frontImageUrl: `/api/public/slab-image/${encodeURIComponent(String(r.certificate_number))}/scan`,
  }));
}

/**
 * Publicly-safe card count. SERVER-DERIVED ONLY — there is no partner-writable counter anywhere in
 * this feature, and partner_runtime holds no UPDATE grant on any count column (COUNT1).
 */
export async function countPublicCards(locationId: string): Promise<number> {
  const { rows } = await partnerPublicQuery<{ n: string }>(
    `SELECT count(*)::text n FROM partner_public_card_projection
      WHERE origin_location_id = $1`,
    [locationId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Measure the rating evidence for one location.
 *
 * Runs on the ADMIN pool because `certificates` is not readable by partner_runtime. One aggregate
 * query, no per-card work — a rating must never cost a scan per card.
 */
export async function measureEvidence(locationId: string): Promise<RatingEvidence> {
  const { rows } = await partnerAdminQuery<{
    w_units: string; w_first: string; w_redos: string; w_aband: string;
    a_units: string; a_first: string; a_redos: string; a_aband: string;
  }>(
    `WITH units AS (
       SELECT redo_count,
              grade_approved_at,
              grade,
              -- The unit's position in time. grade_approved_at is the truth for an approved unit;
              -- an ABANDONED unit has none, so we fall back through the timestamps that do survive
              -- rework. issued_at is the last resort and always exists, so a unit can never fall
              -- out of the all-time population for want of a date.
              COALESCE(grade_approved_at, graded_at, status_updated_at, issued_at) AS ev
         FROM certificates
        WHERE origin_location_id = $1
          AND origin_type = 'PARTNER'
          AND ${REVIEWED_UNIT_PREDICATE}
     )
     SELECT
       count(*) FILTER (WHERE (ev IS NULL OR ev >= now() - ($2 || ' days')::interval))::text AS w_units,
       count(*) FILTER (WHERE (ev IS NULL OR ev >= now() - ($2 || ' days')::interval)
                          AND grade_approved_at IS NOT NULL AND grade IS NOT NULL AND redo_count = 0)::text AS w_first,
       coalesce(sum(redo_count) FILTER (WHERE (ev IS NULL OR ev >= now() - ($2 || ' days')::interval)), 0)::text AS w_redos,
       count(*) FILTER (WHERE (ev IS NULL OR ev >= now() - ($2 || ' days')::interval)
                          AND grade_approved_at IS NULL)::text AS w_aband,
       count(*)::text AS a_units,
       count(*) FILTER (WHERE grade_approved_at IS NOT NULL AND grade IS NOT NULL AND redo_count = 0)::text AS a_first,
       coalesce(sum(redo_count), 0)::text AS a_redos,
       count(*) FILTER (WHERE grade_approved_at IS NULL)::text AS a_aband
     FROM units`,
    [locationId, String(RATING_WINDOW_DAYS)],
  );
  const r = rows[0];
  const windowed = {
    reviewedUnits: Number(r?.w_units ?? 0),
    firstPassUnits: Number(r?.w_first ?? 0),
    totalRedos: Number(r?.w_redos ?? 0),
    abandonedUnits: Number(r?.w_aband ?? 0),
    windowDays: RATING_WINDOW_DAYS as number | null,
  };

  // THE FALLBACK. A rolling window is only honest while it holds enough units to mean something.
  // Below the minimum we widen to the all-time population rather than publish a rating built on
  // three cards — and if all-time is ALSO short, computeRating's sample gate returns
  // "Rating building". A small window never becomes a small rating; it becomes no rating.
  if (windowed.reviewedUnits >= MINIMUM_PUBLIC_SAMPLE) return buildRatingEvidence(locationId, windowed);

  return buildRatingEvidence(locationId, {
    reviewedUnits: Number(r?.a_units ?? 0),
    firstPassUnits: Number(r?.a_first ?? 0),
    totalRedos: Number(r?.a_redos ?? 0),
    abandonedUnits: Number(r?.a_aband ?? 0),
    windowDays: null,
  });
}

export interface RecalculationResult {
  listingId: string;
  locationId: string;
  computed: ComputedRating;
  /** What the public will actually see, after any active override is applied. */
  effective: {
    rating: number | null;
    label: string;
    available: boolean;
    isOverride: boolean;
  };
  evidence: RatingEvidence;
  snapshotId: string;
}

/**
 * Recalculate and persist one listing's rating. IDEMPOTENT in effect: running it twice with
 * unchanged evidence produces the same effective rating (it appends a second snapshot, which is
 * the point of a history, but the listing's current values are identical).
 *
 * The COMPUTED score is always written to the snapshot history untouched. The override, if one is
 * active, is applied only to the denormalised current-* columns the public reads. That is what
 * keeps an override auditable rather than a quiet rewrite of the record.
 */
export async function recalculateRating(listingId: string, actor: string): Promise<RecalculationResult> {
  const listing = await partnerAdminQuery<{ id: string; tenant_id: string; location_id: string }>(
    "SELECT id, tenant_id, location_id FROM partner_public_listings WHERE id = $1",
    [listingId],
  );
  const l = listing.rows[0];
  if (!l) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);

  const evidence = await measureEvidence(l.location_id);
  const computed = computeRating(evidence);

  return withPartnerAdminTransaction(async (client: PoolClient) => {
    const snap = await client.query<{ id: string }>(
      `INSERT INTO partner_public_rating_snapshots
         (tenant_id, listing_id, location_id, rating_version, internal_score, public_rating,
          rating_label, rating_available, sample_size, minimum_sample,
          component_scores, evidence_availability, calculated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
       RETURNING id`,
      [
        l.tenant_id,
        l.id,
        l.location_id,
        computed.version,
        computed.internalScore,
        computed.publicRating,
        computed.ratingLabel,
        computed.ratingAvailable,
        computed.sampleSize,
        computed.minimumSample,
        JSON.stringify(computed.componentScores),
        JSON.stringify(computed.evidenceAvailability),
        actor,
      ],
    );
    const snapshotId = snap.rows[0].id;

    // An override expires by clock, not by a job: expires_at in the past means inactive. A trigger
    // that retired rows on a schedule would mutate history behind the operator's back.
    const ov = await client.query<{
      override_public_rating: string | null;
      override_rating_label: string | null;
      expires_at: Date | null;
    }>(
      `SELECT override_public_rating, override_rating_label, expires_at
         FROM partner_public_rating_overrides
        WHERE listing_id = $1 AND removed_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1`,
      [l.id],
    );
    const override = ov.rows[0];

    const isOverride = Boolean(override);
    const effectiveRating = override
      ? override.override_public_rating === null
        ? computed.publicRating
        : Number(override.override_public_rating)
      : computed.publicRating;
    const effectiveLabel = override?.override_rating_label ?? computed.ratingLabel;
    // An override may publish a rating the sample gate would otherwise withhold — that is the point
    // of an EXCEPTIONAL override, and it is a named Super Admin's recorded decision.
    //
    // An earlier revision achieved that by rewriting current_minimum_sample DOWN to the actual
    // sample so the CHECK would pass. That made the API lie: a 0-card shop reported
    // `minimumSample: 0`, i.e. "the gate was met", when it had been sidestepped. The real minimum
    // is now always stored, and the CHECK itself exempts override rows — so the constraint states
    // the actual rule ("a COMPUTED rating must meet the gate") instead of being worked around.
    const effectiveAvailable = isOverride ? effectiveRating !== null : computed.ratingAvailable;
    const storedMinimum = computed.minimumSample;

    await client.query(
      `UPDATE partner_public_listings
          SET current_rating_version = $2,
              current_public_rating = $3,
              current_rating_label = $4,
              current_rating_available = $5,
              current_sample_size = $6,
              current_minimum_sample = $7,
              current_rating_is_override = $8,
              current_rating_calculated_at = now(),
              current_rating_snapshot_id = $9,
              -- The COMPUTED rating is denormalised beside the effective one so that when the
              -- override lapses the public read has something honest to fall back to, with no
              -- write and no job. These are always the formula's own output, never the override's.
              current_computed_public_rating = $10,
              current_computed_rating_label = $11,
              current_computed_rating_available = $12,
              current_computed_rating_version = $13,
              -- NULL whenever no override is in force, so a stale expiry can never resurrect one.
              current_override_expires_at = $14
        WHERE id = $1`,
      [
        l.id,
        computed.version,
        effectiveAvailable ? effectiveRating : null,
        effectiveLabel,
        effectiveAvailable,
        computed.sampleSize,
        storedMinimum,
        isOverride,
        snapshotId,
        computed.ratingAvailable ? computed.publicRating : null,
        computed.ratingLabel,
        computed.ratingAvailable,
        computed.version,
        isOverride ? (override?.expires_at ?? null) : null,
      ],
    );

    return {
      listingId: l.id,
      locationId: l.location_id,
      computed,
      effective: {
        rating: effectiveAvailable ? effectiveRating : null,
        label: effectiveLabel,
        available: effectiveAvailable,
        isOverride,
      },
      evidence,
      snapshotId,
    };
  });
}
