/**
 * Vault Quest admin routes (Phase 1b) — all under /api/admin/vault-quest, all
 * behind requireAdmin. Isolated: imports only the VQ storage/render/guard modules
 * plus shared infra (requireAdmin, r2, multer config). Touches no grading route.
 *
 * Render endpoints (preview/export) are DB-free — they render from the posted
 * card and optional R2 artwork, so they work before the vq_ tables are pushed.
 * List/get/save require the vq_ tables (staging push, gated behind the deploy hold).
 */
import type { Express, Request, Response } from "express";
import { requireAdmin } from "../auth";
import { uploadToR2, getR2Buffer } from "../r2";
import { toolsUpload } from "../lib/multer-configs";
import { vqStorage } from "../vault-quest/storage";
import { validateArtwork } from "../vault-quest/upload-guard";
import { renderCard, type RenderCardInput } from "../vault-quest/render-service";
import { evaluateCard } from "../vault-quest/qa-engine";
import { vqArtKey, fetchArt, renderSavedFromStudio, assertVqWriteKey } from "../vault-quest/render-saved";
import { normalizePdf } from "../vault-quest/pdf-normalize";
import { VQ_ELEMENTS, VQ_ELEMENTS_NEEDS_APPROVAL } from "../vault-quest/lib/vq-constants";
import { canTransition, isVqStatus } from "@shared/vq-workflow";
import { setIntegrity, cardMetadata } from "../vault-quest/qa-set";
import { startExportJob, getExportJob, jobStatus } from "../vault-quest/export-jobs";
import { generate, type GenerateReq } from "../vault-quest/generate";
import { runGenerator, type GenKind, type CardContext } from "../vault-quest/ai/generators";
import { providerStatuses } from "../vault-quest/ai/provider";
import { AI_DISCLAIMER, guardInput, guardOutput } from "../vault-quest/ai/guardrails";
import {
  buildVaultQuestArtworkPrompt,
  generateHiggsfieldArtwork,
  higgsfieldConnection,
  isCandidateKeyForCard,
  validVqCardId,
  vqArtworkCandidateKey,
  type ArtworkSlot,
} from "../vault-quest/ai/higgsfield";
import type { InsertVqCard } from "@shared/vq-schema";

type VqEditorPayload = RenderCardInput & {
  artR2Key?: string | null;
  prevArtR2Key?: string | null;
  artCandidateKey?: string | null;
  prevArtCandidateKey?: string | null;
  notes?: string | null;
  status?: string;
  variantTier?: string | null;
  baseCardId?: string | null;
  effects?: unknown[] | null;
};

/** Map the editor payload to a DB insert row (drops render-only fields). */
function toInsert(body: VqEditorPayload): InsertVqCard {
  return {
    cardId: body.cardId,
    variantTier: body.variantTier ?? null,
    baseCardId: body.baseCardId ?? null,
    collectorNumber: body.collectorNumber,
    name: body.name,
    displayName: body.displayName ?? null,
    cardType: body.cardType,
    element: body.element,
    rarity: body.rarity ?? null,
    familyId: body.familyId ?? null,
    stageNumber: body.stageNumber ?? null,
    lifeStage: body.lifeStage ?? null,
    health: body.health ?? null,
    guard: body.guard ?? null,
    shift: body.shift ?? null,
    attack1Name: body.attack1Name ?? null,
    attack1Cost: body.attack1Cost ?? null,
    attack1Damage: body.attack1Damage ?? null,
    attack1Effect: body.attack1Effect ?? null,
    attack2Name: body.attack2Name ?? null,
    attack2Cost: body.attack2Cost ?? null,
    attack2Damage: body.attack2Damage ?? null,
    attack2Effect: body.attack2Effect ?? null,
    vulnerability: body.vulnerability ?? null,
    keywords: body.keywords ?? [],
    effects: body.effects ?? null,
    // Store only the DERIVED key (gated on the client's "art present" flag) — never
    // a client-supplied key.
    artR2Key: (body.artR2Key || body.artCandidateKey) ? vqArtKey(body.cardId, "main") : null,
    prevArtR2Key: (body.prevArtR2Key || body.prevArtCandidateKey) ? vqArtKey(body.cardId, "prev") : null,
    setCode: body.setCode ?? "GNV",
    language: body.language ?? "EN",
    year: body.year ?? 2026,
    edition: body.edition ?? "FIRST EDITION",
    status: body.status ?? "draft",
    notes: body.notes ?? null,
  };
}

async function promoteArtworkCandidate(cardId: string, slot: ArtworkSlot, candidateKey?: string | null): Promise<string | null> {
  const key = String(candidateKey ?? "").trim();
  if (!key) return null;
  if (!validVqCardId(cardId)) throw new Error("Card ID can only use letters, numbers, dots, dashes, and underscores.");
  if (!isCandidateKeyForCard(key, cardId)) throw new Error("Artwork candidate does not belong to this card.");
  const buf = await getR2Buffer(key);
  if (!buf) throw new Error("Artwork candidate expired or was not found.");
  const guard = await validateArtwork(buf);
  if (!guard.ok) throw new Error(guard.error ?? "Artwork candidate failed validation.");
  const png = await (await import("sharp")).default(buf).png().toBuffer();
  const draftKey = assertVqWriteKey(vqArtKey(cardId, slot));
  await uploadToR2(draftKey, png, "image/png");
  // The candidate is now actually promoted into draft art — flip the audit flag
  // here (on Save Draft), not on Use. Best-effort: never fail the save.
  await vqStorage.markAiGenerationAppliedByCandidate(key).catch(() => {});
  return draftKey;
}

export function registerVaultQuestAdminRoutes(app: Express): void {
  // ---- editor helpers ----
  app.get("/api/admin/vault-quest/config", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const gameConfig = await vqStorage.getConfig().catch(() => ({}));
      // Merge DB-added elements (from "add new element") with the built-in palette;
      // anything not built-in is flagged NEEDS_APPROVAL by convention.
      const elements: Record<string, unknown> = { ...VQ_ELEMENTS };
      const needsApproval = new Set<string>(VQ_ELEMENTS_NEEDS_APPROVAL);
      try {
        for (const name of await vqStorage.listElementNames()) {
          if (!(name in elements)) { elements[name] = { placeholder: true }; needsApproval.add(name); }
        }
      } catch { /* elements table absent — built-in palette only */ }
      res.json({ elements, needsApproval: [...needsApproval], gameConfig });
    } catch {
      res.json({ elements: VQ_ELEMENTS, needsApproval: [...VQ_ELEMENTS_NEEDS_APPROVAL], gameConfig: {} });
    }
  });

  // ---- cards list / get / save (DB) ----
  app.get("/api/admin/vault-quest/cards", requireAdmin, async (req: Request, res: Response) => {
    try {
      const { setCode, status, cardType, element } = req.query as Record<string, string>;
      const cards = await vqStorage.listCards({ setCode, status, cardType, element });
      res.json({ cards });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to list cards" });
    }
  });

  app.get("/api/admin/vault-quest/cards/:cardId", requireAdmin, async (req: Request, res: Response) => {
    try {
      // Studio payload: card + family-derived previousStage/familyName + base card (variants).
      const studio = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!studio) return res.status(404).json({ error: "card not found" });
      res.json(studio);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to get card" });
    }
  });

  app.post("/api/admin/vault-quest/cards", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as VqEditorPayload;
      if (!body.cardId || !body.name || !body.cardType || !body.element) {
        return res.status(400).json({ error: "cardId, name, cardType and element are required" });
      }
      // Single-door status: SAVE never sets a forward workflow status. A new card is
      // a draft; an existing card keeps its current status. Forward transitions
      // (ready/approved/export_ready/…) happen ONLY through /status, which runs the
      // full workflow gate. This prevents bypassing canTransition via the save route.
      const art = await fetchArt(body);
      const { qa } = await renderCard(body, art, "preview");
      const promotedMain = await promoteArtworkCandidate(body.cardId, "main", body.artCandidateKey);
      const promotedPrev = await promoteArtworkCandidate(body.cardId, "prev", body.prevArtCandidateKey);
      const existing = await vqStorage.getCard(body.cardId);
      const keepStatus = existing ? existing.status : "draft";
      const saveBody = {
        ...body,
        artR2Key: promotedMain ?? body.artR2Key,
        prevArtR2Key: promotedPrev ?? body.prevArtR2Key,
        status: keepStatus,
      };
      const saved = await vqStorage.saveCard(toInsert(saveBody), "admin");
      res.json({ card: saved, qa });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to save card" });
    }
  });

  // ---- generate a new card / family from the locked template (create-only) ----
  app.post("/api/admin/vault-quest/generate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as GenerateReq;
      if (body.mode !== "card" && body.mode !== "family") return res.status(400).json({ error: "mode must be 'card' or 'family'" });
      const result = await generate(body);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "generate failed" });
    }
  });

  // ---- AI Assist (Phases 2-7): generate PREVIEW-ONLY suggestions, audited ----
  const AI_KINDS: GenKind[] = ["name", "family-names", "gameplay", "flavour", "artwork-prompt"];
  app.post("/api/admin/vault-quest/ai/generate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as { kind?: string; mode?: string; context?: CardContext; n?: number };
      if (!body.kind || !AI_KINDS.includes(body.kind as GenKind)) return res.status(400).json({ error: `kind must be one of ${AI_KINDS.join(", ")}` });
      const ctx = (body.context ?? {}) as CardContext;
      const result = await runGenerator(body.kind as GenKind, String(body.mode ?? "generate"), ctx, Number(body.n) || 6);
      // Audit every generation (applied=false until the admin clicks Apply).
      let generationId: number | null = null;
      if (result.suggestions.length > 0) {
        generationId = await vqStorage.recordAiGeneration({
          cardId: (ctx as { cardId?: string }).cardId ?? null,
          kind: body.kind,
          mode: String(body.mode ?? "generate"),
          provider: result.provider,
          model: result.model,
          generatedBy: "admin",
          prompt: result.promptSummary,
          output: result.suggestions as unknown as Record<string, unknown>,
          applied: false,
        });
      }
      res.json({ ...result, generationId, disclaimer: AI_DISCLAIMER });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "AI generate failed" });
    }
  });

  app.post("/api/admin/vault-quest/ai/artwork", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as { context?: CardContext & { cardId?: string }; mode?: string; slot?: string };
      const ctx = (body.context ?? {}) as CardContext & { cardId?: string };
      const cardId = String(ctx.cardId ?? "").trim();
      if (!cardId) return res.status(400).json({ error: "Set a Card ID before generating artwork." });
      if (!validVqCardId(cardId)) return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
      if (!ctx.name && body.mode !== "family-sheet") return res.status(400).json({ error: "Set a card name before generating artwork." });
      if (!ctx.element) return res.status(400).json({ error: "Set an element before generating artwork." });

      const slot: ArtworkSlot = body.slot === "prev" ? "prev" : "main";
      const mode = String(body.mode ?? (slot === "prev" ? "prev-portrait" : "main")).trim() || "main";
      if ((slot === "prev" || mode === "prev-portrait") && !ctx.previousStage) {
        return res.status(400).json({ error: "Set the previous-stage name before generating previous-stage art." });
      }

      const inGuard = guardInput(JSON.stringify(ctx));
      if (!inGuard.ok) return res.status(422).json({ error: `Blocked by guardrails: ${inGuard.violations.join("; ")}` });

      let prompt = buildVaultQuestArtworkPrompt(ctx, mode, slot);
      let promptProvider = "vault-quest-fallback";
      let promptModel = "rules";
      let promptNote: string | undefined;
      const promptResult = await runGenerator("artwork-prompt", mode, ctx, 1).catch((err: unknown) => ({
        suggestions: [],
        provider: "none",
        model: "none",
        promptSummary: "",
        dropped: 0,
        note: err instanceof Error ? err.message : "Text prompt generator unavailable.",
      }));
      const suggestedPrompt = promptResult.suggestions[0]?.text?.trim();
      if (suggestedPrompt) {
        prompt = suggestedPrompt;
        promptProvider = promptResult.provider;
        promptModel = promptResult.model;
      } else {
        promptNote = promptResult.note;
      }

      const outGuard = guardOutput("artwork-prompt", prompt);
      if (outGuard.hard.length) {
        prompt = buildVaultQuestArtworkPrompt(ctx, mode, slot);
        promptProvider = "vault-quest-fallback";
        promptModel = "rules";
        const fallbackGuard = guardOutput("artwork-prompt", prompt);
        if (fallbackGuard.hard.length) return res.status(422).json({ error: `Artwork prompt blocked: ${fallbackGuard.hard.join("; ")}` });
        promptNote = "Text prompt was blocked by guardrails, so Vault Quest used the safe fallback prompt.";
      }

      // Clean provider-not-connected response (503) BEFORE attempting generation —
      // so a missing Higgsfield key on prod reports cleanly and never blocks text
      // AI or Save Draft (those are independent routes).
      const conn = higgsfieldConnection();
      if (!conn.connected) return res.status(503).json({ error: "Artwork provider not connected", provider: "higgsfield", note: conn.note, connected: false });

      const artwork = await generateHiggsfieldArtwork({ prompt, mode, slot });
      const candidateKey = assertVqWriteKey(vqArtworkCandidateKey(cardId));
      await uploadToR2(candidateKey, artwork.png, "image/png");
      // Audit is best-effort: the image is already generated + uploaded, so a
      // logging failure must NOT 500 the request (matches /ai/generate).
      let generationId: number | null = null;
      try {
        generationId = await vqStorage.recordAiGeneration({
          cardId,
          kind: "artwork-image",
          mode,
          provider: artwork.provider,
          model: artwork.model,
          generatedBy: "admin",
          prompt,
          output: {
            candidateKey,
            slot,
            width: artwork.width,
            height: artwork.height,
            jobId: artwork.jobId ?? null,
            promptProvider,
            promptModel,
            promptNote: promptNote ?? null,
          },
          applied: false,
        });
      } catch { /* audit table optional; never fail an already-generated image */ }

      res.status(201).json({
        candidateKey,
        slot,
        provider: artwork.provider,
        model: artwork.model,
        generationId,
        prompt,
        promptProvider,
        promptModel,
        note: promptNote,
        width: artwork.width,
        height: artwork.height,
        preview: `data:image/png;base64,${artwork.png.toString("base64")}`,
        disclaimer: AI_DISCLAIMER,
      });
    } catch (err) {
      // Expired/invalid token → clean 503 "provider not connected" (not a crash);
      // real generation faults stay 500. Text AI + Save Draft are unaffected either way.
      const msg = err instanceof Error ? err.message : "Artwork generation failed";
      const notConnected = /not connected|rejected the token|401|Invalid credentials/i.test(msg);
      res.status(notConnected ? 503 : 500).json({ error: notConnected ? "Artwork provider not connected — token missing or expired" : msg, connected: notConnected ? false : undefined });
    }
  });

  app.post("/api/admin/vault-quest/ai/artwork/use", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as { cardId?: string; slot?: string; candidateKey?: string; generationId?: number | null };
      const cardId = String(body.cardId ?? "").trim();
      const candidateKey = String(body.candidateKey ?? "").trim();
      if (!cardId) return res.status(400).json({ error: "Set a Card ID before using artwork." });
      if (!validVqCardId(cardId)) return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
      if (!candidateKey || !isCandidateKeyForCard(candidateKey, cardId)) return res.status(400).json({ error: "Artwork candidate does not belong to this card." });
      const slot: ArtworkSlot = body.slot === "prev" ? "prev" : "main";
      const buf = await getR2Buffer(candidateKey);
      if (!buf) return res.status(404).json({ error: "Artwork candidate expired or was not found." });
      const guard = await validateArtwork(buf);
      if (!guard.ok) return res.status(422).json({ error: guard.error ?? "Artwork candidate failed validation." });
      // Use = attach + validate ONLY. It does not approve artwork, does not change
      // card status, and does not mark the audit applied — that happens when the
      // candidate is actually promoted into draft art on Save Draft.
      res.json({ candidateKey, slot, width: guard.width, height: guard.height });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to use artwork" });
    }
  });

  app.post("/api/admin/vault-quest/ai/generations/:id/applied", requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });
      await vqStorage.markAiGenerationApplied(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed" });
    }
  });

  // taxonomy for the dropdowns + provider status (keywords/effects derived from cards)
  app.get("/api/admin/vault-quest/taxonomy", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const cards = await vqStorage.listCards({ setCode: "GNV" });
      const keywords = new Set<string>();
      const effects = new Set<string>();
      for (const c of cards) {
        (c.keywords ?? []).forEach((k) => k && keywords.add(k));
        const eff = c.effects;
        if (Array.isArray(eff)) (eff as unknown[]).forEach((e) => typeof e === "string" && e && effects.add(e));
      }
      res.json({ keywords: [...keywords].sort(), effects: [...effects].sort(), providers: providerStatuses() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "taxonomy failed" });
    }
  });

  // add-new element (placeholder palette, NEEDS_APPROVAL by convention)
  app.post("/api/admin/vault-quest/elements", requireAdmin, async (req: Request, res: Response) => {
    try {
      const name = String((req.body as { name?: string }).name ?? "").trim();
      if (!/^[A-Za-z][A-Za-z0-9 ]{0,23}$/.test(name)) return res.status(400).json({ error: "element name must be 1-24 letters/digits/spaces" });
      const el = await vqStorage.createElement(name);
      res.status(201).json({ element: el.name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "add element failed" });
    }
  });

  // add-new family (auto id, create-only, no cards)
  app.post("/api/admin/vault-quest/families", requireAdmin, async (req: Request, res: Response) => {
    try {
      const b = req.body as { name?: string; element?: string; stage1Name?: string; stage2Name?: string; stage3Name?: string; setCode?: string };
      const name = String(b.name ?? "").trim();
      const element = String(b.element ?? "").trim();
      if (!name || !element) return res.status(400).json({ error: "family name and element are required" });
      const setCode = (b.setCode ?? "GNV").trim() || "GNV";
      const existing = await vqStorage.listFamilies(setCode);
      let max = 0;
      for (const f of existing) { const m = /F(\d+)/.exec(f.familyId ?? ""); if (m) max = Math.max(max, Number(m[1])); }
      const familyId = `${setCode}-F${String(max + 1).padStart(2, "0")}`;
      await vqStorage.createFamilyAndCards(
        { familyId, setCode, element, name, stage1Name: b.stage1Name?.trim() || null, stage2Name: b.stage2Name?.trim() || null, stage3Name: b.stage3Name?.trim() || null },
        [],
      );
      res.status(201).json({ familyId, name });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "add family failed" });
    }
  });

  // ---- live preview (DB-free) ----
  app.post("/api/admin/vault-quest/cards/preview", requireAdmin, async (req: Request, res: Response) => {
    try {
      const body = req.body as VqEditorPayload;
      const art = await fetchArt(body);
      const { qa, previewPng } = await renderCard(body, art, "preview");
      res.json({
        qa,
        preview: previewPng ? `data:image/png;base64,${previewPng.toString("base64")}` : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "preview failed" });
    }
  });

  // ---- export svg/png/pdf (DB-free) ----
  app.post("/api/admin/vault-quest/cards/export/:fmt", requireAdmin, async (req: Request, res: Response) => {
    const fmt = String(req.params.fmt);
    if (!["svg", "png", "pdf"].includes(fmt)) return res.status(400).json({ error: "fmt must be svg, png or pdf" });
    try {
      const body = req.body as VqEditorPayload;
      const art = await fetchArt(body);
      const result = await renderCard(body, art, "all");
      if (result.qa.status === "reject") return res.status(422).json({ error: "card fails QA", qa: result.qa });
      const base = (body.cardId || "card").replace(/[^A-Za-z0-9._-]/g, "_");
      if (fmt === "svg") {
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.svg"`);
        return res.send(result.svg);
      }
      if (fmt === "png") {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename="${base}.png"`);
        // 600-DPI master (print-grade), not the 300-DPI live-preview PNG.
        return res.send(result.masterPng ?? result.previewPng);
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
      return res.send(result.pdf ? normalizePdf(result.pdf) : result.pdf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "export failed" });
    }
  });

  // ---- artwork upload -> R2 vq/art/ (served later by id) ----
  app.post(
    "/api/admin/vault-quest/cards/:cardId/art",
    requireAdmin,
    toolsUpload.single("file"),
    async (req: Request, res: Response) => {
      try {
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) return res.status(400).json({ error: "no file uploaded (field 'file')" });
        const guard = await validateArtwork(file.buffer);
        if (!guard.ok) return res.status(400).json({ error: guard.error });
        const cardId = String(req.params.cardId);
        // Root cause fix: params are URL-decoded, so a crafted id could smuggle
        // "../" into the key. Validate the id, then hard-guard the final key.
        if (!validVqCardId(cardId)) return res.status(400).json({ error: "Card ID can only use letters, numbers, dots, dashes, and underscores." });
        const slot = (req.query.slot as string) === "prev" ? "prev" : "main";
        const png = await (await import("sharp")).default(file.buffer).png().toBuffer();
        const key = assertVqWriteKey(vqArtKey(cardId, slot));
        await uploadToR2(key, png, "image/png");
        res.json({ key, slot, width: guard.width, height: guard.height });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "upload failed" });
      }
    },
  );

  // ---- serve stored artwork BY CARD ID (never the raw R2 key) ----
  app.get("/api/admin/vault-quest/cards/:cardId/art/:slot", requireAdmin, async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      if (!validVqCardId(cardId)) return res.status(400).json({ error: "invalid card id" });
      const slot = String(req.params.slot) === "prev" ? "prev" : "main";
      const key = `vq/art/${cardId}/${slot}.png`;
      const buf = await getR2Buffer(key);
      if (!buf) return res.status(404).json({ error: "no artwork on file" });
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load artwork" });
    }
  });

  // ---- import a card master (CSV/JSON) ----
  // Dry run by default: parses + validates every row and returns the report,
  // touching NO database — usable before the vq_ tables exist. `?commit=true`
  // writes set/families/config/cards to the DB, which requires the vq_ tables
  // (the DB push is a separate, founder-approved gate). Same importer as the
  // `seed.ts` CLI, so the canonical 150-card master imports with no code change.
  app.post(
    "/api/admin/vault-quest/import",
    requireAdmin,
    toolsUpload.single("file"),
    async (req: Request, res: Response) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) return res.status(400).json({ error: "no file uploaded (field 'file')" });
      const os = await import("os");
      const nodePath = await import("path");
      const fs = await import("fs/promises");
      const ext = /\.json$/i.test(file.originalname || "") ? ".json" : ".csv";
      const tmp = nodePath.join(os.tmpdir(), `vq-import-${Date.now()}-${process.pid}${ext}`);
      try {
        await fs.writeFile(tmp, file.buffer);
        const { importMaster } = await import("../vault-quest/seed");
        const report = await importMaster(tmp, { commit: req.query.commit === "true", editedBy: "admin-import" });
        res.json({ report });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "import failed" });
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    },
  );

  // ---- dashboard aggregates (fast, render-free) ----
  app.get("/api/admin/vault-quest/dashboard", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await vqStorage.dashboardSummary(String(req.query.setCode || "GNV")));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "dashboard failed" });
    }
  });

  // ---- families ----
  app.get("/api/admin/vault-quest/families", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json({ families: await vqStorage.listFamilies() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to list families" });
    }
  });
  app.get("/api/admin/vault-quest/families/:familyId", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await vqStorage.familyTree(String(req.params.familyId)));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load family" });
    }
  });

  // ---- revisions (history) ----
  app.get("/api/admin/vault-quest/cards/:cardId/revisions", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json({ revisions: await vqStorage.listRevisions(String(req.params.cardId)) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "failed to load revisions" });
    }
  });

  // ---- full QA evaluation for a saved card (resolves variants + runs render QA) ----
  app.get("/api/admin/vault-quest/cards/:cardId/evaluate", requireAdmin, async (req: Request, res: Response) => {
    try {
      const studio = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!studio) return res.status(404).json({ error: "card not found" });
      const art = await fetchArt(studio.card);
      const evaluation = await evaluateCard({ card: studio.card, previousStage: studio.previousStage, familyName: studio.familyName, base: studio.base, mainArt: art.mainArt, prevArt: art.prevArt });
      res.json(evaluation);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "evaluation failed" });
    }
  });

  // ---- status transition (gated by the workflow + QA) ----
  app.post("/api/admin/vault-quest/cards/:cardId/status", requireAdmin, async (req: Request, res: Response) => {
    try {
      const cardId = String(req.params.cardId);
      const body = req.body as { to?: string; note?: string; override?: boolean };
      if (!body.to || !isVqStatus(body.to)) return res.status(400).json({ error: "invalid target status" });
      const studio = await vqStorage.getStudioCard(cardId);
      if (!studio) return res.status(404).json({ error: "card not found" });
      const from = isVqStatus(studio.card.status) ? studio.card.status : "draft";
      const art = await fetchArt(studio.card);
      const evaluation = await evaluateCard({ card: studio.card, previousStage: studio.previousStage, familyName: studio.familyName, base: studio.base, mainArt: art.mainArt, prevArt: art.prevArt });
      const check = canTransition(from, body.to, evaluation.gates, !!body.override);
      if (!check.ok) return res.status(422).json({ error: "transition blocked", reasons: check.reasons, evaluation });
      const card = await vqStorage.setCardStatusAudited(cardId, body.to, body.note, "admin", from);
      res.json({ card, evaluation: { ...evaluation, status: body.to } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "transition failed" });
    }
  });

  // ---- render a SAVED card by id (resolves variant + art from R2) ----
  app.get("/api/admin/vault-quest/cards/:cardId/render/:fmt", requireAdmin, async (req: Request, res: Response) => {
    const fmt = String(req.params.fmt);
    if (!["svg", "png", "pdf"].includes(fmt)) return res.status(400).json({ error: "fmt must be svg, png or pdf" });
    try {
      const studio = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!studio) return res.status(404).json({ error: "card not found" });
      const { result } = await renderSavedFromStudio(studio, "all");
      if (result.qa.status === "reject") return res.status(422).json({ error: "card fails QA", qa: result.qa });
      const fname = studio.card.cardId.replace(/[^A-Za-z0-9._-]/g, "_");
      if (fmt === "svg") { res.setHeader("Content-Type", "image/svg+xml"); res.setHeader("Content-Disposition", `attachment; filename="${fname}.svg"`); return res.send(result.svg); }
      if (fmt === "png") { res.setHeader("Content-Type", "image/png"); res.setHeader("Content-Disposition", `attachment; filename="${fname}.png"`); return res.send(result.masterPng ?? result.previewPng); }
      res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${fname}.pdf"`); return res.send(result.pdf);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "render failed" });
    }
  });

  // ---- Export Centre + Proxy (Phases 10/11) ----
  type Selector = { ids?: string[]; familyId?: string; status?: string; approvedOnly?: boolean };
  const MAX_BATCH = 200; // hard cap: bounds render work + blocks a crafted huge `ids` DoS
  async function resolveCardIds(sel: Selector): Promise<string[]> {
    let ids: string[];
    if (sel.ids?.length) {
      ids = sel.ids;
    } else {
      let cards = await vqStorage.listCards({ setCode: "GNV" });
      if (sel.familyId) cards = cards.filter((c) => c.familyId === sel.familyId);
      if (sel.status) cards = cards.filter((c) => c.status === sel.status);
      if (sel.approvedOnly) cards = cards.filter((c) => ["approved", "export_ready", "printed_proxy"].includes(c.status));
      ids = cards.map((c) => c.cardId);
    }
    return ids.slice(0, MAX_BATCH);
  }

  // set-integrity QA (collector-number uniqueness / completeness / base refs)
  app.get("/api/admin/vault-quest/qa/set", requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(setIntegrity(await vqStorage.listCards({ setCode: "GNV" })));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "set QA failed" });
    }
  });

  // per-card metadata JSON (print house)
  app.get("/api/admin/vault-quest/cards/:cardId/metadata", requireAdmin, async (req: Request, res: Response) => {
    try {
      const s = await vqStorage.getStudioCard(String(req.params.cardId));
      if (!s) return res.status(404).json({ error: "card not found" });
      res.json(cardMetadata(s.card, s.previousStage));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "metadata failed" });
    }
  });

  // batch QA matrix (dashboard "Run QA" over a selection; capped)
  app.post("/api/admin/vault-quest/qa/batch", requireAdmin, async (req: Request, res: Response) => {
    try {
      const ids = await resolveCardIds(req.body as Selector);
      // One batched load (2 queries) instead of 3 queries per card, then art is
      // fetched only for cards that actually have artwork on file.
      const studios = await vqStorage.getStudioCardsBatch(ids);
      const results = [];
      for (const s of studios) {
        const art = await fetchArt(s.card);
        const e = await evaluateCard({ card: s.card, previousStage: s.previousStage, familyName: s.familyName, base: s.base, mainArt: art.mainArt, prevArt: art.prevArt });
        results.push({ cardId: s.card.cardId, status: e.status, render: e.renderStatus, readiness: e.readiness, rejects: e.qa.filter((i) => i.level === "reject").length });
      }
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "batch QA failed" });
    }
  });

  // Export/proxy are async background jobs: POST kicks the job off and returns a
  // jobId immediately (no request timeout / no event-loop block), the client polls
  // status for progress, then downloads the finished file. See export-jobs.ts.
  function startBatch(kind: "pack" | "proxy") {
    return async (req: Request, res: Response) => {
      try {
        const ids = await resolveCardIds(req.body as Selector);
        if (!ids.length) return res.status(400).json({ error: "no cards selected" });
        const { id } = startExportJob(kind, ids);
        res.status(202).json({ jobId: id, count: ids.length });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : `${kind} failed to start` });
      }
    };
  }

  // proxy sheet PDF (A4 3×3) — background job
  app.post("/api/admin/vault-quest/proxy", requireAdmin, startBatch("proxy"));
  // export pack (.zip): svg/png/pdf + per-card metadata + manifest + checksums — background job
  app.post("/api/admin/vault-quest/export/pack", requireAdmin, startBatch("pack"));

  // job progress (poll)
  app.get("/api/admin/vault-quest/export/jobs/:id", requireAdmin, (req: Request, res: Response) => {
    const job = getExportJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: "job not found or expired" });
    res.json(jobStatus(job));
  });

  // download the finished file (streamed from the temp file; kept until TTL so it
  // can be re-downloaded)
  app.get("/api/admin/vault-quest/export/jobs/:id/file", requireAdmin, async (req: Request, res: Response) => {
    const job = getExportJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: "job not found or expired" });
    if (job.state === "running") return res.status(409).json({ error: "export still running" });
    if (job.state === "error") return res.status(422).json({ error: job.error ?? "export failed" });
    if (!job.filePath) return res.status(410).json({ error: "export file no longer available" });
    const fs = await import("fs");
    if (!fs.existsSync(job.filePath)) return res.status(410).json({ error: "export file no longer available" });
    res.setHeader("Content-Type", job.contentType ?? "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${job.fileName ?? "export.bin"}"`);
    if (job.bytes) res.setHeader("Content-Length", String(job.bytes));
    const stream = fs.createReadStream(job.filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "failed to read export file" });
      else res.destroy();
    });
    // if the client disconnects mid-download, tear the read stream down (no fd leak)
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
}
