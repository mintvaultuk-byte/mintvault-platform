import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Save, Zap, Sparkles, Trash2, Eye, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ImageViewer, { mapLegacyTypeToMvgsCode } from "./image-viewer";
import DefectAnnotation, { type Defect, type DefectCandidate, deriveZone } from "./defect-annotation";
import CenteringInput from "./centering-input";
import { calcCornerSubgrade, type CornerValues } from "./corner-grading";
import { calcEdgeSubgrade, type EdgeValues } from "./edge-grading";
import type { SurfaceValues } from "./surface-grading";
import GradeDisplay from "./grade-display";
import Authentication, { type AuthStatus } from "./authentication";
import GradingNotes from "./grading-notes";
import CaptureWizard from "./capture-wizard";
import AiPanel, { type AiAnalysisResult, type AiIdentification } from "./ai-panel";
import ManualCardTool from "./manual-card-tool";
// MeasurementTool retired in v2.1 — line drawing now lives inside image-viewer
// mark-mode and manual-card-tool defects phase as a tool palette, alongside
// the pin tool. The launcher button + overlay mount are gone from this panel.
// CrossGradeDisplay import removed (owner directive 2026-07-02) — the
// cross-grade estimate section was removed from this panel.
// Reuse the EXACT admin set-name combobox + card autofill so the grader identity
// editor feels identical to the admin CertificateForm. Both back-end endpoints
// (/api/pokemon-sets, /api/cards/autofill) are public — no auth change needed.
import { type TcgCardPick } from "@/components/identity-tools";
import { GradingIdentityVerification } from "@/components/grading/GradingIdentityVerification";
import { RarityVariantPicker } from "@/components/rarity-picker/RarityVariantPicker";
import type { StructuredCardVariant } from "@shared/pokemon-rarity-catalogue";
import { decideGradingPersistence } from "@shared/grading-persistence-lifecycle";
import { autofillCard } from "@/lib/api";

// Shared calculation imports (client-side re-implementations)
import { calculateOverallGrade, getGradeLabel, isBlackLabel as checkBlackLabel } from "./grade-logic";
import { computeMvgsScore, gradeFromMvgsScore, DEFAULT_MVGS_CALIBRATION } from "@shared/mvgs-scoring";
import { scoreMvgsV2 } from "@shared/mvgs-input-builder";
// Centering single source of truth (true PSA chart — front strict / back lenient).
import {
  centeringSubgrade,
  centeringSubgradeStrict,
  centeringAxisGradeOrNull,
  type CenteringAxis,
} from "@shared/centering";

function ReprocessButton({ certId, onDone }: { certId: number; onDone: () => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  return (
    <button
      type="button"
      disabled={status === "loading"}
      onClick={async () => {
        if (status === "loading") {
          toast({ title: "Already reprocessing, please wait" });
          return;
        }
        setStatus("loading");
        toast({ title: "Reprocessing images…" });
        try {
          const r = await fetch(`/api/admin/certificates/${certId}/reprocess-images`, {
            method: "POST",
            credentials: "include",
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error);
          setStatus("done");
          toast({ title: "Images reprocessed ✓" });
          onDone();
          setTimeout(() => setStatus("idle"), 3000);
        } catch (e: any) {
          setStatus("idle");
          toast({ title: "Reprocess failed", description: e.message, variant: "destructive" });
        }
      }}
      className={`flex-shrink-0 flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-2 rounded-lg transition-all mt-1 ${
        status === "done"
          ? "border border-[var(--admin-green)]/40 text-[var(--admin-green)] bg-[color-mix(in_srgb,var(--admin-green)_12%,transparent)]"
          : status === "loading"
            ? "border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] bg-[var(--admin-gold)]/5"
            : "border border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:text-[var(--admin-gold)] hover:border-[var(--admin-gold)]/40"
      }`}
    >
      {status === "loading" ? (
        <>
          <Loader2 size={11} className="animate-spin" /> Reprocessing…
        </>
      ) : status === "done" ? (
        <>
          <CheckCircle2 size={11} /> Reprocessed ✓
        </>
      ) : (
        "Reprocess"
      )}
    </button>
  );
}

/**
 * Map MVGS remaining-points-in-category (0..25) to a 1-10 subgrade. Each
 * scoring category (centering / corners / edges / surface) has a 25-pt
 * budget; this helper buckets the leftover into the 10-step subgrade scale.
 *
 * Brackets per MVGS spec:
 *   23-25 → 10   17-19 → 8   11-13 → 6   5-7 → 4   1-2 → 2
 *   20-22 →  9   14-16 → 7    8-10 → 5   3-4 → 3   0   → 1
 *
 * Implemented with descending `>=` thresholds so non-integer remainders
 * (e.g. edges 2.5 from a 22.5-pt deduction) deterministically bucket
 * down: 2.5 ∈ [1, 3) → grade 2.
 */
function mvgsRemainingToGrade(remaining: number): number {
  if (remaining >= 23) return 10;
  if (remaining >= 20) return 9;
  if (remaining >= 17) return 8;
  if (remaining >= 14) return 7;
  if (remaining >= 11) return 6;
  if (remaining >= 8) return 5;
  if (remaining >= 5) return 4;
  if (remaining >= 3) return 3;
  if (remaining >= 1) return 2;
  return 1;
}

interface Props {
  certId: number;
  /**
   * PR A · EXPLICIT GRADE-STAGE LIFECYCLE. REQUIRED — deliberately not optional.
   *
   * True only while the Grade stage is the ACTIVE stage. The workstation is
   * mounted hidden-not-unmounted so a grader's in-progress work survives stage
   * switches, which meant its debounced auto-save also ran while Card Details
   * was on screen — persisting computed defaults for a certificate nobody had
   * graded (MV900007: null -> 10/10/10/10, MV900010: Authentic-Only -> numeric 10).
   *
   * When false the panel performs NO draft save, schedules NO debounce and
   * sends NO grading request, and CANCELS any debounce already scheduled.
   * Rendering and local editing are unaffected, so unsaved grader work is never
   * destroyed.
   *
   * There is NO default (hostile review M-1). An earlier revision defaulted to
   * `true`, which fails OPEN: three standalone surfaces (grader, staff,
   * admin-staff) mounted this panel through GradingWorkstation without passing
   * the flag, so hidden auto-save was still live on all three. Every mount site
   * must now state the lifecycle explicitly, and the two legitimate mount paths
   * — GradingWorkstation (from its own stage state) and CertificateForm (from
   * its workflow stage, injected into the workstation slot) — both do.
   */
  active: boolean;
  certIdStr?: string;
  cardName: string;
  cardSet: string;
  /** Read-only identity extras shown to graders (admins get the editable
   *  CertificateForm above the panel instead). Optional — omitted fields hide. */
  cardNumber?: string | null;
  cardYear?: string | null;
  cardVariant?: string | null;
  existingGrade?: string | null;
  onGradeApproved?: (certId?: string, grade?: string) => void;
  onCertUpdated?: () => void;
  /** When set, GradingPanel processes this analysis as if AI panel completed */
  pendingAnalysis?: { analysis: AiAnalysisResult | null; identification: AiIdentification | null } | null;
  onPendingAnalysisConsumed?: () => void;
  /** Callback when user manually identifies a card from the AI panel's Search TCG */
  onManualIdentification?: (identification: Record<string, unknown>) => void;
  cardGame?: string;
  /** API base for ALL cert endpoints: '/api/admin' (default) or '/api/grader'.
   *  Threaded to ImageViewer + ManualCardTool + every fetch/queryKey so the
   *  SAME panel serves both admin and restricted-grader, never forked. */
  apiBase?: string;
  /** Restricted-grader mode: the primary action submits for approval (POST
   *  /submit) instead of publishing (PUT /approve), and the publish-only UI is
   *  relabelled. A grader can crop/centre/analyse/identify/save-draft but never
   *  publishes a live grade. */
  graderMode?: boolean;
  /** Admin grade-review mode: reuse the FULL panel to review a grader-submitted
   *  (pending_review) cert. Charge-safe — hides the AI panel / reprocess / recrop /
   *  delete-image; the primary action saves the (possibly corrected) draft then
   *  publishes via approve-grader-grade. Mount with apiBase="/api/admin/grade-review". */
  adminReview?: boolean;
  /** Grader EDIT mode: the grader reopened their OWN already-submitted
   *  (pending_review) card in the full workstation to correct it. Same tools as
   *  grading, but the primary action routes through the gated POST
   *  /edit-submission (re-asserts pending_review, re-snapshots operator_grade,
   *  audits) instead of /submit — so an edit can NEVER publish or auto-approve.
   *  Only meaningful with graderMode. */
  graderEdit?: boolean;
  correctionMode?: boolean;
  onCorrectionGradingReady?: (getPayload: () => Record<string, unknown>) => void;
  correctionFeedback?: {
    corrected: boolean;
    changes: Array<{ field: string; before: unknown; after: unknown }>;
  } | null;
}

// Zone arrays default to 0 = "not yet marked" — keeps buildPayload's hasContent
// omit working (untouched zones aren't persisted; 0 ≠ NULL in COALESCE). The
// derived corner/edge SUBGRADE now defaults to 10 when no zone is marked
// (Option A — calcCornerSubgrade), so a flawless card is Pristine 10 with no
// manual zone entry.
const DEFAULT_CORNERS: CornerValues = {
  frontTL: 0,
  frontTR: 0,
  frontBL: 0,
  frontBR: 0,
  backTL: 0,
  backTR: 0,
  backBL: 0,
  backBR: 0,
};
const DEFAULT_EDGES: EdgeValues = {
  frontTop: 0,
  frontBottom: 0,
  frontLeft: 0,
  frontRight: 0,
  backTop: 0,
  backBottom: 0,
  backLeft: 0,
  backRight: 0,
};
const DEFAULT_SURFACE: SurfaceValues = {
  front: 0,
  back: 0,
  hasPrintLines: false,
  hasHoloScratches: false,
  hasSurfaceScratches: false,
  hasStaining: false,
  hasIndentation: false,
  hasRollerMarks: false,
  hasColorRegistration: false,
  hasCrease: false,
  hasTear: false,
};

// Condition checkboxes shown alongside the MVGS-derived surface subgrade.
// Mirrors the legacy SurfaceGrading component's ISSUES list — duplicated
// here because we render the surface UI inline now (the manual front/back
// dropdowns from the old component are gone, surface subgrade comes from
// computeMvgsScore). hasCrease/hasTear still feed calculateOverallGrade
// as caps on the headline grade.
const SURFACE_ISSUES: { key: keyof SurfaceValues; label: string; warning?: string }[] = [
  { key: "hasPrintLines", label: "Print lines present" },
  { key: "hasHoloScratches", label: "Holo scratches present" },
  { key: "hasSurfaceScratches", label: "Surface scratches present" },
  { key: "hasStaining", label: "Staining present" },
  { key: "hasIndentation", label: "Indentation present" },
  { key: "hasRollerMarks", label: "Roller marks present" },
  { key: "hasColorRegistration", label: "Colour / registration issues" },
  // v2 caps: hasCrease → 4.5 (legacy fallback), hasTear → 2 (legacy fallback).
  // When the v2 measurement is set (creaseSpanPct / tearSeverity), it OVERRIDES
  // the checkbox per shared/mvgs-input-builder.ts precedence rules.
  { key: "hasCrease", label: "Crease present", warning: "Cap 4.5 (legacy flag — overridden by v2 crease line)" },
  {
    key: "hasTear",
    label: "Tear or missing material",
    warning: "Cap 2.0 (legacy flag — overridden by v2 tear severity)",
  },
];

const CANONICAL_GRADING_SECTION_ORDER = [
  "workflow-banners",
  "identification",
  "identity-fields",
  "workstation-header",
  "preflight",
  "ai-tools",
  "card-images",
  "defect-marking",
  "grading-controls",
  "mvgs-score",
  "grade-result",
  "d1-d2-d3",
  "centering",
  "surface",
  "authentication",
  "notes",
  "footer-actions",
].join(",");

function surfaceGradeColor(g: number): string {
  if (g >= 10) return "#D4AF37";
  if (g >= 8) return "#16A34A";
  if (g >= 6) return "#CA8A04";
  return "#DC2626";
}

export default function GradingPanel({
  certId,
  active,
  certIdStr,
  cardName,
  cardSet,
  cardNumber,
  cardYear,
  cardVariant,
  existingGrade,
  onGradeApproved,
  onCertUpdated,
  pendingAnalysis,
  onPendingAnalysisConsumed,
  onManualIdentification,
  cardGame,
  apiBase = "/api/admin",
  graderMode = false,
  adminReview = false,
  graderEdit = false,
  correctionMode = false,
  onCorrectionGradingReady,
  correctionFeedback,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Image URLs
  const { data: imageData } = useQuery<{ urls: Record<string, string | null>; quality: Record<string, any> }>({
    queryKey: [`${apiBase}/certificates/${certId}/images`],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/certificates/${certId}/images`, { credentials: "include" });
      if (!res.ok) return { urls: {}, quality: {} };
      return res.json();
    },
    staleTime: 30_000,
  });

  // Per-device AI card-IDENTIFICATION preference (localStorage; default ON). This
  // is the identify step ONLY — the AI never grades. ON: opening a not-yet-
  // identified cert auto-runs the Haiku identify + TCGdex confirm. OFF: no AI call
  // (saves ~£0.004/scan), the grader enters the identity manually. Per-device so
  // one person's choice never changes behaviour for anyone else / shop-wide.
  const [aiIdentify, setAiIdentify] = useState<boolean>(() => {
    try {
      return localStorage.getItem("mv.aiIdentify") !== "0";
    } catch {
      return true;
    }
  });
  const toggleAiIdentify = (on: boolean) => {
    setAiIdentify(on);
    try {
      localStorage.setItem("mv.aiIdentify", on ? "1" : "0");
    } catch {
      /* storage disabled (private mode) — falls back to in-memory for this session */
    }
  };

  // Grading data. NOTE: with AI identify ON, the /grading request BLOCKS ~10s on
  // the first open of a not-yet-identified cert while the server runs card
  // identification, then returns it in this payload (present on first paint, not a
  // later refresh). `gradingPending` drives the computing-state early return below.
  // With AI identify OFF we pass ?aiIdentify=0 so the server SKIPS the identify
  // call and returns immediately (no block); `aiIdentify` is in the queryKey so
  // flipping the toggle refetches with the new behaviour.
  const {
    data: gradingData,
    isPending: gradingPending,
    isError: gradingError,
    error: gradingLoadError,
  } = useQuery<any>({
    queryKey: [`${apiBase}/certificates/${certId}/grading`, aiIdentify],
    queryFn: async () => {
      const url = `${apiBase}/certificates/${certId}/grading${aiIdentify ? "" : "?aiIdentify=0"}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Grading workflow load failed (${res.status})`);
      return res.json();
    },
  });
  // PR A · record WHICH certificate the panel has actually hydrated for. Until
  // the grading payload for the CURRENT certId has arrived, the panel holds UI
  // defaults, and the auto-save effect refuses to persist them.
  //
  // This stores the certId rather than a boolean deliberately. A boolean had to
  // be cleared by the per-certId reset effect below, and effects run in
  // DECLARATION order: for a certificate whose grading payload was already in
  // the react-query cache, `gradingPending` is false on the very first render
  // after the switch, so this effect set the flag true and the reset effect
  // (declared further down) immediately cleared it again. No dependency then
  // changed, so the flag stayed false and grading auto-save was silently dead
  // for the rest of that mount. A certId marker is self-invalidating, so the
  // reset effect no longer touches it and the ordering cannot matter.
  useEffect(() => {
    if (gradingData !== undefined && !gradingPending && !gradingError) {
      gradingHydratedForRef.current = certId;
    }
  }, [gradingData, gradingPending, gradingError, certId]);

  const gradingWorkflowLocked = gradingPending || gradingError;
  const gradingWorkflowLockedRef = useRef(gradingWorkflowLocked);
  const gradingErrorRef = useRef(gradingError);
  useEffect(() => {
    gradingWorkflowLockedRef.current = gradingWorkflowLocked;
    gradingErrorRef.current = gradingError;
  }, [gradingWorkflowLocked, gradingError]);

  // Legacy "Manual Centering" two-rect picker REMOVED (owner directive
  // 2026-07-01): no longer used — the 8-dot Card Tool below is the only
  // centering measurement path.
  // 8-dot manual card tool (crop + deskew + centering in one pass)
  const [manualCardToolSide, setManualCardToolSide] = useState<"front" | "back" | null>(null);
  // MVGS v2 — measurement tool overlay (fullscreen). Opens from the surface
  // sidebar's "Open Measurement Tool" button.
  // measurementToolOpen — REMOVED. Line drawing happens inside the existing
  // mark-defects surfaces (image-viewer mark mode + manual-card-tool defects
  // phase) as a tool palette next to the pin tool. No fullscreen launcher.
  const [centeringMethod, setCenteringMethod] = useState<"ai" | "manual" | null>(null);
  const [manualOuterFront, setManualOuterFront] = useState<any>(null);
  const [manualInnerFront, setManualInnerFront] = useState<any>(null);
  const [manualOuterBack, setManualOuterBack] = useState<any>(null);
  const [manualInnerBack, setManualInnerBack] = useState<any>(null);

  // State — centering ratios start empty so they don't leak to DB as
  // "50/50" placeholders. Hydrated from AI/saved data; if empty at save
  // time, the PR #15 client guard omits them and the server preserves.
  const [frontLR, setFrontLR] = useState("");
  const [frontTB, setFrontTB] = useState("");
  const [backLR, setBackLR] = useState("");
  const [backTB, setBackTB] = useState("");
  const [corners, setCorners] = useState<CornerValues>(DEFAULT_CORNERS);
  const [viewerSide, setViewerSide] = useState("front");
  const [viewerZoom, setViewerZoom] = useState(1);
  const [viewerMode, setViewerMode] = useState({ fullscreen: false, markMode: false });
  const [edges, setEdges] = useState<EdgeValues>(DEFAULT_EDGES);
  const [surface, setSurface] = useState<SurfaceValues>(DEFAULT_SURFACE);
  const [defects, setDefects] = useState<Defect[]>([]);
  const [defectCandidates, setDefectCandidates] = useState<DefectCandidate[]>([]);
  // MVGS admin inputs — persisted on cert via buildPayload → /grade PUT.
  // dark_border_front / dark_border_back independently boost the WH (whitening)
  // ×1.25 edge multiplier on their own side. eye_appeal_modifier is a ±2
  // finishing tweak applied last in scoring.
  const [darkBorderFront, setDarkBorderFront] = useState(false);
  const [darkBorderBack, setDarkBorderBack] = useState(false);
  const [eyeAppealModifier, setEyeAppealModifier] = useState(0);
  // ── MVGS v2 measurement inputs (Phase 2) ───────────────────────────────
  // Persisted on the cert via buildPayload → /grade PUT. Engine reads them
  // through shared/mvgs-input-builder.ts which enforces measurement-wins-
  // over-checkbox precedence (the legacy surface.hasCrease/hasTear flags
  // still drive a fallback ceiling when no measurement is present).
  const [whiteningLines, setWhiteningLines] = useState<
    Array<{
      id?: string;
      side: "front" | "back";
      edge: "top" | "right" | "bottom" | "left";
      coveragePct: number;
      // Display-only: operator's actual drawn segment (image-relative %).
      // Engine ignores it; persisted in the whitening_lines jsonb so the marked
      // line redraws where it was drawn. Optional → legacy rows fall back to the
      // corner-stub indicator.
      start?: { x: number; y: number };
      end?: { x: number; y: number };
      // Display-only line colour (v2.1). Stripped at the mvgs-input-builder
      // boundary — never reaches the engine.
      color?: string;
    }>
  >([]);
  // MVGS v2.1 — multi-crease persistence. List of crease lines, each carrying
  // the drawn segment + spanPct + display colour. Replaces the v2.0
  // crease_span_pct single-value + session-only creaseSegment kludge.
  // Engine input derives `creaseSpanPct = max(spanPct)` per spec §4/§5 at the
  // mvgs-input-builder boundary; the legacy crease_span_pct column is kept as
  // a derived mirror (max of this array) for back-compat.
  type CreaseLine = {
    id: string;
    side: "front" | "back";
    spanPct: number;
    start: { x: number; y: number };
    end: { x: number; y: number };
    color?: string;
  };
  const [creaseLines, setCreaseLines] = useState<CreaseLine[]>([]);
  // Derived for back-compat: legacy readers still see the worst span.
  const creaseSpanPct = creaseLines.length > 0 ? Math.max(...creaseLines.map((l) => l.spanPct)) : null;
  // setCreaseSpanPct shim — existing call sites that set the legacy span
  // value (e.g. ManualCardTool defects phase prior to multi-crease wiring)
  // synthesise a single-entry list. Removed once those call sites move to
  // setCreaseLines directly.
  const setCreaseSpanPct = (next: number | null) => {
    if (next == null) {
      setCreaseLines([]);
      return;
    }
    setCreaseLines([
      {
        id: `legacy-${Date.now()}`,
        side: "front",
        spanPct: next,
        start: { x: 0, y: 0 },
        end: { x: 0, y: 0 },
      },
    ]);
  };
  const [wrinkleSeverity, setWrinkleSeverity] = useState<
    "tiny_back" | "longer_back" | "small_front" | "multiple_front" | null
  >(null);
  const [tearSeverity, setTearSeverity] = useState<"minor" | "significant" | "major" | null>(null);
  // Pre-grade checklist — session-only state, deliberately NOT persisted to
  // the cert. It's an operational reminder that the grader deionized the
  // card before scanning, not a data field on the certificate.
  // Defaults to TICKED (owner directive 2026-07-02): deionization is a standard
  // step every card goes through, so the box is pre-checked to save a click —
  // the grader can still untick it if a card wasn't deionized.
  const [deionizationComplete, setDeionizationComplete] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("genuine");
  const [authNotes, setAuthNotes] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  const [gradeExplanation, setGradeExplanation] = useState("");
  const [highlightDefect, setHighlightDefect] = useState<number | null>(null);

  const [centeringOverride, setCenteringOverride] = useState<number | null>(null);
  const [cornersOverride, setCornersOverride] = useState<number | null>(null);
  const [edgesOverride, setEdgesOverride] = useState<number | null>(null);
  const [surfaceOverride, setSurfaceOverride] = useState<number | null>(null);
  const [overallOverride, setOverallOverride] = useState<number | null>(null);

  // Editable card identity (grader mode only). Seeded once from props on mount;
  // the grader flow remounts the panel per card, so seed-once is correct. Edits
  // ride the existing debounced auto-save (buildPayload → /grade →
  // applyCertGradeDraft). Admins edit identity via CertificateForm instead.
  const [idName, setIdName] = useState(cardName || "");
  const [idSet, setIdSet] = useState(cardSet || "");
  const [idNumber, setIdNumber] = useState(cardNumber || "");
  const [idYear, setIdYear] = useState(cardYear || "");
  const [idVariant, setIdVariant] = useState(cardVariant || "");
  // Structured rarity/finish/promo (role routes only) — same canonical fields as
  // the /admin CertificateForm rarity picker. Persisted via buildPayload.
  const [rarityCode, setRarityCode] = useState("");
  const [finishVariant, setFinishVariant] = useState("");
  const [promoType, setPromoType] = useState("");
  // Tracks a deliberate operator interaction with the rarity picker (including an
  // explicit "No rarity" clear). Only once touched do we persist an EMPTY rarity —
  // so an unhydrated/untouched picker can never wipe a stored value, but an
  // intentional clear IS saved. Reset per card.
  const [rarityTouched, setRarityTouched] = useState(false);
  // The picker seeds from `value` on mount and is uncontrolled after. It is mounted
  // only once `gradingData` is present (so the seed reflects the STORED rarity) and
  // is keyed by certId so switching certs remounts + re-seeds — both derived from the
  // query, so no effect-ordering race can strand it. (The picker emits ONLY on real
  // interaction now, so handleRarityChange = a genuine edit → touched.)
  function handleRarityChange(v: StructuredCardVariant) {
    setRarityTouched(true);
    setRarityCode(v.rarity ?? "");
    setFinishVariant(v.finish ?? "");
    setPromoType(v.promo ?? "");
  }
  // Set CODE captured when a set is chosen from the picker (precise autofill key);
  // free-typed set names fall back to the name itself, same as the admin form.
  const [idSetCode, setIdSetCode] = useState("");
  const [idAutofilling, setIdAutofilling] = useState(false);
  const [idRerunBusy, setIdRerunBusy] = useState(false);
  // Re-sync the editable identity fields from the server payload once the on-open
  // identify has resolved them. The panel mounts BEFORE identify finishes, so the
  // seed-from-props above runs with stale/empty values; when the resolved name
  // arrives in gradingData we fill ONLY the fields the grader has left empty (so
  // their own edits are never stomped). graderMode-only — these fields don't
  // exist otherwise. This is what makes a freshly-scanned card show its real name
  // (and stops the empty field from persisting "" back over it on auto-save).
  useEffect(() => {
    if (!graderMode || !gradingData) return;
    const gd: any = gradingData;
    if (gd.cardName && !idName) setIdName(String(gd.cardName).toUpperCase());
    if (gd.setName && !idSet) setIdSet(String(gd.setName));
    if (gd.cardNumber && !idNumber) setIdNumber(String(gd.cardNumber));
    if (gd.year && !idYear) setIdYear(String(gd.year));
    if (gd.variant && !idVariant) setIdVariant(String(gd.variant));
    // Intentionally fills only empty fields once on data arrival — id* values are
    // deliberately not deps (they'd re-fire and could re-fill after a grader edit).
  }, [gradingData, graderMode]);
  // Structured rarity hydration — runs for BOTH graderMode and adminReview (the
  // Rarity stage renders on all role routes), so /admin/staff's picker loads the
  // stored rarity/finish/promo too. Fills only-when-empty, same pattern as above.
  useEffect(() => {
    if (!(graderMode || adminReview) || !gradingData) return;
    const gd: any = gradingData;
    if (gd.rarityCode && !rarityCode) setRarityCode(String(gd.rarityCode));
    if (gd.finishVariant && !finishVariant) setFinishVariant(String(gd.finishVariant));
    if (gd.promoType && !promoType) setPromoType(String(gd.promoType));
    // Keeps local rarity* state coherent for untouched saves. The picker itself seeds
    // from `gradingData` directly at render (not this state), so its display never
    // depends on this effect winning any ordering race against the per-card reset.
    // Fills only-when-empty on data arrival; the rarity* values are deliberately
    // not deps (same pattern as the identity hydration effect above).
  }, [gradingData, graderMode, adminReview]);
  // Card autofill — mirrors CertificateForm.handleAutofill: set(+number) → card
  // master → fill name/year/variant. Same /api/cards/autofill endpoint + pattern.
  async function graderAutofill() {
    const lookupSetId = (idSetCode || idSet).trim();
    if (!lookupSetId || !idNumber.trim()) return;
    setIdAutofilling(true);
    try {
      const result = await autofillCard({
        setId: lookupSetId,
        cardNumber: idNumber,
        language: "English",
        allowFallbackLanguage: true,
      });
      const m = result.match;
      if (m) {
        if (m.cardName) setIdName(m.cardName.toUpperCase());
        if (m.year) setIdYear(m.year);
        if (m.variant) setIdVariant(m.variant);
        if (result.setName) setIdSet(result.setName);
        toast({ title: "Card details auto-filled" });
      } else {
        toast({ title: "No match found", description: "Check set + number, or enter details manually." });
      }
    } catch (e: any) {
      toast({ title: "Auto-fill failed", description: e.message, variant: "destructive" });
    } finally {
      setIdAutofilling(false);
    }
  }

  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);

  // Wall-clock timestamp when this certificate's grading panel mounted.
  // Sent on approve as `grading_time_seconds` so the dashboard can show a
  // real average instead of "—". Server caps at 1800s (30 min) — anything
  // longer is almost certainly a coffee break, not real grading effort.
  // Reset on certId change so a navigate-to-next-cert resets the clock.
  const gradingStartedAtRef = useRef<number>(Date.now());
  useEffect(() => {
    gradingStartedAtRef.current = Date.now();
  }, [certId]);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  // v413 auto-save: tracks the background save status. "saving" while a debounced
  // PUT is in flight; "saved" after a successful save (cleared after a few seconds);
  // "error" if the save failed. Idle = nothing to indicate.
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Background card-tool crop upload status — PER SIDE. Owned here (not in
  // ManualCardTool) so the upload + retry survive the tool closing, and so the
  // Approve gate can block on it. "pending"/"failed" HARD-BLOCK approval — a
  // backgrounded crop that hasn't persisted to R2 + the DB image path must
  // never finalise a cert. Front and back are tracked independently so an
  // in-flight back upload can't clobber a still-pending front one (and v.v.).
  type CropSideSync = { status: "idle" | "pending" | "synced" | "failed"; payload: any | null };
  const [cropSync, setCropSync] = useState<{ front: CropSideSync; back: CropSideSync }>({
    front: { status: "idle", payload: null },
    back: { status: "idle", payload: null },
  });
  // One auto-clear timer per side so a front "synced→idle" never cancels back's.
  const cropSyncedTimerRef = useRef<{
    front: ReturnType<typeof setTimeout> | null;
    back: ReturnType<typeof setTimeout> | null;
  }>({
    front: null,
    back: null,
  });
  const cropFailedSides = (["front", "back"] as const).filter((s) => cropSync[s].status === "failed");
  const cropPendingSides = (["front", "back"] as const).filter((s) => cropSync[s].status === "pending");
  const cropSyncBlocking = cropFailedSides.length > 0 || cropPendingSides.length > 0;
  const [gradeApprovedAt, setGradeApprovedAt] = useState<string | null>(null);
  const [gradeApprovedBy, setGradeApprovedBy] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Post-approval edit-mode gate. Pre-approval is unchanged (auto-save still
  // runs as a draft mechanism). Post-approval, edits to the live record
  // require explicit Save — see saveEditedGrade() and cancelEdit() below.
  const [editMode, setEditMode] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  type EditSnapshot = {
    frontLR: string;
    frontTB: string;
    backLR: string;
    backTB: string;
    corners: CornerValues;
    edges: EdgeValues;
    surface: SurfaceValues;
    defects: Defect[];
    defectCandidates: DefectCandidate[];
    authStatus: AuthStatus;
    authNotes: string;
    privateNotes: string;
    gradeExplanation: string;
    centeringOverride: number | null;
    cornersOverride: number | null;
    edgesOverride: number | null;
    surfaceOverride: number | null;
    overallOverride: number | null;
    // MVGS v2 measurement inputs — captured in the snapshot so the
    // Cancel/Undo edit path restores them too.
    whiteningLines: Array<{
      side: "front" | "back";
      edge: "top" | "right" | "bottom" | "left";
      coveragePct: number;
      start?: { x: number; y: number };
      end?: { x: number; y: number };
    }>;
    // MVGS v2.1 multi-crease list. Replaces creaseSpanPct + creaseSegment.
    creaseLines: Array<{
      id: string;
      side: "front" | "back";
      spanPct: number;
      start: { x: number; y: number };
      end: { x: number; y: number };
      color?: string;
    }>;
    wrinkleSeverity: "tiny_back" | "longer_back" | "small_front" | "multiple_front" | null;
    tearSeverity: "minor" | "significant" | "major" | null;
  };
  const editSnapshotRef = useRef<EditSnapshot | null>(null);

  /**
   * Clear overallOverride if currently set, toasting once so the grader sees
   * what happened. Called from every sub-grade / centering value edit: the
   * saved overall is stale the moment a grader changes any input.
   */
  function clearOverallOverrideIfSet() {
    if (overallOverride !== null) {
      setOverallOverride(null);
      toast({
        title: "Override cleared",
        description: "Overall grade now recomputed from sub-grades",
      });
    }
  }

  /**
   * STEP 4 measurement-integrity guard. When the operator RE-STRAIGHTENS or
   * re-crops a side via the Manual Crop (perspective) tool AFTER that side's
   * centering was committed, the committed centering was measured against the
   * OLD crop/rotation and is now stale — so we clear it and force a "Redo
   * centering". This guarantees the MVGS centering/grade never reads off
   * pre-straighten numbers. (The Card Tool path needs no guard: its Compute
   * derives the crop, deskew and centering from the SAME 8 dots in one gesture,
   * so they can never diverge.) No-op + silent when nothing was committed for
   * the side. Non-destructive: clears in-memory state only; the cert's centering
   * columns are overwritten by the next manual-centering save.
   */
  function invalidateCenteringForSide(side: "front" | "back") {
    const hadCentering =
      side === "front" ? !!(frontLR || frontTB || manualOuterFront) : !!(backLR || backTB || manualOuterBack);
    if (!hadCentering) return;
    if (side === "front") {
      setFrontLR("");
      setFrontTB("");
      setManualOuterFront(null);
      setManualInnerFront(null);
    } else {
      setBackLR("");
      setBackTB("");
      setManualOuterBack(null);
      setManualInnerBack(null);
    }
    setCenteringOverride(null);
    clearOverallOverrideIfSet();
    toast({
      title: `${side} re-straightened — centering cleared`,
      description: "Redo centering on the straightened image so the grade matches.",
      variant: "destructive",
    });
  }

  // Quick-grade mode REMOVED (owner directive 2026-07-01): manual sub-grade
  // typing bypassed the card-tool + defect-marking pipeline. Grading is now
  // 100% MVGS — the card tool (centering) and defect pins drive every sub-grade.

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        if (gradingWorkflowLockedRef.current) {
          toast({
            title: gradingErrorRef.current ? "Grading workflow unavailable" : "Checking approval state",
            description: "Wait for this card's workflow data before saving changes.",
            variant: gradingErrorRef.current ? "destructive" : undefined,
          });
          return;
        }
        saveDraft();
      } else if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        if (gradingWorkflowLockedRef.current) {
          toast({
            title: gradingErrorRef.current ? "Grading workflow unavailable" : "Checking approval state",
            description: "Wait for this card's workflow data before submitting changes.",
            variant: gradingErrorRef.current ? "destructive" : undefined,
          });
          return;
        }
        // Pre-grade checklist gate — Ctrl+Enter shortcut must respect the
        // deionization checkbox the same way the Approve button does.
        if (!deionizationComplete) {
          toast({ title: "Confirm deionization first", description: "Tick 'Deionization complete' before approving." });
          return;
        }
        const cropBlock = cropGateBlockToast();
        if (cropBlock) {
          toast(cropBlock);
          return;
        }
        setShowConfirm(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line
  }, []);

  // Populate from saved grading data
  useEffect(() => {
    if (!gradingData) return;
    if (gradingData.centeringFrontLr) setFrontLR(gradingData.centeringFrontLr);
    if (gradingData.centeringFrontTb) setFrontTB(gradingData.centeringFrontTb);
    if (gradingData.centeringBackLr) setBackLR(gradingData.centeringBackLr);
    if (gradingData.centeringBackTb) setBackTB(gradingData.centeringBackTb);
    if (gradingData.corners) setCorners(gradingData.corners);
    if (gradingData.edges) setEdges(gradingData.edges);
    if (gradingData.surface) setSurface(gradingData.surface);
    if (gradingData.defects && Array.isArray(gradingData.defects)) setDefects(gradingData.defects);
    if ((gradingData as any).aiDefectCandidates && Array.isArray((gradingData as any).aiDefectCandidates)) {
      setDefectCandidates((gradingData as any).aiDefectCandidates as DefectCandidate[]);
    }
    // Hydrate per-side flags, with fallback to legacy single dark_border
    // for rows that pre-date the split.
    {
      const g = gradingData as any;
      const legacy = typeof g.darkBorder === "boolean" ? g.darkBorder : false;
      if (typeof g.darkBorderFront === "boolean") setDarkBorderFront(g.darkBorderFront);
      else if (typeof g.darkBorder === "boolean") setDarkBorderFront(legacy);
      if (typeof g.darkBorderBack === "boolean") setDarkBorderBack(g.darkBorderBack);
      else if (typeof g.darkBorder === "boolean") setDarkBorderBack(legacy);
    }
    // Hydrate MVGS v2 measurement inputs from the cert row. Server columns
    // are nullable / default-empty so legacy certs read as "no measurement"
    // and the legacy boolean fallback applies via mvgs-input-builder.
    {
      const g = gradingData as any;
      if (Array.isArray(g.whiteningLines)) setWhiteningLines(g.whiteningLines);
      // Hydrate the multi-crease list. v2.1 column comes first; back-compat
      // synth from the legacy single creaseSpanPct fires only when the new
      // array is empty AND the legacy column is non-null (preserves the
      // persisted span% even though the segment is unknown for that path).
      if (Array.isArray(g.creaseLines) && g.creaseLines.length > 0) {
        setCreaseLines(g.creaseLines as typeof creaseLines);
      } else if (g.creaseSpanPct != null) {
        setCreaseLines([
          {
            id: `legacy-${certId}`,
            side: "front",
            spanPct: Number(g.creaseSpanPct),
            start: { x: 0, y: 0 },
            end: { x: 0, y: 0 },
          },
        ]);
      }
      if (g.wrinkleSeverity) setWrinkleSeverity(g.wrinkleSeverity);
      if (g.tearSeverity) setTearSeverity(g.tearSeverity);
    }
    if (typeof (gradingData as any).eyeAppealModifier === "number")
      setEyeAppealModifier((gradingData as any).eyeAppealModifier);
    if (gradingData.authStatus) setAuthStatus(gradingData.authStatus);
    if (gradingData.authNotes) setAuthNotes(gradingData.authNotes);
    if (gradingData.privateNotes) setPrivateNotes(gradingData.privateNotes);
    if (gradingData.gradeExplanation) setGradeExplanation(gradingData.gradeExplanation);
    const nextGradeApprovedAt = (gradingData as any).gradeApprovedAt
      ? String((gradingData as any).gradeApprovedAt)
      : null;
    const nextGradeApprovedBy = gradingData.gradeApprovedBy ? String(gradingData.gradeApprovedBy) : null;
    setGradeApprovedAt(nextGradeApprovedAt);
    setGradeApprovedBy(nextGradeApprovedBy);
    setApproved(!!(nextGradeApprovedAt || nextGradeApprovedBy));
    // Manual centering frame rects (persisted)
    if (gradingData.centeringOuterFront) setManualOuterFront(gradingData.centeringOuterFront);
    if (gradingData.centeringInnerFront) setManualInnerFront(gradingData.centeringInnerFront);
    if (gradingData.centeringOuterBack) setManualOuterBack(gradingData.centeringOuterBack);
    if (gradingData.centeringInnerBack) setManualInnerBack(gradingData.centeringInnerBack);
    if (gradingData.centeringMethod) setCenteringMethod(gradingData.centeringMethod);
    // Hydrate saved aggregate subgrades as overrides
    if (gradingData.cornersScore != null) setCornersOverride(Number(gradingData.cornersScore));
    if (gradingData.edgesScore != null) setEdgesOverride(Number(gradingData.edgesScore));
    if (gradingData.surfaceScore != null) setSurfaceOverride(Number(gradingData.surfaceScore));
    // Manual overall-override removed (owner directive 2026-07-01): the overall
    // grade is 100% MVGS auto, so we no longer seed a manual override from the
    // saved grade on open. Overall always recomputes from the sub-grades / MVGS.
    // Centering: prefer letting centeringCalc derive from L/R + T/B ratios.
    // Fallback: if ratios are missing but a centering_score was saved, use it
    // as an override so the Overall formula still has a value to weight.
    const hasCenteringRatios = !!(
      gradingData.centeringFrontLr &&
      gradingData.centeringFrontTb &&
      gradingData.centeringBackLr &&
      gradingData.centeringBackTb
    );
    if (!hasCenteringRatios && gradingData.centeringScore != null) {
      setCenteringOverride(Number(gradingData.centeringScore));
    }

    // Option B: subgrade hydration reads ONLY from persisted cert columns.
    // The previous fallback to `ai_analysis.grading` is removed — under
    // Option B, scan-ingest does not write a `grading` payload at all, so
    // new scans must initialise empty and wait for the admin's manual
    // grading. Legacy certs (the 145 TEST cards + the Opus-graded MV1 from
    // v406 validation) keep working: their persisted columns hold the
    // graded values. Anything that lived only in ai_analysis JSONB will
    // now load empty — accepted trade-off per the Option B rework.
  }, [gradingData]);

  // AI analysis state
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysisResult | null>(null);
  const [aiIdentification, setAiIdentification] = useState<AiIdentification | null>(null);
  // Track which subgrades were set by AI (key) vs manually changed
  const [aiSources, setAiSources] = useState<Partial<Record<"centering" | "corners" | "edges" | "surface", number>>>(
    {}
  );

  // ── v413/v414 — hooks moved here from below the `if (!hasAnyImage)` early
  // return. Originally PR #51 placed these inline near the related logic; the
  // early return at `hasAnyImage` meant first-render (imageData still loading)
  // skipped them, second-render called them — different hook count → React
  // bailout → white screen. Keep ALL hooks above any conditional return.

  // AI baseline derivations — used to flag AI-suggested vs admin-overridden
  // subgrades and surface low-confidence hints. Pre-Option-A certs (Option B
  // / legacy) won't have a `grading` key here; everything below treats null
  // as "no AI baseline available".
  const aiGradingBase = (gradingData as any)?.aiAnalysis?.grading as
    | {
        centering?: { subgrade?: number };
        corners?: { subgrade?: number };
        edges?: { subgrade?: number };
        surface?: { subgrade?: number };
        overall_grade?: number;
        confidence?: { centering?: string; corners?: string; edges?: string; surface?: string; overall?: string };
      }
    | undefined;

  const aiSubgrades = useMemo(
    () => ({
      centering: aiGradingBase?.centering?.subgrade ?? null,
      corners: aiGradingBase?.corners?.subgrade ?? null,
      edges: aiGradingBase?.edges?.subgrade ?? null,
      surface: aiGradingBase?.surface?.subgrade ?? null,
    }),
    [aiGradingBase]
  );

  const aiConfidenceMap = useMemo(
    () => ({
      centering: (aiGradingBase?.confidence?.centering as "high" | "medium" | "low" | undefined) ?? null,
      corners: (aiGradingBase?.confidence?.corners as "high" | "medium" | "low" | undefined) ?? null,
      edges: (aiGradingBase?.confidence?.edges as "high" | "medium" | "low" | undefined) ?? null,
      surface: (aiGradingBase?.confidence?.surface as "high" | "medium" | "low" | undefined) ?? null,
    }),
    [aiGradingBase]
  );

  // Auto-save refs + debounced effect. autoSaveNow is a plain function
  // declaration (hoisted within this scope) so it can call setters / refs
  // declared just above it, and reference buildPayload() which is declared
  // further down (also hoisted).
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveSeqRef = useRef(0);
  /** The certId GET /grading has actually returned for. While this does not
   *  equal the current certId the panel's state is UI defaults, not grading
   *  evidence, and nothing may be persisted (PR A). */
  const gradingHydratedForRef = useRef<number | null>(null);
  const autoSavedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedOnceRef = useRef(false);

  useEffect(() => {
    setGradeApprovedAt(null);
    setGradeApprovedBy(null);
    setApproved(false);
    setEditMode(false);
    editSnapshotRef.current = null;
    hydratedOnceRef.current = false;
    // gradingHydratedForRef is deliberately NOT reset here — it stores the certId
    // it hydrated for, so it invalidates itself on a card switch. Clearing it
    // here would race the hydration effect declared above (see its comment).
    setFrontLR("");
    setFrontTB("");
    setBackLR("");
    setBackTB("");
    setCorners(DEFAULT_CORNERS);
    setEdges(DEFAULT_EDGES);
    setSurface(DEFAULT_SURFACE);
    setDefects([]);
    setDefectCandidates([]);
    setAuthStatus("genuine");
    setAuthNotes("");
    setPrivateNotes("");
    setGradeExplanation("");
    setCenteringOverride(null);
    setCornersOverride(null);
    setEdgesOverride(null);
    setSurfaceOverride(null);
    setOverallOverride(null);
    setRarityCode("");
    setFinishVariant("");
    setPromoType("");
    setRarityTouched(false);
  }, [certId]);

  // ── Post-approval explicit-save flow ──────────────────────────────────
  function captureEditSnapshot(): EditSnapshot {
    return {
      frontLR,
      frontTB,
      backLR,
      backTB,
      corners,
      edges,
      surface,
      defects: [...defects],
      defectCandidates: [...defectCandidates],
      authStatus,
      authNotes,
      privateNotes,
      gradeExplanation,
      centeringOverride,
      cornersOverride,
      edgesOverride,
      surfaceOverride,
      overallOverride,
      whiteningLines: [...whiteningLines],
      creaseLines: [...creaseLines],
      wrinkleSeverity,
      tearSeverity,
    };
  }

  function restoreEditSnapshot(s: EditSnapshot) {
    setFrontLR(s.frontLR);
    setFrontTB(s.frontTB);
    setBackLR(s.backLR);
    setBackTB(s.backTB);
    setCorners(s.corners);
    setEdges(s.edges);
    setSurface(s.surface);
    setDefects(s.defects);
    setDefectCandidates(s.defectCandidates);
    setAuthStatus(s.authStatus);
    setAuthNotes(s.authNotes);
    setPrivateNotes(s.privateNotes);
    setGradeExplanation(s.gradeExplanation);
    setCenteringOverride(s.centeringOverride);
    setCornersOverride(s.cornersOverride);
    setEdgesOverride(s.edgesOverride);
    setSurfaceOverride(s.surfaceOverride);
    setOverallOverride(s.overallOverride);
    setWhiteningLines(s.whiteningLines);
    setCreaseLines(s.creaseLines);
    setWrinkleSeverity(s.wrinkleSeverity);
    setTearSeverity(s.tearSeverity);
  }

  function enterEditMode() {
    editSnapshotRef.current = captureEditSnapshot();
    setEditMode(true);
  }

  function cancelEdit() {
    if (editSnapshotRef.current) restoreEditSnapshot(editSnapshotRef.current);
    editSnapshotRef.current = null;
    setEditMode(false);
  }

  useEffect(() => {
    if (correctionMode && gradeApprovedAt && !editMode) {
      editSnapshotRef.current = captureEditSnapshot();
      setEditMode(true);
    }
    if (!correctionMode && editMode && editSnapshotRef.current) {
      restoreEditSnapshot(editSnapshotRef.current);
      editSnapshotRef.current = null;
      setEditMode(false);
    }
  }, [correctionMode, gradeApprovedAt]);

  async function saveEditedGrade(): Promise<void> {
    setEditSaving(true);
    try {
      const res = await fetch(`${apiBase}/certificates/${certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      // Cache invalidation — everything that reads from certificates.grade or
      // its subgrades. RQ will refetch on next access; not forcing immediate
      // refetch so we don't thrash. Keys mirror the existing approveGrade()
      // invalidation set plus public logbook + verify endpoints.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/grading`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/printing/browser"] });
      // Editing an ALREADY-APPROVED grade changes what the label will print, so the
      // Ready To Print queue must not keep serving the pre-edit row. (The call that
      // first makes a cert print-eligible is approveGrade() — it invalidates these
      // same keys.) The global client sets staleTime: Infinity, so without this the
      // queue could show stale contents for the rest of the session on this machine.
      // Both base variants: the queue registers its key from its own apiBase, which
      // is "/api/admin" for the admin surface and "/api/staff/print" for a
      // print-capable staff surface. Invalidating a key nothing registered is a
      // no-op, so covering both keeps this correct for an account that holds BOTH
      // can_grade and can_print without guessing which surface is mounted.
      for (const b of ["/api/admin", "/api/staff/print"]) {
        queryClient.invalidateQueries({ queryKey: [`${b}/printing/workflow/queue`] });
        queryClient.invalidateQueries({ queryKey: [`${b}/printing/workflow/batches`] });
      }
      if (certIdStr) {
        queryClient.invalidateQueries({ queryKey: [`/api/cert/${certIdStr}`] });
        queryClient.invalidateQueries({ queryKey: [`/api/cert/${certIdStr}/report`] });
        queryClient.invalidateQueries({ queryKey: [`/api/v1/verify/${certIdStr}`] });
      }
      toast({ title: "Grade updated · audit logged" });
      editSnapshotRef.current = null;
      setEditMode(false);
    } catch (e: any) {
      // Keep edit mode open so the admin doesn't lose their changes.
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  }

  async function autoSaveNow(): Promise<boolean> {
    const seq = ++autoSaveSeqRef.current;
    setAutoSaveStatus("saving");
    try {
      const res = await fetch(`${apiBase}/certificates/${certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      if (seq !== autoSaveSeqRef.current) return true;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setAutoSaveStatus("saved");
      if (autoSavedClearTimerRef.current) clearTimeout(autoSavedClearTimerRef.current);
      autoSavedClearTimerRef.current = setTimeout(() => {
        if (autoSaveSeqRef.current === seq) setAutoSaveStatus("idle");
      }, 2500);
      return true;
    } catch (e: any) {
      if (seq !== autoSaveSeqRef.current) return false;
      setAutoSaveStatus("error");
      toast({ title: "Auto-save failed", description: e.message, variant: "destructive" });
      return false;
    }
  }

  // Schedule a debounced auto-save whenever any persisted state changes.
  // First render skips (hydratedOnceRef false → set to true) so we don't
  // pointlessly POST back what we just GET'd.
  //
  // POST-APPROVAL GATE: once the cert is live, auto-save is DISABLED. Edits
  // require entering edit mode and clicking Save. This kills the previous
  // "edits save automatically to the live record" silent-write behaviour.
  useEffect(() => {
    // PR A (hostile review M-1) · the ENTIRE lifecycle decision now lives in the
    // shared pure function `decideGradingPersistence`
    // (shared/grading-persistence-lifecycle.ts), so it is proven as BEHAVIOUR in
    // a unit test rather than asserted as source text. This effect only executes
    // the decision it is given.
    const decision = decideGradingPersistence({
      active,
      certId,
      hydratedForCertId: gradingHydratedForRef.current,
      workflowLocked: gradingWorkflowLocked,
      gradeApprovedAt,
      settledAfterHydration: hydratedOnceRef.current,
    });
    // Cancel unconditionally on every NON-arming decision: leaving the Grade
    // stage, switching card, a failed GET or an approval landing must all DROP a
    // debounce armed under the previous state rather than let it fire against
    // the new one. This does not rely on the dependency array happening to run
    // the cleanup below.
    if (decision.cancelPending && autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (decision.markSettled) hydratedOnceRef.current = true;
    if (!decision.arm) return;
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveNow();
    }, 500);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
    // eslint-disable-next-line
  }, [
    certId,
    frontLR,
    frontTB,
    backLR,
    backTB,
    corners,
    edges,
    surface,
    defects,
    defectCandidates,
    authStatus,
    authNotes,
    privateNotes,
    gradeExplanation,
    centeringOverride,
    cornersOverride,
    edgesOverride,
    surfaceOverride,
    overallOverride,
    idName,
    idSet,
    idNumber,
    idYear,
    idVariant,
    gradingWorkflowLocked,
    active,
    // Added with the lifecycle extraction: an approval landing must re-evaluate
    // and CANCEL any pending debounce, not leave it armed from before approval.
    gradeApprovedAt,
  ]);

  function handleAiComplete(analysis: AiAnalysisResult, identification: AiIdentification | null) {
    setAiAnalysis((prev) => (analysis.overall_grade ? analysis : prev));
    setAiIdentification(identification);

    // Populate subgrade overrides from AI (skip zero = "not measured")
    const c = analysis.centering.subgrade;
    const co = analysis.corners.subgrade;
    const e = analysis.edges.subgrade;
    const s = analysis.surface.subgrade;

    // Centering: clear override so centeringCalc (from all 4 ratios) is authoritative
    if (c > 0) setCenteringOverride(null);
    if (co > 0) setCornersOverride(co);
    if (e > 0) setEdgesOverride(e);
    if (s > 0) setSurfaceOverride(s);
    // AI re-ran → any prior manual overall override is stale. Let formula redrive.
    setOverallOverride(null);

    setAiSources((prev) => ({
      ...prev,
      ...(c > 0 ? { centering: c } : {}),
      ...(co > 0 ? { corners: co } : {}),
      ...(e > 0 ? { edges: e } : {}),
      ...(s > 0 ? { surface: s } : {}),
    }));

    // Populate centering ratios
    if (analysis.centering.front_left_right) setFrontLR(analysis.centering.front_left_right);
    if (analysis.centering.front_top_bottom) setFrontTB(analysis.centering.front_top_bottom);
    if (analysis.centering.back_left_right) setBackLR(analysis.centering.back_left_right);
    if (analysis.centering.back_top_bottom) setBackTB(analysis.centering.back_top_bottom);

    // Populate corners (skip if subgrade is 0 = not measured)
    if (co > 0) {
      const co2 = analysis.corners;
      setCorners({
        frontTL: co2.front_top_left?.grade ?? 10,
        frontTR: co2.front_top_right?.grade ?? 10,
        frontBL: co2.front_bottom_left?.grade ?? 10,
        frontBR: co2.front_bottom_right?.grade ?? 10,
        backTL: co2.back_top_left?.grade ?? 10,
        backTR: co2.back_top_right?.grade ?? 10,
        backBL: co2.back_bottom_left?.grade ?? 10,
        backBR: co2.back_bottom_right?.grade ?? 10,
      });
    }

    // Populate edges (skip if subgrade is 0)
    if (e > 0) {
      const ed = analysis.edges;
      setEdges({
        frontTop: ed.front_top?.grade ?? 10,
        frontBottom: ed.front_bottom?.grade ?? 10,
        frontLeft: ed.front_left?.grade ?? 10,
        frontRight: ed.front_right?.grade ?? 10,
        backTop: ed.back_top?.grade ?? 10,
        backBottom: ed.back_bottom?.grade ?? 10,
        backLeft: ed.back_left?.grade ?? 10,
        backRight: ed.back_right?.grade ?? 10,
      });
    }

    // Populate surface (skip if subgrade is 0)
    if (s > 0) {
      setSurface((prev) => ({
        ...prev,
        front: analysis.surface.front_grade ?? 10,
        back: analysis.surface.back_grade ?? 10,
      }));
    }

    // Populate surface defect flags from defects array (always update if defects present)
    if (analysis.defects?.length > 0) {
      setSurface((prev) => ({
        ...prev,
        hasHoloScratches: analysis.defects?.some((d) => d.type === "holo_scratch"),
        hasSurfaceScratches: analysis.defects?.some((d) => d.type === "scratch"),
        hasPrintLines: analysis.defects?.some((d) => d.type === "print_line"),
        hasStaining: analysis.defects?.some((d) => d.type === "stain"),
        hasCrease: analysis.defects?.some((d) => d.type === "crease"),
        hasTear: analysis.defects?.some((d) => d.type === "tear"),
      }));
    }

    // Convert AI defects to Defect format and merge with any existing human defects
    if (analysis.defects?.length > 0) {
      const humanDefects = defects.filter((d: any) => !d._aiSource);
      const maxHumanId = humanDefects.length > 0 ? Math.max(...humanDefects.map((d) => d.id)) : 0;
      const aiDefects: Defect[] = analysis.defects.map((ad, i) => {
        const imageSide: "front" | "back" = ad.location === "back" ? "back" : "front";
        const xPercent = ad.position_x_percent ?? 50;
        const yPercent = ad.position_y_percent ?? 50;
        // Stamp mvgsCode + tier + zone at AI-ingest time so the pin reaches the
        // engine via buildPayload (which filters on all three fields). Without
        // this, AI pins were silently dropped until the operator clicked
        // Recalculate — MV33's 37 stain pins are the witness of that.
        // Default tier D2: matches manually-placed quick-clicks, never claims
        // higher severity than the AI can warrant. Operator sees the red
        // _aiSource ring on every AI pin and can raise to D1 (heavy stain) or
        // lower to D3 (factory artefact) during review — they're never
        // invisible-but-scoring.
        const mvgsCode = mapLegacyTypeToMvgsCode(ad.type) ?? undefined;
        const zone = deriveZone({ xPercent, yPercent, imageSide });
        return {
          id: maxHumanId + 1000 + i, // high IDs to avoid collision with human defects
          type: ad.type?.replace(/_/g, " ") || "Unknown",
          severity: (ad.severity === "major" ? "significant" : ad.severity === "moderate" ? "moderate" : "minor") as
            | "minor"
            | "moderate"
            | "significant",
          description: ad.description || "",
          location: ad.location || (ad as any).detected_in || "front",
          image_side: imageSide,
          x_percent: xPercent,
          y_percent: yPercent,
          // MVGS engine fields — stamped only when the AI's type maps to a
          // known MVGS code. Unknown / unmapped AI types remain unscored
          // until the operator labels them via the popover (same fall-back
          // behaviour as before, just for the AI types we can't classify).
          ...(mvgsCode ? { mvgsCode, tier: "D2" as const, zone } : {}),
          _aiSource: true, // flag so image-viewer can render as red ring
        } as Defect & { _aiSource: boolean };
      });
      setDefects([...humanDefects, ...aiDefects]);
    }

    // Populate grade explanation
    if (analysis.grade_explanation) setGradeExplanation(analysis.grade_explanation);

    // Populate auth status
    if (!analysis.is_authentic) setAuthStatus("not_original");
    else if (analysis.is_altered) setAuthStatus("authentic_altered");
    if (analysis.authentication_notes) setAuthNotes(analysis.authentication_notes);

    // Notify parent to refresh cert data (AI autofills card name/set/number on the server)
    onCertUpdated?.();

    // TCGdex prefill: if the AI extracted a set code, query TCGdex for canonical metadata
    if (identification?.set_code && identification.detected_number) {
      console.info("[tcgdex-prefill] firing lookup", {
        code: identification.set_code,
        number: identification.detected_number,
        lang: identification.detected_language,
      });
      runTcgdexLookup(identification.set_code, identification.detected_number, identification.detected_language);
    } else if (identification) {
      console.info("[tcgdex-prefill] skipped — no set_code/number from identify", {
        set_code: identification.set_code,
        detected_number: identification.detected_number,
      });
    }
  }

  /** Fire TCGdex lookup and prefill set/name fields with canonical data */
  async function runTcgdexLookup(setCode: string, cardNumber: string, language?: string) {
    // Map common language names to TCGdex lang codes
    const langMap: Record<string, string> = {
      english: "en",
      japanese: "ja",
      french: "fr",
      german: "de",
      spanish: "es",
      italian: "it",
      portuguese: "pt",
      korean: "ko",
      "traditional chinese": "zh-tw",
      "simplified chinese": "zh-cn",
    };
    const lang = langMap[(language || "english").toLowerCase()] || "en";

    try {
      // Staff endpoint (admin OR grader) so this works on the grader panel too —
      // the admin-only /api/admin/tcgdex-lookup silently 401'd for graders before.
      const res = await fetch(
        `/api/staff/tcgdex-lookup?code=${encodeURIComponent(setCode)}&number=${encodeURIComponent(cardNumber)}&lang=${encodeURIComponent(lang)}`,
        { credentials: "include" }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (!data.found) return;

      // Prefill with canonical TCGdex data (keep fields editable)
      if (data.card_name) setIdName(data.card_name.toUpperCase());
      if (data.set_name) setIdSet(data.set_name);
      if (data.set_id) setIdSetCode(data.set_id);
      if (data.release_date) {
        const year = data.release_date.split("-")[0];
        if (year) setIdYear(year);
      }
      // Variant: best-effort only — don't overwrite if uncertain
      // TCGdex rarity != MintVault variant taxonomy

      const badge = data.auto_added ? " (set auto-added)" : data.needs_manual_add ? " (set needs manual add)" : "";
      toast({ title: `TCGdex: ${data.card_name}${badge}`, description: `Set: ${data.set_name} · Source: TCGdex` });
    } catch {
      // Silent fail — TCGdex lookup is best-effort, form stays editable
    }
  }

  /** Re-run the server identify path on demand (re-fires Haiku identify + TCG
   *  verify and refreshes the status light above). Identify ONLY — never grades,
   *  so it's safe to press at any time. Works for graders (proxied) and admins. */
  async function rerunIdentify() {
    setIdRerunBusy(true);
    try {
      const res = await fetch(`${apiBase}/certificates/${certId}/identify`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Re-identify failed");
      const ident = data.identification || {};
      // EnrichedCardData shape: prefer the verified official* fields, fall back to
      // the AI detected_* ones. Prefill ONLY empty fields so a grader's own edits
      // aren't stomped.
      const name = ident.officialName || ident.detected_name || "";
      const setName = ident.officialSet || ident.detected_set || "";
      const number = ident.officialNumber || ident.detected_number || "";
      const year = ident.detected_year || ident.copyright_year || "";
      if (name && !idName.trim()) setIdName(String(name).toUpperCase());
      if (setName && !idSet.trim()) setIdSet(String(setName));
      if (ident.set_code && !idSetCode.trim()) setIdSetCode(String(ident.set_code));
      if (number && !idNumber.trim()) setIdNumber(String(number));
      if (year && !idYear.trim()) setIdYear(String(year));
      // Refresh the grading payload so the TCGdex status light re-derives.
      queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/grading`] });
      toast({ title: "Re-ran identification", description: name ? `TCGdex: ${name}` : "Status updated." });
    } catch (e: any) {
      toast({ title: "Re-identify failed", description: e.message, variant: "destructive" });
    } finally {
      setIdRerunBusy(false);
    }
  }

  /** Fill the identity fields from a card picked in the TCG card-search pop-down. */
  function applyCardPick(c: TcgCardPick) {
    if (c.name) setIdName(c.name.toUpperCase());
    if (c.setName) setIdSet(c.setName);
    if (c.setCode) setIdSetCode(c.setCode);
    if (c.number) setIdNumber(c.number);
    if (c.year) setIdYear(c.year);
    toast({ title: `Filled from ${c.name}`, description: c.setName || undefined });
  }

  /**
   * Populate all sub-grade overrides + zone values from the last AI analysis
   * that ran during this session. Clears overallOverride so the formula
   * re-derives from the AI sub-grades. Gated on in-session aiAnalysis —
   * on a cold reload without a fresh AI run, the button is disabled.
   */
  function handleRevertToAi() {
    if (approvalInteractionLocked) {
      toast({
        title: "Workflow locked",
        description: gradingWorkflowStatusCopy,
        variant: gradingError ? "destructive" : undefined,
      });
      return;
    }
    if (!aiAnalysis) {
      toast({
        title: "No AI draft in this session",
        description: "Run AI Identify & Grade first",
        variant: "destructive",
      });
      return;
    }
    const c = aiAnalysis.centering?.subgrade ?? 0;
    const co = aiAnalysis.corners?.subgrade ?? 0;
    const e = aiAnalysis.edges?.subgrade ?? 0;
    const s = aiAnalysis.surface?.subgrade ?? 0;

    if (c > 0) setCenteringOverride(null);
    if (co > 0) setCornersOverride(co);
    if (e > 0) setEdgesOverride(e);
    if (s > 0) setSurfaceOverride(s);
    setOverallOverride(null);

    if (aiAnalysis.centering?.front_left_right) setFrontLR(aiAnalysis.centering.front_left_right);
    if (aiAnalysis.centering?.front_top_bottom) setFrontTB(aiAnalysis.centering.front_top_bottom);
    if (aiAnalysis.centering?.back_left_right) setBackLR(aiAnalysis.centering.back_left_right);
    if (aiAnalysis.centering?.back_top_bottom) setBackTB(aiAnalysis.centering.back_top_bottom);

    toast({ title: "Reverted to AI draft", description: "Review and approve to save" });
  }

  // pendingAnalysis is passed through to AiPanel via externalAnalysis prop

  // ── v416 — derived consts + buildPayload moved ABOVE the `if (!hasAnyImage)`
  // early return. Pre-v416 these lived after the early return, which meant
  // any render that took the early-return branch left `centering`,
  // `cornersGrade`, …, `finalGradeOverall` in TDZ. Hoisted `buildPayload`
  // (called from `autoSaveNow` via setTimeout) then crashed on first read of
  // `finalGradeOverall` → minified `qt` → "Cannot access 'qt' before
  // initialization". All these consts are pure derivations from state with
  // initialised defaults (DEFAULT_CORNERS / nulls) — safe to compute even
  // when no images are present yet.

  // Calculated subgrades. centeringCalc uses the strict variant: null until
  // all four ratios are present and valid, so CenteringInput shows no auto
  // subgrade for a partially-filled card.
  const centeringCalc = centeringSubgradeStrict(frontLR, frontTB, backLR, backTB)?.subgrade ?? null;
  const centering = centeringOverride ?? centeringCalc ?? 10;
  const cornersCalc = calcCornerSubgrade(corners);
  const edgesCalc = calcEdgeSubgrade(edges);
  const cornersGrade = cornersOverride ?? cornersCalc.grade;
  const edgesGrade = edgesOverride ?? edgesCalc.grade;

  // MVGS derivations — moved above surfaceGrade because the surface UI no
  // longer has manual front/back selectors; surfaceGrade is now driven by
  // mvgsSurfaceGrade (the surface deduction from the scoring engine). Once
  // any defect is MVGS-classified the engine also drives the headline
  // grade (admin's overallOverride still wins over MVGS, which wins over AI).
  // MVGS v2 — scoreMvgsV2 routes through buildMvgsInput which enforces
  // measurement-wins-over-checkbox precedence. Client uses
  // DEFAULT_MVGS_CALIBRATION for the live preview; server's authoritative
  // compute on approve loads the persisted calibration row.
  // Memoised: scoreMvgsV2 loops over every defect multiple times, and this
  // component re-renders on every keystroke (notes, centering inputs, etc.).
  // Deps are exactly the inputs the engine reads — recompute only when one of
  // them actually changes, not on every render.
  const mvgsForOverall = useMemo(
    () =>
      scoreMvgsV2(
        {
          centeringFrontLr: frontLR || null,
          centeringFrontTb: frontTB || null,
          centeringBackLr: backLR || null,
          centeringBackTb: backTB || null,
          defects: (defects || [])
            .filter((d) => d.mvgsCode && d.tier && d.zone)
            .map((d) => ({ mvgsCode: d.mvgsCode!, tier: d.tier!, zone: d.zone! })),
          darkBorderFront,
          darkBorderBack,
          eyeAppealModifier,
          whiteningLines,
          // v2.1 — multi-crease list. Engine derives max(spanPct) at the builder
          // boundary. creaseSpanPct legacy field omitted; the builder prefers
          // creaseLines when both are present anyway.
          creaseLines,
          wrinkleSeverity,
          tearSeverity,
          hasCrease: !!surface.hasCrease,
          hasTear: !!surface.hasTear,
        },
        DEFAULT_MVGS_CALIBRATION
      ),
    [
      frontLR,
      frontTB,
      backLR,
      backTB,
      defects,
      darkBorderFront,
      darkBorderBack,
      eyeAppealModifier,
      whiteningLines,
      creaseLines,
      wrinkleSeverity,
      tearSeverity,
      surface.hasCrease,
      surface.hasTear,
    ]
  );
  const hasMvgsPins = (defects || []).some((d) => d.mvgsCode);

  // MVGS subgrades. Centering comes straight from the shared PSA chart
  // (worst of the four axes) — the SAME number that scores the card and that
  // the chip/toast display, so they can never diverge. Corners/edges/surface
  // keep the 25-pt budget bucket (remaining points → 1-10).
  const mvgsCenteringGrade = centeringSubgrade(
    frontLR || null,
    frontTB || null,
    backLR || null,
    backTB || null
  ).subgrade;
  const mvgsCornersGrade = mvgsRemainingToGrade(25 - Math.abs(mvgsForOverall.deductions.corners ?? 0));
  const mvgsEdgesGrade = mvgsRemainingToGrade(25 - Math.abs(mvgsForOverall.deductions.edges ?? 0));
  const mvgsSurfaceGrade = mvgsRemainingToGrade(25 - Math.abs(mvgsForOverall.deductions.surface ?? 0));

  // Surface subgrade is now MVGS-derived (was Math.min(front, back) from
  // the old manual SurfaceGrading dropdowns). Admin's explicit override
  // still wins. When no surface pins exist the engine returns no
  // deduction → grade 10, which matches "no surface defects observed".
  const surfaceGrade = surfaceOverride ?? mvgsSurfaceGrade;

  // Zone-set counts for the partial-zones indicator + worstKey for the
  // "Limited by …" tooltip on the summary stepper. Surfaced post-PR-#45
  // when admins can no longer rely on AI pre-fill across all 8 zones.
  const cornersZonesSet = Object.values(corners).filter((v) => typeof v === "number" && v > 0).length;
  const edgesZonesSet = Object.values(edges).filter((v) => typeof v === "number" && v > 0).length;

  // AI / manual subgrades — produced from the steppers + AI baseline +
  // per-zone arrays. Used as the displayed subs when NO MVGS pins are
  // classified, and as the input to calculateOverallGrade in the same case.
  const aiSub = { centering, corners: cornersGrade, edges: edgesGrade, surface: surfaceGrade };

  // Displayed + saved subs: MVGS when any pin is MVGS-classified, AI/manual
  // otherwise. Feeds GradeDisplay's subgrade chips, isBlackLabel(), and
  // (via sub.* in buildPayload below) the approve-payload's grade_centering/
  // grade_corners/grade_edges/grade_surface fields.
  const sub = hasMvgsPins
    ? { centering: mvgsCenteringGrade, corners: mvgsCornersGrade, edges: mvgsEdgesGrade, surface: mvgsSurfaceGrade }
    : aiSub;

  // Auto-populate overrides from MVGS when locked — ensures buildPayload
  // always ships non-null subgrades once defects are MVGS-classified, so
  // grade description generation works without manual entry.
  useEffect(() => {
    if (!hasMvgsPins) return;
    if (sub.corners > 0) setCornersOverride(sub.corners);
    if (sub.edges > 0) setEdgesOverride(sub.edges);
    if (sub.surface > 0) setSurfaceOverride(sub.surface);
  }, [hasMvgsPins, sub.corners, sub.edges, sub.surface]);

  // Auto-derive the 5 mvgsCode-mappable surface flags from pin state — they
  // exist for the CUSTOMER-FACING surface report ("Staining present: yes")
  // and were never read by the engine. Pins are the source of truth; the
  // engine deducts from pins, not from these flags. So we mirror the pin
  // signal into the flag for honest display, instead of letting an operator
  // tick or forget to tick a checkbox that already has the answer from pins.
  // hasRollerMarks + hasColorRegistration have no mvgsCode equivalent in the
  // standard, so they stay operator-editable.
  useEffect(() => {
    const hasPL = defects.some((d) => d.mvgsCode === "PL");
    const hasSP = defects.some((d) => d.mvgsCode === "SP");
    const hasSC = defects.some((d) => d.mvgsCode === "SC");
    const hasST = defects.some((d) => d.mvgsCode === "ST");
    const hasDG = defects.some((d) => d.mvgsCode === "DG");
    setSurface((prev) =>
      prev.hasPrintLines === hasPL &&
      prev.hasHoloScratches === hasSP &&
      prev.hasSurfaceScratches === hasSC &&
      prev.hasStaining === hasST &&
      prev.hasIndentation === hasDG
        ? prev
        : {
            ...prev,
            hasPrintLines: hasPL,
            hasHoloScratches: hasSP,
            hasSurfaceScratches: hasSC,
            hasStaining: hasST,
            hasIndentation: hasDG,
          }
    );
  }, [defects]);

  const mvgsGrade = hasMvgsPins && mvgsForOverall.score != null ? gradeFromMvgsScore(mvgsForOverall.score) : null;
  // 100% MVGS auto (owner directive 2026-07-01): manual overallOverride removed
  // from the precedence, so the overall is always the MVGS engine result
  // (half-grades and all) or the weighted-formula fallback — never a hand-set value.
  const overall = mvgsGrade ?? calculateOverallGrade(sub, surface.hasCrease, surface.hasTear);

  // Generate Description gate: every subgrade must have a real value (>0).
  // Mirrors the server-side 422 check so the button stays disabled until ready.
  const subgradesIncomplete = !centering || !cornersGrade || !edgesGrade || !surfaceGrade;
  const label = getGradeLabel(overall);
  // Pass MVGS deductions so a card with sub-grade-10-but-non-zero defects
  // (e.g. corners -1.5) does NOT flag as Pristine 10P.
  const isBlack = checkBlackLabel(sub, overall, mvgsForOverall.deductions);

  const isNonNumeric = authStatus === "authentic_altered" || authStatus === "not_original";
  const finalGradeOverall = isNonNumeric ? (authStatus === "authentic_altered" ? "AA" : "NO") : String(overall);
  const correctedFields = useMemo(
    () => new Set((correctionFeedback?.changes || []).map((change) => change.field)),
    [correctionFeedback]
  );
  const effectiveGradeApprovedAt = gradeApprovedAt ?? (gradingData as any)?.gradeApprovedAt ?? null;
  const effectiveGradeApprovedBy = gradeApprovedBy ?? (gradingData as any)?.gradeApprovedBy ?? null;
  const isApproved = approved || !!effectiveGradeApprovedAt || !!effectiveGradeApprovedBy;
  const approvalInteractionLocked = gradingWorkflowLocked || (effectiveGradeApprovedAt != null && !editMode);
  const gradingWorkflowStatusCopy = gradingError
    ? (gradingLoadError as Error | null)?.message || "Grading workflow load failed."
    : "Checking this card's approval and workflow state before enabling changes.";
  const canonicalRole = adminReview
    ? "admin-review"
    : graderMode
      ? "staff-or-grader"
      : correctionMode
        ? "super-admin"
        : "admin";
  const primaryActionCopy = graderMode
    ? graderEdit
      ? "Save edits (stays pending review)"
      : "Submit for approval"
    : adminReview
      ? "Approve staff grade"
      : "Approve & Publish";
  const confirmTitle = graderMode
    ? graderEdit
      ? "Save edits — stays pending review"
      : "Submit for approval"
    : adminReview
      ? "Approve staff grade"
      : "Approve & Publish";

  function buildPayload() {
    // Companion to server-side COALESCE fix (PR #14): omit fields that don't
    // carry information so the server preserves the existing DB value. Corner/
    // edge subgrades now default to 10 (Option A — calcCornerSubgrade), so a
    // flawless card ships grade_corners/grade_edges = 10 instead of being
    // omitted; the raw zone arrays still omit when untouched (hasContent below),
    // matching the historical NULL-array Pristines (e.g. MV151).
    const out: Record<string, unknown> = {
      overall_grade: finalGradeOverall,
      auth_status: authStatus,
      auth_notes: authNotes,
      grade_explanation: gradeExplanation,
      private_notes: privateNotes,
    };

    // Grader-editable card identity. Only sent in graderMode — admins edit
    // identity via CertificateForm, so the admin grade-save never carries these
    // (and applyCertGradeDraft, which reads them, is grader-only anyway).
    if (graderMode) {
      out.card_name = idName.trim();
      out.set_name = idSet.trim();
      out.card_number_display = idNumber.trim();
      out.year_text = idYear.trim();
      out.variant = idVariant.trim();
    }

    // Structured rarity/finish/promo — sent on BOTH graderMode and adminReview
    // (the Rarity stage is on all role routes; admins edit identity via a
    // separate editor but rarity has no other role write-path).
    //  - TOUCHED (operator interacted, incl. an explicit "No rarity" clear): send
    //    the exact current selection — an empty string here INTENTIONALLY persists
    //    a cleared rarity.
    //  - UNTOUCHED: only re-send non-empty, so an unhydrated/empty picker can
    //    never wipe a stored value (applyCertGradeDraft's pick() preserves it).
    if (graderMode || adminReview) {
      if (rarityTouched) {
        // An explicit clear is sent as NULL, not "". applyCertGradeDraft's
        // pick() preserves the stored value only for an OMITTED (undefined)
        // key; an explicit null persists as SQL NULL, while "" would have been
        // stored verbatim as an empty string — leaving this route writing ""
        // where the admin certificate route writes NULL for the same columns.
        // Same semantics, one emptiness representation, no server change.
        out.rarity_code = rarityCode.trim() || null;
        out.finish_variant = finishVariant.trim() || null;
        out.promo_type = promoType.trim() || null;
      } else {
        if (rarityCode.trim()) out.rarity_code = rarityCode.trim();
        if (finishVariant.trim()) out.finish_variant = finishVariant.trim();
        if (promoType.trim()) out.promo_type = promoType.trim();
      }
    }

    // Subgrade scalars — omit if 0/null (zone state at empty default).
    // Reads from `sub` so the MVGS-derived subgrades ship to the server when
    // any defect is MVGS-classified; falls back to AI/manual subgrades
    // otherwise (sub === aiSub when hasMvgsPins is false).
    const sendNum = (key: string, val: number | null | undefined) => {
      if (val != null && !isNaN(val) && val > 0) out[key] = val;
    };
    sendNum("grade_centering", sub.centering);
    sendNum("grade_corners", sub.corners);
    sendNum("grade_edges", sub.edges);
    sendNum("grade_surface", sub.surface);

    // Centering ratios — omit if empty.
    const sendTxt = (key: string, val: string | null | undefined) => {
      if (val != null && val !== "") out[key] = val;
    };
    sendTxt("centering_front_lr", frontLR);
    sendTxt("centering_front_tb", frontTB);
    sendTxt("centering_back_lr", backLR);
    sendTxt("centering_back_tb", backTB);

    // Zone JSONBs — only send if user has touched the panel (any non-default value).
    const hasContent = (s: unknown): boolean => {
      if (!s || typeof s !== "object") return false;
      const vals = Object.values(s as Record<string, unknown>).filter(
        (v) => v != null && v !== 0 && v !== "" && v !== false
      );
      return vals.length > 0;
    };
    if (hasContent(corners)) out.corners = corners;
    if (hasContent(edges)) out.edges = edges;
    if (hasContent(surface)) out.surface = surface;

    // Defects — server doesn't preserve this column yet (semantic ambiguity),
    // so keep current send-always behaviour.
    out.defects = defects || [];

    // AI defect candidates — send the current (post confirm/reject) array so
    // the unconfirmed remainder is persisted. Sending an empty array clears
    // the column on server side.
    out.ai_defect_candidates = defectCandidates || [];

    // MVGS inputs — boolean / integer, send unconditionally so toggling OFF
    // actually persists (no false-as-default conflation). Server mirrors the
    // legacy dark_border column from (front OR back) — no need to send it.
    out.dark_border_front = darkBorderFront;
    out.dark_border_back = darkBorderBack;
    out.eye_appeal_modifier = eyeAppealModifier;

    // MVGS v2 measurements. Send unconditionally so clearing a measurement
    // (operator removes a line / unsets a dropdown) actually persists null/[]
    // back to the cert instead of stale values. Engine reads via
    // shared/mvgs-input-builder.ts (measurement wins over the has_crease/
    // has_tear booleans on the surface_values jsonb).
    out.whitening_lines = whiteningLines;
    // v2.1 — multi-crease persistence. crease_lines is the new column; the
    // legacy crease_span_pct is sent as a derived mirror (max spanPct) so
    // back-compat readers see the worst crease.
    out.crease_lines = creaseLines;
    out.crease_span_pct = creaseSpanPct; // derived = max(creaseLines.spanPct) | null
    out.wrinkle_severity = wrinkleSeverity;
    out.tear_severity = tearSeverity;

    return out;
  }

  useEffect(() => {
    if (!onCorrectionGradingReady) return;
    onCorrectionGradingReady(() => {
      const payload = buildPayload();
      delete (payload as any).private_notes;
      return payload;
    });
    return () => onCorrectionGradingReady(() => ({}));
  }, [
    onCorrectionGradingReady,
    finalGradeOverall,
    authStatus,
    authNotes,
    gradeExplanation,
    sub.centering,
    sub.corners,
    sub.edges,
    sub.surface,
    frontLR,
    frontTB,
    backLR,
    backTB,
    corners,
    edges,
    surface,
    defects,
    defectCandidates,
    darkBorderFront,
    darkBorderBack,
    eyeAppealModifier,
    whiteningLines,
    creaseLines,
    creaseSpanPct,
    wrinkleSeverity,
    tearSeverity,
  ]);

  const hasFront = !!(imageData?.urls?.front_display || imageData?.urls?.front_original);
  const hasBack = !!(imageData?.urls?.back_display || imageData?.urls?.back_original);
  const hasAnyImage = hasFront || hasBack;

  if (!hasAnyImage) {
    return (
      <CaptureWizard
        certId={certId}
        onComplete={() => queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/images`] })}
        existingQuality={imageData?.quality}
      />
    );
  }

  async function saveDraft() {
    if (gradingWorkflowLocked) {
      toast({
        title: "Workflow locked",
        description: gradingWorkflowStatusCopy,
        variant: gradingError ? "destructive" : undefined,
      });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/certificates/${certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      toast({ title: "Draft saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/grading`] });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  /**
   * Option B "Generate Description" — Haiku 4.5 text-only call. Server validates
   * that all four subgrades are present and writes the result to grade_explanation,
   * then we mirror it into the form state so the admin can edit before save.
   */
  async function generateDescription() {
    if (subgradesIncomplete) {
      toast({
        title: "Set all four subgrades first",
        description: "Centering, corners, edges, and surface must each have a value.",
      });
      return;
    }
    setGeneratingDescription(true);
    try {
      // Persist current state first so the server's read of the cert reflects
      // the admin's just-set subgrades + confirmed defects.
      await fetch(`${apiBase}/certificates/${certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const res = await fetch(`${apiBase}/certificates/${certId}/generate-description`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (res.status === 422) {
        toast({ title: "Cannot generate yet", description: data.error || "Set all four subgrades first." });
        return;
      }
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setGradeExplanation(data.description);
      toast({
        title: "Description generated",
        description: `Cost ≈ £${(data.costEstimate || 0).toFixed(4)}. Edit before saving if needed.`,
      });
    } catch (e: any) {
      toast({ title: "Generate failed", description: e.message, variant: "destructive" });
    } finally {
      setGeneratingDescription(false);
    }
  }

  // Background crop-upload owner for the card tool. Runs POST /recrop with up
  // to 3 attempts + backoff. On success it returns the fresh display URL (so
  // the tool can swap its <img> seamlessly) and refreshes the image query. On
  // final failure it flips the gate to "failed" (blocking approval) and toasts
  // — never a silent failure. Survives the tool closing because it lives here.
  async function runRecrop(side: "front" | "back", payload: any): Promise<string | undefined> {
    // Admin-review is charge/side-effect-safe: never re-crop or re-upload the
    // grader's images. Centering measurements still update locally (draft auto-save).
    if (adminReview) return undefined;
    // Functional updates only — front and back upload loops run concurrently
    // and must never read/write a stale snapshot of the other side's slot.
    if (cropSyncedTimerRef.current[side]) {
      clearTimeout(cropSyncedTimerRef.current[side]!);
      cropSyncedTimerRef.current[side] = null;
    }
    setCropSync((prev) => ({ ...prev, [side]: { status: "pending", payload } }));
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(`${apiBase}/certificates/${certId}/recrop`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        // Persisted to R2 + DB image path. Clear THIS side's gate + refresh images.
        setCropSync((prev) => ({ ...prev, [side]: { status: "synced", payload: null } }));
        cropSyncedTimerRef.current[side] = setTimeout(() => {
          setCropSync((prev) =>
            prev[side].status === "synced" ? { ...prev, [side]: { status: "idle", payload: null } } : prev
          );
        }, 2500);
        queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/images`] });
        return typeof json.displayUrl === "string" ? json.displayUrl : undefined;
      } catch (e: any) {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
          continue;
        }
        // Keep this side's payload so Retry re-sends the CORRECT side's body.
        setCropSync((prev) => ({ ...prev, [side]: { status: "failed", payload } }));
        toast({
          title: "Crop upload failed — retry",
          description: `${side} crop didn't save to storage. Approval is blocked until it succeeds.`,
          variant: "destructive",
        });
        return undefined;
      }
    }
    return undefined;
  }

  function retryCrop(side: "front" | "back"): Promise<string | undefined> {
    const slot = cropSync[side];
    if (!slot.payload) return Promise.resolve(undefined);
    return runRecrop(side, slot.payload);
  }

  // Catch-all approval gate message — names which side(s) are failed/pending.
  // Returns null when nothing blocks. Used by every approve entry point.
  function cropGateBlockToast(): { title: string; description: string } | null {
    if (cropFailedSides.length > 0) {
      return {
        title: `Crop upload failed — ${cropFailedSides.join(" + ")}`,
        description: `Retry the ${cropFailedSides.join(" and ")} crop upload before approving.`,
      };
    }
    if (cropPendingSides.length > 0) {
      return {
        title: `Crop still syncing — ${cropPendingSides.join(" + ")}`,
        description: `Wait for the ${cropPendingSides.join(" and ")} crop to finish saving before approving.`,
      };
    }
    return null;
  }

  async function approveGrade() {
    if (gradingWorkflowLocked) {
      toast({
        title: "Workflow locked",
        description: gradingWorkflowStatusCopy,
        variant: gradingError ? "destructive" : undefined,
      });
      return;
    }
    // HARD GATE: a backgrounded crop that's still uploading or has failed must
    // never finalise a cert (defects would point at an unpersisted/old image).
    const block = cropGateBlockToast();
    if (block) {
      toast({ ...block, variant: "destructive" });
      return;
    }
    setApproving(true);
    try {
      // v413: flush any pending debounced auto-save before approving so the
      // server reads the freshest payload. Cancel the debounce timer (if any)
      // and POST the current state directly.
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      const elapsedSeconds = Math.round((Date.now() - gradingStartedAtRef.current) / 1000);
      // ADMIN-REVIEW MODE: explicit save-then-approve. Persist the (possibly
      //   corrected) draft via the non-publishing review endpoint, THEN publish
      //   via the existing grader-review approve, so the PUBLISHED grade is the
      //   edited one — not the grader's original.
      // GRADER MODE: submit for admin review (POST /submit) — never publishes.
      // ADMIN MODE: publish the grade live (PUT /approve).
      let res: Response;
      if (adminReview) {
        const saveRes = await fetch(`${apiBase}/certificates/${certId}/grade`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload()),
        });
        if (!saveRes.ok) {
          const sd = await saveRes.json().catch(() => ({}));
          throw new Error(sd.error || "Save failed");
        }
        res = await fetch(`/api/admin/certificates/${certId}/approve-grader-grade`, {
          method: "POST",
          credentials: "include",
        });
      } else if (graderMode && graderEdit) {
        // GRADER EDIT: re-grading an already-submitted card. Route through the
        // GATED edit endpoint — it persists the re-measured grade as a draft,
        // re-asserts pending_review + review_required, re-snapshots operator_grade
        // and audits. It NEVER approves/publishes, so this path cannot leave
        // pending_review. (Distinct from /submit, which can auto-approve.)
        res = await fetch(`${apiBase}/certificates/${certId}/edit-submission`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload()),
        });
      } else if (graderMode) {
        res = await fetch(`${apiBase}/certificates/${certId}/submit`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload()),
        });
      } else {
        res = await fetch(`${apiBase}/certificates/${certId}/approve`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...buildPayload(), grading_time_seconds: elapsedSeconds }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || (graderMode ? "Submit failed" : "Approve failed"));
      setApproved(true);
      setShowConfirm(false);
      if (!graderMode) {
        // Mirror server-side approve into local state so the post-approve
        // banner appears immediately. Graders don't publish, so skip this.
        setGradeApprovedAt(new Date().toISOString());
        setGradeApprovedBy("Cornelius Oliver");
      }
      toast({
        title:
          graderMode && graderEdit
            ? `${certIdStr || "Certificate"} edits saved — still pending review`
            : graderMode
              ? `${certIdStr || "Certificate"} submitted for approval`
              : `${certIdStr || "Certificate"} approved & published — ${finalGradeOverall} ${label}`,
      });
      onGradeApproved?.(certIdStr, finalGradeOverall);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/grading`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      // THIS is the call that makes a certificate print-eligible, so it is the one
      // that must drop the Ready To Print cache. Both base variants: the queue
      // registers its key from its own apiBase ("/api/admin" on the admin surface,
      // "/api/staff/print" for print-capable staff); invalidating a key nothing
      // registered is a no-op, so covering both is correct without guessing which
      // surface is mounted. Without this the queue can serve pre-approval rows
      // (the global client sets staleTime: Infinity).
      for (const b of ["/api/admin", "/api/staff/print"]) {
        queryClient.invalidateQueries({ queryKey: [`${b}/printing/workflow/queue`] });
        queryClient.invalidateQueries({ queryKey: [`${b}/printing/workflow/batches`] });
      }
    } catch (e: any) {
      toast({ title: "Approve failed", description: e.message, variant: "destructive" });
    } finally {
      setApproving(false);
    }
  }

  const urls = imageData?.urls || {};

  // Card-identity status light (DISPLAY ONLY — reads existing ai_analysis flags +
  // the per-device AI-identify toggle; no AI calls, no writes). FOUR states so a
  // card still identifying — or one in manual mode — never looks like a failure:
  //   green   → dbSource "pokemon-tcg-api" (name/set/number from a verified TCGdex match)
  //   red     → needs_identification_review (AI ran, no TCG match — grader verifies)
  //   pending → AI identify ON but not done yet (in progress / not run / timed out)
  //   manual  → AI identify OFF + not identified — grader enters identity manually
  // NOT gated on graderMode, so it renders on the admin panel AND every staff
  // grader's panel (shared component).
  const aiMeta = gradingData?.aiAnalysis;
  const tcgState: "green" | "red" | "pending" | "manual" =
    aiMeta?.identification?.dbSource === "pokemon-tcg-api"
      ? "green"
      : aiMeta?.needs_identification_review === true
        ? "red"
        : aiIdentify
          ? "pending"
          : "manual";
  const tcgGuess: string | null = tcgState === "red" ? (aiMeta?.suggested_name ?? null) : null;

  return (
    <div
      className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-xl p-4 space-y-5"
      data-testid="canonical-grading-panel"
      data-canonical-role={canonicalRole}
      data-section-order={CANONICAL_GRADING_SECTION_ORDER}
      data-api-base={apiBase}
      data-admin-review={String(adminReview)}
      data-grader-mode={String(graderMode)}
      data-grader-edit={String(graderEdit)}
      data-correction-mode={String(correctionMode)}
    >
      <div data-canonical-section="workflow-banners" data-testid="section-workflow-banners">
        {/* Edit-mode banner — a grader re-opened their OWN submitted card. Make it
          unmistakable that saving does NOT publish: the card stays pending review
          and still needs admin approval. */}
        {graderMode && graderEdit && (
          <div
            className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-amber-300"
            data-testid="grader-edit-banner"
          >
            <div className="text-[11px] font-bold uppercase tracking-wider">
              Submitted · editing (stays pending review)
            </div>
            <div className="text-[11px] text-amber-200/80">
              You&apos;re correcting an already-submitted card with the full tools. Saving keeps it pending review — it
              never publishes; an admin still approves it.
            </div>
          </div>
        )}
        {correctionFeedback?.corrected && (
          <div
            className="bg-[var(--admin-amber)]/10 border border-[var(--admin-amber)]/45 rounded-xl p-3 space-y-2"
            data-testid="staff-correction-feedback"
            data-changed-count={correctedFields.size}
          >
            <p className="text-[var(--admin-amber)] text-xs font-bold uppercase tracking-widest">
              This grading has been corrected by Admin.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {correctionFeedback.changes.map((change) => (
                <div
                  key={change.field}
                  className="rounded border border-[var(--admin-amber)]/25 bg-black/20 px-2.5 py-2 text-xs"
                  data-testid={`correction-change-${change.field}`}
                >
                  <div className="font-bold text-[var(--admin-ink)]">{change.field}</div>
                  <div className="text-[var(--admin-ink-dim)] break-words">{String(change.before ?? "blank")}</div>
                  <div className="text-[var(--admin-amber)] text-[10px] uppercase tracking-widest">↓</div>
                  <div className="text-[var(--admin-ink)] break-words">{String(change.after ?? "blank")}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {gradingWorkflowLocked && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              gradingError
                ? "border-[var(--admin-red)]/45 bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] text-[var(--admin-red)]"
                : "border-amber-500/45 bg-amber-500/10 text-amber-300"
            }`}
            data-testid="grading-workflow-safe-state"
          >
            <div className="flex items-center gap-2 font-bold uppercase tracking-wider">
              {!gradingError && <Loader2 size={12} className="animate-spin" />}
              {gradingError ? "Workflow unavailable" : "Checking approval state"}
            </div>
            <div className="mt-1 text-[11px] opacity-80">{gradingWorkflowStatusCopy}</div>
          </div>
        )}
      </div>
      {/* AI card-IDENTIFICATION toggle (per-device, localStorage). Identify step
          ONLY — the AI never grades. ON = auto-identify on open + TCGdex confirm;
          OFF = no AI call, enter identity manually. NOT graderMode-gated → the
          admin panel AND every staff grader sees + controls it. */}
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-[var(--admin-line)] bg-[var(--admin-panel2)] px-3 py-2"
        data-canonical-section="identification"
        data-testid="section-identification"
      >
        <div className="min-w-0">
          <div className="text-xs font-semibold text-[var(--admin-ink)]">AI card identification</div>
          <div className="text-[10px] text-[var(--admin-ink-faint)]">
            Identifies card + set only — never grades.{" "}
            {aiIdentify ? "On — auto-identifies on open, TCGdex confirms." : "Off — enter the card identity manually."}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={aiIdentify}
          onClick={() => toggleAiIdentify(!aiIdentify)}
          data-testid="ai-identify-toggle"
          title="AI card identification (per-device). Identify only — never grades."
          className={
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors " +
            (aiIdentify ? "bg-emerald-500/70" : "bg-[var(--admin-line)]")
          }
        >
          <span
            className={
              "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " +
              (aiIdentify ? "translate-x-[18px]" : "translate-x-0.5")
            }
          />
        </button>
      </div>

      {/* Card-identity status light — see tcgState above. Folds in the old amber
          "verify" note (red state). */}
      <div
        className={
          "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] " +
          (tcgState === "green"
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            : tcgState === "red"
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : tcgState === "pending"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-[var(--admin-line)] bg-[var(--admin-panel2)] text-[var(--admin-ink-faint)]")
        }
        data-testid="tcgdex-status"
      >
        <span
          className={
            "inline-block h-2 w-2 rounded-full shrink-0 " +
            (tcgState === "green"
              ? "bg-emerald-400"
              : tcgState === "red"
                ? "bg-red-400"
                : tcgState === "pending"
                  ? "bg-amber-400 animate-pulse"
                  : "bg-[var(--admin-ink-faint)]")
          }
        />
        <span className="font-semibold uppercase tracking-wider">
          {tcgState === "green"
            ? "TCGdex confirmed"
            : tcgState === "red"
              ? "Not confirmed — verify"
              : tcgState === "pending"
                ? "Identifying…"
                : "Manual entry"}
        </span>
        {tcgState === "red" && (
          <span className="text-[var(--admin-ink-faint)]">
            {tcgGuess
              ? `AI guessed “${tcgGuess}” (unverified) — enter the correct identity.`
              : "Enter the card identity before grading."}
          </span>
        )}
        {tcgState === "manual" && <span>AI identify off — enter the card identity manually.</span>}
      </div>

      {/* Card identity — EDITABLE for graders (they hold the card and may correct
          AI pre-grade errors before submitting). Edits ride the panel's debounced
          auto-save. graderMode-only: admins edit identity via the CertificateForm
          rendered above the panel. The cert number itself is not editable. */}
      {graderMode || adminReview ? (
        <GradingIdentityVerification
          certId={certId}
          certIdStr={certIdStr}
          mode={graderMode ? "edit" : "review"}
          locked={approvalInteractionLocked}
          game={cardGame}
          name={idName}
          set={idSet}
          setCode={idSetCode}
          number={idNumber}
          year={idYear}
          variant={idVariant}
          onName={setIdName}
          onSet={(name, id) => {
            setIdSet(name);
            setIdSetCode(id || "");
          }}
          onNumber={setIdNumber}
          onYear={setIdYear}
          onVariant={setIdVariant}
          onAutofill={graderAutofill}
          autofilling={idAutofilling}
          autofillDisabled={
            approvalInteractionLocked || idAutofilling || !(idSetCode || idSet).trim() || !idNumber.trim()
          }
          onSearchAgain={rerunIdentify}
          searchBusy={idRerunBusy}
          onCardPick={applyCardPick}
          statusLabel={
            tcgState === "green"
              ? "TCGdex confirmed"
              : tcgGuess
                ? "AI suggested"
                : tcgState === "manual"
                  ? "Manual entry"
                  : "Not identified"
          }
          statusTone={tcgState === "green" ? "confirmed" : tcgGuess ? "suggested" : "none"}
          resetKey={certId}
        />
      ) : (
        <div data-canonical-section="identity-fields" data-testid="section-card-identity" hidden />
      )}
      {/* Rarity stage — the SAME canonical structured rarity/variant picker the
          /admin CertificateForm uses (one component, one shared catalogue). Role
          routes only (graderMode/adminReview); /admin renders its own via
          CertificateForm. Persists via buildPayload → the role save (rarity_code /
          finish_variant / promo_type). */}
      {(graderMode || adminReview) && (
        <div
          className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel2)] px-3 py-2.5 space-y-2"
          data-canonical-section="rarity"
          data-testid="section-rarity"
        >
          <div className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Structured rarity &amp; variant</div>
          {/* Mount only once gradingData is present so the picker (uncontrolled after
              mount) seeds from the STORED rarity, and key it by certId so switching
              certs remounts + re-seeds. Both derive straight from the query — no
              effect-ordering latch that a per-card reset could strand. */}
          {gradingData ? (
            <RarityVariantPicker
              key={certId ?? "none"}
              legacyVariant={idVariant || null}
              value={{
                language: "en",
                era: null,
                // Seed STRICTLY from the per-cert query (the picker only mounts once
                // gradingData is present, so it is authoritative). No local-state
                // fallback: a null-rarity cert returning rarityCode:null must seed
                // null, never the previous cert's still-unreset local rarityCode.
                rarity: (gradingData as any).rarityCode || null,
                finish: (gradingData as any).finishVariant || null,
                promo: (gradingData as any).promoType || null,
                subset: null,
              }}
              onChange={handleRarityChange}
            />
          ) : (
            <div className="text-[11px] text-[var(--admin-ink-faint)]" data-testid="rarity-loading">
              Loading rarity…
            </div>
          )}
        </div>
      )}
      <div
        className="flex items-center justify-between"
        data-canonical-section="workstation-header"
        data-testid="section-workstation-header"
      >
        <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">
          Manual Grading Workstation
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRevertToAi}
            disabled={!aiAnalysis || approvalInteractionLocked}
            title={
              approvalInteractionLocked
                ? gradingWorkflowStatusCopy
                : aiAnalysis
                ? "Clear all overrides and re-populate sub-grades from the last AI run this session"
                : "Run AI Identify & Grade first to enable this"
            }
            className={`flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 rounded transition-all ${
              aiAnalysis && !approvalInteractionLocked
                ? "text-[var(--admin-ink-dim)] border border-[var(--admin-line)] hover:text-[var(--admin-gold)] hover:border-[var(--admin-gold)]/40"
                : "text-[var(--admin-ink-faint)] border border-[var(--admin-line)] opacity-60 cursor-not-allowed"
            }`}
          >
            Revert to AI
          </button>
          {isApproved && (
            <span className="flex items-center gap-1.5 text-[var(--admin-green)] text-xs">
              <CheckCircle2 size={13} />
              Grade approved
            </span>
          )}
        </div>
      </div>

      {/* Pre-grade checklist — operational reminder that the card was
          deionized before imaging. Session-only state; gates the Approve
          & Publish button below. Hidden once the cert is approved since
          it's pre-grade-only and would clutter the post-approve view. */}
      <div data-canonical-section="preflight" data-testid="section-preflight">
        {!isApproved && (
          <label
            className={`flex items-center gap-2 cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
              deionizationComplete
                ? "bg-[color-mix(in_srgb,var(--admin-green)_12%,transparent)] border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)]"
                : "bg-[color-mix(in_srgb,var(--admin-amber)_12%,transparent)] border-[color-mix(in_srgb,var(--admin-amber)_50%,transparent)]"
            }`}
            data-testid="check-deionization-complete"
          >
            <input
              type="checkbox"
              checked={deionizationComplete}
              disabled={gradingWorkflowLocked}
              onChange={() => setDeionizationComplete((v) => !v)}
              className="accent-[var(--admin-gold)] h-4 w-4"
            />
            <span className="text-xs font-bold uppercase tracking-wider text-[var(--admin-ink)]">
              Deionization complete
            </span>
            <span className="text-[10px] text-[var(--admin-ink-dim)] ml-auto">Required before approve</span>
          </label>
        )}
      </div>

      {/* AI Panel + Reprocess — HIDDEN in admin-review (every AI/CV action hits
          /api/admin, would burn credits + overwrite the grader's work) AND HIDDEN
          for graders. Graders do MANUAL grading: the AI grade tools (Measure
          Centering, Detect Defects, Grade Card, Run All, Analyze with AI Full)
          must not be available to them, or operator_grade would be AI-vs-final,
          corrupting the per-operator drift stats. The identify banner + AI-identify
          toggle are SEPARATE (rendered above, ungated) so graders keep the
          identification help that fills the set — they just can't AI-grade. */}
      <div data-canonical-section="ai-tools" data-testid="section-ai-tools">
        {!adminReview && !graderMode && !correctionMode && (
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <AiPanel
                certId={certId}
                onAnalysisComplete={handleAiComplete}
                referenceImageUrl={aiIdentification?.referenceImageUrl}
                externalAnalysis={pendingAnalysis}
                onExternalAnalysisConsumed={onPendingAnalysisConsumed}
                onManualIdentification={onManualIdentification}
                cardGame={cardGame}
              />
            </div>
            {/* Admin-only image op (hits /api/admin) — hidden for graders. */}
            {!graderMode && (
              <ReprocessButton
                certId={certId}
                onDone={() => queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/images`] })}
              />
            )}
          </div>
        )}
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[60%_40%] gap-5" data-testid="section-grading-workstation-grid">
        {/* LEFT — Image viewer + defect list */}
        <div className="space-y-4" data-canonical-section="card-images" data-testid="section-card-images">
          {/* FRONT/BACK chip row — own dedicated row above the absolute-anchor
              wrapper for TL/T/TR labels. Pulled out of ImageViewer so the
              wrapper's `top: 0` (anchor for TL/T/TR at top:-28) is the variant
              tabs row, not the chip row — stops the dropdowns colliding with
              the chips. ImageViewer is told to omit its own chip row via
              `omitSideTabs` and to use `viewerSide` as controlled state. */}
          <div className="px-[60px] mb-2">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {(["front", "back"] as const).map((s) => {
                const count = defects.filter((d) => d.image_side === s).length;
                const hasImage = !!(
                  urls[`${s}_cropped` as keyof typeof urls] || urls[`${s}_original` as keyof typeof urls]
                );
                const isActive = viewerSide === s;
                return (
                  <div key={s} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setViewerSide(s)}
                      disabled={!hasImage}
                      data-testid={`btn-side-${s}`}
                      className={`flex-shrink-0 rounded-l px-3 py-1 text-[10px] font-bold uppercase tracking-wider border transition-all ${
                        isActive
                          ? "border-[var(--admin-gold)] text-[var(--admin-gold)] bg-[var(--admin-gold)]/10"
                          : hasImage
                            ? "border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]/40"
                            : "border-[var(--admin-line)] text-[var(--admin-ink-faint)] cursor-not-allowed"
                      }`}
                    >
                      {s}
                      {count > 0 ? ` (${count})` : ""}
                    </button>
                    {hasImage && certId && !adminReview && (
                      <button
                        type="button"
                        title={approvalInteractionLocked ? gradingWorkflowStatusCopy : `Delete ${s} image`}
                        disabled={approvalInteractionLocked}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (approvalInteractionLocked) return;
                          if (!confirm(`Delete the ${s} image? You'll need to re-upload before grading.`)) return;
                          try {
                            const r = await fetch(`${apiBase}/certificates/${certId}/images/${s}`, {
                              method: "DELETE",
                              credentials: "include",
                            });
                            if (!r.ok) {
                              const d = await r.json();
                              throw new Error(d.error);
                            }
                            queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/images`] });
                          } catch {}
                        }}
                        className="flex-shrink-0 rounded-r border border-l-0 border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:text-[var(--admin-red)] hover:border-[var(--admin-red)]/40 px-1.5 py-1 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Trash2 size={10} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ margin: "32px 60px 0" }}>
            <div className="relative" style={{ overflow: "visible" }}>
              <ImageViewer
                apiBase={apiBase}
                urls={urls}
                defects={defects}
                onDefectAdded={(d) => setDefects((prev) => [...prev, d])}
                onDefectsChange={setDefects}
                readOnly={approvalInteractionLocked}
                highlightId={highlightDefect}
                referenceImageUrl={aiIdentification?.referenceImageUrl}
                side={viewerSide as "front" | "back"}
                omitSideTabs
                onOpenCardTool={setManualCardToolSide}
                // MVGS v2.1 measurement state — flows back through the
                // callbacks below when the operator draws a whitening or
                // crease line inside mark mode (no separate tool overlay).
                whiteningLines={whiteningLines}
                creaseLines={creaseLines}
                onWhiteningLinesChange={(next) => {
                  setWhiteningLines(next);
                  clearOverallOverrideIfSet();
                }}
                onCreaseLinesChange={(next) => {
                  setCreaseLines(next);
                  clearOverallOverrideIfSet();
                }}
                centeringFront={
                  frontLR
                    ? {
                        ratioLR: frontLR,
                        ratioTB: frontTB,
                        outerFrame:
                          centeringMethod === "manual" && manualOuterFront
                            ? manualOuterFront
                            : aiAnalysis?.centering?.front_outer_frame || null,
                        innerFrame:
                          centeringMethod === "manual" && manualInnerFront
                            ? manualInnerFront
                            : aiAnalysis?.centering?.front_inner_frame || null,
                      }
                    : null
                }
                centeringBack={
                  backLR
                    ? {
                        ratioLR: backLR,
                        ratioTB: backTB,
                        outerFrame:
                          centeringMethod === "manual" && manualOuterBack
                            ? manualOuterBack
                            : aiAnalysis?.centering?.back_outer_frame || null,
                        innerFrame:
                          centeringMethod === "manual" && manualInnerBack
                            ? manualInnerBack
                            : aiAnalysis?.centering?.back_inner_frame || null,
                      }
                    : null
                }
                certId={certId}
                onImageDeleted={() =>
                  queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/images`] })
                }
                // Perspective crop tool plugs into the SAME per-side crop-sync
                // lifecycle as the 8-dot card tool (background upload, retries,
                // catch-all approval gate). front/back tracked independently.
                // STEP 4: a Manual-Crop re-straighten invalidates this side's
                // committed centering FIRST (it was measured on the old crop),
                // forcing a Redo so the grade never reads pre-straighten numbers.
                onStartCropUpload={(payload) => {
                  invalidateCenteringForSide(payload.side);
                  return runRecrop(payload.side, payload);
                }}
                onSideChange={setViewerSide}
                onZoomChange={setViewerZoom}
                onModeChange={setViewerMode}
              />
              {/* Corner/edge zone selectors removed — MVGS defect pins now
                  drive corners/edges subgrades via computeMvgsScore. */}
            </div>
            {/* Bottom corner/edge selectors removed — MVGS-driven. */}
          </div>
          <div
            className="bg-[var(--admin-panel2)] border border-[var(--admin-line)] rounded-lg p-3 space-y-2"
            data-canonical-section="defect-marking"
            data-testid="section-defect-marking"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[var(--admin-gold-deep)] text-[10px] uppercase tracking-widest font-bold">Defects</p>
              <div className="flex items-center gap-2">
                {defects.length > 0 && defects.some((d) => !d.mvgsCode || !d.tier || !d.zone) && (
	                  <button
	                    type="button"
	                    disabled={approvalInteractionLocked}
	                    onClick={() => {
	                      if (approvalInteractionLocked) return;
	                      setDefects(
                        defects.map((d) => ({
                          ...d,
                          mvgsCode: d.mvgsCode ?? mapLegacyTypeToMvgsCode(d.type) ?? "WH",
                          tier: d.tier ?? "D2",
                          zone:
                            d.zone ??
                            deriveZone({
                              xPercent: d.x_percent,
                              yPercent: d.y_percent,
                              imageSide: d.image_side,
                            }),
                        }))
                      );
                    }}
	                    className="flex items-center gap-1 text-[var(--admin-gold-deep)] hover:text-[var(--admin-gold)] text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
	                    data-testid="btn-recalc-zones"
	                    title={
	                      approvalInteractionLocked
	                        ? gradingWorkflowStatusCopy
	                        : "Backfill mvgsCode, tier, and zone on defects missing them — triggers MVGS subgrade scoring"
	                    }
                  >
                    <Zap size={10} />
                    Recalculate
                  </button>
                )}
                {defects.length > 0 && (
	                  <button
	                    type="button"
	                    disabled={approvalInteractionLocked}
	                    onClick={() => {
	                      if (approvalInteractionLocked) return;
	                      if (!window.confirm("Delete all defect pins? This cannot be undone.")) return;
	                      setDefects([]);
	                    }}
	                    className="flex items-center gap-1 text-[var(--admin-ink-faint)] hover:text-[var(--admin-red)] text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
	                    data-testid="btn-clear-defects"
	                    title={approvalInteractionLocked ? gradingWorkflowStatusCopy : "Delete all defect pins"}
                  >
                    <Trash2 size={10} />
                    Clear Defects
                  </button>
                )}
              </div>
            </div>

            <DefectAnnotation
              defects={defects}
              onChange={setDefects}
              highlightId={highlightDefect}
              onHighlight={setHighlightDefect}
              candidates={defectCandidates}
              onCandidatesChange={setDefectCandidates}
              // MVGS v2.1 — line measurements merged into the same defect list.
              whiteningLines={whiteningLines}
              creaseLines={creaseLines}
              onWhiteningLinesChange={(next) => {
                setWhiteningLines(next);
                clearOverallOverrideIfSet();
              }}
              onCreaseLinesChange={(next) => {
                setCreaseLines(next);
                clearOverallOverrideIfSet();
              }}
            />
          </div>
        </div>

        {/* RIGHT — Grading inputs */}
        <div
          className="space-y-5 overflow-y-auto"
          data-canonical-section="grading-controls"
          data-testid="section-grading-controls"
        >
          {/* Post-approval banner — read-only by default, with an EDIT GRADE
              button that flips into explicit-save edit mode. Auto-save is
              disabled post-approval (see autoSave useEffect gate) so any
              edit-mode change requires the SAVE CHANGES button below. */}
          {effectiveGradeApprovedAt && !editMode && !graderMode && !correctionMode && (
            <div className="bg-[var(--admin-green)]/10 border border-[var(--admin-green)]/40 rounded-lg p-3 flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <p className="text-[var(--admin-green)] text-xs font-bold uppercase tracking-widest">
                  ✓ Approved &amp; Live · {certIdStr || ""}
                </p>
                <p className="text-[var(--admin-green)]/80 text-[10px] leading-relaxed">
                  Approved {effectiveGradeApprovedAt ? new Date(effectiveGradeApprovedAt).toLocaleString() : ""}
                  {effectiveGradeApprovedBy ? ` by ${effectiveGradeApprovedBy}` : ""}.
                </p>
              </div>
              <button
                type="button"
                onClick={enterEditMode}
                className="shrink-0 border border-[var(--admin-gold)]/60 text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded transition-colors"
                data-testid="btn-edit-grade"
              >
                ✏️ Edit Grade
              </button>
            </div>
          )}
          {effectiveGradeApprovedAt && editMode && (
            <div className="bg-[color-mix(in_srgb,var(--admin-amber)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-amber)_50%,transparent)] rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <p className="text-[var(--admin-amber)] text-xs font-bold uppercase tracking-widest">
                    ✏️ Edit mode · {certIdStr || ""}
                  </p>
                  <p className="text-[var(--admin-amber)]/90 text-[10px] leading-relaxed">
                    Changes are not saved until you click Save · all saves recorded in audit log.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveEditedGrade}
                  disabled={editSaving}
                  className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase tracking-widest px-3 py-2 rounded transition-all hover:opacity-90 disabled:opacity-40"
                  data-testid="btn-save-edit"
                >
                  {editSaving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  {editSaving ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={editSaving}
                  className="border border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel3)] text-xs font-bold uppercase tracking-widest px-3 py-2 rounded transition-colors disabled:opacity-40"
                  data-testid="btn-cancel-edit"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {/* Editable block — wrapped in <fieldset disabled> so that, post-
              approval, every form control inside (subgrade steppers, override
              dropdown, centering inputs, defect annotation buttons, auth
              select, notes textareas, approve button) is non-interactive
              until the admin clicks EDIT GRADE in the banner above. Pre-
              approval (gradeApprovedAt null) the fieldset is enabled and
              auto-save handles persistence as before. */}
          <fieldset
            disabled={approvalInteractionLocked}
            className="min-w-0 border-none p-0 m-0 space-y-5 disabled:opacity-70"
          >
            {/* AI source badges */}
            {aiAnalysis && (
              <div className="flex gap-1 flex-wrap">
                {(["centering", "corners", "edges", "surface"] as const).map((key) => {
                  const aiVal = aiSources[key];
                  const curVal =
                    key === "centering"
                      ? centering
                      : key === "corners"
                        ? sub.corners
                        : key === "edges"
                          ? sub.edges
                          : sub.surface;
                  const isManual = aiVal !== undefined && curVal !== aiVal;
                  return (
                    <div
                      key={key}
                      className={`text-[9px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${
                        isManual
                          ? "bg-[var(--admin-blue)]/30 text-[var(--admin-blue)] border-[var(--admin-blue)]/40"
                          : "bg-[var(--admin-gold)]/10 text-[var(--admin-gold)]/70 border-[var(--admin-gold)]/20"
                      }`}
                    >
                      <span className="uppercase font-bold">{key.slice(0, 1).toUpperCase()}</span>
                      <span>{isManual ? `Manual (AI: ${aiVal})` : `AI ${aiVal}`}</span>
                      <span className="text-[var(--admin-gold)]/50">·</span>
                      <span
                        className={`font-bold ${
                          aiAnalysis.confidence[key] === "high"
                            ? "text-[var(--admin-green)]"
                            : aiAnalysis.confidence[key] === "medium"
                              ? "text-[var(--admin-amber)]"
                              : "text-[var(--admin-red)]"
                        }`}
                      >
                        {aiAnalysis.confidence[key]}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* MVGS controls + live score — visible whenever the panel is in
              numeric-grade mode. The score updates as defects, centering,
              dark_border_front/back, and eye_appeal_modifier change locally
              — same pure function (shared/mvgs-scoring.ts) the server runs
              on approve. */}
            {!isNonNumeric &&
              (() => {
                // Preview compute — same scoreMvgsV2 path as mvgsForOverall
                // above. Client uses DEFAULT_MVGS_CALIBRATION; server's
                // approve route is the authoritative compute and loads the
                // persisted calibration row.
                const mvgs = scoreMvgsV2(
                  {
                    centeringFrontLr: frontLR || null,
                    centeringFrontTb: frontTB || null,
                    centeringBackLr: backLR || null,
                    centeringBackTb: backTB || null,
                    defects: (defects || [])
                      .filter((d) => d.mvgsCode && d.tier && d.zone)
                      .map((d) => ({ mvgsCode: d.mvgsCode!, tier: d.tier!, zone: d.zone! })),
                    darkBorderFront,
                    darkBorderBack,
                    eyeAppealModifier,
                    whiteningLines,
                    creaseLines,
                    wrinkleSeverity,
                    tearSeverity,
                    hasCrease: !!surface.hasCrease,
                    hasTear: !!surface.hasTear,
                  },
                  DEFAULT_MVGS_CALIBRATION
                );
                return (
                  <div
                    className="bg-[var(--admin-panel3)] border border-[var(--admin-gold)]/40 rounded-lg p-3 space-y-3"
                    data-testid="mvgs-controls"
                    data-canonical-section="mvgs-score"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="text-[var(--admin-gold)] text-[10px] font-bold uppercase tracking-widest">
                        MVGS
                      </span>
                      <span className="text-[var(--admin-ink)] text-sm font-bold" data-testid="text-mvgs-score">
                        {mvgs.score}/100 · {mvgs.grade}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--admin-ink-dim)]">
                          Dark border
                        </span>
                        <div className="flex gap-3">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={darkBorderFront}
                              onChange={() => setDarkBorderFront((v) => !v)}
                              className="accent-[var(--admin-gold)] h-4 w-4"
                              data-testid="check-dark-border-front"
                            />
                            <span className="text-[10px] text-[var(--admin-ink-dim)]">Front</span>
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={darkBorderBack}
                              onChange={() => setDarkBorderBack((v) => !v)}
                              className="accent-[var(--admin-gold)] h-4 w-4"
                              data-testid="check-dark-border-back"
                            />
                            <span className="text-[10px] text-[var(--admin-ink-dim)]">Back</span>
                          </label>
                        </div>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-[var(--admin-ink-dim)] block mb-1">
                          Eye appeal
                        </span>
                        <div className="flex gap-1">
                          {[-2, -1, 0, 1, 2].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setEyeAppealModifier(n)}
                              className={`flex-1 text-[10px] font-bold px-1.5 py-1 rounded border transition-colors ${
                                eyeAppealModifier === n
                                  ? "bg-[var(--admin-gold)] text-[#1A1400] border-[var(--admin-gold)]"
                                  : "bg-[var(--admin-panel)] text-[var(--admin-ink-dim)] border-[var(--admin-line)] hover:border-[var(--admin-gold)]"
                              }`}
                              data-testid={`btn-eye-appeal-${n >= 0 ? "p" + n : "m" + Math.abs(n)}`}
                            >
                              {n > 0 ? `+${n}` : n}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    {Object.keys(mvgs.deductions).length > 0 && (
                      <div className="text-[10px] text-[var(--admin-ink-dim)] font-mono">
                        {Object.entries(mvgs.deductions).map(([k, v]) => (
                          <span key={k} className="inline-block mr-2 whitespace-nowrap">
                            {k}:{" "}
                            <span className={v > 0 ? "text-[var(--admin-green)]" : "text-[var(--admin-red)]"}>
                              {v > 0 ? `+${v}` : v}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* Grade summary — always visible at top */}
            {!isNonNumeric && (
              <div data-canonical-section="grade-result" data-testid="section-grade-result">
                <GradeDisplay
                  overall={overall}
                  sub={sub}
                  hasCrease={surface.hasCrease}
                  hasTear={surface.hasTear}
                  manualOverride={null}
                  onOverride={() => {}}
                  lockedByMvgs={true}
                  gradeLabel={label}
                  isBlack={isBlack}
                  strengthScore={
                    (aiAnalysis as any)?.grade_strength_score ?? (gradingData as any)?.gradeStrengthScore ?? null
                  }
                  cornersZonesSet={0}
                  edgesZonesSet={0}
                  cornersWorstKey=""
                  edgesWorstKey=""
                  aiSubgrades={aiSubgrades}
                  aiConfidence={aiConfidenceMap}
                />
              </div>
            )}

            {/* Cross-grade estimate REMOVED (owner directive 2026-07-02):
                the MintVault/PSA/BGS/TAG cross-grade estimate is not needed. */}

            {isNonNumeric && (
              <div className="rounded-xl p-4 bg-[color-mix(in_srgb,var(--admin-amber)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-amber)_40%,transparent)] text-center">
                <p className="text-[var(--admin-amber)] text-2xl font-black">
                  {authStatus === "authentic_altered" ? "AA" : "NO"}
                </p>
                <p className="text-[var(--admin-amber)] text-xs mt-1">
                  {authStatus === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL"}
                </p>
              </div>
            )}

            {/* 8-dot Card Tool launchers moved to the ImageViewer controls row
                (under the card image, beside Mark Defects / Manual Crop) —
                owner-requested workflow, 2026-07-03. The ManualCardTool modal +
                its state stay here; only the trigger buttons relocated. */}

            {/* MVGS v2 — Whitening / Crease / Tear. Hoisted here (high in the
                sidebar) so the measurement-tool
                launcher + severity selectors sit in the operator's eye line.
                This is the ONE canonical home for these controls — the Surface
                block below no longer carries duplicates. All identifiers are
                component-scope, so the move keeps them in scope. */}
            <div
              className="bg-[var(--admin-panel2)] rounded-lg p-3 space-y-2 mb-2 border border-[var(--admin-gold)]/30"
              data-canonical-section="d1-d2-d3"
              data-testid="section-d1-d2-d3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm leading-none">📏</span>
                <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">
                  MVGS v2 — Whitening / Crease / Tear
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[var(--admin-ink-dim)] text-[10px] block">Wrinkle severity</label>
                  <select
                    value={wrinkleSeverity ?? ""}
                    onChange={(e) => {
                      setWrinkleSeverity((e.target.value || null) as typeof wrinkleSeverity);
                      clearOverallOverrideIfSet();
                    }}
                    className="w-full bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded px-2 py-1 text-xs text-[var(--admin-ink)]"
                    data-testid="select-wrinkle-severity"
                  >
                    <option value="">— none —</option>
                    <option value="tiny_back">Tiny (back) · cap 6.5</option>
                    <option value="longer_back">Longer (back) · cap 6</option>
                    <option value="small_front">Small (front) · cap 5.5</option>
                    <option value="multiple_front">Multiple (front) · cap 5</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[var(--admin-ink-dim)] text-[10px] block">
                    Tear severity <span className="text-[var(--admin-ink-faint)]">(overrides checkbox)</span>
                  </label>
                  <select
                    value={tearSeverity ?? ""}
                    onChange={(e) => {
                      setTearSeverity((e.target.value || null) as typeof tearSeverity);
                      clearOverallOverrideIfSet();
                    }}
                    className="w-full bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded px-2 py-1 text-xs text-[var(--admin-ink)]"
                    data-testid="select-tear-severity"
                  >
                    <option value="">— none —</option>
                    <option value="minor">Minor · cap 2</option>
                    <option value="significant">Significant · cap 1.5</option>
                    <option value="major">Major / missing → NO</option>
                  </select>
                </div>
              </div>
              <p className="text-[var(--admin-ink-faint)] text-[10px] italic mt-1">
                📏 Whitening + crease lines are drawn inside <strong>Mark Defects</strong> (pin / whitening / crease
                tool palette).
              </p>
              {(whiteningLines.length > 0 || creaseSpanPct != null) && (
                <p className="text-[var(--admin-ink-faint)] text-[10px] font-mono">
                  {whiteningLines.length > 0 &&
                    `${whiteningLines.length} whitening line${whiteningLines.length === 1 ? "" : "s"} marked`}
                  {whiteningLines.length > 0 && creaseSpanPct != null && " · "}
                  {creaseSpanPct != null && `crease ${creaseSpanPct}% span`}
                </p>
              )}
            </div>

            {/* Legacy "Manual Centering (Front/Back)" trigger buttons removed
                (owner directive 2026-07-01) — centering is measured via the
                8-dot Card Tool only. Badge below still reflects centeringMethod
                (set by the Card Tool) so the source stays visible. */}
            <div className="flex gap-2 mb-2">
              {centeringMethod && (
                <span
                  className={`self-center text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${centeringMethod === "manual" ? "bg-[color-mix(in_srgb,var(--admin-green)_12%,transparent)] text-[var(--admin-green)] border border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)]" : "bg-[var(--admin-gold)]/10 text-[var(--admin-gold)]/70 border border-[var(--admin-gold)]/20"}`}
                >
                  {centeringMethod}
                </span>
              )}
            </div>

            <div
              className="bg-[var(--admin-panel2)] rounded-lg p-3 space-y-2"
              data-canonical-section="centering"
              data-testid="section-centering"
            >
              <CenteringInput
                frontLR={frontLR}
                frontTB={frontTB}
                backLR={backLR}
                backTB={backTB}
                subgrade={centeringCalc}
                onChange={(field, val) => {
                  if (field === "frontLR") setFrontLR(val);
                  else if (field === "frontTB") setFrontTB(val);
                  else if (field === "backLR") setBackLR(val);
                  else setBackTB(val);
                  clearOverallOverrideIfSet();
                }}
                overrideGrade={centeringOverride}
                onOverride={(v) => {
                  setCenteringOverride(v);
                }}
              />
              {/* MVGS-standard centering threshold legend — two rows of chips
                (front/back) showing the band each ratio falls into. Chips
                matching the current input values are highlighted in gold.
                Display only — no state changes, no saves. */}
              {(() => {
                // Bands mirror shared/centering.ts exactly. A chip highlights
                // when an entered axis grades into that band — matched via the
                // shared centeringAxisGradeOrNull, so the legend can never drift
                // from the engine.
                const FRONT_CHIPS: { label: string; grade: number }[] = [
                  { label: "≤55/45", grade: 10 },
                  { label: "≤60/40", grade: 9 },
                  { label: "≤65/35", grade: 8 },
                  { label: "≤70/30", grade: 7 },
                  { label: "≤75/25", grade: 6 },
                  { label: "≤80/20", grade: 5 },
                  { label: "≤85/15", grade: 4 },
                  { label: "≤90/10", grade: 3 },
                  { label: "≤95/5", grade: 2 },
                  { label: ">95", grade: 1 },
                ];
                const BACK_CHIPS: { label: string; grade: number }[] = [
                  { label: "≤75/25", grade: 10 },
                  { label: "≤85/15", grade: 9 },
                  { label: "≤90/10", grade: 8 },
                  { label: "≤95/5", grade: 6 },
                  { label: ">95", grade: 3 },
                ];
                const frontHits = new Set(
                  [centeringAxisGradeOrNull(frontLR, "front"), centeringAxisGradeOrNull(frontTB, "front")].filter(
                    (g): g is number => g !== null
                  )
                );
                const backHits = new Set(
                  [centeringAxisGradeOrNull(backLR, "back"), centeringAxisGradeOrNull(backTB, "back")].filter(
                    (g): g is number => g !== null
                  )
                );

                const Chip = ({ label, grade, active }: { label: string; grade: number; active: boolean }) => (
                  <span
                    className={
                      active
                        ? "inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-[var(--admin-gold)] text-[#1A1400] font-bold"
                        : "inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded border border-[var(--admin-line)] text-[var(--admin-ink-faint)]"
                    }
                  >
                    <span>{label}</span>
                    <span className="opacity-70">= {grade}</span>
                  </span>
                );

                return (
                  <div className="space-y-1 pt-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--admin-ink-dim)] w-10">
                        Front
                      </span>
                      {FRONT_CHIPS.map((c) => (
                        <Chip key={c.label} label={c.label} grade={c.grade} active={frontHits.has(c.grade)} />
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--admin-ink-dim)] w-10">
                        Back
                      </span>
                      {BACK_CHIPS.map((c) => (
                        <Chip key={c.label} label={c.label} grade={c.grade} active={backHits.has(c.grade)} />
                      ))}
                    </div>
                  </div>
                );
              })()}
              {/* MVGS centering calculator — applies the MVGS front/back tables
                to the four ratios and writes the result into centeringOverride
                (same state path as the manual subgrade stepper), which
                buildPayload() ships via grade_centering. */}
              {(() => {
                const allFilled = !!(frontLR.trim() && frontTB.trim() && backLR.trim() && backTB.trim());
                const ratioRe = /^\s*\d+\s*\/\s*\d+\s*$/;
                const allValid =
                  allFilled &&
                  ratioRe.test(frontLR) &&
                  ratioRe.test(frontTB) &&
                  ratioRe.test(backLR) &&
                  ratioRe.test(backTB);
                const isDisabled = !allValid;
                return (
                  <button
                    type="button"
                    onClick={() => {
                      const result = centeringSubgradeStrict(frontLR, frontTB, backLR, backTB);
                      if (!result) {
                        toast({
                          title: "MVGS calc unavailable",
                          description: "MVGS calc needs all 4 ratios in X/Y format (e.g. 53/47)",
                          variant: "destructive",
                        });
                        return;
                      }
                      setCenteringOverride(result.subgrade);
                      const AXIS_NAMES: Record<CenteringAxis, string> = {
                        frontLR: "Front L/R",
                        frontTB: "Front T/B",
                        backLR: "Back L/R",
                        backTB: "Back T/B",
                      };
                      toast({
                        title: `Centering set to ${result.subgrade}/10 (MVGS — worst axis: ${AXIS_NAMES[result.worstAxis]} ${result.perAxis[result.worstAxis]}/10)`,
                      });
                    }}
                    disabled={isDisabled}
                    title={
                      isDisabled
                        ? "Fill all 4 ratios in X/Y format to enable"
                        : "Compute centering subgrade from the four ratios using MVGS standard"
                    }
                    data-testid="btn-mvgs-calc"
                    className="text-[10px] font-bold uppercase tracking-widest border border-[var(--admin-gold)]/50 text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/10 px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    MVGS Calc
                  </button>
                );
              })()}
            </div>

            {/* Corners — MVGS-driven when locked, override when unlocked */}
            <div className="bg-[var(--admin-panel2)] rounded-lg p-3">
              <div className="flex items-center justify-between">
                <p className="text-[var(--admin-gold-deep)] text-[10px] uppercase tracking-widest font-bold">Corners</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-[var(--admin-ink)]">{sub.corners || "—"}</span>
                  {/* Locked: corners is 100% MVGS auto (from defect pins) —
                      manual override removed per owner directive 2026-07-01. */}
                  <span className="w-20 text-xs text-center text-[var(--admin-ink-faint)] italic">MVGS auto</span>
                </div>
              </div>
            </div>

            {/* Edges — MVGS-driven when locked, override when unlocked */}
            <div className="bg-[var(--admin-panel2)] rounded-lg p-3">
              <div className="flex items-center justify-between">
                <p className="text-[var(--admin-gold-deep)] text-[10px] uppercase tracking-widest font-bold">Edges</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-[var(--admin-ink)]">{sub.edges || "—"}</span>
                  {/* Locked: edges is 100% MVGS auto (from defect pins) —
                      manual override removed per owner directive 2026-07-01. */}
                  <span className="w-20 text-xs text-center text-[var(--admin-ink-faint)] italic">MVGS auto</span>
                </div>
              </div>
            </div>

            {/* Surface — MVGS-derived. Manual front/back dropdowns from the
                old SurfaceGrading component are gone; surface subgrade comes
                from computeMvgsScore (mvgsSurfaceGrade) with the override
                stepper layered on top. Condition checkboxes still drive
                hasCrease / hasTear caps. */}
            <div
              className="bg-[var(--admin-panel2)] rounded-lg p-3 space-y-3"
              data-canonical-section="surface"
              data-testid="section-surface"
            >
              <div className="flex items-center gap-2">
                <Eye size={14} className="text-[var(--admin-gold)]" />
                <h3 className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">Surface</h3>
              </div>

              {/* v2 measurement banners — prefer the measurement, fall back
                  to the legacy boolean. Shown ONLY for the active source so
                  the operator sees the actual ceiling that will apply. */}
              {creaseSpanPct != null ? (
                <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-red)_18%,transparent)] border border-[var(--admin-red)] rounded px-3 py-2">
                  <AlertTriangle size={12} className="text-[var(--admin-red)] flex-shrink-0" />
                  <p className="text-[var(--admin-red)] text-xs">
                    Crease line drawn — {creaseSpanPct}% of card span (v2 measurement; ceiling applies via engine)
                  </p>
                </div>
              ) : surface.hasCrease ? (
                <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-red)_12%,transparent)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] rounded px-3 py-2">
                  <AlertTriangle size={12} className="text-[var(--admin-red)] flex-shrink-0" />
                  <p className="text-[var(--admin-red)] text-xs">
                    Crease detected (legacy flag) — cap 4.5. Draw the crease line for the strict v2 ceiling.
                  </p>
                </div>
              ) : null}
              {tearSeverity ? (
                <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-red)_22%,transparent)] border border-[var(--admin-red)] rounded px-3 py-2">
                  <AlertTriangle size={12} className="text-[var(--admin-red)] flex-shrink-0" />
                  <p className="text-[var(--admin-red)] text-xs">
                    Tear severity: {tearSeverity} —{" "}
                    {tearSeverity === "major"
                      ? "→ NO (Not Graded), returned unslabbed"
                      : tearSeverity === "significant"
                        ? "cap 1.5"
                        : "cap 2"}{" "}
                    (v2 measurement)
                  </p>
                </div>
              ) : surface.hasTear ? (
                <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-red)_18%,transparent)] border border-[var(--admin-red)] rounded px-3 py-2">
                  <AlertTriangle size={12} className="text-[var(--admin-red)] flex-shrink-0" />
                  <p className="text-[var(--admin-red)] text-xs">
                    Tear detected (legacy flag) — cap 2. Select severity below for the explicit v2 ceiling.
                  </p>
                </div>
              ) : null}
              {wrinkleSeverity && (
                <div className="flex items-center gap-2 bg-[color-mix(in_srgb,var(--admin-red)_16%,transparent)] border border-[var(--admin-red)] rounded px-3 py-2">
                  <AlertTriangle size={12} className="text-[var(--admin-red)] flex-shrink-0" />
                  <p className="text-[var(--admin-red)] text-xs">
                    Wrinkle severity: {wrinkleSeverity.replace("_", " ")} — cap{" "}
                    {wrinkleSeverity === "tiny_back"
                      ? "6.5"
                      : wrinkleSeverity === "longer_back"
                        ? "6"
                        : wrinkleSeverity === "small_front"
                          ? "5.5"
                          : "5"}{" "}
                    (v2 measurement)
                  </p>
                </div>
              )}

              {/* Issue checkboxes — flow into the surface state, which then
                  feeds the headline-grade caps (hasCrease → 5, hasTear → 3)
                  via calculateOverallGrade. */}
              <div className="space-y-1.5">
                {SURFACE_ISSUES.map((issue) => (
                  <label key={String(issue.key)} className="flex items-start gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={surface[issue.key] as boolean}
                      onChange={(e) => {
                        setSurface({ ...surface, [issue.key]: e.target.checked });
                        clearOverallOverrideIfSet();
                      }}
                      className="mt-0.5 accent-[var(--admin-gold)]"
                    />
                    <span
                      className={`text-xs group-hover:text-[var(--admin-ink)] transition-colors ${
                        issue.warning
                          ? "text-[color-mix(in_srgb,var(--admin-red)_50%,transparent)]"
                          : "text-[var(--admin-ink-faint)]"
                      }`}
                    >
                      {issue.warning && "⚠️ "}
                      {issue.label}
                      {issue.warning && (
                        <span className="text-[var(--admin-red)] text-[10px] block ml-1">{issue.warning}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>

              {/* MVGS v2 measurement controls (wrinkle/tear severity, the
                  Measurement Tool launcher, and the line/crease status line)
                  have moved UP to the dedicated "MVGS v2 — Whitening / Crease /
                  Tear" panel just below the Card Tool row, so they sit in the
                  operator's eye line. One canonical home — not duplicated here. */}

              {/* MVGS-derived surface subgrade — read-only display + override
                  stepper. Mirrors the visual treatment of the old SurfaceGrading
                  component's subgrade row. */}
              <div>
                <p className="text-[var(--admin-ink-dim)] text-[10px]">
                  Surface:{" "}
                  <span className="font-bold text-sm" style={{ color: surfaceGradeColor(surfaceGrade) }}>
                    {surfaceGrade}
                  </span>
                  <span className="text-[var(--admin-ink-dim)]"> (MVGS — from defect pins)</span>
                  {surfaceOverride !== null && <span className="text-[var(--admin-ink-dim)]"> (manual)</span>}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  {/* Locked: surface is 100% MVGS auto (from defect pins) —
                      manual override removed per owner directive 2026-07-01. */}
                  <span className="text-xs text-[var(--admin-ink-faint)] italic">MVGS auto</span>
                </div>
              </div>
            </div>

            {/* Authentication */}
            <div
              className="bg-[var(--admin-panel2)] rounded-lg p-3"
              data-canonical-section="authentication"
              data-testid="section-authentication"
            >
              <Authentication
                status={authStatus}
                notes={authNotes}
                onChange={(s, n) => {
                  setAuthStatus(s);
                  setAuthNotes(n);
                }}
              />
            </div>

            {/* Generate Description (Option B — Haiku writes grade rationale
              from the admin's manual subgrades + confirmed defects).
              Hidden in admin-review — paid LLM call, charge-safe. */}
            {!adminReview && (
              <div>
                <button
                  type="button"
                  onClick={generateDescription}
                  disabled={approvalInteractionLocked || generatingDescription || subgradesIncomplete}
                  title={
                    approvalInteractionLocked
                      ? gradingWorkflowStatusCopy
                      : subgradesIncomplete
                      ? "Set all four subgrades first"
                      : "Write a grade rationale paragraph using the current subgrades + confirmed defects"
                  }
                  className="w-full flex items-center justify-center gap-2 border border-[var(--admin-gold)]/30 text-[var(--admin-gold)] hover:border-[var(--admin-gold)]/60 text-xs font-bold uppercase px-4 py-2.5 rounded transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid="btn-generate-description"
                >
                  {generatingDescription ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {generatingDescription ? "Writing description…" : "Generate Description"}
                </button>
              </div>
            )}

            {/* Notes */}
            <div
              className="bg-[var(--admin-panel2)] rounded-lg p-3"
              data-canonical-section="notes"
              data-testid="section-notes"
            >
              <GradingNotes
                privateNotes={privateNotes}
                gradeExplanation={gradeExplanation}
                onChange={(field, val) => {
                  if (field === "privateNotes") setPrivateNotes(val);
                  else setGradeExplanation(val);
                }}
              />
            </div>

            {/* v413 — single-button approval. "Save Draft" is gone; auto-save
              fires silently on every blur. The button gates on subgrades
              present + overall > 0 + (post-approve, always enabled because
              the cert is live and we want edits to flow through). The auto-
              save status pip sits to the left of the button. */}
            <div
              className="sticky bottom-0 pb-2 pt-1 bg-[var(--admin-panel)] space-y-2"
              data-canonical-section="footer-actions"
              data-testid="section-footer-actions"
            >
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
                <span className="text-[var(--admin-ink-faint)]">
                  {autoSaveStatus === "saving" && (
                    <span className="flex items-center gap-1.5">
                      <Loader2 size={10} className="animate-spin" /> Saving…
                    </span>
                  )}
                  {autoSaveStatus === "saved" && (
                    <span className="flex items-center gap-1.5 text-[var(--admin-green)]">
                      <CheckCircle2 size={10} /> Saved
                    </span>
                  )}
                  {autoSaveStatus === "error" && (
                    <span className="text-[var(--admin-red)]">Save failed — retrying on next change</span>
                  )}
                </span>
                {(["front", "back"] as const)
                  .filter((s) => cropSync[s].status !== "idle")
                  .map((s) => (
                    <span key={s} className="flex items-center gap-1.5">
                      {cropSync[s].status === "pending" && (
                        <span className="flex items-center gap-1 text-[var(--admin-gold)]">
                          <Loader2 size={10} className="animate-spin" /> {s} crop syncing…
                        </span>
                      )}
                      {cropSync[s].status === "synced" && (
                        <span className="flex items-center gap-1 text-[var(--admin-green)]">
                          <CheckCircle2 size={10} /> {s} crop saved
                        </span>
                      )}
                      {cropSync[s].status === "failed" && (
                        <span className="flex items-center gap-1.5 text-[var(--admin-red)]">
                          {s} crop upload failed
                          <button type="button" onClick={() => retryCrop(s)} className="underline hover:no-underline">
                            Retry
                          </button>
                        </span>
                      )}
                    </span>
                  ))}
                {effectiveGradeApprovedAt && <span className="text-[var(--admin-green)]">✓ Live</span>}
              </div>
              {gradingWorkflowLocked ? (
                <div
                  className="w-full flex items-center justify-center gap-2 border border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs font-bold uppercase px-4 py-2.5 rounded"
                  data-testid="btn-approve-publish-locked"
                >
                  {!gradingError && <Loader2 size={13} className="animate-spin" />}
                  {gradingError ? "Workflow unavailable" : "Checking approval state"}
                </div>
              ) : !isApproved ? (
                <button
                  type="button"
                  onClick={() => {
                    if (gradingWorkflowLocked) return;
                    if (cropSyncBlocking) return; // belt-and-braces; button is disabled too
                    setShowConfirm(true);
                  }}
                  disabled={
                    gradingWorkflowLocked ||
                    approving ||
                    overall <= 0 ||
                    subgradesIncomplete ||
                    !deionizationComplete ||
                    cropSyncBlocking
                  }
                  title={
                    gradingWorkflowLocked
                      ? gradingWorkflowStatusCopy
                      : overall <= 0 || subgradesIncomplete
                      ? "Set all four subgrades first"
                      : !deionizationComplete
                        ? "Tick 'Deionization complete' before approving"
                        : cropFailedSides.length > 0
                          ? `${cropFailedSides.join(" + ")} crop failed to save — retry before approving`
                          : cropPendingSides.length > 0
                            ? `${cropPendingSides.join(" + ")} crop still saving to storage — wait for it to finish`
                            : graderMode
                              ? graderEdit
                                ? "Save edits without publishing — this card stays pending review"
                                : "Submit this grading for admin review"
                              : adminReview
                                ? "Approve the staff submission and publish the reviewed grade"
                                : "Approve and publish — cert goes live and PDF becomes available at the public URL"
                  }
                  data-testid="btn-approve-publish"
                  className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold uppercase px-4 py-2.5 rounded transition-all hover:opacity-90 disabled:opacity-40"
                >
                  {approving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  {subgradesIncomplete
                    ? "Set subgrades first"
                    : !deionizationComplete
                      ? "Confirm deionization first"
                      : cropFailedSides.length > 0
                        ? "Crop failed — retry"
                        : cropPendingSides.length > 0
                          ? "Crop syncing…"
                          : primaryActionCopy}
                </button>
              ) : (
                <div className="w-full flex items-center justify-center gap-2 bg-[var(--admin-green)]/10 border border-[var(--admin-green)]/40 text-[var(--admin-green)] text-xs font-bold uppercase px-4 py-2.5 rounded">
                  <CheckCircle2 size={13} />
                  Approved & Live · {certIdStr || ""}
                </div>
              )}
            </div>
          </fieldset>
        </div>
      </div>

      {/* 8-dot Card Tool — crop + deskew + centering on the RAW original.
          After Compute the tool stays open in the defects phase against the
          freshly-cropped display image, using the same `onDefectAdded`
          handler that image-viewer mark mode uses (so the auto-save path
          is identical — no new server route, no divergent save semantics). */}
      {manualCardToolSide && (manualCardToolSide === "front" ? urls.front_original : urls.back_original) && (
        <ManualCardTool
          apiBase={apiBase}
          certId={certId}
          side={manualCardToolSide}
          rawImageUrl={(manualCardToolSide === "front" ? urls.front_original : urls.back_original) as string}
          onCentering={(result) => {
            if (result.side === "front") {
              setFrontLR(result.leftRight);
              setFrontTB(result.topBottom);
              setManualOuterFront(result.outer);
              setManualInnerFront(result.inner);
            } else {
              setBackLR(result.leftRight);
              setBackTB(result.topBottom);
              setManualOuterBack(result.outer);
              setManualInnerBack(result.inner);
            }
            setCenteringOverride(null);
            setCenteringMethod("manual");
            clearOverallOverrideIfSet();
          }}
          onDefectAdded={(d) => setDefects((prev) => [...prev, d])}
          existingDefects={defects}
          // MVGS v2.1 — line tools mirrored from image-viewer mark mode.
          // Same callbacks; the defects phase shares the panel's state.
          whiteningLines={whiteningLines}
          creaseLines={creaseLines}
          onWhiteningLinesChange={(next) => {
            setWhiteningLines(next);
            clearOverallOverrideIfSet();
          }}
          onCreaseLinesChange={(next) => {
            setCreaseLines(next);
            clearOverallOverrideIfSet();
          }}
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/images`] });
            queryClient.invalidateQueries({ queryKey: [`${apiBase}/certificates/${certId}/grading`] });
            setManualCardToolSide(null);
          }}
          onCancel={() => setManualCardToolSide(null)}
          // Background crop upload owned by the panel so it survives this tool
          // closing and gates the Approve button. Tracked PER SIDE so a back
          // upload can't clobber a still-pending front one.
          onStartCropUpload={(payload) => runRecrop(payload.side, payload)}
          cropSyncStatus={cropSync[manualCardToolSide].status}
          onRetryCrop={() => retryCrop(manualCardToolSide)}
          // Skip centering when this side ALREADY has a crop image: open straight
          // to defect-marking on the existing crop. GATE ON CROP PRESENCE, not
          // centering-done — a legacy side can have centering ratios but no crop
          // image, where opening defects on the raw would misalign pins.
          initialPhase={
            (
              manualCardToolSide === "front"
                ? urls.front_display || urls.front_cropped
                : urls.back_display || urls.back_cropped
            )
              ? "defects"
              : "capture"
          }
          existingCroppedUrl={
            (manualCardToolSide === "front"
              ? urls.front_display || urls.front_cropped
              : urls.back_display || urls.back_cropped) || undefined
          }
        />
      )}

      {/* MeasurementTool overlay retired in v2.1 — operator draws lines in
          the same mark-mode surfaces where pins are placed (image-viewer mark
          mode + manual-card-tool defects phase). State updates flow through
          onWhiteningLinesChange / onCreaseLinesChange callbacks on those
          components. */}

      {/* Confirm modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-[var(--admin-panel)] border border-[var(--admin-line-hard)] rounded-xl p-6 max-w-sm w-full space-y-4">
            <p className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest">{confirmTitle}</p>
            <p className="text-[var(--admin-ink-dim)] text-sm">
              {graderMode ? (graderEdit ? "Save grade edits for " : "Submit grade of ") : "Publish grade of "}
              <strong className="text-white">
                {finalGradeOverall} —{" "}
                {isNonNumeric ? (authStatus === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL") : label}
              </strong>{" "}
              for <strong className="text-white">{cardName}</strong> ({cardSet})?
            </p>
            <p className="text-[var(--admin-ink-dim)] text-xs">
              {graderMode
                ? graderEdit
                  ? "This card STAYS pending review — it does NOT publish. An admin still approves it. Your re-measured grade replaces the submitted one and is recorded in the audit log."
                  : "This sends the card to admin review. It does NOT publish a live certificate."
                : "The cert goes live, the Digital Grading Report becomes publicly accessible, and any future edits to subgrades or notes will be live immediately (recorded in the audit log)."}
            </p>
            {isBlack && (
              <div className="flex items-center gap-2 text-[var(--admin-gold)] text-xs">
                <span className="text-lg">★</span>
                <span>This card qualifies for PRISTINE 10P — all subgrades are perfect 10.0</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="border border-[var(--admin-line-hard)] text-[var(--admin-ink-dim)] text-xs py-2 px-3 rounded hover:bg-[var(--admin-panel2)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => approveGrade()}
                disabled={approving || gradingWorkflowLocked}
                className="flex-1 bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-xs font-bold py-2 rounded disabled:opacity-40"
              >
                {approving
                  ? graderMode
                    ? "Saving…"
                    : "Publishing…"
                  : graderMode && graderEdit
                    ? "Save edits"
                    : graderMode
                      ? "Submit for approval"
                      : "Approve & Publish"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
