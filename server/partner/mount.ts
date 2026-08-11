/**
 * Partner Portal — runtime mount (WP-1).
 *
 * The authenticated partner surface used to exist ONLY inside `createPartnerApp()` (server/partner/
 * app.ts), a separate Express app with no production caller: the deployed server mounted the four
 * public routes and nothing else. Every authenticated route — session, submissions, customers, team,
 * MFA — was therefore unreachable in production, and `partner_portal_enabled` gated nothing that ran.
 *
 * This module extracts that wiring into ONE composable mount so the SAME gates and the SAME routers
 * serve both the main application (server/routes.ts) and the standalone factory the existing test
 * suites drive. There is deliberately no second copy of the gate order to drift.
 *
 * Gate order (all fail closed, all scoped to /api/partner):
 *   1. partner runtime DB configured AND the PARTNER_* env set is coherent
 *   2. SECURITY DEFINER ownership model intact (DB-F1)
 *   3. partner_emergency_stop is OFF
 *   4. partner_portal_enabled is ON
 *
 * The placeholder `/partner` HTML shell is NOT part of this mount: in the main application the
 * React SPA serves /partner/*, and a dataless placeholder registered here would shadow it. The
 * standalone factory keeps registering its own shell for its own tests.
 */
import { Router, type Express, type Request, type Response, type NextFunction } from "express";
import { partnerSessionMiddleware } from "./session";
import { partnerApiRouter } from "./routes";
import { partnerSubmissionRouter } from "./submission-routes";
import { partnerCustomerRouter } from "./customer-routes";
import { partnerCatalogueRouter } from "./catalogue-routes";
import { partnerGradingRouter } from "./grading-routes";
import { partnerStationRouter } from "./station-routes";
import { partnerDbConfigured, partnerRuntimeQuery } from "./db";
import { resolveGlobalFlag } from "./flags";
import { definerModelViolations } from "./definer-guard";
import { partnerPortalEnvStatus } from "../config";

/** The single path prefix the authenticated partner surface is served from. */
export const PARTNER_PORTAL_BASE = "/api/partner";

/** One body for every closed gate — the caller never learns WHICH gate closed. */
function unavailable(res: Response): void {
  res.status(503).json({ error: "partner portal unavailable" });
}

// Definer-model health for the /api/partner surface. We cache ONLY a confirmed-healthy result for
// the process lifetime (the model can't change without a migration + redeploy). A broken or
// transient-error result is NOT cached — it fails closed (503) and is re-checked on the next
// request, so a one-off blip never permanently bricks the surface (SEC-3).
let definerHealthy = false;

async function checkDefinerModelOnce(): Promise<boolean> {
  if (definerHealthy) return true;
  try {
    const violations = await definerModelViolations((sql, params) => partnerRuntimeQuery(sql, params));
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error("[partner] definer ownership model broken (DB-F1):", violations.join("; "));
      return false; // fail closed; do not cache — re-check next request
    }
    definerHealthy = true;
    return true;
  } catch {
    return false; // fail closed on any inspection error; do not cache
  }
}

/** Test-only: reset the cached definer-model health (so a test can re-evaluate after changes). */
export function __resetDefinerHealthForTests(): void {
  definerHealthy = false;
}

/**
 * Gate 1 — the runtime must have its own restricted DB URL, and the PARTNER_* env set must be
 * coherent. Evaluated per request rather than memoised at registration so a test (or an operator
 * hot-fixing a secret) sees the current value, and because it costs no I/O.
 *
 * A missing PARTNER_DATABASE_URL is the documented "portal not configured" state: 503, never a
 * crash of the main server. An INCOHERENT set (runtime URL present, MFA key absent) is a
 * misconfiguration an operator must see, so it is logged once per process in addition to closing
 * the surface — MFA enrolment/verification would otherwise throw per request deep inside the
 * handlers and surface as opaque 500s.
 */
let loggedEnvProblem = false;
function requirePartnerRuntimeConfig(_req: Request, res: Response, next: NextFunction): void {
  if (!partnerDbConfigured()) {
    unavailable(res);
    return;
  }
  // ACCEPTED BEHAVIOUR: an incoherent PARTNER_* set closes the partner surface and logs once — it
  // never throws, because a validator that threw at startup would crash a live deploy where
  // PARTNER_MFA_ENC_KEY has not been set yet, taking the whole application down with it.
  const env = partnerPortalEnvStatus();
  if (!env.coherent) {
    if (!loggedEnvProblem) {
      loggedEnvProblem = true;
      // eslint-disable-next-line no-console
      console.error(`[partner] portal disabled — incoherent configuration: ${env.problem}`);
    }
    unavailable(res);
    return;
  }
  next();
}

/** Gate 2 — DB-F1: a broken SECURITY DEFINER ownership model closes the whole surface. */
async function requireDefinerModel(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!(await checkDefinerModelOnce())) {
      unavailable(res);
      return;
    }
    next();
  } catch {
    unavailable(res); // fail closed
  }
}

/** Gate 3 — the global emergency stop overrides everything below it. */
async function requireNoEmergencyStop(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await resolveGlobalFlag("partner_emergency_stop")) {
      unavailable(res);
      return;
    }
    next();
  } catch {
    unavailable(res); // fail closed
  }
}

/** Gate 4 — the master switch. Absent row = OFF = 503 (fail closed). */
async function requirePortalEnabled(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!(await resolveGlobalFlag("partner_portal_enabled"))) {
      unavailable(res);
      return;
    }
    next();
  } catch {
    unavailable(res); // fail closed
  }
}

/**
 * The authenticated partner surface as a single mountable router: four fail-closed gates, then the
 * session middleware, then the three route families. Nothing admin, staff, grader, scanner, Vault
 * Quest or certificate-CRUD is reachable through it (asserted by FORBIDDEN_PARTNER_PATHS).
 */
export function partnerPortalRouter(): Router {
  const r = Router();

  r.use(requirePartnerRuntimeConfig);
  r.use(requireDefinerModel);
  r.use(requireNoEmergencyStop);
  r.use(requirePortalEnabled);

  r.use(partnerSessionMiddleware);
  r.use(partnerApiRouter());
  r.use(partnerCatalogueRouter()); // read-only HQ catalogue snapshot
  r.use(partnerGradingRouter()); // partner-scoped MVGS grading adapter
  r.use(partnerStationRouter()); // approved-station enrolment, health and calibration
  r.use(partnerSubmissionRouter()); // Phase 2 submission workflow
  r.use(partnerCustomerRouter()); // Phase 2 customer records

  return r;
}

/**
 * Mount the authenticated partner portal into an Express application at /api/partner.
 *
 * In the main application this MUST be called after `registerPartnerPublicRoutes(app)`: the public
 * router owns /auth/login, /auth/password-reset/* and /invitations/accept, and anything it does not
 * match falls through to the gates here.
 */
export function mountPartnerPortal(app: Express): void {
  app.use(PARTNER_PORTAL_BASE, partnerPortalRouter());
}
