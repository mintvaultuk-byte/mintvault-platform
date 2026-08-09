/**
 * Public Partner Network — HTTP surface.
 *
 * Three routers, deliberately separate because they have three different threat models:
 *
 *   partnerNetworkPublicRouter   ANONYMOUS. Mounted at /api/shops, OUTSIDE /api/partner so it can
 *                                never inherit partnerSessionMiddleware or the partner-portal
 *                                flags. A consumer looking for a shop must not be taken offline
 *                                because an operator hit the partner-portal emergency stop.
 *   partnerNetworkAdminRouter    SUPER ADMIN. Listing lifecycle, address/coordinates, rating
 *                                inspection, recalculation, overrides. Every mutation audited.
 *   partnerNetworkSelfServeRouter AUTHENTICATED PARTNER. The five safe contact fields, and nothing
 *                                else — enforced by a column GRANT, not by this file.
 *
 * RATE LIMITING uses express-rate-limit rather than the bespoke partnerRateLimit wrapper, because
 * CodeQL's js/missing-rate-limiting recognises known limiter libraries and not bespoke ones — the
 * repo hit six false HIGH alerts on demonstrably-limited routes before adopting this shape. The
 * keyGenerator routes through partnerRateLimitClientKey so IPv6 clients are bucketed by /56 rather
 * than by full address; without that an IPv6 client rotating inside its own /64 gets unbounded
 * buckets, which matters far more here than on an admin route because this limiter is the ONLY
 * volumetric control in front of an anonymous endpoint.
 */
import { Router, type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { partnerRateLimitClientKey } from "./rate-limit";
import { requireSuperAdmin } from "../auth";
import { requirePartnerAuth, requirePartnerCapability, requireNotViewOnly } from "./session";
import { getPartnerAdminCapability } from "./admin-capability";
import { withTenant, partnerAdminQuery, withPartnerAdminTransaction, PartnerPublicDbUnavailable } from "./db";
import type { PoolClient } from "pg";
import { partnerPublicNetworkGate } from "./public-network-gate";
import { writePartnerAudit } from "./audit";
import { ratingsNeedingAttention, markRatingDirtyByListing } from "./public-network-rating-lifecycle";
import { SELF_SERVICE_VALIDATORS, SelfServiceValidationError } from "./public-network-validation";
import { storage } from "../storage";
import {
  findShops,
  getShopProfile,
  recalculateRating,
  measureEvidence,
  PublicNetworkError,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  type FinderSort,
} from "./public-network-service";

export const PARTNER_NETWORK_PUBLIC_BASE = "/api/shops";
export const PARTNER_NETWORK_ADMIN_BASE = "/api/super-admin/partner-listings";

const MAX_TEXT = 200;

function sendError(res: Response, err: unknown): void {
  if (err instanceof PublicNetworkError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // A rejected self-service VALUE is a 400 the partner can act on, and it names the offending field
  // so the portal can mark the right input rather than showing a form-level error. Handled here
  // rather than converted at each call site so a future field cannot be added without the mapping.
  if (err instanceof SelfServiceValidationError) {
    res.status(400).json({ error: { code: err.code, message: err.message, field: err.field } });
    return;
  }
  // Log code+message only. A pg error object's `detail` can carry row values, i.e. PII.
  const e = err as { code?: string; message?: string };
  if (isPublicDbUnavailable(err)) {
    // 503, not 500: this is "come back shortly", not "this request was wrong". The distinction is
    // load-bearing for the caller — a CDN or a client may retry a 503 and must not retry a 500 —
    // and for us, because a public database outage that reports 500 looks like an application bug
    // in every dashboard.
    //
    // The body is a FIXED domain shape. Nothing derived from the error reaches it: no SQLSTATE, no
    // query text, no role, no host, no database name, no stack. A pg connection error's `message`
    // routinely contains the host and port, so echoing it here would publish the database endpoint
    // to anonymous callers.
    console.error("[partner-network] public database unavailable:", e?.code, e?.message);
    res.status(503).json({
      error: { code: "public_service_unavailable", message: "Shop finder is temporarily unavailable. Please try again shortly." },
    });
    return;
  }
  console.error("[partner-network] unexpected error:", e?.code, e?.message);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
}

/**
 * Is this failure "the public database could not serve us right now"?
 *
 * Deliberately an ALLOWLIST of causes rather than a catch-all. A catch-all would quietly convert a
 * genuine application bug into a soothing 503 and hide it from every alert, which is the opposite
 * of what an outage signal is for.
 *
 * The SQLSTATEs fall into two groups.
 *
 * OUR OWN BOUNDS FIRING — the public pool doing what it was configured to do:
 *   57014  query_canceled / statement_timeout  — the statement bound
 *   55P03  lock_not_available                  — the lock_timeout bound
 *   53300  too_many_connections                — the server refusing more backends
 *   53200  out_of_memory                       — the server refusing to allocate
 *
 * THE PROVIDER TAKING THE ENDPOINT AWAY — added after hostile review, because Neon does all three
 * of these ROUTINELY (autosuspend, scale-to-zero, compute restart, maintenance) and every one of
 * them was previously classified "unknown" and served as a 500. An ordinary Neon idle-resume
 * looked identical to an application bug in every dashboard:
 *   57P01  admin_shutdown        — the backend was terminated by an administrator
 *   57P02  crash_shutdown        — the server is shutting down after a crash
 *   57P03  cannot_connect_now    — the server is starting up and not yet accepting connections
 *   08xxx  connection exception  — the endpoint gone, refusing, or lost mid-query
 *
 * plus node-postgres' own client-side acquire and query timeouts, which surface as MESSAGES rather
 * than SQLSTATEs, and PartnerPublicDbUnavailable for a missing/refused public configuration.
 *
 * ── WHAT WAS REMOVED, AND WHY IT MATTERED (HIGH H7) ─────────────────────────────────────────
 * `msg.includes("fail closed")` used to be in this list, and it is the reason this function needed
 * revisiting. "fail closed" is not a database condition — it is a PHRASE THIS CODEBASE WRITES INTO
 * ITS OWN ERROR MESSAGES, in at least four places (server/partner/db.ts's missing-URL guard, its
 * tenant-context assertion, the partner runtime pool's refusal to start, and now the public
 * reader's role assertion). Several of those are raised by APPLICATION BUGS: a malformed tenant id
 * reaching withTenant is a programming error, and it was being reported to the caller as "the shop
 * finder is temporarily unavailable, please try again shortly" and to us as a 503 that no alert
 * treats as a defect. A substring match on our own prose is the widest possible net, and it caught
 * exactly the class of error that must stay loud.
 *
 * The genuine missing-configuration case that clause was there for is already covered, properly and
 * by TYPE, by the `instanceof PartnerPublicDbUnavailable` check on the first line.
 *
 * THE RULE: an unknown error is a 500. A 500 is visible, alertable and honest. Widening this
 * allowlist by one guess turns a defect into a shrug.
 */
export function isPublicDbUnavailable(err: unknown): boolean {
  if (err instanceof PartnerPublicDbUnavailable) return true;
  const e = err as { code?: string; message?: string };
  const code = typeof e?.code === "string" ? e.code : "";
  if (code === "57014" || code === "55P03" || code === "53300" || code === "53200") return true;
  if (code === "57P01" || code === "57P02" || code === "57P03") return true;
  if (code.startsWith("08")) return true;
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EPIPE") return true;
  const msg = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  return (
    // node-postgres, verbatim: pool acquire timeout, query timeout, and a dropped backend.
    msg.includes("timeout exceeded when trying to connect") ||
    msg.includes("query read timeout") ||
    msg.includes("connection terminated")
  );
}

/**
 * Single-valued query parameter.
 *
 * Rejects a REPEATED parameter rather than silently taking one of them: `?town=a&town=b` arrives
 * as an array, and quietly using the first would apply a filter the caller did not ask for.
 */
function scalar(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) throw new PublicNetworkError("INVALID_INPUT", `The "${name}" parameter must be supplied at most once.`);
  if (typeof v !== "string") throw new PublicNetworkError("INVALID_INPUT", `The "${name}" parameter must be a single value.`);
  const t = v.trim();
  if (t === "") return undefined;
  if (t.length > MAX_TEXT) throw new PublicNetworkError("INVALID_INPUT", `The "${name}" parameter is too long.`);
  return t;
}

function coord(v: unknown, name: string, min: number, max: number): number | undefined {
  const s = scalar(v, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new PublicNetworkError("INVALID_INPUT", `The "${name}" parameter must be between ${min} and ${max}.`);
  }
  return n;
}

function posInt(v: unknown, name: string, fallback: number, max: number): number {
  const s = scalar(v, name);
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

const publicFinderLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests, please slow down." } },
  keyGenerator: (req) => partnerRateLimitClientKey(req),
});

export function partnerNetworkPublicRouter(): Router {
  const r = Router();
  // ORDER MATTERS. The rate limiter runs FIRST, so a flood aimed at a disabled network is still
  // shed at the limiter rather than each request costing a flag read. The gate then runs before
  // any handler, so no route below can be reached while the rollout flag is off — including any
  // route a future edit adds, which is why this is router-level middleware and not a per-handler
  // check somebody can forget.
  r.use(publicFinderLimit);
  r.use(partnerPublicNetworkGate());

  r.get("/", async (req: Request, res: Response) => {
    try {
      const sortRaw = scalar(req.query.sort, "sort");
      if (sortRaw !== undefined && !["distance", "quality", "name"].includes(sortRaw)) {
        throw new PublicNetworkError("INVALID_INPUT", 'The "sort" parameter must be distance, quality or name.');
      }
      const result = await findShops({
        q: scalar(req.query.q, "q"),
        postcode: scalar(req.query.postcode, "postcode"),
        town: scalar(req.query.town, "town"),
        county: scalar(req.query.county, "county"),
        lat: coord(req.query.lat, "lat", -90, 90),
        lng: coord(req.query.lng, "lng", -180, 180),
        radiusKm: coord(req.query.radiusKm, "radiusKm", 1, 250),
        page: posInt(req.query.page, "page", 1, 1000),
        pageSize: posInt(req.query.pageSize, "pageSize", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
        sort: sortRaw as FinderSort | undefined,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/:slug", async (req: Request, res: Response) => {
    try {
      const slug = String(req.params.slug);
      if (slug.length > 120 || !/^[a-z0-9-]+$/.test(slug)) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Shop not found." } });
        return;
      }
      const profile = await getShopProfile(slug);
      if (!profile) {
        // 404 for paused/suspended/absent alike. Distinguishing them would tell an anonymous
        // caller that a shop exists and has been suspended, which is itself a disclosure.
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Shop not found." } });
        return;
      }
      res.json(profile);
    } catch (err) {
      sendError(res, err);
    }
  });

  return r;
}

// =================================================================================================
// SUPER ADMIN
// =================================================================================================

const adminLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests, please slow down." } },
  keyGenerator: (req) => partnerRateLimitClientKey(req),
});

/** Legal transitions, mirroring the database trigger. The trigger is authoritative; this gives a clean 400. */
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PENDING_REVIEW", "REMOVED"],
  PENDING_REVIEW: ["ACTIVE", "DRAFT", "REMOVED"],
  ACTIVE: ["PAUSED", "SUSPENDED", "REMOVED"],
  PAUSED: ["ACTIVE", "SUSPENDED", "REMOVED"],
  SUSPENDED: ["ACTIVE", "REMOVED"],
  REMOVED: [],
};

function adminActor(req: Request): string {
  const s = req.session as { adminEmail?: string };
  const actor = s?.adminEmail;
  if (!actor) {
    // Refuse rather than write "unknown-admin" into the audit trail of a governance decision.
    throw new PublicNetworkError("ACTOR_REQUIRED", "A verified Super Admin actor is required.", 403);
  }
  return actor;
}

function requireReason(body: Record<string, unknown>): string {
  const reason = body.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new PublicNetworkError("REASON_REQUIRED", "A reason is required for every listing change.");
  }
  if (reason.trim().length > 500) throw new PublicNetworkError("INVALID_INPUT", "The reason is too long.");
  return reason.trim();
}

/**
 * Audit INSIDE the caller's transaction.
 *
 * `auditAdmin` below writes on its own connection AFTER the change has committed, and it exists for
 * the cases where that is genuinely all that is possible (a read, or a mutation that has already
 * landed). For a governance decision it is not good enough: a Super Admin overriding a third
 * party's published quality rating, with no record that they did, is the one gap in this feature
 * that cannot be reconstructed after the fact. `auditAdmin`'s own comment concedes this — it
 * reports the gap rather than preventing it, because by the time it runs there is nothing to undo.
 *
 * In a transaction there IS something to undo, so this one does NOT catch. If the audit cannot be
 * written, the override does not happen. Raw SQL rather than the Drizzle helper because the helper
 * binds to the global connection and would commit independently of the caller's transaction —
 * which is precisely the split being closed.
 *
 * Column list matches shared/schema.ts `auditLog` exactly; `created_at` takes its DEFAULT.
 */
async function auditAdminTx(
  client: PoolClient,
  entityId: string,
  action: string,
  actor: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
     VALUES ('partner_public_listing', $1, $2, $3, $4::jsonb)`,
    [entityId, action, actor, JSON.stringify(details)],
  );
}

/**
 * Deterministic failure injection for the atomicity proofs, and ONLY for them.
 *
 * A rollback is only provable if a failure can be forced at a chosen instant. The alternative —
 * mocking the pg client — would test the mock's idea of a transaction rather than PostgreSQL's,
 * and the whole point of these proofs is that the DATABASE rolls the work back.
 *
 * INERT IN PRODUCTION BY CONSTRUCTION. It reads one env var that is never set outside a test
 * process; with it unset this is a single string comparison and returns immediately. It cannot be
 * triggered by any request field, header or user input — there is no path from an HTTP request to
 * this variable.
 */
async function maybeFailForTest(point: string): Promise<void> {
  if (process.env.PARTNER_TEST_FAIL_POINT === point) {
    throw new Error(`forced test failure at ${point}`);
  }
}

async function auditAdmin(
  entityId: string,
  action: string,
  actor: string,
  details: Record<string, unknown>,
): Promise<boolean> {
  try {
    await storage.writeAuditLog("partner_public_listing", entityId, action, actor, details);
    return true;
  } catch (e) {
    // The mutation is already committed. Report the gap rather than letting a silent audit failure
    // make an unaudited governance decision look fully recorded.
    console.error("[partner-network] AUDIT WRITE FAILED for a committed change:", action, entityId, (e as Error)?.message);
    return false;
  }
}

/**
 * Every partner admin router carries this, and omitting it here was a real defect rather than a
 * style inconsistency. 0058 puts FORCE ROW LEVEL SECURITY on all three tables, which removes the
 * table-owner exemption — so ONLY a BYPASSRLS admin role can see a DRAFT or PENDING_REVIEW listing.
 * Without the preflight, an admin pool lacking BYPASSRLS makes the review queue return HTTP 200
 * carrying only ACTIVE rows: the operator sees an empty approval queue and concludes there is
 * nothing to approve. That is the worst possible failure shape, and it is why this is a hard 503
 * rather than a warning.
 */
async function requirePartnerAdminCapability(_req: Request, res: Response, next: () => void): Promise<void> {
  const capability = await getPartnerAdminCapability();
  if (!capability.ok) {
    res.status(503).json({
      error: {
        code: "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE",
        message: "Partner Super Admin management is not ready.",
      },
    });
    return;
  }
  next();
}

export function partnerNetworkAdminRouter(): Router {
  const r = Router();
  // Rate gate first so an unauthenticated flood never drives a DB round trip; capability last
  // because it costs a memoised catalogue query.
  r.use(adminLimit);
  r.use(requireSuperAdmin);
  r.use(requirePartnerAdminCapability);

  /** List every listing in any state — the review queue. */
  r.get("/", async (req: Request, res: Response) => {
    try {
      const status = scalar(req.query.status, "status");
      if (status !== undefined && !Object.keys(TRANSITIONS).includes(status)) {
        throw new PublicNetworkError("INVALID_INPUT", "Unknown listing status filter.");
      }
      const params: unknown[] = [];
      const where = status ? `WHERE listing_status = $${params.push(status)}` : "";
      const { rows } = await partnerAdminQuery<Record<string, unknown>>(
        `SELECT l.id, l.slug, l.public_display_name, l.listing_status, l.tenant_id, l.location_id,
                l.town_city, l.county, l.postcode, l.latitude, l.longitude,
                l.verified_at, l.approved_at, l.approved_by, l.public_since,
                l.current_public_rating, l.current_rating_label, l.current_rating_available,
                l.current_sample_size, l.current_rating_is_override, l.current_rating_calculated_at,
                o.legal_name AS tenant_legal_name
           FROM partner_public_listings l
           JOIN partner_organisations o ON o.id = l.tenant_id
           ${where}
          ORDER BY l.created_at DESC, l.id ASC
          LIMIT 200`,
        params,
      );
      res.json({ rows });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Create a DRAFT listing for an existing partner location. */
  r.post("/", async (req: Request, res: Response) => {
    try {
      const actor = adminActor(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const locationId = typeof body.locationId === "string" ? body.locationId : "";
      const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (!locationId || !slug || !displayName) {
        throw new PublicNetworkError("INVALID_INPUT", "locationId, slug and displayName are required.");
      }
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 3 || slug.length > 120) {
        throw new PublicNetworkError("INVALID_SLUG", "The slug must be lowercase words separated by single hyphens.");
      }

      const loc = await partnerAdminQuery<{ tenant_id: string }>(
        "SELECT tenant_id FROM partner_locations WHERE id = $1",
        [locationId],
      );
      if (!loc.rows[0]) throw new PublicNetworkError("LOCATION_NOT_FOUND", "Partner location not found.", 404);

      const ins = await partnerAdminQuery<{ id: string }>(
        `INSERT INTO partner_public_listings (tenant_id, location_id, slug, public_display_name, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [loc.rows[0].tenant_id, locationId, slug, displayName, actor],
      );
      const id = ins.rows[0].id;
      const audited = await auditAdmin(id, "partner_listing_created", actor, { locationId, slug, displayName });
      res.status(201).json({ id, slug, listingStatus: "DRAFT", audited });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Move a listing through its lifecycle. Approval sets the approval record ACTIVE requires. */
  r.post("/:id/status", async (req: Request, res: Response) => {
    try {
      const actor = adminActor(req);
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = typeof body.status === "string" ? body.status : "";
      const reason = requireReason(body);
      if (!Object.keys(TRANSITIONS).includes(target)) {
        throw new PublicNetworkError("INVALID_INPUT", "Unknown target status.");
      }

      const result = await withPartnerAdminTransaction(async (client) => {
        const cur = await client.query<{ listing_status: string; public_since: string | null; tenant_id: string }>(
          "SELECT listing_status, public_since, tenant_id FROM partner_public_listings WHERE id = $1 FOR UPDATE",
          [id],
        );
        const row = cur.rows[0];
        if (!row) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);
        if (!TRANSITIONS[row.listing_status].includes(target)) {
          throw new PublicNetworkError(
            "ILLEGAL_TRANSITION",
            `A listing cannot move from ${row.listing_status} to ${target}.`,
            409,
          );
        }

        // public_since is set-once: only stamped on the FIRST activation, so a shop that pauses and
        // resumes is never re-advertised as newly joined.
        const stampFirstActivation = target === "ACTIVE" && row.public_since === null;
        const upd = await client.query(
          `UPDATE partner_public_listings
              SET listing_status = $2,
                  approved_at = CASE WHEN $2 = 'ACTIVE' THEN coalesce(approved_at, now()) ELSE approved_at END,
                  approved_by = CASE WHEN $2 = 'ACTIVE' THEN coalesce(approved_by, $3) ELSE approved_by END,
                  public_since = CASE WHEN $4 THEN now() ELSE public_since END,
                  paused_at = CASE WHEN $2 = 'PAUSED' THEN now() ELSE paused_at END,
                  suspended_at = CASE WHEN $2 = 'SUSPENDED' THEN now() ELSE suspended_at END,
                  removed_at = CASE WHEN $2 = 'REMOVED' THEN now() ELSE removed_at END
            WHERE id = $1`,
          [id, target, actor, stampFirstActivation],
        );
        // Zero rows affected is a failure, never a success.
        if (upd.rowCount !== 1) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);
        return { from: row.listing_status, to: target };
      });

      const audited = await auditAdmin(id, "partner_listing_status_changed", actor, { ...result, reason });
      res.json({ ...result, audited });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Public identity, structured address and coordinates — all HQ-owned. */
  r.put("/:id/public-details", async (req: Request, res: Response) => {
    try {
      const actor = adminActor(req);
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = requireReason(body);

      const FIELDS: Record<string, string> = {
        displayName: "public_display_name",
        tradingName: "trading_name_snapshot",
        addressLine1: "address_line_1",
        addressLine2: "address_line_2",
        townCity: "town_city",
        county: "county",
        postcode: "postcode",
        country: "country",
        phone: "public_phone",
        email: "public_email",
        website: "public_website",
        openingInfo: "public_opening_info",
        description: "public_description",
      };

      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [key, col] of Object.entries(FIELDS)) {
        if (!(key in body)) continue;
        const v = body[key];
        if (v !== null && typeof v !== "string") {
          throw new PublicNetworkError("INVALID_INPUT", `The "${key}" field must be a string or null.`);
        }
        if (typeof v === "string" && v.length > 500) {
          throw new PublicNetworkError("INVALID_INPUT", `The "${key}" field is too long.`);
        }
        sets.push(`${col} = $${params.push(v === null ? null : String(v).trim())}`);
      }

      // Coordinates are both-or-neither; the DB enforces it too, but a 400 beats a 500.
      const hasLat = "latitude" in body;
      const hasLng = "longitude" in body;
      if (hasLat !== hasLng) {
        throw new PublicNetworkError("INVALID_INPUT", "latitude and longitude must be supplied together.");
      }
      if (hasLat) {
        const lat = body.latitude;
        const lng = body.longitude;
        if (lat === null && lng === null) {
          sets.push(`latitude = NULL`, `longitude = NULL`);
        } else {
          const nLat = Number(lat);
          const nLng = Number(lng);
          if (!Number.isFinite(nLat) || nLat < -90 || nLat > 90 || !Number.isFinite(nLng) || nLng < -180 || nLng > 180) {
            throw new PublicNetworkError("INVALID_INPUT", "Coordinates are out of range.");
          }
          sets.push(`latitude = $${params.push(nLat)}`, `longitude = $${params.push(nLng)}`);
        }
      }

      if (sets.length === 0) throw new PublicNetworkError("INVALID_INPUT", "No editable fields were supplied.");

      const upd = await partnerAdminQuery(
        `UPDATE partner_public_listings SET ${sets.join(", ")} WHERE id = $1`,
        params,
      );
      if (upd.rowCount !== 1) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);

      const audited = await auditAdmin(id, "partner_listing_public_details_updated", actor, {
        fields: Object.keys(body).filter((k) => k !== "reason"),
        reason,
      });
      res.json({ ok: true, audited });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** HQ verification of the shop's identity. Distinct from approval. */
  r.post("/:id/verify", async (req: Request, res: Response) => {
    try {
      const actor = adminActor(req);
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = requireReason(body);
      const verified = body.verified !== false;
      const upd = await partnerAdminQuery(
        `UPDATE partner_public_listings
            SET verified_at = CASE WHEN $2 THEN now() ELSE NULL END,
                verified_by = CASE WHEN $2 THEN $3 ELSE NULL END
          WHERE id = $1`,
        [id, verified, actor],
      );
      if (upd.rowCount !== 1) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);
      const audited = await auditAdmin(id, verified ? "partner_listing_verified" : "partner_listing_unverified", actor, { reason });
      res.json({ ok: true, verified, audited });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Inspect the computed rating and its evidence WITHOUT persisting anything. */
  r.get("/:id/rating", async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const l = await partnerAdminQuery<{ location_id: string }>(
        "SELECT location_id FROM partner_public_listings WHERE id = $1",
        [id],
      );
      if (!l.rows[0]) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);

      const evidence = await measureEvidence(l.rows[0].location_id);
      const snapshots = await partnerAdminQuery<Record<string, unknown>>(
        `SELECT id, rating_version, internal_score, public_rating, rating_label, rating_available,
                sample_size, minimum_sample, component_scores, evidence_availability, calculated_at, calculated_by
           FROM partner_public_rating_snapshots
          WHERE listing_id = $1 ORDER BY calculated_at DESC LIMIT 20`,
        [id],
      );
      const overrides = await partnerAdminQuery<Record<string, unknown>>(
        `SELECT id, override_public_rating, override_rating_label, reason, created_by, created_at,
                expires_at, removed_at, removed_by, removal_reason
           FROM partner_public_rating_overrides
          WHERE listing_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      );
      res.json({ evidence, snapshots: snapshots.rows, overrides: overrides.rows });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * The Super Admin exception queue — genuine failures only.
   *
   * Deliberately NOT a list of stale ratings. Staleness is normal and self-healing: a listing goes
   * dirty on every HQ review and the reconciler clears it within minutes. What belongs here is the
   * narrower set where automatic recovery has ALREADY been tried and has not worked, which is why
   * the predicate is a consecutive-failure threshold rather than `rating_dirty = true`. A queue that
   * fills up with healthy work is a queue nobody reads.
   *
   * Returned under a `ratings` key so further exception categories (settlement stuck, security hold,
   * post-review cancellation, identity approval, print/completion inconsistency) can be added
   * alongside it without changing the shape the UI already binds to.
   */
  r.get("/needs-attention", async (_req: Request, res: Response) => {
    try {
      res.json({ ratings: await ratingsNeedingAttention() });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Recalculate and persist. Idempotent in effect. */
  r.post("/:id/rating/recalculate", async (req: Request, res: Response) => {
    try {
      const actor = adminActor(req);
      const id = String(req.params.id);
      const result = await recalculateRating(id, actor);
      const audited = await auditAdmin(id, "partner_listing_rating_recalculated", actor, {
        version: result.computed.version,
        internalScore: result.computed.internalScore,
        publicRating: result.effective.rating,
        sampleSize: result.computed.sampleSize,
        isOverride: result.effective.isOverride,
      });
      res.json({ ...result, audited });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Create an exceptional override. The computed score is never destroyed. */
  r.post("/:id/rating/override", async (req: Request, res: Response) => {
    try {
      const actor = adminActor(req);
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const reason = requireReason(body);
      const hasRating = body.rating !== undefined && body.rating !== null;
      const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim() : null;
      if (!hasRating && !label) {
        throw new PublicNetworkError("INVALID_INPUT", "An override must set a rating, a label, or both.");
      }
      let rating: number | null = null;
      if (hasRating) {
        rating = Number(body.rating);
        if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
          throw new PublicNetworkError("INVALID_INPUT", "An override rating must be between 0 and 5.");
        }
      }
      // AN EXPIRY NOW GENUINELY FIRES. This comment used to say the opposite — "advisory only,
      // nothing recalculates on a schedule, a review-by reminder rather than an enforcement" —
      // and it cited limitation L2, which two later migrations closed:
      //   * 0060 made the effective rating fall back to the computed one AT READ TIME, so an
      //     expired override stops applying the moment it lapses, with no job and no write;
      //   * 0066 added rating_next_recalc_at, so the reconciler also refreshes by clock alone.
      // Left as a false comment it would have told the next engineer that the expiry path is
      // decorative, which is precisely the sort of thing that gets deleted as dead code.
      let expiresAt: string | null = null;
      if (typeof body.expiresAt === "string" && body.expiresAt.trim() !== "") {
        const d = new Date(body.expiresAt);
        if (Number.isNaN(d.getTime())) throw new PublicNetworkError("INVALID_INPUT", "expiresAt is not a valid date.");
        expiresAt = d.toISOString();
      }

      /**
       * ── B5: ONE TRANSACTION, OR NONE OF IT ────────────────────────────────────────────────
       * This used to be an INSERT in a transaction, followed by `recalculateRating` and
       * `auditAdmin` OUTSIDE it. Three states could survive a failure between them, and every one
       * is silent:
       *
       *   * override row written, listing's denormalised current_* columns NOT updated — the
       *     override exists in the audit trail and has no effect on what the public sees, which
       *     is the exact opposite of the intended change and looks like the operator's action
       *     simply did nothing;
       *   * override row written, listing not marked dirty — so the RECONCILER never picks it up
       *     either. Nothing in the system is owed the work, and it stays wrong until a human
       *     notices and presses Recalculate;
       *   * override applied, audit row missing — a rating a named human typed, with no record
       *     that they typed it. For a value published on a third party's public profile that is
       *     the one gap that cannot be reconstructed afterwards.
       *
       * The whole operation is now one transaction: lock the listing, write the override, mark it
       * dirty, and write the audit — commit or roll back together. The DIRTY MARK is what makes
       * this safe even if the refresh that follows fails, because the obligation is then durable
       * and the reconciler owns it.
       *
       * LOCK ORDER is preserved: partner_public_listings is taken FIRST and LAST here because it
       * is the only listing-side table involved, and nothing in this transaction touches
       * certificates, work items or wallets. See the lock-order note in
       * public-network-rating-lifecycle.ts.
       */
      const created = await withPartnerAdminTransaction(async (client) => {
        const l = await client.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM partner_public_listings WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!l.rows[0]) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);
        const latest = await client.query<Record<string, unknown>>(
          `SELECT internal_score, public_rating, rating_label FROM partner_public_rating_snapshots
            WHERE listing_id = $1 ORDER BY calculated_at DESC LIMIT 1`,
          [id],
        );
        const c = latest.rows[0] ?? {};
        const ins = await client.query<{ id: string }>(
          `INSERT INTO partner_public_rating_overrides
             (tenant_id, listing_id, computed_internal_score, computed_public_rating, computed_rating_label,
              override_public_rating, override_rating_label, reason, created_by, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            l.rows[0].tenant_id,
            id,
            c.internal_score ?? null,
            c.public_rating ?? null,
            c.rating_label ?? null,
            rating,
            label,
            reason,
            actor,
            expiresAt,
          ],
        );
        const overrideId = ins.rows[0].id;
        // Durable obligation, in the SAME transaction as the evidence that created it.
        await markRatingDirtyByListing(client, id);
        // Audit inside the transaction too: an override without its audit row must not exist.
        await auditAdminTx(client, id, "partner_listing_rating_override_created", actor, {
          overrideId,
          rating,
          label,
          reason,
          expiresAt,
        });
        // Test hook. Lets the forced-failure proof throw AFTER the override row and the audit have
        // been written but BEFORE commit, which is the only window that can produce the partial
        // states described above. Compiled out of any environment that does not set it.
        await maybeFailForTest("OVERRIDE_CREATE_AFTER_WRITE");
        return overrideId;
      });

      // AFTER the commit, and allowed to fail. The override is already durable, already audited and
      // already marked dirty, so a failure here costs freshness for one reconciler tick — it can no
      // longer strand the operator's decision.
      const result = await recalculateRating(id, actor);
      res.status(201).json({ overrideId: created, effective: result.effective, audited: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Retire the active override and fall back to the computed score. */
  r.delete("/:id/rating/override", async (req: Request, res: Response) => {
    try {
      const actor = adminActor(req);
      const id = String(req.params.id);
      const reason = requireReason((req.body ?? {}) as Record<string, unknown>);
      // Same atomicity argument as create, and one more specific to removal: the retirement used to
      // run as a BARE AUTOCOMMIT UPDATE with no listing lock at all, so two Super Admins removing
      // concurrently could both see rowCount > 0 against different rows, and a failure before the
      // recalculation left the override retired while the public profile kept showing its value.
      await withPartnerAdminTransaction(async (client) => {
        const l = await client.query("SELECT 1 FROM partner_public_listings WHERE id = $1 FOR UPDATE", [id]);
        if (l.rowCount === 0) throw new PublicNetworkError("LISTING_NOT_FOUND", "Listing not found.", 404);
        const upd = await client.query(
          `UPDATE partner_public_rating_overrides
              SET removed_at = now(), removed_by = $2, removal_reason = $3
            WHERE listing_id = $1 AND removed_at IS NULL`,
          [id, actor, reason],
        );
        if (upd.rowCount === 0) {
          throw new PublicNetworkError("NO_ACTIVE_OVERRIDE", "There is no active override to remove.", 404);
        }
        await markRatingDirtyByListing(client, id);
        await auditAdminTx(client, id, "partner_listing_rating_override_removed", actor, { reason });
        await maybeFailForTest("OVERRIDE_REMOVE_AFTER_WRITE");
      });

      const result = await recalculateRating(id, actor);
      res.json({ ok: true, effective: result.effective, audited: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  return r;
}

// =================================================================================================
// PARTNER SELF-SERVICE
// =================================================================================================

/**
 * The five safe fields, and the ONLY five.
 *
 * This allowlist is the second line of defence, not the first. The first is the column-level GRANT
 * in migration 0058: partner_runtime simply has no UPDATE privilege on listing_status, slug,
 * coordinates, any address column, or any rating column. That is why this handler MUST run through
 * withTenant() — routing it through the admin pool would execute as a BYPASSRLS owner and silently
 * discard the entire protection, leaving only this array standing between a partner and its own
 * rating.
 */
const SELF_SERVICE_FIELDS: Record<string, string> = {
  phone: "public_phone",
  email: "public_email",
  website: "public_website",
  openingInfo: "public_opening_info",
  description: "public_description",
};

/**
 * The allowlist above answers "may this column be written". It does NOT answer "may this VALUE be
 * published", and those are different questions with different consequences.
 *
 * Every one of these five fields is rendered to anonymous visitors. Before validation was added the
 * only content rule was `typeof v === "string" && v.length <= 500`, so
 * `{"website":"javascript:..."}` was a legitimate, audited, 200-OK edit whose value landed in a
 * public `href`. The column-level GRANT in 0058 is no defence at all here — the partner is fully
 * entitled to write this column; the danger is entirely in the value.
 *
 * See server/partner/public-network-validation.ts for the rules and why each one is shaped as it is.
 */

export function partnerNetworkSelfServeRouter(): Router {
  const r = Router();
  r.use(requirePartnerAuth);

  r.get("/public-listings", requirePartnerCapability("partner.location.view"), async (req: Request, res: Response) => {
    try {
      const principal = req.partner!;
      const rows = await withTenant({ tenantId: principal.tenantId }, async (c) => {
        const { rows } = await c.query(
          `SELECT id, slug, public_display_name, listing_status, town_city, county, postcode, country,
                  public_phone, public_email, public_website, public_opening_info, public_description,
                  verified_at, public_since,
                  current_public_rating, current_rating_label, current_rating_available,
                  current_sample_size, current_minimum_sample, current_rating_calculated_at
             FROM partner_public_listings
            WHERE tenant_id = $1
            ORDER BY created_at ASC`,
          [principal.tenantId],
        );
        return rows;
      });
      // A tenant may run several shops: 0058 enforces one listing per LOCATION, not per tenant.
      // Returning them all (rather than the oldest) is what lets the caller address the right one.
      res.json({ rows });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.put(
    "/public-listings/:id",
    // partner.users.manage, NOT partner.location.view. These fields are PUBLISHED to consumers, so
    // editing them is a write of the shop's public identity. partner.location.view is a READ
    // capability held by PARTNER_TRAINEE, PARTNER_RECEPTION and MVGS_ASSESSMENT_TECHNICIAN — gating
    // this on it let the lowest-trust credential in a shop repoint the publicly advertised phone
    // number and website. partner.users.manage is held only by OWNER and MANAGER.
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    async (req: Request, res: Response) => {
      try {
        const principal = req.partner!;
        const body = (req.body ?? {}) as Record<string, unknown>;

        // Reject an attempt to write an HQ-owned field EXPLICITLY, rather than ignoring it. Silently
        // dropping it would return 200 and leave the partner believing the change took effect.
        const forbidden = Object.keys(body).filter((k) => !(k in SELF_SERVICE_FIELDS));
        if (forbidden.length > 0) {
          throw new PublicNetworkError(
            "FIELD_NOT_EDITABLE",
            `These fields are managed by MintVault and cannot be edited here: ${forbidden.join(", ")}.`,
            403,
          );
        }

        const listingId = String(req.params.id);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listingId)) {
          throw new PublicNetworkError("INVALID_INPUT", "Invalid listing id.");
        }

        const sets: string[] = [];
        const params: unknown[] = [principal.tenantId, listingId];
        for (const [key, { column, validate }] of Object.entries(SELF_SERVICE_VALIDATORS)) {
          if (!(key in body)) continue;
          const v = body[key];
          if (v !== null && typeof v !== "string") {
            throw new PublicNetworkError("INVALID_INPUT", `The "${key}" field must be a string or null.`);
          }
          // The validator OWNS normalisation as well as rejection: it trims, collapses "" to null,
          // and for a website returns the URL parser's own serialisation. The value stored is
          // therefore exactly the value that was judged safe, with no residue of the raw input for a
          // downstream consumer to re-interpret differently.
          sets.push(`${column} = $${params.push(validate(v as string | null))}`);
        }
        if (sets.length === 0) throw new PublicNetworkError("INVALID_INPUT", "No editable fields were supplied.");

        const updated = await withTenant({ tenantId: principal.tenantId }, async (c) => {
          // SCOPED TO ONE LISTING. Without the id predicate this updated EVERY listing the tenant
          // owned, so a multi-shop partner editing one branch's phone number silently republished
          // it on all of them — invisibly, because the portal only ever showed one. tenant_id stays
          // in the predicate alongside the id: RLS already confines the row set, but an explicit
          // tenant filter means a bug in the policy cannot become a cross-tenant write.
          const upd = await c.query(
            `UPDATE partner_public_listings SET ${sets.join(", ")}, updated_at = now()
              WHERE tenant_id = $1 AND id = $2`,
            params,
          );
          if ((upd.rowCount ?? 0) === 0) {
            // RLS makes a cross-tenant write a silent no-op, so zero rows must be a failure here.
            throw new PublicNetworkError("NO_LISTING", "No such public listing for this partner.", 404);
          }
          await writePartnerAudit(c, {
            tenantId: principal.tenantId,
            actorUserId: principal.userId,
            sessionId: principal.sessionId,
            action: "partner_public_listing_contact_updated",
            recordType: "partner_public_listing",
            recordId: listingId,
            after: Object.fromEntries(Object.keys(body).map((k) => [k, body[k]])),
          });
          return upd.rowCount;
        });

        res.json({ ok: true, updated });
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  return r;
}

export function registerPartnerNetworkPublicRoutes(app: Express): void {
  app.use(PARTNER_NETWORK_PUBLIC_BASE, partnerNetworkPublicRouter());
}

export function registerPartnerNetworkAdminRoutes(app: Express): void {
  app.use(PARTNER_NETWORK_ADMIN_BASE, partnerNetworkAdminRouter());
}
