/** Partner-authenticated supplies routes. Mounted only under /api/partner by mount.ts. */
import { Router, type RequestHandler, type Response } from "express";
import { requirePartnerAuth, requirePartnerCapability, requireNotSensitiveFrozen, requireNotViewOnly } from "./session";
import { partnerSubmissionMutationLimiter } from "./rate-limit";
import {
  SUPPLIES_PRODUCTS,
  SuppliesError,
  attemptNewSuppliesOrderNotification,
  createSuppliesOrder,
  getSuppliesDeliveryPreview,
  listOwnSuppliesOrders,
} from "./supplies-service";

function sendError(res: Response, error: unknown): void {
  if (error instanceof SuppliesError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  // Do not disclose database/provider internals from a Partner route.
  res
    .status(500)
    .json({ error: { code: "SUPPLIES_UNAVAILABLE", message: "Supplies ordering is temporarily unavailable." } });
}

export function partnerSuppliesRouter(): Router {
  const r = Router();

  // This router is mounted beside (not inside) partnerApiRouter(), whose no-store policy is
  // intentionally router-local. Delivery previews and order history contain tenant PII, so keep
  // the same policy by construction instead of relying on each handler to remember it.
  r.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    next();
  });
  r.use(requirePartnerAuth);

  // Read-only server-owned catalogue. The browser never supplies a product label, price, stock
  // status or payment value; POST revalidates these same codes regardless of this response.
  r.get("/supplies/catalogue", requirePartnerCapability("partner.supplies.view"), async (_req, res) => {
    res.json({ products: SUPPLIES_PRODUCTS });
  });

  r.get("/supplies/delivery", requirePartnerCapability("partner.supplies.submit"), async (req, res) => {
    try {
      res.json(await getSuppliesDeliveryPreview(req.partner!));
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/supplies/requests", requirePartnerCapability("partner.supplies.view"), async (req, res) => {
    try {
      res.json({ orders: await listOwnSuppliesOrders(req.partner!) });
    } catch (error) {
      sendError(res, error);
    }
  });

  const createRequest: RequestHandler = async (req, res) => {
    const idempotencyKey = req.get("Idempotency-Key")?.trim() ?? "";
    try {
      const created = await createSuppliesOrder(req.partner!, {
        items: req.body?.items,
        notes: req.body?.notes,
        idempotencyKey,
      });
      // Creation has committed before this attempt. Delivery failure remains a durable outbox
      // state and never makes the Partner repeat/duplicate the order.
      const notificationStatus = created.replayed
        ? created.order.notificationStatus
        : await attemptNewSuppliesOrderNotification(created.order.id);
      res.status(created.replayed ? 200 : 201).json({
        order: { ...created.order, notificationStatus },
        replayed: created.replayed,
      });
    } catch (error) {
      sendError(res, error);
    }
  };
  // The old POST is a rolling-client compatibility alias, never a paid checkout.
  // Literal route declarations keep both entrypoints visible to the topology gate.
  r.post(
    "/supplies/requests",
    requirePartnerCapability("partner.supplies.submit"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    createRequest
  );
  r.post(
    "/supplies/orders",
    requirePartnerCapability("partner.supplies.submit"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    createRequest
  );

  return r;
}
