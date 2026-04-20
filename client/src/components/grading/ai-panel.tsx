import { useState, useEffect, useRef } from "react";
import { Bot, CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronUp, ExternalLink, Search, Database } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

type Confidence = "high" | "medium" | "low";

interface AiDefect {
  id: number;
  type: string;
  location: string;
  position_x_percent: number;
  position_y_percent: number;
  severity: string;
  description: string;
  detected_in: string;
}

interface CornerDetail { grade: number; notes: string; }
interface EdgeDetail   { grade: number; notes: string; }

export interface AiAnalysisResult {
  card_identification: {
    detected_name: string;
    detected_set: string;
    detected_number: string | null;
    detected_year: string | null;
    detected_game: string;
    detected_language: string;
    detected_rarity: string | null;
    is_holo: boolean;
    identification_confidence: string;
  };
  centering: {
    subgrade: number;
    front_left_right: string;
    front_top_bottom: string;
    back_left_right: string;
    back_top_bottom: string;
    front_outer_frame?: { left_pct: number; right_pct: number; top_pct: number; bottom_pct: number } | null;
    front_inner_frame?: { left_pct: number; right_pct: number; top_pct: number; bottom_pct: number } | null;
    back_outer_frame?: { left_pct: number; right_pct: number; top_pct: number; bottom_pct: number } | null;
    back_inner_frame?: { left_pct: number; right_pct: number; top_pct: number; bottom_pct: number } | null;
    notes: string;
  };
  corners: {
    subgrade: number;
    front_top_left: CornerDetail;
    front_top_right: CornerDetail;
    front_bottom_left: CornerDetail;
    front_bottom_right: CornerDetail;
    back_top_left: CornerDetail;
    back_top_right: CornerDetail;
    back_bottom_left: CornerDetail;
    back_bottom_right: CornerDetail;
    notes: string;
  };
  edges: {
    subgrade: number;
    front_top: EdgeDetail;
    front_right: EdgeDetail;
    front_bottom: EdgeDetail;
    front_left: EdgeDetail;
    back_top: EdgeDetail;
    back_right: EdgeDetail;
    back_bottom: EdgeDetail;
    back_left: EdgeDetail;
    notes: string;
  };
  surface: {
    subgrade: number;
    front_grade: number;
    back_grade: number;
    front_notes: string;
    back_notes: string;
    notes: string;
  };
  defects: AiDefect[];
  overall_grade: number | string;
  grade_label: string;
  grade_explanation: string;
  confidence: {
    centering: Confidence;
    corners: Confidence;
    edges: Confidence;
    surface: Confidence;
    overall: Confidence;
  };
  confidence_notes: string;
  photo_quality_notes: string[];
  is_authentic: boolean;
  is_altered: boolean;
  authentication_notes: string;
  recommendations: string[];
}

export interface AiIdentification {
  detected_name: string;
  detected_set: string;
  detected_number: string | null;
  detected_year: string | null;
  detected_game: string;
  detected_language: string;
  detected_rarity: string | null;
  is_holo: boolean;
  confidence: string;
  verified: boolean;
  officialName: string;
  officialSet: string;
  officialNumber: string | null;
  referenceImageUrl: string | null;
  dbSource: string | null;
}

interface Props {
  certId: number;
  onAnalysisComplete: (analysis: AiAnalysisResult, identification: AiIdentification | null) => void;
  referenceImageUrl?: string | null;
  /** External analysis pushed from CertificateForm's "Identify & Grade" button */
  externalAnalysis?: { analysis: AiAnalysisResult | null; identification: AiIdentification | null } | null;
  onExternalAnalysisConsumed?: () => void;
  /** Callback when user manually identifies a card from the AI panel's own Search TCG */
  onManualIdentification?: (identification: Record<string, unknown>) => void;
  /** Current card game from form (for TCG search) */
  cardGame?: string;
}

type Step =
  | "idle"
  | "identifying"
  | "analyzing_centering"
  | "analyzing_corners"
  | "analyzing_edges"
  | "analyzing_surface"
  | "generating_report"
  | "complete"
  | "error";

const STEP_LABELS: Record<Step, string> = {
  idle:               "Analyze with AI",
  identifying:        "Identifying card...",
  analyzing_centering:"Analyzing centering...",
  analyzing_corners:  "Examining corners and edges...",
  analyzing_edges:    "Examining corners and edges...",
  analyzing_surface:  "Inspecting surfaces...",
  generating_report:  "Generating report...",
  complete:           "Analysis complete — review draft below",
  error:              "Analysis failed",
};

function ConfidenceBadge({ level }: { level: Confidence }) {
  const cls =
    level === "high"   ? "bg-emerald-50 text-emerald-600 border-emerald-200" :
    level === "medium" ? "bg-amber-50 text-amber-600 border-amber-200" :
                         "bg-red-50 text-red-600 border-red-200";
  return (
    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${cls}`}>
      {level}
    </span>
  );
}

type ActionStatus = "idle" | "loading" | "done" | "error";

function ActionButton({ label, status, error: err, onClick, cost }: {
  label: string; status: ActionStatus; error?: string; onClick: () => void; cost: string;
}) {
  return (
    <div className="space-y-1">
      <button type="button" onClick={onClick} disabled={status === "loading"}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-xs font-bold uppercase transition-all ${
          status === "done" ? "border-emerald-200 bg-emerald-50 text-emerald-600" :
          status === "error" ? "border-red-300 bg-red-50 text-red-600" :
          status === "loading" ? "border-[#D4AF37]/40 bg-[#D4AF37]/5 text-[#D4AF37]" :
          "border-[#D4D0C8] text-[#333333] hover:border-[#D4AF37]/40 hover:text-[#D4AF37]"
        }`}>
        <span className="flex items-center gap-2">
          {status === "loading" ? <Loader2 size={13} className="animate-spin" /> :
           status === "done" ? <CheckCircle2 size={13} /> :
           status === "error" ? <AlertTriangle size={13} /> :
           <Bot size={13} />}
          {status === "loading" ? `Running ${label}…` : status === "done" ? `${label} ✓` : status === "error" ? `${label} — retry` : label}
        </span>
        <span className="text-[9px] text-[#555555] font-normal normal-case">{cost}</span>
      </button>
      {status === "error" && err && <p className="text-red-600 text-[10px] px-1">{err}</p>}
    </div>
  );
}

export default function AiPanel({ certId, onAnalysisComplete, referenceImageUrl, externalAnalysis, onExternalAnalysisConsumed, onManualIdentification, cardGame }: Props) {
  const { toast } = useToast();

  // Legacy state for full analysis (kept for backward compat)
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<AiAnalysisResult | null>(null);
  const [identification, setIdentification] = useState<AiIdentification | null>(null);
  const [showConfidenceNotes, setShowConfidenceNotes] = useState(false);
  const [showAuthNotes, setShowAuthNotes] = useState(false);
  const [idConfidence, setIdConfidence] = useState<string | null>(null);
  const [idVerified, setIdVerified] = useState(false);

  // Individual action states
  const [centeringStatus, setCenteringStatus] = useState<ActionStatus>("idle");
  const [centeringError, setCenteringError] = useState("");
  const [centeringResult, setCenteringResult] = useState<any>(null);

  const [defectsStatus, setDefectsStatus] = useState<ActionStatus>("idle");
  const [defectsError, setDefectsError] = useState("");
  const [defectsResult, setDefectsResult] = useState<any>(null);

  const [gradeStatus, setGradeStatus] = useState<ActionStatus>("idle");
  const [gradeError, setGradeError] = useState("");
  const [gradeResult, setGradeResult] = useState<any>(null);

  // TCG search state (for "Change card" in Card Identified panel)
  const [panelTcgOpen, setPanelTcgOpen] = useState(false);
  const [panelTcgQuery, setPanelTcgQuery] = useState("");
  const [panelTcgResults, setPanelTcgResults] = useState<{ id: string; name: string; setName: string; number: string | null; rarity: string | null; year: string | null; imageUrl: string | null }[]>([]);
  const [panelTcgLoading, setPanelTcgLoading] = useState(false);
  const panelTcgDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panelTcgCache] = useState(() => new Map<string, typeof panelTcgResults>());

  function handlePanelTcgSearch(query: string) {
    setPanelTcgQuery(query);
    if (panelTcgDebounce.current) clearTimeout(panelTcgDebounce.current);
    if (query.trim().length < 3) { setPanelTcgResults([]); setPanelTcgLoading(false); return; }
    const gameSlug = (cardGame || "pokemon").toLowerCase().replace(/[éè]/g, "e").replace(/[^a-z0-9]/g, "");
    const cacheKey = `${gameSlug}:${query.trim().toLowerCase()}`;
    if (panelTcgCache.has(cacheKey)) { setPanelTcgResults(panelTcgCache.get(cacheKey)!); return; }
    setPanelTcgLoading(true);
    panelTcgDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/card-lookup?game=${encodeURIComponent(gameSlug)}&query=${encodeURIComponent(query.trim())}&mode=wildcard`, { credentials: "include" });
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json();
        const results = Array.isArray(data) ? data : [];
        panelTcgCache.set(cacheKey, results);
        setPanelTcgResults(results);
      } catch { setPanelTcgResults([]); }
      finally { setPanelTcgLoading(false); }
    }, 400);
  }

  function selectPanelTcgCard(card: typeof panelTcgResults[number]) {
    const manualId: AiIdentification = {
      detected_name: card.name || "",
      detected_set: card.setName || "",
      detected_number: card.number || null,
      detected_year: card.year || null,
      detected_game: cardGame || "pokemon",
      detected_language: "English",
      detected_rarity: card.rarity || null,
      is_holo: false,
      confidence: "high",
      verified: true,
      officialName: card.name || "",
      officialSet: card.setName || "",
      officialNumber: card.number || null,
      referenceImageUrl: card.imageUrl || null,
      dbSource: "manual-tcg-search",
    };
    setIdentification(manualId);
    setIdConfidence("high");
    setIdVerified(true);
    if (step === "idle") setStep("complete");
    setPanelTcgOpen(false);
    setPanelTcgQuery("");
    setPanelTcgResults([]);
    toast({ title: "Card updated", description: `${card.name} — ${card.setName}` });
    // Sync to form at the top
    onManualIdentification?.(manualId as unknown as Record<string, unknown>);
  }

  // Accept external analysis or identification-only updates
  useEffect(() => {
    if (externalAnalysis) {
      setIdentification(externalAnalysis.identification ?? null);
      setIdConfidence(externalAnalysis.identification?.confidence || null);
      setIdVerified(externalAnalysis.identification?.verified || false);

      if (externalAnalysis.analysis) {
        // Full analysis — update grading too
        setResult(externalAnalysis.analysis);
        setStep("complete");
        onAnalysisComplete(externalAnalysis.analysis, externalAnalysis.identification ?? null);
      } else {
        // Identification-only update (manual TCG search) — keep existing grading
        if (step === "idle") setStep("complete"); // show the panel if it wasn't visible
      }
      onExternalAnalysisConsumed?.();
    }
  }, [externalAnalysis]);

  // Empty shell for partial synthesis — subgrade 0 means "not measured, skip"
  function emptyAnalysis(): AiAnalysisResult {
    const dc = { grade: 0, notes: "" };
    const de = { grade: 0, notes: "" };
    return {
      card_identification: { detected_name: "", detected_set: "", detected_number: null, detected_year: null, detected_game: "", detected_language: "", detected_rarity: null, is_holo: false, identification_confidence: "low" },
      centering: { subgrade: 0, front_left_right: "", front_top_bottom: "", back_left_right: "", back_top_bottom: "", notes: "" },
      corners: { subgrade: 0, front_top_left: dc, front_top_right: dc, front_bottom_left: dc, front_bottom_right: dc, back_top_left: dc, back_top_right: dc, back_bottom_left: dc, back_bottom_right: dc, notes: "" },
      edges: { subgrade: 0, front_top: de, front_right: de, front_bottom: de, front_left: de, back_top: de, back_right: de, back_bottom: de, back_left: de, notes: "" },
      surface: { subgrade: 0, front_grade: 0, back_grade: 0, front_notes: "", back_notes: "", notes: "" },
      defects: [], overall_grade: 0, grade_label: "", grade_explanation: "",
      confidence: { centering: "medium", corners: "medium", edges: "medium", surface: "medium", overall: "medium" },
      confidence_notes: "", photo_quality_notes: [], is_authentic: true, is_altered: false, authentication_notes: "", recommendations: [],
    };
  }

  async function runCentering() {
    setCenteringStatus("loading"); setCenteringError("");
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/measure-centering`, { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setCenteringResult(d.centering);
      setCenteringStatus("done");
      toast({ title: `Centering: ${d.centering.front_left_right} L/R` });

      // Push centering values into grading panel
      const c = d.centering;
      const partial = emptyAnalysis();
      partial.centering = {
        subgrade: c.centering_subgrade ?? c.front_centering_grade ?? 0,
        front_left_right: c.front_left_right || "",
        front_top_bottom: c.front_top_bottom || "",
        back_left_right: c.back_left_right || "",
        back_top_bottom: c.back_top_bottom || "",
        front_outer_frame: c.front_outer_frame || null,
        front_inner_frame: c.front_inner_frame || null,
        back_outer_frame: c.back_outer_frame || null,
        back_inner_frame: c.back_inner_frame || null,
        notes: c.notes || "",
      };
      onAnalysisComplete(partial, null);
    } catch (e: any) { setCenteringStatus("error"); setCenteringError(e.message); }
  }

  async function runDefects() {
    setDefectsStatus("loading"); setDefectsError("");
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/detect-defects`, { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setDefectsResult(d.defects);
      setDefectsStatus("done");
      const defectArr = Array.isArray(d.defects) ? d.defects : (d.defects?.defects || []);
      toast({ title: `${defectArr.length} defects detected` });

      // Push defects into grading panel
      const partial = emptyAnalysis();
      partial.defects = defectArr.map((df: any, i: number) => ({
        id: df.id ?? i + 1, type: df.type || "unknown",
        location: df.location || "front",
        position_x_percent: df.position_x_percent ?? 50,
        position_y_percent: df.position_y_percent ?? 50,
        width_percent: df.width_percent ?? 5,
        height_percent: df.height_percent ?? 5,
        severity: df.severity || "minor",
        description: df.description || "",
        detected_in: df.detected_in || "original",
      }));
      onAnalysisComplete(partial, null);
    } catch (e: any) { setDefectsStatus("error"); setDefectsError(e.message); }
  }

  async function callGradeEndpoint() {
    const r = await fetch(`/api/admin/certificates/${certId}/grade-card`, { method: "POST", credentials: "include" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    setGradeResult(d.grade);
    setGradeStatus("done");
    toast({ title: `Grade: ${d.grade.overall_grade} ${d.grade.grade_label}` });

    // Synthesise an AiAnalysisResult from the three individual responses
    // so the grading panel populates subgrade dropdowns, defects, centering ratios
    const g = d.grade;
    const c = centeringResult;
    // Use aggregate subgrade as per-position value so calc functions produce correct results
    // (individual /grade-card endpoint doesn't return per-corner/per-edge breakdowns)
    const coGrade = g.corners_subgrade ?? 0;
    const edGrade = g.edges_subgrade ?? 0;
    const sfGrade = g.surface_subgrade ?? 0;
    const cornerVal = { grade: coGrade, notes: "" };
    const edgeVal = { grade: edGrade, notes: "" };
    const synthesised: AiAnalysisResult = {
      card_identification: {
        detected_name: "", detected_set: "", detected_number: null,
        detected_year: null, detected_game: "", detected_language: "",
        detected_rarity: null, is_holo: false, identification_confidence: "low",
      },
      centering: {
        subgrade: g.centering_subgrade ?? c?.centering_subgrade ?? 0,
        front_left_right: c?.front_left_right || "",
        front_top_bottom: c?.front_top_bottom || "",
        back_left_right: c?.back_left_right || "",
        back_top_bottom: c?.back_top_bottom || "",
        front_outer_frame: c?.front_outer_frame || null,
        front_inner_frame: c?.front_inner_frame || null,
        back_outer_frame: c?.back_outer_frame || null,
        back_inner_frame: c?.back_inner_frame || null,
        notes: c?.notes || "",
      },
      corners: {
        subgrade: coGrade,
        front_top_left: cornerVal, front_top_right: cornerVal,
        front_bottom_left: cornerVal, front_bottom_right: cornerVal,
        back_top_left: cornerVal, back_top_right: cornerVal,
        back_bottom_left: cornerVal, back_bottom_right: cornerVal,
        notes: "",
      },
      edges: {
        subgrade: edGrade,
        front_top: edgeVal, front_right: edgeVal,
        front_bottom: edgeVal, front_left: edgeVal,
        back_top: edgeVal, back_right: edgeVal,
        back_bottom: edgeVal, back_left: edgeVal,
        notes: "",
      },
      surface: {
        subgrade: sfGrade,
        front_grade: sfGrade,
        back_grade: sfGrade,
        front_notes: "", back_notes: "", notes: "",
      },
      defects: (defectsResult || []).map((df: any, i: number) => ({
        id: df.id ?? i + 1, type: df.type || "unknown",
        location: df.location || "front",
        position_x_percent: df.position_x_percent ?? 50,
        position_y_percent: df.position_y_percent ?? 50,
        width_percent: df.width_percent ?? 5,
        height_percent: df.height_percent ?? 5,
        severity: df.severity || "minor",
        description: df.description || "",
        detected_in: df.detected_in || "original",
      })),
      overall_grade: g.overall_grade,
      grade_label: g.grade_label || "",
      grade_explanation: g.grade_explanation || "",
      confidence: { centering: "medium", corners: "medium", edges: "medium", surface: "medium", overall: "medium" },
      confidence_notes: "",
      photo_quality_notes: [],
      is_authentic: g.is_authentic ?? true,
      is_altered: g.is_altered ?? false,
      authentication_notes: g.authentication_notes || "",
      recommendations: g.recommendations || [],
      grade_strength_score: g.grade_strength_score ?? null,
    } as AiAnalysisResult;
    onAnalysisComplete(synthesised, null);
  }

  async function runGrade() {
    setGradeStatus("loading"); setGradeError("");
    try {
      // Auto-run centering/defects if not yet done this session
      const needsCentering = centeringStatus !== "done";
      const needsDefects = defectsStatus !== "done";

      if (needsCentering || needsDefects) {
        const prereqs: Promise<void>[] = [];
        if (needsCentering) prereqs.push(runCentering());
        if (needsDefects) prereqs.push(runDefects());
        await Promise.allSettled(prereqs);
      }

      await callGradeEndpoint();
    } catch (e: any) { setGradeStatus("error"); setGradeError(e.message); }
  }

  async function runAllThree() {
    // Centering + defects in parallel, then grade (uses their results as context)
    const promises = [runCentering(), runDefects()];
    await Promise.allSettled(promises);
    await runGrade();
  }

  async function runAnalysis() {
    setStep("identifying");
    setError("");
    setResult(null);
    setIdentification(null);

    // Fake progress steps while waiting
    const steps: Step[] = [
      "analyzing_centering",
      "analyzing_corners",
      "analyzing_surface",
      "generating_report",
    ];
    let stepIdx = 0;
    const progressInterval = setInterval(() => {
      if (stepIdx < steps.length) {
        setStep(steps[stepIdx++]);
      }
    }, 4000);

    try {
      const res = await fetch(`/api/admin/certificates/${certId}/identify-and-analyze`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      clearInterval(progressInterval);

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");

      setIdentification(data.identification ?? null);
      setResult(data.analysis);
      setIdConfidence(data.identificationConfidence || null);
      setIdVerified(data.identificationVerified || false);
      setStep("complete");
      onAnalysisComplete(data.analysis, data.identification ?? null);

      if (data.detailsWritten === false) {
        toast({ title: "AI couldn't confidently identify this card", description: "Please fill in card details manually", variant: "destructive" });
      } else {
        toast({ title: "AI analysis complete" });
      }
    } catch (e: any) {
      clearInterval(progressInterval);
      setStep("error");
      setError(e.message);
    }
  }

  const isLoading = !["idle", "complete", "error"].includes(step);

  return (
    <div className="bg-white border border-[#D4AF37]/20 rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Bot size={16} className="text-[#D4AF37]" />
        <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">AI Grading Assistant</p>
      </div>

      {/* Four individual action buttons */}
      <div className="grid grid-cols-2 gap-2">
        <ActionButton label="Measure Centering" status={centeringStatus} error={centeringError} onClick={runCentering} cost="~£0.03" />
        <ActionButton label="Detect Defects" status={defectsStatus} error={defectsError} onClick={runDefects} cost="~£0.04" />
        <ActionButton
          label="Grade Card"
          status={gradeStatus}
          error={gradeError}
          onClick={runGrade}
          cost={centeringStatus === "done" && defectsStatus === "done" ? "~£0.03" : centeringStatus === "done" || defectsStatus === "done" ? "~£0.07" : "~£0.10"}
        />
        <button type="button" onClick={runAllThree}
          disabled={centeringStatus === "loading" || defectsStatus === "loading" || gradeStatus === "loading" || isLoading}
          className="flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-3 py-2.5 rounded-lg disabled:opacity-50 hover:opacity-90 transition-all"
          title="Centering + Defects + Grade (does not re-identify)"
        >
          <Bot size={13} />
          Run All
        </button>
      </div>

      {/* Legacy full analyze button (smaller, below) */}
      <button
          type="button"
          onClick={runAnalysis}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 border border-[#D4D0C8] text-[#333333] hover:text-[#D4AF37] hover:border-[#D4AF37]/40 text-[10px] font-bold uppercase px-4 py-2 rounded-lg disabled:opacity-60 transition-all"
        >
          {isLoading ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
          {isLoading ? STEP_LABELS[step] : step === "complete" ? "Re-Analyze (Full)" : "Analyze with AI (Full)"}
        </button>

      {/* Confidence indicator */}
      {step === "complete" && idConfidence && (
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${idConfidence === "high" ? "bg-emerald-600" : idConfidence === "medium" ? "bg-amber-600" : "bg-red-600"}`} />
          <span className={idConfidence === "high" ? "text-emerald-600" : idConfidence === "medium" ? "text-amber-600" : "text-red-600"}>
            ID confidence: {idConfidence}{idVerified ? " (TCG API verified)" : ""}
          </span>
          {idConfidence === "low" && <span className="text-red-600/70">— manual verification recommended</span>}
        </div>
      )}

      {/* Loading progress */}
      {isLoading && (
        <div className="flex items-center gap-2 text-[#333333] text-xs">
          <Loader2 size={12} className="animate-spin flex-shrink-0" />
          <span>{STEP_LABELS[step]} (this takes 10–30 seconds)</span>
        </div>
      )}

      {/* Error */}
      {step === "error" && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2.5">
          <AlertTriangle size={14} className="text-red-600 flex-shrink-0" />
          <p className="text-red-600 text-xs">{error}</p>
        </div>
      )}

      {/* Card identification — shown whenever identification is set, regardless of grading state */}
      {step === "complete" && identification && (
        <div className="space-y-4">
          {identification && (
            <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest">Card Identified</p>
                <div className="flex items-center gap-2">
                  {(identification as any).manuallyVerified || (identification as any).dbSource === "manual-tcg-search" ? (
                    <span className="flex items-center gap-1 text-emerald-600 text-[10px]">
                      <CheckCircle2 size={11} />
                      Manually verified
                    </span>
                  ) : identification.verified ? (
                    <span className="flex items-center gap-1 text-emerald-600 text-[10px]">
                      <CheckCircle2 size={11} />
                      Verified via {identification.dbSource}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-amber-600 text-[10px]">
                      <AlertTriangle size={11} />
                      Not found in database
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => { setPanelTcgOpen(true); setPanelTcgQuery(""); setPanelTcgResults([]); }}
                    className="flex items-center gap-1 text-[#D4AF37] text-[10px] font-bold hover:text-[#B8960C] transition-colors"
                  >
                    <Database size={9} />
                    Change
                  </button>
                </div>
              </div>
              <div className="flex gap-3">
                {identification.referenceImageUrl && (
                  <img
                    src={identification.referenceImageUrl}
                    alt="Reference"
                    className="w-16 h-22 object-contain rounded border border-[#D4D0C8] flex-shrink-0"
                  />
                )}
                <div className="space-y-0.5 min-w-0">
                  <p className="text-[#1A1A1A] text-sm font-bold truncate">{identification.officialName}</p>
                  <p className="text-[#333333] text-xs">{identification.officialSet}{identification.officialNumber ? ` · ${identification.officialNumber}` : ""}</p>
                  <p className="text-[#555555] text-[10px]">{identification.detected_game?.toUpperCase()} · {identification.detected_language} · {identification.detected_rarity}</p>
                  {identification.is_holo && <span className="text-[9px] text-[#D4AF37] bg-[#D4AF37]/10 px-1.5 py-0.5 rounded">HOLO</span>}
                </div>
              </div>
            </div>
          )}

          {/* Reference image link */}
          {(referenceImageUrl || identification?.referenceImageUrl) && (
            <a
              href={referenceImageUrl || identification?.referenceImageUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[#D4AF37]/60 text-xs hover:text-[#D4AF37] transition-colors"
            >
              <ExternalLink size={11} />
              View reference image
            </a>
          )}

          {/* Grade summary — only shown when grading results exist */}
          {result && (<><div className="grid grid-cols-5 gap-2">
            {[
              { label: "Centering",  value: result.centering.subgrade, conf: result.confidence.centering },
              { label: "Corners",    value: result.corners.subgrade,   conf: result.confidence.corners },
              { label: "Edges",      value: result.edges.subgrade,     conf: result.confidence.edges },
              { label: "Surface",    value: result.surface.subgrade,   conf: result.confidence.surface },
              { label: "Overall",    value: result.overall_grade,      conf: result.confidence.overall },
            ].map(({ label, value, conf }) => (
              <div key={label} className="bg-[#F7F7F5] rounded-lg p-2 text-center">
                <p className="text-[#555555] text-[8px] uppercase tracking-widest">{label}</p>
                <p className="text-[#D4AF37] text-lg font-black">{value}</p>
                <ConfidenceBadge level={conf} />
              </div>
            ))}
          </div>

          {/* Authentication */}
          {(!result.is_authentic || result.is_altered) && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
              <p className="text-amber-600 text-xs font-bold">
                {!result.is_authentic ? "⚠ Potential counterfeit detected" : "⚠ Card may be altered"}
              </p>
              {result.authentication_notes && (
                <p className="text-amber-600/70 text-xs mt-1">{result.authentication_notes}</p>
              )}
            </div>
          )}

          {/* Confidence notes */}
          {result.confidence_notes && (
            <div>
              <button
                type="button"
                onClick={() => setShowConfidenceNotes(v => !v)}
                className="flex items-center gap-1 text-[#555555] hover:text-[#333333] text-[10px] transition-colors"
              >
                {showConfidenceNotes ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                Confidence notes
              </button>
              {showConfidenceNotes && (
                <p className="text-[#333333] text-xs mt-1 leading-relaxed">{result.confidence_notes}</p>
              )}
            </div>
          )}

          {/* Centering detail */}
          <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3 space-y-1">
            <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest">Centering</p>
            <div className="grid grid-cols-2 gap-x-4 text-xs">
              <span className="text-[#555555]">Front L/R</span>
              <span className="text-[#1A1A1A]">{result.centering.front_left_right}</span>
              <span className="text-[#555555]">Front T/B</span>
              <span className="text-[#1A1A1A]">{result.centering.front_top_bottom}</span>
              <span className="text-[#555555]">Back L/R</span>
              <span className="text-[#1A1A1A]">{result.centering.back_left_right}</span>
              <span className="text-[#555555]">Back T/B</span>
              <span className="text-[#1A1A1A]">{result.centering.back_top_bottom}</span>
            </div>
            {result.centering.notes && <p className="text-[#555555] text-[10px] mt-1">{result.centering.notes}</p>}
          </div>

          {/* Defects */}
          {result.defects.length > 0 && (
            <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3 space-y-2">
              <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest">
                Defects Detected ({result.defects.length})
              </p>
              <div className="space-y-1.5">
                {result.defects.map(d => (
                  <div key={d.id} className="flex items-start gap-2">
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${
                      d.severity === "major"    ? "bg-red-50 text-red-600 border border-red-200" :
                      d.severity === "moderate" ? "bg-orange-50 text-orange-600 border border-orange-200" :
                                                  "bg-[#F0EEE8] text-[#555555] border border-[#D4D0C8]"
                    }`}>{d.severity}</span>
                    <div className="min-w-0">
                      <p className="text-[#1A1A1A] text-xs font-medium capitalize">{d.type.replace(/_/g, " ")} — {d.location}</p>
                      <p className="text-[#555555] text-[10px] leading-snug">{d.description}</p>
                      {d.detected_in !== "original" && (
                        <p className="text-[#888888] text-[9px]">detected in: {d.detected_in}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Grade explanation */}
          {result.grade_explanation && (
            <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3">
              <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest mb-1.5">AI Grade Explanation</p>
              <p className="text-[#333333] text-xs leading-relaxed">{result.grade_explanation}</p>
            </div>
          )}

          {/* Recommendations */}
          {result.recommendations?.length > 0 && (
            <div className="space-y-1">
              <p className="text-[#555555] text-[10px] font-bold uppercase tracking-widest">Recommendations</p>
              {result.recommendations.map((r, i) => (
                <p key={i} className="text-[#555555] text-xs">· {r}</p>
              ))}
            </div>
          )}

          {/* Auth notes toggle */}
          {result.authentication_notes && result.is_authentic && !result.is_altered && (
            <div>
              <button
                type="button"
                onClick={() => setShowAuthNotes(v => !v)}
                className="flex items-center gap-1 text-[#888888] hover:text-[#555555] text-[10px] transition-colors"
              >
                {showAuthNotes ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                Authentication notes
              </button>
              {showAuthNotes && (
                <p className="text-[#555555] text-xs mt-1 leading-relaxed">{result.authentication_notes}</p>
              )}
            </div>
          )}
          </>)}
        </div>
      )}

      {/* TCG Search Dialog (for "Change card" in identification panel) */}
      <Dialog open={panelTcgOpen} onOpenChange={setPanelTcgOpen}>
        <DialogContent className="max-w-lg p-0 overflow-hidden">
          <div className="p-4 pb-2 border-b border-[#E8E4DC]">
            <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest mb-2">Search TCG Database</p>
            <div className="flex items-center gap-2 border border-[#D4AF37]/30 rounded-lg px-3 py-2 focus-within:border-[#D4AF37] transition-colors">
              <Search size={14} className="text-[#D4AF37]/50 shrink-0" />
              <input
                type="text"
                value={panelTcgQuery}
                onChange={(e) => handlePanelTcgSearch(e.target.value)}
                placeholder="Type card name..."
                className="flex-1 bg-transparent text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] outline-none"
                autoFocus
              />
              {panelTcgLoading && <Loader2 size={14} className="animate-spin text-[#D4AF37]" />}
            </div>
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            {panelTcgQuery.trim().length >= 3 && !panelTcgLoading && panelTcgResults.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-[#888888] text-sm">No cards found</p>
              </div>
            )}
            {panelTcgResults.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => selectPanelTcgCard(card)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-[#D4AF37]/5 transition-colors border-b border-[#F7F7F5] last:border-0"
              >
                {card.imageUrl ? (
                  <img src={card.imageUrl} alt="" className="w-10 h-14 object-contain rounded shrink-0" />
                ) : (
                  <div className="w-10 h-14 bg-[#F7F7F5] rounded shrink-0 flex items-center justify-center">
                    <Search size={12} className="text-[#AAAAAA]" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[#1A1A1A] text-sm font-bold truncate">{card.name}</p>
                  <p className="text-[#555555] text-xs truncate">{card.setName}{card.number ? ` · #${card.number}` : ""}</p>
                  <p className="text-[#AAAAAA] text-[10px]">{[card.rarity, card.year].filter(Boolean).join(" · ")}</p>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
