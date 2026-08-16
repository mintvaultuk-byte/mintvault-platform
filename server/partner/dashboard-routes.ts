/**
 * Super Admin Partner Master Dashboard — HTTP surface.
 *
 * Thin router. Authenticate, validate, delegate to dashboard-service, return the standard
 * envelope. The one mutation is an explicit Super Admin credit adjustment delegated to the
 * append-only wallet service; every other dashboard endpoint remains an observation surface.
 *
 * SECURITY POSTURE (deliberately stricter than the three older partner routers):
 *
 *  1. `requireSuperAdmin`, not `requireAdmin`. This is the widest cross-tenant read in the
 *     application, so it uses the strongest tier available. It is also immune to the
 *     `__graderProxy` early-return inside `requireAdmin`: that path leaves `session.adminEmail`
 *     undefined, so the super-admin closure rejects it with 403.
 *
 *  2. A READ rate limiter. `/api/super-admin/*` sits OUTSIDE the `/api/admin` prefix, so it
 *     inherits neither `adminIpAllowlist` nor `adminRateLimit` — and `adminRateLimit` exempts
 *     authenticated admins anyway. These aggregate endpoints are expensive, so they carry their
 *     own ceiling rather than inheriting nothing.
 *
 *  3. Every id path param is UUID-validated BEFORE it reaches Postgres (a malformed id would
 *     otherwise raise 22P02 and surface as an opaque 500 with a full pg error in the logs).
 *
 *  4. Sensitive cross-tenant READS are audited. On this surface the read IS the sensitive
 *     action, so each request appends one audit row recording actor, scope and ROW COUNT —
 *     never the rows themselves.
 *
 *  5. Sorting is allowlist-mapped to literal SQL. Pagination is bounded on both axes.
 *
 * Known inherited limitation: the express-rate-limit default store is in-process, therefore
 * per-Fly-machine — the same accepted trade-off the G4/G5 routers document.
 */
import { Router, type Express, type Request, type Response, type NextFunction } from "express";
import { requireAdminStepUp } from "../lib/admin-step-up";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../auth";
import { storage } from "../storage";
import * as svc from "./dashboard-service";
import { DashboardError } from "./dashboard-service";
import { getPartnerReadVisibility, type PartnerReadVisibility } from "./dashboard-visibility";
import { isDashboardPartnerStatus, isPartnerSortKey, isRiskLevel, isSortDirection } from "@shared/partner-dashboard";
import { addCredits, removeCredits } from "./partner-credit-admin-service";
import { WalletRequestError } from "./partner-wallet-errors";

export const PARTNER_DASHBOARD_BASE = "/api/super-admin/partner-dashboard";

/**
 * Read ceiling. Generous enough for real dashboard use (auto-refresh + drill-down clicks),
 * low enough that a scripted cross-tenant scrape is throttled.
 */
const dashboardReadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many dashboard requests, please slow down." } },
  /**
   * `req.ip` — NOT a hand-parsed `X-Forwarded-For`.
   *
   * The app sets `trust proxy = 1` (server/index.ts), so Express already resolves `req.ip` to
   * the client address one hop in front of Fly's proxy. Reading the raw header instead meant
   * any caller could rotate the header and mint a fresh rate-limit bucket per request. Trusting
   * exactly one hop also avoids the opposite failure — collapsing every client onto the proxy's
   * own IP, which would let one noisy operator throttle all of them.
   */
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
});

function statusFor(code: string): number {
  switch (code) {
    case "PARTNER_NOT_FOUND":
      return 404;
    case "INVALID_INPUT":
      return 400;
    default:
      return 500;
  }
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof WalletRequestError) {
    const status =
      err.code === "WALLET_NOT_FOUND"
        ? 404
        : err.code === "IDEMPOTENCY_CONFLICT" || err.code === "INSUFFICIENT_AVAILABLE_CREDITS"
          ? 409
          : err.code === "INTERNAL_ERROR"
            ? 500
            : 400;
    res.status(status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof DashboardError) {
    res.status(statusFor(err.code)).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // Never leak internals. Log the message + code only, not the whole pg error object
  // (its `detail` field can contain row values, i.e. PII).
  const e = err as { message?: string; code?: string };
  console.error("[partner-dashboard] request failed:", e?.code ?? "", e?.message ?? String(err));
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
}

/**
 * Append one audit row per sensitive cross-tenant read: who looked, at what scope, and how
 * many rows came back. Never the row contents. Wrapped so an audit failure is logged but does
 * not break the read (the established pattern in catalogueService).
 */
async function auditRead(
  req: Request,
  action: string,
  entityId: string,
  details: Record<string, unknown>
): Promise<void> {
  try {
    const actor = req.session.adminEmail ?? "unknown-admin";
    await storage.writeAuditLog("partner_dashboard", entityId, action, actor, {
      ...details,
      requestId: String(req.headers["x-request-id"] ?? ""),
    });
  } catch (err) {
    console.error("[partner-dashboard] audit write failed:", (err as { message?: string })?.message ?? err);
  }
}

/**
 * Read a SCALAR query parameter.
 *
 * Express parses a repeated parameter (`?status=ACTIVE&status=PENDING`) into an ARRAY. Returning
 * `undefined` for that shape silently DROPPED the filter and widened the result set — on a
 * cross-tenant surface, showing more partners than were asked for is a disclosure, not a
 * cosmetic bug, and it is exactly what the explicit unknown-value rejection below exists to
 * prevent. So a repeated scalar parameter is a 400, never a silent first/last pick.
 */
function scalar(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    throw new DashboardError("INVALID_INPUT", `The "${name}" parameter must be supplied at most once.`);
  }
  if (typeof v !== "string") {
    throw new DashboardError("INVALID_INPUT", `The "${name}" parameter must be a single value.`);
  }
  return v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Express 5 types a path param as `string | string[]` (a repeated param arrives as an array).
 * Collapse to a single string here; `requirePartnerId` then UUID-validates it, so an array or
 * any other shape is rejected with a clean 400 rather than reaching the driver.
 */
function paramId(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Fail-closed visibility gate (applies to EVERY endpoint on this router).
 *
 * See dashboard-visibility.ts: if the configured admin role cannot read the FORCE-RLS partner
 * tables, every query below returns zero rows, and aggregates would render that as a confident
 * "0 shops / 0 credits / no alerts". One gate in front of all handlers is what guarantees the
 * dashboard cannot show some sections as zeros while others report unavailable.
 *
 * 503, not 500: the request was well-formed and authorised; the dependency is misconfigured.
 */
async function requirePartnerReadVisibility(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const visibility = await getPartnerReadVisibility();
    if (!visibility.ok) {
      // Deliberately no role name, connection string or catalogue detail — the operator is told
      // WHAT is wrong and that it is a deployment issue, not the database's internals.
      res.status(503).json({ error: { code: visibility.code, message: visibility.message } });
      return;
    }
    (req as Request & { partnerVisibility?: PartnerReadVisibility }).partnerVisibility = visibility;
    next();
  } catch (err) {
    sendError(res, err);
  }
}

/** Wallet relations present AND readable by this role. */
function walletSchemaOf(req: Request): boolean {
  const v = (req as Request & { partnerVisibility?: PartnerReadVisibility }).partnerVisibility;
  return v?.ok === true ? v.walletSchema : false;
}

export function partnerDashboardRouter(): Router {
  const r = Router();

  // Order matters: authenticate first, then throttle, so an unauthenticated flood is
  // rejected by the cheapest check and never consumes a real admin's rate budget. The
  // visibility probe runs last of the three — it costs a catalogue query (memoised), so it
  // must sit behind both the auth and the rate gate.
  r.use(requireSuperAdmin);
  r.use(dashboardReadRateLimit);
  r.use(requirePartnerReadVisibility);

  // ---- A. Network overview ----
  r.get("/summary", async (req: Request, res: Response) => {
    try {
      const summary = await svc.getNetworkSummary(walletSchemaOf(req));
      await auditRead(req, "dashboard_summary_viewed", "network", { shops: summary.shops.total });
      res.json({ summary });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- B. Partner table ----
  r.get("/partners", async (req: Request, res: Response) => {
    try {
      const statusRaw = scalar(req.query.status, "status");
      const sortRaw = scalar(req.query.sort, "sort");
      const dirRaw = scalar(req.query.direction, "direction");
      const riskRaw = scalar(req.query.risk, "risk");
      const searchRaw = scalar(req.query.search, "search");
      const pageRaw = scalar(req.query.page, "page");
      const pageSizeRaw = scalar(req.query.pageSize, "pageSize");

      // Reject rather than silently ignore an unknown filter/sort — a silently-dropped
      // filter shows the operator more partners than they asked for, which on a
      // cross-tenant surface is a disclosure, not a cosmetic bug.
      if (statusRaw && !isDashboardPartnerStatus(statusRaw)) {
        throw new DashboardError("INVALID_INPUT", "Unknown status filter.");
      }
      if (sortRaw && !isPartnerSortKey(sortRaw)) {
        throw new DashboardError("INVALID_INPUT", "Unknown sort key.");
      }
      if (dirRaw && !isSortDirection(dirRaw)) {
        throw new DashboardError("INVALID_INPUT", "Unknown sort direction.");
      }
      if (riskRaw && !isRiskLevel(riskRaw)) {
        throw new DashboardError("INVALID_INPUT", "Unknown risk filter.");
      }

      const result = await svc.listPartnersForDashboard(
        {
          search: searchRaw,
          status: statusRaw,
          risk: riskRaw,
          sort: sortRaw as never,
          direction: dirRaw as never,
        },
        pageRaw,
        pageSizeRaw,
        walletSchemaOf(req)
      );
      await auditRead(req, "dashboard_partners_listed", "network", {
        returned: result.rows.length,
        total: result.total,
        filters: { status: statusRaw ?? null, risk: riskRaw ?? null, searched: Boolean(searchRaw) },
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- I. Alerts ----
  r.get("/alerts", async (req: Request, res: Response) => {
    try {
      const alerts = await svc.getAlerts(scalar(req.query.limit, "limit"), walletSchemaOf(req));
      await auditRead(req, "dashboard_alerts_viewed", "network", { returned: alerts.length });
      res.json({ alerts });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- C. Drill-down sections ----
  // Each validates its id and 404s an unknown partner before touching anything else.
  const section = (
    path: string,
    action: string,
    handler: (partnerId: string, req: Request) => Promise<unknown>,
    count: (result: unknown) => number
  ) => {
    r.get(path, async (req: Request, res: Response) => {
      try {
        const partnerId = paramId(req.params.partnerId);
        const result = await handler(partnerId, req);
        await auditRead(req, action, partnerId, { returned: count(result) });
        res.json(result);
      } catch (err) {
        sendError(res, err);
      }
    });
  };

  section(
    "/partners/:partnerId/overview",
    "dashboard_partner_overview_viewed",
    (id) => svc.getPartnerOverview(id),
    () => 1
  );

  // AG-3b: granting or removing Grading Credits moves money-equivalent capacity into a shop's
  // wallet. It is audited and idempotent, but auditing tells you afterwards WHO the session
  // belonged to — not that they were still at the keyboard.
  r.post("/partners/:partnerId/credits/adjust", requireAdminStepUp(), async (req: Request, res: Response) => {
    try {
      const tenantId = paramId(req.params.partnerId);
      const operation = req.body?.operation;
      if (operation !== "add" && operation !== "remove") {
        throw new WalletRequestError("VALIDATION_ERROR", "operation must be add or remove.");
      }
      const actorEmail = req.session.adminEmail;
      const actorUserId = req.session.authUserId;
      if (!actorEmail || !actorUserId) {
        throw new WalletRequestError("ACTOR_REQUIRED", "A verified Super Admin actor is required.");
      }
      const input = {
        tenantId,
        quantity: req.body?.quantity,
        reason: req.body?.reason,
        idempotencyKey: req.body?.idempotencyKey,
      };
      const result = await (operation === "add"
        ? addCredits({ actorUserId, actorEmail }, input)
        : removeCredits({ actorUserId, actorEmail }, input));
      // The immutable credit-ledger row is the authoritative financial audit evidence and already
      // contains actor, operation, quantity and reason. Mirror it into the general operator audit
      // log when available, but never turn a committed adjustment into a misleading 500 response.
      try {
        await storage.writeAuditLog(
          "partner_credit",
          result.entry.id,
          operation === "add" ? "partner_credit_added" : "partner_credit_removed",
          actorEmail,
          {
            tenantId,
            quantity: req.body.quantity,
            reason: req.body.reason,
            alreadyApplied: result.alreadyApplied,
            requestId: String(req.headers["x-request-id"] ?? ""),
          }
        );
      } catch (auditError) {
        console.error("[partner-credit] secondary audit mirror failed:", (auditError as Error).message);
      }
      res.status(result.alreadyApplied ? 200 : 201).json({ result });
    } catch (err) {
      sendError(res, err);
    }
  });
  section(
    "/partners/:partnerId/staff",
    "dashboard_partner_staff_viewed",
    async (id) => ({ staff: await svc.getPartnerStaff(id) }),
    (r2) => (r2 as { staff: unknown[] }).staff.length
  );
  section(
    "/partners/:partnerId/wallet",
    "dashboard_partner_wallet_viewed",
    (id, req) => svc.getPartnerWallet(id, walletSchemaOf(req)),
    () => 1
  );
  section(
    "/partners/:partnerId/submissions",
    "dashboard_partner_submissions_viewed",
    (id) => svc.getPartnerSubmissions(id),
    (r2) => (r2 as { recent: unknown[] }).recent.length
  );
  section(
    "/partners/:partnerId/quality",
    "dashboard_partner_quality_viewed",
    (id) => svc.getPartnerQuality(id),
    () => 0
  );
  section(
    "/partners/:partnerId/devices",
    "dashboard_partner_devices_viewed",
    (id) => svc.getPartnerDevices(id),
    (r2) => (r2 as { recentSessions: unknown[] }).recentSessions.length
  );
  section(
    "/partners/:partnerId/corrections",
    "dashboard_partner_corrections_viewed",
    (id) => svc.getPartnerCorrections(id),
    (r2) => (r2 as { escalations: unknown[] }).escalations.length
  );
  section(
    "/partners/:partnerId/security",
    "dashboard_partner_security_viewed",
    (id) => svc.getPartnerSecurity(id),
    (r2) => (r2 as { events: unknown[] }).events.length
  );

  r.get("/partners/:partnerId/audit", async (req: Request, res: Response) => {
    try {
      const partnerId = paramId(req.params.partnerId);
      const result = await svc.getPartnerAuditTimeline(
        partnerId,
        scalar(req.query.page, "page"),
        scalar(req.query.pageSize, "pageSize")
      );
      await auditRead(req, "dashboard_partner_audit_viewed", partnerId, {
        returned: result.rows.length,
        total: result.total,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  return r;
}

export function registerPartnerDashboardRoutes(app: Express): void {
  app.use(PARTNER_DASHBOARD_BASE, partnerDashboardRouter());
}
