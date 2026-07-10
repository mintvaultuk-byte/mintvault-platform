/**
 * Next Task Engine + workflow feed (Phase 5).
 *
 * Derives "what should the founder do next" ENTIRELY from existing data — no new
 * tables, no migrations. Per character the canonical order is:
 *   Description → Approve Description → Master Reference → Action Pose →
 *   Approve References → Lock Character → Generate Cards
 * then set-level: QA → Packaging → Release.
 *
 * Also computes: the production queue (every open task, ordered), smart warnings
 * (release is blocked while any exist), credits usage (from vq_ai_generations),
 * recent items and the activity timeline (from revision + generation history).
 *
 * VQ-only; read-only; degrades gracefully where Phase-4 tables (0007) are absent.
 */
import { desc } from "drizzle-orm";
import { db } from "../db";
import { vqStorage } from "./storage";
import { vqAiGenerations, vqCharacterRevisions, vqCardRevisions, type VqCharacter, type VqCardRow } from "@shared/vq-schema";
import { STATUS_META, type VqStatus } from "@shared/vq-workflow";
import { higgsfieldCreditsPerImage, vqArtworkCandidateKey } from "./ai/higgsfield";
import { vqCharacterCandidateKey, assertVqWriteKey } from "./render-saved";
import { getR2Buffer, uploadToR2 } from "../r2";
import { productionStorage, isUndefinedTable } from "./production-storage";

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUndefinedTable(err)) return fallback;
    throw err;
  }
}

const cardIsDone = (status: string) => STATUS_META[status as VqStatus]?.tone === "success";

// ── Task model ───────────────────────────────────────────────────────────────
export type TaskKind =
  | "description"
  | "approve_description"
  | "master_reference"
  | "action_pose"
  | "approve_references"
  | "lock_character"
  | "generate_cards"
  | "qa"
  | "packaging"
  | "release";

const TASK_META: Record<TaskKind, { label: string; section: string; priority: number }> = {
  description: { label: "Generate Description", section: "characters", priority: 1 },
  approve_description: { label: "Approve Description", section: "characters", priority: 2 },
  master_reference: { label: "Generate Master Reference", section: "characters", priority: 3 },
  action_pose: { label: "Generate Action Pose", section: "characters", priority: 4 },
  approve_references: { label: "Approve References", section: "characters", priority: 5 },
  lock_character: { label: "Lock Character", section: "characters", priority: 6 },
  generate_cards: { label: "Generate Cards", section: "standard", priority: 7 },
  qa: { label: "Run QA", section: "qa", priority: 8 },
  packaging: { label: "Packaging", section: "packaging", priority: 9 },
  release: { label: "Release", section: "release", priority: 10 },
};

/** Complete deep-link target: RESUME WORK opens EXACTLY this. */
export interface TaskTarget {
  setCode: string;
  familyId: string | null;
  characterId: string | null;
  cardId: string | null;
  section: string;
  step: TaskKind;
  referenceType: string | null;
  /** SPA URL (query-param based, refresh-safe) that opens the exact target */
  url: string;
}

export interface WorkflowTask {
  id: string;
  kind: TaskKind;
  label: string;
  section: string;
  characterId: string | null;
  characterName: string | null;
  familyId: string | null;
  stageNumber: number | null;
  cardId: string | null;
  status: "queued" | "waiting_for_review" | "approved" | "locked" | "completed";
  /** rough founder-minutes to complete — powers "estimated time remaining" */
  estMinutes: number;
  /** estimated credit cost if this task generates images */
  estCredits: number;
  /** asset-reuse hint: an approved asset already exists for this need */
  reuse: { alreadyExists: boolean; note: string } | null;
  target: TaskTarget;
}

const REF_FOR_KIND: Partial<Record<TaskKind, string>> = {
  master_reference: "master_portrait",
  action_pose: "action_pose",
  approve_references: "master_portrait",
};

function buildTarget(kind: TaskKind, setCode: string, ch: { characterId: string; familyId: string } | null, cardId: string | null): TaskTarget {
  const referenceType = REF_FOR_KIND[kind] ?? null;
  let url: string;
  if (cardId && kind === "generate_cards") {
    url = `/admin/vault-quest?card=${encodeURIComponent(cardId)}&step=${kind}`;
  } else if (ch) {
    url = `/admin/vault-quest?bible=${encodeURIComponent(ch.characterId)}&step=${kind}${referenceType ? `&ref=${referenceType}` : ""}`;
  } else {
    url = `/admin/vault-quest/studio?section=${TASK_META[kind].section}${cardId ? `&ref=${encodeURIComponent(cardId)}` : ""}`;
  }
  return {
    setCode,
    familyId: ch?.familyId ?? null,
    characterId: ch?.characterId ?? null,
    cardId,
    section: TASK_META[kind].section,
    step: kind,
    referenceType,
    url,
  };
}

export interface SmartWarning {
  code: string;
  severity: "warn" | "block";
  message: string;
  ref: string | null;
}

/** Per-character: the FIRST unfinished step in the canonical order, or null when done. */
function nextTaskForCharacter(ch: VqCharacter, cardsByBase: Map<string, VqCardRow[]>): WorkflowTask | null {
  const pack = (ch.referencePack ?? {}) as Partial<Record<string, { r2Key?: string }>>;
  const hasDescriptionText = !!(ch.visualDescription && ch.characterDna);
  const hasMaster = !!pack.master_portrait?.r2Key || !!ch.approvedArtworkR2Key;
  const hasAction = !!pack.action_pose?.r2Key;

  const mk = (kind: TaskKind, status: WorkflowTask["status"], estMinutes: number, estCredits: number, reuse: WorkflowTask["reuse"] = null, cardId: string | null = null): WorkflowTask => ({
    id: `${ch.characterId}:${kind}`,
    kind,
    label: TASK_META[kind].label,
    section: TASK_META[kind].section,
    characterId: ch.characterId,
    characterName: ch.characterName,
    familyId: ch.familyId,
    stageNumber: ch.stageNumber,
    cardId,
    status,
    estMinutes,
    estCredits,
    reuse,
    target: buildTarget(kind, ch.setCode, { characterId: ch.characterId, familyId: ch.familyId }, cardId),
  });

  const perImage = higgsfieldCreditsPerImage();
  if (ch.descriptionStatus !== "approved") {
    if (!hasDescriptionText) return mk("description", "queued", 3, 0);
    return mk("approve_description", "waiting_for_review", 2, 0);
  }
  if (!hasMaster) return mk("master_reference", "queued", 5, perImage * 3, ch.approvedArtworkR2Key ? { alreadyExists: true, note: "Approved artwork exists — reuse instead of regenerating" } : null);
  if (!hasAction) return mk("action_pose", "queued", 5, perImage * 3);
  if (ch.approvalStatus !== "approved") return mk("approve_references", "waiting_for_review", 3, 0, { alreadyExists: true, note: "References generated — review, don't regenerate" });
  if (!ch.locked) return mk("lock_character", "approved", 1, 0);

  const cards = cardsByBase.get(ch.cardId ?? "") ?? [];
  const undone = cards.filter((c) => !cardIsDone(c.status));
  const noArt = undone.filter((c) => !c.artR2Key);
  if (undone.length > 0) {
    return mk(
      "generate_cards",
      "locked",
      undone.length * 4,
      noArt.length * perImage,
      noArt.length < undone.length ? { alreadyExists: true, note: `${undone.length - noArt.length} card(s) already have artwork — reuse` } : null,
      undone[0].cardId,
    );
  }
  return null; // character fully complete
}

export async function getWorkflow(setCode = "GNV") {
  const [characters, cards, status] = await Promise.all([
    vqStorage.listCharacters(setCode).catch(() => [] as VqCharacter[]),
    vqStorage.listCards({ setCode }).catch(() => [] as VqCardRow[]),
    productionStorage.getProductionStatus(setCode),
  ]);

  const cardsByBase = new Map<string, VqCardRow[]>();
  for (const c of cards) {
    const base = c.baseCardId ?? c.cardId;
    const list = cardsByBase.get(base) ?? [];
    list.push(c);
    cardsByBase.set(base, list);
  }

  // ── queue: every open character task in canonical family/stage order ──
  const queue: WorkflowTask[] = [];
  const sorted = [...characters].sort((a, b) => a.familyId.localeCompare(b.familyId) || a.stageNumber - b.stageNumber);
  for (const ch of sorted) {
    const t = nextTaskForCharacter(ch, cardsByBase);
    if (t) queue.push(t);
  }
  // set-level tasks once all character work is queued
  const packagingStage = status.stages.find((s) => s.key === "packaging");
  const qaStage = status.stages.find((s) => s.key === "qa");
  const mkSet = (kind: TaskKind, estMinutes: number): WorkflowTask => ({
    id: `set:${kind}`, kind, label: TASK_META[kind].label, section: TASK_META[kind].section,
    characterId: null, characterName: null, familyId: null, stageNumber: null, cardId: null,
    status: "queued", estMinutes, estCredits: 0, reuse: null, target: buildTarget(kind, setCode, null, null),
  });
  if (qaStage && qaStage.status !== "completed") queue.push(mkSet("qa", 30));
  if (packagingStage && packagingStage.status !== "completed") queue.push(mkSet("packaging", 60));
  if (!status.release.releaseReady) queue.push(mkSet("release", 15));

  // Character-priority ordering: finish lower-priority steps first across the set
  queue.sort((a, b) => TASK_META[a.kind].priority - TASK_META[b.kind].priority || (a.familyId ?? "zz").localeCompare(b.familyId ?? "zz") || (a.stageNumber ?? 9) - (b.stageNumber ?? 9));

  const current = queue[0] ?? null;
  const estMinutesRemaining = queue.reduce((a, t) => a + t.estMinutes, 0);
  const estCreditsRemaining = queue.reduce((a, t) => a + t.estCredits, 0);

  // ── smart warnings ──
  const warnings: SmartWarning[] = [];
  const byFamily = new Map<string, VqCharacter[]>();
  for (const ch of characters) {
    const l = byFamily.get(ch.familyId) ?? [];
    l.push(ch);
    byFamily.set(ch.familyId, l);
  }
  for (const [famId, list] of byFamily) {
    const stages = [...list].sort((a, b) => a.stageNumber - b.stageNumber);
    for (let i = 1; i < stages.length; i++) {
      const a = stages[i - 1];
      const b = stages[i];
      if (a.visualDescription && b.visualDescription && a.visualDescription.trim() === b.visualDescription.trim()) {
        warnings.push({ code: "stage_identical", severity: "block", message: `${famId}: Stage ${b.stageNumber} description is identical to Stage ${a.stageNumber} — stages must evolve`, ref: b.characterId });
      }
    }
    const approved = list.filter((c) => c.approvalStatus === "approved").length;
    if (approved > 0 && approved < list.length) {
      warnings.push({ code: "family_incomplete", severity: "warn", message: `${famId}: family incomplete — ${approved}/${list.length} characters approved`, ref: famId });
    }
  }
  for (const ch of characters) {
    if (ch.approvalStatus === "approved" && !ch.locked) {
      warnings.push({ code: "character_not_locked", severity: "warn", message: `${ch.characterName} (${ch.characterId}) is approved but not locked`, ref: ch.characterId });
    }
  }
  const packaging = await productionStorage.listPackaging(setCode);
  const allLocked = characters.length > 0 && characters.every((c) => c.locked);
  for (const p of packaging) {
    if (p.artworkR2Key && !allLocked) {
      warnings.push({ code: "packaging_unfinished_art", severity: "block", message: `Packaging "${p.name}" has artwork while characters are still unlocked — packaging must use only locked canonical characters`, ref: String(p.id) });
    }
  }
  const qaChecks = await productionStorage.listQa(setCode);
  const qaRefs = new Set(qaChecks.map((q) => q.assetRef));
  const doneCards = cards.filter((c) => cardIsDone(c.status));
  for (const c of doneCards) {
    if (!qaRefs.has(c.cardId)) warnings.push({ code: "card_missing_qa", severity: "warn", message: `Card ${c.cardId} is done but has no QA check`, ref: c.cardId });
  }
  const releaseBlocked = warnings.length > 0;

  // ── credits (from vq_ai_generations; ~1 image-generation ≈ perImage credits, text ≈ 0) ──
  const gens = await safe(() => db.select().from(vqAiGenerations).orderBy(desc(vqAiGenerations.createdAt)).limit(500), [] as (typeof vqAiGenerations.$inferSelect)[]);
  const perImage = higgsfieldCreditsPerImage();
  const now = Date.now();
  const dayMs = 86_400_000;
  const startOfToday = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
  const isImage = (g: { kind?: string | null; mode?: string | null }) => /art|image|reference|portrait|pose/i.test(`${g.kind ?? ""} ${g.mode ?? ""}`);
  const creditsOf = (list: typeof gens) => list.reduce((a, g) => a + (isImage(g) ? perImage : 0), 0);
  const inWindow = (g: (typeof gens)[number], ms: number) => !!g.createdAt && now - new Date(g.createdAt).getTime() <= ms;
  const gensToday = gens.filter((g) => !!g.createdAt && new Date(g.createdAt).getTime() >= startOfToday);
  const gensWeek = gens.filter((g) => inWindow(g, 7 * dayMs));
  const gensMonth = gens.filter((g) => inWindow(g, 30 * dayMs));
  const cardIdsWithGens = new Set(gens.map((g) => g.cardId).filter(Boolean));
  const familyOf = new Map(cards.map((c) => [c.cardId, c.familyId]));
  const famWithGens = new Set([...cardIdsWithGens].map((id) => familyOf.get(id as string)).filter(Boolean));
  const totalCredits = creditsOf(gens);
  const reusableApproved = characters.filter((c) => !!c.approvedArtworkR2Key || !!(c.referencePack as Record<string, unknown> | null)?.master_portrait).length;
  const credits = {
    today: creditsOf(gensToday),
    week: creditsOf(gensWeek),
    month: creditsOf(gensMonth),
    generationsToday: gensToday.length,
    avgPerCard: cardIdsWithGens.size ? Math.round((totalCredits / cardIdsWithGens.size) * 10) / 10 : 0,
    avgPerFamily: famWithGens.size ? Math.round((totalCredits / famWithGens.size) * 10) / 10 : 0,
    estimatedRemaining: estCreditsRemaining,
    potentialSavings: reusableApproved * perImage,
    perImage,
  };

  // ── recent items + activity timeline (revision/generation history) ──
  const charRevs = await safe(() => db.select().from(vqCharacterRevisions).orderBy(desc(vqCharacterRevisions.editedAt)).limit(15), [] as (typeof vqCharacterRevisions.$inferSelect)[]);
  const cardRevs = await safe(() => db.select().from(vqCardRevisions).orderBy(desc(vqCardRevisions.editedAt)).limit(15), [] as (typeof vqCardRevisions.$inferSelect)[]);
  const byUpdated = [...characters].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const recent = {
    edited: charRevs.slice(0, 5).map((r) => ({ ref: r.characterId, note: r.reason ?? "edited", at: r.editedAt ? new Date(r.editedAt).toISOString() : "" })),
    generated: gens.slice(0, 5).map((g) => ({ ref: g.cardId ?? "—", note: `${g.kind ?? "generation"}${g.mode ? ` · ${g.mode}` : ""}`, at: g.createdAt ? new Date(g.createdAt).toISOString() : "" })),
    approved: byUpdated.filter((c) => c.approvalStatus === "approved").slice(0, 5).map((c) => ({ ref: c.characterId, note: c.characterName, at: new Date(c.updatedAt).toISOString() })),
    locked: byUpdated.filter((c) => c.locked).slice(0, 5).map((c) => ({ ref: c.characterId, note: c.characterName, at: new Date(c.updatedAt).toISOString() })),
  };
  const activity = [
    ...charRevs.map((r) => ({ kind: "character", label: `${r.reason ?? "Edited"} — ${r.characterId}`, at: r.editedAt ? new Date(r.editedAt).toISOString() : "" })),
    ...cardRevs.map((r) => ({ kind: "card", label: `Card edited — ${r.cardId}`, at: r.editedAt ? new Date(r.editedAt).toISOString() : "" })),
    ...gens.slice(0, 15).map((g) => ({ kind: "generation", label: `Generated ${g.kind ?? "content"}${g.cardId ? ` — ${g.cardId}` : ""}`, at: g.createdAt ? new Date(g.createdAt).toISOString() : "" })),
  ]
    .filter((a) => a.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 25);

  return {
    setCode,
    current,
    queue: queue.slice(0, 100),
    queueTotal: queue.length,
    estMinutesRemaining,
    warnings,
    releaseBlocked,
    credits,
    recent,
    activity,
  };
}

// ── Approved-asset reuse (check before any generation; apply copies, never approves) ──
export interface ReusableAsset {
  label: string;
  r2Key: string;
  kind: "master_portrait" | "action_pose" | "approved_artwork" | "family_reference" | "card_artwork";
  approvalStatus: string;
  identityScore: number | null;
  from: string; // source character/card/family
}

export async function checkReuse(setCode: string, opts: { characterId?: string; cardId?: string; referenceType?: string }) {
  const assets: ReusableAsset[] = [];
  const characters = await vqStorage.listCharacters(setCode).catch(() => [] as VqCharacter[]);
  const byId = new Map(characters.map((c) => [c.characterId, c]));

  const packAssets = (ch: VqCharacter, from: string) => {
    const pack = (ch.referencePack ?? {}) as Partial<Record<string, { r2Key?: string }>>;
    for (const [type, entry] of Object.entries(pack)) {
      if (entry?.r2Key) assets.push({ label: `${ch.characterName} — ${type.replace("_", " ")}`, r2Key: entry.r2Key, kind: type === "action_pose" ? "action_pose" : "master_portrait", approvalStatus: "approved", identityScore: null, from });
    }
    if (ch.approvedArtworkR2Key) assets.push({ label: `${ch.characterName} — approved artwork`, r2Key: ch.approvedArtworkR2Key, kind: "approved_artwork", approvalStatus: "approved", identityScore: null, from });
  };

  let ch: VqCharacter | undefined;
  if (opts.characterId) ch = byId.get(opts.characterId);
  let card: VqCardRow | undefined;
  if (opts.cardId) {
    card = await vqStorage.getCard(opts.cardId).catch(() => undefined);
    if (card) {
      if (card.artR2Key) assets.push({ label: `${card.name} — existing card artwork`, r2Key: card.artR2Key, kind: "card_artwork", approvalStatus: card.status, identityScore: null, from: card.cardId });
      const baseId = card.baseCardId ?? card.cardId;
      ch = characters.find((c) => c.cardId === baseId);
    }
  }
  if (ch) {
    packAssets(ch, ch.characterId);
    // Family artwork: approved siblings in the same evolution line.
    for (const sib of characters.filter((c) => c.familyId === ch!.familyId && c.characterId !== ch!.characterId && c.approvalStatus === "approved")) {
      packAssets(sib, `family ${sib.familyId} · ${sib.characterId}`);
    }
  }

  // De-dup by key; attach identity scores where a scored candidate exists for that key.
  const seen = new Set<string>();
  const unique = assets.filter((a) => (seen.has(a.r2Key) ? false : (seen.add(a.r2Key), true)));
  if (ch || card) {
    const cands = await vqStorage.listArtworkCandidates(ch?.characterId ?? "", undefined).catch(() => []);
    const scoreByKey = new Map(cands.filter((c) => c.identityScore != null).map((c) => [c.r2Key, c.identityScore]));
    for (const a of unique) a.identityScore = scoreByKey.get(a.r2Key) ?? a.identityScore;
  }

  const perImage = higgsfieldCreditsPerImage();
  const imagesAvoided = opts.referenceType === "master_portrait" ? 3 : 1;
  return {
    assets: unique.slice(0, 12),
    creditsSaved: unique.length > 0 ? perImage * imagesAvoided : 0,
    perImage,
    referenceType: opts.referenceType ?? null,
  };
}

/**
 * Apply an EXPLICIT reuse: copy an existing approved vq/ asset into a NEW
 * candidate for the target character reference slot or card artwork. Zero image
 * credits. The copy lands in the normal candidate gallery — the founder still
 * reviews/approves through the standard flow. NO auto-approval, NO lock, NO card
 * status change, and nothing existing is replaced or deleted.
 */
export async function applyReuse(opts: { characterId?: string; cardId?: string; sourceR2Key: string; referenceType?: string }) {
  const source = (opts.sourceR2Key ?? "").trim();
  if (!source.startsWith("vq/")) throw new Error("reuse source must be an existing Vault Quest asset (vq/…)");
  const buf = await getR2Buffer(source);
  if (!buf) throw new Error("source asset not found in storage");

  if (opts.characterId) {
    // Validate the target parent exists — recordArtworkCandidate is a bare insert
    // with no FK, so an unknown characterId would mint an orphaned candidate.
    const character = await vqStorage.getCharacter(opts.characterId);
    if (!character) throw new Error("target character not found");
    const targetKey = assertVqWriteKey(vqCharacterCandidateKey(opts.characterId));
    await uploadToR2(targetKey, buf, "image/png");
    const candidate = await vqStorage.recordArtworkCandidate({
      characterId: opts.characterId,
      referenceType: opts.referenceType ?? "master_portrait",
      source: "reused",
      r2Key: targetKey,
      status: "candidate",
      createdBy: "admin",
      prompt: `reused from ${source}`,
    });
    return { targetKey, candidateId: candidate.id, creditsSpent: 0 };
  }
  if (opts.cardId) {
    const card = await vqStorage.getCard(opts.cardId);
    if (!card) throw new Error("target card not found");
    const targetKey = assertVqWriteKey(vqArtworkCandidateKey(opts.cardId));
    await uploadToR2(targetKey, buf, "image/png");
    return { targetKey, candidateId: null, creditsSpent: 0 };
  }
  throw new Error("characterId or cardId required");
}
export async function searchAll(setCode: string, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { results: [] };
  const match = (...vals: (string | null | undefined)[]) => vals.some((v) => v && v.toLowerCase().includes(needle));

  const [characters, cards, families, packaging, assets, prints, qa] = await Promise.all([
    vqStorage.listCharacters(setCode).catch(() => []),
    vqStorage.listCards({ setCode }).catch(() => []),
    vqStorage.listFamilies(setCode).catch(() => []),
    productionStorage.listPackaging(setCode),
    productionStorage.listAssets(setCode),
    productionStorage.listPrint(setCode),
    productionStorage.listQa(setCode),
  ]);

  const results = [
    ...characters.filter((c) => match(c.characterName, c.characterId, c.familyId)).map((c) => ({ type: "character", ref: c.characterId, label: c.characterName, sub: `${c.familyId} · stage ${c.stageNumber}`, section: "characters" })),
    ...families.filter((f) => match(f.name, f.familyId)).map((f) => ({ type: "family", ref: f.familyId, label: f.name, sub: f.familyId, section: "families" })),
    ...cards.filter((c) => match(c.name, c.cardId, c.collectorNumber)).map((c) => ({ type: "card", ref: c.cardId, label: c.name, sub: `${c.cardId} · ${c.status}`, section: c.baseCardId ? "variant" : "standard" })),
    ...packaging.filter((p) => match(p.name, p.type)).map((p) => ({ type: "packaging", ref: String(p.id), label: p.name, sub: p.type, section: "packaging" })),
    ...assets.filter((a) => match(a.name, a.category)).map((a) => ({ type: "asset", ref: String(a.id), label: a.name, sub: a.category, section: "assets" })),
    ...prints.filter((p) => match(p.type)).map((p) => ({ type: "print", ref: String(p.id), label: p.type, sub: p.status, section: "print" })),
    ...qa.filter((c) => match(c.assetRef, c.assetType)).map((c) => ({ type: "qa", ref: c.assetRef, label: c.assetRef, sub: `QA · ${c.status}`, section: "qa" })),
  ].slice(0, 30);

  return { results };
}
