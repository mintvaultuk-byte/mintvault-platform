/**
 * Super Admin GLOBAL partner feature-flag administration (WP-1).
 *
 * WHY THIS EXISTS: `partner_feature_flags` resolves most-specific-first — location, then tenant,
 * then GLOBAL (tenant_id IS NULL AND location_id IS NULL). The portal-wide kill switches read the
 * GLOBAL row only (`resolveGlobalFlag`), but the sole write endpoint that existed
 * (`POST /api/super-admin/grading-partners/:partnerId/flags`) always writes a TENANT-scoped row.
 * There was therefore no API in the product that could turn the platform on or off: enabling the
 * portal required hand-written SQL against the partner database.
 *
 * SECURITY POSTURE (mirrors server/partner/dashboard-routes.ts, deliberately stricter than the
 * older `requireAdmin`-gated partner routers):
 *
 *  1. `requireSuperAdmin`, not `requireAdmin`. These flags gate the entire partner platform for
 *     every tenant at once, so they use the strongest tier available. It is also immune to the
 *     `__graderProxy` early-return inside `requireAdmin`, which leaves `session.adminEmail`
 *     undefined and is rejected with 403 by the super-admin closure.
 *
 *  2. Its own rate limiter. `/api/super-admin/*` sits OUTSIDE the `/api/admin` prefix, so it
 *     inherits neither `adminIpAllowlist` nor `adminRateLimit`.
 *
 *  3. Only the canonical flag names in server/partner/flags.ts are accepted; anything else is a
 *     400, so a typo can never silently create an inert row that looks like a control.
 *
 *  4. Every WRITE requires a reason and is audited with the acting super-admin, the previous
 *     value and the new value. Reads are not audited — unlike the dashboard these return nine
 *     booleans, not cross-tenant records.
 *
 *  5. Writes are idempotent: delete-then-insert inside ONE transaction leaves exactly one global
 *     row per flag, so resolution can never return a stale prior value and disabling always takes
 *     (the same H2 correction already applied to the tenant-scoped writer).
 *
 * Known inherited limitation: the express-rate-limit default store is in-process, therefore
 * per-Fly-machine — the same accepted trade-off the G4/G5/dashboard routers document.
 */
import { Router, type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../auth";
import { storage } from "../storage";
import { partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import { getPartnerAdminCapability } from "./admin-capability";
import { PARTNER_FLAGS, resolveGlobalFlag, type PartnerFlag } from "./flags";

export const PARTNER_GLOBAL_FLAGS_BASE = "/api/super-admin/partner-flags";

/** Longest accepted reason. Long enough for a real change note, bounded so it cannot be a payload. */
const MAX_REASON_LEN = 500;

/**
 * Write ceiling. Flag changes are rare, deliberate operator actions; reads are cheap but sit on the
 * same router. Generous for real use, low enough that a scripted flip-flood is throttled.
 */
const flagAdminRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many partner flag requests, please slow down." } },
  // `req.ip` — NOT a hand-parsed `X-Forwarded-For`. The app sets `trust proxy = 1`
  // (server/index.ts), so Express resolves req.ip one hop in front of Fly's proxy; reading the raw
  // header would let any caller mint a fresh bucket per request. See dashboard-routes.ts.
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
});

/**
 * Preflight, identical to the one the sibling super-admin partner router uses. The privileged admin
 * role must be able to see through RLS on the partner tables; without BYPASSRLS every statement here
 * silently addresses zero rows, and a flag write would report success having changed nothing. A 503
 * with an explicit code tells the operator this is a deployment problem, not an opaque 500.
 */
async function requirePartnerAdminCapability(_req: Request, res: Response, next: () => void): Promise<void> {
  const capability = await getPartnerAdminCapability();
  if (!capability.ok) {
    res.status(503).json({
      error: "Partner Super Admin management is not ready.",
      code: "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE",
    });
    return;
  }
  next();
}

function isPartnerFlag(value: unknown): value is PartnerFlag {
  return typeof value === "string" && (PARTNER_FLAGS as readonly string[]).includes(value);
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { code: "INVALID_INPUT", message } });
}

function sendError(res: Response, err: unknown): void {
  // Never leak internals. Log the message + code only, not the whole pg error object
  // (its `detail` field can contain row values).
  const e = err as { message?: string; code?: string };
  console.error("[partner-flags] request failed:", e?.code ?? "", e?.message ?? String(err));
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
}

interface GlobalFlagRow {
  flag: string;
  enabled: boolean;
  updated_at: string | null;
}

/** Read every GLOBAL flag row in one query, keyed by flag name. */
async function readGlobalFlags(): Promise<Map<string, GlobalFlagRow>> {
  const { rows } = await partnerAdminQuery<GlobalFlagRow>(
    `SELECT DISTINCT ON (flag) flag, enabled, updated_at
       FROM partner_feature_flags
      WHERE tenant_id IS NULL AND location_id IS NULL
      ORDER BY flag, updated_at DESC, id DESC`
  );
  return new Map(rows.map((r) => [r.flag, r]));
}

export function partnerFlagAdminRouter(): Router {
  const r = Router();

  // Order matters. The IP-keyed limiter runs FIRST: `requireSuperAdmin` performs a database-backed
  // admin lookup, so throttling after it would let an unauthenticated flood drive one DB round trip
  // per request before being rejected. Limiting on the cheap in-process check first is what keeps
  // that flood off the database. The capability preflight runs last of the three — it costs a
  // catalogue query (memoised), so it must sit behind both the rate gate and the auth gate.
  r.use(flagAdminRateLimit);
  r.use(requireSuperAdmin);
  r.use(requirePartnerAdminCapability);

  /**
   * Current GLOBAL state of every canonical flag. Always returns all nine, including the ones with
   * no row: absent means the resolver reads OFF, and an operator must see "off" rather than a gap.
   */
  r.get("/", async (_req: Request, res: Response) => {
    try {
      const present = await readGlobalFlags();
      res.json({
        flags: PARTNER_FLAGS.map((flag) => {
          const row = present.get(flag);
          return {
            flag,
            enabled: row?.enabled === true,
            configured: row !== undefined, // false = no global row at all (resolves OFF, fail closed)
            updatedAt: row?.updated_at ?? null,
          };
        }),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * Set ONE global flag. Idempotent: repeating the same call leaves the same single row and the
   * same effective value (it re-audits, which is correct — each operator action is evidence).
   */
  r.put("/:flag", async (req: Request, res: Response) => {
    try {
      const flag = req.params.flag;
      if (!isPartnerFlag(flag)) {
        badRequest(res, "Unknown flag.");
        return;
      }
      const { enabled, reason } = (req.body ?? {}) as { enabled?: unknown; reason?: unknown };
      if (typeof enabled !== "boolean") {
        badRequest(res, 'The "enabled" field must be true or false.');
        return;
      }
      if (typeof reason !== "string" || reason.trim() === "") {
        badRequest(res, "A reason is required for every partner flag change.");
        return;
      }
      const trimmedReason = reason.trim();
      if (trimmedReason.length > MAX_REASON_LEN) {
        badRequest(res, `A reason must be ${MAX_REASON_LEN} characters or fewer.`);
        return;
      }

      const previous = (await readGlobalFlags()).get(flag);

      // One transaction: delete every existing global row for this flag, then insert exactly one.
      // Without the delete a second write would leave two rows and resolution would depend on
      // updated_at ordering — the H2 defect already corrected on the tenant-scoped writer.
      await withPartnerAdminTransaction(async (client) => {
        await client.query(
          "DELETE FROM partner_feature_flags WHERE flag=$1 AND tenant_id IS NULL AND location_id IS NULL",
          [flag]
        );
        await client.query(
          "INSERT INTO partner_feature_flags (tenant_id, location_id, flag, enabled) VALUES (NULL, NULL, $1, $2)",
          [flag, enabled]
        );
      });

      // SPLIT-BRAIN DETECTION. This router writes through the PRIVILEGED admin pool
      // (PARTNER_ADMIN_DATABASE_URL); every portal gate READS through the restricted runtime pool
      // (PARTNER_DATABASE_URL) via resolveGlobalFlag. Those are two separate URLs, and nothing
      // guarantees they address the same database. If they diverge, an operator hitting the
      // emergency "turn the portal off" control would get a confident 200 while the live gates went
      // on reading the old value — the portal would stay open through the whole incident.
      //
      // So the write is verified through the READ PATH THE GATES ACTUALLY USE before it is reported
      // as successful. Disagreement is a 409, not a 200: the operator learns immediately that the
      // control is not connected to the surface it claims to control.
      const effective = await resolveGlobalFlag(flag);
      if (effective !== enabled) {
        console.error(
          `[partner-flags] SPLIT BRAIN: wrote ${flag}=${enabled} via the admin pool but the runtime pool reads ${effective}. ` +
            "PARTNER_ADMIN_DATABASE_URL and PARTNER_DATABASE_URL are not addressing the same database."
        );
        res.status(409).json({
          error: {
            code: "PARTNER_FLAG_NOT_EFFECTIVE",
            message:
              "The flag was written but the partner runtime still reads the previous value. The admin and runtime databases are not in sync — do not rely on this control until that is resolved.",
          },
          flag,
          written: enabled,
          effective,
        });
        return;
      }

      // Audit AFTER the write commits, so the ledger never claims a change that rolled back.
      // partner_audit_events and partner_management_audit both require a NOT NULL tenant_id and a
      // global flag has no tenant, so this uses the MintVault audit log — the same path the partner
      // dashboard router uses for its own non-tenant-scoped evidence.
      const actor = req.session.adminEmail ?? "unknown-admin";
      let audited = true;
      try {
        await storage.writeAuditLog(
          "partner_feature_flag",
          flag,
          enabled ? "partner_global_flag_enabled" : "partner_global_flag_disabled",
          actor,
          {
            flag,
            scope: "global",
            enabled,
            previousEnabled: previous?.enabled ?? null,
            previouslyConfigured: previous !== undefined,
            reason: trimmedReason,
            requestId: String(req.headers["x-request-id"] ?? ""),
          }
        );
      } catch (auditErr) {
        // The flag change has already COMMITTED. Reporting 500 here would tell the operator the
        // change did not apply, which is worse than reporting it applied unaudited — so the failure
        // is logged loudly and surfaced in the response instead of being swallowed or misreported.
        audited = false;
        console.error(
          "[partner-flags] AUDIT WRITE FAILED for a committed flag change:",
          flag,
          enabled,
          (auditErr as { message?: string })?.message ?? auditErr
        );
      }

      // `effective` is the value the live gates now read, not merely the value we asked for.
      res.json({ flag, enabled, scope: "global", effective, audited });
    } catch (err) {
      sendError(res, err);
    }
  });

  return r;
}

/** Additive registration into the existing MintVault admin app. */
export function registerPartnerFlagAdminRoutes(app: Express): void {
  app.use(PARTNER_GLOBAL_FLAGS_BASE, partnerFlagAdminRouter());
}
