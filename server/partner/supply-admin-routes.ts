import { Router, type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../auth";
import { supplyProductImageUpload } from "../lib/multer-configs";
import {
  PartnerSupplyError,
  cancelSupplyOrderForSuperAdmin,
  listSupplyOrderAuditForSuperAdmin,
  listSupplyOrdersForSuperAdmin,
  moveSupplyOrderForSuperAdmin,
  requestSupplyManualExceptionForSuperAdmin,
  refundSupplyOrderForSuperAdmin,
  createSupplyProductForSuperAdmin,
  removeSupplyProductImageForSuperAdmin,
  setSupplyProductImageForSuperAdmin,
  updateSupplyCatalogueForSuperAdmin,
  updateSupplyTaxForSuperAdmin,
} from "./supply-service";

function actor(req: Request) {
  const session = req.session as { authUserId?: string; adminEmail?: string };
  return { userId: session.authUserId ?? null, email: session.adminEmail ?? null };
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof PartnerSupplyError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error("[partner-supply-admin] request failed", (err as Error).message);
  res
    .status(500)
    .json({ error: "Supply order administration is temporarily unavailable.", code: "SUPPLY_ADMIN_UNAVAILABLE" });
}

const mutationLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.ip ?? req.socket.remoteAddress ?? "unknown",
  message: { error: "Too many supply operations. Please slow down.", code: "RATE_LIMITED" },
});

export function partnerSupplyAdminRouter(): Router {
  const r = Router();
  // Cross-tenant order/read/refund authority belongs to Super Admin, never the wider admin role.
  r.use(requireSuperAdmin);

  r.get("/orders", async (_req, res) => {
    try {
      res.json({ orders: await listSupplyOrdersForSuperAdmin() });
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/catalogue", async (_req, res) => {
    try {
      const { listPartnerSupplyProducts } = await import("./supply-service");
      res.json(await listPartnerSupplyProducts());
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/orders/:orderId/audit", async (req, res) => {
    try {
      res.json({ events: await listSupplyOrderAuditForSuperAdmin(req.params.orderId) });
    } catch (err) {
      sendError(res, err);
    }
  });
  r.post("/orders/:orderId/processing", mutationLimit, async (req, res) => {
    try {
      await moveSupplyOrderForSuperAdmin(actor(req), req.params.orderId, "processing");
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
  r.post("/orders/:orderId/dispatched", mutationLimit, async (req, res) => {
    try {
      await moveSupplyOrderForSuperAdmin(actor(req), req.params.orderId, "dispatched", req.body?.trackingReference);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
  r.post("/orders/:orderId/completed", mutationLimit, async (req, res) => {
    try {
      await moveSupplyOrderForSuperAdmin(actor(req), req.params.orderId, "completed");
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
  r.post("/orders/:orderId/manual-exception", mutationLimit, async (req, res) => {
    try {
      await requestSupplyManualExceptionForSuperAdmin(actor(req), req.params.orderId, req.body?.reason);
      res.status(202).json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
  r.post("/orders/:orderId/refund", mutationLimit, async (req, res) => {
    try {
      res.json(
        await refundSupplyOrderForSuperAdmin(actor(req), req.params.orderId, req.body?.amountPence, req.body?.reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });
  r.post("/orders/:orderId/cancel", mutationLimit, async (req, res) => {
    try {
      await cancelSupplyOrderForSuperAdmin(actor(req), req.params.orderId, req.body?.reason);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
  /*
   * ADD SUPPLY PRODUCT. The catalogue is open-ended: migration 0111 removed the CHECK constraint
   * that named the only three permitted products, so this INSERT is what makes a fourth possible.
   * A new product is created UNPRICED and therefore not purchasable until somebody prices it.
   */
  r.post("/catalogue", mutationLimit, async (req, res) => {
    try {
      res.status(201).json(await createSupplyProductForSuperAdmin(actor(req), req.body ?? {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  /*
   * PRODUCT IMAGE. Multipart, one file, 4 MB. The service checks magic bytes and decodes the image
   * before anything is stored, and generates the object key itself — the browser never chooses a
   * storage path and never sees one.
   */
  r.post("/catalogue/:code/image", mutationLimit, supplyProductImageUpload.single("image"), async (req, res) => {
    try {
      res.json(await setSupplyProductImageForSuperAdmin(actor(req), req.params.code, req.file));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.delete("/catalogue/:code/image", mutationLimit, async (req, res) => {
    try {
      await removeSupplyProductImageForSuperAdmin(actor(req), req.params.code);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.put("/catalogue/:code", mutationLimit, async (req, res) => {
    try {
      await updateSupplyCatalogueForSuperAdmin(actor(req), req.params.code, req.body ?? {});
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
  r.put("/tax", mutationLimit, async (req, res) => {
    try {
      await updateSupplyTaxForSuperAdmin(actor(req), req.body ?? {});
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  });
  return r;
}

export function registerPartnerSupplyAdminRoutes(app: Express): void {
  app.use("/api/super-admin/supplies", partnerSupplyAdminRouter());
}
