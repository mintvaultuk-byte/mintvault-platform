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
import { requireAdminStepUp } from "../lib/admin-step-up";
import rateLimit from "express-rate-limit";
import { requireSuperAdmin } from "../auth";
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
import { getLastPartnerAdminCapability, getPartnerAdminCapability } from "./admin-capability";
import { validatePartnerRbac, partnerRbacBlocksReadiness } from "./permissions";
import { checkPartnerSchemaContract } from "./schema-contract";
import { resolveGlobalFlag } from "./flags";
import { getAdminGooglePresence } from "./google-presence-service";
import { adminClientIpRateLimitKey } from "../lib/admin-client-ip";

/**
 * Static operator remedy. Used when RBAC blocks readiness but the validator itself had no remedy to
 * offer — i.e. state is "not_configured" while the Partner surface is switched ON. Kept as a literal
 * so nothing derived from database output can ever reach the HTTP response.
 */
const REMEDY_APPLY_RBAC_MIGRATION = "Apply the pending Partner RBAC migration (0034_partner_rbac_seed.sql).";

const g5MutationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many operations, please slow down." } },
  keyGenerator: adminClientIpRateLimitKey,
});

/**
 * PERMANENT DELETION gets its own, far tighter budget.
 *
 * The general G5 limiter allows 60 mutations a minute, which is right for editing a shop and wrong
 * for destroying one. A legitimate operator deletes a Partner a handful of times a day at most, so
 * anything beyond a few an hour is either a mistake being repeated or an attack, and both are better
 * stopped. Keyed the same way as every other admin limiter here, and applied IN ADDITION to
 * g5MutationRateLimit rather than instead of it.
 */
const partnerDeleteRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    error: { code: "RATE_LIMITED", message: "Too many permanent deletions attempted. Try again later." },
  },
  keyGenerator: adminClientIpRateLimitKey,
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

async function requirePartnerAdminCapability(_req: Request, res: Response, next: () => void): Promise<void> {
  const capability = await getPartnerAdminCapability();
  if (!capability.ok) {
    res.status(503).json({
      error: {
        code: "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE",
        message: "Partner Super Admin management is not ready.",
      },
    });
    return;
  }
  next();
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
  r.use(requireSuperAdmin);

  /**
   * Partner-management readiness.
   *
   * Reports BOTH preconditions the surface actually needs:
   *   1. the admin pool can see through RLS (BYPASSRLS capability), and
   *   2. the RBAC reference data exists.
   *
   * (2) was added after the first-owner-invitation incident. The RBAC bootstrap is deliberately
   * fail-soft — a missing partner role must never take down grading or certificates — but fail-soft
   * without visibility is precisely what let the original defect hide: the app reported healthy on
   * every probe while partner invitations were impossible. This endpoint is the partner-specific
   * readiness surface, it already 503s for partner-specific problems, and it is where an operator
   * looks; so an unusable RBAC state now shows up here rather than nowhere. The core /ready probe is
   * deliberately NOT changed — a partner reference-data fault must not pull the app out of service.
   */
  r.get("/readiness", async (_req, res) => {
    const last = getLastPartnerAdminCapability();
    const current = last?.ok ? last : await getPartnerAdminCapability();
    // Re-validated per probe, so an operator sees CURRENT truth rather than a boot-time snapshot.
    // This call is strictly read-only — it can never seed or repair the catalogue.
    const rbac = await validatePartnerRbac();

    /*
     * "not_configured" is healthy ONLY while the Partner surface is entirely off. Once any Partner
     * flag is enabled, an absent catalogue is a genuine fault — the product would be advertising a
     * Partner surface it cannot serve. Treating not_configured as unconditionally healthy is exactly
     * how the original first-invitation blocker stayed invisible.
     *
     * Flag resolution is itself fail-closed: if the flag store cannot be read we assume the surface
     * IS enabled, so an unreadable flag can never downgrade a real RBAC fault into a 200.
     */
    let partnerSurfaceEnabled: boolean;
    try {
      const [portal, onboarding, login] = await Promise.all([
        resolveGlobalFlag("partner_portal_enabled"),
        resolveGlobalFlag("partner_onboarding_enabled"),
        resolveGlobalFlag("partner_login_enabled"),
      ]);
      partnerSurfaceEnabled = portal || onboarding || login;
    } catch {
      partnerSurfaceEnabled = true;
    }

    const rbacBlocks = partnerRbacBlocksReadiness(rbac.state, partnerSurfaceEnabled);

    /*
     * Schema contract (invariant I18). This is the surface an operator actually looks at, so a
     * version deployed ahead of its migration must say so HERE rather than being inferred from a
     * scatter of unrelated 401s and 500s across login, password reset and invitation accept.
     * Read-only and cached-on-success; it can never seed or repair anything.
     */
    const schema = await checkPartnerSchemaContract();

    const ready = current.ok && !rbacBlocks && schema.ok;

    /*
     * failureCode is always a FIXED enum and remedy is always a STATIC string. No raw database error
     * text, schema detail, connection string or row content reaches this response; the detail is
     * logged server-side only inside validatePartnerRbac().
     */
    const rbacFailureCode = rbacBlocks ? (rbac.failureCode ?? "PARTNER_RBAC_NOT_SEEDED") : null;

    res.status(ready ? 200 : 503).json({
      checked: true,
      ready,
      capability: current.capability,
      checkedAt: current.checkedAt,
      failureCode: current.ok ? rbacFailureCode : current.code,
      rbac: {
        state: rbac.state,
        checkedAt: rbac.checkedAt,
        failureCode: rbacFailureCode,
        remedy: rbacBlocks ? (rbac.remedy ?? REMEDY_APPLY_RBAC_MIGRATION) : null,
        missing: rbac.missing,
        unexpected: rbac.unexpected,
      },
      schemaContract: {
        ok: schema.ok,
        // Each entry names the requirement AND the migration file that supplies it. This is
        // deployment configuration, never tenant data, so it is safe on this Super-Admin surface.
        missing: schema.missing,
        probeError: schema.error ?? null,
      },
    });
  });

  r.use(requirePartnerAdminCapability);

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

  /**
   * READ-ONLY pre-creation duplicate scan.
   *
   * ROUTE ORDER IS LOAD-BEARING: this literal path MUST be registered before `/partners/:partnerId`,
   * or Express matches the parameterised route first and "duplicate-check" is treated as a partner id
   * (a 404 that looks like a broken feature). The test suite asserts the ordering.
   *
   * It is a GET with query parameters and no body. The values echoed back are values the caller just
   * supplied plus the legal names of colliding partners — both already visible to any admin through
   * the partners list, so this leaks nothing new. It writes nothing and audits nothing.
   */
  r.get("/partners/duplicate-check", async (req, res) => {
    try {
      const q = req.query as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : undefined);
      const matches = await svc.findDuplicates({
        legalName: str(q.legalName),
        tradingName: str(q.tradingName),
        email: str(q.email),
        postcode: str(q.postcode),
        phone: str(q.phone),
      });
      res.json({ matches });
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * READ-ONLY Owner-email eligibility for the CREATE SHOP form.
   *
   * ROUTE ORDER, same reason as duplicate-check above: a literal path must be registered before any
   * parameterised sibling that could swallow it.
   *
   * Super Admin only, like every route on this router, so it answers plainly — which Partner holds
   * the address, that user's status, and the one supported resolution. The Partner-facing surfaces
   * keep their deliberately vague wording; this is the operator entitled to the answer, and telling
   * them nothing is what made a correct refusal look like a broken button.
   */
  r.get("/first-shop/owner-email-eligibility", async (req, res) => {
    try {
      const email = typeof req.query.email === "string" ? req.query.email.trim().slice(0, 320) : "";
      res.json(await svc.checkOwnerEmailEligibility(email));
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
  r.get("/partners/:partnerId/onboarding-readiness", async (req, res) => {
    try {
      res.json(await svc.getPartnerOnboardingReadiness(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });
  /**
   * Guided first-shop view. This is a projection of the existing Partner/location/contact/user
   * authorities, not a second onboarding record or a client-side checklist.
   */
  r.get("/partners/:partnerId/first-shop", async (req, res) => {
    try {
      res.json(await svc.getFirstShopOnboarding(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * CAN this Partner be permanently deleted, and if not, exactly why not?
   *
   * A READ, deliberately separate from the deletion itself, so the Super Admin screen can decide
   * whether to offer a destructive control at all. Showing a delete button that is certain to fail —
   * and then surfacing a raw foreign-key violation to a non-technical operator — is the behaviour
   * this endpoint exists to replace.
   */
  r.get("/partners/:partnerId/deletion-assessment", async (req, res) => {
    try {
      const { assessPartnerDeletion } = await import("./partner-deletion-service");
      res.json(await assessPartnerDeletion(String(req.params.partnerId)));
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- MUTATIONS ----
  r.use(g5MutationRateLimit);

  r.post("/wallet-backfills/WALLET-BACKFILL1", requireSuperAdmin, async (req, res) => {
    try {
      const actor = actorOf(req);
      if (req.body?.confirm !== "WALLET-BACKFILL1") {
        throw new G5RequestError("VALIDATION_ERROR", "Confirmation phrase is required.");
      }
      const reason = requireReason(req.body?.reason);
      const targetTenantIds = parseTargetTenantIds(req.body?.targetTenantIds);
      mutationResponse(res, actor.requestId, {
        result: await svc.provisionMissingActivePartnerWallets(actor, { reason, targetTenantIds }),
        alreadyCompleted: false,
      });
    } catch (err) {
      sendError(res, err);
    }
  });

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

  /** Atomically creates the first shop's canonical Partner, Main location, contact, Owner invite and wallet. */
  r.post("/first-shop", async (req, res) => {
    try {
      const actor = actorOf(req);
      mutationResponse(
        res,
        actor.requestId,
        await svc.createFirstShopOnboarding(
          actor,
          {
            legalName: requireNonEmpty(req.body?.legalName, "legalName"),
            /*
             * Both optional now. A single-location shop is always "Main location", and its
             * operations contact is the Owner unless somebody says otherwise, so the guided form
             * stopped asking for either. The SERVICE applies the defaults, not this route, so the
             * canonical record is identical whichever caller creates it.
             */
            locationName: optionalText(req.body?.locationName, "locationName", 120),
            deliveryAddress: {
              line1: requireNonEmpty(req.body?.deliveryAddress?.line1, "deliveryAddress.line1"),
              line2: optionalText(req.body?.deliveryAddress?.line2, "deliveryAddress.line2", 200),
              city: requireNonEmpty(req.body?.deliveryAddress?.city, "deliveryAddress.city"),
              postcode: requireNonEmpty(req.body?.deliveryAddress?.postcode, "deliveryAddress.postcode"),
              country: requireNonEmpty(req.body?.deliveryAddress?.country, "deliveryAddress.country"),
            },
            operationsContact:
              req.body?.operationsContact == null
                ? null
                : {
                    fullName: optionalText(req.body?.operationsContact?.fullName, "operationsContact.fullName", 200),
                    email: optionalText(req.body?.operationsContact?.email, "operationsContact.email", 320),
                  },
            owner: {
              firstName: requireNonEmpty(req.body?.owner?.firstName, "owner.firstName"),
              lastName: requireNonEmpty(req.body?.owner?.lastName, "owner.lastName"),
              email: requireNonEmpty(req.body?.owner?.email, "owner.email"),
            },
          },
          optionalReason(req.body?.reason, "first shop onboarding created")
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.patch("/partners/:partnerId/first-shop/location", async (req, res) => {
    try {
      const actor = actorOf(req);
      const partnerId = String(req.params.partnerId);
      // Never accept a browser-selected location here. The guided flow must edit the exact
      // Main-location record that readiness and Supplies treat as canonical, otherwise a
      // multi-location Partner could "complete" a different shop floor while remaining blocked.
      const snapshot = await svc.getFirstShopOnboarding(partnerId);
      if (!snapshot.mainLocation) {
        throw new G5RequestError("PARTNER_NOT_FOUND", "No active Main location is available for this Partner.");
      }
      mutationResponse(
        res,
        actor.requestId,
        await svc.updateFirstShopDeliveryAddress(
          actor,
          partnerId,
          snapshot.mainLocation.id,
          {
            line1: requireNonEmpty(req.body?.deliveryAddress?.line1, "deliveryAddress.line1"),
            line2: optionalText(req.body?.deliveryAddress?.line2, "deliveryAddress.line2", 200),
            city: requireNonEmpty(req.body?.deliveryAddress?.city, "deliveryAddress.city"),
            postcode: requireNonEmpty(req.body?.deliveryAddress?.postcode, "deliveryAddress.postcode"),
            country: requireNonEmpty(req.body?.deliveryAddress?.country, "deliveryAddress.country"),
          },
          optionalReason(req.body?.reason, "Main location delivery address updated")
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.put("/partners/:partnerId/first-shop/operations-contact", async (req, res) => {
    try {
      const actor = actorOf(req);
      mutationResponse(
        res,
        actor.requestId,
        await svc.upsertFirstShopOperationsContact(
          actor,
          String(req.params.partnerId),
          {
            fullName: requireNonEmpty(req.body?.fullName, "fullName"),
            email: requireNonEmpty(req.body?.email, "email"),
          },
          optionalReason(req.body?.reason, "primary operations contact updated")
        )
      );
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
          String(req.params.partnerId),
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

  /** Correct a PENDING invitation and re-issue it (revokes the outstanding token). Reason required. */
  r.patch("/partners/:partnerId/users/:userId/invitation", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.amendPendingInvitation(
          actor,
          req.params.partnerId,
          req.params.userId,
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

  r.post("/partners/:partnerId/users/:userId/copy-invitation-link", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.copyPartnerInvitationLink(actor, req.params.partnerId, req.params.userId, reason)
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

  // AG-3b: changing a partner user's role hands over or removes authority inside that shop.
  r.post("/partners/:partnerId/users/:userId/role", requireAdminStepUp(), async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.changePartnerUserRole(
          actor,
          String(req.params.partnerId),
          String(req.params.userId),
          requirePartnerUserRole(req.body?.role),
          reason
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  // AG-3b: suspending or removing a partner user ends their access immediately.
  r.post("/partners/:partnerId/users/:userId/status", requireAdminStepUp(), async (req, res) => {
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
        await svc.setPartnerUserStatus(actor, String(req.params.partnerId), String(req.params.userId), status, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Email the user a password-reset link. No password is ever set, shown or stored by the admin. */
  // AG-3b: initiating a password reset mints a credential-recovery link for somebody else's account.
  r.post("/partners/:partnerId/users/:userId/password-reset", requireAdminStepUp(), async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.sendPartnerUserPasswordReset(actor, String(req.params.partnerId), String(req.params.userId), reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * Void a Card Job whose capture geometry cannot be recovered.
   *
   * The only route by which a card HOLDING EVIDENCE can be closed. Station cancellation refuses
   * such a card on purpose (`JOB_HAS_EVIDENCE`) — throwing away a photographed card is not an
   * operator decision. But a card whose sessions predate the 0091 acquisition-region snapshot can
   * neither finish (its two sides would come from unknown, possibly different rectangles) nor
   * cancel, and it blocks its station from recalibrating for as long as it stays open.
   *
   * Releases the Grading Credit once, preserves the MV number for ever, and LEAVES THE EVIDENCE
   * IN PLACE — this closes a job, it does not rewrite what was captured.
   */
  // AG-3b: closing somebody's paid-for card and returning its credit is a money-and-record event.
  r.post("/partners/:partnerId/card-jobs/:cardJobId/void", requireAdminStepUp(), async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.voidPartnerCardJob(actor, String(req.params.partnerId), String(req.params.cardJobId), reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * PERMANENTLY DELETE a setup-only Partner.
   *
   * Layered on purpose, and no layer is redundant:
   *   requireSuperAdmin        (router-wide) only MintVault's owner-level admin reaches this at all
   *   requireAdminStepUp       a fresh re-authentication, as suspending a Partner already demands
   *   partnerDeleteRateLimit   a handful an hour, far below the general mutation budget
   *   requireReason            a written reason, kept on the tombstone that outlives the Partner
   *   confirmLegalName         the operator types the shop's exact name, proving WHICH shop
   *   the service               re-assesses under a row lock and refuses anything with history
   *
   * The service returns a friendly PARTNER_DELETE_BLOCKED with the operator-facing cause rather than
   * letting a database foreign-key violation reach the screen.
   */
  r.post(
    "/partners/:partnerId/permanent-delete",
    requireAdminStepUp(),
    partnerDeleteRateLimit,
    async (req, res) => {
      try {
        const actor = actorOf(req);
        const reason = requireReason(req.body?.reason);
        const confirmLegalName = requireNonEmpty(req.body?.confirmLegalName, "confirmLegalName");
        const { deletePartnerPermanently } = await import("./partner-deletion-service");
        mutationResponse(
          res,
          actor.requestId,
          await deletePartnerPermanently(actor, String(req.params.partnerId), { reason, confirmLegalName })
        );
      } catch (err) {
        sendError(res, err);
      }
    }
  );

  /**
   * ARM this shop's onboarding TEST CARD — the next new card scanned at this shop becomes the test.
   *
   * Not step-up gated, unlike deletion: arming destroys nothing, spends nothing and is superseded by
   * the very next card. What it DOES do is authorise one ordinary Grading Credit to be labelled as a
   * test, so it takes a written reason and is recorded in the management-audit ledger under its own
   * action name (0110) rather than folded into a neighbouring one.
   */
  r.post("/partners/:partnerId/first-shop/test-card/arm", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "onboarding test card armed");
      mutationResponse(res, actor.requestId, await svc.armOnboardingTestCard(actor, String(req.params.partnerId), reason));
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Clear the user's second factor and force re-enrolment. Revokes sessions. */
  // AG-3b: clearing somebody's second factor removes a security control from their account.
  r.post("/partners/:partnerId/users/:userId/reset-mfa", requireAdminStepUp(), async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.resetPartnerUserMfa(actor, String(req.params.partnerId), String(req.params.userId), reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  // AG-3b: signing a partner user out of everything is a security action.
  r.post("/partners/:partnerId/users/:userId/revoke-sessions", requireAdminStepUp(), async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "partner user sessions revoked");
      mutationResponse(
        res,
        actor.requestId,
        await svc.revokePartnerUserSessions(actor, String(req.params.partnerId), String(req.params.userId), reason)
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

  /** Rename the organisation. Reason required; optimistic-locked on the shared profile version. */
  r.patch("/partners/:partnerId/legal-name", async (req, res) => {
    try {
      const actor = actorOf(req);
      const legalName = requireNonEmpty(req.body?.legalName, "legalName");
      const version = requireVersion(req.body?.expectedVersion);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.updatePartnerLegalName(actor, req.params.partnerId, legalName, version, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  // AG-3b: suspending a partner organisation stops every shop floor it owns.
  r.post("/partners/:partnerId/status", requireAdminStepUp(), async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      const version = requireVersion(req.body?.expectedVersion);
      const status = req.body?.status;
      if (!isPartnerStatus(status)) throw new G5RequestError("INVALID_PARTNER_STATUS", "Unknown partner status.");
      mutationResponse(
        res,
        actor.requestId,
        await svc.changeStatus(actor, String(req.params.partnerId), status, version, reason)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  /* ------------------------------------------------------------------------------------------
   * AG-1 — MULTI-LOCATION.
   *
   * These are the routes that were simply missing. partner_locations has been multi-location
   * capable since 0001, but createPartner() inserted one 'Main location' and nothing anywhere
   * could add a second — which silently capped stations to one shop floor and made the Scanner's
   * location selector dead code.
   *
   * Super Admin only, like every other route on this router (requireSuperAdmin +
   * requirePartnerAdminCapability applied at mount). Partner Owners and Managers reach their own
   * locations through the EXISTING portal surfaces and the EXISTING RBAC — no new partner-side
   * authority is granted here.
   * ---------------------------------------------------------------------------------------- */
  r.get("/partners/:partnerId/locations", async (req, res) => {
    try {
      res.json({ locations: await svc.listPartnerLocations(req.params.partnerId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/partners/:partnerId/google-presence", async (req, res) => {
    try {
      res.json(await getAdminGooglePresence(req.params.partnerId));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/partners/:partnerId/locations", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "location created");
      mutationResponse(
        res,
        actor.requestId,
        await svc.createPartnerLocation(
          actor,
          req.params.partnerId,
          { name: req.body?.name, address: req.body?.address },
          reason
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.patch("/partners/:partnerId/locations/:locationId", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = optionalReason(req.body?.reason, "location updated");
      mutationResponse(
        res,
        actor.requestId,
        await svc.updatePartnerLocation(
          actor,
          req.params.partnerId,
          req.params.locationId,
          { name: req.body?.name, address: req.body?.address },
          reason
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  /*
   * Suspending a shop floor stops capture there. A REASON IS MANDATORY — unlike creation, this
   * takes work away from people, and the audit row is the only thing that can later distinguish a
   * deliberate closure from a mistake.
   */
  r.post("/partners/:partnerId/locations/:locationId/status", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.setPartnerLocationStatus(
          actor,
          req.params.partnerId,
          req.params.locationId,
          String(req.body?.status ?? ""),
          reason
        )
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  /* Which shop floors a named user may operate at. Replaces the whole set in one decision. */
  r.post("/partners/:partnerId/users/:userId/locations", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(
        res,
        actor.requestId,
        await svc.setPartnerUserLocations(actor, req.params.partnerId, req.params.userId, req.body?.locationIds, reason)
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

function parseTargetTenantIds(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new G5RequestError("VALIDATION_ERROR", "targetTenantIds must be an array.");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = raw.map((id) => {
    if (typeof id !== "string" || !uuid.test(id)) {
      throw new G5RequestError("VALIDATION_ERROR", "targetTenantIds must contain valid organisation ids.");
    }
    return id;
  });
  return ids.length ? Array.from(new Set(ids)) : undefined;
}

/** Additive registration into the existing MintVault admin app (G5 partner management). */
export function registerPartnerManagementRoutes(app: Express): void {
  app.use("/api/super-admin/partner-management", partnerManagementRouter());
}
