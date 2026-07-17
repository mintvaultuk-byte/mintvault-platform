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
import { partnerSessionMiddleware } from "./session";
import { partnerApiRouter } from "./routes";
import { partnerDbConfigured } from "./db";
import { resolveGlobalFlag } from "./flags";

export function createPartnerApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // fail closed if the restricted runtime DB isn't configured (never fall back to privileged conn)
  app.use((_req, res, next) => {
    if (!partnerDbConfigured()) {
      res.status(503).json({ error: "partner portal unavailable" });
      return;
    }
    next();
  });

  // H1/M1: portal-wide kill switches. partner_portal_enabled must be ON (fail closed) and
  // partner_emergency_stop must be OFF, else the ENTIRE surface returns 503. Checked per request
  // on the /api/partner surface (the /partner shell is a static page, exempt).
  app.use("/api/partner", async (_req, res, next) => {
    try {
      const [portalOn, emergencyStop] = await Promise.all([
        resolveGlobalFlag("partner_portal_enabled"),
        resolveGlobalFlag("partner_emergency_stop"),
      ]);
      if (!portalOn || emergencyStop) {
        res.status(503).json({ error: "partner portal unavailable" });
        return;
      }
      next();
    } catch {
      res.status(503).json({ error: "partner portal unavailable" }); // fail closed
    }
  });

  app.use(partnerSessionMiddleware);
  app.use("/api/partner", partnerApiRouter());

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
