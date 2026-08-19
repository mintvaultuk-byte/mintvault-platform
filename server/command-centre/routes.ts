import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireSuperAdmin } from "../auth";
import { requireCommandCentreEnabled } from "./auth";
import { composeCommandCentreDashboard } from "./dashboard-service";

const dashboardQuerySchema = z
  .object({
    period: z.enum(["today", "month_to_date"]).optional(),
  })
  .strict();

const commandCentreReadRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "Too many Command Centre requests" },
});

export function registerCommandCentreRoutes(app: Express): void {
  app.get(
    "/api/admin/command/dashboard",
    requireCommandCentreEnabled,
    requireSuperAdmin,
    commandCentreReadRateLimit,
    async (request, response) => {
      const parsed = dashboardQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        response.status(400).json({ error: "Invalid Command Centre request" });
        return;
      }

      let serialized: string;
      try {
        const dashboard = await composeCommandCentreDashboard(
          parsed.data.period ?? "today",
        );
        serialized = JSON.stringify(dashboard);
      } catch {
        response.status(503).json({ error: "Command Centre response unavailable" });
        return;
      }
      if (Buffer.byteLength(serialized, "utf8") > 128 * 1024) {
        response.status(503).json({ error: "Command Centre response unavailable" });
        return;
      }

      response.type("application/json").send(serialized);
    },
  );
}
