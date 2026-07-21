/**
 * G4 Super-Admin connector operations — HTTP surface.
 *
 * Thin router: authenticate (existing requireAdmin), derive the acting admin from the SERVER session
 * (never the request body), shape the request via the pure helpers, delegate to connector-admin-
 * service (which delegates to the audited/idempotent G3F services), and return the repository-standard
 * envelope. No connector business logic here. Mounted additively under /api/super-admin/connector-ops;
 * CSRF/origin is already applied globally by csrfOriginCheck.
 *
 * Deferred by design (see G4-SCOPE-GUARD / G4-DISC-01): connector pause/resume/disable and any global
 * emergency-stop WRITE — those have no safe existing service and are not exposed here. Global flag +
 * emergency-stop STATE is surfaced read-only via GET /worker/status.
 */
import { Router, type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../auth";
import {
  toG4Error,
  g4StatusFor,
  requireReason,
  requireVersion,
  clampPagination,
  optionalStateFilter,
  G4RequestError,
} from "./connector-admin-errors";
import * as svc from "./connector-admin-service";
import type { ActorContext } from "./connector-admin-service";

/**
 * Mutation rate-limiter. Mirrors the existing adminRateLimit pattern (server/index.ts). NOTE: the
 * default express-rate-limit store is in-process and therefore per-Fly-machine — acceptable for a
 * low-volume internal admin surface, but a shared (DB/Redis) store is the documented multi-machine
 * follow-up, consistent with the existing in-process admin/staff counters.
 */
const g4MutationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: { code: "OPERATION_CONFLICT", message: "Too many operations, please slow down." } },
  keyGenerator: (req) => {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0]).trim();
    return req.ip || req.socket.remoteAddress || "unknown";
  },
});

/** Derive the acting admin identity from the authenticated session — never from the request body. */
function actorOf(req: Request): ActorContext {
  const actorUserId = req.session.authUserId;
  const actorEmail = req.session.adminEmail;
  if (!actorUserId || !actorEmail) {
    // requireAdmin guarantees these after a full two-step login; treat absence as unauthenticated.
    throw new G4RequestError("UNAUTHENTICATED", "Admin identity is not established.");
  }
  const requestId = String(req.headers["x-request-id"] ?? `g4-${req.method}-${Date.now()}`);
  const idempotencyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined;
  return { actorUserId, actorEmail, requestId, idempotencyKey };
}

function sendError(res: Response, err: unknown): void {
  const g4 = toG4Error(err);
  res
    .status(g4StatusFor(g4.code))
    .json({ error: { code: g4.code, message: g4.message, operatorAction: g4.operatorAction } });
}

/** Wrap a mutation result: idempotency short-circuit returns REQUEST_ALREADY_COMPLETED semantics. */
function mutationResponse(res: Response, requestId: string, r: { result: unknown; alreadyCompleted: boolean }): void {
  if (r.alreadyCompleted) {
    res.status(200).json({ ok: true, alreadyCompleted: true, requestId });
    return;
  }
  res.json({ ok: true, result: r.result, requestId });
}

export function connectorOpsRouter(): Router {
  const r = Router();
  r.use(requireAdmin);

  // ---- READS ----
  r.get("/partners", async (req, res) => {
    try {
      const { page, pageSize, offset } = clampPagination(req.query.page, req.query.pageSize);
      const search =
        typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;
      const { rows, total } = await svc.listPartnerOrgs(search, offset, pageSize);
      res.json({ partners: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/records", async (req, res) => {
    try {
      const { page, pageSize, offset } = clampPagination(req.query.page, req.query.pageSize);
      const filters = {
        partnerId: typeof req.query.partnerId === "string" ? req.query.partnerId : undefined,
        state: optionalStateFilter(req.query.state),
        reconciliationRequired: req.query.reconciliationRequired === "true",
        manualReview: req.query.manualReview === "true",
        failed: req.query.failed === "true",
        search: typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined,
      };
      const { rows, total } = await svc.listConnectorRecords(filters, offset, pageSize);
      res.json({ records: rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/records/:recordId", async (req, res) => {
    try {
      res.json(await svc.getRecordDetail(req.params.recordId));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/records/:recordId/attempts", async (req, res) => {
    try {
      res.json({ attempts: await svc.getAttemptHistory(req.params.recordId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/records/:recordId/audit", async (req, res) => {
    try {
      const { offset, pageSize } = clampPagination(req.query.page, req.query.pageSize);
      res.json(await svc.getRecordAuditHistory(req.params.recordId, offset, pageSize));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/manual-review", async (req, res) => {
    try {
      const { offset, pageSize } = clampPagination(req.query.page, req.query.pageSize);
      res.json(await svc.getManualReviewQueue(offset, pageSize));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/reconciliation", async (req, res) => {
    try {
      const { offset, pageSize } = clampPagination(req.query.page, req.query.pageSize);
      res.json(await svc.getReconciliationQueue(offset, pageSize));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/worker/status", async (_req, res) => {
    try {
      res.json(await svc.getOperationalHealth());
    } catch (err) {
      sendError(res, err);
    }
  });

  // WP-3: live driver state (running/stopped/last cycle) + the backlog it drains. Read-only.
  r.get("/worker/runtime", async (_req, res) => {
    try {
      res.json(await svc.getConnectorRuntimeStatus());
    } catch (err) {
      sendError(res, err);
    }
  });

  // ---- MUTATIONS (all reason-required, audited, idempotent) ----
  r.use(g4MutationRateLimit);

  r.post("/records/:recordId/revalidate", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      const version = requireVersion(req.body?.expectedVersion);
      mutationResponse(
        res,
        actor.requestId,
        await svc.opRequestRevalidation(actor, req.params.recordId, reason, version)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/records/:recordId/reconcile", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(res, actor.requestId, await svc.opRequestReconciliation(actor, req.params.recordId, reason));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/records/:recordId/recover-credit", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(res, actor.requestId, await svc.opRecoverSubmissionCredit(actor, req.params.recordId, reason));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/records/:recordId/retry", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      const version = requireVersion(req.body?.expectedVersion);
      mutationResponse(res, actor.requestId, await svc.opRetryRecord(actor, req.params.recordId, reason, version));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/records/:recordId/release-claim", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(res, actor.requestId, await svc.opReleaseExpiredClaim(actor, req.params.recordId, reason));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/records/:recordId/mark-manual-review", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      mutationResponse(res, actor.requestId, await svc.opMarkManualReview(actor, req.params.recordId, reason));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/records/:recordId/manual-review/resolve", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      const version = requireVersion(req.body?.expectedVersion);
      const resolution = req.body?.resolution;
      if (resolution !== "retry" && resolution !== "cancel") {
        throw new G4RequestError("BAD_REQUEST", "resolution must be 'retry' or 'cancel'.");
      }
      mutationResponse(
        res,
        actor.requestId,
        await svc.opResolveManualReview(actor, req.params.recordId, reason, resolution, version)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post("/records/:recordId/ack-failure", async (req, res) => {
    try {
      const actor = actorOf(req);
      const reason = requireReason(req.body?.reason);
      const version = requireVersion(req.body?.expectedVersion);
      mutationResponse(
        res,
        actor.requestId,
        await svc.opAckPermanentFailure(actor, req.params.recordId, reason, version)
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  return r;
}

/** Additive registration into the existing MintVault admin app (G4 super-admin connector ops). */
export function registerConnectorOpsRoutes(app: Express): void {
  app.use("/api/super-admin/connector-ops", connectorOpsRouter());
}
