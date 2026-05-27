import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Save, Zap, Sparkles, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ImageViewer, { mapLegacyTypeToMvgsCode } from "./image-viewer";
import DefectAnnotation, { type Defect, type DefectCandidate, deriveZone } from "./defect-annotation";
import CenteringInput from "./centering-input";
import { calcCornerSubgrade, type CornerValues } from "./corner-grading";
import { calcEdgeSubgrade, type EdgeValues } from "./edge-grading";
import SurfaceGrading, { calcSurfaceSubgrade, type SurfaceValues } from "./surface-grading";
import GradeDisplay from "./grade-display";
import Authentication, { type AuthStatus } from "./authentication";
import GradingNotes from "./grading-notes";
import CaptureWizard from "./capture-wizard";
import QuickGrade from "./quick-grade";
import AiPanel, { type AiAnalysisResult, type AiIdentification } from "./ai-panel";
import ManualCentering, { type CenteringResult } from "./manual-centering";
import CrossGradeDisplay from "./cross-grade-display";

// Shared calculation imports (client-side re-implementations)
import {
  calculateOverallGrade,
  getGradeLabel,
  isBlackLabel as checkBlackLabel,
  getCenteringGrade,
  mvgsCenteringSubgrade,
} from "./grade-logic";
import { computeMvgsScore, gradeFromMvgsScore } from "@shared/mvgs-scoring";

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
          ? "border border-emerald-600/40 text-emerald-600 bg-emerald-50"
          : status === "loading"
            ? "border border-[#D4AF37]/40 text-[#D4AF37] bg-[#D4AF37]/5"
            : "border border-[#D4D0C8] text-[#333333] hover:text-[#D4AF37] hover:border-[#D4AF37]/40"
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
  certIdStr?: string;
  cardName: string;
  cardSet: string;
  existingGrade?: string | null;
  onGradeApproved?: (certId?: string, grade?: string) => void;
  onCertUpdated?: () => void;
  /** When set, GradingPanel processes this analysis as if AI panel completed */
  pendingAnalysis?: { analysis: AiAnalysisResult | null; identification: AiIdentification | null } | null;
  onPendingAnalysisConsumed?: () => void;
  /** Callback when user manually identifies a card from the AI panel's Search TCG */
  onManualIdentification?: (identification: Record<string, unknown>) => void;
  cardGame?: string;
}

// Defaults use 0 to indicate "not yet graded" — prevents false Black Label on ungraded certs
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

export default function GradingPanel({
  certId,
  certIdStr,
  cardName,
  cardSet,
  existingGrade,
  onGradeApproved,
  onCertUpdated,
  pendingAnalysis,
  onPendingAnalysisConsumed,
  onManualIdentification,
  cardGame,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Image URLs
  const { data: imageData } = useQuery<{ urls: Record<string, string | null>; quality: Record<string, any> }>({
    queryKey: [`/api/admin/certificates/${certId}/images`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/certificates/${certId}/images`, { credentials: "include" });
      if (!res.ok) return { urls: {}, quality: {} };
      return res.json();
    },
    staleTime: 30_000,
  });

  // Grading data
  const { data: gradingData } = useQuery<any>({
    queryKey: [`/api/admin/certificates/${certId}/grading`],
    queryFn: async () => {
      const res = await fetch(`/api/admin/certificates/${certId}/grading`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  // Manual centering state
  const [manualCenteringSide, setManualCenteringSide] = useState<"front" | "back" | null>(null);
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
  // Pre-grade checklist — session-only state, deliberately NOT persisted to
  // the cert. It's an operational reminder that the grader deionized the
  // card before scanning, not a data field on the certificate.
  const [deionizationComplete, setDeionizationComplete] = useState(false);
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

  // Quick-grade mode
  const [quickGrade, setQuickGrade] = useState(() => {
    try {
      return localStorage.getItem("mv_quick_grade") === "1";
    } catch {
      return false;
    }
  });
  const [quickFocusField, setQuickFocusField] = useState<"centering" | "corners" | "edges" | "surface" | null>(null);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        saveDraft();
      } else if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        // Pre-grade checklist gate — Ctrl+Enter shortcut must respect the
        // deionization checkbox the same way the Approve button does.
        if (!deionizationComplete) {
          toast({ title: "Confirm deionization first", description: "Tick 'Deionization complete' before approving." });
          return;
        }
        setShowConfirm(true);
      } else if (e.key === "q" || e.key === "Q") {
        setQuickGrade((v) => {
          const next = !v;
          try {
            localStorage.setItem("mv_quick_grade", next ? "1" : "0");
          } catch {}
          return next;
        });
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
    if (typeof (gradingData as any).eyeAppealModifier === "number")
      setEyeAppealModifier((gradingData as any).eyeAppealModifier);
    if (gradingData.authStatus) setAuthStatus(gradingData.authStatus);
    if (gradingData.authNotes) setAuthNotes(gradingData.authNotes);
    if (gradingData.privateNotes) setPrivateNotes(gradingData.privateNotes);
    if (gradingData.gradeExplanation) setGradeExplanation(gradingData.gradeExplanation);
    if (gradingData.gradeApprovedBy) {
      setApproved(true);
      setGradeApprovedBy(gradingData.gradeApprovedBy);
    }
    if ((gradingData as any).gradeApprovedAt) {
      setGradeApprovedAt(String((gradingData as any).gradeApprovedAt));
    }
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
    if (gradingData.grade != null) setOverallOverride(Number(gradingData.grade));
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
  const autoSavedClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedOnceRef = useRef(false);

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

  async function saveEditedGrade(): Promise<void> {
    setEditSaving(true);
    try {
      const res = await fetch(`/api/admin/certificates/${certId}/grade`, {
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
      queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/grading`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/printing/browser"] });
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
      const res = await fetch(`/api/admin/certificates/${certId}/grade`, {
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
    if (!certId) return;
    if (gradeApprovedAt) return; // auto-save is pre-approval only
    if (!hydratedOnceRef.current) {
      hydratedOnceRef.current = true;
      return;
    }
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
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
      const aiDefects: Defect[] = analysis.defects.map(
        (ad, i) =>
          ({
            id: maxHumanId + 1000 + i, // high IDs to avoid collision with human defects
            type: ad.type?.replace(/_/g, " ") || "Unknown",
            severity: (ad.severity === "major" ? "significant" : ad.severity === "moderate" ? "moderate" : "minor") as
              | "minor"
              | "moderate"
              | "significant",
            description: ad.description || "",
            location: ad.location || (ad as any).detected_in || "front",
            image_side: ad.location === "back" ? "back" : "front",
            x_percent: ad.position_x_percent ?? 50,
            y_percent: ad.position_y_percent ?? 50,
            _aiSource: true, // flag so image-viewer can render as red ring
          }) as Defect & { _aiSource: boolean }
      );
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
  }

  /**
   * Populate all sub-grade overrides + zone values from the last AI analysis
   * that ran during this session. Clears overallOverride so the formula
   * re-derives from the AI sub-grades. Gated on in-session aiAnalysis —
   * on a cold reload without a fresh AI run, the button is disabled.
   */
  function handleRevertToAi() {
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

  // Calculated subgrades
  const centeringCalc =
    frontLR && frontTB && backLR && backTB ? getCenteringGrade(frontLR, frontTB, backLR, backTB) : null;
  const centering = centeringOverride ?? centeringCalc ?? 10;
  const cornersCalc = calcCornerSubgrade(corners);
  const edgesCalc = calcEdgeSubgrade(edges);
  const cornersGrade = cornersOverride ?? cornersCalc.grade;
  const edgesGrade = edgesOverride ?? edgesCalc.grade;
  const surfaceGrade = surfaceOverride ?? calcSurfaceSubgrade(surface);

  // Zone-set counts for the partial-zones indicator + worstKey for the
  // "Limited by …" tooltip on the summary stepper. Surfaced post-PR-#45
  // when admins can no longer rely on AI pre-fill across all 8 zones.
  const cornersZonesSet = Object.values(corners).filter((v) => typeof v === "number" && v > 0).length;
  const edgesZonesSet = Object.values(edges).filter((v) => typeof v === "number" && v > 0).length;

  // AI / manual subgrades — produced from the steppers + AI baseline +
  // per-zone arrays. Used as the displayed subs when NO MVGS pins are
  // classified, and as the input to calculateOverallGrade in the same case.
  const aiSub = { centering, corners: cornersGrade, edges: edgesGrade, surface: surfaceGrade };

  // MVGS-derived overall — once any defect has been MVGS-classified
  // (mvgsCode set), the MVGS scoring engine becomes authoritative for both
  // the four subgrade chips AND the headline overall grade. Admin's
  // explicit overallOverride still wins over MVGS, which wins over AI.
  const mvgsForOverall = computeMvgsScore({
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
  });
  const hasMvgsPins = (defects || []).some((d) => d.mvgsCode);

  // MVGS subgrades — each category has a 25-pt budget; remaining points
  // bucket to 1-10. Centering's budget spans the combined front+back
  // deductions (front max -20, back max -5, total max -25). The three
  // other categories cap at -25 inside the scoring engine, so remaining ≥ 0.
  const mvgsCenteringGrade = mvgsRemainingToGrade(
    25 -
      Math.abs(mvgsForOverall.deductions.centering_front ?? 0) -
      Math.abs(mvgsForOverall.deductions.centering_back ?? 0)
  );
  const mvgsCornersGrade = mvgsRemainingToGrade(25 - Math.abs(mvgsForOverall.deductions.corners ?? 0));
  const mvgsEdgesGrade = mvgsRemainingToGrade(25 - Math.abs(mvgsForOverall.deductions.edges ?? 0));
  const mvgsSurfaceGrade = mvgsRemainingToGrade(25 - Math.abs(mvgsForOverall.deductions.surface ?? 0));

  // Displayed + saved subs: MVGS when any pin is MVGS-classified, AI/manual
  // otherwise. Feeds GradeDisplay's subgrade chips, isBlackLabel(), and
  // (via sub.* in buildPayload below) the approve-payload's grade_centering/
  // grade_corners/grade_edges/grade_surface fields.
  const sub = hasMvgsPins
    ? { centering: mvgsCenteringGrade, corners: mvgsCornersGrade, edges: mvgsEdgesGrade, surface: mvgsSurfaceGrade }
    : aiSub;

  const mvgsGrade = hasMvgsPins && mvgsForOverall.score != null ? gradeFromMvgsScore(mvgsForOverall.score) : null;
  const overall = overallOverride ?? mvgsGrade ?? calculateOverallGrade(sub, surface.hasCrease, surface.hasTear);

  // Generate Description gate: every subgrade must have a real value (>0).
  // Mirrors the server-side 422 check so the button stays disabled until ready.
  const subgradesIncomplete = !centering || !cornersGrade || !edgesGrade || !surfaceGrade;
  const label = getGradeLabel(overall);
  const isBlack = checkBlackLabel(sub, overall);

  const isNonNumeric = authStatus === "authentic_altered" || authStatus === "not_original";
  const finalGradeOverall = isNonNumeric ? (authStatus === "authentic_altered" ? "AA" : "NO") : String(overall);

  function buildPayload() {
    // Companion to server-side COALESCE fix (PR #14): omit fields that don't
    // carry information so the server preserves the existing DB value.
    // calcCornerSubgrade(DEFAULT_CORNERS) returns 0 when zone state is empty —
    // sending 0 would overwrite real data since 0 ≠ NULL in SQL's COALESCE.
    const out: Record<string, unknown> = {
      overall_grade: finalGradeOverall,
      auth_status: authStatus,
      auth_notes: authNotes,
      grade_explanation: gradeExplanation,
      private_notes: privateNotes,
    };

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

    return out;
  }

  const hasFront = !!(imageData?.urls?.front_display || imageData?.urls?.front_original);
  const hasBack = !!(imageData?.urls?.back_display || imageData?.urls?.back_original);
  const hasAnyImage = hasFront || hasBack;

  if (!hasAnyImage) {
    return (
      <CaptureWizard
        certId={certId}
        onComplete={() => queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] })}
        existingQuality={imageData?.quality}
      />
    );
  }

  async function saveDraft() {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/certificates/${certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      toast({ title: "Draft saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/grading`] });
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
      await fetch(`/api/admin/certificates/${certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const res = await fetch(`/api/admin/certificates/${certId}/generate-description`, {
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

  async function approveGrade() {
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
      const res = await fetch(`/api/admin/certificates/${certId}/approve`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildPayload(), grading_time_seconds: elapsedSeconds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Approve failed");
      setApproved(true);
      setShowConfirm(false);
      // Mirror server-side approve into local state so the post-approve
      // banner appears immediately without waiting for the next gradingData
      // refetch.
      setGradeApprovedAt(new Date().toISOString());
      setGradeApprovedBy("Cornelius Oliver");
      toast({ title: `${certIdStr || "Certificate"} approved & published — ${finalGradeOverall} ${label}` });
      onGradeApproved?.(certIdStr, finalGradeOverall);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/grading`] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
    } catch (e: any) {
      toast({ title: "Approve failed", description: e.message, variant: "destructive" });
    } finally {
      setApproving(false);
    }
  }

  const urls = imageData?.urls || {};

  return (
    <div className="bg-white border border-[#E8E4DC] rounded-xl p-4 space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Manual Grading Workstation</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRevertToAi}
            disabled={!aiAnalysis}
            title={
              aiAnalysis
                ? "Clear all overrides and re-populate sub-grades from the last AI run this session"
                : "Run AI Identify & Grade first to enable this"
            }
            className={`flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 rounded transition-all ${
              aiAnalysis
                ? "text-[#555555] border border-[#D4D0C8] hover:text-[#D4AF37] hover:border-[#D4AF37]/40"
                : "text-[#999999] border border-[#E8E4DC] opacity-60 cursor-not-allowed"
            }`}
          >
            Revert to AI
          </button>
          <button
            type="button"
            onClick={() =>
              setQuickGrade((v) => {
                const next = !v;
                try {
                  localStorage.setItem("mv_quick_grade", next ? "1" : "0");
                } catch {}
                return next;
              })
            }
            className={`flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 rounded transition-all ${quickGrade ? "bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/40" : "text-[#555555] border border-[#D4D0C8] hover:text-[#333333]"}`}
            title="Toggle quick-grade mode (Q)"
          >
            <Zap size={10} />
            Quick
          </button>
          {approved && (
            <span className="flex items-center gap-1.5 text-emerald-600 text-xs">
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
      {!approved && (
        <label
          className={`flex items-center gap-2 cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
            deionizationComplete ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-300"
          }`}
          data-testid="check-deionization-complete"
        >
          <input
            type="checkbox"
            checked={deionizationComplete}
            onChange={() => setDeionizationComplete((v) => !v)}
            className="accent-[#D4AF37] h-4 w-4"
          />
          <span className="text-xs font-bold uppercase tracking-wider text-[#1A1A1A]">Deionization complete</span>
          <span className="text-[10px] text-[#555] ml-auto">Required before approve</span>
        </label>
      )}

      {quickGrade && (
        <QuickGrade
          subgrades={{ centering, corners: cornersGrade, edges: edgesGrade, surface: surfaceGrade }}
          onChange={(s) => {
            setCenteringOverride(s.centering);
            setCornersOverride(s.corners);
            setEdgesOverride(s.edges);
            setSurfaceOverride(s.surface);
            clearOverallOverrideIfSet();
          }}
          onApprove={() => {
            // Mirror the main Approve button's deionization gate so the
            // QuickGrade panel can't bypass it.
            if (!deionizationComplete) {
              toast({
                title: "Confirm deionization first",
                description: "Tick 'Deionization complete' before approving.",
              });
              return;
            }
            setShowConfirm(true);
          }}
          onSave={saveDraft}
          approving={approving}
          saving={saving}
          focusField={quickFocusField}
          onFocusField={setQuickFocusField}
        />
      )}

      {/* AI Panel + Reprocess */}
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
        <ReprocessButton
          certId={certId}
          onDone={() => queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] })}
        />
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[60%_40%] gap-5">
        {/* LEFT — Image viewer + defect list */}
        <div className="space-y-4">
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
                          ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10"
                          : hasImage
                            ? "border-[#D4D0C8] text-[#333333] hover:border-[#D4AF37]/40"
                            : "border-[#E8E4DC] text-[#888888] cursor-not-allowed"
                      }`}
                    >
                      {s}
                      {count > 0 ? ` (${count})` : ""}
                    </button>
                    {hasImage && certId && (
                      <button
                        type="button"
                        title={`Delete ${s} image`}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm(`Delete the ${s} image? You'll need to re-upload before grading.`)) return;
                          try {
                            const r = await fetch(`/api/admin/certificates/${certId}/images/${s}`, {
                              method: "DELETE",
                              credentials: "include",
                            });
                            if (!r.ok) {
                              const d = await r.json();
                              throw new Error(d.error);
                            }
                            queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] });
                          } catch {}
                        }}
                        className="flex-shrink-0 rounded-r border border-l-0 border-[#D4D0C8] text-[#555555] hover:text-red-600 hover:border-red-400/40 px-1.5 py-1 transition-all"
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
                urls={urls}
                defects={defects}
                onDefectAdded={(d) => setDefects((prev) => [...prev, d])}
                onDefectsChange={setDefects}
                readOnly={gradeApprovedAt != null && !editMode}
                highlightId={highlightDefect}
                referenceImageUrl={aiIdentification?.referenceImageUrl}
                side={viewerSide as "front" | "back"}
                omitSideTabs
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
                  queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] })
                }
                onSideChange={setViewerSide}
                onZoomChange={setViewerZoom}
                onModeChange={setViewerMode}
              />
              {/* Corner/edge zone selectors removed — MVGS defect pins now
                  drive corners/edges subgrades via computeMvgsScore. */}
            </div>
            {/* Bottom corner/edge selectors removed — MVGS-driven. */}
          </div>
          <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[#B8960C] text-[10px] uppercase tracking-widest font-bold">Defects</p>
              <div className="flex items-center gap-2">
                {defects.length > 0 && defects.some((d) => !d.mvgsCode || !d.tier || !d.zone) && (
                  <button
                    type="button"
                    onClick={() => {
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
                    className="flex items-center gap-1 text-[#B8960C] hover:text-[#D4AF37] text-[10px] font-bold uppercase tracking-wider transition-colors"
                    data-testid="btn-recalc-zones"
                    title="Backfill mvgsCode, tier, and zone on defects missing them — triggers MVGS subgrade scoring"
                  >
                    <Zap size={10} />
                    Recalculate
                  </button>
                )}
                {defects.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm("Delete all defect pins? This cannot be undone.")) return;
                      setDefects([]);
                    }}
                    className="flex items-center gap-1 text-[#888888] hover:text-red-600 text-[10px] font-bold uppercase tracking-wider transition-colors"
                    data-testid="btn-clear-defects"
                    title="Delete all defect pins"
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
            />
          </div>
        </div>

        {/* RIGHT — Grading inputs */}
        <div className="space-y-5 overflow-y-auto">
          {/* Post-approval banner — read-only by default, with an EDIT GRADE
              button that flips into explicit-save edit mode. Auto-save is
              disabled post-approval (see autoSave useEffect gate) so any
              edit-mode change requires the SAVE CHANGES button below. */}
          {gradeApprovedAt && !editMode && (
            <div className="bg-[#16A34A]/10 border border-[#16A34A]/40 rounded-lg p-3 flex items-start justify-between gap-3">
              <div className="space-y-1 min-w-0">
                <p className="text-[#16A34A] text-xs font-bold uppercase tracking-widest">
                  ✓ Approved &amp; Live · {certIdStr || ""}
                </p>
                <p className="text-[#16A34A]/80 text-[10px] leading-relaxed">
                  Approved {gradeApprovedAt ? new Date(gradeApprovedAt).toLocaleString() : ""}
                  {gradeApprovedBy ? ` by ${gradeApprovedBy}` : ""}.
                </p>
              </div>
              <button
                type="button"
                onClick={enterEditMode}
                className="shrink-0 border border-[#D4AF37]/60 text-[#D4AF37] hover:bg-[#D4AF37]/10 text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded transition-colors"
                data-testid="btn-edit-grade"
              >
                ✏️ Edit Grade
              </button>
            </div>
          )}
          {gradeApprovedAt && editMode && (
            <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <p className="text-amber-800 text-xs font-bold uppercase tracking-widest">
                    ✏️ Edit mode · {certIdStr || ""}
                  </p>
                  <p className="text-amber-700/90 text-[10px] leading-relaxed">
                    Changes are not saved until you click Save · all saves recorded in audit log.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveEditedGrade}
                  disabled={editSaving}
                  className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase tracking-widest px-3 py-2 rounded transition-all hover:opacity-90 disabled:opacity-40"
                  data-testid="btn-save-edit"
                >
                  {editSaving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  {editSaving ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={editSaving}
                  className="border border-zinc-300 text-zinc-600 hover:bg-zinc-100 text-xs font-bold uppercase tracking-widest px-3 py-2 rounded transition-colors disabled:opacity-40"
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
            disabled={gradeApprovedAt != null && !editMode}
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
                        ? cornersGrade
                        : key === "edges"
                          ? edgesGrade
                          : surfaceGrade;
                  const isManual = aiVal !== undefined && curVal !== aiVal;
                  return (
                    <div
                      key={key}
                      className={`text-[9px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${
                        isManual
                          ? "bg-blue-950/30 text-blue-400 border-blue-800/40"
                          : "bg-[#D4AF37]/10 text-[#D4AF37]/70 border-[#D4AF37]/20"
                      }`}
                    >
                      <span className="uppercase font-bold">{key.slice(0, 1).toUpperCase()}</span>
                      <span>{isManual ? `Manual (AI: ${aiVal})` : `AI ${aiVal}`}</span>
                      <span className="text-[#D4AF37]/50">·</span>
                      <span
                        className={`font-bold ${
                          aiAnalysis.confidence[key] === "high"
                            ? "text-emerald-600"
                            : aiAnalysis.confidence[key] === "medium"
                              ? "text-amber-600"
                              : "text-red-600"
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
                const mvgs = computeMvgsScore({
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
                });
                return (
                  <div
                    className="bg-[#FAF5E0] border border-[#D4AF37]/40 rounded-lg p-3 space-y-3"
                    data-testid="mvgs-controls"
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest">MVGS</span>
                      <span className="text-[#1A1400] text-sm font-bold" data-testid="text-mvgs-score">
                        {mvgs.score}/100 · {mvgs.grade}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-[#555]">Dark border</span>
                        <div className="flex gap-3">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={darkBorderFront}
                              onChange={() => setDarkBorderFront((v) => !v)}
                              className="accent-[#D4AF37] h-4 w-4"
                              data-testid="check-dark-border-front"
                            />
                            <span className="text-[10px] text-[#555]">Front</span>
                          </label>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={darkBorderBack}
                              onChange={() => setDarkBorderBack((v) => !v)}
                              className="accent-[#D4AF37] h-4 w-4"
                              data-testid="check-dark-border-back"
                            />
                            <span className="text-[10px] text-[#555]">Back</span>
                          </label>
                        </div>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase tracking-wider text-[#555] block mb-1">Eye appeal</span>
                        <div className="flex gap-1">
                          {[-2, -1, 0, 1, 2].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setEyeAppealModifier(n)}
                              className={`flex-1 text-[10px] font-bold px-1.5 py-1 rounded border transition-colors ${
                                eyeAppealModifier === n
                                  ? "bg-[#D4AF37] text-[#1A1400] border-[#D4AF37]"
                                  : "bg-white text-[#555] border-[#E8E4DC] hover:border-[#D4AF37]"
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
                      <div className="text-[10px] text-[#555] font-mono">
                        {Object.entries(mvgs.deductions).map(([k, v]) => (
                          <span key={k} className="inline-block mr-2 whitespace-nowrap">
                            {k}:{" "}
                            <span className={v > 0 ? "text-emerald-700" : "text-red-700"}>{v > 0 ? `+${v}` : v}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* Grade summary — always visible at top */}
            {!isNonNumeric && (
              <GradeDisplay
                overall={overall}
                sub={sub}
                hasCrease={surface.hasCrease}
                hasTear={surface.hasTear}
                manualOverride={hasMvgsPins ? null : overallOverride}
                onOverride={hasMvgsPins ? () => {} : setOverallOverride}
                lockedByMvgs={hasMvgsPins}
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
                onSubgradeChange={(key, val) => {
                  if (key === "centering") setCenteringOverride(val);
                  else if (key === "corners") setCornersOverride(val);
                  else if (key === "edges") setEdgesOverride(val);
                  else if (key === "surface") setSurfaceOverride(val);
                  clearOverallOverrideIfSet();
                }}
              />
            )}

            {/* Cross-grade estimate */}
            {!isNonNumeric && overall > 0 && (
              <CrossGradeDisplay
                mvGrade={overall}
                subgrades={sub}
                strengthScore={
                  (aiAnalysis as any)?.grade_strength_score ?? (gradingData as any)?.gradeStrengthScore ?? null
                }
              />
            )}

            {isNonNumeric && (
              <div className="rounded-xl p-4 bg-amber-50 border border-amber-200 text-center">
                <p className="text-amber-600 text-2xl font-black">{authStatus === "authentic_altered" ? "AA" : "NO"}</p>
                <p className="text-amber-600 text-xs mt-1">
                  {authStatus === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL"}
                </p>
              </div>
            )}

            {/* Centering — manual measurement buttons */}
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => setManualCenteringSide("front")}
                className="flex-1 flex items-center justify-center gap-1.5 border border-[#D4D0C8] text-[#333333] hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-[10px] font-bold uppercase px-2 py-1.5 rounded transition-all"
              >
                Manual Centering (Front)
              </button>
              <button
                type="button"
                onClick={() => setManualCenteringSide("back")}
                className="flex-1 flex items-center justify-center gap-1.5 border border-[#D4D0C8] text-[#333333] hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-[10px] font-bold uppercase px-2 py-1.5 rounded transition-all"
              >
                Manual Centering (Back)
              </button>
              {centeringMethod && (
                <span
                  className={`self-center text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${centeringMethod === "manual" ? "bg-emerald-50 text-emerald-600 border border-emerald-200" : "bg-[#D4AF37]/10 text-[#D4AF37]/70 border border-[#D4AF37]/20"}`}
                >
                  {centeringMethod}
                </span>
              )}
            </div>

            <div className="bg-[#F7F7F5] rounded-lg p-3 space-y-2">
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
                const FRONT_CHIPS: { label: string; grade: string; devMax: number }[] = [
                  { label: "≤55/45", grade: "10", devMax: 10 },
                  { label: "56–60", grade: "9", devMax: 20 },
                  { label: "61–65", grade: "8", devMax: 30 },
                  { label: "66–70", grade: "7", devMax: 40 },
                  { label: "71–75", grade: "6", devMax: 50 },
                  { label: "76–80", grade: "5", devMax: 60 },
                  { label: ">80", grade: "≤4", devMax: Infinity },
                ];
                const BACK_CHIPS: { label: string; grade: string; devMax: number }[] = [
                  { label: "≤75/25", grade: "10", devMax: 50 },
                  { label: "76–85", grade: "8", devMax: 70 },
                  { label: "86–90", grade: "5", devMax: 80 },
                  { label: ">90", grade: "1", devMax: Infinity },
                ];
                const devFromRatio = (raw: string): number | null => {
                  const m = raw.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
                  if (!m) return null;
                  const a = parseInt(m[1], 10);
                  const b = parseInt(m[2], 10);
                  if (isNaN(a) || isNaN(b) || a + b === 0) return null;
                  return (Math.abs(a - b) / (a + b)) * 100;
                };
                const matchIdx = (dev: number, chips: { devMax: number }[]): number => {
                  for (let i = 0; i < chips.length; i++) if (dev <= chips[i].devMax) return i;
                  return chips.length - 1;
                };
                const frontDevs = [devFromRatio(frontLR), devFromRatio(frontTB)].filter((v): v is number => v !== null);
                const backDevs = [devFromRatio(backLR), devFromRatio(backTB)].filter((v): v is number => v !== null);
                const frontHits = new Set(frontDevs.map((d) => matchIdx(d, FRONT_CHIPS)));
                const backHits = new Set(backDevs.map((d) => matchIdx(d, BACK_CHIPS)));

                const Chip = ({ label, grade, active }: { label: string; grade: string; active: boolean }) => (
                  <span
                    className={
                      active
                        ? "inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#D4AF37] text-[#1A1400] font-bold"
                        : "inline-flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded border border-[#D4D0C8] text-[#777777]"
                    }
                  >
                    <span>{label}</span>
                    <span className="opacity-70">= {grade}</span>
                  </span>
                );

                return (
                  <div className="space-y-1 pt-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-[#555555] w-10">Front</span>
                      {FRONT_CHIPS.map((c, i) => (
                        <Chip key={c.label} label={c.label} grade={c.grade} active={frontHits.has(i)} />
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-[#555555] w-10">Back</span>
                      {BACK_CHIPS.map((c, i) => (
                        <Chip key={c.label} label={c.label} grade={c.grade} active={backHits.has(i)} />
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
                      const result = mvgsCenteringSubgrade(frontLR, frontTB, backLR, backTB);
                      if (!result) {
                        toast({
                          title: "MVGS calc unavailable",
                          description: "MVGS calc needs all 4 ratios in X/Y format (e.g. 53/47)",
                          variant: "destructive",
                        });
                        return;
                      }
                      setCenteringOverride(result.subgrade);
                      toast({
                        title: `Centering set to ${result.subgrade}/10 (MVGS — worst axis: ${result.worstAxisName} ${result.worstAxisValue}/10)`,
                      });
                    }}
                    disabled={isDisabled}
                    title={
                      isDisabled
                        ? "Fill all 4 ratios in X/Y format to enable"
                        : "Compute centering subgrade from the four ratios using MVGS standard"
                    }
                    data-testid="btn-mvgs-calc"
                    className="text-[10px] font-bold uppercase tracking-widest border border-[#D4AF37]/50 text-[#D4AF37] hover:bg-[#D4AF37]/10 px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    MVGS Calc
                  </button>
                );
              })()}
            </div>

            {/* Corners — read-only MVGS-driven subgrade with manual override */}
            <div className="bg-[#F7F7F5] rounded-lg p-3">
              <div className="flex items-center justify-between">
                <p className="text-[#B8960C] text-[10px] uppercase tracking-widest font-bold">Corners</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-[#1A1A1A]">{sub.corners || "—"}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={0.5}
                    value={cornersOverride ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      setCornersOverride(v);
                      clearOverallOverrideIfSet();
                    }}
                    placeholder="Override"
                    className="w-20 text-xs border border-[#E8E4DC] rounded px-2 py-1 text-center bg-white"
                  />
                </div>
              </div>
            </div>

            {/* Edges — read-only MVGS-driven subgrade with manual override */}
            <div className="bg-[#F7F7F5] rounded-lg p-3">
              <div className="flex items-center justify-between">
                <p className="text-[#B8960C] text-[10px] uppercase tracking-widest font-bold">Edges</p>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-[#1A1A1A]">{sub.edges || "—"}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    step={0.5}
                    value={edgesOverride ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : Number(e.target.value);
                      setEdgesOverride(v);
                      clearOverallOverrideIfSet();
                    }}
                    placeholder="Override"
                    className="w-20 text-xs border border-[#E8E4DC] rounded px-2 py-1 text-center bg-white"
                  />
                </div>
              </div>
            </div>

            {/* Surface */}
            <div className="bg-[#F7F7F5] rounded-lg p-3">
              <SurfaceGrading
                values={surface}
                onChange={(v) => {
                  setSurface(v);
                  clearOverallOverrideIfSet();
                }}
                overrideGrade={surfaceOverride}
                onOverride={setSurfaceOverride}
              />
            </div>

            {/* Authentication */}
            <div className="bg-[#F7F7F5] rounded-lg p-3">
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
              from the admin's manual subgrades + confirmed defects). */}
            <div>
              <button
                type="button"
                onClick={generateDescription}
                disabled={generatingDescription || subgradesIncomplete}
                title={
                  subgradesIncomplete
                    ? "Set all four subgrades first"
                    : "Write a grade rationale paragraph using the current subgrades + confirmed defects"
                }
                className="w-full flex items-center justify-center gap-2 border border-[#D4AF37]/30 text-[#D4AF37] hover:border-[#D4AF37]/60 text-xs font-bold uppercase px-4 py-2.5 rounded transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="btn-generate-description"
              >
                {generatingDescription ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                {generatingDescription ? "Writing description…" : "Generate Description"}
              </button>
            </div>

            {/* Notes */}
            <div className="bg-[#F7F7F5] rounded-lg p-3">
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
            <div className="sticky bottom-0 pb-2 pt-1 bg-white space-y-2">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
                <span className="text-[#888888]">
                  {autoSaveStatus === "saving" && (
                    <span className="flex items-center gap-1.5">
                      <Loader2 size={10} className="animate-spin" /> Saving…
                    </span>
                  )}
                  {autoSaveStatus === "saved" && (
                    <span className="flex items-center gap-1.5 text-[#16A34A]">
                      <CheckCircle2 size={10} /> Saved
                    </span>
                  )}
                  {autoSaveStatus === "error" && (
                    <span className="text-red-600">Save failed — retrying on next change</span>
                  )}
                </span>
                {gradeApprovedAt && <span className="text-[#16A34A]">✓ Live</span>}
              </div>
              {!approved ? (
                <button
                  type="button"
                  onClick={() => setShowConfirm(true)}
                  disabled={approving || overall <= 0 || subgradesIncomplete || !deionizationComplete}
                  title={
                    overall <= 0 || subgradesIncomplete
                      ? "Set all four subgrades first"
                      : !deionizationComplete
                        ? "Tick 'Deionization complete' before approving"
                        : "Approve and publish — cert goes live and PDF becomes available at the public URL"
                  }
                  data-testid="btn-approve-publish"
                  className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-4 py-2.5 rounded transition-all hover:opacity-90 disabled:opacity-40"
                >
                  {approving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  {subgradesIncomplete
                    ? "Set subgrades first"
                    : !deionizationComplete
                      ? "Confirm deionization first"
                      : "Approve & Publish"}
                </button>
              ) : (
                <div className="w-full flex items-center justify-center gap-2 bg-[#16A34A]/10 border border-[#16A34A]/40 text-[#16A34A] text-xs font-bold uppercase px-4 py-2.5 rounded">
                  <CheckCircle2 size={13} />
                  Approved & Live · {certIdStr || ""}
                </div>
              )}
            </div>
          </fieldset>
        </div>
      </div>

      {/* Manual centering picker */}
      {manualCenteringSide && (
        <ManualCentering
          certId={certId}
          side={manualCenteringSide}
          imageUrl={
            manualCenteringSide === "front"
              ? urls.front_cropped || urls.front_original || ""
              : urls.back_cropped || urls.back_original || ""
          }
          existingOuter={
            manualCenteringSide === "front"
              ? manualOuterFront || (gradingData as any)?.centeringOuterFront || null
              : manualOuterBack || (gradingData as any)?.centeringOuterBack || null
          }
          existingInner={
            manualCenteringSide === "front"
              ? manualInnerFront || (gradingData as any)?.centeringInnerFront || null
              : manualInnerBack || (gradingData as any)?.centeringInnerBack || null
          }
          aiRatios={
            manualCenteringSide === "front"
              ? {
                  lr: (gradingData as any)?.centeringFrontLr ?? null,
                  tb: (gradingData as any)?.centeringFrontTb ?? null,
                }
              : { lr: (gradingData as any)?.centeringBackLr ?? null, tb: (gradingData as any)?.centeringBackTb ?? null }
          }
          onSave={(result) => {
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
            // Clear override so centeringCalc (using all 4 values) becomes authoritative
            setCenteringOverride(null);
            setCenteringMethod("manual");
            setManualCenteringSide(null);
            clearOverallOverrideIfSet();
          }}
          onCancel={() => setManualCenteringSide(null)}
        />
      )}

      {/* Confirm modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-[#111111] border border-[#333333] rounded-xl p-6 max-w-sm w-full space-y-4">
            <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Approve &amp; Publish</p>
            <p className="text-[#CCCCCC] text-sm">
              Publish grade of{" "}
              <strong className="text-white">
                {finalGradeOverall} —{" "}
                {isNonNumeric ? (authStatus === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL") : label}
              </strong>{" "}
              for <strong className="text-white">{cardName}</strong> ({cardSet})?
            </p>
            <p className="text-[#555555] text-xs">
              The cert goes live, the Digital Grading Report becomes publicly accessible, and any future edits to
              subgrades or notes will be live immediately (recorded in the audit log).
            </p>
            {isBlack && (
              <div className="flex items-center gap-2 text-[#D4AF37] text-xs">
                <span className="text-lg">★</span>
                <span>This card qualifies for PRISTINE 10P — all subgrades are perfect 10.0</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="border border-[#333333] text-[#555555] text-xs py-2 px-3 rounded hover:bg-[#1A1A1A]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => approveGrade()}
                disabled={approving}
                className="flex-1 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold py-2 rounded disabled:opacity-40"
              >
                {approving ? "Publishing…" : "Approve & Publish"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
