import { useState } from "react";
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
    level === "high"   ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/40" :
    level === "medium" ? "bg-yellow-950/40 text-yellow-400 border-yellow-800/40" :
                         "bg-red-950/40 text-red-400 border-red-800/40";
  return (
    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${cls}`}>
      {level}
    </span>
  );
}

export default function AiPanel({ certId, onAnalysisComplete, referenceImageUrl }: Props) {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<AiAnalysisResult | null>(null);
  const [identification, setIdentification] = useState<AiIdentification | null>(null);
  const [showConfidenceNotes, setShowConfidenceNotes] = useState(false);
  const [showAuthNotes, setShowAuthNotes] = useState(false);
  const [idConfidence, setIdConfidence] = useState<string | null>(null);
  const [idVerified, setIdVerified] = useState(false);

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
    <div className="bg-[#0A0A0A] border border-[#D4AF37]/20 rounded-xl p-4 space-y-4">
      {/* Header + button */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-[#D4AF37]" />
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">AI Grading Assistant</p>
        </div>
        <button
          type="button"
          onClick={runAnalysis}
          disabled={isLoading}
          className="flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-xs font-bold uppercase px-4 py-2 rounded-lg disabled:opacity-60 hover:opacity-90 transition-all"
        >
          {isLoading ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
          {isLoading ? STEP_LABELS[step] : step === "complete" ? "Re-Analyze" : "Analyze with AI"}
        </button>
      </div>

      {/* Confidence indicator */}
      {step === "complete" && idConfidence && (
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${idConfidence === "high" ? "bg-emerald-400" : idConfidence === "medium" ? "bg-yellow-400" : "bg-red-400"}`} />
          <span className={idConfidence === "high" ? "text-emerald-400" : idConfidence === "medium" ? "text-yellow-400" : "text-red-400"}>
            ID confidence: {idConfidence}{idVerified ? " (TCG API verified)" : ""}
          </span>
          {idConfidence === "low" && <span className="text-red-400/70">— manual verification recommended</span>}
        </div>
      )}

      {/* Loading progress */}
      {isLoading && (
        <div className="flex items-center gap-2 text-[#888888] text-xs">
          <Loader2 size={12} className="animate-spin flex-shrink-0" />
          <span>{STEP_LABELS[step]} (this takes 10–30 seconds)</span>
        </div>
      )}

      {/* Error */}
      {step === "error" && (
        <div className="flex items-center gap-2 bg-red-950/30 border border-red-800/40 rounded-lg px-3 py-2.5">
          <AlertTriangle size={14} className="text-red-400 flex-shrink-0" />
          <p className="text-red-400 text-xs">{error}</p>
        </div>
      )}

      {/* Complete state */}
      {step === "complete" && result && (
        <div className="space-y-4">

          {/* Card identification */}
          {identification && (
            <div className="bg-[#111111] border border-[#222222] rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest">Card Identified</p>
                {identification.verified ? (
                  <span className="flex items-center gap-1 text-emerald-400 text-[10px]">
                    <CheckCircle2 size={11} />
                    Verified via {identification.dbSource}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-yellow-400 text-[10px]">
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
                    className="w-16 h-22 object-contain rounded border border-[#333333] flex-shrink-0"
                  />
                )}
                <div className="space-y-0.5 min-w-0">
                  <p className="text-white text-sm font-bold truncate">{identification.officialName}</p>
                  <p className="text-[#888888] text-xs">{identification.officialSet}{identification.officialNumber ? ` · ${identification.officialNumber}` : ""}</p>
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
              <div key={label} className="bg-[#111111] rounded-lg p-2 text-center">
                <p className="text-[#555555] text-[8px] uppercase tracking-widest">{label}</p>
                <p className="text-[#D4AF37] text-lg font-black">{value}</p>
                <ConfidenceBadge level={conf} />
              </div>
            ))}
          </div>

          {/* Authentication */}
          {(!result.is_authentic || result.is_altered) && (
            <div className="bg-amber-950/30 border border-amber-700/40 rounded-lg px-3 py-2.5">
              <p className="text-amber-400 text-xs font-bold">
                {!result.is_authentic ? "⚠ Potential counterfeit detected" : "⚠ Card may be altered"}
              </p>
              {result.authentication_notes && (
                <p className="text-amber-400/70 text-xs mt-1">{result.authentication_notes}</p>
              )}
            </div>
          )}

          {/* Confidence notes */}
          {result.confidence_notes && (
            <div>
              <button
                type="button"
                onClick={() => setShowConfidenceNotes(v => !v)}
                className="flex items-center gap-1 text-[#555555] hover:text-[#888888] text-[10px] transition-colors"
              >
                {showConfidenceNotes ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                Confidence notes
              </button>
              {showConfidenceNotes && (
                <p className="text-[#888888] text-xs mt-1 leading-relaxed">{result.confidence_notes}</p>
              )}
            </div>
          )}

          {/* Centering detail */}
          <div className="bg-[#111111] border border-[#222222] rounded-lg p-3 space-y-1">
            <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest">Centering</p>
            <div className="grid grid-cols-2 gap-x-4 text-xs">
              <span className="text-[#555555]">Front L/R</span>
              <span className="text-[#CCCCCC]">{result.centering.front_left_right}</span>
              <span className="text-[#555555]">Front T/B</span>
              <span className="text-[#CCCCCC]">{result.centering.front_top_bottom}</span>
              <span className="text-[#555555]">Back L/R</span>
              <span className="text-[#CCCCCC]">{result.centering.back_left_right}</span>
              <span className="text-[#555555]">Back T/B</span>
              <span className="text-[#CCCCCC]">{result.centering.back_top_bottom}</span>
            </div>
            {result.centering.notes && <p className="text-[#555555] text-[10px] mt-1">{result.centering.notes}</p>}
          </div>

          {/* Defects */}
          {result.defects.length > 0 && (
            <div className="bg-[#111111] border border-[#222222] rounded-lg p-3 space-y-2">
              <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest">
                Defects Detected ({result.defects.length})
              </p>
              <div className="space-y-1.5">
                {result.defects.map(d => (
                  <div key={d.id} className="flex items-start gap-2">
                    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${
                      d.severity === "major"    ? "bg-red-950/40 text-red-400 border border-red-800/40" :
                      d.severity === "moderate" ? "bg-orange-950/40 text-orange-400 border border-orange-800/40" :
                                                  "bg-[#1A1A1A] text-[#555555] border border-[#333333]"
                    }`}>{d.severity}</span>
                    <div className="min-w-0">
                      <p className="text-[#CCCCCC] text-xs font-medium capitalize">{d.type.replace(/_/g, " ")} — {d.location}</p>
                      <p className="text-[#555555] text-[10px] leading-snug">{d.description}</p>
                      {d.detected_in !== "original" && (
                        <p className="text-[#444444] text-[9px]">detected in: {d.detected_in}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Grade explanation */}
          {result.grade_explanation && (
            <div className="bg-[#111111] border border-[#222222] rounded-lg p-3">
              <p className="text-[#D4AF37]/70 text-[10px] font-bold uppercase tracking-widest mb-1.5">AI Grade Explanation</p>
              <p className="text-[#888888] text-xs leading-relaxed">{result.grade_explanation}</p>
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
                className="flex items-center gap-1 text-[#444444] hover:text-[#666666] text-[10px] transition-colors"
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
