import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminFetch, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AdminButton } from "@/components/admin";
import { Loader2, Upload, Save, History, FileImage, FileText, FileCode, Plus, AlertCircle, CheckCircle2, LayoutGrid, ArrowLeft, ShieldCheck, RotateCcw, XCircle, PackageCheck, Archive, Wand2, Sparkles, ChevronDown, BookOpen, Lock, Unlock } from "lucide-react";
import { STATUS_META, allowedTargets, type VqStatus } from "@shared/vq-workflow";
import { ReusePanel, fetchReuseCheck, useAdvancedMode, type ReuseCheck, type ReusableAsset } from "@/components/vault-quest/workflow";
import { characterHealth, traitsFromBreakdown, matchBand, scoreBand, poseDiversityBand, evolutionDifferenceBand, actionNoveltyBand, identityFullyPassing, STATE_CLS, type IdentityBreakdown, type HealthState } from "@/components/vault-quest/quality";
import { getOrCreateIdempotencyKey, clearIdempotencyKey } from "@/lib/vq-idempotency";
import { runGenerationWithRecovery, type GenerationPhase } from "@/lib/vq-generation-lifecycle";
import { VQ_ACTION_CATEGORY_OPTIONS, findActionCategory } from "@shared/vq-action-categories";
import { CreatureDesigner } from "@/components/vault-quest/creature-designer";
import { FounderSpendControlPanel } from "@/components/vault-quest/FounderSpendControlPanel";
import { ProviderConnectionPanel } from "@/components/vault-quest/ProviderConnectionPanel";
import { VqStoredImage } from "@/components/vault-quest/VqStoredImage";
import {
  batchConfirmationButtonText,
  batchMaximumCredits,
  canSubmitGeneration,
  expectedResolvedModel,
  featureForReferenceType,
  generationBlockedReasonWithProvider,
  generationStageLabel,
  isPremiumModel,
  planGenerationGate,
  providerGenerationBlockedReason,
  providerHardBlockReason,
  providerReadiness,
  resolveFounderFeatureMap,
  resolveFounderFeatureReasons,
  stageForPlan,
  type FounderFeatureKey,
  type FounderFeatureMap,
  type FounderFeatureStatus,
  type ProviderConnection,
} from "@/components/vault-quest/spend-control";

// AI Cost Mode — founder-friendly quality tiers that map to real image models.
// Simple Mode shows only these; Advanced Mode still exposes the model dropdown.
const COST_MODES: { key: "cheapest" | "balanced" | "highest"; label: string; hint: string; model: VqImageModel }[] = [
  { key: "cheapest", label: "Cheapest", hint: "Lowest credits", model: VQ_QUALITY_MODEL.draft },
  { key: "balanced", label: "Balanced", hint: "Recommended", model: VQ_QUALITY_MODEL.standard },
  { key: "highest", label: "Highest Quality", hint: "Best detail", model: VQ_QUALITY_MODEL.premium },
];
const costModeFor = (m: VqImageModel) => COST_MODES.find((c) => c.model === m)?.key ?? "balanced";
import { VQ_IMAGE_MODELS, VQ_QUALITY_MODEL, vqCreditsPerImage, vqChargedCredits, type VqImageModel } from "@shared/vq-schema";
import { estimatedCreditsForGenerateWith, requestModelForGenerateWith, resetGenerateWithAfterAttempt, type VqGenerateWith } from "@shared/vq-ai-provider";

// Vault Quest Studio — production control centre: dashboard board + card editor
// with the full status workflow. Renders via the shared (locked) engine.

// Core/Token intentionally omitted — the locked renderer rejects unknown types, so
// they'd create un-renderable cards. Gated on a locked-renderer extension.
const CARD_TYPES = ["Creature", "Tactic", "Relic", "Vault", "Collector", "Place"];
const VARIANT_TIERS = ["STANDARD", "CHR", "SRA", "FSR", "UR", "CR"];
const ELEMENTS = [
  "Flame", "Water", "Nature", "Storm", "Stone", "Shadow", "Neutral",
  "Blaze", "Tide", "Blossom", "Spark", "Earth", "Cosmos", "Wind",
  "Electric", "Ice", "Dark", "Light", "Brand", "Crystal",
];
const RARITIES = ["C", "U", "R", "SR", "GR", "UR", "SRA", "RR", "FSR", "CR"];
const SUPPORT = new Set(["Tactic", "Relic", "Vault", "Collector", "Place"]);

const TONE_CLS: Record<string, string> = {
  neutral: "bg-slate-700 text-slate-200",
  info: "bg-sky-900 text-sky-200 border border-sky-700",
  warn: "bg-amber-900 text-amber-200 border border-amber-700",
  success: "bg-emerald-900 text-emerald-200 border border-emerald-700",
  danger: "bg-red-950 text-red-300 border border-red-800",
};
function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status as VqStatus] ?? { label: status, tone: "neutral" };
  return <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${TONE_CLS[meta.tone]}`}>{meta.label}</span>;
}

type CardForm = {
  cardId: string; collectorNumber: string; name: string; displayName: string; cardType: string; element: string; rarity: string;
  familyId: string; familyName: string; stageNumber: string; lifeStage: string; previousStage: string;
  health: string; guard: string; shift: string;
  attack1Name: string; attack1Damage: string; attack1Effect: string; attack2Name: string; attack2Damage: string; attack2Effect: string;
  vulnerability: string; keywords: string; notes: string; artR2Key: string; prevArtR2Key: string; artCandidateKey: string; prevArtCandidateKey: string;
  attack1Cost: string; attack2Cost: string; variantTier: string; baseCardId: string; statusEffects: string;
};

const BLANK: CardForm = {
  cardId: "", collectorNumber: "", name: "", displayName: "", cardType: "Creature", element: "Flame",
  rarity: "C", familyId: "", familyName: "", stageNumber: "1", lifeStage: "BABY", previousStage: "",
  health: "5", guard: "0", shift: "0", attack1Name: "", attack1Damage: "", attack1Effect: "",
  attack2Name: "", attack2Damage: "", attack2Effect: "", vulnerability: "", keywords: "", notes: "",
  artR2Key: "", prevArtR2Key: "", artCandidateKey: "", prevArtCandidateKey: "", attack1Cost: "", attack2Cost: "", variantTier: "", baseCardId: "", statusEffects: "",
};

type BaseRef = { cardId: string; name: string; cardType: string; element: string; stageNumber: number | null; health: number | null; guard: number | null; shift: number | null; attack1Name: string | null; attack1Damage: number | null; status: string } | null;
type QaIssue = { level: "reject" | "warn"; field: string; message: string };
type CardSummary = { cardId: string; collectorNumber: string; name: string; cardType: string; element: string; rarity: string | null; stageNumber: number | null; familyId: string | null; variantTier: string | null; baseCardId: string | null; status: string; hasData: boolean; hasArt: boolean; placeholderElement: boolean; readiness: number };
type Dashboard = { total: number; byStatus: Record<string, number>; byType: Record<string, number>; variants: number; base: number; needsData: number; needsArtwork: number; placeholderElements: number; families: number; familiesComplete: number; cards: CardSummary[] };
type GenerateModal = {
  mode: "open-family" | "open-card" | "new-family" | "new-card";
  setCode: string;
  familyId: string;
  cardId: string;
  name: string;
  element: string;
  cardType: string;
};
type Evaluation = { readiness: number; bucket: string; gates: { dataComplete: boolean; artworkPresent: boolean; renderPasses: boolean; isVariant: boolean; baseApproved: boolean }; suggestions: string[]; qa: QaIssue[] };
type VqCharacterRow = {
  characterId: string;
  familyId: string;
  familyName: string | null;
  cardId: string;
  stageNumber: number;
  characterName: string;
  element: string;
  role: string | null;
  variantCardIds: string[] | null;
  evolvesFromCharacterId: string | null;
  sourceNotes: string | null;
  characterDna: string | null;
  visualDescription: string | null;
  bodyShape: string | null;
  colours: string | null;
  markings: string | null;
  eyes: string | null;
  tailAccessories: string | null;
  personality: string | null;
  stageProgressionNotes: string | null;
  elementIdentity: string | null;
  negativePrompt: string | null;
  masterArtworkPrompt: string | null;
  referenceArtworkR2Key: string | null;
  approvedArtworkR2Key: string | null;
  referencePack: Partial<Record<VqRefType, { r2Key: string; identityScore?: number | null }>> | null;
  descriptionStatus: string;
  approvalStatus: string;
  locked: boolean;
};

// Reference Pack (mirrors shared/vq-schema VQ_REFERENCE_TYPES; TCG requires the first two).
type VqRefType = "master_portrait" | "action_pose" | "face_closeup" | "colour_sheet" | "turnaround_sheet";
const REF_TYPES: { value: VqRefType; label: string; tier: "required" | "recommended" | "optional" }[] = [
  { value: "master_portrait", label: "Master Reference", tier: "required" },
  { value: "action_pose", label: "Action Pose", tier: "required" },
  { value: "face_closeup", label: "Face Close-up", tier: "recommended" },
  { value: "colour_sheet", label: "Colour Sheet", tier: "recommended" },
  { value: "turnaround_sheet", label: "Turnaround Sheet", tier: "optional" },
];
const REQUIRED_REF_TYPES: VqRefType[] = ["master_portrait", "action_pose"];
// Runtime guard: a handler wired as onClick={fn} passes a React MouseEvent as the
// first arg. This keeps such an event from ever reaching a request body / toast —
// only a real VqRefType string is accepted, otherwise callers fall back to state.
const isVqRefType = (v: unknown): v is VqRefType => typeof v === "string" && REF_TYPES.some((t) => t.value === v);
function packCompleteness(pack: VqCharacterRow["referencePack"]): "missing" | "partial" | "complete" {
  const p = pack ?? {};
  if (p.master_portrait?.r2Key && p.action_pose?.r2Key) return "complete";
  return Object.values(p).some((v) => v?.r2Key) ? "partial" : "missing";
}
const packApproved = (ch: VqCharacterRow, t: VqRefType) => !!ch.referencePack?.[t]?.r2Key;
const requiredComplete = (ch: VqCharacterRow) => REQUIRED_REF_TYPES.every((t) => packApproved(ch, t));
const requiredCount = (ch: VqCharacterRow) => REQUIRED_REF_TYPES.filter((t) => packApproved(ch, t)).length;
// character.identity passes when NO approved reference scored below the 70 threshold
// (bootstrap references with no score are treated as a pass).
const identityPassed = (ch: VqCharacterRow) => Object.values(ch.referencePack ?? {}).every((v) => v?.identityScore == null || v.identityScore >= 70);

type BibleFieldKey =
  | "characterDna"
  | "visualDescription"
  | "bodyShape"
  | "colours"
  | "markings"
  | "eyes"
  | "tailAccessories"
  | "personality"
  | "stageProgressionNotes"
  | "elementIdentity"
  | "negativePrompt"
  | "masterArtworkPrompt";
type BibleDraft = Record<BibleFieldKey, string>;

const BIBLE_FIELDS: { key: BibleFieldKey; label: string; rows: number }[] = [
  { key: "characterDna", label: "Character DNA", rows: 4 },
  { key: "visualDescription", label: "Visual description", rows: 4 },
  { key: "bodyShape", label: "Body shape", rows: 3 },
  { key: "colours", label: "Colours", rows: 2 },
  { key: "markings", label: "Markings", rows: 2 },
  { key: "eyes", label: "Eyes", rows: 2 },
  { key: "tailAccessories", label: "Tail / accessories", rows: 2 },
  { key: "personality", label: "Personality", rows: 2 },
  { key: "stageProgressionNotes", label: "Stage progression notes", rows: 3 },
  { key: "elementIdentity", label: "Element identity", rows: 2 },
  { key: "negativePrompt", label: "Negative prompt", rows: 3 },
  { key: "masterArtworkPrompt", label: "Master artwork prompt", rows: 5 },
];

const dnaComplete = (ch: VqCharacterRow) => BIBLE_FIELDS.every((f) => String(ch[f.key] ?? "").trim());
// Description workflow status (text before pixels): artwork needs an APPROVED description.
const descStatus = (ch: VqCharacterRow): "missing" | "draft" | "approved" | "needs_review" =>
  !dnaComplete(ch) ? "missing" : ch.descriptionStatus === "approved" ? "approved" : ch.descriptionStatus === "needs_review" ? "needs_review" : "draft";
const DESC_STATUS_META: Record<ReturnType<typeof descStatus>, { label: string; cls: string }> = {
  missing: { label: "Description Missing", cls: "bg-red-950 text-red-300" },
  draft: { label: "Description Draft", cls: "bg-amber-950 text-amber-300" },
  approved: { label: "Description Approved", cls: "bg-emerald-950 text-emerald-300" },
  needs_review: { label: "Needs Description Review", cls: "bg-orange-950 text-orange-300" },
};
// CANONICAL = DNA complete + description approved + required references + identity + locked.
const isCanonical = (ch: VqCharacterRow) => dnaComplete(ch) && ch.descriptionStatus === "approved" && requiredComplete(ch) && identityPassed(ch) && ch.locked;

function draftFromCharacter(ch?: VqCharacterRow | null): BibleDraft {
  return Object.fromEntries(BIBLE_FIELDS.map((f) => [f.key, ch?.[f.key] ?? ""])) as BibleDraft;
}

function toPayload(f: CardForm) {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return {
    cardId: f.cardId.trim(), collectorNumber: f.collectorNumber.trim(), name: f.name.trim(),
    displayName: f.displayName.trim() || null, cardType: f.cardType, element: f.element, rarity: f.rarity,
    familyId: f.familyId.trim() || null, familyName: f.familyName.trim() || null,
    stageNumber: num(f.stageNumber), lifeStage: f.lifeStage.trim() || null, previousStage: f.previousStage.trim() || null,
    health: num(f.health), guard: num(f.guard), shift: num(f.shift),
    attack1Name: f.attack1Name.trim() || null, attack1Damage: num(f.attack1Damage), attack1Effect: f.attack1Effect.trim() || null,
    attack2Name: f.attack2Name.trim() || null, attack2Damage: num(f.attack2Damage), attack2Effect: f.attack2Effect.trim() || null,
    vulnerability: f.vulnerability.trim() || null,
    keywords: f.keywords.trim() ? f.keywords.split(",").map((k) => k.trim()).filter(Boolean) : [],
    effects: f.statusEffects.trim() ? f.statusEffects.split(",").map((k) => k.trim()).filter(Boolean) : [],
    notes: f.notes.trim() || null, artR2Key: f.artR2Key || null, prevArtR2Key: f.prevArtR2Key || null,
    artCandidateKey: f.artCandidateKey || null, prevArtCandidateKey: f.prevArtCandidateKey || null,
    attack1Cost: num(f.attack1Cost), attack2Cost: num(f.attack2Cost),
    variantTier: f.variantTier.trim() || null, baseCardId: f.baseCardId.trim() || null,
  };
}

function triggerDownload(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Run a background export/proxy job: POST to start (returns a jobId immediately),
 * poll for progress, then stream down the finished file. This replaces the old
 * hold-the-request-open download so large exports can't time out.
 */
async function runExportJob(
  startUrl: string,
  body: unknown,
  fallbackName: string,
  onProgress: (done: number, total: number) => void,
  isAlive: () => boolean = () => true,
): Promise<{ rendered: number; skipped: number }> {
  const startRes = await adminFetch(startUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!startRes.ok) {
    const err = new Error((await startRes.json().catch(() => ({}))).error || `failed (${startRes.status})`) as Error & { status?: number };
    err.status = startRes.status;
    throw err;
  }
  const { jobId, count } = (await startRes.json()) as { jobId: string; count: number };
  onProgress(0, count ?? 0);

  const base = `/api/admin/vault-quest/export/jobs/${encodeURIComponent(jobId)}`;
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    // stop polling if the view was left (component unmounted) — the job keeps
    // running server-side and can be re-downloaded within its TTL.
    if (!isAlive()) return { rendered: 0, skipped: 0 };
    const sRes = await adminFetch(base, { credentials: "include" });
    if (!sRes.ok) {
      const err = new Error(`lost track of the export (${sRes.status}) — it may have expired`) as Error & { status?: number };
      err.status = sRes.status;
      throw err;
    }
    const s = (await sRes.json()) as { state: string; done: number; total: number; rendered: number; skipped: number; fileName?: string; error?: string };
    onProgress(s.done ?? 0, s.total ?? count ?? 0);
    if (s.state === "error") throw new Error(s.error || "export failed");
    if (s.state === "done") {
      const fRes = await adminFetch(`${base}/file`, { credentials: "include" });
      if (!fRes.ok) {
        const err = new Error((await fRes.json().catch(() => ({}))).error || `download failed (${fRes.status})`) as Error & { status?: number };
        err.status = fRes.status;
        throw err;
      }
      triggerDownload(await fRes.blob(), s.fileName || fallbackName);
      return { rendered: s.rendered ?? 0, skipped: s.skipped ?? 0 };
    }
  }
}

const inputCls = "w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 focus:border-amber-500 focus:outline-none";
const labelCls = "block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1";

// ---- AI Assist (Phase 7) ----
type AiField = Record<string, unknown>;
interface AiSug { text: string; reason?: string; pronunciation?: string; warning?: string; fields?: AiField }
interface AiResp { suggestions: AiSug[]; provider: string; model: string; dropped: number; note?: string; generationId?: number | null }
interface ProviderStat { id: string; label: string; connected: boolean; note: string }
interface ArtworkResp {
  candidateKey: string;
  slot: "main" | "prev";
  provider: string;
  model: string;
  prompt: string;
  preview: string;
  width: number;
  height: number;
  note?: string;
  promptProvider?: string;
  promptModel?: string;
  generationId?: number | null;
}

const AI_TABS: { id: string; label: string; kind: string; buttons: { mode: string; label: string; kind?: string }[] }[] = [
  { id: "names", label: "Names", kind: "name", buttons: [
    { mode: "generate", label: "Generate" }, { mode: "alternatives", label: "10 alternatives" }, { mode: "improve", label: "Improve" },
    { mode: "cuter", label: "Cuter" }, { mode: "powerful", label: "More powerful" }, { mode: "less-medieval", label: "Less medieval" }, { mode: "mascot", label: "Mascot-style" },
    { mode: "stage1", label: "Stage 1" }, { mode: "stage2", label: "Stage 2" }, { mode: "stage3", label: "Stage 3" },
    { mode: "generate", label: "Full family names", kind: "family-names" },
  ] },
  { id: "gameplay", label: "Gameplay", kind: "gameplay", buttons: [
    { mode: "attack1", label: "Attack 1" }, { mode: "attack2", label: "Attack 2" }, { mode: "balanced-pair", label: "Balanced pair" },
    { mode: "suggest-stats", label: "Suggest stats" }, { mode: "suggest-core", label: "Suggest Core" }, { mode: "suggest-vulnerability", label: "Vulnerability" },
    { mode: "weaker", label: "Weaker" }, { mode: "stronger", label: "Stronger" },
  ] },
  { id: "flavour", label: "Flavour", kind: "flavour", buttons: [{ mode: "generate", label: "Generate" }, { mode: "simpler", label: "Simpler" }, { mode: "child-readable", label: "Child-readable" }] },
  { id: "artwork", label: "Artwork", kind: "artwork-prompt", buttons: [
    { mode: "main", label: "Main" }, { mode: "prev-portrait", label: "Prev portrait" }, { mode: "family-sheet", label: "Family sheet" }, { mode: "fsr-scene", label: "FSR scene" },
    { mode: "cleaner", label: "Cleaner" }, { mode: "more-mascot", label: "More mascot" }, { mode: "less-pokemon", label: "Less Pokémon" },
  ] },
  { id: "variants", label: "Variants", kind: "artwork-prompt", buttons: [{ mode: "variant", label: "Variant artwork" }, { mode: "fsr-scene", label: "FSR scene" }] },
];

function AiAssist({ context, onApply, onUseArtwork, imageProviders, textConnected, onGenerateFull, fullBusy, fullCardBlocked, cardArtworkBlocked }: {
  context: Record<string, unknown>;
  onApply: (fields: AiField) => boolean;
  onUseArtwork: (art: { candidateKey: string; slot: "main" | "prev"; preview: string; generationId?: number | null }) => Promise<boolean>;
  imageProviders: ProviderStat[];
  textConnected: boolean;
  onGenerateFull: () => void;
  fullBusy: string | null;
  /** Reason the Full Card button is disabled (e.g. character not locked). Null = enabled. */
  fullCardBlocked?: string | null;
  cardArtworkBlocked?: string | null;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState("names");
  // Card-art model choice — mirrors the Character Bible's selector (same VQ_IMAGE_MODELS
  // list) so card art isn't stuck on the server's env default. Defaults to nano_banana:
  // cheapest model that still supports reference-image identity lock.
  const [imgModel, setImgModel] = useState<VqImageModel>("nano_banana");
  const [premiumConfirmed, setPremiumConfirmed] = useState(false);
  const [premiumReason, setPremiumReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AiResp | null>(null);
  const [last, setLast] = useState<{ kind: string; mode: string } | null>(null);
  const [artwork, setArtwork] = useState<ArtworkResp | null>(null);
  const [artworkUsed, setArtworkUsed] = useState(false);
  const [usingArtwork, setUsingArtwork] = useState(false);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const active = AI_TABS.find((t) => t.id === tab)!;
  const artworkTab = tab === "artwork" || tab === "variants";
  const premiumBlockReason = isPremiumModel(imgModel) && (!premiumConfirmed || !premiumReason.trim()) ? "Premium Final needs a checked confirmation and reason." : null;
  const artworkBlockedReason = cardArtworkBlocked ?? premiumBlockReason;
  const premiumRequest = isPremiumModel(imgModel) ? { premiumModel: imgModel, premiumConfirmed: true, premiumReason: premiumReason.trim() } : {};
  const higgsfield = imageProviders.find((p) => p.id === "higgsfield");
  const applyableKeys = new Set([
    "name", "health", "guard", "shift",
    "attack1Name", "attack1Cost", "attack1Damage", "attack1Effect",
    "attack2Name", "attack2Cost", "attack2Damage", "attack2Effect",
    "vulnerability", "flavour", "stage1", "stage2", "stage3",
  ]);

  function messageFromError(e: unknown): string {
    return e instanceof Error ? e.message : "Action failed.";
  }

  function handleAiError(e: unknown, title: string) {
    const status = (e as { status?: number })?.status;
    if (status === 401) {
      toast({ title: "Admin login required", description: "Your admin session isn't active — taking you to the login page…", variant: "destructive" });
      setTimeout(() => { window.location.href = "/admin/login"; }, 1400);
      return;
    }
    if (status === 403) {
      toast({ title: "Admin access required", description: "Please log in as admin to use this action.", variant: "destructive" });
      return;
    }
    toast({ title, description: messageFromError(e), variant: "destructive" });
  }

  async function run(kind: string, mode: string) {
    setBusy(true); setHidden(new Set()); setApplied(new Set()); setArtwork(null); setArtworkUsed(false); setUsingArtwork(false);
    try {
      const r = await apiRequest("POST", "/api/admin/vault-quest/ai/generate", { kind, mode, context, n: mode === "alternatives" ? 10 : 6 });
      setRes(await r.json()); setLast({ kind, mode });
    } catch (e) {
      setRes({ suggestions: [], provider: "none", model: "none", dropped: 0, note: messageFromError(e) });
      handleAiError(e, "AI failed");
    } finally { setBusy(false); }
  }

  // Ref latch: paid artwork generation must be double-click-proof even during the
  // awaited reuse-check below (state-based `busy` only updates on re-render).
  const artworkInFlight = useRef(false);
  async function runArtwork(mode: string) {
    if (artworkInFlight.current) return;
    if (artworkBlockedReason) {
      toast({ title: "Artwork generation unavailable", description: artworkBlockedReason, variant: "destructive" });
      return;
    }
    artworkInFlight.current = true;
    setBusy(true);
    const slot: "main" | "prev" = mode === "prev-portrait" ? "prev" : "main";
    // Reuse-before-generate: if approved assets exist for this card's character,
    // generation must be an explicit choice (server already uses approved refs).
    const cardId = String(context.cardId ?? "");
    if (cardId && slot === "main") {
      const check = await fetchReuseCheck({ cardId });
      if (check === null) {
        toast({ title: "Reuse check unavailable", description: "Couldn't verify existing approved assets — generating new artwork." });
      }
      if (check && check.assets.length > 0) {
        const ok = window.confirm(
          `${check.assets.length} approved asset(s) already exist for this character (saving ≈${check.creditsSaved} credits if reused via the Character Bible).\n\n` +
            `OK = generate NEW artwork anyway (uses approved references, spends credits).\nCancel = stop and reuse from the Character Bible instead.`,
        );
        if (!ok) { artworkInFlight.current = false; setBusy(false); return; }
      }
    }
    setHidden(new Set()); setApplied(new Set()); setRes(null); setArtwork(null); setArtworkUsed(false); setUsingArtwork(false);
    const cardScopeKey = `card:${cardId || "new"}:${mode}:${slot}:${imgModel || "default"}`;
    const cardIdempotencyKey = getOrCreateIdempotencyKey(cardScopeKey);
    try {
      const r = await apiRequest("POST", "/api/admin/vault-quest/ai/artwork", { mode, slot, context, model: imgModel, idempotencyKey: cardIdempotencyKey, ...premiumRequest });
      const data = await r.json() as ArtworkResp & { pending?: boolean; message?: string };
      if (data.pending) { toast({ title: "Already generating", description: data.message ?? "This is already running — please wait." }); return; }
      clearIdempotencyKey(cardScopeKey);
      setArtwork(data);
      setLast({ kind: "artwork-image", mode });
    } catch (e) {
      clearIdempotencyKey(cardScopeKey);
      setRes({ suggestions: [], provider: "higgsfield", model: "", dropped: 0, note: messageFromError(e) });
      handleAiError(e, "Artwork failed");
    } finally { artworkInFlight.current = false; setBusy(false); }
  }

  function rerunLast() {
    if (!last) return;
    if (last.kind === "artwork-image") runArtwork(last.mode);
    else run(last.kind, last.mode);
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <div className="mb-1 flex items-center gap-2"><Wand2 className="h-4 w-4 text-amber-400" /><span className="text-xs font-semibold uppercase tracking-wide text-slate-300">AI Assist</span></div>
      <p className="mb-2 text-[10px] text-amber-400/80">AI suggestions are draft only. Founder approval required.</p>
      {!textConnected && <p className="mb-2 rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-400">Text provider not connected — set <span className="text-slate-200">ANTHROPIC_API_KEY</span> in your .env, then restart.</p>}
      {/* One-flow: writes every field + generates artwork in a single click (draft-only). */}
      <button type="button" disabled={!!fullBusy || !!fullCardBlocked} onClick={onGenerateFull} title={fullCardBlocked ?? undefined}
        className="mb-3 flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-amber-400 to-amber-600 px-3 py-2.5 text-sm font-bold text-slate-900 shadow hover:from-amber-300 hover:to-amber-500 disabled:opacity-60">
        {fullBusy ? <><Loader2 className="h-4 w-4 animate-spin" />{fullBusy}</> : <><Wand2 className="h-4 w-4" />{fullCardBlocked ? "🔒 " : ""}Generate Full Card</>}
      </button>
      {fullCardBlocked && <p className="mb-2 text-[10px] text-amber-400/80">{fullCardBlocked}</p>}
      <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">or refine one part:</p>
      <div className="mb-2 flex flex-wrap gap-1">
        {AI_TABS.map((t) => <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`rounded px-2 py-1 text-xs ${tab === t.id ? "bg-amber-500/20 text-amber-300" : "text-slate-400 hover:text-slate-200"}`}>{t.label}</button>)}
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {active.buttons.map((b) => <button key={b.label} type="button" disabled={busy || (artworkTab && !!artworkBlockedReason)} title={artworkTab ? artworkBlockedReason ?? undefined : undefined} onClick={() => artworkTab ? runArtwork(b.mode) : run(b.kind ?? active.kind, b.mode)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:border-amber-500 disabled:opacity-50">{b.label}</button>)}
      </div>
      {artworkTab && (
        <div className="mb-2 rounded border border-slate-700 bg-slate-900/60 p-1.5 text-[10px] leading-relaxed text-slate-400">
          Artwork provider: <span className={higgsfield?.connected ? "text-emerald-400" : "text-amber-400"}>{higgsfield?.connected ? "Higgsfield connected" : "Higgsfield not connected"}</span>
          {higgsfield?.note && <span className="ml-1 text-slate-500">· {higgsfield.note}</span>}
          <div className="mt-1 flex items-center gap-1">
            <span>Model:</span>
            <select value={imgModel} onChange={(e) => setImgModel(e.target.value as VqImageModel)} className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-[10px] text-slate-200">
              {VQ_IMAGE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label} — ~{m.creditsPerImage} cr/image{m.refCapable ? "" : " · no identity lock"}</option>)}
            </select>
          </div>
          {isPremiumModel(imgModel) && (
            <div className="mt-1 rounded border border-amber-700/60 bg-amber-950/20 p-1.5">
              <label className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-200">
                <input type="checkbox" className="h-3 w-3 accent-amber-500" checked={premiumConfirmed} onChange={(e) => setPremiumConfirmed(e.target.checked)} />
                Confirm Premium Final
              </label>
              <input value={premiumReason} onChange={(e) => setPremiumReason(e.target.value)} placeholder="Reason for Premium Final" className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] text-slate-200" />
            </div>
          )}
        </div>
      )}
      {busy && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="h-3 w-3 animate-spin" />Generating…</p>}
      {res?.note && !busy && <p className="text-xs text-amber-400">{res.note}</p>}
      {artwork && artworkTab && !busy && (
        <div className="mb-2 rounded border border-slate-700 bg-slate-900/60 p-2 text-sm">
          <div className="flex gap-2">
            <VqStoredImage src={artwork.preview} alt="generated card artwork candidate" idLabel={artwork.generationId ?? "card artwork"} kind="candidate" className="h-24 w-24 shrink-0 rounded object-cover" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-slate-200">{artwork.slot === "prev" ? "Previous-stage candidate" : "Main artwork candidate"}</div>
              <div className="text-[11px] text-slate-400">{artwork.provider} · {artwork.model} · {artwork.width}×{artwork.height}</div>
              {artwork.note && <div className="mt-1 text-[11px] text-amber-400">{artwork.note}</div>}
              <div className="mt-2 max-h-28 overflow-auto rounded border border-slate-800 bg-slate-950/60 p-2 text-[11px] leading-relaxed text-slate-300">{artwork.prompt}</div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
            <button type="button" className="text-slate-300 hover:text-amber-300" onClick={() => { navigator.clipboard?.writeText(artwork.prompt); toast({ title: "Prompt copied" }); }}>Copy Prompt</button>
            <button type="button" disabled={usingArtwork || artworkUsed} className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50" onClick={async () => {
              setUsingArtwork(true);
              try {
                const ok = await onUseArtwork({ candidateKey: artwork.candidateKey, slot: artwork.slot, preview: artwork.preview, generationId: artwork.generationId });
                if (ok) setArtworkUsed(true);
              } finally {
                setUsingArtwork(false);
              }
            }}>{usingArtwork ? "Attaching…" : artworkUsed ? "Image attached ✓" : "Use Image"}</button>
            <button type="button" className="text-slate-300 hover:text-amber-300" onClick={rerunLast}>Regenerate</button>
            <button type="button" className="text-slate-500 hover:text-red-400" onClick={() => { setArtwork(null); setArtworkUsed(false); setUsingArtwork(false); }}>Reject</button>
          </div>
        </div>
      )}
      <div className="space-y-2">
        {res?.suggestions.map((s, i) => hidden.has(i) ? null : (
          <div key={i} className="rounded border border-slate-700 bg-slate-900/60 p-2 text-sm">
            <div className="font-medium text-slate-100">{s.text}</div>
            {s.pronunciation && <div className="text-[11px] text-slate-400">{s.pronunciation}</div>}
            {s.reason && <div className="text-[11px] text-slate-400">{s.reason}</div>}
            {s.warning && <div className="text-[11px] text-amber-400">⚠ {s.warning}</div>}
            <div className="mt-1 flex flex-wrap gap-3 text-[11px]">
              <button type="button" className="text-slate-300 hover:text-amber-300" onClick={() => { navigator.clipboard?.writeText(s.text); toast({ title: "Copied" }); }}>Copy</button>
              {s.fields && Object.keys(s.fields).some((k) => applyableKeys.has(k)) && (
                <button type="button" className="text-emerald-400 hover:text-emerald-300" onClick={async () => {
                  if (res.generationId != null) {
                    try {
                      await apiRequest("POST", `/api/admin/vault-quest/ai/generations/${res.generationId}/applied`, {});
                    } catch (e) {
                      const status = (e as { status?: number })?.status;
                      if (status === 401) {
                        toast({ title: "Admin login required", description: "Your admin session isn't active — taking you to the login page…", variant: "destructive" });
                        setTimeout(() => { window.location.href = "/admin/login"; }, 1400);
                      } else {
                        toast({ title: "Apply audit failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
                      }
                      return;
                    }
                  }
                  if (!onApply(s.fields!)) {
                    toast({ title: "Nothing to apply — use Copy", variant: "destructive" });
                    return;
                  }
                  setApplied((p) => new Set(p).add(i));
                  toast({ title: "Applied — running QA" });
                }}>{applied.has(i) ? "Applied ✓" : "Apply"}</button>
              )}
              <button type="button" className="text-slate-300 hover:text-amber-300" onClick={rerunLast}>Regenerate</button>
              <button type="button" className="text-slate-500 hover:text-red-400" onClick={() => setHidden((p) => new Set(p).add(i))}>Reject</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Chip multi-select with free-form add + datalist suggestions (keywords / status effects).
function TagInput({ value, onChange, suggestions, placeholder }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[]; placeholder?: string }) {
  const [q, setQ] = useState("");
  const listId = "dl-" + (placeholder ?? "tags").replace(/\W/g, "");
  const add = (t: string) => { const v = t.trim(); if (v && !value.includes(v)) onChange([...value, v]); setQ(""); };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5">
      {value.map((t) => <span key={t} className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">{t}<button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="text-amber-400/70 hover:text-amber-200">×</button></span>)}
      <input list={listId} className="min-w-[70px] flex-1 bg-transparent text-sm text-slate-100 focus:outline-none" placeholder={value.length ? "" : (placeholder ?? "add…")} value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === ",") && q.trim()) { e.preventDefault(); add(q); } else if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1)); }}
        onBlur={() => q.trim() && add(q)} />
      <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  );
}

type Opt = { value: string; label: string; hint?: string };

// Searchable dropdown: type-to-filter, keyboard nav (↑/↓/Enter/Esc), click select.
// Falls back to the value itself if it isn't in the option list (so existing data
// like a legacy element/type is never lost).
function Combo({ value, onChange, options, placeholder, allowEmpty = true, disabled, onAddNew, addNewLabel }: {
  value: string;
  onChange: (v: string) => void;
  options: Opt[];
  placeholder?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
  onAddNew?: (query: string) => void; // called with the typed text; parent creates + selects
  addNewLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const filtered = options.filter((o) => (o.label + " " + o.value).toLowerCase().includes(q.toLowerCase()));
  const selected = options.find((o) => o.value === value);
  const shownLabel = selected ? selected.label : value || "";

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  useEffect(() => { if (open) { setQ(""); setHi(0); const t = setTimeout(() => input.current?.focus(), 0); return () => clearTimeout(t); } }, [open]);

  const pick = (v: string) => { onChange(v); setOpen(false); };

  return (
    <div className="relative" ref={wrap}>
      <button type="button" disabled={disabled} onClick={() => !disabled && setOpen((o) => !o)}
        className={`${inputCls} flex items-center justify-between text-left ${disabled ? "cursor-not-allowed opacity-50" : ""}`}>
        <span className={shownLabel ? "truncate" : "text-slate-500"}>{shownLabel || placeholder || "Select…"}</span>
        <ChevronDown className="ml-1 h-4 w-4 shrink-0 text-slate-500" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-600 bg-slate-900 shadow-xl">
          <input ref={input} className="sticky top-0 w-full border-b border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 focus:outline-none"
            placeholder="Type to search…" value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); if (filtered[hi]) pick(filtered[hi].value); }
              else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
            }} />
          {allowEmpty && <div onMouseDown={(e) => e.preventDefault()} onClick={() => pick("")} className="cursor-pointer px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-800">— none —</div>}
          {onAddNew && q.trim() && !options.some((o) => o.label.toLowerCase() === q.trim().toLowerCase()) && (
            <div onMouseDown={(e) => e.preventDefault()} onClick={() => { onAddNew(q.trim()); setOpen(false); }} className="cursor-pointer border-b border-slate-700 px-2 py-1.5 text-sm font-medium text-amber-400 hover:bg-slate-800">+ {addNewLabel ?? "Add"} “{q.trim()}”</div>
          )}
          {filtered.length === 0 && !onAddNew && <div className="px-2 py-2 text-sm text-slate-500">No matches</div>}
          {filtered.map((o, i) => (
            <div key={o.value} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)} onMouseEnter={() => setHi(i)}
              className={`flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-sm ${i === hi ? "bg-slate-800" : ""} ${o.value === value ? "text-amber-300" : "text-slate-100"}`}>
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">{o.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type VqCandidateRow = { id: number; status: string; source: string; referenceType: VqRefType; identityScore: number | null; identityBreakdown?: IdentityBreakdown | null; prompt: string | null; width: number | null; height: number | null; createdAt: string };
type BatchStatus = "queued" | "generating" | "paused" | "succeeded" | "failed" | "skipped" | "rejected";
// kind "artwork" spends Higgsfield credits; kind "description" is Anthropic text only (0 credits).
type BatchItem = { characterId: string; name: string; stage: number; referenceType: VqRefType; status: BatchStatus; note?: string; kind?: "artwork" | "description" };
// Sidebar production stage per character: canonical → references → description → missing.
function stageProgress(ch: VqCharacterRow): { label: string; icon: string; cls: string } {
  if (isCanonical(ch)) return { label: "Canonical", icon: "✅", cls: "text-emerald-400" };
  if (ch.descriptionStatus === "approved" && requiredCount(ch) > 0) return { label: `References ${requiredCount(ch)}/2`, icon: "🟡", cls: "text-amber-400" };
  if (ch.descriptionStatus === "approved") return { label: "References", icon: "🟡", cls: "text-amber-400" };
  if (dnaComplete(ch)) return { label: "Description", icon: "🟡", cls: "text-amber-400" };
  return { label: "Missing", icon: "🔴", cls: "text-red-400" };
}

/** Deep-link payload from the Production Studio (?bible=&step=&ref=). */
type BibleDeepLink = { characterId: string; step?: string | null; refType?: string | null };

/** Scroll to + briefly highlight the element carrying data-deeplink=<key>. */
function flashDeepLink(key: string) {
  const el = document.querySelector<HTMLElement>(`[data-deeplink="${key}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const prev = el.style.outline;
  el.style.outline = "2px solid #D4AF37";
  el.style.outlineOffset = "3px";
  setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = ""; }, 3000);
}
const STEP_TO_ANCHOR: Record<string, string> = {
  description: "description",
  approve_description: "approve_description",
  master_reference: "generate-reference",
  action_pose: "generate-reference",
  approve_references: "generate-reference",
  lock_character: "lock_character",
};

// Raw POST that inspects status + body directly (202 pending / 200 replayed / terminal)
// rather than throwing on non-2xx like apiRequest — runGenerationWithRecovery's
// classifier needs to see all three shapes to decide "keep polling" vs "done".
async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await adminFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function CharacterBibleView({ onBack, onAuthError, deepLink }: { onBack: () => void; onAuthError: (e: unknown, fallbackTitle: string) => void; deepLink?: BibleDeepLink | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const chars = useQuery<{ characters: VqCharacterRow[] } | null>({ queryKey: ["/api/admin/vault-quest/characters"], retry: false });
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<BibleDraft>(draftFromCharacter(null));
  const [busy, setBusy] = useState<string | null>(null);
  const [artNonce, setArtNonce] = useState(0);
  const [familySel, setFamilySel] = useState<Record<string, number>>({}); // characterId → chosen candidateId (for family approve)
  const [refType, setRefType] = useState<VqRefType>("master_portrait"); // active Reference Pack slot
  const refTypeMeta = REF_TYPES.find((t) => t.value === refType) ?? REF_TYPES[0];
  // ── Batch generation (client-orchestrated queue over existing per-character routes) ──
  const [selectedChars, setSelectedChars] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<BatchItem[] | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  // `model` is FROZEN at estimate time — the founder confirms a specific cost, so the
  // batch must spend on that model even if the selector changes before Confirm.
  const [estimate, setEstimate] = useState<{ items: BatchItem[]; images: number; credits: number; needTyped: boolean; label: string; model: VqImageModel; premiumReason?: string } | null>(null);
  const [typedConfirm, setTypedConfirm] = useState("");
  const [stopOnFail, setStopOnFail] = useState(false);
  const stopRef = useRef(false);
  const pauseRef = useRef(false);
  const skipRef = useRef(false);
  // Unmount latch for the batch loop: leaving the Bible view must stop the queue
  // (its Pause/Stop controls unmount with the view — a paused loop would otherwise
  // spin forever and a running one would keep spending credits invisibly).
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [queuePaused, setQueuePaused] = useState(false);
  // Candidate review extras
  const [favourites, setFavourites] = useState<Set<number>>(() => {
    // Guarded: corrupt localStorage must not crash the whole Bible view on mount.
    try { return new Set(JSON.parse(localStorage.getItem("vq-fav-candidates") ?? "[]") as number[]); } catch { return new Set(); }
  });
  const toggleFavourite = (id: number) => setFavourites((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    localStorage.setItem("vq-fav-candidates", JSON.stringify([...n]));
    return n;
  });
  const [compareSel, setCompareSel] = useState<number[]>([]); // up to 2 candidate ids
  const [showCompare, setShowCompare] = useState(false);
  const [promptFor, setPromptFor] = useState<VqCandidateRow | null>(null);
  const [zoomId, setZoomId] = useState<number | "master" | "action" | null>(null);
  // Archive/History panel (Phase B) — which reference slot's revision history is open.
  const [historyFor, setHistoryFor] = useState<VqRefType | null>(null);
  // Description history (vq_character_revisions is already written on every change)
  const [histOpen, setHistOpen] = useState(false);
  const [histCompare, setHistCompare] = useState<number | null>(null);
  // Locked-character edit override (Phase B): a locked/canonical character stays
  // locked while this is true — it only unblocks the Bible/description controls for
  // one deliberate, confirmed edit session. Reset whenever the selected character changes.
  const [editingLocked, setEditingLocked] = useState(false);
  // Action Reference replacement: founder-selected action category ("auto" excludes the
  // existing action's category server-side). Threaded into the action generation body.
  const [actionCategory, setActionCategory] = useState<string>("auto");
  // AI Creature Designer (Phase 2): the idea → concept → create modal.
  const [designerOpen, setDesignerOpen] = useState(false);
  // Card-level stats for the founder dashboard (same endpoint as the board).
  const bibleDash = useQuery<Dashboard>({ queryKey: ["/api/admin/vault-quest/dashboard"], retry: false });
  // Session/today credit tracking (client-side ESTIMATE of spend, persisted per day).
  const [sessionCredits, setSessionCredits] = useState(0);
  const todayKey = `vq-credits-${new Date().toISOString().slice(0, 10)}`;
  const [todayCredits, setTodayCredits] = useState(() => Number(localStorage.getItem(todayKey) ?? 0));
  const trackCredits = (n: number) => {
    if (!n) return;
    setSessionCredits((s) => Math.round((s + n) * 100) / 100);
    // Read the stored value for TODAY's key (not accumulated state) so a session
    // that crosses midnight doesn't carry yesterday's total into the new day.
    setTodayCredits(() => { const v = Math.round((Number(localStorage.getItem(todayKey) ?? 0) + n) * 100) / 100; localStorage.setItem(todayKey, String(v)); return v; });
  };
  const cost = useQuery<{ model: string; connected: boolean; creditsPerImage: number; masterImagesPerItem: number; providers: { id: string; label: string; enabled: boolean; note: string }[] }>({ queryKey: ["/api/admin/vault-quest/artwork-cost"], retry: false });
  const [founderFlags, setFounderFlags] = useState<FounderFeatureMap>(() => resolveFounderFeatureMap(undefined, false));
  const [providerConnection, setProviderConnection] = useState<ProviderConnection | null>(null);
  const [providerStatusLoaded, setProviderStatusLoaded] = useState(false);
  // Image model / quality — default DRAFT/CHEAP (never the expensive model unless chosen).
  const [imgModel, setImgModel] = useState<VqGenerateWith>("auto");
  const resetGenerateWith = useCallback(() => setImgModel(resetGenerateWithAfterAttempt()), []);
  const [premiumConfirmed, setPremiumConfirmed] = useState(false);
  const [premiumReason, setPremiumReason] = useState("");
  const requestedImgModel = requestModelForGenerateWith(imgModel);
  const creditsPerImage = imgModel === "auto" ? estimatedCreditsForGenerateWith("auto", refType) : vqCreditsPerImage(imgModel);
  const [advanced] = useAdvancedMode(); // Simple founder workflow is the default; Advanced reveals technical controls.
  // Auto-progression (Phase 1, Simple mode only): after an approval, gently scroll the
  // NEXT step into view so the founder never has to hunt for it. No-op in Advanced mode.
  // Deferred a beat so the list refetch has re-rendered the target section first.
  const scrollToStep = useCallback((step: "master" | "action" | "lock") => {
    if (advanced) return;
    setTimeout(() => {
      document.querySelector(`[data-vq-step="${step}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
  }, [advanced]);
  const imagesPerItem = refType === "master_portrait" ? (cost.data?.masterImagesPerItem ?? 3) : 1;
  const higgsProvider = cost.data?.providers?.find((p) => p.id === "higgsfield");
  const BATCH_IMAGE_LIMIT = 3; // default max images before the typed confirmation is required
  const TYPED_PHRASE = "I understand this will spend credits";
  const autoPaidRetryEnabled = founderFlags.auto_paid_retry;
  const premiumBlockReason = requestedImgModel && isPremiumModel(requestedImgModel) && (!premiumConfirmed || !premiumReason.trim()) ? "Premium Final needs a checked confirmation and reason." : null;
  const premiumRequest = (model: VqGenerateWith, reason = premiumReason) =>
    model !== "auto" && isPremiumModel(model)
      ? { premiumModel: model, premiumConfirmed: true, premiumReason: reason.trim() }
      : {};
  const generationDisabledTitle = (feature: FounderFeatureKey) => generationBlockedReasonWithProvider(founderFlags, feature, providerConnection, providerStatusLoaded) ?? undefined;
  // Full block (unchanged) — feature Off OR provider not verified OR premium
  // unconfirmed. Still used by the advanced batch/family buttons so their behavior
  // is byte-for-byte the same as before this change.
  const referenceGenerationBlocked = (type: VqRefType) =>
    !canSubmitGeneration(founderFlags, featureForReferenceType(type)) ||
    !!providerGenerationBlockedReason(providerConnection, providerStatusLoaded) ||
    !!premiumBlockReason;
  // The founder primary Generate buttons are NEVER disabled by the spend gates —
  // only by local, in-the-moment conditions (a generation already in flight, a
  // locked character, an unapproved description). The click itself resolves the
  // gates on FRESH server state (ensureGenerationReady) and always ends in either a
  // generation or a specific real-reason toast, so the button can never be a silent
  // dead end (and never flashes a scary "locked" while status is still loading).
  // This helper supplies an OPTIONAL amber hint shown beside the button once status
  // has loaded and a real, click-unresolvable reason exists — informational only.
  const referenceGenerationHardTitle = (_type: VqRefType): string | undefined => {
    if (premiumBlockReason) return premiumBlockReason; // local model choice — always valid
    if (!providerStatusLoaded) return undefined; // status still loading — show nothing rather than flash
    if (!founderFlags.generation) return "AI Generation is Locked. Turn it back on in Founder Spend Controls.";
    if (providerReadiness(providerConnection, providerStatusLoaded) === "hard_blocked") return providerHardBlockReason(providerConnection);
    return undefined;
  };
  const referenceGenerationTitle = (type: VqRefType, fallback?: string) => generationDisabledTitle(featureForReferenceType(type)) ?? premiumBlockReason ?? fallback;

  const characters = chars.data?.characters ?? [];
  const selected = characters.find((c) => c.characterId === selectedId) ?? characters[0] ?? null;
  const missing = selected ? BIBLE_FIELDS.filter((f) => !String(selected[f.key] ?? "").trim()).map((f) => f.label) : [];
  const grouped = characters.reduce<Record<string, VqCharacterRow[]>>((acc, ch) => {
    const key = ch.familyId;
    acc[key] = [...(acc[key] ?? []), ch];
    return acc;
  }, {});
  // Simple mode shows Master AND Action sections side by side, so it must fetch ALL
  // candidate types (they're filtered per-section client-side). Fetching only the
  // active refType hid the other section's pending candidates, inviting duplicate
  // paid generation. Advanced mode keeps the single-type fetch for its gallery.
  const candQuery = useQuery<{ candidates: VqCandidateRow[] } | null>({
    queryKey: [`/api/admin/vault-quest/characters/${selected?.characterId ?? "none"}/candidates${advanced ? `?type=${refType}` : ""}`],
    enabled: !!selected?.characterId,
    retry: false,
  });
  const candidates = candQuery.data?.candidates ?? [];

  useEffect(() => {
    if (!selectedId && characters[0]) setSelectedId(characters[0].characterId);
  }, [characters, selectedId]);

  // Deep-link from the Production Studio: select the exact character, switch the
  // Reference Pack slot, then scroll/flash the exact step control. Applied once.
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current || !deepLink || characters.length === 0) return;
    if (!characters.some((c) => c.characterId === deepLink.characterId)) return;
    deepLinkApplied.current = true;
    setSelectedId(deepLink.characterId);
    const refT = deepLink.refType;
    if (refT && REF_TYPES.some((t) => t.value === refT)) setRefType(refT as VqRefType);
    const anchor = deepLink.step ? STEP_TO_ANCHOR[deepLink.step] : undefined;
    if (anchor) setTimeout(() => flashDeepLink(anchor), 700);
  }, [deepLink, characters]);

  useEffect(() => {
    setDraft(draftFromCharacter(selected));
    // Compare/zoom selections are candidate IDs of the PREVIOUS character — carrying
    // them across a switch let the compare overlay mix candidates from two characters
    // (the server 404s the foreign one → broken image in the comparison).
    setCompareSel([]);
    setShowCompare(false);
    setZoomId(null);
    setEditingLocked(false);
    setHistoryFor(null);
    setActionCategory("auto");
  }, [selected?.characterId]);

  async function seedCharacters() {
    setBusy("seed");
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/characters/seed", { setCode: "GNV" });
      const data = (await res.json()) as { created: number; familyRulesCreated: number };
      await chars.refetch();
      toast({ title: "Character Bible seeded", description: `${data.created} character(s), ${data.familyRulesCreated} family rule(s)` });
    } catch (e) {
      onAuthError(e, "Seed failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveCharacter() {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); return; }
    const lockedOverride = selected.locked && editingLocked;
    if (selected.locked && !editingLocked) { toast({ title: "Character locked", description: "Click Edit in the Identity section to make a confirmed change to this locked character, or Unlock it.", variant: "destructive" }); return; }
    setBusy("save");
    try {
      await apiRequest("PATCH", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}`, {
        ...draft,
        reason: lockedOverride ? "Character Bible edit (locked override)" : "Character Bible edit",
        ...(lockedOverride ? { confirmReplaceLocked: true } : {}),
      });
      await chars.refetch();
      if (lockedOverride) setEditingLocked(false);
      toast({ title: "Character Bible saved", description: lockedOverride ? "Description may now need re-approval before new artwork uses it." : selected.characterId });
    } catch (e) {
      onAuthError(e, "Save Character Bible failed");
    } finally {
      setBusy(null);
    }
  }

  // ── Description workflow (Anthropic text — never artwork) ──────────────────
  // Generate/Improve fills the DRAFT fields only; the founder reviews, saves, then
  // explicitly approves. Approving saves the current draft first, then approves.
  async function generateDescription(mode: "generate" | "improve") {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); return; }
    if (selected.locked && !editingLocked) { toast({ title: "Character locked", description: "Click Edit in the Identity section first, or Unlock the character.", variant: "destructive" }); return; }
    setBusy(`desc-${mode}`);
    try {
      const res = await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/describe`, { mode });
      const data = (await res.json()) as { fields: Record<BibleFieldKey, string> };
      setDraft((p) => ({ ...p, ...data.fields }));
      toast({ title: mode === "improve" ? "Description improved" : "Description generated", description: "Review the fields, edit if needed, then Approve Description (saves + approves)." });
    } catch (e) {
      onAuthError(e, "Description generation failed");
    } finally {
      setBusy(null);
    }
  }

  async function approveDescription() {
    if (!selected) return;
    const lockedOverride = selected.locked && editingLocked;
    setBusy("desc-approve");
    try {
      // Persist the current draft first so what's approved is exactly what's on screen.
      await apiRequest("PATCH", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}`, {
        ...draft,
        reason: lockedOverride ? "description review (locked override)" : "description review",
        ...(lockedOverride ? { confirmReplaceLocked: true } : {}),
      });
      await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/approve-description`, {});
      await chars.refetch();
      if (lockedOverride) setEditingLocked(false);
      scrollToStep("master"); // auto-progress the founder to the next step
      toast({ title: "Description approved", description: "Artwork generation is now unlocked for this character." });
    } catch (e) {
      onAuthError(e, "Approve description failed");
    } finally {
      setBusy(null);
    }
  }

  // Candidate extras: delete (hide, R2 kept) + regenerate-similar (same type, 1 image)
  async function deleteCandidate(candidateId: number) {
    if (!selected) return;
    setBusy(`del-${candidateId}`);
    try {
      await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/reject-candidate`, { candidateId, action: "delete" });
      setCompareSel((p) => p.filter((id) => id !== candidateId));
      await candQuery.refetch();
      toast({ title: "Candidate deleted", description: "Hidden from the gallery (file kept in storage)." });
    } catch (e) {
      onAuthError(e, "Delete candidate failed");
    } finally {
      setBusy(null);
    }
  }

  // Description history — revisions are already recorded on every save/approval.
  const revisions = useQuery<{ revisions: { id: number; reason: string | null; editedBy: string | null; editedAt: string; revisionJson: Record<string, unknown> }[] } | null>({
    queryKey: [`/api/admin/vault-quest/characters/${selected?.characterId ?? "none"}/revisions`],
    enabled: !!selected?.characterId && histOpen,
    retry: false,
  });
  function restoreRevision(rev: Record<string, unknown>) {
    // Restores into the DRAFT only — founder must Save/Approve. Never overwrites approved work silently.
    const restored = Object.fromEntries(BIBLE_FIELDS.map((f) => [f.key, String(rev[f.key] ?? "")])) as BibleDraft;
    setDraft(restored);
    setHistOpen(false);
    toast({ title: "Revision restored to draft", description: "Review the fields, then Save Bible / Approve Description to keep it." });
  }

  // Archive/History for Master + Action reference images (Phase B) — wires the
  // already-built, already-tested immutable revision ledger into the UI for the
  // first time. Every approve keeps the previous image here forever; Restore never
  // deletes anything, it just re-activates an older revision.
  type VqRevisionRow = { id: number; r2Key: string; isActive: boolean; width: number | null; height: number | null; createdBy: string | null; createdAt: string; archivedAt: string | null };
  const revisionHistory = useQuery<{ revisions: VqRevisionRow[] } | null>({
    queryKey: [`/api/admin/vault-quest/artwork-revisions?entityType=character&entityId=${selected?.characterId ?? "none"}&slot=${historyFor ?? "none"}`],
    enabled: !!selected?.characterId && !!historyFor,
    retry: false,
  });
  async function restoreRevisionImage(revisionId: number) {
    if (!selected) return;
    const lockedOverride = selected.locked;
    if (lockedOverride && !window.confirm(`${selected.characterName} is locked as canonical.\n\nRestoring this older image will archive the current one and make this the active reference again. Nothing is ever deleted — you can restore back at any time.\n\nContinue?`)) return;
    setBusy(`restore-${revisionId}`);
    try {
      await apiRequest("POST", `/api/admin/vault-quest/artwork-revisions/${revisionId}/restore`, lockedOverride ? { confirmReplaceLocked: true } : {});
      await chars.refetch();
      await revisionHistory.refetch();
      setArtNonce((n) => n + 1);
      toast({ title: "Revision restored", description: "This image is now the active reference." });
    } catch (e) {
      onAuthError(e, "Restore failed");
    } finally {
      setBusy(null);
    }
  }

  async function uploadReference(file: File) {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); return; }
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await adminFetch(`/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/artwork`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = new Error((await res.json().catch(() => ({}))).error || `upload failed (${res.status})`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as { width: number; height: number };
      await chars.refetch();
      setArtNonce((n) => n + 1);
      toast({ title: "Reference artwork uploaded", description: `${data.width}x${data.height}` });
    } catch (e) {
      onAuthError(e, "Upload reference failed");
    } finally {
      setBusy(null);
    }
  }

  async function approveArtwork() {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); return; }
    if (!selected.referenceArtworkR2Key) { toast({ title: "Upload reference artwork first", variant: "destructive" }); return; }
    setBusy("approve");
    try {
      await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/approve-artwork`, {});
      await chars.refetch();
      setArtNonce((n) => n + 1);
      toast({ title: "Artwork approved", description: "This is now the approved Character Bible artwork." });
    } catch (e) {
      onAuthError(e, "Approve artwork failed");
    } finally {
      setBusy(null);
    }
  }

  async function uploadActionReference(file: File) {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); return; }
    const masterKey = selected.referencePack?.master_portrait?.r2Key || selected.approvedArtworkR2Key;
    if (!masterKey) {
      toast({ title: "Approve a Master Reference first", description: "The Action Pose is linked to the approved Master.", variant: "destructive" });
      return;
    }
    const confirmReplaceLocked = selected.locked
      ? window.confirm(`${selected.characterName} is locked as canonical.\n\nUploading this Action Pose will replace the active Action Reference and archive the previous one. Continue?`)
      : false;
    if (selected.locked && !confirmReplaceLocked) return;
    setBusy("upload-action");
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (confirmReplaceLocked) fd.append("confirmReplaceLocked", "true");
      const res = await adminFetch(`/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/reference/action_pose/upload`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = new Error((await res.json().catch(() => ({}))).error || `upload failed (${res.status})`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as { width: number; height: number };
      await chars.refetch();
      await candQuery.refetch();
      setArtNonce((n) => n + 1);
      toast({ title: "Action Pose uploaded", description: `${data.width}x${data.height} approved as the Action Reference.` });
    } catch (e) {
      onAuthError(e, "Upload Action Pose failed");
    } finally {
      setBusy(null);
    }
  }

  async function setLocked(id: string, locked: boolean) {
    await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(id)}/lock`, { locked });
  }
  // The character Lock button is the ONLY place a character locks. Gated by the disabled
  // button (required pack complete) + a confirmation; the server also enforces it.
  async function toggleLock() {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); return; }
    if (!selected.locked) {
      if (!requiredComplete(selected)) { toast({ title: "Complete the required reference pack before locking.", variant: "destructive" }); return; }
      if (!window.confirm(`You are about to permanently lock ${selected.characterName}.\n\nThis identity will become the source for:\n\n• Stage evolutions\n• Variants\n• Full Card generation\n• Future game assets\n• Animations\n• 3D models\n\nContinue?`)) return;
    }
    setBusy("lock");
    try {
      await setLocked(selected.characterId, !selected.locked);
      await chars.refetch();
      toast({ title: !selected.locked ? "Character locked" : "Character unlocked", description: selected.characterId });
    } catch (e) {
      onAuthError(e, "Lock update failed");
    } finally {
      setBusy(null);
    }
  }

  function artworkError(e: unknown, fallback: string) {
    const status = (e as { status?: number })?.status;
    const serverMsg = (e as { message?: string })?.message;
    if (status === 402) toast({ title: "Higgsfield limit", description: "Needs a higher plan or more credits — no artwork generated.", variant: "destructive" });
    else if (status === 503) toast({ title: "Provider not connected", description: serverMsg || "Higgsfield token missing or expired.", variant: "destructive" });
    // 422 = a real, actionable server reason (description not approved, image
    // failed the integrity/pose/identity gate). Surface it verbatim so the founder
    // sees exactly why, never a silent no-op.
    else if (status === 422) toast({ title: `${fallback}`, description: serverMsg || "The character isn't ready for this generation yet.", variant: "destructive" });
    else onAuthError(e, fallback);
  }

  // One-click generation readiness for the founder — FULLY AUTOMATIC. The Generate
  // button is a SINGLE action: this resolves the two legitimate spend gates in
  // place, with no dialogs and no hidden panels, narrating each step:
  //   (1) the per-type flag — a type the founder has never used is enabled
  //       automatically (their explicit, logged click IS the enable); a deliberate
  //       owner Off (db_flag_off) and the master lock are respected, never bypassed,
  //   (2) the free provider verification — a zero-cost token check, no credits —
  // by driving the SAME sanctioned endpoints the Founder Spend Controls / AI
  // Provider panels use. The server still independently re-checks BOTH gates on the
  // generate call; nothing here weakens them. Returns true only when generation may
  // proceed. Reads a FRESH server snapshot after each step (never stale React state)
  // and, on any failure, shows the EXACT reason (never a silent no-op).
  async function ensureGenerationReady(feature: FounderFeatureKey): Promise<boolean> {
    const fetchOps = async (): Promise<{ features?: FounderFeatureStatus[]; provider?: ProviderConnection } | null> => {
      try {
        return (await (await apiRequest("GET", "/api/admin/vault-quest/ops/status")).json()) as {
          features?: FounderFeatureStatus[];
          provider?: ProviderConnection;
        };
      } catch {
        return null; // fail closed below
      }
    };
    setGenStageLabel(generationStageLabel("preparing"));
    let snap = await fetchOps();
    for (let step = 0; step < 4; step++) {
      if (!snap) {
        toast({ title: "Generation unavailable", description: "Couldn't read your spend controls. Check the connection and try again.", variant: "destructive" });
        return false;
      }
      const flags = resolveFounderFeatureMap(snap.features, true);
      const reasons = resolveFounderFeatureReasons(snap.features);
      const plan = planGenerationGate(flags, feature, reasons[feature], snap.provider ?? null, true);
      if (plan.kind === "generate") return true;
      if (plan.kind === "blocked") {
        toast({ title: "Generation unavailable", description: plan.reason, variant: "destructive" });
        return false;
      }
      const stage = stageForPlan(plan.kind);
      if (stage) setGenStageLabel(generationStageLabel(stage));
      if (plan.kind === "enable_then_continue") {
        // Auto-enable the type the founder explicitly asked to generate. Their click
        // is the explicit owner action; a brief toast keeps it transparent (never
        // silent). Server default-Off and the master lock are unchanged.
        try {
          await apiRequest("POST", `/api/admin/vault-quest/ops/feature-flags/${plan.feature}`, {
            enabled: true,
            reason: `${plan.label} enabled automatically from the Generate button (founder)`,
          });
          toast({ title: `${plan.label} generation enabled` });
        } catch (e) {
          onAuthError(e, "Couldn't enable generation");
          return false;
        }
      } else if (plan.kind === "verify_then_continue") {
        // Zero-cost token check (no credits, no image) — the sanctioned provider
        // verification, run automatically so the founder never hunts for it.
        try {
          await apiRequest("POST", "/api/admin/vault-quest/ops/provider/test-connection", {});
        } catch (e) {
          onAuthError(e, "Couldn't verify the AI provider");
          return false;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/vault-quest/ops/status"] });
      snap = await fetchOps();
    }
    // Still not ready after enabling + verifying — surface the freshest real reason.
    const provider = snap?.provider ?? null;
    const reason =
      providerReadiness(provider, true) === "hard_blocked"
        ? providerHardBlockReason(provider)
        : "The AI provider still isn't connected. Check the AI Provider panel above.";
    toast({ title: "Generation unavailable", description: reason, variant: "destructive" });
    return false;
  }

  // Reuse-before-generate: never silently regenerate when approved assets exist.
  const [reuseCheck, setReuseCheck] = useState<ReuseCheck | null>(null);
  const [reuseType, setReuseType] = useState<VqRefType>("master_portrait");

  // In-flight latch for PAID reference generation. A ref (not state) so a rapid
  // double-click within one render frame cannot double-bill: state-based `busy`
  // only updates on re-render, leaving a window during the reuse-check round-trip.
  const genInFlight = useRef(false);

  // Live request-lifecycle phase for the single-reference generate buttons — drives
  // "Generating…" / "Still processing…" text so the page never just looks frozen
  // while a real (sometimes 15-60s) generation is in flight. Null when idle.
  const [genPhase, setGenPhase] = useState<GenerationPhase | null>(null);
  const genPhaseLabel = genPhase === "still-processing" ? "Still processing…" : genPhase === "generating" ? "Generating…" : null;
  // Live founder-facing phase across the WHOLE automatic sequence — Preparing →
  // Verifying Provider → Generating <type> → Refreshing. Null when idle. Shown on
  // the button and on the production tracker's active step so the one-click flow
  // narrates itself and never looks frozen. Purely visual; drives no gate.
  const [genStageLabel, setGenStageLabel] = useState<string | null>(null);
  // A generated Action Pose that the studio-background gate rejected. Kept so the
  // founder sees exactly WHY (measured edge % vs threshold), that a credit was spent,
  // and that NO automatic paid retry happened — with an explicit Try Again. Never
  // used to present rejected artwork as approved/usable.
  const [bgRejection, setBgRejection] = useState<
    {
      reason: string;
      offPercent: number | null;
      thresholdPercent: number | null;
      creditUsed: boolean;
      cleanupAttempted?: boolean;
      quarantineRef?: string | null;
    } | null
  >(null);
  useEffect(() => {
    setBgRejection(null);
  }, [selectedId]); // a background-rejection notice belongs to one character only

  async function generateMasterArtwork(typeOverride?: VqRefType) {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); resetGenerateWith(); return; }
    if (genInFlight.current) { resetGenerateWith(); return; } // re-entrancy guard (double-click during reuse-check)
    genInFlight.current = true;
    setBusy("gen-art");
    try {
      // Guard: only accept a real ref-type string; never a forwarded MouseEvent.
      const type: VqRefType = isVqRefType(typeOverride) ? typeOverride : refType;
      // Spend gates (per-type flag + provider verification) are resolved in
      // doGenerateReference via ensureGenerationReady — the single funnel every
      // path (this button AND the ReusePanel) shares — so the founder's one click
      // enables + verifies + generates with no hidden step, on FRESH server state.
      if (isVqRefType(typeOverride) && typeOverride !== refType) setRefType(typeOverride); // keep gallery + approved-image in sync
      // Reuse popup is an ADVANCED-only affordance (Phase 1): Simple mode keeps the
      // founder in the plain Generate → Approve flow and never shows the cross-asset
      // "Reuse / Reference / Generate Anyway" chooser — reuse-first still happens
      // server-side, this only hides the implementation-detail popup.
      if (advanced) {
        // Check for approved reusable assets FIRST — reuse must be an explicit choice.
        const check = await fetchReuseCheck({ characterId: selected.characterId, referenceType: type });
        if (check === null) {
          // Fail OPEN but never SILENTLY: the reuse endpoint errored, so we can't rule
          // out existing approved assets — tell the founder before spending credits.
          toast({ title: "Reuse check unavailable", description: "Couldn't verify existing approved assets — generating new artwork." });
        }
        if (check && check.assets.length > 0) { setReuseType(type); setReuseCheck(check); setBusy(null); resetGenerateWith(); return; }
      }
      // Release before delegating — doGenerateReference acquires the latch itself
      // (it is also called directly by the ReusePanel buttons). Same synchronous
      // frame, so no click can interleave between release and re-acquire.
      genInFlight.current = false;
      await doGenerateReference(type);
    } finally {
      genInFlight.current = false;
    }
  }

  async function applyReuseAsset(asset: ReusableAsset) {
    if (!selected) return;
    setBusy("gen-art");
    try {
      const r = await apiRequest("POST", `/api/admin/vault-quest/sets/GNV/reuse-apply`, { characterId: selected.characterId, sourceR2Key: asset.r2Key, referenceType: reuseType });
      if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || "reuse failed"), { status: r.status });
      await candQuery.refetch();
      setArtNonce((n) => n + 1);
      setReuseCheck(null);
      toast({ title: "Approved asset reused — 0 credits", description: "Copied into the candidate gallery. Review and approve it like any candidate — nothing was auto-approved." });
    } catch (e) {
      artworkError(e, "Reuse failed");
    } finally {
      setBusy(null);
    }
  }

  async function doGenerateReference(typeOverride?: VqRefType) {
    if (!selected) { resetGenerateWith(); return; }
    if (genInFlight.current) { resetGenerateWith(); return; } // double-click guard for the ReusePanel entry points too
    genInFlight.current = true;
    // Guard: only a real ref-type string; never a forwarded MouseEvent (would put a
    // DOM node into the JSON body → "Converting circular structure to JSON").
    const type: VqRefType = isVqRefType(typeOverride) ? typeOverride : refType;
    // Premium (highest-quality) model requires an explicit checked confirmation +
    // reason before it can spend the premium rate — unchanged, still enforced here.
    if (premiumBlockReason) {
      toast({ title: "Confirm premium generation", description: premiumBlockReason, variant: "destructive" });
      genInFlight.current = false;
      setBusy(null);
      resetGenerateWith();
      return;
    }
    // The character's description must be approved before any artwork (server also
    // enforces this with a 422). Surface it here so the founder gets the real reason
    // instead of a request that silently bounces.
    if (selected.descriptionStatus !== "approved") {
      toast({ title: "Approve the description first", description: "Generate, review and Approve the character description before generating artwork.", variant: "destructive" });
      genInFlight.current = false;
      setBusy(null);
      resetGenerateWith();
      return;
    }
    // Resolve the two spend gates (per-type flag + provider verification) through
    // the sanctioned enable/verify endpoints — the founder's single click, no hidden
    // panel. Returns false (already messaged) if the founder cancels or a real,
    // unresolvable reason remains. The server re-checks both gates on the POST below.
    setBusy("gen-art");
    setBgRejection(null); // a fresh attempt clears any prior background-rejection notice
    const ready = await ensureGenerationReady(featureForReferenceType(type));
    if (!ready) {
      genInFlight.current = false;
      setBusy(null);
      resetGenerateWith();
      return;
    }
    const typeLabel = REF_TYPES.find((t) => t.value === type)?.label ?? "reference";
    setReuseCheck(null);
    setBusy("gen-art");
    // Double-pay protection (D10): reuse the SAME key across a reload/2nd tab for this
    // exact character+type+model; cleared below on any TERMINAL outcome so a deliberate
    // next click (new roll, or a retry after a real failure) gets a fresh one. A
    // client-side timeout is NOT terminal — see runGenerationWithRecovery below — so it
    // must never clear this key, or a re-click would mint a fresh one and risk a
    // second paid attempt while the first is still genuinely running server-side.
    // Action Reference only: include the chosen action category. It's part of the
    // idempotency scope so a DIFFERENT category is a distinct paid request (a fresh
    // key), while a reload with the SAME category still safely replays (D10 unchanged).
    const catForBody = type === "action_pose" ? actionCategory : undefined;
    const requestModel = requestModelForGenerateWith(imgModel);
    const fallbackModel = requestModel ?? VQ_QUALITY_MODEL.draft;
    const scopeKey = `character:${selected.characterId}:${type}:${imgModel}${catForBody ? `:${catForBody}` : ""}`;
    const idempotencyKey = getOrCreateIdempotencyKey(scopeKey);
    const url = `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/generate-artwork`;
    const body = { referenceType: type, ...(requestModel ? { model: requestModel } : {}), idempotencyKey, ...(catForBody ? { actionCategory: catForBody } : {}), ...premiumRequest(imgModel) };
    try {
      // Bounded client wait, then safe re-polling on the SAME idempotencyKey — the
      // server's D10 guard makes a repeat POST free (202 pending / 200 replayed), so
      // "recovery" here is just asking the same question again, never a new charge.
      const outcome = await runGenerationWithRecovery({
        post: () => postJson(url, body),
        onPhase: (phase) => {
          setGenPhase(phase);
          if (phase === "generating") setGenStageLabel(generationStageLabel("generating", typeLabel));
          else if (phase === "still-processing") setGenStageLabel("Still processing…");
        },
      });

      if (outcome.phase === "still-processing") {
        // Timed out AND the poll budget is exhausted with no terminal answer yet.
        // The reservation is still valid server-side — keep the key so the founder's
        // next click (now, or after a refresh) safely re-asks instead of re-charging.
        toast({ title: "Still processing", description: "This is taking longer than usual but is still running on the server. Check back shortly — trying again now won't charge twice." });
        return;
      }
      if (outcome.phase === "failed") {
        clearIdempotencyKey(scopeKey); // terminal (error) response — a deliberate retry should charge again
        // A studio-background rejection is a specific, expected outcome (the image
        // reached the gate and was correctly rejected): show the dedicated founder
        // panel with the measured %, threshold and credit note + an explicit Try
        // Again, instead of a generic error toast. NO automatic paid retry happened.
        const body = (outcome.data ?? {}) as {
          rejected?: boolean;
          rejectionKind?: string;
          error?: string;
          backgroundOffFraction?: number;
          backgroundThreshold?: number;
          providerCreditUsed?: boolean;
          cleanupAttempted?: boolean;
          quarantineRef?: string | null;
        };
        if (type === "action_pose" && body.rejected && body.rejectionKind === "studio_background") {
          const pct = (v: number | undefined) => (typeof v === "number" ? Math.round(v * 1000) / 10 : null);
          setBgRejection({
            reason: body.error ?? "Generated image had a non-studio background.",
            offPercent: pct(body.backgroundOffFraction),
            thresholdPercent: pct(body.backgroundThreshold),
            creditUsed: body.providerCreditUsed === true,
            cleanupAttempted: body.cleanupAttempted === true,
            quarantineRef: body.quarantineRef ?? null,
          });
          return;
        }
        artworkError(outcome.error, `Generate ${typeLabel} failed`);
        return;
      }
      // completed or replayed — both terminal, safe to clear.
      clearIdempotencyKey(scopeKey);
      setGenStageLabel(generationStageLabel("refreshing")); // narrate the auto-refresh
      if (type === "master_portrait") {
        const data = outcome.data as { created?: { model?: string }[]; autoRejected?: number; bgRejected?: number; message?: string };
        if (outcome.phase === "replayed") {
          toast({ title: "Already generated", description: data.message ?? "This exact request already completed. Refresh the gallery to see it." });
          await candQuery.refetch();
          return;
        }
        // Master Reference always produces TWO strict studio candidates (enforced server-side).
        await candQuery.refetch();
        setArtNonce((n) => n + 1);
        const made = data.created?.length ?? 0;
        const rejected = data.autoRejected ?? 0;
        trackCredits(vqChargedCredits(data, fallbackModel)); // counts billed rejects at the model actually used
        toast({ title: `Master Reference — ${made} candidate${made === 1 ? "" : "s"}`, description: rejected ? `${rejected} auto-rejected for identity drift. Choose one below.` : "Studio references generated — choose one below." });
      } else {
        const data = outcome.data as { width: number; height: number; model?: string; message?: string; backgroundCorrected?: boolean };
        if (outcome.phase === "replayed") {
          toast({ title: "Already generated", description: data.message ?? "This exact request already completed. Refresh the gallery to see it." });
          await candQuery.refetch();
          return;
        }
        if (data.backgroundCorrected) {
          // The raw provider background failed the gate but was fixed LOCALLY — no extra
          // provider call, no extra credit. Reassure the founder explicitly.
          toast({ title: "Studio background corrected automatically", description: "The studio background was cleaned up locally — no additional generation credit used. Review the candidate below." });
        }
        await candQuery.refetch();
        trackCredits(vqCreditsPerImage(data.model ?? fallbackModel)); // model the server actually used (refs may upgrade it)
        setArtNonce((n) => n + 1);
        toast({ title: `${typeLabel} generated`, description: `${data.width}x${data.height} — review below, then Approve.` });
      }
    } finally {
      genInFlight.current = false;
      setBusy(null);
      setGenPhase(null);
      setGenStageLabel(null);
      resetGenerateWith();
    }
  }

  async function generateFamilyArtwork() {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); resetGenerateWith(); return; }
    const blocked = generationBlockedReasonWithProvider(founderFlags, "gen_master_portrait", providerConnection, providerStatusLoaded);
    if (blocked) { toast({ title: "Generation unavailable", description: blocked, variant: "destructive" }); resetGenerateWith(); return; }
    if (!window.confirm(`Generate Stage 1/2/3 master artwork for family ${selected.familyId}? This spends Higgsfield credits (up to 3 images).`)) { resetGenerateWith(); return; }
    setBusy("gen-family");
    const requestModel = requestModelForGenerateWith(imgModel);
    const fallbackModel = requestModel ?? VQ_QUALITY_MODEL.draft;
    const familyScopeKey = `family:${selected.familyId}:${imgModel}`;
    const familyIdempotencyKey = getOrCreateIdempotencyKey(familyScopeKey);
    try {
      const res = await apiRequest("POST", `/api/admin/vault-quest/characters/family/${encodeURIComponent(selected.familyId)}/generate-artwork`, { ...(requestModel ? { model: requestModel } : {}), idempotencyKey: familyIdempotencyKey, ...premiumRequest(imgModel) });
      const data = (await res.json()) as { generated?: unknown[]; pending?: boolean; message?: string };
      if (data.pending) { toast({ title: "Already generating", description: data.message ?? "This is already running — please wait." }); return; }
      clearIdempotencyKey(familyScopeKey);
      await candQuery.refetch();
      setArtNonce((n) => n + 1);
      trackCredits((data.generated?.length ?? 0) * vqCreditsPerImage(fallbackModel)); // paid images — keep the spend counters honest
      toast({ title: "Family master artwork generated", description: `${data.generated?.length ?? 0} stage candidate(s). Select each stage to review + approve.` });
    } catch (e) {
      clearIdempotencyKey(familyScopeKey);
      artworkError(e, "Generate family artwork failed");
    } finally {
      setBusy(null);
      resetGenerateWith();
    }
  }

  async function generate3More() {
    if (!selected) { toast({ title: "Choose a character first", variant: "destructive" }); resetGenerateWith(); return; }
    const blocked = generationBlockedReasonWithProvider(founderFlags, featureForReferenceType(refType), providerConnection, providerStatusLoaded);
    if (blocked) { toast({ title: "Generation unavailable", description: blocked, variant: "destructive" }); resetGenerateWith(); return; }
    if (!window.confirm(`Generate 3 more ${refTypeMeta.label} candidates for ${selected.characterName}? This spends Higgsfield credits (3 images).`)) { resetGenerateWith(); return; }
    setBusy("gen-3more");
    const requestModel = requestModelForGenerateWith(imgModel);
    const fallbackModel = requestModel ?? VQ_QUALITY_MODEL.draft;
    const batchScopeKey = `character:${selected.characterId}:batch:${refType}:${imgModel}`;
    const batchIdempotencyKey = getOrCreateIdempotencyKey(batchScopeKey);
    try {
      const res = await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/generate-artwork/batch`, { count: 3, referenceType: refType, ...(requestModel ? { model: requestModel } : {}), idempotencyKey: batchIdempotencyKey, ...premiumRequest(imgModel) });
      const data = (await res.json()) as { created?: { model?: string }[]; autoRejected?: number; bgRejected?: number; pending?: boolean; message?: string };
      if (data.pending) { toast({ title: "Already generating", description: data.message ?? "This is already running — please wait." }); return; }
      clearIdempotencyKey(batchScopeKey);
      await candQuery.refetch();
      setArtNonce((n) => n + 1);
      trackCredits(vqChargedCredits(data, fallbackModel)); // counts billed rejects at the model actually used
      toast({ title: "Generated more candidates", description: `${data.created?.length ?? 0} new candidate(s).` });
    } catch (e) {
      clearIdempotencyKey(batchScopeKey);
      artworkError(e, "Generate 3 more failed");
    } finally {
      setBusy(null);
      resetGenerateWith();
    }
  }

  async function approveCandidate(candidateId: number, lock = false) {
    if (!selected) return;
    // Approving on an already-locked character replaces its Master/Action reference
    // (Phase B) — a deliberate, confirmed action every time. The old image is archived,
    // never destroyed (promoteCharacterReferenceRevision), and stays in Archive/History.
    const lockedOverride = selected.locked;
    if (lockedOverride && !window.confirm(`${selected.characterName} is locked as canonical.\n\nApproving this candidate will archive the current approved reference image and make this the new one. The replaced image stays available in Archive/History and can be restored at any time.\n\nContinue?`)) return;
    // Which step did we just complete? Drives auto-progression to the next one.
    const approvedType = candidates.find((c) => c.id === candidateId)?.referenceType;
    setBusy(`${lock ? "lock" : "approve"}-${candidateId}`);
    try {
      await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/approve-candidate`, { candidateId, lock, ...(lockedOverride ? { confirmReplaceLocked: true } : {}) });
      await chars.refetch();
      await candQuery.refetch();
      setArtNonce((n) => n + 1);
      // Auto-progress: Master approved → Action step; Action approved → Lock step.
      if (approvedType === "master_portrait") scrollToStep("action");
      else if (approvedType === "action_pose") scrollToStep("lock");
      toast({ title: lock ? "Approved + locked" : "Approved as reference", description: lock ? "Approved artwork set; character locked." : "This is now the approved Character Bible artwork." });
    } catch (e) {
      onAuthError(e, "Approve candidate failed");
    } finally {
      setBusy(null);
    }
  }

  async function rejectCandidate(candidateId: number) {
    if (!selected) return;
    setBusy(`reject-${candidateId}`);
    try {
      await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/reject-candidate`, { candidateId });
      setFamilySel((p) => { if (p[selected.characterId] === candidateId) { const n = { ...p }; delete n[selected.characterId]; return n; } return p; });
      await candQuery.refetch();
      toast({ title: "Candidate rejected", description: "Marked rejected (kept in storage)." });
    } catch (e) {
      onAuthError(e, "Reject candidate failed");
    } finally {
      setBusy(null);
    }
  }

  async function approveFamilyReferences() {
    if (!selected) return;
    const stages = characters.filter((c) => c.familyId === selected.familyId).sort((a, b) => a.stageNumber - b.stageNumber);
    const selections = stages.map((s) => ({ characterId: s.characterId, candidateId: familySel[s.characterId] })).filter((x) => Number.isInteger(x.candidateId));
    if (stages.length !== 3 || selections.length !== 3) { toast({ title: "Select a candidate for all 3 stages first", variant: "destructive" }); return; }
    setBusy("approve-family");
    try {
      await apiRequest("POST", `/api/admin/vault-quest/characters/family/${encodeURIComponent(selected.familyId)}/approve-references`, { selections });
      await chars.refetch();
      setArtNonce((n) => n + 1);
      toast({ title: "Family references approved", description: `All 3 stages of ${selected.familyId} now have an approved reference.` });
    } catch (e) {
      onAuthError(e, "Approve family references failed");
    } finally {
      setBusy(null);
    }
  }

  const familyStages = selected ? characters.filter((c) => c.familyId === selected.familyId).sort((a, b) => a.stageNumber - b.stageNumber) : [];
  const familyReady = familyStages.length === 3 && familyStages.every((s) => Number.isInteger(familySel[s.characterId]));

  const masterImages = cost.data?.masterImagesPerItem ?? 3;
  const imagesForType = (rt: VqRefType) => (rt === "master_portrait" ? masterImages : 1);
  // Build the estimate for an explicit list of (character, referenceType) work items.
  function openBatchItems(work: { characterId: string; name: string; stage: number; referenceType: VqRefType }[], label: string) {
    if (batchRunning) { resetGenerateWith(); return; }
    if (work.length === 0) { toast({ title: "Nothing to generate", description: `Everything for “${label}” is already approved / locked / complete — 0 credits.` }); resetGenerateWith(); return; }
    const disabledType = work.find((w) => generationBlockedReasonWithProvider(founderFlags, featureForReferenceType(w.referenceType), providerConnection, providerStatusLoaded));
    if (disabledType) {
      toast({ title: "Generation unavailable", description: generationBlockedReasonWithProvider(founderFlags, featureForReferenceType(disabledType.referenceType), providerConnection, providerStatusLoaded) ?? "This generation type is Off.", variant: "destructive" });
      resetGenerateWith();
      return;
    }
    const items: BatchItem[] = work.map((w) => ({ ...w, status: "queued" }));
    const images = work.reduce((a, w) => a + imagesForType(w.referenceType), 0);
    const baseModel = requestModelForGenerateWith(imgModel) ?? VQ_QUALITY_MODEL.draft;
    const resolvedModel = expectedResolvedModel(baseModel, work.some((w) => w.referenceType !== "master_portrait" || !!characters.find((c) => c.characterId === w.characterId)?.referencePack));
    const maxCredits = batchMaximumCredits(images, resolvedModel, autoPaidRetryEnabled);
    setTypedConfirm("");
    setEstimate({ items, images, credits: maxCredits, needTyped: images > BATCH_IMAGE_LIMIT, label, model: resolvedModel, premiumReason: isPremiumModel(resolvedModel) ? premiumReason.trim() : undefined });
  }
  // Convenience: a batch of the CURRENT reference type over the given characters.
  // Filters to characters the server would actually accept AND that still need this
  // type — otherwise "Generate Selected/Family/Stage" happily re-billed approved
  // references and enqueued locked/description-less characters as failures. This is
  // the filtering the empty-case toast in openBatchItems already promises.
  function openBatch(chars: VqCharacterRow[], label: string) {
    const eligible = chars.filter((c) => !c.locked && c.descriptionStatus === "approved" && !packApproved(c, refType));
    openBatchItems(eligible.map((c) => ({ characterId: c.characterId, name: c.characterName, stage: c.stageNumber, referenceType: refType })), label);
  }

  function stopBatch() { stopRef.current = true; pauseRef.current = false; setQueuePaused(false); resetGenerateWith(); }
  function pauseQueue() { pauseRef.current = true; setQueuePaused(true); }
  function resumeQueue() { pauseRef.current = false; setQueuePaused(false); }
  function skipCurrent() { skipRef.current = true; }
  // Re-queue failed / rejected items from the finished batch as a fresh estimate.
  function retryBatch(statuses: BatchStatus[]) {
    if (!batch || batchRunning) { resetGenerateWith(); return; }
    const work = batch.filter((b) => statuses.includes(b.status)).map((b) => ({ characterId: b.characterId, name: b.name, stage: b.stage, referenceType: b.referenceType, kind: b.kind }));
    if (!work.length) { toast({ title: "Nothing to retry" }); resetGenerateWith(); return; }
    const disabledType = work.find((w) => generationBlockedReasonWithProvider(founderFlags, featureForReferenceType(w.referenceType), providerConnection, providerStatusLoaded));
    if (disabledType) {
      toast({ title: "Generation unavailable", description: generationBlockedReasonWithProvider(founderFlags, featureForReferenceType(disabledType.referenceType), providerConnection, providerStatusLoaded) ?? "This generation type is Off.", variant: "destructive" });
      resetGenerateWith();
      return;
    }
    const images = work.reduce((a, w) => a + (w.kind === "description" ? 0 : imagesForType(w.referenceType)), 0);
    const baseModel = requestModelForGenerateWith(imgModel) ?? VQ_QUALITY_MODEL.draft;
    const maxCredits = batchMaximumCredits(images, baseModel, autoPaidRetryEnabled);
    setTypedConfirm("");
    setEstimate({ items: work.map((w) => ({ ...w, status: "queued" as BatchStatus })), images, credits: maxCredits, needTyped: images > BATCH_IMAGE_LIMIT, label: `Retry ${statuses.join("/")}`, model: baseModel, premiumReason: isPremiumModel(baseModel) ? premiumReason.trim() : undefined });
  }

  async function runBatch() {
    if (!estimate || batchRunning) { resetGenerateWith(); return; }
    if (estimate.needTyped && typedConfirm.trim() !== TYPED_PHRASE) {
      toast({ title: "Type the confirmation to proceed", description: `Type: ${TYPED_PHRASE}`, variant: "destructive" });
      resetGenerateWith();
      return;
    }
    const disabledType = estimate.items.find((item) => item.kind !== "description" && generationBlockedReasonWithProvider(founderFlags, featureForReferenceType(item.referenceType), providerConnection, providerStatusLoaded));
    if (disabledType) {
      toast({ title: "Generation unavailable", description: generationBlockedReasonWithProvider(founderFlags, featureForReferenceType(disabledType.referenceType), providerConnection, providerStatusLoaded) ?? "This generation type is Off.", variant: "destructive" });
      resetGenerateWith();
      return;
    }
    const items = estimate.items.map((i) => ({ ...i, status: "queued" as BatchStatus }));
    // Spend on the model the founder CONFIRMED, not whatever the selector says now.
    const batchModel = estimate.model;
    const batchCreditsPerImage = vqCreditsPerImage(batchModel);
    setBatch(items);
    setEstimate(null);
    resetGenerateWith();
    setBatchRunning(true);
    stopRef.current = false; pauseRef.current = false; skipRef.current = false; setQueuePaused(false);
    const setItem = (idx: number, patch: Partial<BatchItem>) => setBatch((prev) => (prev ? prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)) : prev));
    let ok = 0, failed = 0, rejected = 0, skipped = 0;
    for (let i = 0; i < items.length; i++) {
      // Unmount = stop: leaving the Bible view removes the Stop/Pause controls, so the
      // loop must never keep spending credits (or spinning in the pause-wait) unseen.
      if (!alive.current) { stopRef.current = true; }
      // Pause: hold BEFORE starting the next item (never mid-request).
      while (pauseRef.current && !stopRef.current && alive.current) {
        setItem(i, { status: "paused" });
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!alive.current) { resetGenerateWith(); return; } // unmounted: no further requests, no toast, no refetch
      if (stopRef.current) {
        setBatch((prev) => (prev ? prev.map((it) => (it.status === "queued" || it.status === "generating" || it.status === "paused" ? { ...it, status: "skipped" as BatchStatus } : it)) : prev));
        skipped = items.length - i;
        break;
      }
      if (skipRef.current) { skipRef.current = false; setItem(i, { status: "skipped", note: "skipped by founder" }); skipped++; continue; }
      setItem(i, { status: "generating" });
      const queueScopeKey = items[i].kind === "description" ? null : `character:${items[i].characterId}:${items[i].referenceType}:${batchModel || "default"}`;
      try {
        if (items[i].kind === "description") {
          // Anthropic text only — generates a DRAFT description (never approves), 0 credits.
          const res = await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(items[i].characterId)}/describe`, { mode: "generate" });
          const data = (await res.json()) as { fields?: Record<string, string> };
          if (!data.fields) { setItem(i, { status: "failed", note: "no fields" }); failed++; continue; }
          await apiRequest("PATCH", `/api/admin/vault-quest/characters/${encodeURIComponent(items[i].characterId)}`, { ...data.fields, reason: "batch description draft" });
          setItem(i, { status: "succeeded", note: "draft — review & approve" }); ok++;
        } else {
          const queueIdempotencyKey = getOrCreateIdempotencyKey(queueScopeKey!);
          const res = await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(items[i].characterId)}/generate-artwork`, { referenceType: items[i].referenceType, model: batchModel, idempotencyKey: queueIdempotencyKey, ...premiumRequest(batchModel, estimate.premiumReason ?? premiumReason) });
          const data = (await res.json()) as { created?: unknown[]; autoRejected?: number; candidateId?: number; pending?: boolean };
          if (data.pending) { setItem(i, { status: "queued", note: "already running elsewhere" }); continue; } // don't clear the key — genuinely still in flight
          clearIdempotencyKey(queueScopeKey!);
          const made = Array.isArray(data.created) ? data.created.length : data.candidateId ? 1 : 0;
          trackCredits(made * batchCreditsPerImage);
          if (made === 0 && (data.autoRejected ?? 0) > 0) { setItem(i, { status: "rejected", note: "identity drift" }); rejected++; }
          else { setItem(i, { status: "succeeded" }); ok++; }
        }
      } catch (e) {
        if (queueScopeKey) clearIdempotencyKey(queueScopeKey); // terminal (error) — a deliberate retry should charge again
        const status = (e as { status?: number })?.status;
        if (status === 401) {
          // Auth expired: mark the current item failed AND release the queued remainder
          // as skipped (previously they were stranded "queued" forever with no retry path).
          onAuthError(e, "Batch generation failed");
          setItem(i, { status: "failed", note: "auth" });
          failed++;
          setBatch((prev) => (prev ? prev.map((it) => (it.status === "queued" ? { ...it, status: "skipped" as BatchStatus, note: "auth expired" } : it)) : prev));
          skipped = items.length - i - 1;
          break;
        }
        if (status === 422 && /identity|drift/i.test((e as Error)?.message ?? "")) { setItem(i, { status: "rejected", note: "identity drift" }); rejected++; }
        else {
          setItem(i, { status: "failed", note: (e as Error)?.message?.slice(0, 50) });
          failed++;
          if (stopOnFail) {
            setBatch((prev) => (prev ? prev.map((it) => (it.status === "queued" ? { ...it, status: "skipped" as BatchStatus } : it)) : prev));
            skipped = items.length - i - 1;
            break;
          }
        }
      } finally {
        // A Skip pressed while THIS item was already in-flight cannot abort the HTTP
        // request — clear it so it doesn't leak onto (and wrongly skip) the NEXT item.
        skipRef.current = false;
      }
    }
    setBatchRunning(false);
    resetGenerateWith();
    stopRef.current = false; pauseRef.current = false; setQueuePaused(false);
    await candQuery.refetch();
    await chars.refetch();
    setArtNonce((n) => n + 1);
    toast({ title: "Batch complete", description: `${ok} done · ${rejected} rejected · ${failed} failed · ${skipped} skipped` });
  }

  // Generate Missing Descriptions — Anthropic only (0 Higgsfield credits). Drafts only;
  // skips approved descriptions, locked characters, and canonical/complete characters.
  function generateMissingDescriptions() {
    const work = characters
      // "Missing" means missing: characters with fully-written (just unapproved) DNA are
      // NOT regenerated — this button previously clobbered manual unapproved drafts.
      .filter((c) => !c.locked && !isCanonical(c) && c.descriptionStatus !== "approved" && !dnaComplete(c))
      .map((c) => ({ characterId: c.characterId, name: c.characterName, stage: c.stageNumber, referenceType: "master_portrait" as VqRefType, kind: "description" as const }));
    if (!work.length) { toast({ title: "Nothing to generate", description: "Every unlocked character already has an approved description." }); resetGenerateWith(); return; }
    setTypedConfirm("");
    setEstimate({ items: work.map((w) => ({ ...w, status: "queued" as BatchStatus })), images: 0, credits: 0, needTyped: false, label: `Missing descriptions (${work.length}) — Anthropic text, 0 Higgsfield credits`, model: requestModelForGenerateWith(imgModel) ?? VQ_QUALITY_MODEL.draft });
    resetGenerateWith();
  }

  // ── Family actions ─────────────────────────────────────────────────────────
  // Generate the REQUIRED references (Master + Action) for the family's unlocked stages,
  // skipping any already-approved reference, locked characters and completed packs.
  function generateRequiredReferences() {
    const work = familyStages.flatMap((ch) =>
      ch.locked || ch.descriptionStatus !== "approved" ? [] : REQUIRED_REF_TYPES.filter((t) => !packApproved(ch, t)).map((t) => ({ characterId: ch.characterId, name: ch.characterName, stage: ch.stageNumber, referenceType: t })),
    );
    const skippedDesc = familyStages.filter((c) => !c.locked && c.descriptionStatus !== "approved").length;
    if (skippedDesc) toast({ title: `${skippedDesc} stage(s) skipped`, description: "Their description isn't approved yet — approve descriptions first." });
    openBatchItems(work, `Required references — ${selected?.familyId ?? "family"}`);
  }
  // Generate the FULL pack (all 5 types) for all 3 stages, skipping approved refs + locked stages.
  function generateCompleteFamilyPack() {
    const work = familyStages.flatMap((ch) =>
      ch.locked || ch.descriptionStatus !== "approved" ? [] : REF_TYPES.filter((t) => !packApproved(ch, t.value)).map((t) => ({ characterId: ch.characterId, name: ch.characterName, stage: ch.stageNumber, referenceType: t.value })),
    );
    openBatchItems(work, `Complete family pack — ${selected?.familyId ?? "family"}`);
  }
  // Approve the NEWEST un-approved candidate of the current reference type for each family stage.
  async function approveSelectedFamily() {
    if (!selected) return;
    setBusy("approve-family");
    let approved = 0;
    try {
      for (const ch of familyStages) {
        if (packApproved(ch, refType)) continue;
        const list = (await (await apiRequest("GET", `/api/admin/vault-quest/characters/${encodeURIComponent(ch.characterId)}/candidates?type=${refType}`)).json()) as { candidates?: { id: number; status: string }[] };
        const pick = (list.candidates ?? []).find((c) => c.status === "candidate" || c.status === "approved");
        if (!pick) continue;
        await apiRequest("POST", `/api/admin/vault-quest/characters/${encodeURIComponent(ch.characterId)}/approve-candidate`, { candidateId: pick.id });
        approved++;
      }
      await chars.refetch();
      setArtNonce((n) => n + 1);
      toast({ title: "Approved selected", description: `${approved} stage(s) got an approved ${refTypeMeta.label}.` });
    } catch (e) {
      onAuthError(e, "Approve selected failed");
    } finally {
      setBusy(null);
    }
  }
  async function lockFamily(lock: boolean) {
    if (!selected) return;
    if (lock && !familyStages.every((c) => requiredComplete(c))) { toast({ title: "Every stage needs a complete required pack before locking the family.", variant: "destructive" }); return; }
    if (lock && !window.confirm(`Lock all 3 stages of ${selected.familyId}?\n\nLocked characters become the permanent identity for all future AI generations.`)) return;
    setBusy("lock-family");
    try {
      for (const ch of familyStages) {
        if (ch.locked === lock) continue;
        if (lock && !requiredComplete(ch)) continue;
        await setLocked(ch.characterId, lock);
      }
      await chars.refetch();
      toast({ title: lock ? "Family locked" : "Family unlocked", description: selected.familyId });
    } catch (e) {
      onAuthError(e, "Family lock failed");
    } finally {
      setBusy(null);
    }
  }
  const familyLockedCount = familyStages.filter((c) => c.locked).length;
  const familyAllRequired = familyStages.length === 3 && familyStages.every((c) => requiredComplete(c));
  const packScores = Object.values(selected?.referencePack ?? {}).map((v) => v?.identityScore).filter((s): s is number => typeof s === "number");
  const avgIdentity = packScores.length ? Math.round(packScores.reduce((a, b) => a + b, 0) / packScores.length) : null;
  const statusChip = (label: string, ok: boolean, partial = false) => (
    <span className={`rounded px-1.5 py-0.5 ${ok ? "bg-emerald-950 text-emerald-300" : partial ? "bg-amber-950 text-amber-300" : "bg-slate-800 text-slate-500"}`}>{ok ? "✅ " : partial ? "◐ " : "○ "}{label}</span>
  );

  return (
    <div className="space-y-4">
      {reuseCheck && (
        <ReusePanel
          check={reuseCheck}
          providerLabel={`higgsfield · ${imgModel}`}
          busy={busy === "gen-art"}
          onReuse={applyReuseAsset}
          onGenerateWithRefs={() => void doGenerateReference()}
          onGenerateAnyway={() => void doGenerateReference()}
          onClose={() => { setReuseCheck(null); resetGenerateWith(); }}
        />
      )}
      <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 p-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold"><BookOpen className="h-5 w-5 text-amber-400" />Character Bible</h2>
          <p className="text-xs text-slate-400">Permanent creature identity, artwork approval and lock state.</p>
        </div>
        <div className="flex gap-2">
          <AdminButton variant="ghost" onClick={onBack}><ArrowLeft className="mr-1 h-4 w-4" />Board</AdminButton>
          <AdminButton variant="gold" onClick={() => setDesignerOpen(true)}><Sparkles className="mr-1 h-4 w-4" />Create New Creature</AdminButton>
          {advanced && <AdminButton variant="ghost" onClick={seedCharacters} disabled={busy === "seed"}>{busy === "seed" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BookOpen className="mr-1 h-4 w-4" />}Seed missing</AdminButton>}
        </div>
      </div>
      {designerOpen && (
        <CreatureDesigner
          onClose={() => setDesignerOpen(false)}
          onCreated={async (_familyId, stage1CharacterId) => {
            setDesignerOpen(false);
            await chars.refetch();
            setSelectedId(stage1CharacterId); // open the new Stage 1 (description already approved)
            scrollToStep("master");
          }}
        />
      )}

      {/* ═══ Founder production dashboard (live) ═══ */}
      {characters.length > 0 && (() => {
        const descA = characters.filter((c) => c.descriptionStatus === "approved").length;
        const refsA = characters.filter((c) => requiredComplete(c)).length;
        const lockedN = characters.filter((c) => c.locked).length;
        const canonN = characters.filter((c) => isCanonical(c)).length;
        const famIds = [...new Set(characters.map((c) => c.familyId))];
        const famComplete = famIds.filter((f) => characters.filter((c) => c.familyId === f).every((c) => isCanonical(c))).length;
        const cardsGen = bibleDash.data ? bibleDash.data.total - bibleDash.data.needsArtwork : null;
        const qaPassed = bibleDash.data?.byStatus?.approved ?? 0;
        const exportReady = bibleDash.data?.byStatus?.published ?? 0;
        const remainingImages = characters.filter((c) => !c.locked && c.descriptionStatus === "approved").reduce((a, c) => a + REQUIRED_REF_TYPES.filter((t) => !packApproved(c, t)).length, 0);
        const cell = (label: string, value: string | number, cls = "text-slate-100") => (
          <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5"><p className="text-[9px] uppercase tracking-wide text-slate-500">{label}</p><p className={`text-sm font-bold ${cls}`}>{value}</p></div>
        );
        return (
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Production dashboard</span>
              <span className="text-[10px] text-slate-500">
                Provider <b className="text-slate-300">Higgsfield</b> · model <b className="text-slate-300">{VQ_IMAGE_MODELS.find((m) => m.value === imgModel)?.label ?? imgModel}</b> · ~{creditsPerImage} cr/image · queue {batchRunning ? (queuePaused ? "paused" : "running") : "idle"}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6 lg:grid-cols-12">
              {cell("Characters", characters.length)}
              {cell("Descriptions ✓", `${descA}/${characters.length}`, descA === characters.length ? "text-emerald-400" : "text-amber-300")}
              {cell("References ✓", `${refsA}/${characters.length}`, refsA === characters.length ? "text-emerald-400" : "text-amber-300")}
              {cell("Locked", `${lockedN}/${characters.length}`, lockedN ? "text-emerald-400" : "text-slate-100")}
              {cell("Canonical", canonN, canonN ? "text-emerald-400" : "text-slate-100")}
              {cell("Families ✓", `${famComplete}/${famIds.length}`, famComplete === famIds.length ? "text-emerald-400" : "text-slate-100")}
              {cell("Cards w/ art", cardsGen ?? "—")}
              {cell("QA passed", qaPassed)}
              {cell("Export ready", exportReady)}
              {cell("Imgs remaining", remainingImages, "text-amber-300")}
              {cell("Credits (sess.)", `~${sessionCredits}`, "text-amber-300")}
              {cell("Credits (today)", `~${todayCredits}`, "text-amber-300")}
            </div>
            <p className="mt-1 text-[9px] text-slate-600">Credit figures are client-side estimates of images generated here (~{creditsPerImage}/image current model). Est. remaining spend for required refs: ~{Math.ceil(remainingImages * creditsPerImage)} credits.</p>
          </div>
        );
      })()}

      {characters.length > 0 && (
        <div className="space-y-3">
          <FounderSpendControlPanel onStatusChange={setFounderFlags} />
          <ProviderConnectionPanel onStatusChange={(provider, loaded) => { setProviderConnection(provider); setProviderStatusLoaded(loaded); }} />
        </div>
      )}

      {chars.isLoading && <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading Character Bible...</p>}
      {chars.isError && <p className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">Character Bible unavailable — {String((chars.error as Error)?.message ?? "error")}</p>}
      {!chars.isLoading && !chars.isError && !chars.data && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4">
          <p className="font-semibold text-amber-300">Admin login required</p>
          <p className="mt-1 text-sm text-slate-300">Your admin session isn't active, so the Character Bible cannot load.</p>
          <a href="/admin/login" className="mt-3 inline-flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-amber-400">Go to admin login</a>
        </div>
      )}
      {!chars.isLoading && !chars.isError && chars.data && characters.length === 0 && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4 text-sm text-slate-300">
          <p className="font-semibold text-amber-300">No Character Bible rows yet.</p>
          <p className="mt-1">Click Seed missing to create the 36 canonical stage characters from the existing Vault Quest cards.</p>
        </div>
      )}

      {characters.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
          <section className="max-h-[calc(100vh-220px)] overflow-auto rounded-lg border border-slate-800 bg-slate-900/40 p-2">
            {Object.entries(grouped).map(([familyId, rows]) => {
              const stages = [...rows].sort((a, b) => a.stageNumber - b.stageNumber);
              const complete = stages.filter((c) => isCanonical(c)).length;
              return (
              <div key={familyId} className="mb-2">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{rows[0]?.familyName ?? familyId} Family</span>
                  <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${complete === 3 ? "bg-emerald-950 text-emerald-300" : complete > 0 ? "bg-amber-950 text-amber-300" : "bg-slate-800 text-slate-500"}`}>{complete} / 3 Complete</span>
                </div>
                {stages.map((ch) => {
                  const isSelected = selected?.characterId === ch.characterId;
                  const ticked = selectedChars.has(ch.characterId);
                  const prog = stageProgress(ch);
                  return (
                    <div key={ch.characterId} className={`mb-1 flex items-stretch gap-1 rounded-md border ${isSelected ? "border-amber-500 bg-amber-500/10" : "border-slate-800 bg-slate-950/40"}`}>
                      <label className="flex cursor-pointer items-center pl-2" title="Tick for batch generation" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="h-3.5 w-3.5 accent-amber-500" checked={ticked} onChange={() => setSelectedChars((prev) => { const n = new Set(prev); if (n.has(ch.characterId)) n.delete(ch.characterId); else n.add(ch.characterId); return n; })} />
                      </label>
                      <button type="button" onClick={() => setSelectedId(ch.characterId)} className="flex-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-800/40">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-100">S{ch.stageNumber} · {ch.characterName}</span>
                          {ch.locked && <Lock className="h-3.5 w-3.5 text-emerald-400" />}
                        </div>
                        <div className={`mt-0.5 text-[10px] font-medium ${prog.cls}`}>{prog.icon} {prog.label}</div>
                      </button>
                    </div>
                  );
                })}
              </div>
            );})}
          </section>

          {selected && (
            <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-bold">{selected.characterName}</h3>
                    {isCanonical(selected) && <span className="rounded bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-slate-900">★ CANONICAL CHARACTER</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] font-semibold">
                    {statusChip("DNA Complete", dnaComplete(selected))}
                    {statusChip(`Reference Pack ${requiredCount(selected)}/2`, requiredComplete(selected), requiredCount(selected) > 0)}
                    {statusChip(avgIdentity != null ? `Identity ${avgIdentity}` : "Identity —", identityPassed(selected) && (avgIdentity == null || avgIdentity >= 70), avgIdentity != null)}
                    {statusChip("Locked", selected.locked)}
                    {statusChip("Family Complete", familyLockedCount === 3)}
                  </div>
                  {isCanonical(selected) && <p className="mt-1 text-[11px] text-emerald-400">Ready for Full Card generation — Full Card will use the approved Master Reference + Action Pose.</p>}
                  <p className="mt-1 text-xs text-slate-400">
                    {selected.characterId} · {selected.cardId} · {selected.familyId} · Stage {selected.stageNumber} · {selected.element}
                  </p>
                  {missing.length > 0 && <p className="mt-1 text-xs text-amber-400">DNA missing: {missing.slice(0, 8).join(", ")}{missing.length > 8 ? "..." : ""}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <AdminButton data-deeplink="lock_character" variant="ghost" onClick={toggleLock} disabled={busy === "lock" || (!selected.locked && !requiredComplete(selected))} title={
                    selected.locked ? "Unlock this character"
                      : !packApproved(selected, "master_portrait") ? "Complete the required reference pack before locking."
                        : !packApproved(selected, "action_pose") ? "Action Pose is required before locking."
                          : "Lock this character as the permanent identity"
                  }>
                    {busy === "lock" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : selected.locked ? <Unlock className="mr-1 h-4 w-4" /> : <Lock className="mr-1 h-4 w-4" />}
                    {selected.locked ? "Unlock" : "Lock Character"}
                  </AdminButton>
                  <AdminButton onClick={saveCharacter} disabled={busy === "save"}>{busy === "save" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}Save Bible</AdminButton>
                </div>
              </div>

              {/* ═══ Production tracker ═══
                  Simple mode: the founder-facing creature asset progression (Description →
                  Master → Action → Card Artwork → Reference Pack → future asset slots →
                  Family Complete). Advanced mode keeps the full production pipeline. */}
              {(() => {
                if (advanced) {
                  const steps = [
                    { label: "Create Character", done: descStatus(selected) === "approved" && packApproved(selected, "master_portrait") },
                    { label: "Create Battle Pose", done: packApproved(selected, "action_pose") },
                    { label: "Lock Character", done: selected.locked },
                    { label: "Create Cards", done: false },
                    { label: "Create Rare Cards", done: false },
                    { label: "Packaging", done: false },
                    { label: "QA", done: false },
                    { label: "Release", done: false },
                  ];
                  const active = steps.findIndex((s) => !s.done);
                  return (
                    <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-800 bg-slate-950/60 p-2 text-[10px]">
                      {steps.map((s, i) => (
                        <span key={s.label} className="flex items-center gap-1">
                          {i > 0 && <span className="text-slate-700">→</span>}
                          <span className={`rounded px-1.5 py-0.5 font-semibold ${s.done ? "bg-emerald-950 text-emerald-300" : i === active ? "border border-amber-500 bg-amber-500/15 text-amber-200" : "bg-slate-900 text-slate-600"}`}>
                            {s.done ? "✅" : i === active ? "▶" : `${i + 1}.`} {s.label}
                          </span>
                        </span>
                      ))}
                    </div>
                  );
                }
                // Simple mode — asset-centric tracker. `future` slots are roadmap-only.
                const descDone = descStatus(selected) === "approved";
                const masterDone = packApproved(selected, "master_portrait");
                const actionDone = packApproved(selected, "action_pose");
                const refPackDone = requiredComplete(selected);
                const steps: { label: string; done: boolean; future?: boolean }[] = [
                  { label: "Description", done: descDone },
                  { label: "Master", done: masterDone },
                  { label: "Action", done: actionDone },
                  { label: "Card Artwork", done: false },
                  { label: "Reference Pack", done: refPackDone },
                  { label: "Animations", done: false, future: true },
                  { label: "3D Model", done: false, future: true },
                  { label: "Voice", done: false, future: true },
                  { label: "Family Complete", done: familyLockedCount === 3 },
                ];
                // The current step is the first non-done, non-future step.
                const active = steps.findIndex((s) => !s.done && !s.future);
                return (
                  <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-800 bg-slate-950/60 p-2 text-[10px]">
                    {steps.map((s, i) => (
                      <span key={s.label} className="flex items-center gap-1">
                        {i > 0 && <span className="text-slate-700">→</span>}
                        <span
                          className={`rounded px-1.5 py-0.5 font-semibold ${
                            s.future ? "border border-slate-800 bg-slate-900/60 text-slate-600"
                              : s.done ? "bg-emerald-950 text-emerald-300"
                                : i === active ? "border border-amber-500 bg-amber-500/15 text-amber-200"
                                  : "bg-slate-900 text-slate-600"
                          }`}
                          title={s.future ? "Coming soon" : undefined}
                        >
                          {/* While the one-click sequence runs, the active step narrates the
                              live phase (Preparing → Verifying Provider → Generating → Refreshing). */}
                          {i === active && genStageLabel
                            ? `🟡 ${genStageLabel}`
                            : `${s.future ? "🔒" : s.done ? "✅" : i === active ? "▶" : "•"} ${s.label}${s.future ? " (soon)" : ""}`}
                        </span>
                      </span>
                    ))}
                  </div>
                );
              })()}

              {/* ═══ 1 · IDENTITY — description first, artwork second ═══ */}
              <div className="rounded-md border border-sky-800/40 bg-sky-950/10 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-sky-300">Identity</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${DESC_STATUS_META[descStatus(selected)].cls}`}>{DESC_STATUS_META[descStatus(selected)].label}</span>
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.locked && !editingLocked && (
                      <AdminButton
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (window.confirm(`${selected.characterName} is locked as a canonical character.\n\nYou can still edit its description here. Saving will require the description to be re-approved before new artwork can use it — the current locked/approved state and full history are preserved either way.\n\nContinue editing?`)) setEditingLocked(true);
                        }}
                        title="Locked characters need a confirmed Edit before their description can change"
                      >
                        <Wand2 className="mr-1 h-4 w-4" />Edit
                      </AdminButton>
                    )}
                    {selected.locked && editingLocked && (
                      <AdminButton variant="ghost" size="sm" onClick={() => { setEditingLocked(false); setDraft(draftFromCharacter(selected)); }}>
                        Cancel Edit
                      </AdminButton>
                    )}
                    <AdminButton data-deeplink="description" variant="gold" size="sm" onClick={() => generateDescription("generate")} disabled={busy === "desc-generate" || (selected.locked && !editingLocked)}>
                      {busy === "desc-generate" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}{dnaComplete(selected) ? "Regenerate Description" : "Generate Description"}
                    </AdminButton>
                    <AdminButton variant="ghost" size="sm" onClick={() => generateDescription("improve")} disabled={busy === "desc-improve" || (selected.locked && !editingLocked) || !dnaComplete(selected)} title={!dnaComplete(selected) ? "Generate a description first" : "Improve the current description without changing the identity"}>
                      {busy === "desc-improve" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}Improve
                    </AdminButton>
                    <AdminButton data-deeplink="approve_description" size="sm" onClick={approveDescription} disabled={busy === "desc-approve" || (selected.locked && !editingLocked) || descStatus(selected) === "approved"} title={descStatus(selected) === "approved" ? "Already approved" : "Saves the fields below, then approves the description — unlocks artwork generation"}>
                      {busy === "desc-approve" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}Approve Description
                    </AdminButton>
                    <AdminButton variant="ghost" size="sm" onClick={() => { setHistCompare(null); setHistOpen(true); }} title="Every save is recorded — view, compare or restore a previous description">
                      <History className="mr-1 h-4 w-4" />History
                    </AdminButton>
                  </div>
                </div>
                {selected.locked && editingLocked && (
                  <p className="mb-2 text-[11px] text-amber-300/90">Editing a locked character — Save Bible will demote the description to Needs Review until you re-approve it. The character itself stays locked/canonical.</p>
                )}
                {descStatus(selected) !== "approved" && (
                  <p className="mb-2 text-[11px] text-sky-300/80">Artwork generation is locked until the description is approved. Stage 2/3 descriptions inherit the previous stage and must clearly evolve it.</p>
                )}
                {histOpen && (
                  <div className="mb-2 max-h-72 overflow-auto rounded border border-slate-700 bg-slate-950/80 p-2">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-300">Description history — restore fills the DRAFT only (approved work is never overwritten)</span>
                      <button type="button" onClick={() => setHistOpen(false)} className="text-[11px] text-slate-500 hover:text-slate-300">close</button>
                    </div>
                    {revisions.isLoading && <p className="text-[11px] text-slate-500">Loading revisions…</p>}
                    {(revisions.data?.revisions ?? []).slice(0, 25).map((r) => {
                      const rv = r.revisionJson as Record<string, unknown>;
                      const comparing = histCompare === r.id;
                      return (
                        <div key={r.id} className="mb-1 rounded border border-slate-800 bg-slate-900/60 p-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-1 text-[10px]">
                            <span className="text-slate-400">{new Date(r.editedAt).toLocaleString()} · {r.reason ?? "edit"} · {r.editedBy ?? "admin"}</span>
                            <span className="flex gap-1">
                              <button type="button" onClick={() => setHistCompare(comparing ? null : r.id)} className="rounded border border-slate-600 px-1.5 py-0.5 text-slate-300 hover:border-sky-500">{comparing ? "Hide" : "Compare"}</button>
                              <button type="button" onClick={() => restoreRevision(rv)} className="rounded bg-amber-500 px-1.5 py-0.5 font-semibold text-slate-900 hover:bg-amber-400">Restore to draft</button>
                            </span>
                          </div>
                          {comparing && (
                            <div className="mt-1 grid grid-cols-2 gap-2 text-[10px]">
                              <div><p className="font-semibold text-slate-400">This revision</p>{BIBLE_FIELDS.filter((f) => String(rv[f.key] ?? "") !== draft[f.key]).slice(0, 6).map((f) => <p key={f.key} className="truncate text-slate-500"><b className="text-slate-400">{f.label}:</b> {String(rv[f.key] ?? "").slice(0, 90)}</p>)}</div>
                              <div><p className="font-semibold text-slate-400">Current draft</p>{BIBLE_FIELDS.filter((f) => String(rv[f.key] ?? "") !== draft[f.key]).slice(0, 6).map((f) => <p key={f.key} className="truncate text-slate-500"><b className="text-slate-400">{f.label}:</b> {draft[f.key].slice(0, 90)}</p>)}</div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {!revisions.isLoading && (revisions.data?.revisions ?? []).length === 0 && <p className="text-[11px] text-slate-500">No revisions yet.</p>}
                  </div>
                )}
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {BIBLE_FIELDS.map((field) => (
                    <div key={field.key} className={field.key === "characterDna" || field.key === "masterArtworkPrompt" ? "md:col-span-2" : ""}>
                      <label className={labelCls}>{field.label}</label>
                      <textarea
                        className={`${inputCls} min-h-[72px] resize-y`}
                        rows={field.rows}
                        value={draft[field.key]}
                        disabled={selected.locked && !editingLocked}
                        onChange={(e) => setDraft((p) => ({ ...p, [field.key]: e.target.value }))}
                        placeholder={field.label}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* ═══ SIMPLE guided reference workflow (Phase 5.3) — Master → Action → Lock ═══ */}
              {!advanced && (() => {
                const descOk = descStatus(selected) === "approved";
                const masterOk = packApproved(selected, "master_portrait");
                const actionOk = packApproved(selected, "action_pose");
                const cid = encodeURIComponent(selected.characterId);
                const busyGen = busy === "gen-art";
                const masterCands = candidates.filter((c) => c.referenceType === "master_portrait" && c.status === "candidate");
                const actionCands = candidates.filter((c) => c.referenceType === "action_pose" && c.status === "candidate");
                const packPct = (masterOk ? 50 : 0) + (actionOk ? 50 : 0);
                const health = characterHealth(selected);
                // Evolution relabeling (Phase 1): stage 2/3 aren't a fresh "Master" — they
                // are evolutions of the previous stage. Founder-facing wording only; the
                // underlying master_portrait slot + generation are unchanged.
                const stageNum = selected.stageNumber;
                const masterNoun = stageNum >= 3 ? "Final Evolution" : stageNum === 2 ? "Stage 2 Evolution" : "Master Reference";
                const masterVerb = stageNum >= 3 ? "Create Final Evolution" : stageNum === 2 ? "Create Stage 2 Evolution" : "Generate Master Reference";
                const next = !descOk ? { now: "Write & approve the description", do: "Approve Description first (above)" }
                  // Candidates-pending check must come BEFORE the generate nudge, or the
                  // banner tells the founder to (re)generate while approvals are waiting.
                  : !masterOk && masterCands.length > 0 ? { now: `${masterNoun} candidates ready`, do: `Approve a ${masterNoun}` }
                    : !masterOk ? { now: "Description approved", do: masterVerb }
                      : !actionOk && actionCands.length > 0 ? { now: "Action candidates ready", do: "Approve an Action Pose" }
                        : !actionOk ? { now: `${masterNoun} approved`, do: "Generate Matching Action Pose" }
                          : health.identityScore != null && health.identityScore < 70 ? { now: "Identity too low", do: "Generate a closer Action Pose" }
                            : !selected.locked ? { now: "Action approved", do: "Lock Character" }
                              : { now: "Character locked", do: "Generate Cards" };
                const gold = "#D4AF37";
                return (
                  <div className="space-y-4">
                    {/* ═ Character Health Check ═ */}
                    <div className={`rounded-xl border p-4 ${health.readyForCards ? "border-emerald-700 bg-emerald-950/20" : "border-slate-800 bg-slate-950/50"}`}>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Character Health Check</span>
                        {health.readyForCards && <span className="rounded-full bg-emerald-500 px-2.5 py-0.5 text-[10px] font-bold text-slate-900">READY FOR CARDS ✅</span>}
                      </div>
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {health.items.map((it) => (
                          <div key={it.label} className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${STATE_CLS[it.state]}`}>
                            <span className="font-medium">{it.label}</span>
                            <span className="font-bold tabular-nums">{it.value}</span>
                          </div>
                        ))}
                      </div>
                      {!health.readyForCards && (
                        <div className="mt-3 rounded-lg border border-amber-800/50 bg-amber-950/20 p-2.5">
                          <div className="text-xs font-semibold text-amber-300">Not ready for cards — you still need:</div>
                          <ul className="mt-1 space-y-0.5 text-[11px] text-slate-300">
                            {health.missing.map((m) => <li key={m} className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border-2 border-slate-600" />{m}</li>)}
                          </ul>
                        </div>
                      )}
                      <p className="mt-2 text-[10px] text-slate-600">Background is validated at generation; colour &amp; style consistency are derived from the identity analysis (colour, markings &amp; shape). No artwork is ever auto-approved or auto-locked.</p>
                    </div>

                    {/* Current → Next step */}
                    <div className="flex items-center gap-3 rounded-xl border p-3" style={{ borderColor: "#3f3410", background: "rgba(212,175,55,0.06)" }}>
                      <div className="flex-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Now</span>
                        <div className="text-sm font-semibold text-slate-200">{next.now}</div>
                      </div>
                      <span className="text-slate-600">→</span>
                      <div className="flex-1">
                        <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: gold }}>Next</span>
                        <div className="text-sm font-bold" style={{ color: gold }}>{next.do}</div>
                      </div>
                    </div>

                    {/* AI Cost Mode */}
                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">AI Cost Mode</div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <button type="button" onClick={() => setImgModel("auto")} className={`rounded-lg border p-2.5 text-left ${imgModel === "auto" ? "border-amber-500 bg-amber-500/15" : "border-slate-700 hover:border-slate-500"}`}>
                          <div className="flex items-center gap-2">
                            <span className={`h-3 w-3 rounded-full border-2 ${imgModel === "auto" ? "border-amber-400 bg-amber-400" : "border-slate-600"}`} />
                            <span className={`text-sm font-semibold ${imgModel === "auto" ? "text-amber-200" : "text-slate-300"}`}>Auto</span>
                          </div>
                          <div className="mt-1 text-[10px] text-slate-500">Uses the current safe server policy for this generation</div>
                        </button>
                        {COST_MODES.map((cm) => {
                          const active = imgModel !== "auto" && costModeFor(imgModel) === cm.key;
                          const blurb = cm.key === "cheapest" ? "Fast drafts and testing" : cm.key === "balanced" ? "Best value for most reference generation" : "Use for final canonical artwork";
                          return (
                            <button key={cm.key} type="button" onClick={() => setImgModel(cm.model)} className={`rounded-lg border p-2.5 text-left ${active ? "border-amber-500 bg-amber-500/15" : "border-slate-700 hover:border-slate-500"}`}>
                              <div className="flex items-center gap-2">
                                <span className={`h-3 w-3 rounded-full border-2 ${active ? "border-amber-400 bg-amber-400" : "border-slate-600"}`} />
                                <span className={`text-sm font-semibold ${active ? "text-amber-200" : "text-slate-300"}`}>{cm.label}</span>
                              </div>
                              <div className="mt-1 text-[10px] text-slate-500">{cm.key === "balanced" ? "Recommended · " : ""}{blurb}</div>
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                        {/* Master ALWAYS generates 2 candidates (server-enforced, incl. Replace); Action generates 1. */}
                        <span>Generate With: <b className="text-slate-200">{imgModel === "auto" ? "Auto" : VQ_IMAGE_MODELS.find((m) => m.value === imgModel)?.label ?? imgModel}</b></span>
                        <span>Master: <b className="text-slate-200">2 images (~{2 * creditsPerImage} cr)</b></span>
                        <span>Action: <b className="text-slate-200">1 image (~{creditsPerImage} cr)</b></span>
                        <span>Approved assets: <b className="text-slate-200">{(masterOk ? 1 : 0) + (actionOk ? 1 : 0)}</b></span>
                        <span className="text-emerald-400">Reuse-first always checks these before generating.</span>
                      </div>
                      {requestedImgModel && isPremiumModel(requestedImgModel) && (
                        <div className="mt-2 rounded-lg border border-amber-700/60 bg-amber-950/20 p-2">
                          <label className="flex items-center gap-2 text-[11px] font-semibold text-amber-200">
                            <input type="checkbox" className="h-3.5 w-3.5 accent-amber-500" checked={premiumConfirmed} onChange={(e) => setPremiumConfirmed(e.target.checked)} />
                            I confirm this Premium Final generation may spend the higher-credit model.
                          </label>
                          <input value={premiumReason} onChange={(e) => setPremiumReason(e.target.value)} placeholder="Reason for Premium Final" className={`${inputCls} mt-2 text-xs`} />
                        </div>
                      )}
                    </div>

                    {/* STEP 1 · MASTER REFERENCE (relabeled "…Evolution" for stage 2/3) */}
                    <div data-vq-step="master" className={`rounded-xl border p-4 ${masterOk ? "border-emerald-800/50 bg-emerald-950/10" : "border-slate-800 bg-slate-900/40"}`}>
                      <div className="mb-3 flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm font-bold text-slate-100"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-800 text-xs font-bold text-slate-300">1</span>{masterNoun}{masterOk && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}</span>
                      </div>
                      {masterOk ? (
                        <div className="flex items-center gap-3">
                          <VqStoredImage src={`/api/admin/vault-quest/characters/${cid}/pack/master_portrait?v=${artNonce}`} alt="approved master reference" idLabel={selected.characterId} kind="reference" onClick={() => setZoomId("master")} className="h-24 w-24 cursor-zoom-in rounded-lg bg-slate-950 object-contain" />
                          <div>
                            <div className="text-sm text-emerald-300">Approved Master on file</div>
                            <p className="mt-0.5 max-w-sm text-[11px] text-slate-500">Every future card and pose reuses this exact image so the character always looks the same.</p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <button type="button" onClick={() => setZoomId("master")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500">View</button>
                              <button type="button" onClick={() => generateMasterArtwork("master_portrait")} disabled={busyGen} title={referenceGenerationHardTitle("master_portrait")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500 disabled:opacity-40">Replace Master</button>
                              <button type="button" onClick={() => setHistoryFor("master_portrait")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500">Archive</button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button type="button" onClick={() => generateMasterArtwork("master_portrait")} disabled={busyGen || !descOk || selected.locked} title={referenceGenerationHardTitle("master_portrait") ?? (!descOk ? "Approve the description first" : undefined)}
                            className="flex w-full items-center justify-center gap-2 rounded-xl px-6 py-4 text-base font-bold text-black transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40" style={{ background: gold }}>
                            {busyGen ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}{busyGen ? (genStageLabel ?? genPhaseLabel ?? "Generating…") : masterVerb}
                          </button>
                          {!descOk && <p className="mt-2 text-center text-[11px] text-slate-500">Approve the character description above to unlock this.</p>}
                        </>
                      )}
                      {/* Candidate chooser renders in BOTH branches: after "Replace Master" the
                          approved image stays on file, but the new (paid) candidates must be
                          reviewable — previously they were generated and then hidden. */}
                      {masterCands.length > 0 && (() => {
                        // Stage 2/3 evolution-differentiation fix: when this character
                        // evolves from a previous stage that already has an approved
                        // Master, show a Previous Stage → New Candidate comparison with
                        // independent Identity / Evolution Difference badges, and block
                        // Approve when evolution-difference fails — mirroring the Action
                        // Pose section's pose-diversity comparison exactly. Stage 1 (no
                        // evolvesFromCharacterId) always falls through to the original,
                        // unchanged simple grid below.
                        const prevStageChar = selected.evolvesFromCharacterId
                          ? characters.find((c) => c.characterId === selected.evolvesFromCharacterId)
                          : undefined;
                        const prevMasterOk = !!prevStageChar?.referencePack?.master_portrait?.r2Key;
                        if (selected.stageNumber > 1 && prevMasterOk) {
                          return (
                            <div className="mt-3 space-y-2">
                              <div className="text-[11px] font-semibold text-slate-400">{masterOk ? "Replacement candidates — approving one replaces the current Master:" : `Compare each candidate to Stage ${prevStageChar!.stageNumber}:`}</div>
                              {masterCands.map((c) => {
                                const band = scoreBand(c.identityScore);
                                const traits = traitsFromBreakdown(c.identityBreakdown);
                                const evo = evolutionDifferenceBand(c.identityBreakdown?.evolutionDifference);
                                const evoFailed = evo.state === "fail";
                                return (
                                  <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                                    <div className="flex items-start gap-2">
                                      <div className="text-center"><VqStoredImage src={`/api/admin/vault-quest/characters/${encodeURIComponent(prevStageChar!.characterId)}/pack/master_portrait?v=${artNonce}`} alt={`stage ${prevStageChar!.stageNumber} approved master reference`} idLabel={prevStageChar!.characterId} kind="reference" className="h-24 w-24 rounded bg-slate-950 object-contain" /><div className="mt-0.5 text-[9px] uppercase text-slate-600">Stage {prevStageChar!.stageNumber} (approved)</div></div>
                                      <span className="mt-8 text-slate-600">→</span>
                                      <div className="text-center"><VqStoredImage src={`/api/admin/vault-quest/characters/${cid}/candidate/${c.id}?v=${artNonce}`} alt={`master candidate ${c.id}`} idLabel={c.id} kind="candidate" onClick={() => setZoomId(c.id)} className="h-24 w-24 cursor-zoom-in rounded bg-slate-950 object-contain" /><div className="mt-0.5 text-[9px] uppercase text-slate-600">Stage {selected.stageNumber} Candidate</div></div>
                                      <div className="ml-1 flex-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-bold ${STATE_CLS[band.state]}`}>Identity {c.identityScore ?? "—"} · {band.label}</div>
                                          <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-bold ${STATE_CLS[evo.state]}`} title="Measures how much this candidate has evolved from the previous stage — independent of identity.">Evolution Difference · {evo.label}</div>
                                        </div>
                                        {evoFailed && <p className="mt-1 text-[10px] text-red-400">Too similar to the previous stage — cannot be approved. Generate another.</p>}
                                        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                                          {traits.map((t) => {
                                            const mb = matchBand(t.score);
                                            return <div key={t.label} className="flex items-center justify-between"><span className="text-slate-500">{t.label}</span><span className={mb.state === "pass" ? "text-emerald-400" : mb.state === "review" ? "text-amber-400" : mb.state === "fail" ? "text-red-400" : "text-slate-600"}>{mb.label}</span></div>;
                                          })}
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                          <button type="button" disabled={!!busy || evoFailed} title={evoFailed ? "Blocked — too similar to the previous evolution stage" : undefined} onClick={() => approveCandidate(c.id)} className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-40">Approve</button>
                                          <button type="button" disabled={!!busy} onClick={() => rejectCandidate(c.id)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-400 hover:text-red-400 disabled:opacity-40">Reject</button>
                                          <button type="button" disabled={busy === `del-${c.id}`} onClick={() => deleteCandidate(c.id)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-400 hover:text-red-400 disabled:opacity-40">{busy === `del-${c.id}` ? "…" : "Delete"}</button>
                                          <button type="button" onClick={() => setZoomId(c.id)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200">Zoom</button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        }
                        return (
                          <div className="mt-3">
                            <div className="mb-1.5 text-[11px] font-semibold text-slate-400">{masterOk ? "Replacement candidates — approving one replaces the current Master:" : "Choose your favourite:"}</div>
                            <div className="grid grid-cols-3 gap-2">
                              {masterCands.map((c) => (
                                <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-1.5">
                                  <VqStoredImage src={`/api/admin/vault-quest/characters/${cid}/candidate/${c.id}?v=${artNonce}`} alt={`master candidate ${c.id}`} idLabel={c.id} kind="candidate" className="aspect-square w-full rounded bg-slate-950 object-contain" />
                                  <div className="mt-1 flex items-center justify-between">
                                    <span className="text-[10px] text-slate-500">{c.identityScore != null ? `Match ${c.identityScore}` : ""}</span>
                                    <div className="flex items-center gap-1">
                                      <button type="button" disabled={!!busy} onClick={() => rejectCandidate(c.id)} title="Reject" className="rounded p-0.5 text-slate-500 hover:text-red-400 disabled:opacity-40"><XCircle className="h-4 w-4" /></button>
                                      <button type="button" disabled={busy === `del-${c.id}`} onClick={() => deleteCandidate(c.id)} title="Delete (hides it — file kept)" className="rounded px-1 text-[9px] text-slate-500 hover:text-red-400 disabled:opacity-40">Del</button>
                                      <button type="button" disabled={!!busy} onClick={() => approveCandidate(c.id)} className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-500 disabled:opacity-40">Approve</button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    {/* STEP 2 · ACTION REFERENCE — disabled until Master approved */}
                    <div data-vq-step="action" className={`relative rounded-xl border p-4 ${!masterOk ? "border-slate-800 bg-slate-950/60" : actionOk ? "border-emerald-800/50 bg-emerald-950/10" : "border-slate-800 bg-slate-900/40"}`}>
                      <div className="mb-3 flex items-center justify-between">
                        <span className="flex items-center gap-2 text-sm font-bold text-slate-100"><span className="flex h-6 w-6 items-center justify-center rounded-lg bg-slate-800 text-xs font-bold text-slate-300">2</span>Action Reference{actionOk && <CheckCircle2 className="h-4 w-4 text-emerald-400" />}</span>
                        {!masterOk && <span className="inline-flex items-center gap-1 text-[11px] text-slate-500"><Lock className="h-3 w-3" />Locked until Master approved</span>}
                      </div>
                      {masterOk && (
                        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                          <label className="text-[11px] font-semibold text-slate-400">Action</label>
                          <select value={actionCategory} onChange={(e) => setActionCategory(e.target.value)} className={`${inputCls} w-auto text-xs`}>
                            {VQ_ACTION_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <span className="text-[10px] text-slate-500">{actionCategory === "auto" ? (actionOk ? "Auto picks a clearly different action from the current one." : "Auto picks a dynamic action.") : "This exact action will be generated."}</span>
                        </div>
                      )}
                      {!masterOk ? (
                        <p className="text-[11px] text-slate-600">Approve a Master Reference first — the Action Pose is built from it so the character stays identical.</p>
                      ) : actionOk ? (
                        <div className="flex items-center gap-3">
                          <VqStoredImage src={`/api/admin/vault-quest/characters/${cid}/pack/action_pose?v=${artNonce}`} alt="approved action reference" idLabel={selected.characterId} kind="reference" onClick={() => setZoomId("action")} className="h-24 w-24 cursor-zoom-in rounded-lg bg-slate-950 object-contain" />
                          <div>
                            <div className="text-sm text-emerald-300">Approved Action Pose on file</div>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <button type="button" onClick={() => setZoomId("action")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500">View</button>
                              <button type="button" onClick={() => generateMasterArtwork("action_pose")} disabled={busyGen} title={referenceGenerationHardTitle("action_pose")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500 disabled:opacity-40">Replace Action</button>
                              <label className={`cursor-pointer rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500 ${busy ? "pointer-events-none opacity-40" : ""}`}>
                                {busy === "upload-action" ? "Uploading…" : "Upload Action Pose"}
                                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadActionReference(f); }} />
                              </label>
                              <button type="button" onClick={() => setHistoryFor("action_pose")} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-500">Archive</button>
                            </div>
                            {referenceGenerationHardTitle("action_pose") && (
                              <div className="mt-2 text-[11px] text-amber-300">{referenceGenerationHardTitle("action_pose")}</div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <>
                          {actionCands.length === 0 && (
                            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                              <button type="button" onClick={() => generateMasterArtwork("action_pose")} disabled={busyGen || selected.locked} title={referenceGenerationHardTitle("action_pose")}
                                className="flex w-full items-center justify-center gap-2 rounded-xl px-6 py-4 text-base font-bold text-black transition enabled:hover:brightness-110 disabled:opacity-40" style={{ background: gold }}>
                                {busyGen ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wand2 className="h-5 w-5" />}{busyGen ? (genStageLabel ?? genPhaseLabel ?? "Generating…") : "Generate Matching Action Pose"}
                              </button>
                              <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-600 px-5 py-4 text-sm font-bold text-slate-100 hover:border-amber-500 ${busy ? "pointer-events-none opacity-40" : ""}`}>
                                <Upload className="h-4 w-4" />{busy === "upload-action" ? "Uploading…" : "Upload Action Pose"}
                                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadActionReference(f); }} />
                              </label>
                            </div>
                          )}
                          {bgRejection && !busyGen && (
                            <div className="mt-3 rounded-xl border border-amber-700/60 bg-amber-950/20 p-3 text-left">
                              <div className="flex items-center gap-2 text-sm font-bold text-amber-200"><AlertCircle className="h-4 w-4" />{bgRejection.cleanupAttempted ? "Background could not be corrected safely" : "Generated image had a non-studio background"}</div>
                              <p className="mt-1 text-[12px] text-amber-100/90">{bgRejection.cleanupAttempted ? "Automatic cleanup could not safely isolate the character. No automatic retry was made — you choose whether to spend another generation credit." : "No automatic retry was made — you choose whether to spend another generation credit."}</p>
                              <div className="mt-2 grid grid-cols-1 gap-0.5 text-[11px] text-slate-300 sm:grid-cols-2">
                                {bgRejection.offPercent != null && <div>Measured edge off-background: <b className="text-amber-200">{bgRejection.offPercent}%</b></div>}
                                {bgRejection.thresholdPercent != null && <div>Allowed maximum: <b className="text-emerald-300">{bgRejection.thresholdPercent}%</b></div>}
                                <div className="sm:col-span-2">{bgRejection.creditUsed ? "A generation credit was used for this attempt." : "No generation credit was used."}</div>
                                <div className="sm:col-span-2 text-slate-500">The rejected image was not saved as a candidate and is not usable — a clean pure-white studio background is required.</div>
                              </div>
                              <div className="mt-2.5 flex flex-wrap gap-2">
                                <button type="button" onClick={() => generateMasterArtwork("action_pose")} disabled={busyGen || selected.locked} className="rounded-lg px-4 py-2 text-xs font-bold text-black transition enabled:hover:brightness-110 disabled:opacity-40" style={{ background: gold }}>Generate Again — uses another credit</button>
                                <label className={`flex cursor-pointer items-center gap-2 rounded-lg border border-slate-600 px-4 py-2 text-xs font-bold text-slate-100 hover:border-amber-500 ${busy ? "pointer-events-none opacity-40" : ""}`}>
                                  <Upload className="h-3.5 w-3.5" />{busy === "upload-action" ? "Uploading…" : "Manual Upload Action Pose"}
                                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadActionReference(f); }} />
                                </label>
                                {bgRejection.quarantineRef && (
                                  <a href={`/api/admin/vault-quest/quarantine/${bgRejection.quarantineRef}/image`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 hover:border-slate-500">View Rejected Source</a>
                                )}
                              </div>
                            </div>
                          )}
                          {(selected.locked || referenceGenerationHardTitle("action_pose")) && (
                            <p className="mt-2 text-center text-[11px] text-amber-300">
                              {selected.locked ? "Generation is locked for this character. Uploading a finished Action Pose is still available with confirmation." : referenceGenerationHardTitle("action_pose")}
                            </p>
                          )}
                          <p className="mt-2 text-center text-[11px] text-slate-500">Always built from your approved Master — face, colours, markings, ears, tail, accessories &amp; shape stay the same. Only pose, expression, camera angle and movement change.</p>
                        </>
                      )}
                      {/* Candidate review renders in BOTH branches (see Master note above):
                          Replace Action generates a paid candidate that must stay reviewable. */}
                      {masterOk && actionCands.length > 0 && (
                            <div className="mt-3 space-y-2">
                              <div className="text-[11px] font-semibold text-slate-400">{actionOk ? "Replacement poses — approving one replaces the current Action Pose:" : "Compare each pose to your approved Master:"}</div>
                              {actionCands.map((c) => {
                                const band = scoreBand(c.identityScore);
                                const traits = traitsFromBreakdown(c.identityBreakdown);
                                const pose = poseDiversityBand(c.identityBreakdown?.poseDiversity);
                                const novelty = actionNoveltyBand(c.identityBreakdown?.actionNovelty);
                                const poseFailed = pose.state === "fail";
                                const noveltyFailed = novelty.state === "fail";
                                const identityBlocked = !identityFullyPassing(c.identityScore, c.identityBreakdown);
                                const blocked = poseFailed || noveltyFailed || identityBlocked;
                                const catLabel = findActionCategory(c.identityBreakdown?.actionCategory)?.label;
                                // When replacing, the "before" is the EXISTING approved Action (what
                                // this must differ from). For a first Action there's nothing to
                                // replace, so keep the Master as the comparison anchor.
                                return (
                                  <div key={c.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                                    <div className="flex items-start gap-2">
                                      {actionOk ? (
                                        <div className="text-center"><VqStoredImage src={`/api/admin/vault-quest/characters/${cid}/pack/action_pose?v=${artNonce}`} alt="existing approved action reference" idLabel={selected.characterId} kind="reference" onClick={() => setZoomId("action")} className="h-24 w-24 cursor-zoom-in rounded bg-slate-950 object-contain" /><div className="mt-0.5 text-[9px] uppercase text-slate-600">Existing Action</div></div>
                                      ) : (
                                        <div className="text-center"><VqStoredImage src={`/api/admin/vault-quest/characters/${cid}/pack/master_portrait?v=${artNonce}`} alt="approved master reference" idLabel={selected.characterId} kind="reference" onClick={() => setZoomId("master")} className="h-24 w-24 cursor-zoom-in rounded bg-slate-950 object-contain" /><div className="mt-0.5 text-[9px] uppercase text-slate-600">Approved Master</div></div>
                                      )}
                                      <span className="mt-8 text-slate-600">→</span>
                                      <div className="text-center"><VqStoredImage src={`/api/admin/vault-quest/characters/${cid}/candidate/${c.id}?v=${artNonce}`} alt={`action candidate ${c.id}`} idLabel={c.id} kind="candidate" onClick={() => setZoomId(c.id)} className="h-24 w-24 cursor-zoom-in rounded bg-slate-950 object-contain" /><div className="mt-0.5 text-[9px] uppercase text-slate-600">New Candidate</div></div>
                                      <div className="ml-1 flex-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                          <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-bold ${STATE_CLS[band.state]}`}>Identity {c.identityScore ?? "—"} · {band.label}</div>
                                          {pose.label !== "—" && (
                                            <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-bold ${STATE_CLS[pose.state]}`} title="How different this pose is from the neutral approved Master — independent of identity.">Pose Diff · Master {pose.label}</div>
                                          )}
                                          {novelty.label !== "—" && (
                                            <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-bold ${STATE_CLS[novelty.state]}`} title="How different this pose is from the EXISTING approved Action it replaces — independent of identity.">Pose Diff · Existing Action {novelty.label}</div>
                                          )}
                                          {catLabel && (
                                            <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs font-semibold text-slate-300" title="The action category this candidate was generated for.">Action · {catLabel}</div>
                                          )}
                                        </div>
                                        {poseFailed && <p className="mt-1 text-[10px] text-red-400">Too similar to the Master's pose — cannot be approved. Generate another.</p>}
                                        {noveltyFailed && <p className="mt-1 text-[10px] text-red-400">Too similar to the existing approved Action — cannot be approved. Pick a different action and generate again.</p>}
                                        {identityBlocked && !poseFailed && !noveltyFailed && <p className="mt-1 text-[10px] text-red-400">This candidate changed the approved character identity and cannot be approved.</p>}
                                        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
                                          {[...traits, { label: "Background", score: 100 }].map((t) => {
                                            const mb = t.label === "Background" ? { label: "Pass", state: "pass" as HealthState } : matchBand(t.score);
                                            return <div key={t.label} className="flex items-center justify-between"><span className="text-slate-500">{t.label}</span><span className={mb.state === "pass" ? "text-emerald-400" : mb.state === "review" ? "text-amber-400" : mb.state === "fail" ? "text-red-400" : "text-slate-600"}>{mb.label}</span></div>;
                                          })}
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                          <button type="button" disabled={!!busy || blocked} title={poseFailed ? "Blocked — pose is too similar to the Master Reference" : noveltyFailed ? "Blocked — too similar to the existing approved Action" : identityBlocked ? "Blocked — this candidate changed the approved character identity" : undefined} onClick={() => approveCandidate(c.id)} className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-40">Approve Action Pose</button>
                                          <button type="button" disabled={!!busy} onClick={() => rejectCandidate(c.id)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-400 hover:text-red-400 disabled:opacity-40">Reject</button>
                                          <button type="button" disabled={busy === `del-${c.id}`} onClick={() => deleteCandidate(c.id)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-400 hover:text-red-400 disabled:opacity-40">{busy === `del-${c.id}` ? "…" : "Delete"}</button>
                                          <button type="button" onClick={() => setZoomId(c.id)} className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-400 hover:text-slate-200">Zoom</button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                              <button type="button" onClick={() => generateMasterArtwork("action_pose")} disabled={busyGen} title={referenceGenerationHardTitle("action_pose")} className="w-full rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-amber-500 disabled:opacity-40">{busyGen ? (genStageLabel ?? genPhaseLabel ?? "Generating…") : "Generate Another Matching Pose"}</button>
                            </div>
                          )}
                    </div>

                    {/* Reference Pack progress */}
                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-bold text-slate-200">Reference Pack</span>
                        <span className="text-xs font-semibold" style={{ color: packPct === 100 ? "#6ee7b7" : gold }}>{packPct === 100 ? "Complete ✅" : `${packPct}%`}</span>
                      </div>
                      <div className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full transition-all" style={{ width: `${packPct}%`, background: packPct === 100 ? "#34d399" : gold }} /></div>
                      <div className="flex gap-4 text-xs">
                        <span className={masterOk ? "text-emerald-300" : "text-slate-500"}>{masterOk ? "✅" : "⬜"} Master Reference</span>
                        <span className={actionOk ? "text-emerald-300" : "text-slate-500"}>{actionOk ? "✅" : "⬜"} Action Pose</span>
                      </div>
                    </div>

                    {/* Lock explanation + Continue */}
                    {!selected.locked && (
                      <div data-vq-step="lock" className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                        {requiredComplete(selected) ? (
                          <button type="button" onClick={toggleLock} disabled={busy === "lock"} className="flex w-full items-center justify-center gap-2 rounded-xl px-6 py-4 text-base font-bold text-black transition enabled:hover:brightness-110 disabled:opacity-40" style={{ background: gold }}>
                            {busy === "lock" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Lock className="h-5 w-5" />}Lock Character
                          </button>
                        ) : (
                          <>
                            <div className="mb-2 text-sm font-semibold text-slate-300">Before you can lock this character, you still need:</div>
                            <div className="space-y-1 text-sm">
                              {!descOk && <div className="flex items-center gap-2 text-slate-400"><span className="h-4 w-4 rounded-sm border-2 border-slate-600" />Approve the Description</div>}
                              {descOk && !masterOk && <div className="flex items-center gap-2 text-slate-400"><span className="h-4 w-4 rounded-sm border-2 border-slate-600" />Approve a Master Reference</div>}
                              {masterOk && !actionOk && <div className="flex items-center gap-2 text-slate-400"><span className="h-4 w-4 rounded-sm border-2 border-slate-600" />Approve an Action Pose</div>}
                            </div>
                            <div className="mt-3 text-[11px] text-slate-500">Continue below — the next step is <b style={{ color: gold }}>{next.do}</b>.</div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Stage evolution review — review-only, never regenerates */}
                    {(() => {
                      const fam = characters.filter((c) => c.familyId === selected.familyId).sort((a, b) => a.stageNumber - b.stageNumber);
                      if (fam.length < 2) return null;
                      const flags: string[] = [];
                      for (let i = 1; i < fam.length; i++) {
                        const a = fam[i - 1], b = fam[i];
                        if (a.visualDescription && b.visualDescription && a.visualDescription.trim() === b.visualDescription.trim()) flags.push(`Stage ${b.stageNumber} looks identical to Stage ${a.stageNumber} — stages must clearly evolve, not repeat.`);
                      }
                      return (
                        <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                          <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">Family Evolution</div>
                          <div className="flex items-end justify-center gap-2">
                            {fam.map((c, i) => (
                              <div key={c.characterId} className="flex items-end gap-2">
                                {i > 0 && <span className="mb-8 text-slate-600">→</span>}
                                <div className="text-center">
                                  {c.referencePack?.master_portrait?.r2Key
                                    ? <VqStoredImage src={`/api/admin/vault-quest/characters/${encodeURIComponent(c.characterId)}/pack/master_portrait?v=${artNonce}`} alt={`stage ${c.stageNumber} approved master reference`} idLabel={c.characterId} kind="reference" onClick={() => setSelectedId(c.characterId)} className="h-20 w-20 cursor-pointer rounded-lg bg-slate-950 object-contain" style={c.characterId === selected.characterId ? { outline: `2px solid ${gold}` } : undefined} />
                                    : <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-slate-700 text-[9px] text-slate-600">no master</div>}
                                  <div className="mt-0.5 text-[9px] uppercase text-slate-600">Stage {c.stageNumber}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                          {flags.length > 0
                            ? <div className="mt-2 space-y-0.5">{flags.map((f) => <div key={f} className="text-[11px] text-amber-400">⚠ {f}</div>)}</div>
                            : <p className="mt-2 text-center text-[11px] text-slate-600">Review the three stages — each should clearly grow from the last, keeping the same colours &amp; markings. Click a stage to open it.</p>}
                        </div>
                      );
                    })()}

                    {/* Simple zoom overlay (fit to screen) */}
                    {zoomId != null && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setZoomId(null)}>
                        <VqStoredImage src={zoomId === "master" ? `/api/admin/vault-quest/characters/${cid}/pack/master_portrait?v=${artNonce}` : zoomId === "action" ? `/api/admin/vault-quest/characters/${cid}/pack/action_pose?v=${artNonce}` : `/api/admin/vault-quest/characters/${cid}/candidate/${zoomId}?v=${artNonce}`} alt="zoomed stored Vault Quest artwork" idLabel={zoomId} kind={zoomId === "master" || zoomId === "action" ? "reference" : "candidate"} className="max-h-full max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
                        <button type="button" onClick={() => setZoomId(null)} className="absolute right-6 top-6 rounded-lg bg-slate-800 px-3 py-1.5 text-sm text-slate-200">Close</button>
                      </div>
                    )}

                    {/* Archive / History overlay — every approved image ever, oldest work never lost */}
                    {historyFor && (
                      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setHistoryFor(null)}>
                        <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-lg border border-slate-700 bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
                          <div className="mb-3 flex items-center justify-between">
                            <span className="text-sm font-semibold text-slate-200">Archive — {REF_TYPES.find((t) => t.value === historyFor)?.label} history</span>
                            <button type="button" onClick={() => setHistoryFor(null)} className="text-xs text-slate-500 hover:text-slate-300">close</button>
                          </div>
                          {revisionHistory.isLoading && <p className="text-xs text-slate-500">Loading history…</p>}
                          {!revisionHistory.isLoading && (revisionHistory.data?.revisions ?? []).length === 0 && (
                            <p className="text-xs text-slate-500">No revision history yet for this slot — it was set before Archive tracking was added, or nothing has been approved yet.</p>
                          )}
                          <div className="space-y-2">
                            {(revisionHistory.data?.revisions ?? []).map((r) => (
                              <div key={r.id} className={`flex items-center gap-3 rounded border p-2 ${r.isActive ? "border-emerald-700 bg-emerald-950/20" : "border-slate-800 bg-slate-950/40"}`}>
                                <VqStoredImage src={`/api/admin/vault-quest/artwork-revisions/${r.id}/image`} alt={`archived reference revision ${r.id}`} idLabel={r.id} kind="revision" className="h-16 w-16 rounded bg-slate-950 object-contain" />
                                <div className="flex-1 text-[11px] text-slate-400">
                                  <div className={r.isActive ? "font-semibold text-emerald-300" : "text-slate-300"}>{r.isActive ? "Active" : "Archived"}{r.width ? ` · ${r.width}×${r.height}` : ""}</div>
                                  <div>{new Date(r.createdAt).toLocaleString()} · {r.createdBy ?? "admin"}</div>
                                  {r.archivedAt && <div className="text-slate-600">archived {new Date(r.archivedAt).toLocaleString()}</div>}
                                </div>
                                {!r.isActive && (
                                  <button type="button" disabled={busy === `restore-${r.id}`} onClick={() => restoreRevisionImage(r.id)} className="rounded bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-50">{busy === `restore-${r.id}` ? "…" : "Restore"}</button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* ═══ 2 · REFERENCES — full editor (Advanced Mode) ═══ */}
              {advanced && (<div className="rounded-md border border-amber-800/40 bg-amber-950/10 p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-amber-300">References</span>
                    <span className={labelCls}>generating <b className="text-amber-300">{refTypeMeta.label}</b></span>
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <AdminButton data-deeplink="generate-reference" variant="gold" size="sm" onClick={() => generateMasterArtwork()} disabled={busy === "gen-art" || descStatus(selected) !== "approved" || referenceGenerationBlocked(refType)} title={referenceGenerationTitle(refType, descStatus(selected) !== "approved" ? "Approve the description first — artwork reads from the approved description only." : undefined)}>
                      {busy === "gen-art" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}Generate {refTypeMeta.label}
                    </AdminButton>
                    <AdminButton variant="ghost" size="sm" onClick={generate3More} disabled={busy === "gen-3more" || descStatus(selected) !== "approved" || referenceGenerationBlocked(refType)} title={referenceGenerationTitle(refType)}>
                      {busy === "gen-3more" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}Generate 3 More
                    </AdminButton>
                    <select
                      value=""
                      disabled={batchRunning || busy === "approve-family" || busy === "lock-family"}
                      onChange={(e) => { const v = e.target.value; e.currentTarget.value = ""; if (v === "required") generateRequiredReferences(); else if (v === "complete") generateCompleteFamilyPack(); else if (v === "approve") approveSelectedFamily(); else if (v === "lock") lockFamily(true); else if (v === "unlock") lockFamily(false); }}
                      className={`${inputCls} w-auto text-xs`}
                    >
                      <option value="">Family Actions…</option>
                      <option value="required">Generate Required References (skip done)</option>
                      <option value="complete">Generate Complete Family Pack (5 × 3)</option>
                      <option value="approve" disabled={packApproved(selected, refType)}>Approve Selected ({refTypeMeta.label})</option>
                      <option value="lock" disabled={!familyAllRequired || familyLockedCount === 3}>Lock Entire Family</option>
                      <option value="unlock" disabled={familyLockedCount === 0}>Unlock Family</option>
                    </select>
                  </div>
                </div>

                {/* Reference Pack checklist — live. Click a row to switch the active type. */}
                <div className="mb-2 rounded border border-slate-800 bg-slate-950/40 p-2">
                  <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide">
                    <span className="text-slate-500">Reference Pack</span>
                    <span className={requiredComplete(selected) ? "text-emerald-400" : "text-amber-400"}>Required {requiredCount(selected)} / {REQUIRED_REF_TYPES.length} Complete</span>
                  </div>
                  <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                    {REF_TYPES.map((t) => {
                      const ok = packApproved(selected, t.value);
                      const req = t.tier === "required";
                      return (
                        <button key={t.value} type="button" onClick={() => setRefType(t.value)} className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] ${refType === t.value ? "bg-slate-800" : "hover:bg-slate-900"}`}>
                          <span>{ok ? "✅" : req ? "❌" : "⬜"}</span>
                          <span className={ok ? "text-emerald-300" : req ? "text-slate-200" : "text-slate-500"}>{t.label}{req ? "" : " (optional)"}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {selected.referencePack?.[refType]?.r2Key && (
                  <div className="mb-2 flex items-center gap-2 rounded border border-emerald-900/60 bg-emerald-950/20 p-1.5">
                    <VqStoredImage src={`/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/pack/${refType}?v=${artNonce}`} alt={`approved ${refTypeMeta.label}`} idLabel={selected.characterId} kind="reference" className="h-14 w-14 rounded bg-slate-950 object-contain" />
                    <span className="text-[11px] text-emerald-300">Approved {refTypeMeta.label} on file — new approvals replace it.</span>
                  </div>
                )}

                {/* ── Image engine: provider · quality · model ──────────────────── */}
                <div className="mb-2 rounded-md border border-slate-800 bg-slate-950/40 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Image engine</span>
                    <button type="button" disabled className="rounded border border-amber-500 bg-amber-500/15 px-2 py-1 text-[11px] text-amber-200" title={higgsProvider?.note ?? "Higgsfield"}>Higgsfield</button>
                    <div className="ml-auto flex gap-1">
                      <button type="button" onClick={() => setImgModel("auto")} className={`rounded px-2 py-1 text-[11px] font-semibold ${imgModel === "auto" ? "border border-amber-500 bg-amber-500/15 text-amber-200" : "border border-slate-700 text-slate-400 hover:border-slate-500"}`}>Auto</button>
                      {(["draft", "standard", "premium"] as const).map((q) => {
                        const m = VQ_QUALITY_MODEL[q];
                        const active = imgModel === m;
                        const label = q === "draft" ? "Draft / Cheap" : q === "standard" ? "Standard" : "Premium";
                        return (
                          <button key={q} type="button" onClick={() => setImgModel(m)} className={`rounded px-2 py-1 text-[11px] font-semibold ${active ? "border border-amber-500 bg-amber-500/15 text-amber-200" : "border border-slate-700 text-slate-400 hover:border-slate-500"}`}>{label}</button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <select value={imgModel} onChange={(e) => setImgModel(e.target.value as VqGenerateWith)} className={`${inputCls} w-auto text-xs`}>
                      <option value="auto">Auto — current safe default</option>
                      {VQ_IMAGE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label} — ~{m.creditsPerImage} cr/image{m.refCapable ? "" : " · no identity lock"}</option>)}
                    </select>
                    <span className="text-[10px] text-slate-500">~{creditsPerImage} credit{creditsPerImage === 1 ? "" : "s"}/image · Master Reference = {imagesPerItem} image{imagesPerItem === 1 ? "" : "s"}/character{(imgModel === "auto" || imgModel === "z_image") ? " · Auto/cheap model auto-upgrades to Nano Banana when identity references are needed" : ""}</span>
                  </div>
                  {requestedImgModel && isPremiumModel(requestedImgModel) && (
                    <div className="mt-2 rounded border border-amber-700/60 bg-amber-950/20 p-2">
                      <label className="flex items-center gap-2 text-[11px] font-semibold text-amber-200">
                        <input type="checkbox" className="h-3.5 w-3.5 accent-amber-500" checked={premiumConfirmed} onChange={(e) => setPremiumConfirmed(e.target.checked)} />
                        I confirm this Premium Final generation may spend the higher-credit model.
                      </label>
                      <input value={premiumReason} onChange={(e) => setPremiumReason(e.target.value)} placeholder="Reason for Premium Final" className={`${inputCls} mt-2 text-xs`} />
                    </div>
                  )}
                </div>

                {/* ── Safe batch generation ─────────────────────────────────────── */}
                <div className="mb-3 rounded-md border border-indigo-800/40 bg-indigo-950/10 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-300">Batch · {refTypeMeta.label} · ~{creditsPerImage} cr/image{imagesPerItem > 1 ? ` × ${imagesPerItem}/character` : ""}</span>
                    <span className="text-[10px] text-slate-500">{selectedChars.size} ticked · {characters.length} characters</span>
                  </div>
                  {(() => {
                    // Buttons are DISABLED (with a reason) instead of throwing errors.
                    const descOk = descStatus(selected) === "approved";
                    const actionNeedsMaster = refType === "action_pose" && !packApproved(selected, "master_portrait");
                    const typeBlocked = referenceGenerationBlocked(refType);
                    const genBlocked = batchRunning || !descOk || actionNeedsMaster || typeBlocked;
                    const blockTitle = referenceGenerationTitle(refType, !descOk ? "Approve the Character Description first." : actionNeedsMaster ? "Approve a Master Reference first." : undefined);
                    const btn = "rounded border border-indigo-600 px-2 py-1 text-[11px] text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-40";
                    return (
                      <div className="flex flex-wrap gap-1.5">
                        <button type="button" disabled={genBlocked || selectedChars.size === 0} title={blockTitle} onClick={() => openBatch(characters.filter((c) => selectedChars.has(c.characterId)), `Selected (${selectedChars.size})`)} className={btn}>{genBlocked ? "🔒 " : ""}Generate Selected</button>
                        <button type="button" disabled={batchRunning || actionNeedsMaster || typeBlocked} title={referenceGenerationTitle(refType, actionNeedsMaster ? "Approve a Master Reference first." : `Only characters missing an approved ${refTypeMeta.label}`)} onClick={() => openBatch(characters.filter((c) => !c.referencePack?.[refType]?.r2Key && c.descriptionStatus === "approved" && !c.locked), `Missing ${refTypeMeta.label}s`)} className={btn}>Generate Missing {refTypeMeta.label}s</button>
                        <button type="button" disabled={genBlocked || familyStages.length === 0} title={blockTitle} onClick={() => openBatch(familyStages, `Family ${selected.familyId}`)} className={btn}>{genBlocked ? "🔒 " : ""}Generate Current Family</button>
                        <button type="button" disabled={genBlocked} title={blockTitle} onClick={() => openBatch([selected], `Current stage — ${selected.characterName}`)} className={btn}>{genBlocked ? "🔒 " : ""}Generate Current Stage Only</button>
                        <button type="button" disabled={batchRunning} title="Anthropic text only — 0 Higgsfield credits. Drafts for every character missing an approved description." onClick={generateMissingDescriptions} className="rounded border border-sky-600 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-500/15 disabled:opacity-40">Generate Missing Descriptions (0 cr)</button>
                        <button type="button" disabled title="Coming soon — staged auto pipeline: descriptions → approve → masters → approve → action poses → approve → lock → cards → QA → export. Every stage pauses for founder approval." className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-600">Auto Mode (soon)</button>
                        {selectedChars.size > 0 && !batchRunning && <button type="button" onClick={() => setSelectedChars(new Set())} className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-slate-500">Clear ticks</button>}
                      </div>
                    );
                  })()}

                  {/* Credit estimate + confirmation */}
                  {estimate && (
                    <div className="mt-2 rounded border border-amber-700/50 bg-amber-950/20 p-2.5">
                      <p className="text-xs font-semibold text-amber-200">Credit estimate — {estimate.label}</p>
                      <p className="mt-1 text-[11px] text-slate-300">Provider <b>Higgsfield</b> · final expected model <b>{VQ_IMAGE_MODELS.find((m) => m.value === estimate.model)?.label ?? estimate.model}</b> · {refTypeMeta.label}</p>
                      <p className="mt-0.5 text-[11px] text-slate-300">{estimate.items.length} separate provider job{estimate.items.length === 1 ? "" : "s"} · each job requests one image · <b>{estimate.images} image{estimate.images === 1 ? "" : "s"}</b> · estimated <b>~{vqCreditsPerImage(estimate.model)} credit{vqCreditsPerImage(estimate.model) === 1 ? "" : "s"} per image</b> · maximum <b>~{estimate.credits} credits</b></p>
                      <p className="mt-0.5 text-[11px] text-slate-300">Automatic paid retry: <b className={autoPaidRetryEnabled ? "text-amber-300" : "text-emerald-300"}>{autoPaidRetryEnabled ? "On" : "Off"}</b>{autoPaidRetryEnabled ? " — warning: may spend credits on a second provider call." : ""}</p>
                      <p className="mt-0.5 text-[11px] text-slate-300">Premium mode: <b className={isPremiumModel(estimate.model) ? "text-amber-300" : "text-slate-200"}>{isPremiumModel(estimate.model) ? "On" : "Off"}</b>{isPremiumModel(estimate.model) ? " — Premium Final selected by the founder; the server still requires explicit premium confirmation and reason." : ""}</p>
                      {isPremiumModel(estimate.model) && estimate.premiumReason && <p className="mt-0.5 text-[11px] text-amber-100">Premium reason: <span className="text-slate-200">{estimate.premiumReason}</span></p>}
                      <p className="mt-0.5 text-[10px] text-slate-500">Client totals are informational. The server independently resolves model, credit reservation and provider request count.</p>
                      <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" className="h-3 w-3 accent-amber-500" checked={stopOnFail} onChange={(e) => setStopOnFail(e.target.checked)} />Stop on first failure (otherwise continue)</label>
                      {estimate.needTyped && (
                        <div className="mt-1.5">
                          <p className="text-[11px] text-red-300">Over {BATCH_IMAGE_LIMIT} images — type to confirm: <span className="font-mono text-red-200">{TYPED_PHRASE}</span></p>
                          <input value={typedConfirm} onChange={(e) => setTypedConfirm(e.target.value)} placeholder={TYPED_PHRASE} className={`${inputCls} mt-1 text-xs`} />
                        </div>
                      )}
                      <div className="mt-2 flex gap-1.5">
                        <button type="button" onClick={runBatch} disabled={estimate.needTyped && typedConfirm.trim() !== TYPED_PHRASE} className="rounded bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-40">{batchConfirmationButtonText(estimate.images, estimate.credits)}</button>
                        <button type="button" onClick={() => { setEstimate(null); setTypedConfirm(""); resetGenerateWith(); }} className="rounded border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 hover:border-slate-400">Cancel</button>
                      </div>
                    </div>
                  )}

                  {/* Queue manager */}
                  {batch && (() => {
                    const n = (s: BatchStatus) => batch.filter((b) => b.status === s).length;
                    const qbtn = "rounded border px-1.5 py-0.5 text-[10px] font-semibold";
                    return (
                      <div className="mt-2 rounded border border-slate-800 bg-slate-950/50 p-2">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Queue {batchRunning ? (queuePaused ? "· PAUSED" : "· RUNNING") : "· FINISHED"}</span>
                          {batchRunning && !queuePaused && <button type="button" onClick={pauseQueue} className={`${qbtn} border-amber-600 text-amber-300 hover:bg-amber-900/30`}>⏸ Pause Queue</button>}
                          {batchRunning && queuePaused && <button type="button" onClick={resumeQueue} className={`${qbtn} border-emerald-600 text-emerald-300 hover:bg-emerald-900/30`}>▶ Resume Queue</button>}
                          {batchRunning && <button type="button" onClick={skipCurrent} className={`${qbtn} border-slate-600 text-slate-300 hover:border-slate-400`}>⤼ Skip Current</button>}
                          {batchRunning && <button type="button" onClick={stopBatch} className={`${qbtn} border-red-600 bg-red-950/40 text-red-300 hover:bg-red-900/40`}>■ Stop Queue</button>}
                          {!batchRunning && n("failed") > 0 && <button type="button" onClick={() => retryBatch(["failed"])} className={`${qbtn} border-red-600 text-red-300 hover:bg-red-900/30`}>↻ Retry Failed ({n("failed")})</button>}
                          {!batchRunning && n("rejected") > 0 && <button type="button" onClick={() => retryBatch(["rejected"])} className={`${qbtn} border-amber-600 text-amber-300 hover:bg-amber-900/30`}>↻ Retry Rejected ({n("rejected")})</button>}
                        </div>
                        <div className="flex flex-wrap gap-2 text-[10px] font-semibold">
                          <span className="text-slate-400">Queued {n("queued")}</span>
                          <span className="text-sky-300">Running {n("generating")}</span>
                          <span className="text-amber-300">Paused {n("paused")}</span>
                          <span className="text-emerald-300">Finished {n("succeeded")}</span>
                          <span className="text-red-300">Failed {n("failed")}</span>
                          <span className="text-amber-300">Rejected {n("rejected")}</span>
                          <span className="text-slate-500">Skipped {n("skipped")}</span>
                          {!batchRunning && <button type="button" onClick={() => setBatch(null)} className="ml-auto text-slate-500 hover:text-slate-300">clear</button>}
                        </div>
                        <div className="mt-1.5 max-h-28 space-y-0.5 overflow-auto">
                          {batch.map((b) => (
                            // A character can appear once per reference type (e.g. "Generate Required
                            // References" queues master + action) — characterId alone duplicated keys.
                            <div key={`${b.characterId}-${b.referenceType}-${b.kind ?? "artwork"}`} className="flex items-center justify-between gap-2 text-[10px]">
                              <span className="text-slate-400">S{b.stage} · {b.name} · {REF_TYPES.find((t) => t.value === b.referenceType)?.label ?? b.referenceType}</span>
                              <span className={b.status === "succeeded" ? "text-emerald-400" : b.status === "generating" ? "text-sky-400" : b.status === "failed" ? "text-red-400" : b.status === "rejected" ? "text-amber-400" : "text-slate-500"}>{b.status}{b.note ? ` (${b.note})` : ""}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {candQuery.isLoading ? (
                  <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading candidates…</p>
                ) : candidates.length === 0 ? (
                  <p className="text-xs text-slate-500">No candidates yet — generate master artwork to create this character's first reference. Standalone character art only; nothing is approved automatically.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                    {candidates.map((c) => {
                      const rejected = c.status === "rejected";
                      const approved = c.status === "approved";
                      const fav = favourites.has(c.id);
                      const inCompare = compareSel.includes(c.id);
                      const candUrl = `/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/candidate/${c.id}?v=${artNonce}`;
                      const mini = "rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-sky-500";
                      return (
                        <div key={c.id} className={`rounded border p-1 bg-slate-900 ${approved ? "border-emerald-500 ring-1 ring-emerald-500/50" : inCompare ? "border-sky-500 ring-1 ring-sky-500/50" : "border-slate-800"} ${rejected ? "opacity-40" : ""}`}>
                          <VqStoredImage src={candUrl} alt={`${refTypeMeta.label} candidate ${c.id}`} idLabel={c.id} kind="candidate" className="aspect-square w-full cursor-zoom-in rounded bg-slate-950 object-contain" onClick={() => setZoomId(c.id)} />
                          <div className="mt-1 flex items-center justify-between gap-1">
                            <span className="flex items-center gap-1">
                              <button type="button" onClick={() => toggleFavourite(c.id)} title="Favourite" className={`text-[12px] ${fav ? "text-amber-400" : "text-slate-600 hover:text-amber-400"}`}>{fav ? "★" : "☆"}</button>
                              {typeof c.identityScore === "number" && (
                                <span className={`rounded px-1 text-[9px] font-semibold ${c.identityScore >= 70 ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`} title="Character Identity Score vs approved references">ID {c.identityScore}</span>
                              )}
                            </span>
                            <span className={`text-[10px] uppercase ${approved ? "text-emerald-400" : rejected ? "text-red-400" : "text-slate-500"}`}>{c.status}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {!rejected && <button type="button" onClick={() => approveCandidate(c.id)} disabled={busy === `approve-${c.id}`} className="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-50">{busy === `approve-${c.id}` ? "…" : "Approve"}</button>}
                            {!rejected && <button type="button" onClick={() => rejectCandidate(c.id)} disabled={busy === `reject-${c.id}`} className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-red-500 hover:text-red-300 disabled:opacity-50">{busy === `reject-${c.id}` ? "…" : "Reject"}</button>}
                            <button type="button" title="Zoom" onClick={() => setZoomId(c.id)} className={mini}>Zoom</button>
                            <button type="button" title="Compare (pick two)" onClick={() => setCompareSel((p) => { const n = p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p.slice(-1), c.id]; if (n.length === 2) setShowCompare(true); return n; })} className={`${mini} ${inCompare ? "border-sky-500 text-sky-300" : ""}`}>Compare</button>
                            <button type="button" title="Delete (hides it — file kept)" onClick={() => deleteCandidate(c.id)} disabled={busy === `del-${c.id}`} className={`${mini} hover:border-red-500 hover:text-red-300`}>{busy === `del-${c.id}` ? "…" : "Delete"}</button>
                            <button type="button" title="Show the exact prompt used" onClick={() => setPromptFor(c)} className={mini}>Prompt</button>
                            <button type="button" title={referenceGenerationTitle(refType, `Generate another ${refTypeMeta.label} from the same description`)} onClick={() => generateMasterArtwork()} disabled={busy === "gen-art" || descStatus(selected) !== "approved" || referenceGenerationBlocked(refType)} className={mini}>Regen Similar</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Zoom / Compare / Prompt overlays */}
                {zoomId != null && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setZoomId(null)}>
                    <VqStoredImage src={`/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/candidate/${zoomId}?v=${artNonce}`} alt={`zoomed candidate ${zoomId}`} idLabel={zoomId} kind="candidate" className="max-h-full max-w-full rounded object-contain" />
                  </div>
                )}
                {showCompare && compareSel.length === 2 && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => { setShowCompare(false); setCompareSel([]); }}>
                    <div className="grid max-h-full w-full max-w-5xl grid-cols-2 gap-2">
                      {compareSel.map((id) => (
                        <VqStoredImage key={id} src={`/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/candidate/${id}?v=${artNonce}`} alt={`compare candidate ${id}`} idLabel={id} kind="candidate" className="max-h-[80vh] w-full rounded bg-slate-950 object-contain" />
                      ))}
                    </div>
                  </div>
                )}
                {promptFor && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setPromptFor(null)}>
                    <div className="max-h-[80vh] max-w-2xl overflow-auto rounded-lg border border-slate-700 bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-300">Prompt — candidate #{promptFor.id} ({promptFor.referenceType})</span>
                        <button type="button" onClick={() => setPromptFor(null)} className="text-xs text-slate-500 hover:text-slate-300">close</button>
                      </div>
                      <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">{promptFor.prompt ?? "(no prompt recorded)"}</p>
                    </div>
                  </div>
                )}
              </div>)}

              {advanced && (<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className={labelCls}>Reference artwork</span>
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:border-amber-500">
                      {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}Upload
                      <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; /* allow re-selecting the same file after a failure */ if (f) void uploadReference(f); }} />
                    </label>
                  </div>
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded bg-slate-900">
                    {selected.referenceArtworkR2Key ? <VqStoredImage src={`/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/art/reference?v=${artNonce}`} alt="uploaded reference artwork" idLabel={selected.characterId} kind="artwork" className="h-full w-full object-contain" /> : <span className="text-xs text-slate-500">no reference uploaded</span>}
                  </div>
                </div>

                <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className={labelCls}>Approved artwork</span>
                    <AdminButton variant="ghost" size="sm" onClick={approveArtwork} disabled={busy === "approve"}>{busy === "approve" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}Approve reference</AdminButton>
                  </div>
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded bg-slate-900">
                    {selected.approvedArtworkR2Key ? <VqStoredImage src={`/api/admin/vault-quest/characters/${encodeURIComponent(selected.characterId)}/art/approved?v=${artNonce}`} alt="approved artwork" idLabel={selected.characterId} kind="artwork" className="h-full w-full object-contain" /> : <span className="text-xs text-slate-500">not approved</span>}
                  </div>
                </div>
              </div>)}

            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ---- transition button labels ----
const TRANSITION_BTN: { to: VqStatus; label: string; icon: typeof CheckCircle2 }[] = [
  { to: "ready_for_review", label: "Mark Ready", icon: ShieldCheck },
  { to: "approved", label: "Approve", icon: CheckCircle2 },
  { to: "export_ready", label: "Mark Export Ready", icon: PackageCheck },
  { to: "printed_proxy", label: "Printed Proxy", icon: PackageCheck },
  { to: "rejected", label: "Reject", icon: XCircle },
  { to: "draft", label: "Return to Draft", icon: RotateCcw },
  { to: "archived", label: "Archive", icon: Archive },
];

export default function AdminVaultQuest() {
  const { toast } = useToast();
  const [view, setView] = useState<"board" | "editor" | "bible">("board");
  const [form, setForm] = useState<CardForm>(BLANK);
  const [preview, setPreview] = useState<string | null>(null);
  const [qa, setQa] = useState<QaIssue[]>([]);
  const [artNonce, setArtNonce] = useState(0);
  const [candidatePreviews, setCandidatePreviews] = useState<{ main?: string; prev?: string }>({});
  const [fullBusy, setFullBusy] = useState<string | null>(null);
  // Synchronous re-entrancy latch: `fullBusy` is state, so two clicks in one frame
  // both read it as null and both fire (double text + double paid artwork). Mirrors
  // the artworkInFlight/genInFlight latches used by every other paid generate action.
  const fullInFlight = useRef(false);
  const [rendering, setRendering] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [baseRef, setBaseRef] = useState<BaseRef>(null);
  const [loadedStatus, setLoadedStatus] = useState<VqStatus | null>(null);
  const [evalu, setEvalu] = useState<Evaluation | null>(null);
  const [dirty, setDirty] = useState(false);
  const [exportJob, setExportJob] = useState<{ label: string; done: number; total: number } | null>(null);
  const [gen, setGen] = useState<GenerateModal | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [filters, setFilters] = useState({ q: "", status: "", cardType: "", element: "", rarity: "", need: "", family: "" });
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // ── Deep-link entry from the Production Studio (refresh-safe query params):
  //    ?bible=<characterId>&step=<taskKind>&ref=<referenceType> → exact Bible target
  //    ?card=<cardId>&step=generate_cards                       → exact card editor
  const [bibleDeepLink, setBibleDeepLink] = useState<BibleDeepLink | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const bible = p.get("bible");
    const card = p.get("card");
    if (bible) {
      setBibleDeepLink({ characterId: bible, step: p.get("step"), refType: p.get("ref") });
      setView("bible");
    } else if (card) {
      void loadCard(card); // loadCard sets view("editor") on success
    }
  }, []);

  const isSupport = SUPPORT.has(form.cardType);
  const set = <K extends keyof CardForm>(k: K, v: string) => { setForm((f) => ({ ...f, [k]: v })); setDirty(true); };

  const dash = useQuery<Dashboard>({ queryKey: ["/api/admin/vault-quest/dashboard"], retry: false });
  const cfg = useQuery<{ elements: Record<string, unknown>; needsApproval: string[] }>({ queryKey: ["/api/admin/vault-quest/config"], retry: false });
  const fams = useQuery<{ families: { familyId: string; name: string | null; element?: string; stage1Name?: string | null; stage2Name?: string | null; stage3Name?: string | null }[] }>({ queryKey: ["/api/admin/vault-quest/families"], retry: false });
  const opsStatus = useQuery<{ features: { feature: string; enabled: boolean }[]; provider?: ProviderConnection } | null>({ queryKey: ["/api/admin/vault-quest/ops/status"], retry: false });
  const editorFounderFlags = resolveFounderFeatureMap(opsStatus.data?.features, !opsStatus.isError && !!opsStatus.data);
  const lastAutoPrev = useRef<string>("");

  // ---- dropdown option lists (Phase 1) ----
  const needsApprovalSet = new Set(cfg.data?.needsApproval ?? []);
  const elementOpts: Opt[] = (cfg.data ? Object.keys(cfg.data.elements) : ELEMENTS).map((e) => ({ value: e, label: e, hint: needsApprovalSet.has(e) ? "NEEDS APPROVAL" : undefined }));
  const familyOpts: Opt[] = (fams.data?.families ?? []).map((f) => ({ value: f.familyId, label: `${f.name ?? f.familyId} · ${f.familyId}` }));
  const baseCardOpts: Opt[] = (dash.data?.cards ?? []).filter((c) => !c.baseCardId).map((c) => ({ value: c.cardId, label: `${c.cardId} · ${c.name}` }));
  const selFam = fams.data?.families.find((f) => f.familyId === form.familyId);
  const autoPrev = !selFam ? "" : form.stageNumber === "2" ? (selFam.stage1Name ?? "") : form.stageNumber === "3" ? (selFam.stage2Name ?? "") : "";
  const evolveWarn = !!form.previousStage && form.previousStage !== autoPrev;
  const isVariantTier = !!form.variantTier && form.variantTier !== "STANDARD";
  const tax = useQuery<{ keywords: string[]; effects: string[]; providers: ProviderStat[] }>({ queryKey: ["/api/admin/vault-quest/taxonomy"], retry: false });
  const providers = tax.data?.providers ?? [];
  const imageProviders = providers.filter((p) => p.id !== "anthropic");
  const textConnected = providers.find((p) => p.id === "anthropic")?.connected ?? false;
  const aiContext: Record<string, unknown> = {
    cardId: form.cardId || undefined, name: form.name, cardType: form.cardType, element: form.element, stageNumber: form.stageNumber,
    familyId: form.familyId, familyName: form.familyName, previousStage: form.previousStage, rarity: form.rarity, health: form.health, guard: form.guard, shift: form.shift,
    attack1Name: form.attack1Name, attack1Damage: form.attack1Damage, vulnerability: form.vulnerability,
    variantTier: form.variantTier, baseCardId: form.baseCardId,
  };
  // Full Card is gated on the CANONICAL (locked) character — disabled with a reason,
  // never a confusing error. Support cards (no Bible character) are never gated.
  const editorChars = useQuery<{ characters: VqCharacterRow[] } | null>({ queryKey: ["/api/admin/vault-quest/characters"], retry: false, enabled: form.cardType === "Creature" });
  const editorChar = form.cardType === "Creature"
    ? (editorChars.data?.characters ?? []).find((c) => c.cardId === (form.baseCardId || form.cardId))
    : undefined;
  const cardArtworkBlockReason = generationBlockedReasonWithProvider(editorFounderFlags, "gen_card_artwork", opsStatus.data?.provider, !opsStatus.isError && !!opsStatus.data);
  const fullCardBlockReason = editorChar && !editorChar.locked ? "Lock the canonical character before generating cards." : cardArtworkBlockReason;

  // Apply an AI suggestion's fields to the form (never auto — only on click), then run QA.
  function applyAi(fields: AiField): boolean {
    const map: Record<string, keyof CardForm> = {
      name: "name", health: "health", guard: "guard", shift: "shift",
      attack1Name: "attack1Name", attack1Cost: "attack1Cost", attack1Damage: "attack1Damage", attack1Effect: "attack1Effect",
      attack2Name: "attack2Name", attack2Cost: "attack2Cost", attack2Damage: "attack2Damage", attack2Effect: "attack2Effect",
      vulnerability: "vulnerability", flavour: "notes",
    };
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v == null || v === "") continue;
      if (map[k]) updates[map[k]] = String(v);
      else if (k === "stage1" || k === "stage2" || k === "stage3") {
        const want = form.stageNumber === "2" ? "stage2" : form.stageNumber === "3" ? "stage3" : "stage1";
        if (k === want) updates.name = String(v);
      }
    }
    if (Object.keys(updates).length === 0) return false; // e.g. artwork prompt — Copy only
    setForm((p) => ({ ...p, ...updates }));
    setDirty(true);
    // QA runs automatically (Phase 8): the debounced live-preview effect re-fires on
    // this form change with the applied values — no explicit (stale-closure) call needed.
    return true;
  }

  // Add-new dropdown handlers (Element / Family) — create server-side, then select.
  async function addElement(name: string) {
    try {
      await apiRequest("POST", "/api/admin/vault-quest/elements", { name });
      await cfg.refetch();
      set("element", name);
      toast({ title: `Element "${name}" added`, description: "Marked NEEDS APPROVAL (placeholder palette)" });
    } catch (e) { handleAuthError(e, "Add element failed"); }
  }
  const [newFamily, setNewFamily] = useState<{ name: string; element: string; s1: string; s2: string; s3: string } | null>(null);
  async function createFamily() {
    if (!newFamily || !newFamily.name.trim() || !newFamily.element) return;
    try {
      const r = await apiRequest("POST", "/api/admin/vault-quest/families", { name: newFamily.name.trim(), element: newFamily.element, stage1Name: newFamily.s1, stage2Name: newFamily.s2, stage3Name: newFamily.s3 });
      const d = (await r.json()) as { familyId: string; name: string };
      await fams.refetch();
      setForm((p) => ({ ...p, familyId: d.familyId, familyName: d.name }));
      setDirty(true);
      setNewFamily(null);
      toast({ title: `Family "${d.name}" created`, description: d.familyId });
    } catch (e) { handleAuthError(e, "Add family failed"); }
  }

  // Evolves-From auto-populate from the selected family + stage (Stage 1 = none,
  // Stage 2 = Stage 1 name, Stage 3 = Stage 2 name). Manual edits are preserved.
  useEffect(() => {
    const fam = fams.data?.families.find((f) => f.familyId === form.familyId);
    const auto = !fam ? "" : form.stageNumber === "2" ? (fam.stage1Name ?? "") : form.stageNumber === "3" ? (fam.stage2Name ?? "") : "";
    setForm((prev) => {
      if (prev.previousStage === "" || prev.previousStage === lastAutoPrev.current) {
        lastAutoPrev.current = auto;
        return prev.previousStage === auto ? prev : { ...prev, previousStage: auto };
      }
      return prev;
    });
  }, [form.familyId, form.stageNumber, fams.data]);

  const runPreview = useCallback(async () => {
    if (!form.name || !form.cardId) { setPreview(null); setQa([]); return; }
    setRendering(true);
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/cards/preview", toPayload(form));
      const data = await res.json();
      setPreview(data.preview);
      setQa(data.qa?.issues ?? []);
    } catch (e) {
      setQa([{ level: "reject", field: "preview", message: e instanceof Error ? e.message : "preview failed" }]);
      setPreview(null);
    } finally { setRendering(false); }
  }, [form]);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(runPreview, 400);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [runPreview]);

  // warn on navigating away with unsaved edits
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  async function uploadArt(file: File, slot: "main" | "prev") {
    if (!form.cardId) { toast({ title: "Set a Card ID first", variant: "destructive" }); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await adminFetch(`/api/admin/vault-quest/cards/${encodeURIComponent(form.cardId)}/art?slot=${slot}`, { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) {
        const err = new Error((await res.json().catch(() => ({}))).error || `upload failed (${res.status})`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      setForm((p) => slot === "main"
        ? { ...p, artR2Key: data.key, artCandidateKey: "" }
        : { ...p, prevArtR2Key: data.key, prevArtCandidateKey: "" });
      setCandidatePreviews((p) => slot === "main" ? { ...p, main: undefined } : { ...p, prev: undefined });
      setDirty(true);
      setArtNonce((n) => n + 1);
      toast({ title: `Artwork uploaded (${slot})`, description: `${data.width}×${data.height}` });
    } catch (e) {
      handleAuthError(e, "Upload failed");
    } finally { setUploading(false); }
  }

  async function useArtworkCandidate(art: { candidateKey: string; slot: "main" | "prev"; preview: string; generationId?: number | null }): Promise<boolean> {
    if (!form.cardId) {
      toast({ title: "Set a Card ID first", description: "Generated artwork needs a card slot before it can be attached.", variant: "destructive" });
      return false;
    }
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/ai/artwork/use", { cardId: form.cardId, slot: art.slot, candidateKey: art.candidateKey, generationId: art.generationId });
      const data = (await res.json()) as { candidateKey: string; slot: "main" | "prev"; width?: number; height?: number };
      setForm((p) => data.slot === "main"
        ? { ...p, artCandidateKey: data.candidateKey }
        : { ...p, prevArtCandidateKey: data.candidateKey });
      setCandidatePreviews((p) => data.slot === "main" ? { ...p, main: art.preview } : { ...p, prev: art.preview });
      setDirty(true);
      setArtNonce((n) => n + 1);
      // Preview/QA refresh comes from the debounced live-preview effect on the form change.
      toast({ title: `Candidate attached (${data.slot})`, description: "Click Save Draft to save it as draft artwork." });
      return true;
    } catch (e) {
      handleAuthError(e, "Use image failed");
      return false;
    }
  }

  // Map an AI full-card result to the editor form (numbers → strings, keywords → csv).
  function fullCardFieldsToForm(f: Record<string, unknown>): Partial<CardForm> {
    const patch: Partial<CardForm> = {};
    const put = (k: keyof CardForm, v: unknown) => { if (v != null && v !== "") (patch as Record<string, string>)[k] = String(v); };
    put("name", f.name); put("displayName", f.displayName); put("cardType", f.cardType); put("element", f.element); put("rarity", f.rarity);
    put("stageNumber", f.stageNumber); put("health", f.health); put("guard", f.guard); put("shift", f.shift);
    put("attack1Name", f.attack1Name); put("attack1Cost", f.attack1Cost); put("attack1Damage", f.attack1Damage); put("attack1Effect", f.attack1Effect);
    put("attack2Name", f.attack2Name); put("attack2Cost", f.attack2Cost); put("attack2Damage", f.attack2Damage); put("attack2Effect", f.attack2Effect);
    put("vulnerability", f.vulnerability);
    if (Array.isArray(f.keywords)) patch.keywords = (f.keywords as unknown[]).map(String).join(", ");
    put("notes", f.flavour);
    return patch;
  }

  // Generate Full Card — one flow: Anthropic writes every field + a clean artwork
  // prompt, then Higgsfield makes the image and it's auto-attached as a candidate.
  // Draft-only: fields update client-side; the user still clicks Save Draft to persist.
  async function generateFullCard() {
    if (!form.cardId) { toast({ title: "Set a Card ID first", variant: "destructive" }); return; }
    if (fullCardBlockReason) { toast({ title: "Full Card generation unavailable", description: fullCardBlockReason, variant: "destructive" }); return; }
    if (fullInFlight.current || fullBusy) return;
    fullInFlight.current = true;
    setFullBusy("Writing card…");
    let fields: Record<string, unknown>;
    let artworkPrompt = "";
    try {
      // 1) text — every field. If this fails, the form is NOT touched.
      const res = await apiRequest("POST", "/api/admin/vault-quest/ai/full-card", { context: aiContext });
      const data = (await res.json()) as { fields: Record<string, unknown>; artworkPrompt?: string; artworkBlockedReason?: string };
      fields = data.fields ?? {};
      artworkPrompt = data.artworkPrompt ?? "";
      if (Object.keys(fields).length === 0) { toast({ title: "No card returned — try again", variant: "destructive" }); fullInFlight.current = false; setFullBusy(null); return; }
      if (data.artworkBlockedReason) {
        setForm((p) => ({ ...p, ...fullCardFieldsToForm(fields) }));
        setDirty(true);
        toast({ title: "Text drafted — artwork blocked", description: data.artworkBlockedReason, variant: "destructive" });
        fullInFlight.current = false;
        setFullBusy(null);
        return;
      }
    } catch (e) {
      handleAuthError(e, "Generate Full Card failed"); // 401 → login; else error. Form untouched.
      fullInFlight.current = false;
      setFullBusy(null);
      return;
    }
    // 2) apply the text fields (draft-only, client-side)
    setForm((p) => ({ ...p, ...fullCardFieldsToForm(fields) }));
    setDirty(true);
    // 3) artwork from the generated card + clean prompt (independent failure)
    setFullBusy("Generating artwork…");
    try {
      const artCtx = { ...aiContext, ...fields, cardId: form.cardId };
      const ares = await apiRequest("POST", "/api/admin/vault-quest/ai/artwork", { context: artCtx, mode: "main", slot: "main", promptOverride: artworkPrompt || undefined });
      const art = (await ares.json()) as { candidateKey: string; preview: string; generationId?: number | null };
      // useArtworkCandidate handles its own errors and returns false — don't show the
      // success toast (on top of its error toast) when attaching the artwork failed.
      const attached = await useArtworkCandidate({ candidateKey: art.candidateKey, slot: "main", preview: art.preview, generationId: art.generationId });
      if (attached) toast({ title: "Full card drafted ✨", description: "Review the fields + art, then click Save Draft to keep it." });
      else toast({ title: "Full card drafted — artwork not attached", description: "The fields are filled in, but the generated artwork couldn't be attached. Use AI Assist → artwork to retry.", variant: "destructive" });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 401) { handleAuthError(e, "Artwork failed"); }
      else {
        const desc =
          status === 503 ? "Artwork provider not connected. Upload art manually, then Save Draft." :
          status === 402 ? "Higgsfield needs a higher plan or more credits. Upload art manually, then Save Draft." :
          (e instanceof Error ? e.message : "");
        toast({ title: "Text saved — artwork failed", description: desc, variant: "destructive" });
      }
    } finally {
      fullInFlight.current = false;
      setFullBusy(null);
    }
  }

  async function exportCard(fmt: "svg" | "png" | "pdf") {
    try {
      const res = await adminFetch(`/api/admin/vault-quest/cards/export/${fmt}`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(toPayload(form)) });
      if (!res.ok) {
        const err = new Error((await res.json().catch(() => ({}))).error || `export failed (${res.status})`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      triggerDownload(await res.blob(), `${form.cardId || "card"}.${fmt}`);
    } catch (e) {
      handleAuthError(e, `Export ${fmt.toUpperCase()} failed`);
    }
  }

  async function bulkProxy(ids: string[]) {
    if (!ids.length) { toast({ title: "No cards to proxy" }); return; }
    if (exportJob) return; // one export at a time
    setExportJob({ label: "Proxy", done: 0, total: ids.length });
    try {
      const r = await runExportJob("/api/admin/vault-quest/proxy", { ids }, `VQ_proxy_${ids.length}.pdf`, (done, total) => setExportJob({ label: "Proxy", done, total }), () => alive.current);
      toast({ title: `Proxy sheet ready — ${r.rendered} card(s)`, description: r.skipped ? `${r.skipped} skipped (not renderable yet)` : undefined });
    } catch (e) { handleAuthError(e, "Proxy failed"); }
    finally { setExportJob(null); }
  }
  async function bulkExport(ids: string[]) {
    if (!ids.length) { toast({ title: "No cards to export" }); return; }
    if (exportJob) return; // one export at a time
    setExportJob({ label: "Export pack", done: 0, total: ids.length });
    try {
      const r = await runExportJob("/api/admin/vault-quest/export/pack", { ids }, `VQ_export_${ids.length}.zip`, (done, total) => setExportJob({ label: "Export pack", done, total }), () => alive.current);
      toast({ title: `Export pack ready — ${r.rendered} rendered`, description: r.skipped ? `${r.skipped} skipped (not renderable yet)` : undefined });
    } catch (e) { handleAuthError(e, "Export failed"); }
    finally { setExportJob(null); }
  }

  async function save(status?: "draft") {
    setSaving(true);
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/cards", { ...toPayload(form), status: status ?? "draft" });
      const data = await res.json();
      setQa(data.qa?.issues ?? []);
      setLoadedStatus((data.card?.status as VqStatus) ?? "draft");
      const savedCard = (data.card ?? {}) as { artR2Key?: string | null; prevArtR2Key?: string | null };
      setForm((p) => ({
        ...p,
        artR2Key: savedCard.artR2Key ? String(savedCard.artR2Key) : p.artR2Key,
        prevArtR2Key: savedCard.prevArtR2Key ? String(savedCard.prevArtR2Key) : p.prevArtR2Key,
        artCandidateKey: "",
        prevArtCandidateKey: "",
      }));
      setCandidatePreviews({});
      setArtNonce((n) => n + 1);
      setDirty(false);
      toast({ title: `Saved ${form.cardId}` });
      dash.refetch();
    } catch (e) {
      handleAuthError(e, "Save failed");
    } finally { setSaving(false); }
  }

  async function loadCard(cardId: string) {
    try {
      const res = await adminFetch(`/api/admin/vault-quest/cards/${encodeURIComponent(cardId)}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `load failed (${res.status})`);
      const data = (await res.json()) as { card: Record<string, unknown>; previousStage: string | null; familyName: string | null; base: BaseRef };
      const c = data.card;
      const s = (v: unknown) => (v == null ? "" : String(v));
      setForm({
        cardId: s(c.cardId), collectorNumber: s(c.collectorNumber), name: s(c.name), displayName: s(c.displayName),
        cardType: s(c.cardType) || "Creature", element: s(c.element) || "Flame", rarity: s(c.rarity),
        familyId: s(c.familyId), familyName: data.familyName ?? "", stageNumber: s(c.stageNumber),
        lifeStage: s(c.lifeStage), previousStage: data.previousStage ?? "",
        health: s(c.health), guard: s(c.guard), shift: s(c.shift),
        attack1Name: s(c.attack1Name), attack1Damage: s(c.attack1Damage), attack1Effect: s(c.attack1Effect),
        attack2Name: s(c.attack2Name), attack2Damage: s(c.attack2Damage), attack2Effect: s(c.attack2Effect),
        vulnerability: s(c.vulnerability), keywords: Array.isArray(c.keywords) ? (c.keywords as string[]).join(", ") : "",
        notes: s(c.notes), artR2Key: s(c.artR2Key), prevArtR2Key: s(c.prevArtR2Key), artCandidateKey: "", prevArtCandidateKey: "",
        attack1Cost: s(c.attack1Cost), attack2Cost: s(c.attack2Cost), variantTier: s(c.variantTier), baseCardId: s(c.baseCardId),
        statusEffects: Array.isArray(c.effects) ? (c.effects as string[]).join(", ") : "",
      });
      setBaseRef(data.base ?? null);
      setCandidatePreviews({});
      setLoadedStatus(((c.status as string) || "draft") as VqStatus);
      setEvalu(null);
      setDirty(false);
      setView("editor");
    } catch (e) {
      toast({ title: "Failed to load card", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  }

  async function runFullQa() {
    if (!form.cardId) return;
    try {
      const res = await adminFetch(`/api/admin/vault-quest/cards/${encodeURIComponent(form.cardId)}/evaluate`, { credentials: "include" });
      if (!res.ok) {
        const err = new Error((await res.json().catch(() => ({}))).error || "evaluate failed") as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const e = (await res.json()) as Evaluation;
      setEvalu(e);
      setQa(e.qa ?? []);
    } catch (e) { handleAuthError(e, "QA failed"); }
  }

  async function transition(to: VqStatus, override = false) {
    if (!form.cardId) { toast({ title: "Save the card first", variant: "destructive" }); return; }
    if (dirty) { toast({ title: "Save your changes before changing status", variant: "destructive" }); return; }
    try {
      const res = await adminFetch(`/api/admin/vault-quest/cards/${encodeURIComponent(form.cardId)}/status`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ to, override }),
      });
      const data = await res.json();
      if (res.status === 401 || res.status === 403) {
        const err = new Error(data.error || `transition failed (${res.status})`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      if (!res.ok) {
        const reasons = data.reasons as string[] | undefined;
        // The variant-base gate is the only overridable one — offer to force it.
        if (!override && reasons?.some((r) => /base/i.test(r))) {
          if (window.confirm(`Blocked:\n${reasons.join("\n")}\n\nForce ${STATUS_META[to].label} anyway (override the base-approval gate)?`)) {
            return transition(to, true);
          }
        }
        toast({ title: `Cannot ${STATUS_META[to].label}`, description: reasons?.join(" · ") || data.error || "blocked", variant: "destructive" });
        if (data.evaluation) setEvalu(data.evaluation);
        return;
      }
      setLoadedStatus(to);
      if (data.evaluation) setEvalu(data.evaluation);
      toast({ title: `→ ${STATUS_META[to].label}` });
      dash.refetch();
    } catch (e) { handleAuthError(e, "Transition failed"); }
  }

  function newCard() { setForm(BLANK); setPreview(null); setQa([]); setBaseRef(null); setCandidatePreviews({}); setLoadedStatus(null); setEvalu(null); setDirty(false); setView("editor"); }

  // Shared error handling: an expired/absent admin session surfaces as a clear
  // "Admin login required" + redirect to the admin login, instead of a cryptic
  // "Unauthorized" toast. Never weakens auth — the server still enforces requireAdmin.
  function handleAuthError(e: unknown, fallbackTitle: string) {
    const status = (e as { status?: number })?.status;
    if (status === 401) {
      toast({ title: "Admin login required", description: "Your admin session isn't active — taking you to the login page…", variant: "destructive" });
      setTimeout(() => { window.location.href = "/admin/login"; }, 1400);
      return;
    }
    if (status === 403) {
      toast({ title: "Admin access required", description: "This account can't use admin actions. Please log in as admin.", variant: "destructive" });
      return;
    }
    toast({ title: fallbackTitle, description: e instanceof Error ? e.message : "", variant: "destructive" });
  }

  // Generate new draft card(s) from the locked template (create-only server-side).
  // Uses the shared apiRequest so auth/session handling matches every other Studio
  // call (same cookie/credentials path). A 401 means the admin session isn't active.
  async function runGenerate() {
    if (!gen || !gen.name.trim()) return;
    setGenBusy(true);
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/generate", {
        mode: gen.mode === "new-family" ? "family" : "card",
        name: gen.name.trim(),
        element: gen.element,
        cardType: gen.mode === "new-card" ? gen.cardType : undefined,
      });
      const data = (await res.json()) as { created: string[]; familyId?: string; openCardId: string };
      setGen(null);
      await dash.refetch();
      toast({ title: gen.mode === "new-family" ? `Family created — ${data.created.length} draft cards` : "Draft card created", description: `Opening ${data.openCardId} in the editor` });
      await loadCard(data.openCardId);
    } catch (e) {
      handleAuthError(e, "Generate failed");
    } finally {
      setGenBusy(false);
    }
  }

  const rejects = qa.filter((i) => i.level === "reject");
  const warns = qa.filter((i) => i.level === "warn");
  const targets = loadedStatus ? allowedTargets(loadedStatus) : [];

  // ---- filtered board ----
  const board = (dash.data?.cards ?? []).filter((c) => {
    if (filters.q && !(`${c.cardId} ${c.name}`.toLowerCase().includes(filters.q.toLowerCase()))) return false;
    if (filters.status && c.status !== filters.status) return false;
    if (filters.cardType && c.cardType !== filters.cardType) return false;
    if (filters.element && c.element !== filters.element) return false;
    if (filters.rarity && c.rarity !== filters.rarity) return false;
    if (filters.need === "data" && c.hasData) return false;
    if (filters.need === "artwork" && c.hasArt) return false;
    if (filters.need === "variants" && !c.baseCardId) return false;
    if (filters.need === "base" && c.baseCardId) return false;
    if (filters.need === "placeholder" && !c.placeholderElement) return false;
    if (filters.family && c.familyId !== filters.family) return false;
    return true;
  });
  const families = [...new Set((dash.data?.cards ?? []).map((c) => c.familyId).filter(Boolean))].sort() as string[];
  const setCodes = [...new Set((dash.data?.cards ?? []).map((c) => c.cardId.split("-")[0]).filter(Boolean))].sort();
  const activeSet = gen?.setCode || setCodes[0] || "GNV";
  const setCards = (dash.data?.cards ?? []).filter((c) => c.cardId.startsWith(`${activeSet}-`));
  const familyRows = (fams.data?.families ?? []).filter((f) => f.familyId.startsWith(`${activeSet}-`));
  const familyChoices = familyRows.map((f) => {
    const cards = setCards.filter((c) => c.familyId === f.familyId).sort((a, b) => String(a.collectorNumber).localeCompare(String(b.collectorNumber)));
    const first = cards[0];
    const last = cards[cards.length - 1];
    const range = first && last ? `${first.collectorNumber}-${last.collectorNumber}` : "no cards";
    return {
      familyId: f.familyId,
      label: `${f.name ?? f.familyId} · ${f.familyId}`,
      hint: `${range} · ${f.element ?? "element"} · ${cards.length} card(s)`,
      cards,
    };
  });
  const selectedFamily = gen ? familyChoices.find((f) => f.familyId === gen.familyId) : undefined;
  const selectedFamilyCards = selectedFamily?.cards ?? [];
  const cardChoices = setCards
    .filter((c) => !gen?.familyId || c.familyId === gen.familyId)
    .sort((a, b) => String(a.collectorNumber).localeCompare(String(b.collectorNumber)));
  const syncGenSet = (setCode: string) => {
    const rows = (fams.data?.families ?? []).filter((f) => f.familyId.startsWith(`${setCode}-`));
    const cards = (dash.data?.cards ?? []).filter((c) => c.cardId.startsWith(`${setCode}-`));
    setGen((prev) => prev && ({ ...prev, setCode, familyId: rows[0]?.familyId ?? "", cardId: cards[0]?.cardId ?? "" }));
  };
  const openSelectedFamily = () => {
    if (!gen?.familyId) { toast({ title: "Choose a family first", variant: "destructive" }); return; }
    setFilters({ q: "", status: "", cardType: "", element: "", rarity: "", need: "", family: gen.familyId });
    setGen(null);
    setTimeout(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    toast({ title: "Family shown", description: "Click any card in that family to open AI Assist." });
  };
  const openSelectedCard = async () => {
    if (!gen?.cardId) { toast({ title: "Choose a card first", variant: "destructive" }); return; }
    const cardId = gen.cardId;
    setGen(null);
    await loadCard(cardId);
  };

  // Clicking a stat tile filters the card list to those cards (resets other filters)
  // and scrolls the list into view so the result is visible.
  const listRef = useRef<HTMLDivElement>(null);
  const selectTile = (patch: Partial<typeof filters>) => {
    setFilters({ q: "", status: "", cardType: "", element: "", rarity: "", need: "", family: "", ...patch });
    setTimeout(() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  const noFilter = !filters.status && !filters.need && !filters.cardType && !filters.element && !filters.rarity && !filters.family && !filters.q;
  const Tile = ({ label, value, onClick, active }: { label: string; value: number | string; onClick?: () => void; active?: boolean }) => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition ${active ? "border-amber-500 bg-amber-500/10" : "border-slate-800 bg-slate-900/50"} cursor-pointer hover:border-amber-500/60 hover:bg-slate-900`}
    >
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-950 p-6 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Vault Quest Studio</h1>
            <p className="text-sm text-slate-400">Production control centre — dashboard · workflow · live preview · export.</p>
          </div>
          <div className="flex gap-2">
            {view !== "board" && <AdminButton variant="ghost" onClick={() => setView("board")}><ArrowLeft className="mr-1 h-4 w-4" />Board</AdminButton>}
            {view === "board" && <AdminButton variant="ghost" onClick={() => dash.refetch()}><LayoutGrid className="mr-1 h-4 w-4" />Refresh</AdminButton>}
            <AdminButton variant={view === "bible" ? "gold" : "ghost"} onClick={() => setView("bible")}><BookOpen className="mr-1 h-4 w-4" />Character Bible</AdminButton>
            <AdminButton variant="gold" onClick={() => setGen({ mode: "open-family", setCode: setCodes[0] || "GNV", familyId: familyRows[0]?.familyId ?? "", cardId: setCards[0]?.cardId ?? "", name: "", element: ELEMENTS[0], cardType: "Creature" })}><Wand2 className="mr-1 h-4 w-4" />Generate</AdminButton>
            <AdminButton variant="ghost" onClick={newCard}><Plus className="mr-1 h-4 w-4" />New card</AdminButton>
          </div>
        </header>

        {view === "board" ? (
          <div className="space-y-4">
            {dash.isError && <p className="text-sm text-red-400">Dashboard unavailable — {String((dash.error as Error)?.message ?? "error")}</p>}
            {dash.isLoading && <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Loading 150 cards…</p>}
            {!dash.isLoading && !dash.isError && !dash.data && (
              <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-4">
                <p className="font-semibold text-amber-300">Admin login required</p>
                <p className="mt-1 text-sm text-slate-300">Your admin session isn't active, so no cards can load. Log in to use the Studio.</p>
                <a href="/admin/login" className="mt-3 inline-flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:bg-amber-400">Go to admin login →</a>
              </div>
            )}
            {dash.data && (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  <Tile label="Total" value={dash.data.total} onClick={() => selectTile({})} active={noFilter} />
                  <Tile label="Base" value={dash.data.base} onClick={() => selectTile({ need: "base" })} active={filters.need === "base"} />
                  <Tile label="Variants" value={dash.data.variants} onClick={() => selectTile({ need: "variants" })} active={filters.need === "variants"} />
                  <Tile label="Needs data" value={dash.data.needsData} onClick={() => selectTile({ need: "data" })} active={filters.need === "data"} />
                  <Tile label="Needs artwork" value={dash.data.needsArtwork} onClick={() => selectTile({ need: "artwork" })} active={filters.need === "artwork"} />
                  <Tile label="Placeholder el." value={dash.data.placeholderElements} onClick={() => selectTile({ need: "placeholder" })} active={filters.need === "placeholder"} />
                  <Tile label="Approved" value={dash.data.byStatus.approved ?? 0} onClick={() => selectTile({ status: "approved" })} active={filters.status === "approved"} />
                  <Tile label="Export ready" value={dash.data.byStatus.export_ready ?? 0} onClick={() => selectTile({ status: "export_ready" })} active={filters.status === "export_ready"} />
                  <Tile label="Ready" value={dash.data.byStatus.ready_for_review ?? 0} onClick={() => selectTile({ status: "ready_for_review" })} active={filters.status === "ready_for_review"} />
                  <Tile label="Families ✓" value={`${dash.data.familiesComplete}/${dash.data.families}`} onClick={() => selectTile({ cardType: "Creature" })} active={filters.cardType === "Creature"} />
                  <Tile label="Drafts" value={dash.data.byStatus.draft ?? 0} onClick={() => selectTile({ status: "draft" })} active={filters.status === "draft"} />
                  <Tile label="Rejected" value={dash.data.byStatus.rejected ?? 0} onClick={() => selectTile({ status: "rejected" })} active={filters.status === "rejected"} />
                </div>

                <div className="flex flex-wrap gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                  <input className={`${inputCls} w-44`} placeholder="Search id / name" value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} />
                  <select className={`${inputCls} w-36`} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}><option value="">All status</option>{Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s as VqStatus].label}</option>)}</select>
                  <select className={`${inputCls} w-32`} value={filters.cardType} onChange={(e) => setFilters((f) => ({ ...f, cardType: e.target.value }))}><option value="">All types</option>{CARD_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
                  <select className={`${inputCls} w-32`} value={filters.element} onChange={(e) => setFilters((f) => ({ ...f, element: e.target.value }))}><option value="">All elements</option>{ELEMENTS.map((t) => <option key={t}>{t}</option>)}</select>
                  <select className={`${inputCls} w-28`} value={filters.rarity} onChange={(e) => setFilters((f) => ({ ...f, rarity: e.target.value }))}><option value="">All rarity</option>{RARITIES.map((t) => <option key={t}>{t}</option>)}</select>
                  <select className={`${inputCls} w-40`} value={filters.need} onChange={(e) => setFilters((f) => ({ ...f, need: e.target.value }))}><option value="">Any</option><option value="data">Needs gameplay</option><option value="artwork">Needs artwork</option><option value="base">Base cards only</option><option value="variants">Variants only</option><option value="placeholder">Placeholder element</option></select>
                  <select className={`${inputCls} w-32`} value={filters.family} onChange={(e) => setFilters((f) => ({ ...f, family: e.target.value }))}><option value="">All families</option>{families.map((fam) => <option key={fam}>{fam}</option>)}</select>
                  <div className="ml-auto flex items-center gap-2">
                    {exportJob ? (
                      <span className="self-center text-xs font-medium text-amber-400" role="status" aria-live="polite">
                        {exportJob.label}… {exportJob.done}/{exportJob.total}
                      </span>
                    ) : (
                      <span className="self-center text-xs text-slate-500">{board.length} shown</span>
                    )}
                    <AdminButton variant="ghost" disabled={!!exportJob} onClick={() => bulkProxy(board.map((c) => c.cardId))}><FileText className="mr-1 h-4 w-4" />Proxy</AdminButton>
                    <AdminButton variant="ghost" disabled={!!exportJob} onClick={() => bulkExport(board.map((c) => c.cardId))}><FileCode className="mr-1 h-4 w-4" />Export pack</AdminButton>
                  </div>
                </div>

                <div ref={listRef} className="scroll-mt-4 overflow-hidden rounded-lg border border-slate-800">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-900/60 text-left text-[11px] uppercase tracking-wide text-slate-400">
                      <tr><th className="px-3 py-2">Card</th><th className="px-2 py-2">Type</th><th className="px-2 py-2">Element</th><th className="px-2 py-2">Rarity</th><th className="px-2 py-2">Data</th><th className="px-2 py-2">Art</th><th className="px-2 py-2">Ready</th><th className="px-2 py-2">Status</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {board.slice(0, 300).map((c) => (
                        <tr key={c.cardId} className="cursor-pointer hover:bg-slate-900/60" onClick={() => loadCard(c.cardId)}>
                          <td className="px-3 py-1.5"><span className="font-medium">{c.cardId}</span> <span className="text-slate-400">{c.name}</span>{c.baseCardId && <span className="ml-1 text-[10px] text-amber-400">▸{c.variantTier}</span>}</td>
                          <td className="px-2 py-1.5 text-slate-300">{c.cardType}</td>
                          <td className="px-2 py-1.5 text-slate-300">{c.element}{c.placeholderElement && <span className="ml-1 text-[10px] text-amber-500">◦</span>}</td>
                          <td className="px-2 py-1.5 text-slate-300">{c.rarity}</td>
                          <td className="px-2 py-1.5">{c.hasData ? "✓" : <span className="text-amber-500">—</span>}</td>
                          <td className="px-2 py-1.5">{c.hasArt ? "✓" : <span className="text-amber-500">—</span>}</td>
                          <td className="px-2 py-1.5"><span className="text-slate-400">{c.readiness}%</span></td>
                          <td className="px-2 py-1.5"><StatusBadge status={c.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        ) : view === "bible" ? (
          <CharacterBibleView onBack={() => setView("board")} onAuthError={handleAuthError} deepLink={bibleDeepLink} />
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
            {/* editor */}
            <section className="space-y-5 rounded-lg border border-slate-800 bg-slate-900/40 p-5">
              {loadedStatus && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 p-2">
                  <span className="text-xs text-slate-400">Status</span><StatusBadge status={loadedStatus} />
                  {evalu && <span className="text-xs text-slate-400">· readiness <span className="font-semibold text-slate-200">{evalu.readiness}%</span></span>}
                  <AdminButton variant="ghost" onClick={runFullQa}><ShieldCheck className="mr-1 h-4 w-4" />Run QA</AdminButton>
                  <span className="mx-1 w-px self-stretch bg-slate-700" />
                  {dirty && <span className="self-center text-[11px] text-amber-400">Save changes to enable status actions</span>}
                  {!dirty && TRANSITION_BTN.filter((b) => targets.includes(b.to) && b.to !== loadedStatus).map((b) => (
                    <AdminButton key={b.to} variant="ghost" onClick={() => transition(b.to)}><b.icon className="mr-1 h-4 w-4" />{b.label}</AdminButton>
                  ))}
                </div>
              )}
              {baseRef && (
                <div className="rounded-md border border-amber-700/50 bg-amber-950/30 p-2 text-xs text-amber-200">
                  Variant{form.variantTier ? ` (${form.variantTier})` : ""} of <span className="font-semibold">{baseRef.cardId} · {baseRef.name}</span> — gameplay inherited from base:
                  Health {baseRef.health ?? "—"} · Guard {baseRef.guard ?? "—"} · Shift {baseRef.shift ?? "—"} · {baseRef.attack1Name ?? "no attack yet"}{baseRef.attack1Damage != null ? ` (${baseRef.attack1Damage})` : ""} · base: {baseRef.status}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div><label className={labelCls}>Card ID</label><input className={inputCls} value={form.cardId} onChange={(e) => set("cardId", e.target.value)} placeholder="GNV-001" /></div>
                <div><label className={labelCls}>Collector no.</label><input className={inputCls} value={form.collectorNumber} onChange={(e) => set("collectorNumber", e.target.value)} placeholder="001/150" /></div>
                <div><label className={labelCls}>Type</label><Combo value={form.cardType} onChange={(v) => set("cardType", v)} options={CARD_TYPES.map((t) => ({ value: t, label: t }))} allowEmpty={false} /></div>
                <div className="col-span-2"><label className={labelCls}>Name</label><input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Flammi" /></div>
                <div><label className={labelCls}>Element</label><Combo value={form.element} onChange={(v) => set("element", v)} options={elementOpts} allowEmpty={false} placeholder="Select element" onAddNew={addElement} addNewLabel="Add element" /></div>
                <div><label className={labelCls}>Rarity</label><Combo value={form.rarity} onChange={(v) => set("rarity", v)} options={RARITIES.map((t) => ({ value: t, label: t }))} placeholder="Rarity" /></div>
                <div><label className={labelCls}>Vulnerability</label><input className={inputCls} value={form.vulnerability} onChange={(e) => set("vulnerability", e.target.value)} placeholder="Water" /></div>
              </div>

              {!isSupport && (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div><label className={labelCls}>Family</label><Combo value={form.familyId} onChange={(v) => { const f = fams.data?.families.find((x) => x.familyId === v); setForm((p) => ({ ...p, familyId: v, familyName: f?.name ?? p.familyName })); setDirty(true); }} options={familyOpts} placeholder="Search family" onAddNew={(q) => setNewFamily({ name: q, element: form.element || ELEMENTS[0], s1: `${q} I`, s2: `${q} II`, s3: `${q} III` })} addNewLabel="New family" /></div>
                    <div><label className={labelCls}>Family name</label><input className={inputCls} value={form.familyName} onChange={(e) => set("familyName", e.target.value)} placeholder="Flammi" /></div>
                    <div><label className={labelCls}>Stage</label><Combo value={form.stageNumber} onChange={(v) => set("stageNumber", v)} options={[{ value: "1", label: "1 Baby" }, { value: "2", label: "2 Teen" }, { value: "3", label: "3 Final" }]} allowEmpty={false} /></div>
                    <div><label className={labelCls}>Evolves from</label><input className={inputCls} value={form.previousStage} onChange={(e) => set("previousStage", e.target.value)} placeholder="(auto from family + stage)" />{evolveWarn && <p className="mt-1 text-[10px] text-amber-400">⚠ manual override (auto: {autoPrev || "none"})</p>}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className={labelCls}>Variant tier</label><Combo value={form.variantTier} onChange={(v) => set("variantTier", v)} options={VARIANT_TIERS.map((t) => ({ value: t, label: t === "STANDARD" ? "Standard" : t }))} placeholder="Standard / none" /></div>
                    <div><label className={labelCls}>Base card {isVariantTier && !form.baseCardId && <span className="text-red-400">· required for variants</span>}</label><Combo value={form.baseCardId} onChange={(v) => set("baseCardId", v)} options={baseCardOpts} placeholder="Search base card" /></div>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className={labelCls}>Health</label><input className={inputCls} value={form.health} onChange={(e) => set("health", e.target.value)} /></div>
                    <div><label className={labelCls}>Guard</label><input className={inputCls} value={form.guard} onChange={(e) => set("guard", e.target.value)} /></div>
                    <div><label className={labelCls}>Shift</label><input className={inputCls} value={form.shift} onChange={(e) => set("shift", e.target.value)} /></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-[64px_1fr_80px]">
                    <div><label className={labelCls}>A1 Core</label><input className={inputCls} value={form.attack1Cost} onChange={(e) => set("attack1Cost", e.target.value)} placeholder="0" /></div>
                    <div><label className={labelCls}>Attack 1 name</label><input className={inputCls} value={form.attack1Name} onChange={(e) => set("attack1Name", e.target.value)} placeholder="Ember Tap" /></div>
                    <div><label className={labelCls}>Damage</label><input className={inputCls} value={form.attack1Damage} onChange={(e) => set("attack1Damage", e.target.value)} /></div>
                    <div className="col-span-2 sm:col-span-3"><label className={labelCls}>Attack 1 effect</label><input className={inputCls} value={form.attack1Effect} onChange={(e) => set("attack1Effect", e.target.value)} placeholder="(optional)" /></div>
                    <div><label className={labelCls}>A2 Core</label><input className={inputCls} value={form.attack2Cost} onChange={(e) => set("attack2Cost", e.target.value)} placeholder="0" /></div>
                    <div><label className={labelCls}>Attack 2 name</label><input className={inputCls} value={form.attack2Name} onChange={(e) => set("attack2Name", e.target.value)} placeholder="(optional)" /></div>
                    <div><label className={labelCls}>Damage</label><input className={inputCls} value={form.attack2Damage} onChange={(e) => set("attack2Damage", e.target.value)} /></div>
                    <div className="col-span-2 sm:col-span-3"><label className={labelCls}>Attack 2 effect</label><input className={inputCls} value={form.attack2Effect} onChange={(e) => set("attack2Effect", e.target.value)} /></div>
                  </div>
                </>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div><label className={labelCls}>Keywords</label><TagInput value={form.keywords.split(",").map((k) => k.trim()).filter(Boolean)} onChange={(v) => set("keywords", v.join(", "))} suggestions={tax.data?.keywords ?? []} placeholder="add keyword…" /></div>
                <div><label className={labelCls}>Status effects</label><TagInput value={form.statusEffects.split(",").map((k) => k.trim()).filter(Boolean)} onChange={(v) => set("statusEffects", v.join(", "))} suggestions={tax.data?.effects ?? []} placeholder="add status effect…" /></div>
              </div>
              <div><label className={labelCls}>Notes</label><input className={inputCls} value={form.notes} onChange={(e) => set("notes", e.target.value)} /></div>

              <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:border-amber-500">
                  <Upload className="h-4 w-4" />{uploading ? "Uploading…" : "Upload artwork"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadArt(f, "main"); }} />
                </label>
                {(form.artCandidateKey || form.artR2Key) && (
                  <span className="inline-flex items-center gap-2">
                    <img src={form.artCandidateKey && candidatePreviews.main ? candidatePreviews.main : `/api/admin/vault-quest/cards/${encodeURIComponent(form.cardId)}/art/main?v=${artNonce}`} alt="art" className="h-10 w-10 rounded object-cover" />
                    {form.artCandidateKey && <span className="text-[11px] text-amber-400">candidate · save draft</span>}
                  </span>
                )}
                {!isSupport && (
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-600 px-3 py-1.5 text-sm hover:border-amber-500">
                    <Upload className="h-4 w-4" />Prev-stage art
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadArt(f, "prev"); }} />
                  </label>
                )}
                {!isSupport && form.prevArtCandidateKey && <span className="text-[11px] text-amber-400">prev candidate · save draft</span>}
              </div>

              <div className="flex flex-wrap gap-2 border-t border-slate-800 pt-4">
                <AdminButton onClick={() => save("draft")} disabled={saving}>{saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}Save Draft</AdminButton>
                <span className="mx-1 w-px bg-slate-700" />
                <AdminButton variant="ghost" onClick={() => exportCard("svg")}><FileCode className="mr-1 h-4 w-4" />SVG</AdminButton>
                <AdminButton variant="ghost" onClick={() => exportCard("png")}><FileImage className="mr-1 h-4 w-4" />PNG</AdminButton>
                <AdminButton variant="ghost" onClick={() => exportCard("pdf")}><FileText className="mr-1 h-4 w-4" />PDF</AdminButton>
              </div>
            </section>

            <aside className="space-y-4">
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                <div className="mb-2 flex items-center justify-between"><span className={labelCls}>Live preview</span>{rendering && <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}</div>
                <div className="flex aspect-[69/94] items-center justify-center overflow-hidden rounded bg-slate-800">
                  {preview ? <img src={preview} alt="card preview" className="h-full w-full object-contain" /> : <span className="text-xs text-slate-500">enter Card ID + Name</span>}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                <span className={labelCls}>QA {evalu && `· readiness ${evalu.readiness}%`}</span>
                {rejects.length === 0 && warns.length === 0 && <p className="text-sm text-emerald-400">✓ passes QA</p>}
                {rejects.map((i, k) => <p key={`r${k}`} className="flex items-start gap-1 text-sm text-red-400"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />[{i.field}] {i.message}</p>)}
                {warns.map((i, k) => <p key={`w${k}`} className="text-xs text-amber-400">⚠ [{i.field}] {i.message}</p>)}
                {evalu?.suggestions?.map((sug, k) => <p key={`s${k}`} className="text-xs text-slate-400">→ {sug}</p>)}
              </div>

              <AiAssist context={aiContext} onApply={applyAi} onUseArtwork={useArtworkCandidate} imageProviders={imageProviders} textConnected={textConnected} onGenerateFull={generateFullCard} fullBusy={fullBusy} fullCardBlocked={fullCardBlockReason} cardArtworkBlocked={cardArtworkBlockReason} />
            </aside>
          </div>
        )}

        {gen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !genBusy && setGen(null)}>
            <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <h2 className="mb-1 flex items-center gap-2 text-lg font-bold text-slate-100"><Wand2 className="h-5 w-5 text-amber-400" />Choose cards to generate</h2>
              <p className="mb-4 text-xs text-slate-400">
                Pick from the existing set, family, and card list first. Opening a card shows AI Assist. The create-new options add extra draft cards only.
              </p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setGen({ ...gen, mode: "open-family" })} className={`rounded-md border px-3 py-2 text-left text-sm ${gen.mode === "open-family" ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-slate-600 text-slate-300 hover:border-slate-500"}`}>Existing family<span className="block text-[10px] text-slate-500">show all cards</span></button>
                  <button type="button" onClick={() => setGen({ ...gen, mode: "open-card" })} className={`rounded-md border px-3 py-2 text-left text-sm ${gen.mode === "open-card" ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-slate-600 text-slate-300 hover:border-slate-500"}`}>Existing card<span className="block text-[10px] text-slate-500">open editor</span></button>
                  <button type="button" onClick={() => setGen({ ...gen, mode: "new-family" })} className={`rounded-md border px-3 py-2 text-left text-sm ${gen.mode === "new-family" ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-slate-600 text-slate-300 hover:border-slate-500"}`}>New family<span className="block text-[10px] text-slate-500">3 extra draft cards</span></button>
                  <button type="button" onClick={() => setGen({ ...gen, mode: "new-card" })} className={`rounded-md border px-3 py-2 text-left text-sm ${gen.mode === "new-card" ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-slate-600 text-slate-300 hover:border-slate-500"}`}>New card<span className="block text-[10px] text-slate-500">1 extra draft card</span></button>
                </div>
                {(gen.mode === "open-family" || gen.mode === "open-card") ? (
                  <>
                    <div><label className={labelCls}>Set</label><select className={inputCls} value={gen.setCode} onChange={(e) => syncGenSet(e.target.value)}>{(setCodes.length ? setCodes : ["GNV"]).map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
                    <div><label className={labelCls}>Family</label><select className={inputCls} value={gen.familyId} onChange={(e) => setGen({ ...gen, familyId: e.target.value, cardId: familyChoices.find((f) => f.familyId === e.target.value)?.cards[0]?.cardId ?? "" })}><option value="">All families</option>{familyChoices.map((f) => <option key={f.familyId} value={f.familyId}>{f.label} · {f.hint}</option>)}</select></div>
                    {gen.mode === "open-card" && <div><label className={labelCls}>Card</label><select className={inputCls} value={gen.cardId} onChange={(e) => setGen({ ...gen, cardId: e.target.value })}>{cardChoices.map((c) => <option key={c.cardId} value={c.cardId}>{c.collectorNumber} · {c.cardId} · {c.name} · {c.familyId ?? "No family"}</option>)}</select></div>}
                    {gen.mode === "open-family" && selectedFamilyCards.length > 0 && (
                      <div className="max-h-36 overflow-auto rounded-md border border-slate-700 bg-slate-950/40 p-2 text-xs text-slate-300">
                        {selectedFamilyCards.map((c) => <div key={c.cardId} className="flex justify-between gap-2 py-0.5"><span>{c.collectorNumber} · {c.cardId}</span><span className="text-slate-400">{c.name}</span></div>)}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div><label className={labelCls}>{gen.mode === "new-family" ? "New family name" : "New card name"}</label><input className={inputCls} autoFocus value={gen.name} onChange={(e) => setGen({ ...gen, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && gen.name.trim() && !genBusy) runGenerate(); }} placeholder={gen.mode === "new-family" ? "e.g. Emberling" : "e.g. Emberling"} /></div>
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className={labelCls}>Element</label><select className={inputCls} value={gen.element} onChange={(e) => setGen({ ...gen, element: e.target.value })}>{ELEMENTS.map((t) => <option key={t}>{t}</option>)}</select></div>
                      {gen.mode === "new-card" && <div><label className={labelCls}>Type</label><select className={inputCls} value={gen.cardType} onChange={(e) => setGen({ ...gen, cardType: e.target.value })}>{CARD_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>}
                    </div>
                  </>
                )}
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <AdminButton variant="ghost" onClick={() => setGen(null)} disabled={genBusy}>Cancel</AdminButton>
                {gen.mode === "open-family" && <AdminButton variant="gold" onClick={openSelectedFamily} disabled={!gen.familyId}>Show family</AdminButton>}
                {gen.mode === "open-card" && <AdminButton variant="gold" onClick={openSelectedCard} disabled={!gen.cardId}>Open card</AdminButton>}
                {(gen.mode === "new-family" || gen.mode === "new-card") && <AdminButton variant="gold" onClick={runGenerate} disabled={genBusy || !gen.name.trim()}>{genBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}Create draft</AdminButton>}
              </div>
            </div>
          </div>
        )}

        {newFamily && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setNewFamily(null)}>
            <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <h2 className="mb-1 flex items-center gap-2 text-lg font-bold text-slate-100"><Plus className="h-5 w-5 text-amber-400" />New family</h2>
              <p className="mb-4 text-xs text-slate-400">Creates the family registry row only (no cards). The card you’re editing will be assigned to it.</p>
              <div className="space-y-3">
                <div><label className={labelCls}>Family name</label><input className={inputCls} autoFocus value={newFamily.name} onChange={(e) => setNewFamily({ ...newFamily, name: e.target.value })} placeholder="e.g. Emberling" /></div>
                <div><label className={labelCls}>Element</label><Combo value={newFamily.element} onChange={(v) => setNewFamily({ ...newFamily, element: v })} options={elementOpts} allowEmpty={false} /></div>
                <div className="grid grid-cols-3 gap-2">
                  <div><label className={labelCls}>Stage 1</label><input className={inputCls} value={newFamily.s1} onChange={(e) => setNewFamily({ ...newFamily, s1: e.target.value })} placeholder="Baby" /></div>
                  <div><label className={labelCls}>Stage 2</label><input className={inputCls} value={newFamily.s2} onChange={(e) => setNewFamily({ ...newFamily, s2: e.target.value })} placeholder="Teen" /></div>
                  <div><label className={labelCls}>Stage 3</label><input className={inputCls} value={newFamily.s3} onChange={(e) => setNewFamily({ ...newFamily, s3: e.target.value })} placeholder="Final" /></div>
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <AdminButton variant="ghost" onClick={() => setNewFamily(null)}>Cancel</AdminButton>
                <AdminButton variant="gold" onClick={createFamily} disabled={!newFamily.name.trim() || !newFamily.element}><Plus className="mr-1 h-4 w-4" />Create family</AdminButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
