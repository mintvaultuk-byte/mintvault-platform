/** Super Admin-only Partner invitation and access-management HTTP surface. */
import { Router, type Express, type Request, type Response } from "express";
import { requireSuperAdmin } from "../auth";
import {
  PartnerAccessError,
  type SuperAdminActor,
  createInvitation,
  resendInvitation,
  revokeInvitation,
  listInvitations,
  listMembers,
  listPartnerLocationsForAccess,
  changeMemberRole,
  changeMemberLocations,
  setMemberStatus,
  revokeMemberSessions,
  setPartnerStatus,
  listAccessAudit,
} from "./partner-access-service";
import { PARTNER_ROLE_CODES, type PartnerRoleCode } from "../../shared/partner-schema";

function actorOf(req: Request): SuperAdminActor {
  const userId = req.session?.authUserId;
  const email = req.session?.adminEmail;
  if (!userId || !email) throw new PartnerAccessError("bad_request", "Super Admin identity is not established.");
  const requestId = req.header("x-request-id")?.slice(0, 200) || `partner-access-${Date.now()}`;
  return { userId, email, correlationId: requestId };
}

function requiredReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason || reason.length > 2000) throw new PartnerAccessError("bad_request", "A reason is required.");
  return reason;
}

function optionalIdempotencyKey(req: Request): string | undefined {
  const fromHeader = req.header("idempotency-key");
  const fromBody = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
  const key = (fromHeader ?? fromBody)?.trim();
  if (key && key.length > 200) throw new PartnerAccessError("bad_request", "Idempotency key is too long.");
  return key || undefined;
}

function roleOf(raw: unknown): PartnerRoleCode {
  if (typeof raw !== "string" || !PARTNER_ROLE_CODES.includes(raw as PartnerRoleCode)) {
    throw new PartnerAccessError("bad_request", "A recognised Partner role is required.");
  }
  return raw as PartnerRoleCode;
}

function locationsOf(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    throw new PartnerAccessError("bad_request", "Location selection is invalid.");
  }
  return raw;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof PartnerAccessError) {
    const status =
      error.code === "not_found" ? 404 : error.code === "conflict" || error.code === "invalid_state" ? 409 : 400;
    res.status(status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  // Do not expose database/delivery provider details.
  res
    .status(500)
    .json({ error: { code: "internal_error", message: "The Partner access operation could not be completed." } });
}

export function partnerAccessAdminRouter(): Router {
  const r = Router();
  r.use(requireSuperAdmin);

  r.get("/partners/:partnerId/invitations", async (req, res) => {
    try {
      res.json({ invitations: await listInvitations(req.params.partnerId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/invitations", async (req, res) => {
    try {
      const body = req.body ?? {};
      const result = await createInvitation(actorOf(req), req.params.partnerId, {
        email: typeof body.email === "string" ? body.email : "",
        role: roleOf(body.role),
        locationIds: locationsOf(body.locationIds),
        idempotencyKey: optionalIdempotencyKey(req),
      });
      // Never return the raw invitation token: it exists only in the delivery call stack.
      res.status(result.alreadyCompleted ? 200 : 201).json({
        ok: true,
        alreadyCompleted: result.alreadyCompleted,
        invitation: result.invitation,
        deliveryStatus: result.deliveryStatus,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/invitations/:invitationId/resend", async (req, res) => {
    try {
      const result = await resendInvitation(
        actorOf(req),
        req.params.partnerId,
        req.params.invitationId,
        optionalIdempotencyKey(req)
      );
      res.json({
        ok: true,
        alreadyCompleted: result.alreadyCompleted,
        invitation: result.invitation,
        deliveryStatus: result.deliveryStatus,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/invitations/:invitationId/revoke", async (req, res) => {
    try {
      const invitation = await revokeInvitation(
        actorOf(req),
        req.params.partnerId,
        req.params.invitationId,
        requiredReason(req.body?.reason)
      );
      res.json({ ok: true, invitation });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/partners/:partnerId/members", async (req, res) => {
    try {
      res.json({ members: await listMembers(req.params.partnerId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/partners/:partnerId/locations", async (req, res) => {
    try {
      res.json({ locations: await listPartnerLocationsForAccess(req.params.partnerId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/members/:userId/role", async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await changeMemberRole(
          actorOf(req),
          req.params.partnerId,
          req.params.userId,
          roleOf(req.body?.role),
          requiredReason(req.body?.reason)
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/members/:userId/locations", async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await changeMemberLocations(
          actorOf(req),
          req.params.partnerId,
          req.params.userId,
          locationsOf(req.body?.locationIds),
          requiredReason(req.body?.reason)
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/members/:userId/suspend", async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await setMemberStatus(
          actorOf(req),
          req.params.partnerId,
          req.params.userId,
          false,
          requiredReason(req.body?.reason)
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/members/:userId/reactivate", async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await setMemberStatus(
          actorOf(req),
          req.params.partnerId,
          req.params.userId,
          true,
          requiredReason(req.body?.reason)
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/members/:userId/revoke-sessions", async (req, res) => {
    try {
      res.json({
        ok: true,
        revoked: await revokeMemberSessions(
          actorOf(req),
          req.params.partnerId,
          req.params.userId,
          requiredReason(req.body?.reason)
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/suspend", async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await setPartnerStatus(actorOf(req), req.params.partnerId, false, requiredReason(req.body?.reason)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/reactivate", async (req, res) => {
    try {
      res.json({
        ok: true,
        result: await setPartnerStatus(actorOf(req), req.params.partnerId, true, requiredReason(req.body?.reason)),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/partners/:partnerId/access-audit", async (req, res) => {
    try {
      res.json({ events: await listAccessAudit(req.params.partnerId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return r;
}

export function registerPartnerAccessAdminRoutes(app: Express): void {
  app.use("/api/super-admin/partner-access", partnerAccessAdminRouter());
}
