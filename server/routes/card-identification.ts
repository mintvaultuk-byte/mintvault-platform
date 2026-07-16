/**
 * AI Card Identification Assistant routes (admin + staff-grader mirrors).
 *
 * Safety contract enforced here:
 *   • flag-gated (AI_CARD_IDENTIFICATION_ENABLED default OFF) → explicit 503 when off
 *   • provider selected by env — no key ⇒ "unavailable", never a real call
 *   • ONE explicit click ⇒ ONE provider call; idempotency key dedups double-clicks
 *   • pre-call spend ceiling (multi-machine safe); no automatic paid retry
 *   • image integrity + quality gates BEFORE any spend
 *   • suggestion only — nothing is saved, no cert/grade/number touched
 *   • generic errors (no provider prompt/token/secret leakage)
 *   • manual grading always works: any failure returns a message, never blocks
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "../auth";
import { requireCapability } from "../staff";
import { getFeatureFlag } from "../config/feature-flags";
import { getR2Buffer } from "../r2";
import { normalizeCertId } from "../lib/cert-id";
import { validateIdentificationImages, normaliseForProvider } from "../lib/card-identification/image-gates";
import { selectProvider, ProviderUnavailableError } from "../lib/card-identification/provider";
import { runIdentificationPipeline } from "../lib/card-identification/pipeline";
import { spendDecision } from "../lib/card-identification/spend";
import {
  findByIdempotencyKey,
  recordRequest,
  getSpendSnapshot,
  recordCorrections,
  accuracySummary,
  dbSetLookup,
  type CorrectionRow,
} from "../lib/card-identification/store";

const identifyLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many identification requests. Please wait a few minutes." },
});
const analyticsLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests." } });

function actorOf(req: Request): string {
  const s = req.session as { adminEmail?: string; staffEmail?: string; staffId?: string } | undefined;
  return s?.adminEmail || s?.staffEmail || s?.staffId || "unknown";
}

/** Base64 data URL or raw base64 → Buffer. Bounded by the express json limit. */
function base64ToBuffer(v: unknown): Buffer | null {
  if (typeof v !== "string" || !v) return null;
  const b64 = v.includes(",") ? v.slice(v.indexOf(",") + 1) : v;
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * A supplied R2 key is accepted ONLY when it's a card image scoped to the
 * certificate this request is for: `images/{normalizeCertId(certId)}/...`, with
 * no traversal. This blocks reading arbitrary bucket objects (other customers'
 * images, VQ artwork, backups) — a caller can't point identification at anything
 * but the card they already have open. Returns the key, or null if unsafe.
 */
export function safeImageKey(rawKey: unknown, certId: unknown): string | null {
  if (typeof rawKey !== "string" || !rawKey) return null;
  if (typeof certId !== "string" || !certId.trim()) return null; // a key requires a cert to scope to
  // Must be a card front/back image key: images/<cert>/front|back.<ext> — the
  // strict shape rules out traversal, other namespaces (vq/, labels/, logbooks/)
  // and control chars. The cert in the key must match this request's cert
  // (compared normalised, since the stored key uses the un-normalised cert id).
  const m = rawKey.match(/^images\/([A-Za-z0-9-]+)\/(front|back)\.[A-Za-z0-9]{1,5}$/);
  if (!m) return null;
  const want = normalizeCertId(certId.trim());
  return want && normalizeCertId(m[1]) === want ? rawKey : null;
}

async function resolveImage(body: Record<string, unknown>, keyField: string, r2Field: string): Promise<Buffer | null> {
  const inline = base64ToBuffer(body[keyField]);
  if (inline) return inline;
  // Or a server-side R2 key the grader already has open — scoped to this cert.
  const r2Key = safeImageKey(body[r2Field], body.certId);
  if (r2Key) return await getR2Buffer(r2Key);
  return null;
}

export async function handleIdentify(req: Request, res: Response): Promise<void> {
  try {
    if (!(await getFeatureFlag("AI_CARD_IDENTIFICATION_ENABLED"))) {
      res.status(503).json({ error: "AI Identification unavailable — use manual entry.", unavailable: true });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim().slice(0, 120) : null;
    if (!clientKey) {
      res.status(400).json({ error: "idempotencyKey is required." });
      return;
    }
    // Actor-scope the idempotency key so one grader can't read or poison another's
    // stored suggestion by reusing a key (the stored key is namespaced per actor).
    const idempotencyKey = `${actorOf(req)}::${clientKey}`.slice(0, 200);

    // Idempotency: a repeat click returns the stored suggestion — no second call.
    const existing = await findByIdempotencyKey(idempotencyKey);
    if (existing?.result) {
      res.json({ suggestion: existing.result, deduped: true });
      return;
    }

    const front = await resolveImage(body, "frontImageBase64", "frontImageKey");
    const back = await resolveImage(body, "backImageBase64", "backImageKey");

    const gate = await validateIdentificationImages({ front, back });
    if (!gate.ok) {
      res.status(422).json({ error: gate.message, code: gate.code, imageRejected: true });
      return;
    }

    // Spend ceiling BEFORE any provider work.
    const verdict = spendDecision(await getSpendSnapshot());
    if (!verdict.allowed) {
      res.status(429).json({ error: verdict.message, reason: verdict.reason, spendBlocked: true });
      return;
    }

    const provider = selectProvider();
    const [frontN, backN] = await Promise.all([normaliseForProvider(front!), back ? normaliseForProvider(back) : Promise.resolve(null)]);

    const suggestion = await runIdentificationPipeline({
      requestId: clientKey,
      provider,
      vision: { frontBase64: frontN.base64, frontMediaType: frontN.mediaType, backBase64: backN?.base64 ?? null, backMediaType: backN?.mediaType ?? null },
      setLookup: dbSetLookup,
      frontChecksum: gate.frontChecksum,
      backChecksum: gate.backChecksum,
      imageWarnings: gate.warnings,
      providerCostEstimate: verdict.estimateUsd,
    });

    // Record for idempotency + cost ledger (validated suggestion only — no raw AI, no images, no PII).
    await recordRequest({
      idempotencyKey,
      certId: typeof body.certId === "string" ? body.certId.slice(0, 40) : null,
      provider: suggestion.provider,
      model: suggestion.model,
      costUsd: suggestion.actualProviderCost,
      result: suggestion,
      actor: actorOf(req),
    });

    res.json({ suggestion });
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      res.status(503).json({ error: "AI Identification unavailable — use manual entry.", unavailable: true });
      return;
    }
    // Generic — never leak provider prompt/token/secret.
    console.error("[card-identification] failed:", err instanceof Error ? err.message : String(err));
    res.status(502).json({ error: "Identification failed. Please try again or enter manually.", providerError: true });
  }
}

async function handleCorrections(req: Request, res: Response): Promise<void> {
  try {
    const rows = Array.isArray(req.body?.corrections) ? (req.body.corrections as CorrectionRow[]) : [];
    const valid = rows.filter((r) => r && typeof r.field === "string" && ["accepted", "rejected", "changed"].includes(r.decision));
    const n = await recordCorrections(valid, actorOf(req));
    res.json({ ok: true, recorded: n });
  } catch (err) {
    console.error("[card-identification] corrections failed:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: "Failed to record analytics." });
  }
}

export function registerCardIdentificationRoutes(app: Express): void {
  // Identify — admin + staff(grade) mirrors. One explicit click per call.
  app.post("/api/admin/card-identification", identifyLimit, requireAdmin, handleIdentify);
  app.post("/api/staff/card-identification", identifyLimit, requireCapability("grade"), handleIdentify);

  // Correction analytics (non-PII) — logged when the grader accepts/rejects/changes.
  app.post("/api/admin/card-identification/corrections", analyticsLimit, requireAdmin, handleCorrections);
  app.post("/api/staff/card-identification/corrections", analyticsLimit, requireCapability("grade"), handleCorrections);

  // Accuracy dashboard foundation (admin only).
  app.get("/api/admin/card-identification/accuracy", requireAdmin, async (_req, res) => {
    try {
      res.json(await accuracySummary());
    } catch (err) {
      console.error("[card-identification] accuracy failed:", err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: "Failed to load accuracy summary." });
    }
  });
}
