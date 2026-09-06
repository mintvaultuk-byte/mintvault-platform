/**
 * Partner Portal — isolated application factory (Phase 1).
 *
 * A SEPARATE Express app: its own composition, its own session middleware + cookie, its own API
 * namespace (/api/partner), its own error handling. It deliberately mounts NONE of:
 *   /api/admin, staff routes, numeric certificate CRUD, scanner shared-token routes, Vault Quest,
 *   or unrelated customer-account routes. It never uses requireAdmin. The runtime connects only as
 *   the restricted partner_runtime role (server/partner/db.ts) — never the privileged MintVault
 *   connection. Feature flag `partner_portal_enabled` gates the whole surface (fail closed).
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { partnerDbConfigured, partnerRuntimeQuery } from "./db";
import { assertDefinerModel } from "./definer-guard";
import { mountPartnerPortal } from "./mount";
import { registerPartnerPublicRoutes } from "./public-routes";
import { requestBodyMemoryAdmission } from "../lib/upload-memory-admission";

export { __resetDefinerHealthForTests } from "./mount";

/**
 * DB-F1 capability check, for a supervisor to call at boot: throws if the definer ownership model
 * (migration 0006) is not intact, so it can refuse to bring the partner runtime up.
 * NOTE: the live, always-on enforcement is the memoized fail-closed gate inside
 * `mountPartnerPortal` (a broken model 503s the whole /api/partner surface), so protection does not
 * depend on anyone remembering to call this. Reads catalogs via the restricted runtime role only.
 */
export async function assertPartnerDbCapability(): Promise<void> {
  await assertDefinerModel((sql, params) => partnerRuntimeQuery(sql, params));
}

/**
 * The standalone factory now COMPOSES `mountPartnerPortal` rather than duplicating its wiring, so
 * the gates the existing suites exercise here are literally the gates the main application runs.
 * The only surface unique to this factory is the placeholder /partner shell below — in the main
 * application the React SPA owns /partner/*, so the mount deliberately does not register it.
 */
export function createPartnerApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestBodyMemoryAdmission);
  app.use(express.json({ limit: "1mb" }));

  // fail closed if the restricted runtime DB isn't configured (never fall back to privileged conn).
  // App-wide here, not just /api/partner, because this factory serves nothing else worth serving
  // without it — the mount re-applies the same check scoped to its own prefix.
  app.use((_req, res, next) => {
    if (!partnerDbConfigured()) {
      res.status(503).json({ error: "partner portal unavailable" });
      return;
    }
    next();
  });

  // Use the same canonical public-auth router and ordering as the main application. The standalone
  // factory must be able to establish the sessions consumed by its authenticated surface; keeping
  // the router implementation in public-routes.ts avoids restoring the shadow login implementation
  // that previously drifted inside routes.ts.
  registerPartnerPublicRoutes(app);

  // H1/M1/DB-F1: portal-wide kill switches + definer-model health, then session + the route
  // families. All authenticated wiring lives in mount.ts (single source of truth for gate order).
  mountPartnerPortal(app);

  // minimal UI shell route (SPA placeholder — no data, no secrets)
  app.get("/partner", (_req: Request, res: Response) => {
    res.type("html").send("<!doctype html><title>MintVault Partner Portal</title><div id=partner-root></div>");
  });

  // 404 for anything else — the partner app has no other surface.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: "not found", path: req.path });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "internal error" }); // never leak internals
  });

  return app;
}

/** Route families that must NEVER be reachable through the partner app (asserted by tests). */
export const FORBIDDEN_PARTNER_PATHS = [
  "/api/admin",
  "/api/admin/certificates/1",
  "/api/staff",
  "/api/grader",
  "/api/admin/scan-ingest",
  "/api/admin/vault-quest",
  "/api/cert/1/edit",
];
