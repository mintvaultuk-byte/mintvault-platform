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
  /*
   * PATH-SCOPED on purpose (AT-23 mount-order defect, 2026-08-14). This router is mounted in
   * partnerPortalRouter() BEFORE the grading and station routers, and a pathless
   * `r.use(requirePartnerAuth)` runs for EVERY request that falls through the API router — so a
   * signed-station request (Ed25519 headers, deliberately no session cookie) was 401-rejected here
   * and could never reach the station router at all: the entire scanner-station surface was dead in
   * the composed app while every per-router test stayed green. Scoping the guard to this router's
   * own path keeps /catalogue exactly as protected as before and lets everything else fall through
   * to the next router, each of which carries its own guards.
   */
  r.use("/catalogue", requirePartnerAuth);

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
