import { Router } from "express";
import { CATALOGUE_CATEGORIES } from "@shared/schema";
import { getCatalogueSnapshot } from "../lib/catalogue-provider";
import { requirePartnerAuth, requirePartnerCapability } from "./session";

export function partnerCatalogueRouter(): Router {
  const r = Router();
  r.use(requirePartnerAuth);

  r.get("/catalogue/snapshot", requirePartnerCapability("partner.cards.view"), async (_req, res) => {
    try {
      res.json({ snapshot: await getCatalogueSnapshot(), categories: CATALOGUE_CATEGORIES });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[partner catalogue] unexpected error:", err);
      res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
    }
  });

  return r;
}
