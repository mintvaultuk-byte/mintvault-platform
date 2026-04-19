import { useState, useEffect } from "react";
import { Bot, CheckCircle2, AlertTriangle, Loader2, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
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
  externalAnalysis?: { analysis: AiAnalysisResult; identification: AiIdentification | null } | null;
  onExternalAnalysisConsumed?: () => void;
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

export default function AiPanel({ certId, onAnalysisComplete, referenceImageUrl, externalAnalysis, onExternalAnalysisConsumed }: Props) {
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

  // Accept external analysis from CertificateForm's "Identify & Grade" button
  useEffect(() => {
    if (externalAnalysis) {
      setIdentification(externalAnalysis.identification ?? null);
      setResult(externalAnalysis.analysis);
      setIdConfidence(externalAnalysis.identification?.confidence || null);
      setIdVerified(externalAnalysis.identification?.verified || false);
      setStep("complete");
      onAnalysisComplete(externalAnalysis.analysis, externalAnalysis.identification ?? null);
      onExternalAnalysisConsumed?.();
    }
  }, [externalAnalysis]);

  async function runCentering() {
    setCenteringStatus("loading"); setCenteringError("");
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/measure-centering`, { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setCenteringResult(d.centering);
      setCenteringStatus("done");
      toast({ title: `Centering: ${d.centering.front_left_right} L/R` });
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
      toast({ title: `${d.defects.defects?.length || 0} defects detected` });
    } catch (e: any) { setDefectsStatus("error"); setDefectsError(e.message); }
  }

  async function runGrade() {
    setGradeStatus("loading"); setGradeError("");
    try {
      const r = await fetch(`/api/admin/certificates/${certId}/grade-card`, { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setGradeResult(d.grade);
      setGradeStatus("done");
      toast({ title: `Grade: ${d.grade.overall_grade} ${d.grade.grade_label}` });
    } catch (e: any) { setGradeStatus("error"); setGradeError(e.message); }
  }

  async function runAllFour() {
    // Run identify (already on form), centering, defects in parallel, then grade
    const promises = [runCentering(), runDefects()];
    await Promise.allSettled(promises);
    await runGrade();
    // Also trigger legacy full analysis for the workstation integration
    runAnalysis();
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
        <ActionButton label="Grade Card" status={gradeStatus} error={gradeError} onClick={runGrade} cost="~£0.03" />
        <button type="button" onClick={runAllFour}
          disabled={centeringStatus === "loading" || defectsStatus === "loading" || gradeStatus === "loading" || isLoading}
          className="flex items-center justify-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-3 py-2.5 rounded-lg disabled:opacity-50 hover:opacity-90 transition-all"
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

      {/* Complete state */}
      {step === "complete" && result && (
        <div className="space-y-4">

          {/* Card identification */}
          {identification && (
            <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest">Card Identified</p>
                {identification.verified ? (
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
                  <p className="text-[#555555] text-[10px]">{identification.detected_game.toUpperCase()} · {identification.detected_language} · {identification.detected_rarity}</p>
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

          {/* Grade summary */}
          <div className="grid grid-cols-5 gap-2">
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
        </div>
      )}
    </div>
  );
}
