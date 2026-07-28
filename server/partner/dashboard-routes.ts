/**
 * Super Admin Partner Master Dashboard — HTTP surface.
 *
 * Thin router. Authenticate, validate, delegate to dashboard-service, return the standard
 * envelope. No business logic here, and NO mutations anywhere in this file — the dashboard is
 * an observation surface only.
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
import { Router, type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../auth";
import { storage } from "../storage";
import * as svc from "./dashboard-service";
import { DashboardError } from "./dashboard-service";
import { isDashboardPartnerStatus, isPartnerSortKey, isSortDirection } from "@shared/partner-dashboard";

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
  keyGenerator: (req) => {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
    return req.ip || req.socket.remoteAddress || "unknown";
  },
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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Express 5 types a path param as `string | string[]` (a repeated param arrives as an array).
 * Collapse to a single string here; `requirePartnerId` then UUID-validates it, so an array or
 * any other shape is rejected with a clean 400 rather than reaching the driver.
 */
function paramId(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function partnerDashboardRouter(): Router {
  const r = Router();

  // Order matters: authenticate first, then throttle, so an unauthenticated flood is
  // rejected by the cheapest check and never consumes a real admin's rate budget.
  r.use(requireSuperAdmin);
  r.use(dashboardReadRateLimit);

  // ---- A. Network overview ----
  r.get("/summary", async (req: Request, res: Response) => {
    try {
      const summary = await svc.getNetworkSummary();
      await auditRead(req, "dashboard_summary_viewed", "network", { shops: summary.shops.total });
      res.json({ summary });
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- B. Partner table ----
  r.get("/partners", async (req: Request, res: Response) => {
    try {
      const statusRaw = str(req.query.status);
      const sortRaw = str(req.query.sort);
      const dirRaw = str(req.query.direction);
      const riskRaw = str(req.query.risk);

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
      if (riskRaw && !["none", "low", "medium", "high"].includes(riskRaw)) {
        throw new DashboardError("INVALID_INPUT", "Unknown risk filter.");
      }

      const result = await svc.listPartnersForDashboard(
        {
          search: str(req.query.search),
          status: statusRaw,
          risk: riskRaw,
          sort: sortRaw as never,
          direction: dirRaw as never,
        },
        req.query.page,
        req.query.pageSize
      );
      await auditRead(req, "dashboard_partners_listed", "network", {
        returned: result.rows.length,
        total: result.total,
        filters: { status: statusRaw ?? null, risk: riskRaw ?? null, searched: Boolean(str(req.query.search)) },
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- I. Alerts ----
  r.get("/alerts", async (req: Request, res: Response) => {
    try {
      const alerts = await svc.getAlerts(req.query.limit);
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
  section(
    "/partners/:partnerId/staff",
    "dashboard_partner_staff_viewed",
    async (id) => ({ staff: await svc.getPartnerStaff(id) }),
    (r2) => (r2 as { staff: unknown[] }).staff.length
  );
  section(
    "/partners/:partnerId/wallet",
    "dashboard_partner_wallet_viewed",
    (id) => svc.getPartnerWallet(id),
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
      const result = await svc.getPartnerAuditTimeline(partnerId, req.query.page, req.query.pageSize);
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
