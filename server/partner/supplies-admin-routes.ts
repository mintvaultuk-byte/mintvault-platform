/**
 * Super Admin supplies operations. This router is deliberately separate from the Partner portal:
 * Partner users can never transition a physical order to Processing/Dispatched/Cancelled by guessing
 * an ID or a client-side button state.
 */
import { Router, type Express, type Request, type Response } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../auth";
import { requireAdminStepUp } from "../lib/admin-step-up";
import { adminClientIpRateLimitKey } from "../lib/admin-client-ip";
import { getPartnerAdminCapability } from "./admin-capability";
import {
  SuppliesError,
  attemptNewSuppliesOrderNotification,
  listSuppliesOrdersForAdmin,
  retrySuppliesOrderNotificationAsAdmin,
  transitionSuppliesOrderAsAdmin,
  type SuppliesOrderStatus,
} from "./supplies-service";

const suppliesAdminMutationLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many supplies operations. Please slow down." } },
  keyGenerator: adminClientIpRateLimitKey,
});

function isStatus(value: unknown): value is SuppliesOrderStatus {
  return value === "RECEIVED" || value === "PROCESSING" || value === "DISPATCHED" || value === "CANCELLED";
}

function actorOf(req: Request): { actorUserId: string; actorEmail: string; requestId: string } {
  const actorUserId = req.session.authUserId;
  const actorEmail = req.session.adminEmail;
  if (!actorUserId || !actorEmail) throw new SuppliesError("NOT_FOUND", "An identified Super Admin session is required.", 401);
  return {
    actorUserId,
    actorEmail,
    requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : crypto.randomUUID(),
  };
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof SuppliesError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  res.status(500).json({ error: { code: "SUPPLIES_UNAVAILABLE", message: "Supplies operations are temporarily unavailable." } });
}

async function requirePartnerAdminCapability(_req: Request, res: Response, next: () => void): Promise<void> {
  const capability = await getPartnerAdminCapability();
  if (!capability.ok) {
    res.status(503).json({
      error: { code: "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE", message: "Partner supplies operations are not ready." },
    });
    return;
  }
  next();
}

export function partnerSuppliesAdminRouter(): Router {
  const r = Router();
  // This PII-bearing router is mounted outside partnerApiRouter(), so inherit the authenticated
  // Partner cache boundary explicitly for every Super Admin supplies response.
  r.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    next();
  });
  r.use(requireSuperAdmin);
  r.use(requirePartnerAdminCapability);

  r.get("/orders", async (req, res) => {
    const status = isStatus(req.query.status) ? req.query.status : undefined;
    try {
      res.json({ orders: await listSuppliesOrdersForAdmin({ status }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/orders/:orderId/status", suppliesAdminMutationLimit, requireAdminStepUp(), async (req, res) => {
    if (!isStatus(req.body?.status)) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A valid supplies status is required." } });
      return;
    }
    try {
      const order = await transitionSuppliesOrderAsAdmin({ orderId: String(req.params.orderId), status: req.body.status, ...actorOf(req) });
      res.json({ order });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/orders/:orderId/notification/retry", suppliesAdminMutationLimit, requireAdminStepUp(), async (req, res) => {
    try {
      const order = await retrySuppliesOrderNotificationAsAdmin({ orderId: String(req.params.orderId), ...actorOf(req) });
      // Requeue commits before this attempt. Any renewed provider failure remains durable and can
      // be requeued again only through a deliberate future step-up; it never creates another order.
      const notificationStatus = await attemptNewSuppliesOrderNotification(order.id);
      res.json({ order: { ...order, notificationStatus } });
    } catch (error) {
      sendError(res, error);
    }
  });

  return r;
}

export function registerPartnerSuppliesAdminRoutes(app: Express): void {
  app.use("/api/super-admin/partner-supplies", partnerSuppliesAdminRouter());
}
