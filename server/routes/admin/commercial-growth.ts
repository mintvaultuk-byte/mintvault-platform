import { Router, type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireSuperAdmin } from "../../auth";
import { TRACKED_LINK_OPTIONS } from "../../commercial-attribution";
import {
  GrowthLeadNotFoundError,
  generateTrackedCampaignLink,
  getGrowthSummary,
  getPartnerApplication,
  isGrowthPeriod,
  isPartnerLeadStatus,
  listPartnerApplications,
  updatePartnerLeadStatus,
} from "../../commercial-growth-service";
import { PARTNER_APPLICATION_STATUSES } from "../../partner-applications";
import { storage } from "../../storage";

export const COMMERCIAL_GROWTH_BASE = "/api/super-admin/growth";

const readLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
  message: { error: "Too many Growth Command requests. Please slow down." },
});

const mutationLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
  message: { error: "Too many Growth Command changes. Please wait before trying again." },
});

const leadIdSchema = z.string().uuid();
const leadStatusSchema = z.object({ status: z.enum(PARTNER_APPLICATION_STATUSES) }).strict();

async function audit(req: Request, entityId: string, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await storage.writeAuditLog("commercial_growth", entityId, action, req.session.adminEmail ?? null, details);
  } catch {
    // Reads and deterministic link generation remain available if the generic
    // audit sink is temporarily unavailable. Lead status writes audit inside
    // their database transaction and deliberately fail instead.
    console.warn("[commercial-growth] non-authoritative audit unavailable");
  }
}

function invalidLeadId(res: Response): void {
  res.status(400).json({ error: "A valid Partner application id is required" });
}

export function registerCommercialGrowthRoutes(app: Express): void {
  const router = Router();
  router.use(requireSuperAdmin, readLimit);

  router.get("/summary", async (req: Request, res: Response) => {
    const period = req.query.period ?? "30d";
    if (!isGrowthPeriod(period)) return res.status(400).json({ error: "period must be today, 7d, 30d, 90d, or all" });
    try {
      const summary = await getGrowthSummary(period);
      await audit(req, period, "growth_command_viewed", {
        period,
        sourceRows: summary.sourcePerformance.length,
        campaignRows: summary.campaignPerformance.length,
      });
      return res.set("Cache-Control", "private, no-store").json(summary);
    } catch {
      console.error("[commercial-growth] aggregate query failed");
      return res.status(500).json({ error: "Growth Command data is unavailable" });
    }
  });

  router.get("/leads", async (req: Request, res: Response) => {
    const status = req.query.status;
    if (status !== undefined && !isPartnerLeadStatus(status)) {
      return res.status(400).json({ error: "status must be a valid Partner lead state" });
    }
    try {
      const leads = await listPartnerApplications(status);
      await audit(req, status ?? "all", "growth_partner_leads_listed", { status: status ?? "all", rowCount: leads.length });
      return res.set("Cache-Control", "private, no-store").json({ leads });
    } catch {
      console.error("[commercial-growth] Partner lead list failed");
      return res.status(500).json({ error: "Partner applications are unavailable" });
    }
  });

  router.get("/leads/:id", async (req: Request, res: Response) => {
    const parsedId = leadIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return invalidLeadId(res);
    try {
      const lead = await getPartnerApplication(parsedId.data);
      await audit(req, parsedId.data, "growth_partner_lead_viewed", { scope: "growth_command" });
      return res.set("Cache-Control", "private, no-store").json({ lead });
    } catch (error) {
      if (error instanceof GrowthLeadNotFoundError) return res.status(404).json({ error: "Partner application not found" });
      console.error("[commercial-growth] Partner lead detail failed");
      return res.status(500).json({ error: "Partner application is unavailable" });
    }
  });

  router.post("/leads/:id/status", mutationLimit, async (req: Request, res: Response) => {
    const parsedId = leadIdSchema.safeParse(req.params.id);
    if (!parsedId.success) return invalidLeadId(res);
    const parsedBody = leadStatusSchema.safeParse(req.body);
    if (!parsedBody.success) return res.status(400).json({ error: "A valid Partner lead status is required" });
    try {
      const result = await updatePartnerLeadStatus(parsedId.data, parsedBody.data.status, req.session.adminEmail ?? null);
      return res.set("Cache-Control", "private, no-store").json(result);
    } catch (error) {
      if (error instanceof GrowthLeadNotFoundError) return res.status(404).json({ error: "Partner application not found" });
      console.error("[commercial-growth] Partner lead status change failed");
      return res.status(500).json({ error: "Partner application status could not be changed" });
    }
  });

  router.get("/link-options", async (req: Request, res: Response) => {
    await audit(req, "link-options", "growth_link_options_viewed", { scope: "controlled_campaign_registry" });
    return res.set("Cache-Control", "private, no-store").json(TRACKED_LINK_OPTIONS);
  });

  router.post("/links", mutationLimit, async (req: Request, res: Response) => {
    try {
      const link = generateTrackedCampaignLink(req.body);
      await audit(req, link.attribution.campaign ?? "direct", "growth_link_generated", {
        target: req.body?.target,
        category: link.attribution.category,
        campaign: link.attribution.campaign ?? "UNATTRIBUTED",
      });
      return res.set("Cache-Control", "private, no-store").json({ url: link.url });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Use the controlled Growth Command link values" });
      console.error("[commercial-growth] tracked link generation failed");
      return res.status(500).json({ error: "Tracked link generation is unavailable" });
    }
  });

  app.use(COMMERCIAL_GROWTH_BASE, router);
}
