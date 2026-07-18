/**
 * Partner Portal — customer API routes (Phase 2 completion). Mounted under /api/partner. Reuses
 * the existing partner.orders.view/.create permissions (customer management is part of the
 * order-creation flow, matching the same reasoning already used for card management reusing
 * partner.orders.edit — no new permission string needed).
 */
import { Router } from "express";
import { requirePartnerAuth, requirePartnerCapability, requireNotViewOnly, requireNotSensitiveFrozen } from "./session";
import { partnerSubmissionMutationLimiter } from "./rate-limit";
import { CustomerError, listCustomers, createCustomer } from "./customer-service";

const MAX_STRING = 200;
function tooLong(s: unknown): boolean {
  return typeof s === "string" && s.length > MAX_STRING;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && !tooLong(v) ? v : null;
}

export function partnerCustomerRouter(): Router {
  const r = Router();
  r.use(requirePartnerAuth);

  r.get("/customers", requirePartnerCapability("partner.orders.view"), async (req, res) => {
    try {
      const search = typeof req.query.search === "string" && !tooLong(req.query.search) ? req.query.search : undefined;
      res.json(await listCustomers(req.partner!, search));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[partner customers] unexpected error:", err);
      res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
    }
  });

  r.post(
    "/customers",
    requirePartnerCapability("partner.orders.create"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const body = req.body ?? {};
        if (
          typeof body.fullName !== "string" ||
          tooLong(body.fullName) ||
          tooLong(body.email) ||
          tooLong(body.phone) ||
          tooLong(body.reference)
        ) {
          res.status(400).json({ error: { code: "validation", message: "Invalid customer input." } });
          return;
        }
        const created = await createCustomer(req.partner!, {
          fullName: body.fullName,
          email: asString(body.email),
          phone: asString(body.phone),
          reference: asString(body.reference),
        });
        res.status(201).json(created);
      } catch (err) {
        if (err instanceof CustomerError) {
          res.status(400).json({ error: { code: err.code, message: err.message } });
          return;
        }
        // eslint-disable-next-line no-console
        console.error("[partner customers] unexpected error:", err);
        res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
      }
    }
  );

  return r;
}
