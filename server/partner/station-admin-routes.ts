import { Router, type Express } from "express";
import { requireAdminStepUp } from "../lib/admin-step-up";
import { requireSuperAdmin } from "../auth";
import {
  activateReplacementStation,
  cancelPendingStation,
  listFleetStations,
  rejectPendingStation,
  setStationUpdatePolicy,
  transferStationLocation,
  transitionStationStatus,
} from "./station-service";

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
      res.json({ ok: true, status: "REJECTED", action: "rejected" });
    } catch (error: any) {
      const code = error?.code || "station_change_failed";
      res
        .status(code === "station_not_found" ? 404 : 409)
        .json({ error: { code, message: error?.message || "Station could not be rejected" } });
    }
  });

  r.post("/stations/:stationCode/cancel", requireAdminStepUp(), async (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
      await cancelPendingStation(String(req.params.stationCode), actorId(req), reason);
      res.json({ ok: true, status: "CANCELLED", action: "cancelled" });
    } catch (error: any) {
      const code = error?.code || "station_change_failed";
      res
        .status(code === "station_not_found" ? 404 : 409)
        .json({ error: { code, message: error?.message || "Station could not be cancelled" } });
    }
  });

  r.post("/stations/:stationCode/replace", requireAdminStepUp(), async (req, res) => {
    try {
      await activateReplacementStation({
        stationCode: String(req.params.stationCode),
        replacesStationCode: req.body?.replacesStationCode,
        actorUserId: actorId(req),
        reason: typeof req.body?.reason === "string" ? req.body.reason : "",
      });
      res.json({ ok: true, status: "ACTIVE", action: "replacement_activated" });
    } catch (error: any) {
      const code = error?.code || "station_change_failed";
      res
        .status(code === "station_not_found" ? 404 : 409)
        .json({ error: { code, message: error?.message || "Replacement station could not be activated" } });
    }
  });

  r.post("/stations/:stationCode/transfer-location", requireAdminStepUp(), async (req, res) => {
    try {
      await transferStationLocation({
        stationCode: String(req.params.stationCode),
        targetLocationId: req.body?.targetLocationId,
        actorUserId: actorId(req),
        reason: typeof req.body?.reason === "string" ? req.body.reason : "",
      });
      res.json({ ok: true, status: "ACTIVE", action: "location_transferred" });
    } catch (error: any) {
      const code = error?.code || "station_change_failed";
      res
        .status(code === "station_not_found" ? 404 : 409)
        .json({ error: { code, message: error?.message || "Station location could not be transferred" } });
    }
  });

  r.post("/stations/:stationCode/update-policy", requireAdminStepUp(), async (req, res) => {
    try {
      await setStationUpdatePolicy({
        stationCode: String(req.params.stationCode),
        policy: req.body?.policy,
        actorUserId: actorId(req),
        reason: typeof req.body?.reason === "string" ? req.body.reason : "",
      });
      res.json({ ok: true, action: "update_policy_issued" });
    } catch (error: any) {
      const code = error?.code || "station_change_failed";
      res
        .status(code === "station_not_found" ? 404 : 409)
        .json({ error: { code, message: error?.message || "Scanner update policy could not be issued" } });
    }
  });
  return r;
}

export function registerPartnerStationAdminRoutes(app: Express): void {
  app.use("/api/super-admin/fleet", partnerStationAdminRouter());
}
