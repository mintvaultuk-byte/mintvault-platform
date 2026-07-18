/**
 * Partner Portal — submission API routes (Phase 2). Mounted under /api/partner alongside the
 * Phase 1 router. Every route requires an authenticated, MFA-passed session (requirePartnerAuth)
 * plus the specific granular permission for the action (requirePartnerCapability). Every mutating
 * route is additionally rate-limited per authenticated user. Errors always use the consistent
 * { error: { code, message } } shape — never a raw DB error or stack trace.
 */
import { Router } from "express";
import { requirePartnerAuth, requirePartnerCapability, requireNotViewOnly, requireNotSensitiveFrozen } from "./session";
import { partnerSubmissionMutationLimiter } from "./rate-limit";
import {
  SubmissionError,
  listSubmissions,
  createSubmissionDraft,
  editSubmissionDraft,
  cancelSubmission,
  addCard,
  editCard,
  removeCard,
  listCards,
  getSubmissionDetail,
  submitSubmission,
  dashboardSummary,
  listAvailableServiceTiers,
} from "./submission-service";

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof SubmissionError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "forbidden"
          ? 403
          : err.code === "stale_version" || err.code === "idempotency_conflict" || err.code === "service_tier_unavailable"
            ? 409
            : 400;
    res.status(status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("[partner submissions] unexpected error:", err);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } });
}

const MAX_STRING = 500; // oversized-input guard, applied to EVERY client-supplied free-text field
const MAX_QUANTITY = 1000; // sane ceiling — a single card submission is never realistically larger
const MAX_DECLARED_VALUE_PENCE = 100_000_000; // £1,000,000 — generous ceiling, not a real ceiling on card value
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function tooLong(s: unknown): boolean {
  return typeof s === "string" && s.length > MAX_STRING;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && !tooLong(v) ? v : null;
}

/**
 * Tri-state field coercion for PATCH: distinguishes "field omitted" (undefined — don't touch) from
 * "field explicitly cleared" (null — clear it) from "field set to a string" (validate/store it).
 * A plain `typeof v === "string" ? v : undefined` (as used elsewhere for POST, where there is no
 * "clear" concept) would collapse an explicit `null` into `undefined` and silently make "clear the
 * service tier" a no-op — this preserves that distinction for editSubmissionDraft.
 */
function asStringOrExplicitNull(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === "string" && !tooLong(v) ? v : undefined;
}

/** Bounded positive integer, or null if absent/invalid/out of range. */
function asBoundedInt(v: unknown, min: number, max: number): number | null {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null;
}

/**
 * Strict quantity validation — an invalid quantity must NEVER silently become 1. Only a genuinely
 * OMITTED field (undefined) defaults to 1 (quantity is an intentionally optional field — the DB
 * column itself defaults to 1). Anything else that isn't a valid integer in range is a hard
 * rejection: zero, negative, decimal, NaN, Infinity, numeric strings ("5"), empty strings,
 * non-numeric text, arrays, and objects are all rejected — `Number.isInteger` returns false for
 * every one of those (it does not coerce strings), matching this file's existing strict-typing
 * convention (year/declaredValuePence use the same `Number.isInteger` check, never string coercion).
 */
function parseQuantity(v: unknown): number | null {
  if (v === undefined) return 1; // omitted only — an explicitly-sent invalid value is never defaulted
  return asBoundedInt(v, 1, MAX_QUANTITY);
}

export function partnerSubmissionRouter(): Router {
  const r = Router();
  r.use(requirePartnerAuth);

  r.get("/dashboard/submissions", requirePartnerCapability("partner.dashboard.view"), async (req, res) => {
    try {
      res.json(await dashboardSummary(req.partner!));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Currently-available service tiers for the wizard's "Select a service" step. Read-only.
  r.get("/service-tiers", requirePartnerCapability("partner.orders.view"), async (req, res) => {
    try {
      res.json(await listAvailableServiceTiers(req.partner!));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.get("/submissions", requirePartnerCapability("partner.orders.view"), async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const pageRaw = Number(req.query.page);
      const pageSizeRaw = Number(req.query.pageSize);
      const result = await listSubmissions(req.partner!, {
        status,
        page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : undefined,
        pageSize: Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined,
      });
      res.json(result);
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post(
    "/submissions",
    requirePartnerCapability("partner.orders.create"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const body = req.body ?? {};
        if (typeof body.locationId !== "string" || tooLong(body.customerId) || tooLong(body.internalReference) || tooLong(body.serviceTierCode) || tooLong(body.intakeNotes)) {
          res.status(400).json({ error: { code: "validation", message: "Invalid submission input." } });
          return;
        }
        const created = await createSubmissionDraft(req.partner!, {
          locationId: body.locationId,
          customerId: asString(body.customerId),
          internalReference: asString(body.internalReference),
          serviceTierCode: asString(body.serviceTierCode),
          intakeNotes: asString(body.intakeNotes),
        });
        res.status(201).json(created);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  r.get("/submissions/:id", requirePartnerCapability("partner.orders.view"), async (req, res) => {
    try {
      res.json(await getSubmissionDetail(req.partner!, String(req.params.id)));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.patch(
    "/submissions/:id",
    requirePartnerCapability("partner.orders.edit"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const body = req.body ?? {};
        if (
          typeof body.version !== "number" ||
          tooLong(body.customerId) ||
          tooLong(body.internalReference) ||
          tooLong(body.serviceTierCode) ||
          tooLong(body.intakeNotes)
        ) {
          res.status(400).json({ error: { code: "validation", message: "Invalid submission input." } });
          return;
        }
        const updated = await editSubmissionDraft(req.partner!, String(req.params.id), {
          version: body.version,
          customerId: typeof body.customerId === "string" ? body.customerId : undefined,
          internalReference: typeof body.internalReference === "string" ? body.internalReference : undefined,
          serviceTierCode: asStringOrExplicitNull(body.serviceTierCode),
          intakeNotes: typeof body.intakeNotes === "string" ? body.intakeNotes : undefined,
        });
        res.json(updated);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  r.delete(
    "/submissions/:id",
    requirePartnerCapability("partner.orders.cancel"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
        if (tooLong(reason)) {
          res.status(400).json({ error: { code: "validation", message: "Reason is too long." } });
          return;
        }
        res.json(await cancelSubmission(req.partner!, String(req.params.id), reason));
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  r.get("/submissions/:id/cards", requirePartnerCapability("partner.cards.view"), async (req, res) => {
    try {
      res.json(await listCards(req.partner!, String(req.params.id)));
    } catch (err) {
      sendError(res, err);
    }
  });

  r.post(
    "/submissions/:id/cards",
    requirePartnerCapability("partner.orders.edit"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const body = req.body ?? {};
        if (
          typeof body.cardName !== "string" ||
          tooLong(body.cardName) ||
          tooLong(body.game) ||
          tooLong(body.cardSet) ||
          tooLong(body.cardNumber) ||
          tooLong(body.variant) ||
          tooLong(body.language) ||
          tooLong(body.customerNotes) ||
          tooLong(body.intakeNotes)
        ) {
          res.status(400).json({ error: { code: "validation", message: "Invalid card input." } });
          return;
        }
        // Invalid quantity is a hard rejection BEFORE any DB call — it must never silently become 1,
        // never create a card row, and never write an audit/event claiming a card was added.
        const quantity = parseQuantity(body.quantity);
        if (quantity === null) {
          res.status(400).json({ error: { code: "invalid_quantity", message: "Enter a valid card quantity." } });
          return;
        }
        const created = await addCard(req.partner!, String(req.params.id), {
          cardName: body.cardName,
          game: asString(body.game),
          cardSet: asString(body.cardSet),
          cardNumber: asString(body.cardNumber),
          year: asBoundedInt(body.year, MIN_YEAR, MAX_YEAR),
          variant: asString(body.variant),
          language: asString(body.language),
          declaredValuePence: asBoundedInt(body.declaredValuePence, 0, MAX_DECLARED_VALUE_PENCE),
          quantity,
          customerNotes: asString(body.customerNotes),
          intakeNotes: asString(body.intakeNotes),
        });
        res.status(201).json(created);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  r.patch(
    "/submissions/:id/cards/:cardId",
    requirePartnerCapability("partner.orders.edit"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const body = req.body ?? {};
        if (
          (body.cardName !== undefined && typeof body.cardName !== "string") ||
          tooLong(body.cardName) ||
          tooLong(body.game) ||
          tooLong(body.cardSet) ||
          tooLong(body.cardNumber) ||
          tooLong(body.variant) ||
          tooLong(body.language) ||
          tooLong(body.customerNotes) ||
          tooLong(body.intakeNotes)
        ) {
          res.status(400).json({ error: { code: "validation", message: "Invalid card input." } });
          return;
        }
        if (body.quantity !== undefined && asBoundedInt(body.quantity, 1, MAX_QUANTITY) === null) {
          res.status(400).json({ error: { code: "invalid_quantity", message: "Enter a valid card quantity." } });
          return;
        }
        // asBoundedInt collapses "omitted" and "invalid" into the same null — fine for editCard's
        // COALESCE (null = no change), but that would silently swallow a genuinely invalid year or
        // declared value instead of rejecting it, unlike quantity above. Reject explicitly here.
        if (body.year !== undefined && asBoundedInt(body.year, MIN_YEAR, MAX_YEAR) === null) {
          res.status(400).json({ error: { code: "invalid_year", message: "Enter a valid year." } });
          return;
        }
        if (body.declaredValuePence !== undefined && asBoundedInt(body.declaredValuePence, 0, MAX_DECLARED_VALUE_PENCE) === null) {
          res.status(400).json({ error: { code: "invalid_declared_value", message: "Enter a valid declared value." } });
          return;
        }
        const updated = await editCard(req.partner!, String(req.params.id), String(req.params.cardId), {
          cardName: typeof body.cardName === "string" ? body.cardName : undefined,
          game: asString(body.game),
          cardSet: asString(body.cardSet),
          cardNumber: asString(body.cardNumber),
          year: asBoundedInt(body.year, MIN_YEAR, MAX_YEAR),
          variant: asString(body.variant),
          language: asString(body.language),
          declaredValuePence: asBoundedInt(body.declaredValuePence, 0, MAX_DECLARED_VALUE_PENCE),
          quantity: body.quantity !== undefined ? (asBoundedInt(body.quantity, 1, MAX_QUANTITY) ?? undefined) : undefined,
          customerNotes: asString(body.customerNotes),
          intakeNotes: asString(body.intakeNotes),
        });
        res.json(updated);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  r.delete(
    "/submissions/:id/cards/:cardId",
    requirePartnerCapability("partner.orders.edit"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const reasonRaw = req.body?.reason;
        if (tooLong(reasonRaw)) {
          res.status(400).json({ error: { code: "validation", message: "Reason is too long." } });
          return;
        }
        const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;
        await removeCard(req.partner!, String(req.params.id), String(req.params.cardId), reason);
        res.json({ ok: true });
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  r.post(
    "/submissions/:id/submit",
    requirePartnerCapability("partner.orders.submit"),
    requireNotViewOnly,
    requireNotSensitiveFrozen,
    partnerSubmissionMutationLimiter,
    async (req, res) => {
      try {
        const idempotencyKeyRaw = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : req.header("Idempotency-Key");
        if (typeof idempotencyKeyRaw !== "string" || !idempotencyKeyRaw.trim() || tooLong(idempotencyKeyRaw)) {
          res.status(400).json({ error: { code: "validation", message: "An idempotency key is required." } });
          return;
        }
        res.json(await submitSubmission(req.partner!, String(req.params.id), idempotencyKeyRaw));
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  return r;
}
