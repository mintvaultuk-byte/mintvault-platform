/**
 * G5 Super-Admin partner-management — HTTP surface.
 *
 * Thin router: authenticate (existing requireAdmin), derive the acting admin from the SERVER session
 * (never the request body), shape the request via the pure helpers, delegate to partner-management-
 * service, and return the repository-standard envelope. No business logic here. Mounted additively
 * under /api/super-admin/partner-management; global csrfOriginCheck already covers it.
 *
 * NOTE: /api/super-admin/* is outside the /api/admin rate-limit prefix, so this router ships its own
 * mutation limiter. Its default express-rate-limit store is in-process → per-Fly-machine — acceptable
 * for a low-volume internal admin surface; a shared (DB/Redis) store is the documented multi-machine
 * follow-up, consistent with the existing admin/staff in-process counters.
 */
import { Router, type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../auth";
import {
  toG5Error,
  g5StatusFor,
  clampPagination,
  requireReason,
  optionalReason,
  requireVersion,
  requireNonEmpty,
  optionalText,
  requireContactType,
  optionalOrganisationKind,
  optionalBrandingStatus,
  isPartnerStatus,
  G5RequestError,
} from "./partner-management-errors";
import * as svc from "./partner-management-service";
import type { ActorContext } from "./partner-management-service";

const g5MutationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many operations, please slow down." } },
  keyGenerator: (req) => {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
    return req.ip || req.socket.remoteAddress || "unknown";
  },
});

function actorOf(req: Request): ActorContext {
  const actorUserId = req.session.authUserId;
  const actorEmail = req.session.adminEmail;
  if (!actorUserId || !actorEmail) throw new G5RequestError("UNAUTHENTICATED", "Admin identity is not established.");
  const requestId = String(req.headers["x-request-id"] ?? `g5-${req.method}-${Date.now()}`);
  const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
  return { actorUserId, actorEmail, requestId, idempotencyKey };
}

function sendError(res: Response, err: unknown): void {
  const g5 = toG5Error(err);
  res.status(g5StatusFor(g5.code)).json({ error: { code: g5.code, message: g5.message } });
}

function mutationResponse(res: Response, requestId: string, r: { result: unknown; alreadyCompleted: boolean }): void {
  if (r.alreadyCompleted) {
    res.status(200).json({ ok: true, alreadyCompleted: true, requestId });
    return;
  }
  res.json({ ok: true, result: r.result, requestId });
}

function requirePartnerUserRole(raw: unknown): svc.AdminPartnerRole {
  if (!svc.isAdminPartnerRole(raw)) {
    throw new G5RequestError("VALIDATION_ERROR", "Unknown partner user role.");
  }
  return raw;
}

export function partnerManagementRouter(): Router {
  const r = Router();
  r.use(requireAdmin);

  // ---- READS ----
  r.get("/partners", async (req, res) => {
    try {
      const { page, pageSize, offset } = clampPagination(req.query.page, req.query.pageSize);
      const status =
        typeof req.query.status === "string" && isPartnerStatus(req.query.status) ? req.query.status : undefined;
      const kind = typeof req.query.kind === "string" && req.query.kind ? req.query.kind : undefined;
      const search =
        typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;
      const { rows, total } = await svc.listPartners({ status, kind, search }, offset, pageSize);
      res.json({ partners: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/partners/:partnerId", async (req, res) => {
    try {
      res.json(await svc.getPartnerDetail(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/partners/:partnerId/contacts", async (req, res) => {
    try {
      res.json(await svc.listContacts(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/partners/:partnerId/branding", async (req, res) => {
    try {
      res.json(await svc.getBranding(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/partners/:partnerId/notes", async (req, res) => {
    try {
      const { offset, pageSize } = clampPagination(req.query.page, req.query.pageSize);
      res.json(await svc.listNotes(req.params.partnerId, offset, pageSize));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/partners/:partnerId/activity", async (req, res) => {
    try {
      const { offset, pageSize } = clampPagination(req.query.page, req.query.pageSize);
      res.json(await svc.getActivity(req.params.partnerId, offset, pageSize));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/partners/:partnerId/statistics", async (req, res) => {
    try {
      res.json(await svc.getStatistics(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/partners/:partnerId/audit", async (req, res) => {
    try {
      const { offset, pageSize } = clampPagination(req.query.page, req.query.pageSize);
      res.json(await svc.getPartnerAudit(req.params.partnerId, offset, pageSize));
    } catch (err) {
      sendError(res, err);
    }
  });
  r.get("/partners/:partnerId/users", async (req, res) => {
    try {
      res.json(await svc.listPartnerUsers(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- MUTATIONS ----
  r.use(g5MutationRateLimit);

  r.post("/partners", async (req, res) => {
    try {
      const actor = actorOf(req);
      const legalName = requireNonEmpty(req.body?.legalName, "legalName");
      const reason = optionalReason(req.body?.reason, "partner created");
      mutationResponse(res, actor.requestId, await svc.createPartner(actor, { legalName }, reason));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/users", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "partner user invited");
      mutationResponse(
        res,
        actor.requestId,
        await svc.invitePartnerUser(
          actor,
          req.params.partnerId,
          {
            firstName: requireNonEmpty(req.body?.firstName, "firstName"),
            lastName: requireNonEmpty(req.body?.lastName, "lastName"),
            email: requireNonEmpty(req.body?.email, "email"),
            role: requirePartnerUserRole(req.body?.role),
          },
          reason
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/users/:userId/resend-invitation", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "partner invitation resent");
      mutationResponse(
        res,
        actor.requestId,
        await svc.resendPartnerInvitation(actor, req.params.partnerId, req.params.userId, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/users/:userId/revoke-invitation", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.revokePartnerInvitation(actor, req.params.partnerId, req.params.userId, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/users/:userId/role", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.changePartnerUserRole(
          actor,
          req.params.partnerId,
          req.params.userId,
          requirePartnerUserRole(req.body?.role),
          reason
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/users/:userId/status", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      const status = req.body?.status;
      if (status !== "ACTIVE" && status !== "SUSPENDED" && status !== "REVOKED") {
        throw new G5RequestError("VALIDATION_ERROR", "Unknown partner user status.");
      }
      mutationResponse(
        res,
        actor.requestId,
        await svc.setPartnerUserStatus(actor, req.params.partnerId, req.params.userId, status, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/users/:userId/revoke-sessions", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "partner user sessions revoked");
      mutationResponse(
        res,
        actor.requestId,
        await svc.revokePartnerUserSessions(actor, req.params.partnerId, req.params.userId, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.patch("/partners/:partnerId/profile", async (req, res) => {
    try {
      const actor = actorOf(req);
      const version = requireVersion(req.body?.expectedVersion);
      const reason = optionalReason(req.body?.reason, "profile updated");
      // validate any provided constrained fields
      if ("organisation_kind" in (req.body ?? {})) optionalOrganisationKind(req.body.organisation_kind);
      const fields = extractProfileFields(req.body ?? {});
      mutationResponse(
        res,
        actor.requestId,
        await svc.updateProfile(actor, req.params.partnerId, fields, version, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/status", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      const version = requireVersion(req.body?.expectedVersion);
      const status = req.body?.status;
      if (!isPartnerStatus(status)) throw new G5RequestError("INVALID_PARTNER_STATUS", "Unknown partner status.");
      mutationResponse(
        res,
        actor.requestId,
        await svc.changeStatus(actor, req.params.partnerId, status, version, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/contacts", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "contact added");
      const input = {
        fullName: requireNonEmpty(req.body?.fullName, "fullName"),
        contactType: requireContactType(req.body?.contactType),
        email: optionalText(req.body?.email, "email"),
        phone: optionalText(req.body?.phone, "phone"),
        title: optionalText(req.body?.title, "title"),
        isPrimary: req.body?.isPrimary === true,
      };
      mutationResponse(res, actor.requestId, await svc.addContact(actor, req.params.partnerId, input, reason));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.patch("/partners/:partnerId/contacts/:contactId", async (req, res) => {
    try {
      const actor = actorOf(req);
      const version = requireVersion(req.body?.expectedVersion);
      const reason = optionalReason(req.body?.reason, "contact updated");
      const b = req.body ?? {};
      const fields: Record<string, unknown> = {};
      if ("fullName" in b) fields.fullName = requireNonEmpty(b.fullName, "fullName");
      if ("title" in b) fields.title = optionalText(b.title, "title");
      if ("email" in b) fields.email = optionalText(b.email, "email");
      if ("phone" in b) fields.phone = optionalText(b.phone, "phone");
      if ("contactType" in b) fields.contactType = requireContactType(b.contactType);
      if ("isPrimary" in b) fields.isPrimary = b.isPrimary === true;
      mutationResponse(
        res,
        actor.requestId,
        await svc.updateContact(actor, req.params.partnerId, req.params.contactId, fields, version, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/contacts/:contactId/deactivate", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "contact deactivated");
      mutationResponse(
        res,
        actor.requestId,
        await svc.deactivateContact(actor, req.params.partnerId, req.params.contactId, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.put("/partners/:partnerId/branding", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "branding updated");
      // validate the constrained field up front → a friendly 400 rather than a DB CHECK 500
      if ("branding_status" in (req.body ?? {})) optionalBrandingStatus(req.body.branding_status);
      const expectedVersion = req.body?.expectedVersion === undefined ? null : requireVersion(req.body.expectedVersion);
      mutationResponse(
        res,
        actor.requestId,
        await svc.upsertBranding(
          actor,
          req.params.partnerId,
          extractBrandingFields(req.body ?? {}),
          expectedVersion,
          reason
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/notes", async (req, res) => {
    try {
      const actor = actorOf(req);
      const body = requireNonEmptyLong(req.body?.body, "body");
      const supersedes = typeof req.body?.supersedesNoteId === "string" ? req.body.supersedesNoteId : null;
      mutationResponse(
        res,
        actor.requestId,
        await svc.addNote(actor, req.params.partnerId, body, supersedes, "note added")
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  return r;
}

function extractProfileFields(b: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "trading_name",
    "organisation_kind",
    "company_number",
    "vat_number",
    "website",
    "primary_email",
    "primary_phone",
    "address_line1",
    "address_line2",
    "address_city",
    "address_postcode",
    "address_country",
    "onboarding_date",
    "internal_tier",
    "health_note",
  ];
  const out: Record<string, unknown> = {};
  for (const f of allowed) if (f in b) out[f] = b[f];
  return out;
}

function extractBrandingFields(b: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "display_name",
    "logo_r2_key",
    "primary_colour",
    "secondary_colour",
    "accent_colour",
    "support_email",
    "support_website",
    "custom_domain",
    "branding_status",
  ];
  const out: Record<string, unknown> = {};
  for (const f of allowed) if (f in b) out[f] = b[f];
  return out;
}

function requireNonEmptyLong(raw: unknown, field: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) throw new G5RequestError("VALIDATION_ERROR", `${field} is required.`);
  if (s.length > 10000) throw new G5RequestError("VALIDATION_ERROR", `${field} is too long.`);
  return s;
}

/** Additive registration into the existing MintVault admin app (G5 partner management). */
export function registerPartnerManagementRoutes(app: Express): void {
  app.use("/api/super-admin/partner-management", partnerManagementRouter());
}
