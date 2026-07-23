/** Partner Shop Launch HTTP routes. */
import { Router, type Express, type Request, type Response } from "express";
import { requireSuperAdmin } from "../auth";
import {
  ShopLaunchError,
  adminListLaunchState,
  adminResolveReconciliationCase,
  adminSetPackageEligibility,
  adminSetPilotAuthorisation,
  adminSetReadinessCheck,
  adminUpsertCreditPackage,
  createPartnerCreditPurchase,
  getPartnerLaunchDashboard,
  getPartnerWalletView,
  listEligibleCreditPackages,
  listPartnerCertificates,
  listPartnerCorrections,
  listReadiness,
  respondToPartnerCorrection,
  startPartnerCreditCheckout,
  type SuperAdminLaunchActor,
} from "./shop-launch-service";
import { requirePartnerAuth, requirePartnerCapability, requireNotSensitiveFrozen, requireNotViewOnly } from "./session";

function sendError(res: Response, error: unknown): void {
  if (error instanceof ShopLaunchError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden" || error.code === "pilot_not_authorised"
          ? 403
          : error.code === "feature_disabled" ||
              error.code === "payment_unavailable" ||
              error.code === "stripe_unavailable"
            ? 503
            : error.code === "idempotency_conflict" || error.code === "invalid_state"
              ? 409
              : 400;
    res.status(status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[partner shop launch] unexpected error:", error);
  res.status(500).json({ error: { code: "internal_error", message: "The Partner operation could not be completed." } });
}

function actorOf(req: Request): SuperAdminLaunchActor {
  const userId = req.session?.authUserId;
  const email = req.session?.adminEmail;
  if (!userId || !email) throw new ShopLaunchError("bad_request", "Super Admin identity is not established.");
  return { userId, email, correlationId: req.header("x-request-id")?.slice(0, 200) || `shop-launch-${Date.now()}` };
}

export function partnerShopLaunchRouter(): Router {
  const r = Router();
  r.use(requirePartnerAuth);

  r.get("/dashboard/launch", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    try {
      res.json(await getPartnerLaunchDashboard(req.partner!));
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/wallet", requirePartnerCapability("partner.credits.view"), async (req, res) => {
    try {
      res.json(await getPartnerWalletView(req.partner!, Number(req.query.limit ?? 50)));
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/purchases/packages", requirePartnerCapability("partner.purchases.view"), async (req, res) => {
    try {
      res.json({ packages: await listEligibleCreditPackages(req.partner!) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post(
    "/purchases",
    requirePartnerCapability("partner.purchases.create"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        const purchase = await createPartnerCreditPurchase(req.partner!, {
          packageId: String(req.body?.packageId ?? ""),
          idempotencyKey: String(req.header("idempotency-key") ?? req.body?.idempotencyKey ?? ""),
        });
        res.status(201).json({ purchase });
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  r.post(
    "/purchases/:purchaseId/checkout",
    requirePartnerCapability("partner.purchases.create"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        res.json(
          await startPartnerCreditCheckout(req.partner!, {
            purchaseId: String(req.params.purchaseId),
            idempotencyKey: String(req.header("idempotency-key") ?? req.body?.idempotencyKey ?? ""),
          })
        );
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  r.get("/certificates", requirePartnerCapability("partner.certificates.view"), async (req, res) => {
    try {
      res.json({ certificates: await listPartnerCertificates(req.partner!) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/grading", requirePartnerCapability("partner.grading.view"), async (req, res) => {
    try {
      const dashboard = await getPartnerLaunchDashboard(req.partner!);
      res.json({
        queue: {
          submittedToMintVault: dashboard.submissions?.submitted_to_mintvault ?? 0,
          cardsAwaitingCompletion: dashboard.handoffs?.pending ?? 0,
        },
        note: "MVGS execution remains on the existing grading workflow; G6D rebase must connect final settlement.",
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.get("/corrections", requirePartnerCapability("partner.corrections.view"), async (req, res) => {
    try {
      res.json({ corrections: await listPartnerCorrections(req.partner!) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post(
    "/corrections/:correctionId/respond",
    requirePartnerCapability("partner.corrections.respond"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    async (req, res) => {
      try {
        res.json({
          correction: await respondToPartnerCorrection(req.partner!, String(req.params.correctionId), {
            response: String(req.body?.response ?? ""),
            idempotencyKey: String(req.header("idempotency-key") ?? req.body?.idempotencyKey ?? ""),
          }),
        });
      } catch (error) {
        sendError(res, error);
      }
    }
  );

  r.get("/onboarding/readiness", requirePartnerCapability("partner.onboarding.view"), async (req, res) => {
    try {
      res.json({ checks: await listReadiness(req.partner!) });
    } catch (error) {
      sendError(res, error);
    }
  });

  return r;
}

export function partnerShopLaunchAdminRouter(): Router {
  const r = Router();
  r.use(requireSuperAdmin);

  r.get("/partners/:partnerId/launch", async (req, res) => {
    try {
      res.json(await adminListLaunchState(req.params.partnerId));
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/packages", async (req, res) => {
    try {
      res.json({ package: await adminUpsertCreditPackage(actorOf(req), req.body ?? {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/packages/:packageId/eligibility/:partnerId", async (req, res) => {
    try {
      res.json({
        eligibility: await adminSetPackageEligibility(
          actorOf(req),
          req.params.partnerId,
          req.params.packageId,
          req.body?.eligible === true,
          String(req.body?.reason ?? "")
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/readiness", async (req, res) => {
    try {
      res.json({ check: await adminSetReadinessCheck(actorOf(req), req.params.partnerId, req.body ?? {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/partners/:partnerId/pilot-authorisation", async (req, res) => {
    try {
      res.json({ pilot: await adminSetPilotAuthorisation(actorOf(req), req.params.partnerId, req.body ?? {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  r.post("/reconciliation/:caseId/resolve", async (req, res) => {
    try {
      res.json({
        case: await adminResolveReconciliationCase(actorOf(req), req.params.caseId, {
          status: req.body?.status === "dismissed" ? "dismissed" : "resolved",
          reason: String(req.body?.reason ?? ""),
        }),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  return r;
}

export function registerPartnerShopLaunchAdminRoutes(app: Express): void {
  app.use("/api/super-admin/partner-launch", partnerShopLaunchAdminRouter());
}
