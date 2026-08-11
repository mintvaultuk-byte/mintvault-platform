/**
 * Partner Portal — read-only HQ catalogue access.
 *
 * Reuses the same snapshot provider as the admin/staff grading pickers. This router deliberately
 * exposes no catalogue item mutation, import, reorder, active/archive, or audit endpoints.
 */
import { Router } from "express";
import { CATALOGUE_CATEGORIES } from "@shared/schema";
import { getCatalogueSnapshot } from "../lib/catalogue-provider";
import { requirePartnerAuth, requirePartnerCapability } from "./session";

export function partnerCatalogueRouter(): Router {
  const r = Router();
  r.use(requirePartnerAuth);

  r.get("/catalogue/snapshot", requirePartnerCapability("partner.orders.view"), async (_req, res) => {
    try {
      res.json({ snapshot: await getCatalogueSnapshot(), categories: CATALOGUE_CATEGORIES });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[partner catalogue] snapshot failed:", err);
      res.status(500).json({ error: { code: "catalogue_unavailable", message: "Catalogue is unavailable." } });
    }
  });

  return r;
}
