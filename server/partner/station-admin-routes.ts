import { Router, type Express } from "express";
import { requireAdminStepUp } from "../lib/admin-step-up";
import { requireSuperAdmin } from "../auth";
import { listFleetStations, rejectPendingStation, transitionStationStatus } from "./station-service";

function actorId(req: import("express").Request): string | null {
  const value = (req.session as any)?.authUserId;
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export function partnerStationAdminRouter(): Router {
  const r = Router();
  r.use(requireSuperAdmin);

  r.get("/stations", async (req, res) => {
    try {
      res.json(
        await listFleetStations({
          page: Number(req.query.page),
          pageSize: Number(req.query.pageSize),
          status: req.query.status,
          query: req.query.query,
          tenantId: req.query.tenantId,
        })
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[station-fleet] list failed", error);
      res.status(500).json({ error: "Station fleet is unavailable" });
    }
  });

  for (const status of ["ACTIVE", "SUSPENDED", "REVOKED"] as const) {
    /*
     * AG-3b: approving, suspending or revoking a station changes whether a physical Mac in a shop
     * can capture paid work. Revocation is effectively irreversible for that install — the station
     * must re-enrol — so it demands a fresh proof, not merely a live admin session.
     */
    r.post(`/stations/:stationCode/${status.toLowerCase()}`, requireAdminStepUp(), async (req, res) => {
      try {
        const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
        await transitionStationStatus(String(req.params.stationCode), status, actorId(req), reason);
        res.json({ ok: true, status });
      } catch (error: any) {
        const code = error?.code || "station_change_failed";
        res
          .status(code === "station_not_found" ? 404 : 409)
          .json({ error: { code, message: error?.message || "Station status could not be changed" } });
      }
    });
  }

  // AG-3b: rejecting a pending enrolment is the same class of decision as revoking an active one.
  r.post("/stations/:stationCode/reject", requireAdminStepUp(), async (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      await rejectPendingStation(String(req.params.stationCode), actorId(req), reason);
      res.json({ ok: true, status: "REVOKED", action: "rejected" });
    } catch (error: any) {
      const code = error?.code || "station_change_failed";
      res
        .status(code === "station_not_found" ? 404 : 409)
        .json({ error: { code, message: error?.message || "Station could not be rejected" } });
    }
  });
  return r;
}

export function registerPartnerStationAdminRoutes(app: Express): void {
  app.use("/api/super-admin/fleet", partnerStationAdminRouter());
}
