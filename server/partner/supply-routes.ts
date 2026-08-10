import { Router } from "express";
import { APP_BASE_URL } from "../app-url";
import { requirePartnerCapability, requireNotSensitiveFrozen, requireNotViewOnly } from "./session";
import {
  PartnerSupplyError,
  createPartnerSupplyCheckout,
  listPartnerSupplyOperations,
  listPartnerSupplyOrders,
  listPartnerSupplyProducts,
  recordPartnerSupplyStock,
} from "./supply-service";

function sendSupplyError(res: { status: (status: number) => { json: (body: unknown) => void } }, err: unknown): void {
  if (err instanceof PartnerSupplyError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error("[partner-supply] request failed", (err as Error).message);
  res.status(500).json({ error: "Supplies are temporarily unavailable.", code: "SUPPLY_UNAVAILABLE" });
}

/** Auth/session/gates are mounted by mount.ts before this router. */
export function partnerSupplyRouter(): Router {
  const r = Router();

  r.get("/supplies/products", requirePartnerCapability("partner.orders.view"), async (_req, res) => {
    try {
      res.json(await listPartnerSupplyProducts());
    } catch (err) {
      sendSupplyError(res, err);
    }
  });

  r.get("/supplies/orders", requirePartnerCapability("partner.orders.view"), async (req, res) => {
    try {
      res.json({ orders: await listPartnerSupplyOrders(req.partner!) });
    } catch (err) {
      sendSupplyError(res, err);
    }
  });

  r.get("/supplies/operations", requirePartnerCapability("partner.orders.view"), async (req, res) => {
    try {
      res.json(await listPartnerSupplyOperations(req.partner!));
    } catch (err) {
      sendSupplyError(res, err);
    }
  });

  // Reception holds legacy orders.submit, so it is intentionally insufficient here. A recorded
  // stock count is mutable operational evidence and is limited to the existing Owner/Manager
  // purchase capability; Finance remains read-only.
  r.put(
    "/supplies/stock/:productCode",
    requirePartnerCapability("partner.orders.submit"),
    requirePartnerCapability("partner.credits.purchase"),
    requireNotViewOnly,
    async (req, res) => {
      try {
        res.json(await recordPartnerSupplyStock(req.partner!, req.params.productCode, req.body?.knownUnits));
      } catch (err) {
        sendSupplyError(res, err);
      }
    }
  );

  // A Finance Viewer has partner.orders.view but deliberately lacks credits.purchase. The two
  // checks are both required so the historical broad orders.submit grant for Reception cannot
  // become accidental payment authority.
  r.post(
    "/supplies/checkout",
    requirePartnerCapability("partner.orders.submit"),
    requirePartnerCapability("partner.credits.purchase"),
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const origin = (req.headers.origin as string | undefined) || APP_BASE_URL;
        const checkout = await createPartnerSupplyCheckout(
          req.partner!,
          {
            items: req.body?.items,
            deliveryAddress: req.body?.deliveryAddress,
            idempotencyKey: req.get("Idempotency-Key") ?? req.body?.idempotencyKey,
          },
          { origin, returnPath: req.body?.returnPath }
        );
        res.status(201).json(checkout);
      } catch (err) {
        sendSupplyError(res, err);
      }
    }
  );

  return r;
}
