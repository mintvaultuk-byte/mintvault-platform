/**
 * Partner Portal — API routes (Phase 1). Mounted under /api/partner only. No admin/staff/VQ/cert
 * routes are ever mounted here (see app.ts + the route-isolation test).
 */
import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  partnerLogin,
  partnerLogout,
  revokeAllSessions,
  markSessionMfaPassed,
  createPasswordResetToken,
  consumePasswordResetToken,
} from "./auth";
import {
  requirePartnerAuth,
  requirePartnerCapability,
  setPartnerCookie,
  clearPartnerCookie,
  PARTNER_COOKIE,
  requireNotViewOnly,
  requireNotSensitiveFrozen,
} from "./session";
import {
  partnerLoginIpLimiter,
  partnerLoginLimiter,
  partnerMfaLimiter,
  partnerMfaAccountLimiter,
  partnerResetLimiter,
  partnerLocationSwitchLimiter,
  partnerInviteLimiter,
  partnerTeamMutationLimiter,
} from "./rate-limit";
import { withTenant, partnerRuntimeQuery } from "./db";
import { auditInOwnTxn, writePartnerSecurity } from "./audit";
import { recoveryHash, mfaEncryptionConfigured } from "./mfa";
import { resetDeliveryConfigured, deliverResetToken } from "./delivery";
import { switchLocation } from "./location";
import {
  acceptPartnerInvitation,
  getFirstShopOnboarding,
  updateFirstShopDeliveryAddress,
  upsertFirstShopOperationsContact,
} from "./partner-management-service";
import { toG5Error, g5StatusFor, requireReason, optionalReason, G5RequestError } from "./partner-management-errors";
import { getUserRoles } from "./permissions";
import {
  changeTeamMemberRole,
  deliverTeamInvitationAfterCommit,
  inviteTeamMember,
  listTeamMembers,
  requirePortalTeamRole,
  resendTeamInvitation,
  revokeTeamInvitation,
  revokeTeamMemberSessions,
  setTeamMemberStatus,
} from "./team-service";
import {
  mfaEnrolStart,
  mfaEnrolConfirm,
  mfaEnrolRestart,
  mfaEnrolCancel,
  mfaRegenerateRecovery,
  verifyActiveTotpNoReplay,
  getMfaStatus,
  verifyStepUp,
} from "./mfa-service";
import { hasRecentStepUp, recordStepUp, requireRecentAuth, STEP_UP_WINDOW_MINUTES } from "./step-up";
import {
  canPurchaseCredits,
  checkoutStripeEnvironmentStatus,
  completePartnerCreditCheckoutOperation,
  findActivePartnerCreditCheckoutOperation,
  listCreditPacks,
  presentPartnerCreditCheckoutOperation,
  reservePartnerCreditCheckoutOperation,
  resolvePackForCheckout,
  validateStripePriceForCheckout,
} from "./credit-purchase-service";
import { getPartnerOperations } from "./dashboard-operations-service";
import {
  getPartnerCreditView,
  getPartnerPortalContext,
  listOwnPartnerSessions,
  revokeOwnPartnerSession,
} from "./portal-view-service";
import {
  beginGoogleBusinessConnection,
  completeGoogleBusinessOAuth,
  confirmGoogleBusinessCandidate,
  disconnectGoogleBusinessConnection,
  getGooglePresenceCapability,
  getGooglePresenceStatus,
  GooglePresenceError,
  refreshGoogleBusinessConnection,
} from "./google-presence-service";
import {
  getPartnerPublicProfileStatus,
  PublicPublicationError,
  savePartnerPublicDraft,
} from "./public-publication-service";

function sendPartnerTeamError(res: import("express").Response, err: unknown): void {
  const g5 = toG5Error(err);
  res.status(g5StatusFor(g5.code)).json({ error: { code: g5.code, message: g5.message } });
}

function noStore(res: import("express").Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

function requiredPartnerOnboardingText(raw: unknown, field: string, max = 500): string {
  if (typeof raw !== "string") throw new G5RequestError("VALIDATION_ERROR", `${field} is required.`);
  const value = raw.trim();
  if (!value || value.length > max) throw new G5RequestError("VALIDATION_ERROR", `${field} is invalid.`);
  return value;
}

function optionalPartnerOnboardingText(raw: unknown, field: string, max = 200): string | null {
  if (raw == null || raw === "") return null;
  return requiredPartnerOnboardingText(raw, field, max);
}

/**
 * First-shop edits are self-service for the canonical Partner Owner, never a browser-supplied
 * tenant or a broad team-management permission. The admin service remains the single writer and
 * audit authority; this helper only derives its actor from the authenticated session.
 */
export async function currentPartnerOwnerActor(req: import("express").Request) {
  const principal = req.partner;
  if (!principal) throw new G5RequestError("UNAUTHENTICATED", "Sign in to continue.");
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const roles = await getUserRoles(client, principal.userId);
    if (!roles.includes("PARTNER_OWNER")) {
      throw new G5RequestError("FORBIDDEN", "Only the Partner Owner can confirm first-shop setup.");
    }
    const user = await client.query<{ email: string }>("SELECT email FROM partner_users WHERE id=$1", [principal.userId]);
    if (!user.rows[0]?.email) throw new G5RequestError("UNAUTHENTICATED", "Partner account details are unavailable.");
    return {
      actorUserId: principal.userId,
      actorEmail: user.rows[0].email,
      requestId: String(req.headers["x-request-id"] ?? `partner-onboarding-${req.method}-${Date.now()}`),
      idempotencyKey: partnerOriginatedIdempotencyKey(req.body?.idempotencyKey, principal.tenantId),
    };
  });
}

/**
 * Namespace and validate a CUSTOMER-supplied idempotency key before it can reach the Super Admin
 * management ledger.
 *
 * `partner_management_audit.idempotency_key` is a GLOBAL namespace: priorSuccess() matches on the
 * key alone, and uq_partner_management_audit_idem is unique on the key alone. Until first-shop
 * onboarding added self-service Owner routes, only MintVault staff could name a key. Passing a raw
 * body value through would let any Partner Owner register a key of their choosing and thereby make
 * a LATER Super Admin mutation carrying the same key short-circuit to
 * `{ ok: true, alreadyCompleted: true }` without executing — including the containment actions
 * (suspend partner, revoke invitation, reset MFA, revoke sessions). The ledger is append-only and
 * the index is unique-on-success, so such a collision would be permanent.
 *
 * Two defences, deliberately both: the key is validated to the same shape createFirstShopOnboarding
 * already enforces, and it is prefixed with the authenticated tenant so a partner-originated key can
 * never be spelled the same way as a staff-originated one. The tenant comes from the session, never
 * the body.
 */
function partnerOriginatedIdempotencyKey(raw: unknown, tenantId: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(value)) {
    throw new G5RequestError("VALIDATION_ERROR", "idempotencyKey is invalid.");
  }
  return `partner:${tenantId}:${value}`;
}

function sendGooglePresenceError(res: import("express").Response, err: unknown): void {
  if (err instanceof GooglePresenceError) {
    const messages: Record<GooglePresenceError["code"], string> = {
      forbidden: "Only a Partner Owner can manage the Google Business connection.",
      invalid_request: "The Google Business request was invalid.",
      location_unavailable: "That location or Google listing is not available.",
      already_connected: "This location already has a Google Business connection.",
      oauth_invalid: "Google authorisation could not be verified. Start the connection again.",
      oauth_replayed: "This Google authorisation link has expired or has already been used.",
      candidate_expired: "That Google listing choice has expired. Start the connection again.",
      listing_already_connected: "That Google listing is already connected to a MintVault Partner location.",
      operation_frozen: "Google Business changes are paused for this location.",
      provider_unavailable: "Google Business is temporarily unavailable. Your MintVault profile is unaffected.",
    };
    res.status(err.status).json({ error: { code: err.code, message: messages[err.code] } });
    return;
  }
  console.error("[partner google] operation failed:", (err as Error)?.message ?? "unknown");
  res.status(503).json({
    error: { code: "google_business_unavailable", message: "Google Business is temporarily unavailable." },
  });
}

function sendPublicPublicationError(res: import("express").Response, err: unknown): void {
  if (err instanceof PublicPublicationError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error("[partner-publication] request failed:", (err as Error)?.message ?? "unknown");
  res.status(503).json({ error: { code: "PUBLIC_PROFILE_UNAVAILABLE", message: "Public profiles are temporarily unavailable." } });
}

// The actor-bound Partner limiter below is the primary control because OAuth
// query values and source IPs are attacker-controlled. Keep this conventional
// edge limiter too: it bounds burst traffic before callback authorization and
// is recognisable to the static security gate that protects this exposed route.
const googleCallbackRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

/** OAuth returns as a top-level navigation, so the standard JSON mutation
 * guards would strand the browser on a JSON error document. Enforce the same
 * three gates before state consumption/token exchange and redirect to an
 * actionable, secret-free Partner page on denial. */
async function requireGoogleCallbackMutation(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction
): Promise<void> {
  const principal = req.partner;
  if (!principal) {
    res.redirect(303, "/partner/login");
    return;
  }
  if (principal.viewOnly || principal.sensitiveDisabled) {
    res.redirect(303, "/partner/public-profile?google=frozen");
    return;
  }
  try {
    if (await hasRecentStepUp(principal.sessionId)) {
      next();
      return;
    }
  } catch (err) {
    console.error("[partner google] callback step-up verification failed:", (err as Error).message);
  }
  res.redirect(303, "/partner/public-profile?google=step_up_required");
}

/**
 * Denial codes worth an audit row. A denied privilege escalation is the single most useful
 * forensic signal this surface produces, so it must survive the rollback that the denial itself
 * triggers — every team mutation runs inside withTenant(), whose catch issues ROLLBACK, so a row
 * written on that client is always erased. auditInOwnTxn() opens its own transaction on a fresh
 * pooled client AFTER the mutation transaction has already rolled back, so the row commits.
 */
const AUDITED_DENIAL_CODES = new Set([
  "FORBIDDEN",
  "FINAL_OWNER_REQUIRED",
  "INVALID_STATUS_TRANSITION",
  "DUPLICATE_PARTNER_USER",
  "PARTNER_USER_NOT_FOUND",
  "PARTNER_UNAVAILABLE",
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
]);

/**
 * Record a denied team-management action. Never allowed to change the response: an audit failure
 * is logged, not surfaced, so a denial can never become a 500.
 */
async function auditTeamDenial(req: import("express").Request, action: string, err: unknown): Promise<void> {
  const g5 = toG5Error(err);
  if (!AUDITED_DENIAL_CODES.has(g5.code)) return;
  const principal = req.partner;
  if (!principal?.tenantId) return; // no authenticated tenant context → nothing to attribute it to
  try {
    await auditInOwnTxn({
      tenantId: principal.tenantId,
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
      action: `${action}_denied`,
      recordType: "partner_user",
      recordId: typeof req.params?.id === "string" ? req.params.id : null,
      ip: req.ip ?? null,
      correlationId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null,
      reason: g5.code, // stable code only — never the target email or any free text
    });
  } catch (auditErr) {
    console.error("[partner team] denial audit write failed:", (auditErr as Error).message);
  }
}

/** Send the denial response and durably record it. */
function denyTeamAction(
  req: import("express").Request,
  res: import("express").Response,
  action: string,
  err: unknown
): void {
  sendPartnerTeamError(res, err);
  void auditTeamDenial(req, action, err);
}

export function partnerApiRouter(): Router {
  const r = Router();

  /**
   * TENANT-SCOPED RESPONSES ARE NEVER CACHEABLE — applied by construction, for every route on this
   * router, rather than remembered per handler.
   *
   * `noStore()` was called by hand in only five places (/me, /session and the MFA secret/recovery
   * responses), while `GET /credits` (wallet balance + ledger), `/sessions` (session ids, IPs),
   * `/dashboard` (org legal name, status, accreditation), `/users` (full team roster) and
   * `/locations` carried NO Cache-Control and no Vary at all. With neither header present, RFC 9111
   * §4.2.2 permits a shared cache to apply heuristic freshness — and the deployment shape here is
   * literally "a Mac behind a shop's network", where a corporate proxy or any CDN placed in front
   * could serve one tenant's credit ledger to another.
   *
   * `Vary: Cookie` is set alongside as the second line of defence: no-store already forbids storage,
   * but any cache that mishandles it must still key on the session cookie rather than the URL.
   */
  r.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    next();
  });

  // ---- auth ----
  // SHADOWED DUPLICATE — the served implementation is server/partner/public-routes.ts, kept ahead of
  // this router by the registration-order invariant at server/routes.ts:2798. It carries the SAME
  // limiter pair anyway, in the SAME order, so the protection does not depend on that invariant
  // holding: partnerLoginIpLimiter (IP-only, always applied) must bind BEFORE partnerLoginLimiter,
  // whose key includes the caller-supplied `email` and on its own hands one source IP a fresh
  // budget per address it tries. If this route ever stops being shadowed it is still bounded.
  //
  // GATE DIFFERENCE, stated exactly: this router is NOT ungated. partnerPortalRouter
  // (server/partner/mount.ts) composes it behind requirePartnerRuntimeConfig, requireDefinerModel,
  // requireNoEmergencyStop and requirePortalEnabled, so the emergency stop and partner_portal_enabled
  // both apply here too. The ONE gate this handler lacks is the per-route partner_login_enabled
  // check that public-routes.ts performs before authenticating.
  r.post("/auth/login", partnerLoginIpLimiter, partnerLoginLimiter, async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const result = await partnerLogin(email, password, req.ip);
    if (!result.ok) {
      // Parity with public-routes.ts: a missing MFA projection is a deployment fault
      // (503), not a credential fault.
      if (result.reason === "mfa_state_unavailable") {
        res.status(503).json({ error: "partner login unavailable" });
        return;
      }
      // generic — never disclose which of unknown/invalid/locked/suspended (except a soft MFA hint)
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    setPartnerCookie(res, result.sessionToken!);
    // RESPONSE SHAPE IS DELIBERATELY UNCHANGED. Whether the outstanding second step is enrolment or
    // a code challenge is reported by GET /session (`mfaEnrolmentRequired`), which the client calls
    // immediately after login anyway. Keeping that bit off this response avoids widening the
    // login contract that tests/partner-login-rate-limit-integration.test.ts asserts exactly.
    res.json({ ok: true, mfaRequired: !!result.mfaPending });
  });

  r.post("/auth/mfa", partnerMfaLimiter, partnerMfaAccountLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    if (req.partner.mfaPassed) {
      res.json({ ok: true });
      return;
    }
    if (!mfaEncryptionConfigured()) {
      res.status(503).json({ error: "mfa unavailable" }); // fail closed with no key
      return;
    }
    const { code, recoveryCode } = req.body ?? {};
    const ok = await withTenant({ tenantId: req.partner.tenantId }, async (c) => {
      if (typeof recoveryCode === "string" && recoveryCode) {
        const rc = await c.query(
          "UPDATE partner_recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id",
          [req.partner!.userId, recoveryHash(recoveryCode)]
        );
        return (rc.rowCount ?? 0) === 1;
      }
      if (typeof code === "string") {
        return verifyActiveTotpNoReplay(c, req.partner!.userId, code); // F3: replay-protected
      }
      return false;
    });
    if (!ok) {
      /*
       * A wrong second factor used to write NOTHING — no counter, no audit row, no security event —
       * so a sustained guessing campaign against one account was invisible to the account holder and
       * to us. The account-keyed limiter above is the bound; this is the evidence. Written
       * best-effort: failing to record the attempt must never turn a refused login into a 500.
       */
      await withTenant({ tenantId: req.partner.tenantId }, async (c) =>
        writePartnerSecurity(c, {
          tenantId: req.partner!.tenantId,
          severity: "medium",
          kind: "partner_mfa_failed",
          detail: { userId: req.partner!.userId, method: typeof recoveryCode === "string" && recoveryCode ? "recovery_code" : "totp" },
        })
      ).catch(() => {});
      res.status(401).json({ error: "invalid code" });
      return;
    }
    if (!(await markSessionMfaPassed(req.partner.tenantId, req.partner.sessionId, req.partner.userId))) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    res.json({ ok: true });
  });

  r.post("/auth/logout", async (req, res) => {
    if (req.partner) await partnerLogout(req.partner.tenantId, req.partner.sessionId);
    clearPartnerCookie(res);
    res.json({ ok: true });
  });

  r.post("/auth/revoke-all", requirePartnerAuth, requireNotSensitiveFrozen, async (req, res) => {
    const n = await revokeAllSessions(req.partner!.tenantId, req.partner!.userId);
    clearPartnerCookie(res);
    res.json({ ok: true, revoked: n });
  });

  r.post("/auth/password-reset/request", partnerResetLimiter, async (req, res) => {
    const { email } = req.body ?? {};
    // Always generic (never reveal account existence). If the email resolves to a single active
    // user, mint a single-use token, delivered OUT-OF-BAND (email) — never returned in the response.
    if (typeof email === "string" && email) {
      try {
        const { rows } = await partnerRuntimeQuery<{
          user_id: string;
          tenant_id: string;
          user_status: string;
          org_status: string;
        }>("SELECT user_id, tenant_id, user_status, org_status FROM partner_auth_lookup($1)", [email]);
        if (
          rows.length === 1 &&
          rows[0].user_status === "ACTIVE" &&
          rows[0].org_status === "ACTIVE" &&
          resetDeliveryConfigured()
        ) {
          const token = await createPasswordResetToken(rows[0].tenant_id, rows[0].user_id);
          // NULL means a fresh link already exists and was preserved (denial-of-recovery guard).
          if (token !== null) {
            await deliverResetToken(email, token); // out-of-band; token never returned in the response
          }
        }
      } catch {
        /* swallow — response stays generic regardless */
      }
    }
    res.json({ ok: true });
  });

  r.post("/auth/password-reset/consume", partnerResetLimiter, async (req, res) => {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== "string" || typeof newPassword !== "string" || newPassword.length < 10) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    // tenant is derived from the token server-side (L6) — no client tenantId.
    const ok = await consumePasswordResetToken(token, newPassword);
    res.status(ok ? 200 : 400).json({ ok });
  });

  r.post("/invitations/accept", partnerResetLimiter, async (req, res) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "invalid invitation" });
      return;
    }
    const result = await acceptPartnerInvitation(token, password);
    if (!result.ok) {
      res.status(400).json({ error: "invalid invitation" });
      return;
    }
    res.json({ ok: true });
  });

  // ---- session ----
  const sessionIdentity = async (req: import("express").Request, res: import("express").Response) => {
    // Identity + permissions + shop-facing names. Same no-store discipline as every other
    // partner GET in this router — this response must never sit in a shared/proxy cache.
    noStore(res);
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    // L1: withhold identity + permissions until MFA is complete — a password-only (mfa-pending)
    // session must not disclose the account's full authorization profile.
    //
    // P0-E: the ONE extra bit added here is `mfaEnrolmentRequired` — whether the outstanding second
    // step is enrolment or a code challenge. Without it the Portal cannot route a first owner to the
    // only step they can complete. It is not an authorization profile, it is reachable only with a
    // valid session cookie, and the user could infer it anyway by calling /mfa/enrol.
    const status = await getMfaStatus({ tenantId: req.partner.tenantId, userId: req.partner.userId });
    if (!req.partner.mfaPassed) {
      res.json({ mfaPassed: false, mfaRequired: true, mfaEnrolmentRequired: status.enrolmentRequired });
      return;
    }
    try {
      const context = await getPartnerPortalContext(req.partner);
      // no secrets — principal, MFA posture and shop-facing identity summary only.
      // The four mfa* fields come from origin/main (P0-E) and the ...context spread from this
      // branch; their key sets are disjoint. The mfa* fields are listed AFTER the spread so a
      // future portal-context key can never silently override the authoritative MFA posture.
      res.json({
        userId: req.partner.userId,
        tenantId: req.partner.tenantId,
        locationId: req.partner.locationId,
        mfaPassed: req.partner.mfaPassed,
        viewOnly: req.partner.viewOnly,
        permissions: [...req.partner.permissions],
        ...context,
        mfaRequired: status.required,
        mfaEnrolled: status.enrolled,
        mfaEnrolmentRequired: status.enrolmentRequired,
        recoveryCodesRemaining: status.recoveryCodesRemaining,
      });
    } catch {
      res.status(503).json({ error: { code: "portal_context_unavailable", message: "Shop details are unavailable." } });
    }
  };
  // `/me` is the stable identity contract; `/session` remains the backwards-compatible alias.
  r.get("/me", sessionIdentity);
  r.get("/session", sessionIdentity);

  r.get("/credits", requirePartnerCapability("partner.credits.view"), async (req, res) => {
    try {
      res.json(await getPartnerCreditView(req.partner!));
    } catch (err) {
      console.error("[partner credits] projection failed:", (err as Error).message);
      res
        .status(500)
        .json({ error: { code: "credit_view_unavailable", message: "Credit information is unavailable." } });
    }
  });

  /**
   * The Grading Credit pack catalogue.
   *
   * Readable by anyone who can see credits, so the dashboard can show what is available and, when
   * pricing is not yet configured, say so honestly instead of hiding the feature. `purchasable` is
   * false for every pack until the owner records a Stripe Price id — the UI must gate the buy
   * control on that flag, not on the pack merely existing.
   */
  r.get("/credits/packs", requirePartnerCapability("partner.credits.view"), async (_req, res) => {
    try {
      res.json({ packs: await listCreditPacks() });
    } catch (err) {
      console.error("[partner credits] pack catalogue failed:", (err as Error).message);
      res.status(500).json({ error: { code: "credit_packs_unavailable", message: "Credit packs are unavailable." } });
    }
  });

  /**
   * Begin a Grading Credit purchase.
   *
   * THIS ROUTE GRANTS NOTHING. It creates a Stripe Checkout Session and returns its URL. Credits
   * appear only when the verified webhook fulfils the payment — so a user who abandons checkout,
   * loses connectivity, or replays the success page a hundred times receives exactly what they paid
   * for and nothing more.
   *
   * The pack CODE is the only client input, and the credit quantity is looked up server-side from
   * it; quantity is never taken from the request, and never from session metadata on the way back.
   *
   * requireNotViewOnly / requireNotSensitiveFrozen are applied because spending money is a sensitive
   * mutation: a view-only or emergency-frozen principal must not be able to start one.
   */
  r.post(
    "/credits/checkout",
    requirePartnerCapability("partner.credits.purchase"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    // AG-3: spending the shop's money is the single most consequential thing a partner session can
    // do, and it is irreversible once Stripe has the payment. Placed AFTER the capability guard so
    // a role that may never buy is told that, rather than asked for a password that would not help.
    requireRecentAuth(),
    async (req, res) => {
      const principal = req.partner!;
      try {
        /*
         * A grading role never buys, even if the purchase permission was granted by mistake.
         * The permission gate above is the primary control; this is the deliberate second one,
         * because "GRADER cannot buy" is a business rule rather than a configuration choice.
         */
        const roles = await withTenant({ tenantId: principal.tenantId }, async (c) => {
          const { rows } = await c.query<{ code: string }>(
            `SELECT r.code FROM partner_user_roles ur
               JOIN partner_roles r ON r.id = ur.role_id
              WHERE ur.tenant_id=$1 AND ur.user_id=$2`,
            [principal.tenantId, principal.userId]
          );
          return rows.map((x) => x.code);
        });
        if (!roles.some((role) => canPurchaseCredits(role, principal.permissions))) {
          res.status(403).json({
            error: { code: "forbidden", message: "Your role cannot buy Grading Credits." },
          });
          return;
        }

        const packCode = typeof req.body?.packCode === "string" ? req.body.packCode : "";
        const checkoutEnvironment = checkoutStripeEnvironmentStatus();
        if (!checkoutEnvironment.ok || checkoutEnvironment.environment === null) {
          const error = new Error(checkoutEnvironment.message || "Stripe mode is not configured.") as Error & {
            code?: string;
          };
          error.code = checkoutEnvironment.code || "STRIPE_ENV_UNDECLARED";
          throw error;
        }

        /*
         * Reuse a live operation BEFORE looking at the mutable pack catalogue. A pack may be
         * disabled or its Stripe Price rotated after a buyer was sent to Checkout; that must stop
         * only NEW purchases, never strand this already server-created operation.
         */
        let operation = await findActivePartnerCreditCheckoutOperation({
          tenantId: principal.tenantId,
          initiatingUserId: principal.userId,
          packCode,
          stripeEnvironment: checkoutEnvironment.environment,
        });

        if (!operation) {
          const pack = await resolvePackForCheckout(packCode);
          const { getUncachableStripeClient } = await import("../stripeClient");
          const stripe = await getUncachableStripeClient();
          const stripePrice = await stripe.prices.retrieve(pack.stripePriceId!);
          const priceFields = stripePrice as {
            id?: unknown;
            currency?: unknown;
            unit_amount?: unknown;
            tax_behavior?: unknown;
            livemode?: unknown;
            active?: unknown;
          };
          const stripeEnvironment = validateStripePriceForCheckout(pack, {
            id: typeof priceFields.id === "string" ? priceFields.id : null,
            currency: typeof priceFields.currency === "string" ? priceFields.currency : null,
            unitAmount: typeof priceFields.unit_amount === "number" ? priceFields.unit_amount : null,
            taxBehavior: typeof priceFields.tax_behavior === "string" ? priceFields.tax_behavior : null,
            livemode: typeof priceFields.livemode === "boolean" ? priceFields.livemode : null,
            active: typeof priceFields.active === "boolean" ? priceFields.active : null,
          });
          operation = await reservePartnerCreditCheckoutOperation({
            tenantId: principal.tenantId,
            packCode: pack.code,
            initiatingUserId: principal.userId,
            stripePriceId: pack.stripePriceId!,
            stripeCurrency: pack.stripeCurrency!,
            stripeEnvironment,
            credits: pack.credits,
            pricePence: pack.pricePence,
            taxBehavior: "inclusive",
            // A creating operation is deliberately durable long enough for a request timeout to
            // retry through the same Stripe idempotency key. Stripe returns its exact expiry below.
            checkoutExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
        }

        const { getUncachableStripeClient } = await import("../stripeClient");
        const stripe = await getUncachableStripeClient();
        const appUrl = process.env.APP_URL || "https://mintvaultuk.com";
        if (!operation.checkoutUrl) {
          let session;
          if (operation.stripeSessionId) {
            // 0099 is compatible with a pre-existing 0097 row whose Session was recorded before
            // URLs were persisted: retrieve that same Session, never create a second one.
            session = await stripe.checkout.sessions.retrieve(operation.stripeSessionId);
          } else {
            // ONE server-derived attribution object, deliberately built once and used in both
            // places. The Checkout Session metadata serves the successful-purchase fulfilment
            // webhook; a refund or dispute is emitted from the PaymentIntent/Charge object instead,
            // so the SAME identifiers must reach payment_intent_data or charge.refunded /
            // charge.dispute.created cannot attribute the event to a tenant. Sharing the constant
            // is what makes "the same attribution" provable rather than a coincidence of two
            // literals that could drift apart. The webhook reads ONLY these keys: credits and price
            // remain in the immutable server-created operation, never in Stripe metadata.
            const checkoutAttribution = {
              partner_tenant_id: principal.tenantId,
              partner_pack_code: operation.packCode,
              partner_initiating_user_id: principal.userId,
              partner_checkout_operation_key: operation.checkoutOperationKey,
            };
            session = await stripe.checkout.sessions.create(
              {
                mode: "payment",
                line_items: [{ price: operation.stripePriceId, quantity: 1 }],
                metadata: checkoutAttribution,
                payment_intent_data: { metadata: checkoutAttribution },
                // success_url MUST match a real client route. `/partner/credits` is not registered
                // in App.tsx, so the partner catch-all silently redirected the returning buyer to
                // the dashboard and discarded the `?purchase=` signal. The wallet page is
                // `/partner/billing`.
                //
                // NB: that catch-all's path pattern is deliberately NOT written out here. A
                // slash-star sequence inside a comment opens a block comment as far as a naive
                // stripper is concerned, and tests/partner-main-reconciliation-merge-loss.test.ts
                // strips comments before asserting routes still exist — writing it literally
                // silently swallowed every route below this point.
                success_url: `${appUrl}/partner/billing?purchase=processing`,
                cancel_url: `${appUrl}/partner/billing?purchase=cancelled`,
              },
              { idempotencyKey: `partner-credit-checkout:${operation.checkoutOperationKey}` }
            );
          }
          if (!session.url || !session.id || !session.expires_at) {
            throw new Error("Stripe Checkout did not return a URL and expiry.");
          }
          operation = await completePartnerCreditCheckoutOperation({
            checkoutOperationKey: operation.checkoutOperationKey,
            stripeSessionId: session.id,
            checkoutUrl: session.url,
            checkoutExpiresAt: new Date(session.expires_at * 1000),
          });
        }
        res.json({ url: operation.checkoutUrl, ...presentPartnerCreditCheckoutOperation(operation) });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "PACK_NOT_FOUND" || code === "PACK_NOT_PURCHASABLE") {
          res.status(400).json({ error: { code, message: (err as Error).message } });
          return;
        }
        if (code === "STRIPE_ENV_UNDECLARED" || code === "STRIPE_ENV_MISMATCH") {
          res.status(503).json({ error: { code, message: (err as Error).message } });
          return;
        }
        if (
          code === "STRIPE_PRICE_MISMATCH" ||
          code === "STRIPE_CURRENCY_MISMATCH" ||
          code === "STRIPE_AMOUNT_MISMATCH" ||
          code === "STRIPE_TAX_BEHAVIOR_MISMATCH" ||
          code === "STRIPE_PRICE_INACTIVE" ||
          code === "CHECKOUT_INTENT_CONFLICT"
        ) {
          res.status(503).json({ error: { code, message: (err as Error).message } });
          return;
        }
        console.error("[partner credits] checkout failed:", (err as Error).message);
        res
          .status(502)
          .json({ error: { code: "checkout_unavailable", message: "Could not start checkout. Try again." } });
      }
    }
  );

  /**
   * P8 — the operational read behind the EXISTING Partner Dashboard.
   *
   * One tenant-scoped call returning the lifecycle counts, the station fleet and the shop floors.
   * Gated on `partner.dashboard.view`, which every operational role holds and the view-only ones
   * hold too — this is a READ, and read-only navigation is deliberately never step-up guarded.
   *
   * The principal supplies tenant and location; the request supplies nothing. There is no parameter
   * by which a caller can widen their own scope, which is what makes the negative tests meaningful
   * rather than decorative.
   */
  r.get("/dashboard/operations", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    try {
      res.json(await getPartnerOperations(req.partner!));
    } catch (err) {
      console.error("[partner dashboard] operations read failed:", (err as Error).message);
      res.status(500).json({
        error: { code: "operations_unavailable", message: "Operational summary is unavailable right now." },
      });
    }
  });

  /**
   * P8 — this organisation's OWN onboarding readiness.
   *
   * Reuses getPartnerOnboardingReadiness, the same computation the Super Admin console reads, called
   * with the tenant id from the SESSION. That is deliberate: a second readiness implementation would
   * be a second definition of "is this shop set up", and the two would drift — which is precisely
   * the "READY because rows exist" failure the original was written to end.
   */
  r.get("/onboarding-readiness", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    try {
      const { getPartnerOnboardingReadiness } = await import("./partner-management-service");
      const readiness = await getPartnerOnboardingReadiness(req.partner!.tenantId);
      res.json(readiness);
    } catch (err) {
      console.error("[partner dashboard] readiness read failed:", (err as Error).message);
      res
        .status(500)
        .json({ error: { code: "readiness_unavailable", message: "Setup status is unavailable right now." } });
    }
  });

  /** The Owner's guided view of the same canonical first-shop record Super Admin sees. */
  r.get("/onboarding", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    try {
      await currentPartnerOwnerActor(req);
      res.json(await getFirstShopOnboarding(req.partner!.tenantId));
    } catch (err) {
      sendPartnerTeamError(res, err);
    }
  });

  r.patch(
    "/onboarding/main-location",
    requirePartnerCapability("partner.dashboard.view"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerTeamMutationLimiter,
    async (req, res) => {
      try {
        const actor = await currentPartnerOwnerActor(req);
        const snapshot = await getFirstShopOnboarding(req.partner!.tenantId);
        if (!snapshot.mainLocation) throw new G5RequestError("PARTNER_NOT_FOUND", "No active Main location is available.");
        const result = await updateFirstShopDeliveryAddress(
          actor,
          req.partner!.tenantId,
          snapshot.mainLocation.id,
          {
            line1: requiredPartnerOnboardingText(req.body?.deliveryAddress?.line1, "Address line 1", 200),
            line2: optionalPartnerOnboardingText(req.body?.deliveryAddress?.line2, "Address line 2", 200),
            city: requiredPartnerOnboardingText(req.body?.deliveryAddress?.city, "Town or city", 120),
            postcode: requiredPartnerOnboardingText(req.body?.deliveryAddress?.postcode, "Postcode", 32),
            country: requiredPartnerOnboardingText(req.body?.deliveryAddress?.country, "Country", 120),
          },
          "Partner Owner confirmed Main location delivery address"
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_first_shop_main_location", err);
      }
    }
  );

  r.put(
    "/onboarding/operations-contact",
    requirePartnerCapability("partner.dashboard.view"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerTeamMutationLimiter,
    async (req, res) => {
      try {
        const actor = await currentPartnerOwnerActor(req);
        const result = await upsertFirstShopOperationsContact(
          actor,
          req.partner!.tenantId,
          {
            fullName: requiredPartnerOnboardingText(req.body?.fullName, "Contact name", 200),
            email: requiredPartnerOnboardingText(req.body?.email, "Operational email", 320),
          },
          "Partner Owner confirmed primary operations contact"
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_first_shop_operations_contact", err);
      }
    }
  );

  r.get("/sessions", requirePartnerAuth, async (req, res) => {
    try {
      res.json({ sessions: await listOwnPartnerSessions(req.partner!) });
    } catch (err) {
      console.error("[partner sessions] list failed:", (err as Error).message);
      res.status(500).json({ error: { code: "session_view_unavailable", message: "Sessions are unavailable." } });
    }
  });

  r.post("/sessions/:id/revoke", requirePartnerAuth, async (req, res) => {
    try {
      const revoked = await revokeOwnPartnerSession(req.partner!, String(req.params.id));
      if (!revoked) {
        res.status(404).json({ error: { code: "session_not_found", message: "Session not found." } });
        return;
      }
      res.json({ ok: true, current: String(req.params.id) === req.partner!.sessionId });
    } catch (err) {
      console.error("[partner sessions] revoke failed:", (err as Error).message);
      res.status(500).json({ error: { code: "session_revoke_failed", message: "The session could not be revoked." } });
    }
  });

  // ---- permission-gated foundation reads ----
  r.get("/dashboard", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    const data = await withTenant(
      { tenantId: req.partner!.tenantId, locationId: req.partner!.locationId },
      async (c) => {
        const org = await c.query("SELECT id, legal_name, status, accreditation_level FROM partner_organisations");
        const locs = await c.query("SELECT count(*)::int n FROM partner_locations");
        return { org: org.rows[0] ?? null, locationCount: locs.rows[0]?.n ?? 0 };
      }
    );
    res.json(data);
  });

  r.get("/users", requirePartnerCapability("partner.users.view"), async (req, res) => {
    try {
      const rows = await withTenant({ tenantId: req.partner!.tenantId }, (c) => listTeamMembers(c));
      res.json({ users: rows });
    } catch (err) {
      sendPartnerTeamError(res, err);
    }
  });

  r.post(
    "/users",
    partnerInviteLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    // AG-3: an invitation mints a credential that can become a login.
    requireRecentAuth(),
    async (req, res) => {
      try {
        const reason = optionalReason(req.body?.reason, "Partner team member invited");
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          inviteTeamMember(c, req.partner!, req.body, reason)
        );
        await deliverTeamInvitationAfterCommit(req.partner!.tenantId, result.invitationId, result.delivery);
        const { delivery: _delivery, ...safeResult } = result;
        res.json({ ok: true, result: safeResult });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_invited", err);
      }
    }
  );

  r.post(
    "/users/:id/resend-invitation",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const reason = optionalReason(req.body?.reason, "Partner invitation resent");
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          resendTeamInvitation(c, req.partner!, String(req.params.id), reason)
        );
        await deliverTeamInvitationAfterCommit(req.partner!.tenantId, result.invitationId, result.delivery);
        const { delivery: _delivery, ...safeResult } = result;
        res.json({ ok: true, result: safeResult });
      } catch (err) {
        denyTeamAction(req, res, "partner_invitation_resent", err);
      }
    }
  );

  r.post(
    "/users/:id/revoke-invitation",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const reason = requireReason(req.body?.reason);
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          revokeTeamInvitation(c, req.partner!, String(req.params.id), reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_invitation_revoked", err);
      }
    }
  );

  r.post(
    "/users/:id/role",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    // AG-3: changing a colleague's role hands over or takes away authority.
    requireRecentAuth(),
    async (req, res) => {
      try {
        const role = requirePortalTeamRole(req.body?.role);
        const reason = requireReason(req.body?.reason);
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          changeTeamMemberRole(c, req.partner!, String(req.params.id), role, reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_role_changed", err);
      }
    }
  );

  r.post(
    "/users/:id/status",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.users.manage"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    // AG-3: suspending or removing someone ends their access immediately.
    requireRecentAuth(),
    async (req, res) => {
      try {
        const status = req.body?.status;
        if (status !== "ACTIVE" && status !== "SUSPENDED" && status !== "REVOKED") {
          throw new G5RequestError("VALIDATION_ERROR", "Unknown team member status.");
        }
        const reason = requireReason(req.body?.reason);
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          setTeamMemberStatus(c, req.partner!, String(req.params.id), status, reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_status_changed", err);
      }
    }
  );

  // Locations the current user may operate at — org-wide roles (owner/manager/finance-viewer) see
  // every ACTIVE location; everyone else sees only their explicit partner_user_locations
  // assignments. Powers the Portal's location switcher (Increment A) and the "select a location"
  // step of the submission wizard (Increment B) — read-only, no client-supplied tenant/org filter.
  r.get("/locations", requirePartnerCapability("partner.location.view"), async (req, res) => {
    const rows = await withTenant({ tenantId: req.partner!.tenantId }, async (c) => {
      if (req.partner!.orgWide) {
        const l = await c.query("SELECT id, name, status FROM partner_locations WHERE status='ACTIVE' ORDER BY name");
        return l.rows;
      }
      const l = await c.query(
        `SELECT pl.id, pl.name, pl.status FROM partner_locations pl
           JOIN partner_user_locations pul ON pul.location_id = pl.id
          WHERE pul.user_id = $1 AND pl.status = 'ACTIVE' ORDER BY pl.name`,
        [req.partner!.userId]
      );
      return l.rows;
    });
    res.json(rows);
  });

  // Public-profile state is backed by the separate public-only consent schema.
  // Operational addresses remain visible only on this authenticated surface;
  // preview is built by the exact public DTO mapper.
  r.get("/public-profile", requirePartnerCapability("partner.location.view"), async (req, res) => {
    noStore(res);
    try {
      res.json(await getPartnerPublicProfileStatus(req.partner!));
    } catch (err) {
      sendPublicPublicationError(res, err);
    }
  });

  r.post(
    "/public-profile/locations/:locationId",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.location.view"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    requireRecentAuth(),
    async (req, res) => {
      noStore(res);
      try {
        if (
          !Number.isInteger(req.body?.expectedProfileVersion) || req.body.expectedProfileVersion < 0 ||
          !Number.isInteger(req.body?.expectedLocationVersion) || req.body.expectedLocationVersion < 0
        ) {
          res.status(400).json({ error: "The exact profile and location versions are required before saving." });
          return;
        }
        await savePartnerPublicDraft(req.partner!, String(req.params.locationId), req.body ?? {});
        res.json({ ok: true });
      } catch (err) {
        sendPublicPublicationError(res, err);
      }
    }
  );

  // Google Business is an optional, isolated Partner feature. Its positive gate
  // is evaluated inside these routes only; missing Google config/schema never
  // changes portal login, public-profile reads, or any grading operation.
  r.get("/google-business/status", requirePartnerCapability("partner.location.view"), async (req, res) => {
    const capability = await getGooglePresenceCapability();
    if (!capability.available) {
      res.json({ available: false, reason: capability.reason, owner: false, locations: [] });
      return;
    }
    try {
      res.json({ available: true, ...(await getGooglePresenceStatus(req.partner!)) });
    } catch (err) {
      sendGooglePresenceError(res, err);
    }
  });

  r.post(
    "/google-business/connect",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.location.view"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    requireRecentAuth(),
    async (req, res) => {
      const capability = await getGooglePresenceCapability();
      if (!capability.available) {
        res.status(503).json({ error: { code: capability.reason, message: "Google Business connection is unavailable." } });
        return;
      }
      if (typeof req.body?.locationId !== "string") {
        sendGooglePresenceError(res, new GooglePresenceError("invalid_request", 400));
        return;
      }
      try {
        res.json(await beginGoogleBusinessConnection(req.partner!, req.body.locationId, capability.config));
      } catch (err) {
        sendGooglePresenceError(res, err);
      }
    }
  );

  r.get(
    "/google-business/callback",
    googleCallbackRateLimit,
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.location.view"),
    requireGoogleCallbackMutation,
    async (req, res) => {
      const capability = await getGooglePresenceCapability();
      if (!capability.available) {
        res.redirect(303, "/partner/public-profile?google=unavailable");
        return;
      }
      if (typeof req.query.error === "string") {
        res.redirect(303, "/partner/public-profile?google=cancelled");
        return;
      }
      try {
        await completeGoogleBusinessOAuth({
          principal: req.partner!,
          state: typeof req.query.state === "string" ? req.query.state : "",
          code: typeof req.query.code === "string" ? req.query.code : "",
          config: capability.config,
        });
        res.redirect(303, "/partner/public-profile?google=select");
      } catch (err) {
        if (err instanceof GooglePresenceError) {
          res.redirect(303, `/partner/public-profile?google=${encodeURIComponent(err.code)}`);
          return;
        }
        console.error("[partner google] callback failed:", (err as Error)?.message ?? "unknown");
        res.redirect(303, "/partner/public-profile?google=unavailable");
      }
    }
  );

  r.post(
    "/google-business/confirm",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.location.view"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    requireRecentAuth(),
    async (req, res) => {
      const capability = await getGooglePresenceCapability();
      if (!capability.available) {
        res.status(503).json({ error: { code: capability.reason, message: "Google Business connection is unavailable." } });
        return;
      }
      if (typeof req.body?.locationId !== "string" || typeof req.body?.candidateHandle !== "string") {
        sendGooglePresenceError(res, new GooglePresenceError("invalid_request", 400));
        return;
      }
      try {
        await confirmGoogleBusinessCandidate({
          principal: req.partner!,
          locationId: req.body.locationId,
          candidateHandle: req.body.candidateHandle,
        });
        res.json({ ok: true });
      } catch (err) {
        sendGooglePresenceError(res, err);
      }
    }
  );

  r.post(
    "/google-business/:locationId/refresh",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.location.view"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    requireRecentAuth(),
    async (req, res) => {
      const capability = await getGooglePresenceCapability();
      if (!capability.available) {
        res.status(503).json({ error: { code: capability.reason, message: "Google Business connection is unavailable." } });
        return;
      }
      try {
        await refreshGoogleBusinessConnection(req.partner!, String(req.params.locationId), capability.config);
        res.json({ ok: true });
      } catch (err) {
        sendGooglePresenceError(res, err);
      }
    }
  );

  r.post(
    "/google-business/:locationId/disconnect",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.location.view"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    requireRecentAuth(),
    async (req, res) => {
      const capability = await getGooglePresenceCapability();
      if (!capability.available) {
        res.status(503).json({ error: { code: capability.reason, message: "Google Business connection is unavailable." } });
        return;
      }
      try {
        await disconnectGoogleBusinessConnection(req.partner!, String(req.params.locationId), capability.config);
        res.json({ ok: true });
      } catch (err) {
        sendGooglePresenceError(res, err);
      }
    }
  );

  // ---- location switching (Item 2) ----
  r.post("/session/location", partnerLocationSwitchLimiter, requirePartnerAuth, async (req, res) => {
    const { locationId } = req.body ?? {}; // any submitted partner/tenant id is ignored
    if (typeof locationId !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const result = await switchLocation(req.partner!, locationId);
    if (!result.ok) {
      res.status(result.reason === "not_assigned" ? 403 : 404).json({ error: result.reason });
      return;
    }
    res.json({ ok: true, locationId });
  });

  // ---- MFA enrolment (Item 3) ----
  // enrol/confirm are reachable by an mfa-pending session (a user with mfa_required but no method yet).
  /**
   * AG-3 — STEP-UP: re-prove the human behind this session.
   *
   * Rate-limited with the MFA limiter because it accepts a password and a second factor, and is
   * therefore exactly as brute-forceable as the MFA routes it borrows its standard from.
   *
   * On success it stamps the session and says how long the proof lasts, so the client can avoid
   * asking again inside the window. It returns NO new session and NO token: this raises the
   * privilege of the session already in hand rather than issuing anything new.
   */
  r.post("/auth/step-up", requirePartnerAuth, partnerMfaLimiter, partnerMfaAccountLimiter, async (req, res) => {
    const principal = req.partner!;
    try {
      const result = await verifyStepUp(
        { tenantId: principal.tenantId, userId: principal.userId },
        req.body?.password,
        {
          code: typeof req.body?.code === "string" ? req.body.code : undefined,
          recoveryCode: typeof req.body?.recoveryCode === "string" ? req.body.recoveryCode : undefined,
        }
      );
      if (!result.ok) {
        // A wrong password and a missing second factor are told apart, because the user can act on
        // the difference. Neither answer reveals whether the ACCOUNT exists — the session already
        // proves that, so there is nothing left to enumerate here.
        res.status(result.reason === "second_factor_required" ? 400 : 403).json({
          error: {
            code: result.reason === "second_factor_required" ? "second_factor_required" : "unauthorised",
            message:
              result.reason === "second_factor_required"
                ? "Enter the code from your authenticator app."
                : "That password was not correct.",
          },
        });
        return;
      }
      await recordStepUp(principal.sessionId);
      res.json({ ok: true, windowMinutes: STEP_UP_WINDOW_MINUTES });
    } catch (err) {
      console.error("[partner step-up] failed:", (err as Error).message);
      res.status(500).json({ error: { code: "step_up_failed", message: "Could not confirm your password." } });
    }
  });

  r.post("/mfa/enrol", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const { password, code, recoveryCode } = req.body ?? {};
    if (typeof password !== "string") {
      res.status(400).json({ error: "elevated verification required" });
      return;
    }
    const out = await mfaEnrolStart(
      {
        tenantId: req.partner.tenantId,
        userId: req.partner.userId,
        sessionId: req.partner.sessionId,
        sessionMfaPassed: req.partner.mfaPassed,
      },
      password,
      // F3: only consulted when an ACTIVE authenticator already exists (i.e. this is a REPLACEMENT).
      // First-time enrolment is unaffected and still needs the password alone.
      {
        code: typeof code === "string" ? code : undefined,
        recoveryCode: typeof recoveryCode === "string" ? recoveryCode : undefined,
      }
    );
    if (!out.ok) {
      const status =
        out.reason === "encryption_unavailable"
          ? 503
          : out.reason === "requires_current_factor" || out.reason === "second_factor_required"
            ? 403
            : 401;
      res.status(status).json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({
      ok: true,
      enrolmentId: out.enrolmentId,
      secret: out.secret,
      otpauthUri: out.otpauthUri,
      expiresAt: out.expiresAt,
    }); // shown once; never logged
  });

  r.post("/mfa/restart", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    // Same elevated-verification precondition as /mfa/enrol above: restart issues a
    // NEW authenticator secret, so it is the same operation and takes the same proof.
    // A second factor is deliberately NOT accepted — the service refuses this path
    // outright while an ACTIVE authenticator exists.
    const { password } = req.body ?? {};
    // MERGE (2026-08-11): the v1069 lineage's stricter guard is kept — an EMPTY
    // password is rejected here rather than being handed to bcrypt, and the
    // response is an undifferentiated 401 so a caller cannot distinguish
    // "no password supplied" from "wrong password".
    if (typeof password !== "string" || password.length === 0) {
      res.status(401).json({ error: "unauthorised" });
      return;
    }
    const out = await mfaEnrolRestart(
      {
        tenantId: req.partner.tenantId,
        userId: req.partner.userId,
        sessionId: req.partner.sessionId,
        sessionMfaPassed: req.partner.mfaPassed,
      },
      password
    );
    if (!out.ok) {
      const status =
        out.reason === "encryption_unavailable" ? 503 : out.reason === "requires_current_factor" ? 403 : 401;
      res.status(status).json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({
      ok: true,
      enrolmentId: out.enrolmentId,
      secret: out.secret,
      otpauthUri: out.otpauthUri,
      expiresAt: out.expiresAt,
    });
  });

  r.post("/mfa/cancel", partnerMfaLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    await mfaEnrolCancel({
      tenantId: req.partner.tenantId,
      userId: req.partner.userId,
      sessionId: req.partner.sessionId,
    });
    clearPartnerCookie(res);
    res.json({ ok: true });
  });

  r.post("/mfa/confirm", partnerMfaLimiter, partnerMfaAccountLimiter, async (req, res) => {
    if (!req.partner) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const { code, enrolmentId } = req.body ?? {};
    const normalizedCode = typeof code === "string" ? code.replace(/\s/g, "") : "";
    if (typeof enrolmentId !== "string" || !/^[0-9a-f-]{36}$/i.test(enrolmentId) || !/^\d{6}$/.test(normalizedCode)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const out = await mfaEnrolConfirm(
      {
        tenantId: req.partner.tenantId,
        userId: req.partner.userId,
        sessionId: req.partner.sessionId,
        sessionMfaPassed: req.partner.mfaPassed,
      },
      enrolmentId,
      normalizedCode
    );
    if (!out.ok) {
      res.status(out.reason === "requires_current_factor" ? 403 : 400).json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({ ok: true, recoveryCodes: out.recoveryCodes }); // shown once
  });

  r.post("/mfa/recovery-codes/regenerate", requirePartnerAuth, partnerMfaLimiter, partnerMfaAccountLimiter, async (req, res) => {
    const { password, code, recoveryCode } = req.body ?? {};
    if (typeof password !== "string") {
      res.status(400).json({ error: "elevated verification required" });
      return;
    }
    const out = await mfaRegenerateRecovery(
      {
        tenantId: req.partner!.tenantId,
        userId: req.partner!.userId,
        sessionMfaPassed: req.partner!.mfaPassed,
      },
      password,
      // C: only consulted when an ACTIVE authenticator already exists. Minting a fresh recovery set
      // for an enrolled user is a credential-class change and now demands the same current-factor
      // proof as replacing the authenticator. Bootstrap (no active method) is unaffected.
      {
        code: typeof code === "string" ? code : undefined,
        recoveryCode: typeof recoveryCode === "string" ? recoveryCode : undefined,
      }
    );
    if (!out.ok) {
      res
        .status(out.reason === "requires_current_factor" || out.reason === "second_factor_required" ? 403 : 401)
        .json({ error: out.reason });
      return;
    }
    noStore(res);
    res.json({ ok: true, recoveryCodes: out.recoveryCodes }); // shown once; never logged
  });

  // A Partner cannot remove their own second factor. Recovery is deliberately a distinct,
  // audited Super Admin action protected by fresh step-up authentication; allowing a self-service
  // password/current-code path here contradicts the locked recovery policy and turns loss of a
  // device into an unreviewed credential-class change.
  r.post("/mfa/disable", requirePartnerAuth, partnerMfaLimiter, (_req, res) => {
    res.status(403).json({ error: "self-service MFA removal is not available" });
  });

  r.post(
    "/users/:id/revoke-sessions",
    partnerTeamMutationLimiter,
    requirePartnerCapability("partner.sessions.revoke"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    // AG-3: signing someone out of everything is a security action.
    requireRecentAuth(),
    async (req, res) => {
      try {
        const reason = optionalReason(req.body?.reason, "Partner team member sessions revoked");
        const result = await withTenant({ tenantId: req.partner!.tenantId }, (c) =>
          revokeTeamMemberSessions(c, req.partner!, String(req.params.id), reason)
        );
        res.json({ ok: true, result });
      } catch (err) {
        denyTeamAction(req, res, "partner_user_sessions_revoked", err);
      }
    }
  );

  return r;
}

export { PARTNER_COOKIE };
