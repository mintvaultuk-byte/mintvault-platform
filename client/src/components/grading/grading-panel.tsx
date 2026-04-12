import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Save, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ImageViewer from "./image-viewer";
import DefectAnnotation, { type Defect } from "./defect-annotation";
import { calculateSubgradesFromDefects } from "@/lib/defect-subgrade-impact";
import CenteringInput from "./centering-input";
import CornerGrading, { calcCornerSubgrade, type CornerValues } from "./corner-grading";
import EdgeGrading, { calcEdgeSubgrade, type EdgeValues } from "./edge-grading";
import SurfaceGrading, { calcSurfaceSubgrade, type SurfaceValues } from "./surface-grading";
import GradeDisplay from "./grade-display";
import Authentication, { type AuthStatus } from "./authentication";
import GradingNotes from "./grading-notes";
import CaptureWizard from "./capture-wizard";
import QuickGrade from "./quick-grade";
import AiPanel, { type AiAnalysisResult, type AiIdentification } from "./ai-panel";
import ManualCentering, { type CenteringResult } from "./manual-centering";

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
        status === "done" ? "border border-emerald-600/40 text-emerald-400 bg-emerald-950/20" :
        status === "loading" ? "border border-[#D4AF37]/40 text-[#D4AF37] bg-[#D4AF37]/5" :
        "border border-[#333333] text-[#888888] hover:text-[#D4AF37] hover:border-[#D4AF37]/40"
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
}

// Defaults use 0 to indicate "not yet graded" — prevents false Black Label on ungraded certs
const DEFAULT_CORNERS: CornerValues = { frontTL: 0, frontTR: 0, frontBL: 0, frontBR: 0, backTL: 0, backTR: 0, backBL: 0, backBR: 0 };
const DEFAULT_EDGES: EdgeValues = { frontTop: 0, frontBottom: 0, frontLeft: 0, frontRight: 0, backTop: 0, backBottom: 0, backLeft: 0, backRight: 0 };
const DEFAULT_SURFACE: SurfaceValues = { front: 0, back: 0, hasPrintLines: false, hasHoloScratches: false, hasSurfaceScratches: false, hasStaining: false, hasIndentation: false, hasRollerMarks: false, hasColorRegistration: false, hasCrease: false, hasTear: false };

export default function GradingPanel({ certId, certIdStr, cardName, cardSet, existingGrade, onGradeApproved, onCertUpdated }: Props) {
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

  // State
  const [frontLR, setFrontLR] = useState("50/50");
  const [frontTB, setFrontTB] = useState("50/50");
  const [backLR, setBackLR]   = useState("50/50");
  const [backTB, setBackTB]   = useState("50/50");
  const [corners, setCorners] = useState<CornerValues>(DEFAULT_CORNERS);
  const [edges, setEdges]     = useState<EdgeValues>(DEFAULT_EDGES);
  const [surface, setSurface] = useState<SurfaceValues>(DEFAULT_SURFACE);
  const [defects, setDefects] = useState<Defect[]>([]);
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
  const [approved, setApproved]   = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

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
    if (gradingData.authStatus) setAuthStatus(gradingData.authStatus);
    if (gradingData.authNotes)  setAuthNotes(gradingData.authNotes);
    if (gradingData.privateNotes)   setPrivateNotes(gradingData.privateNotes);
    if (gradingData.gradeExplanation) setGradeExplanation(gradingData.gradeExplanation);
    if (gradingData.gradeApprovedBy)  setApproved(true);
  }, [gradingData]);

  // AI analysis state
  const [aiAnalysis, setAiAnalysis] = useState<AiAnalysisResult | null>(null);
  const [aiIdentification, setAiIdentification] = useState<AiIdentification | null>(null);
  // Track original AI values for override audit
  const [aiSources, setAiSources] = useState<Partial<Record<"centering" | "corners" | "edges" | "surface", number>>>({});
  const [aiOriginalCentering, setAiOriginalCentering] = useState<{ frontLR?: string; frontTB?: string; backLR?: string; backTB?: string }>({});

  function handleAiComplete(analysis: AiAnalysisResult, identification: AiIdentification | null) {
    setAiAnalysis(analysis);
    setAiIdentification(identification);

    // Populate subgrade overrides from AI
    const c = analysis.centering.subgrade;
    const co = analysis.corners.subgrade;
    const e  = analysis.edges.subgrade;
    const s  = analysis.surface.subgrade;

    setCenteringOverride(c);
    setCornersOverride(co);
    setEdgesOverride(e);
    setSurfaceOverride(s);

    setAiSources({ centering: c, corners: co, edges: e, surface: s });

    // Capture original AI centering for audit trail
    setAiOriginalCentering({
      frontLR: analysis.centering.front_left_right || undefined,
      frontTB: analysis.centering.front_top_bottom || undefined,
      backLR: analysis.centering.back_left_right || undefined,
      backTB: analysis.centering.back_top_bottom || undefined,
    });

    // Populate centering ratios
    if (analysis.centering.front_left_right) setFrontLR(analysis.centering.front_left_right);
    if (analysis.centering.front_top_bottom) setFrontTB(analysis.centering.front_top_bottom);
    if (analysis.centering.back_left_right)  setBackLR(analysis.centering.back_left_right);
    if (analysis.centering.back_top_bottom)  setBackTB(analysis.centering.back_top_bottom);

    // Populate corners
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

    // Populate edges
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

    // Populate surface
    setSurface(prev => ({
      ...prev,
      front: analysis.surface.front_grade ?? 10,
      back:  analysis.surface.back_grade  ?? 10,
      hasHoloScratches: analysis.defects?.some(d => d.type === "holo_scratch"),
      hasSurfaceScratches: analysis.defects?.some(d => d.type === "scratch"),
      hasPrintLines: analysis.defects?.some(d => d.type === "print_line"),
      hasStaining: analysis.defects?.some(d => d.type === "stain"),
      hasCrease: analysis.defects?.some(d => d.type === "crease"),
      hasTear: analysis.defects?.some(d => d.type === "tear"),
    }));

    // Convert AI defects to Defect format and merge with any existing manual defects
    if (analysis.defects?.length > 0) {
      const manualDefects = defects.filter(d => d.source !== "ai");
      const maxManualId = manualDefects.length > 0 ? Math.max(...manualDefects.map(d => d.id)) : 0;
      const aiDefects: Defect[] = analysis.defects.map((ad, i) => ({
        id: maxManualId + 1000 + i,
        type: ad.type?.replace(/_/g, " ") || "Unknown",
        severity: (ad.severity === "major" ? "significant" : ad.severity === "moderate" ? "moderate" : "minor") as "minor" | "moderate" | "significant",
        description: ad.description || "",
        location: ad.location || (ad as any).detected_in || "front",
        image_side: ad.location === "back" ? "back" : "front",
        x_percent: ad.position_x_percent ?? 50,
        y_percent: ad.position_y_percent ?? 50,
        source: "ai" as const,
      }));
      setDefects([...manualDefects, ...aiDefects]);
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
  const label   = getGradeLabel(overall);
  const isBlack = checkBlackLabel(sub, overall);

  // Defect-based subgrade suggestions
  const defectSuggestions = useMemo(() => calculateSubgradesFromDefects(defects), [defects]);

  const isNonNumeric = authStatus === "authentic_altered" || authStatus === "not_original";
  const finalGradeOverall = isNonNumeric ? (authStatus === "authentic_altered" ? "AA" : "NO") : String(overall);

  function detectOverrides(): Array<{ field_path: string; ai_value: unknown; override_value: unknown }> {
    const overrides: Array<{ field_path: string; ai_value: unknown; override_value: unknown }> = [];
    // Subgrade overrides
    if (aiSources.centering !== undefined && centering !== aiSources.centering) {
      overrides.push({ field_path: "subgrades.centering", ai_value: aiSources.centering, override_value: centering });
    }
    if (aiSources.corners !== undefined && cornersGrade !== aiSources.corners) {
      overrides.push({ field_path: "subgrades.corners", ai_value: aiSources.corners, override_value: cornersGrade });
    }
    if (aiSources.edges !== undefined && edgesGrade !== aiSources.edges) {
      overrides.push({ field_path: "subgrades.edges", ai_value: aiSources.edges, override_value: edgesGrade });
    }
    if (aiSources.surface !== undefined && surfaceGrade !== aiSources.surface) {
      overrides.push({ field_path: "subgrades.surface", ai_value: aiSources.surface, override_value: surfaceGrade });
    }
    // Overall grade override
    if (aiAnalysis && overallOverride !== null) {
      overrides.push({ field_path: "overall_grade", ai_value: aiAnalysis.overall_grade, override_value: overallOverride });
    }
    // Centering overrides
    if (aiOriginalCentering.frontLR && frontLR !== aiOriginalCentering.frontLR) {
      overrides.push({ field_path: "centering.front_lr", ai_value: aiOriginalCentering.frontLR, override_value: frontLR });
    }
    if (aiOriginalCentering.frontTB && frontTB !== aiOriginalCentering.frontTB) {
      overrides.push({ field_path: "centering.front_tb", ai_value: aiOriginalCentering.frontTB, override_value: frontTB });
    }
    if (aiOriginalCentering.backLR && backLR !== aiOriginalCentering.backLR) {
      overrides.push({ field_path: "centering.back_lr", ai_value: aiOriginalCentering.backLR, override_value: backLR });
    }
    if (aiOriginalCentering.backTB && backTB !== aiOriginalCentering.backTB) {
      overrides.push({ field_path: "centering.back_tb", ai_value: aiOriginalCentering.backTB, override_value: backTB });
    }
    // Defect changes: count manual additions and AI deletions
    const aiDefectCount = defects.filter(d => d.source === "ai").length;
    const manualDefectCount = defects.filter(d => d.source === "manual").length;
    const originalAiDefectCount = aiAnalysis?.defects?.length ?? 0;
    if (originalAiDefectCount > 0 && aiDefectCount < originalAiDefectCount) {
      overrides.push({ field_path: "defects.ai_deleted", ai_value: originalAiDefectCount, override_value: aiDefectCount });
    }
    if (manualDefectCount > 0) {
      overrides.push({ field_path: "defects.manual_added", ai_value: 0, override_value: manualDefectCount });
    }
    return overrides;
  }

  function buildPayload() {
    return {
      centering_front_lr: frontLR, centering_front_tb: frontTB,
      centering_back_lr: backLR,   centering_back_tb: backTB,
      grade_centering: centering, grade_corners: cornersGrade, grade_edges: edgesGrade, grade_surface: surfaceGrade,
      corners, edges, surface,
      defects,
      auth_status: authStatus, auth_notes: authNotes,
      grade_explanation: gradeExplanation,
      private_notes: privateNotes,
      overall_grade: finalGradeOverall,
    };
  }

  async function saveDraft() {
    setSaving(true);
    try {
      // Log AI overrides (non-blocking — never prevents save)
      const overrides = detectOverrides();
      if (overrides.length > 0) {
        fetch(`/api/admin/certificates/${certId}/override-audit/batch`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrides }),
        }).catch(e => console.warn("[audit] override log failed:", e));
      }

      const res = await fetch(`/api/admin/certificates/${certId}/grade`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      toast({ title: "Draft saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function approveGrade(andNext = false) {
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

      if (andNext) {
        // Create next cert and switch to it
        try {
          const nextRes = await fetch("/api/admin/certificates/new", {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          });
          if (nextRes.ok) {
            const nextCert = await nextRes.json();
            if (nextCert?.id) {
              onGradeApproved?.(certIdStr, finalGradeOverall);
              onCertUpdated?.(); // triggers parent refetch which will switch to the new cert
              // Parent handles the navigation via onGradeApproved
              return;
            }
          }
        } catch { /* fall through to normal close */ }
      }

      onGradeApproved?.(certIdStr, finalGradeOverall);
    } catch (e: any) {
      toast({ title: "Approve failed", description: e.message, variant: "destructive" });
    } finally {
      setApproving(false);
    }
  }

  const urls = imageData?.urls || {};

  return (
    <div className="bg-[#0A0A0A] border border-[#D4AF37]/20 rounded-xl p-4 space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">Manual Grading Workstation</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setQuickGrade(v => { const next = !v; try { localStorage.setItem("mv_quick_grade", next ? "1" : "0"); } catch {} return next; })}
            className={`flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 rounded transition-all ${quickGrade ? "bg-[#D4AF37]/20 text-[#D4AF37] border border-[#D4AF37]/40" : "text-[#555555] border border-[#333333] hover:text-[#888888]"}`}
            title="Toggle quick-grade mode (Q)"
          >
            <Zap size={10} />
            Quick
          </button>
          {approved && (
            <span className="flex items-center gap-1.5 text-emerald-400 text-xs">
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
            onDefectsDetected={(aiDefects) => {
              const manualDefects = defects.filter(d => d.source !== "ai");
              const maxManualId = manualDefects.length > 0 ? Math.max(...manualDefects.map(d => d.id)) : 0;
              const converted: Defect[] = aiDefects.map((ad, i) => ({
                id: maxManualId + 1000 + i,
                type: ad.type?.replace(/_/g, " ") || "Unknown",
                severity: (ad.severity === "major" ? "significant" : ad.severity === "moderate" ? "moderate" : "minor") as "minor" | "moderate" | "significant",
                description: ad.description || "",
                location: ad.location || "front",
                image_side: ad.location === "back" ? "back" : "front",
                x_percent: ad.position_x_percent ?? 50,
                y_percent: ad.position_y_percent ?? 50,
                source: "ai" as const,
              }));
              setDefects([...manualDefects, ...converted]);
            }}
            referenceImageUrl={aiIdentification?.referenceImageUrl}
          />
        </div>
        <ReprocessButton certId={certId} onDone={() => queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] })} />
      </div>

      {/* Two-panel layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[60%_40%] gap-5">
        {/* LEFT — Image viewer + defect list */}
        <div className="space-y-4">
          <ImageViewer
            urls={urls}
            defects={defects}
            onDefectAdded={d => setDefects(prev => [...prev, { ...d, source: "manual" as const }])}
            onDefectDeleted={id => setDefects(prev => prev.filter(d => d.id !== id))}
            highlightId={highlightDefect}
            referenceImageUrl={aiIdentification?.referenceImageUrl}
            centeringFront={frontLR ? {
              ratioLR: frontLR,
              ratioTB: frontTB,
              outerFrame: aiAnalysis?.centering?.front_outer_frame || null,
              innerFrame: aiAnalysis?.centering?.front_inner_frame || null,
            } : null}
            centeringBack={backLR ? {
              ratioLR: backLR,
              ratioTB: backTB,
              outerFrame: aiAnalysis?.centering?.back_outer_frame || null,
              innerFrame: aiAnalysis?.centering?.back_inner_frame || null,
            } : null}
            certId={certId}
            onImageDeleted={() => queryClient.invalidateQueries({ queryKey: [`/api/admin/certificates/${certId}/images`] })}
          />
          <div className="bg-[#0D0D0D] border border-[#222222] rounded-lg p-3 space-y-2">
            <p className="text-[#D4AF37]/70 text-[10px] uppercase tracking-widest font-bold">Defects</p>
            <DefectAnnotation
              defects={defects}
              onChange={setDefects}
              highlightId={highlightDefect}
              onHighlight={setHighlightDefect}
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
                      aiAnalysis.confidence[key] === "high" ? "text-emerald-400" :
                      aiAnalysis.confidence[key] === "medium" ? "text-yellow-400" : "text-red-400"
                    }`}>{aiAnalysis.confidence[key]}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Defect-based subgrade suggestions */}
          {defects.length > 0 && !isNonNumeric && (() => {
            const s = defectSuggestions;
            const hasDiff = s.centering !== centering || s.corners !== cornersGrade || s.edges !== edgesGrade || s.surface !== surfaceGrade;
            return (
              <div className="bg-[#0D0D0D] border border-[#222222] rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[#888888] text-[10px] uppercase tracking-widest font-bold">Defect Impact ({defects.length} defect{defects.length !== 1 ? "s" : ""})</p>
                  {hasDiff && (
                    <button type="button"
                      onClick={() => {
                        setCenteringOverride(s.centering);
                        setCornersOverride(s.corners);
                        setEdgesOverride(s.edges);
                        setSurfaceOverride(s.surface);
                      }}
                      className="text-[9px] text-[#D4AF37] hover:text-[#B8960C] font-bold uppercase tracking-widest transition-colors"
                    >
                      Apply Suggestions
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {([
                    { label: "C", current: centering, suggested: s.centering },
                    { label: "Co", current: cornersGrade, suggested: s.corners },
                    { label: "E", current: edgesGrade, suggested: s.edges },
                    { label: "S", current: surfaceGrade, suggested: s.surface },
                  ] as const).map(({ label, current, suggested }) => {
                    const diff = suggested !== current;
                    return (
                      <div key={label} className={`text-center p-1.5 rounded border ${diff ? "border-amber-700/40 bg-amber-900/10" : "border-[#222222]"}`}>
                        <p className="text-[9px] text-[#555555] font-bold uppercase">{label}</p>
                        <p className={`text-sm font-black ${diff ? "text-amber-400" : "text-[#555555]"}`}>{suggested}</p>
                        {diff && <p className="text-[8px] text-[#555555]">now: {current}</p>}
                      </div>
                    );
                  })}
                </div>
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
              }}
            />
          )}

          {isNonNumeric && (
            <div className="rounded-xl p-4 bg-amber-950/30 border border-amber-700/40 text-center">
              <p className="text-amber-400 text-2xl font-black">{authStatus === "authentic_altered" ? "AA" : "NO"}</p>
              <p className="text-amber-400 text-xs mt-1">{authStatus === "authentic_altered" ? "AUTHENTIC ALTERED" : "NOT ORIGINAL"}</p>
            </div>
          )}

          {/* Centering — manual measurement buttons */}
          <div className="flex gap-2 mb-2">
            <button type="button" onClick={() => setManualCenteringSide("front")}
              className="flex-1 flex items-center justify-center gap-1.5 border border-[#333333] text-[#888888] hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-[10px] font-bold uppercase px-2 py-1.5 rounded transition-all">
              Manual Centering (Front)
            </button>
            <button type="button" onClick={() => setManualCenteringSide("back")}
              className="flex-1 flex items-center justify-center gap-1.5 border border-[#333333] text-[#888888] hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-[10px] font-bold uppercase px-2 py-1.5 rounded transition-all">
              Manual Centering (Back)
            </button>
            {centeringMethod && (
              <span className={`self-center text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${centeringMethod === "manual" ? "bg-emerald-950/30 text-emerald-400 border border-emerald-800/40" : "bg-[#D4AF37]/10 text-[#D4AF37]/70 border border-[#D4AF37]/20"}`}>
                {centeringMethod}
              </span>
            )}
          </div>

          <div className="bg-[#111111] rounded-lg p-3">
            <CenteringInput
              frontLR={frontLR} frontTB={frontTB} backLR={backLR} backTB={backTB}
              subgrade={centeringCalc}
              onChange={(field, val) => {
                if (field === "frontLR") setFrontLR(val);
                else if (field === "frontTB") setFrontTB(val);
                else if (field === "backLR") setBackLR(val);
                else setBackTB(val);
              }}
              overrideGrade={centeringOverride}
              onOverride={v => { setCenteringOverride(v); }}
            />
          </div>

          {/* Corners */}
          <div className="bg-[#111111] rounded-lg p-3">
            <CornerGrading
              values={corners}
              subgrade={cornersGrade}
              onChange={setCorners}
              overrideGrade={cornersOverride}
              onOverride={setCornersOverride}
            />
          </div>

          {/* Edges */}
          <div className="bg-[#111111] rounded-lg p-3">
            <EdgeGrading
              values={edges}
              onChange={setEdges}
              overrideGrade={edgesOverride}
              onOverride={setEdgesOverride}
            />
          </div>

          {/* Surface */}
          <div className="bg-[#111111] rounded-lg p-3">
            <SurfaceGrading
              values={surface}
              onChange={setSurface}
              overrideGrade={surfaceOverride}
              onOverride={setSurfaceOverride}
            />
          </div>

          {/* Authentication */}
          <div className="bg-[#111111] rounded-lg p-3">
            <Authentication
              status={authStatus}
              notes={authNotes}
              onChange={(s, n) => { setAuthStatus(s); setAuthNotes(n); }}
            />
          </div>

          {/* Notes */}
          <div className="bg-[#111111] rounded-lg p-3">
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
          <div className="flex gap-3 sticky bottom-0 pb-2 pt-1 bg-[#0A0A0A]">
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
              setCenteringOverride(result.subgrade);
            } else {
              setBackLR(result.leftRight);
              setBackTB(result.topBottom);
            }
            setCenteringMethod("manual");
            setManualCenteringSide(null);
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
            <p className="text-[#888888] text-xs">This grade will be published and the Digital Grading Report will be generated.</p>
            {isBlack && (
              <div className="flex items-center gap-2 text-[#D4AF37] text-xs">
                <span className="text-lg">★</span>
                <span>This card qualifies for a BLACK LABEL — all subgrades are perfect 10.0</span>
              </div>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowConfirm(false)} className="border border-[#333333] text-[#888888] text-xs py-2 px-3 rounded hover:bg-[#1A1A1A]">Cancel</button>
              <button
                type="button"
                onClick={() => approveGrade(false)}
                disabled={approving}
                className="flex-1 border border-[#D4AF37]/40 text-[#D4AF37] text-xs font-bold py-2 rounded hover:bg-[#D4AF37]/10 disabled:opacity-40"
              >
                {approving ? "Approving…" : "Approve & Close"}
              </button>
              <button
                type="button"
                onClick={() => approveGrade(true)}
                disabled={approving}
                className="flex-1 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold py-2 rounded disabled:opacity-40"
              >
                {approving ? "Approving…" : "Approve & Next"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
