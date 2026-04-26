import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Save, Zap, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ImageViewer from "./image-viewer";
import DefectAnnotation, { type Defect, type DefectCandidate } from "./defect-annotation";
import CenteringInput from "./centering-input";
import CornerGrading, { calcCornerSubgrade, CornerSelect, type CornerValues } from "./corner-grading";
import EdgeGrading, { calcEdgeSubgrade, EdgeSelect, type EdgeValues } from "./edge-grading";
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
import { calculateOverallGrade, getGradeLabel, isBlackLabel as checkBlackLabel, getCenteringGrade } from "./grade-logic";

function ReprocessButton({ certId, onDone }: { certId: number; onDone: () => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  return (
    <button
      type="button"
      disabled={status === "loading"}
      onClick={async () => {
        if (status === "loading") { toast({ title: "Already reprocessing, please wait" }); return; }
        setStatus("loading");
        toast({ title: "Reprocessing images…" });
        try {
          const r = await fetch(`/api/admin/certificates/${certId}/reprocess-images`, { method: "POST", credentials: "include" });
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
        status === "done" ? "border border-emerald-600/40 text-emerald-600 bg-emerald-50" :
        status === "loading" ? "border border-[#D4AF37]/40 text-[#D4AF37] bg-[#D4AF37]/5" :
        "border border-[#D4D0C8] text-[#333333] hover:text-[#D4AF37] hover:border-[#D4AF37]/40"
      }`}
    >
      {status === "loading" ? <><Loader2 size={11} className="animate-spin" /> Reprocessing…</> :
       status === "done" ? <><CheckCircle2 size={11} /> Reprocessed ✓</> :
       "Reprocess"}
    </button>
  );
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
const DEFAULT_CORNERS: CornerValues = { frontTL: 0, frontTR: 0, frontBL: 0, frontBR: 0, backTL: 0, backTR: 0, backBL: 0, backBR: 0 };
const DEFAULT_EDGES: EdgeValues = { frontTop: 0, frontBottom: 0, frontLeft: 0, frontRight: 0, backTop: 0, backBottom: 0, backLeft: 0, backRight: 0 };
const DEFAULT_SURFACE: SurfaceValues = { front: 0, back: 0, hasPrintLines: false, hasHoloScratches: false, hasSurfaceScratches: false, hasStaining: false, hasIndentation: false, hasRollerMarks: false, hasColorRegistration: false, hasCrease: false, hasTear: false };

export default function GradingPanel({ certId, certIdStr, cardName, cardSet, existingGrade, onGradeApproved, onCertUpdated, pendingAnalysis, onPendingAnalysisConsumed, onManualIdentification, cardGame }: Props) {
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
  const [backLR, setBackLR]   = useState("");
  const [backTB, setBackTB]   = useState("");
  const [corners, setCorners] = useState<CornerValues>(DEFAULT_CORNERS);
  const [viewerSide, setViewerSide] = useState("front");
  const [viewerZoom, setViewerZoom] = useState(1);
  const [viewerMode, setViewerMode] = useState({ fullscreen: false, markMode: false });
  const [edges, setEdges]     = useState<EdgeValues>(DEFAULT_EDGES);
  const [surface, setSurface] = useState<SurfaceValues>(DEFAULT_SURFACE);
  const [defects, setDefects] = useState<Defect[]>([]);
  const [defectCandidates, setDefectCandidates] = useState<DefectCandidate[]>([]);
  const [authStatus, setAuthStatus]   = useState<AuthStatus>("genuine");
  const [authNotes, setAuthNotes]     = useState("");
  const [privateNotes, setPrivateNotes]         = useState("");
  const [gradeExplanation, setGradeExplanation] = useState("");
  const [highlightDefect, setHighlightDefect]   = useState<number | null>(null);

  const [centeringOverride, setCenteringOverride] = useState<number | null>(null);
  const [cornersOverride, setCornersOverride]     = useState<number | null>(null);
  const [edgesOverride, setEdgesOverride]         = useState<number | null>(null);
  const [surfaceOverride, setSurfaceOverride]     = useState<number | null>(null);
  const [overallOverride, setOverallOverride]     = useState<number | null>(null);

  const [saving, setSaving]   = useState(false);
  const [approving, setApproving] = useState(false);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  const [approved, setApproved]   = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

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
    try { return localStorage.getItem("mv_quick_grade") === "1"; } catch { return false; }
  });
  const [quickFocusField, setQuickFocusField] = useState<"centering" | "corners" | "edges" | "surface" | null>(null);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.ctrlKey && e.key === "s") { e.preventDefault(); saveDraft(); }
      else if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); setShowConfirm(true); }
      else if (e.key === "q" || e.key === "Q") {
        setQuickGrade(v => { const next = !v; try { localStorage.setItem("mv_quick_grade", next ? "1" : "0"); } catch {} return next; });
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Populate from saved grading data
  useEffect(() => {
    if (!gradingData) return;
    if (gradingData.centeringFrontLr) setFrontLR(gradingData.centeringFrontLr);
    if (gradingData.centeringFrontTb) setFrontTB(gradingData.centeringFrontTb);
    if (gradingData.centeringBackLr)  setBackLR(gradingData.centeringBackLr);
    if (gradingData.centeringBackTb)  setBackTB(gradingData.centeringBackTb);
    if (gradingData.corners) setCorners(gradingData.corners);
    if (gradingData.edges)   setEdges(gradingData.edges);
    if (gradingData.surface) setSurface(gradingData.surface);
    if (gradingData.defects && Array.isArray(gradingData.defects)) setDefects(gradingData.defects);
    if ((gradingData as any).aiDefectCandidates && Array.isArray((gradingData as any).aiDefectCandidates)) {
      setDefectCandidates((gradingData as any).aiDefectCandidates as DefectCandidate[]);
    }
    if (gradingData.authStatus) setAuthStatus(gradingData.authStatus);
    if (gradingData.authNotes)  setAuthNotes(gradingData.authNotes);
    if (gradingData.privateNotes)   setPrivateNotes(gradingData.privateNotes);
    if (gradingData.gradeExplanation) setGradeExplanation(gradingData.gradeExplanation);
    if (gradingData.gradeApprovedBy)  setApproved(true);
    // Manual centering frame rects (persisted)
    if (gradingData.centeringOuterFront) setManualOuterFront(gradingData.centeringOuterFront);
    if (gradingData.centeringInnerFront) setManualInnerFront(gradingData.centeringInnerFront);
    if (gradingData.centeringOuterBack)  setManualOuterBack(gradingData.centeringOuterBack);
    if (gradingData.centeringInnerBack)  setManualInnerBack(gradingData.centeringInnerBack);
    if (gradingData.centeringMethod)     setCenteringMethod(gradingData.centeringMethod);
    // Hydrate saved aggregate subgrades as overrides
    if (gradingData.cornersScore != null)  setCornersOverride(Number(gradingData.cornersScore));
    if (gradingData.edgesScore != null)    setEdgesOverride(Number(gradingData.edgesScore));
    if (gradingData.surfaceScore != null)  setSurfaceOverride(Number(gradingData.surfaceScore));
    if (gradingData.grade != null)         setOverallOverride(Number(gradingData.grade));
    // Centering: prefer letting centeringCalc derive from L/R + T/B ratios.
    // Fallback: if ratios are missing but a centering_score was saved, use it
    // as an override so the Overall formula still has a value to weight.
    const hasCenteringRatios = !!(gradingData.centeringFrontLr && gradingData.centeringFrontTb &&
                                  gradingData.centeringBackLr  && gradingData.centeringBackTb);
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
  const [aiSources, setAiSources] = useState<Partial<Record<"centering" | "corners" | "edges" | "surface", number>>>({});

  function handleAiComplete(analysis: AiAnalysisResult, identification: AiIdentification | null) {
    setAiAnalysis(prev => analysis.overall_grade ? analysis : prev);
    setAiIdentification(identification);

    // Populate subgrade overrides from AI (skip zero = "not measured")
    const c = analysis.centering.subgrade;
    const co = analysis.corners.subgrade;
    const e  = analysis.edges.subgrade;
    const s  = analysis.surface.subgrade;

    // Centering: clear override so centeringCalc (from all 4 ratios) is authoritative
    if (c > 0) setCenteringOverride(null);
    if (co > 0) setCornersOverride(co);
    if (e > 0) setEdgesOverride(e);
    if (s > 0) setSurfaceOverride(s);
    // AI re-ran → any prior manual overall override is stale. Let formula redrive.
    setOverallOverride(null);

    setAiSources(prev => ({
      ...prev,
      ...(c > 0 ? { centering: c } : {}),
      ...(co > 0 ? { corners: co } : {}),
      ...(e > 0 ? { edges: e } : {}),
      ...(s > 0 ? { surface: s } : {}),
    }));

    // Populate centering ratios
    if (analysis.centering.front_left_right) setFrontLR(analysis.centering.front_left_right);
    if (analysis.centering.front_top_bottom) setFrontTB(analysis.centering.front_top_bottom);
    if (analysis.centering.back_left_right)  setBackLR(analysis.centering.back_left_right);
    if (analysis.centering.back_top_bottom)  setBackTB(analysis.centering.back_top_bottom);

    // Populate corners (skip if subgrade is 0 = not measured)
    if (co > 0) {
      const co2 = analysis.corners;
      setCorners({
        frontTL: co2.front_top_left?.grade     ?? 10,
        frontTR: co2.front_top_right?.grade    ?? 10,
        frontBL: co2.front_bottom_left?.grade  ?? 10,
        frontBR: co2.front_bottom_right?.grade ?? 10,
        backTL:  co2.back_top_left?.grade      ?? 10,
        backTR:  co2.back_top_right?.grade     ?? 10,
        backBL:  co2.back_bottom_left?.grade   ?? 10,
        backBR:  co2.back_bottom_right?.grade  ?? 10,
      });
    }

    // Populate edges (skip if subgrade is 0)
    if (e > 0) {
      const ed = analysis.edges;
      setEdges({
        frontTop:    ed.front_top?.grade    ?? 10,
        frontBottom: ed.front_bottom?.grade ?? 10,
        frontLeft:   ed.front_left?.grade   ?? 10,
        frontRight:  ed.front_right?.grade  ?? 10,
        backTop:     ed.back_top?.grade     ?? 10,
        backBottom:  ed.back_bottom?.grade  ?? 10,
        backLeft:    ed.back_left?.grade    ?? 10,
        backRight:   ed.back_right?.grade   ?? 10,
      });
    }

    // Populate surface (skip if subgrade is 0)
    if (s > 0) {
      setSurface(prev => ({
        ...prev,
        front: analysis.surface.front_grade ?? 10,
        back:  analysis.surface.back_grade  ?? 10,
      }));
    }

    // Populate surface defect flags from defects array (always update if defects present)
    if (analysis.defects?.length > 0) {
      setSurface(prev => ({
        ...prev,
        hasHoloScratches: analysis.defects?.some(d => d.type === "holo_scratch"),
        hasSurfaceScratches: analysis.defects?.some(d => d.type === "scratch"),
        hasPrintLines: analysis.defects?.some(d => d.type === "print_line"),
        hasStaining: analysis.defects?.some(d => d.type === "stain"),
        hasCrease: analysis.defects?.some(d => d.type === "crease"),
        hasTear: analysis.defects?.some(d => d.type === "tear"),
      }));
    }

    // Convert AI defects to Defect format and merge with any existing human defects
    if (analysis.defects?.length > 0) {
      const humanDefects = defects.filter((d: any) => !d._aiSource);
      const maxHumanId = humanDefects.length > 0 ? Math.max(...humanDefects.map(d => d.id)) : 0;
      const aiDefects: Defect[] = analysis.defects.map((ad, i) => ({
        id: maxHumanId + 1000 + i, // high IDs to avoid collision with human defects
        type: ad.type?.replace(/_/g, " ") || "Unknown",
        severity: (ad.severity === "major" ? "significant" : ad.severity === "moderate" ? "moderate" : "minor") as "minor" | "moderate" | "significant",
        description: ad.description || "",
        location: ad.location || (ad as any).detected_in || "front",
        image_side: ad.location === "back" ? "back" : "front",
        x_percent: ad.position_x_percent ?? 50,
        y_percent: ad.position_y_percent ?? 50,
        _aiSource: true, // flag so image-viewer can render as red ring
      } as Defect & { _aiSource: boolean }));
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
      toast({ title: "No AI draft in this session", description: "Run AI Identify & Grade first", variant: "destructive" });
      return;
    }
    const c  = aiAnalysis.centering?.subgrade ?? 0;
    const co = aiAnalysis.corners?.subgrade   ?? 0;
    const e  = aiAnalysis.edges?.subgrade     ?? 0;
    const s  = aiAnalysis.surface?.subgrade   ?? 0;

    if (c  > 0) setCenteringOverride(null);
    if (co > 0) setCornersOverride(co);
    if (e  > 0) setEdgesOverride(e);
    if (s  > 0) setSurfaceOverride(s);
    setOverallOverride(null);

    if (aiAnalysis.centering?.front_left_right) setFrontLR(aiAnalysis.centering.front_left_right);
    if (aiAnalysis.centering?.front_top_bottom) setFrontTB(aiAnalysis.centering.front_top_bottom);
    if (aiAnalysis.centering?.back_left_right)  setBackLR(aiAnalysis.centering.back_left_right);
    if (aiAnalysis.centering?.back_top_bottom)  setBackTB(aiAnalysis.centering.back_top_bottom);

    toast({ title: "Reverted to AI draft", description: "Review and approve to save" });
  }

  // pendingAnalysis is passed through to AiPanel via externalAnalysis prop

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

  // Calculated subgrades
  const centeringCalc = (frontLR && frontTB && backLR && backTB)
    ? getCenteringGrade(frontLR, frontTB, backLR, backTB)
    : null;
  const centering = centeringOverride ?? centeringCalc ?? 10;
  const cornersGrade  = cornersOverride  ?? calcCornerSubgrade(corners).grade;
  const edgesGrade    = edgesOverride    ?? calcEdgeSubgrade(edges).grade;
  const surfaceGrade  = surfaceOverride  ?? calcSurfaceSubgrade(surface);

  const sub = { centering, corners: cornersGrade, edges: edgesGrade, surface: surfaceGrade };
  const overall = overallOverride ?? calculateOverallGrade(sub, surface.hasCrease, surface.hasTear);
  // Generate Description gate: every subgrade must have a real value (>0).
  // Mirrors the server-side 422 check so the button stays disabled until ready.
  const subgradesIncomplete = !centering || !cornersGrade || !edgesGrade || !surfaceGrade;
  const label   = getGradeLabel(overall);
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
    const sendNum = (key: string, val: number | null | undefined) => {
      if (val != null && !isNaN(val) && val > 0) out[key] = val;
    };
    sendNum("grade_centering", centering);
    sendNum("grade_corners",   cornersGrade);
    sendNum("grade_edges",     edgesGrade);
    sendNum("grade_surface",   surfaceGrade);

    // Centering ratios — omit if empty.
    const sendTxt = (key: string, val: string | null | undefined) => {
      if (val != null && val !== "") out[key] = val;
    };
    sendTxt("centering_front_lr", frontLR);
    sendTxt("centering_front_tb", frontTB);
    sendTxt("centering_back_lr",  backLR);
    sendTxt("centering_back_tb",  backTB);

    // Zone JSONBs — only send if user has touched the panel (any non-default value).
    const hasContent = (s: unknown): boolean => {
      if (!s || typeof s !== "object") return false;
      const vals = Object.values(s as Record<string, unknown>)
        .filter(v => v != null && v !== 0 && v !== "" && v !== false);
      return vals.length > 0;
    };
    if (hasContent(corners)) out.corners = corners;
    if (hasContent(edges))   out.edges   = edges;
    if (hasContent(surface)) out.surface = surface;

    // Defects — server doesn't preserve this column yet (semantic ambiguity),
    // so keep current send-always behaviour.
    out.defects = defects || [];

    // AI defect candidates — send the current (post confirm/reject) array so
    // the unconfirmed remainder is persisted. Sending an empty array clears
    // the column on server side.
    out.ai_defect_candidates = defectCandidates || [];

    return out;
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
      toast({ title: "Set all four subgrades first", description: "Centering, corners, edges, and surface must each have a value." });
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
      toast({ title: "Description generated", description: `Cost ≈ £${(data.costEstimate || 0).toFixed(4)}. Edit before saving if needed.` });
    } catch (e: any) {
      toast({ title: "Generate failed", description: e.message, variant: "destructive" });
    } finally {
      setGeneratingDescription(false);
    }
  }

  async function approveGrade() {
    setApproving(true);
    try {
      const res = await fetch(`/api/admin/certificates/${certId}/approve`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Approve failed");
      setApproved(true);
      setShowConfirm(false);
      toast({ title: `${certIdStr || "Certificate"} approved — ${finalGradeOverall} ${label}` });
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
            title={aiAnalysis ? "Clear all overrides and re-populate sub-grades from the last AI run this session" : "Run AI Identify & Grade first to enable this"}
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
            onClick={() => setQuickGrade(v => { const next = !v; try { localStorage.setItem("mv_quick_grade", next ? "1" : "0"); } catch {} return next; })}
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

      {quickGrade && (
        <QuickGrade
          subgrades={{ centering, corners: cornersGrade, edges: edgesGrade, surface: surfaceGrade }}
          onChange={s => {
            setCenteringOverride(s.centering);
            setCornersOverride(s.corners);
            setEdgesOverride(s.edges);
            setSurfaceOverride(s.surface);
            clearOverallOverrideIfSet();
          }}
          onApprove={() => setShowConfirm(true)}
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
        <ReprocessButton certId={certId} onDone={() => queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] })} />
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[60%_40%] gap-5">
        {/* LEFT — Image viewer + defect list */}
        <div className="space-y-4">
          <div style={{ margin: "0 60px" }}>
            <div className="relative" style={{ overflow: "visible" }}>
              <ImageViewer
                urls={urls}
                defects={defects}
                onDefectAdded={d => setDefects(prev => [...prev, d])}
                highlightId={highlightDefect}
                referenceImageUrl={aiIdentification?.referenceImageUrl}
                centeringFront={frontLR ? {
                  ratioLR: frontLR,
                  ratioTB: frontTB,
                  outerFrame: centeringMethod === "manual" && manualOuterFront
                    ? manualOuterFront
                    : (aiAnalysis?.centering?.front_outer_frame || null),
                  innerFrame: centeringMethod === "manual" && manualInnerFront
                    ? manualInnerFront
                    : (aiAnalysis?.centering?.front_inner_frame || null),
                } : null}
                centeringBack={backLR ? {
                  ratioLR: backLR,
                  ratioTB: backTB,
                  outerFrame: centeringMethod === "manual" && manualOuterBack
                    ? manualOuterBack
                    : (aiAnalysis?.centering?.back_outer_frame || null),
                  innerFrame: centeringMethod === "manual" && manualInnerBack
                    ? manualInnerBack
                    : (aiAnalysis?.centering?.back_inner_frame || null),
                } : null}
                certId={certId}
                onImageDeleted={() => queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] })}
                onSideChange={setViewerSide}
                onZoomChange={setViewerZoom}
                onModeChange={setViewerMode}
              />
              {/* Top + side overlays (absolute — these work fine) */}
              {viewerZoom <= 1 && !viewerMode.fullscreen && !viewerMode.markMode && (() => {
                const cc = viewerSide === "back"
                  ? { tl: corners.backTL, tr: corners.backTR }
                  : { tl: corners.frontTL, tr: corners.frontTR };
                const allCorners = viewerSide === "back"
                  ? [corners.backTL, corners.backTR, corners.backBL, corners.backBR]
                  : [corners.frontTL, corners.frontTR, corners.frontBL, corners.frontBR];
                const cLow = Math.min(...allCorners);
                const isCLow = (v: number) => v === cLow && cLow < 10;
                const setC = (pos: "tl" | "tr", v: number) => {
                  const key = viewerSide === "back"
                    ? ({ tl: "backTL", tr: "backTR" } as const)[pos]
                    : ({ tl: "frontTL", tr: "frontTR" } as const)[pos];
                  setCorners(prev => ({ ...prev, [key]: v }));
                  clearOverallOverrideIfSet();
                };
                const ee = viewerSide === "back"
                  ? { top: edges.backTop, left: edges.backLeft, right: edges.backRight }
                  : { top: edges.frontTop, left: edges.frontLeft, right: edges.frontRight };
                const allEdges = viewerSide === "back"
                  ? [edges.backTop, edges.backBottom, edges.backLeft, edges.backRight]
                  : [edges.frontTop, edges.frontBottom, edges.frontLeft, edges.frontRight];
                const eLow = Math.min(...allEdges);
                const isELow = (v: number) => v === eLow && eLow < 10;
                const setE = (pos: "top" | "left" | "right", v: number) => {
                  const key = viewerSide === "back"
                    ? ({ top: "backTop", left: "backLeft", right: "backRight" } as const)[pos]
                    : ({ top: "frontTop", left: "frontLeft", right: "frontRight" } as const)[pos];
                  setEdges(prev => ({ ...prev, [key]: v }));
                  clearOverallOverrideIfSet();
                };
                return (
                  <>
                    <div className="absolute z-20 flex flex-col items-center gap-0.5" style={{ top: 32, left: -56 }}>
                      <span className="text-[8px] font-bold text-[#555555]">TL</span>
                      <CornerSelect value={cc.tl} onChange={v => setC("tl", v)} isLowest={isCLow(cc.tl)} />
                    </div>
                    <div className="absolute z-20 flex flex-col items-center gap-0.5" style={{ top: 32, right: -56 }}>
                      <span className="text-[8px] font-bold text-[#555555]">TR</span>
                      <CornerSelect value={cc.tr} onChange={v => setC("tr", v)} isLowest={isCLow(cc.tr)} />
                    </div>
                    <div className="absolute z-20 flex flex-col items-center gap-0.5" style={{ top: 16, left: "50%", transform: "translateX(-50%)" }}>
                      <span className="text-[8px] font-bold text-[#555555]">T</span>
                      <EdgeSelect value={ee.top} onChange={v => setE("top", v)} isLowest={isELow(ee.top)} />
                    </div>
                    <div className="absolute z-20 flex items-center gap-0.5" style={{ top: "50%", left: -56, transform: "translateY(-50%)" }}>
                      <span className="text-[8px] font-bold text-[#555555]">L</span>
                      <EdgeSelect value={ee.left} onChange={v => setE("left", v)} isLowest={isELow(ee.left)} />
                    </div>
                    <div className="absolute z-20 flex items-center gap-0.5" style={{ top: "50%", right: -56, transform: "translateY(-50%)" }}>
                      <EdgeSelect value={ee.right} onChange={v => setE("right", v)} isLowest={isELow(ee.right)} />
                      <span className="text-[8px] font-bold text-[#555555]">R</span>
                    </div>
                  </>
                );
              })()}
            </div>
            {/* Bottom row — normal flow, always below card + controls */}
            {viewerZoom <= 1 && !viewerMode.fullscreen && !viewerMode.markMode && (() => {
              const cc = viewerSide === "back"
                ? { bl: corners.backBL, br: corners.backBR }
                : { bl: corners.frontBL, br: corners.frontBR };
              const allCorners = viewerSide === "back"
                ? [corners.backTL, corners.backTR, corners.backBL, corners.backBR]
                : [corners.frontTL, corners.frontTR, corners.frontBL, corners.frontBR];
              const cLow = Math.min(...allCorners);
              const isCLow = (v: number) => v === cLow && cLow < 10;
              const setCBot = (pos: "bl" | "br", v: number) => {
                const key = viewerSide === "back"
                  ? ({ bl: "backBL", br: "backBR" } as const)[pos]
                  : ({ bl: "frontBL", br: "frontBR" } as const)[pos];
                setCorners(prev => ({ ...prev, [key]: v }));
              };
              const eeBot = viewerSide === "back" ? edges.backBottom : edges.frontBottom;
              const allEdges = viewerSide === "back"
                ? [edges.backTop, edges.backBottom, edges.backLeft, edges.backRight]
                : [edges.frontTop, edges.frontBottom, edges.frontLeft, edges.frontRight];
              const eLow = Math.min(...allEdges);
              const isELow = eeBot === eLow && eLow < 10;
              return (
                <div className="flex items-start justify-between mt-1 px-1">
                  <div className="flex flex-col items-center gap-0.5">
                    <CornerSelect value={cc.bl} onChange={v => setCBot("bl", v)} isLowest={isCLow(cc.bl)} />
                    <span className="text-[8px] font-bold text-[#555555]">BL</span>
                  </div>
                  <div className="flex flex-col items-center gap-0.5">
                    <EdgeSelect value={eeBot} onChange={v => {
                      const key = viewerSide === "back" ? "backBottom" : "frontBottom";
                      setEdges(prev => ({ ...prev, [key]: v }));
                    }} isLowest={isELow} />
                    <span className="text-[8px] font-bold text-[#555555]">B</span>
                  </div>
                  <div className="flex flex-col items-center gap-0.5">
                    <CornerSelect value={cc.br} onChange={v => setCBot("br", v)} isLowest={isCLow(cc.br)} />
                    <span className="text-[8px] font-bold text-[#555555]">BR</span>
                  </div>
                </div>
              );
            })()}
          </div>
          <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3 space-y-2">
            <p className="text-[#B8960C] text-[10px] uppercase tracking-widest font-bold">Defects</p>

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
          {/* AI source badges */}
          {aiAnalysis && (
            <div className="flex gap-1 flex-wrap">
              {(["centering", "corners", "edges", "surface"] as const).map(key => {
                const aiVal = aiSources[key];
                const curVal = key === "centering" ? centering : key === "corners" ? cornersGrade : key === "edges" ? edgesGrade : surfaceGrade;
                const isManual = aiVal !== undefined && curVal !== aiVal;
                return (
                  <div key={key} className={`text-[9px] px-1.5 py-0.5 rounded border flex items-center gap-1 ${
                    isManual
                      ? "bg-blue-950/30 text-blue-400 border-blue-800/40"
                      : "bg-[#D4AF37]/10 text-[#D4AF37]/70 border-[#D4AF37]/20"
                  }`}>
                    <span className="uppercase font-bold">{key.slice(0, 1).toUpperCase()}</span>
                    <span>{isManual ? `Manual (AI: ${aiVal})` : `AI ${aiVal}`}</span>
                    <span className="text-[#D4AF37]/50">·</span>
                    <span className={`font-bold ${
                      aiAnalysis.confidence[key] === "high" ? "text-emerald-600" :
                      aiAnalysis.confidence[key] === "medium" ? "text-amber-600" : "text-red-600"
                    }`}>{aiAnalysis.confidence[key]}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Grade summary — always visible at top */}
          {!isNonNumeric && (
            <GradeDisplay
              overall={overall}
              sub={sub}
              hasCrease={surface.hasCrease}
              hasTear={surface.hasTear}
              manualOverride={overallOverride}
              onOverride={setOverallOverride}
              gradeLabel={label}
              isBlack={isBlack}
              strengthScore={(aiAnalysis as any)?.grade_strength_score ?? (gradingData as any)?.gradeStrengthScore ?? null}
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
              strengthScore={(aiAnalysis as any)?.grade_strength_score ?? (gradingData as any)?.gradeStrengthScore ?? null}
            />
          )}

          {isNonNumeric && (
            <div className="rounded-xl p-4 bg-amber-50 border border-amber-200 text-center">
              <p className="text-amber-600 text-2xl font-black">{authStatus === "authentic_altered" ? "AA" : "NO"}</p>
              <p className="text-amber-600 text-xs mt-1">{authStatus === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL"}</p>
            </div>
          )}

          {/* Centering — manual measurement buttons */}
          <div className="flex gap-2 mb-2">
            <button type="button" onClick={() => setManualCenteringSide("front")}
              className="flex-1 flex items-center justify-center gap-1.5 border border-[#D4D0C8] text-[#333333] hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-[10px] font-bold uppercase px-2 py-1.5 rounded transition-all">
              Manual Centering (Front)
            </button>
            <button type="button" onClick={() => setManualCenteringSide("back")}
              className="flex-1 flex items-center justify-center gap-1.5 border border-[#D4D0C8] text-[#333333] hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-[10px] font-bold uppercase px-2 py-1.5 rounded transition-all">
              Manual Centering (Back)
            </button>
            {centeringMethod && (
              <span className={`self-center text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${centeringMethod === "manual" ? "bg-emerald-50 text-emerald-600 border border-emerald-200" : "bg-[#D4AF37]/10 text-[#D4AF37]/70 border border-[#D4AF37]/20"}`}>
                {centeringMethod}
              </span>
            )}
          </div>

          <div className="bg-[#F7F7F5] rounded-lg p-3">
            <CenteringInput
              frontLR={frontLR} frontTB={frontTB} backLR={backLR} backTB={backTB}
              subgrade={centeringCalc}
              onChange={(field, val) => {
                if (field === "frontLR") setFrontLR(val);
                else if (field === "frontTB") setFrontTB(val);
                else if (field === "backLR") setBackLR(val);
                else setBackTB(val);
                clearOverallOverrideIfSet();
              }}
              overrideGrade={centeringOverride}
              onOverride={v => { setCenteringOverride(v); }}
            />
          </div>

          {/* Corners */}
          <div className="bg-[#F7F7F5] rounded-lg p-3">
            <CornerGrading
              values={corners}
              subgrade={cornersGrade}
              onChange={(v) => { setCorners(v); clearOverallOverrideIfSet(); }}
              overrideGrade={cornersOverride}
              onOverride={setCornersOverride}
            />
          </div>

          {/* Edges */}
          <div className="bg-[#F7F7F5] rounded-lg p-3">
            <EdgeGrading
              values={edges}
              onChange={(v) => { setEdges(v); clearOverallOverrideIfSet(); }}
              overrideGrade={edgesOverride}
              onOverride={setEdgesOverride}
            />
          </div>

          {/* Surface */}
          <div className="bg-[#F7F7F5] rounded-lg p-3">
            <SurfaceGrading
              values={surface}
              onChange={(v) => { setSurface(v); clearOverallOverrideIfSet(); }}
              overrideGrade={surfaceOverride}
              onOverride={setSurfaceOverride}
            />
          </div>

          {/* Authentication */}
          <div className="bg-[#F7F7F5] rounded-lg p-3">
            <Authentication
              status={authStatus}
              notes={authNotes}
              onChange={(s, n) => { setAuthStatus(s); setAuthNotes(n); }}
            />
          </div>

          {/* Generate Description (Option B — Haiku writes grade rationale
              from the admin's manual subgrades + confirmed defects). */}
          <div>
            <button
              type="button"
              onClick={generateDescription}
              disabled={generatingDescription || subgradesIncomplete}
              title={subgradesIncomplete ? "Set all four subgrades first" : "Write a grade rationale paragraph using the current subgrades + confirmed defects"}
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

          {/* Action buttons */}
          <div className="flex gap-3 sticky bottom-0 pb-2 pt-1 bg-white">
            <button
              type="button"
              onClick={saveDraft}
              disabled={saving}
              className="flex-1 flex items-center justify-center gap-2 border border-[#D4AF37]/30 text-[#D4AF37]/70 hover:border-[#D4AF37]/60 hover:text-[#D4AF37] text-xs font-bold uppercase px-4 py-2.5 rounded transition-all disabled:opacity-40"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save Draft
            </button>
            <button
              type="button"
              onClick={() => setShowConfirm(true)}
              disabled={approving || overall <= 0}
              title={overall <= 0 ? "Set all subgrades before approving" : undefined}
              className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-4 py-2.5 rounded transition-all hover:opacity-90 disabled:opacity-40"
            >
              {approving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              {overall <= 0 ? "Set subgrades first" : "Approve Grade"}
            </button>
          </div>
        </div>
      </div>

      {/* Manual centering picker */}
      {manualCenteringSide && (
        <ManualCentering
          certId={certId}
          side={manualCenteringSide}
          imageUrl={
            manualCenteringSide === "front"
              ? (urls.front_cropped || urls.front_original || "")
              : (urls.back_cropped || urls.back_original || "")
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
            <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Confirm Grade</p>
            <p className="text-[#CCCCCC] text-sm">
              Confirm grade of <strong className="text-white">{finalGradeOverall} — {isNonNumeric ? (authStatus === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL") : label}</strong> for <strong className="text-white">{cardName}</strong> ({cardSet})?
            </p>
            <p className="text-[#555555] text-xs">This grade will be published and the Digital Grading Report will be generated.</p>
            {isBlack && (
              <div className="flex items-center gap-2 text-[#D4AF37] text-xs">
                <span className="text-lg">★</span>
                <span>This card qualifies for a BLACK LABEL — all subgrades are perfect 10.0</span>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowConfirm(false)} className="border border-[#333333] text-[#555555] text-xs py-2 px-3 rounded hover:bg-[#1A1A1A]">Cancel</button>
              <button
                type="button"
                onClick={() => approveGrade()}
                disabled={approving}
                className="flex-1 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold py-2 rounded disabled:opacity-40"
              >
                {approving ? "Approving…" : "Approve"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
