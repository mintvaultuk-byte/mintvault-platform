// /pre-grade — public-facing AI pre-grade upload tool.
//
// Two file inputs (front + back) → POST /api/pre-grade → display the
// returned grading with per-subgrade confidence. No persistence — the
// backend processes in memory and discards. Rate-limited to 3/hour per
// IP server-side; this page surfaces the 429 response if hit.

import { useState, useRef } from "react";
import { Link } from "wouter";
import { Upload, X, ArrowRight, Loader2, AlertTriangle } from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";

type Confidence = "high" | "medium" | "low";

interface GradingResponse {
  centering: { subgrade: number };
  corners:   { subgrade: number };
  edges:     { subgrade: number };
  surface:   { subgrade: number };
  overall_grade: number;
  confidence: {
    centering: Confidence;
    corners:   Confidence;
    edges:     Confidence;
    surface:   Confidence;
    overall:   Confidence;
  };
}

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const ACCEPT = "image/jpeg,image/png,image/tiff,image/tif";

// ── Local file picker ──────────────────────────────────────────────────────

function FilePicker({
  label,
  file,
  onChange,
  testId,
}: {
  label: string;
  file: File | null;
  onChange: (file: File | null) => void;
  testId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex-1">
      <p className="text-[10px] uppercase tracking-[0.2em] text-[#888888] mb-2">{label}</p>
      <label
        htmlFor={`file-${testId}`}
        className={`flex flex-col items-center justify-center gap-3 border-2 border-dashed rounded-xl p-8 cursor-pointer transition-all ${
          file ? "border-[#D4AF37] bg-[#D4AF37]/5" : "border-[#E8E4DC] hover:border-[#D4AF37]/60 hover:bg-[#D4AF37]/5"
        }`}
        data-testid={`zone-${testId}`}
      >
        <input
          ref={inputRef}
          id={`file-${testId}`}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={e => onChange(e.target.files?.[0] ?? null)}
          data-testid={`input-${testId}`}
        />
        {file ? (
          <>
            <div className="flex items-center gap-2 text-[#D4AF37]">
              <Upload size={18} />
              <span className="text-sm font-medium truncate max-w-[12rem]">{file.name}</span>
            </div>
            <p className="text-[10px] text-[#888888]">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                if (inputRef.current) inputRef.current.value = "";
                onChange(null);
              }}
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#888888] hover:text-[#1A1A1A] mt-1"
            >
              <X size={11} /> Remove
            </button>
          </>
        ) : (
          <>
            <Upload size={24} className="text-[#888888]" />
            <p className="text-sm font-medium text-[#1A1A1A]">Click to upload {label.toLowerCase()}</p>
            <p className="text-[10px] text-[#888888]">JPEG, PNG, TIFF — up to 20 MB</p>
          </>
        )}
      </label>
    </div>
  );
}

// ── Subgrade bar ───────────────────────────────────────────────────────────
// Renders the grade 1-10 as a horizontal bar with the value + confidence
// chip. Bar colour scales: 10 = emerald, 9 = gold, 8 = blue, ≤7 = amber.

function gradeBarColor(grade: number): string {
  if (grade >= 10) return "bg-emerald-500";
  if (grade >= 9)  return "bg-[#D4AF37]";
  if (grade >= 8)  return "bg-blue-500";
  if (grade >= 6)  return "bg-amber-500";
  return "bg-red-500";
}

function confidenceChip(c: Confidence): string {
  return c === "high"  ? "bg-emerald-100 text-emerald-800 border-emerald-300" :
         c === "low"   ? "bg-red-100    text-red-800    border-red-300" :
                         "bg-amber-100  text-amber-800  border-amber-300";
}

function SubgradeBar({
  label,
  value,
  confidence,
}: {
  label: string;
  value: number;
  confidence: Confidence;
}) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  return (
    <div data-testid={`subgrade-${label.toLowerCase()}`}>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs uppercase tracking-[0.15em] text-[#555555] font-medium">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-lg font-black text-[#1A1A1A]">{value}</span>
          <span className={`text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${confidenceChip(confidence)}`}>
            {confidence}
          </span>
        </div>
      </div>
      <div className="h-2 bg-[#F0EDE5] rounded-full overflow-hidden">
        <div className={`h-full ${gradeBarColor(value)} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function PreGradePage() {
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GradingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = !!front && !!back && !loading;

  // Client-side validation only — the server enforces the real limits.
  // Mirroring them here gives faster feedback for the common cases.
  function validateClient(): string | null {
    if (!front || !back) return "Both front and back images are required.";
    for (const [f, name] of [[front, "front"], [back, "back"]] as const) {
      if (f.size > MAX_BYTES) return `${name} image is over 20 MB.`;
      if (!ACCEPT.split(",").includes(f.type)) {
        return `${name} must be JPEG, PNG, or TIFF (got ${f.type || "unknown"}).`;
      }
    }
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const vErr = validateClient();
    if (vErr) { setError(vErr); return; }

    const fd = new FormData();
    fd.append("front", front!);
    fd.append("back", back!);

    setLoading(true);
    try {
      const r = await fetch("/api/pre-grade", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) {
        // 429 = rate-limited, surface the server message.
        throw new Error(d.error || (r.status === 429 ? "Rate-limited. Try again later." : `HTTP ${r.status}`));
      }
      if (!d.grading) throw new Error("No grading returned.");
      setResult(d.grading as GradingResponse);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white text-[#1A1A1A]">
      <HeaderV2 />

      <main className="max-w-3xl mx-auto px-4 py-12 sm:py-20">
        <header className="text-center mb-12">
          <p className="text-[10px] uppercase tracking-[0.3em] text-[#D4AF37] mb-3">MintVault AI</p>
          <h1 className="text-4xl sm:text-5xl font-black mb-4">Pre-Grade Tool</h1>
          <p className="text-[#555555] text-sm sm:text-base max-w-xl mx-auto">
            Upload front and back card images for an instant AI grade estimate. No account, no storage —
            images are analysed in memory and discarded.
          </p>
        </header>

        <form onSubmit={onSubmit} className="space-y-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <FilePicker label="Front" file={front} onChange={setFront} testId="front" />
            <FilePicker label="Back" file={back} onChange={setBack} testId="back" />
          </div>

          <div className="flex justify-center">
            <button
              type="submit"
              disabled={!canSubmit}
              className={`inline-flex items-center gap-2 px-8 py-3 rounded-lg text-sm font-bold uppercase tracking-wider transition-all ${
                canSubmit
                  ? "bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] hover:opacity-90"
                  : "bg-[#E8E4DC] text-[#888888] cursor-not-allowed"
              }`}
              data-testid="btn-submit"
            >
              {loading
                ? <><Loader2 size={14} className="animate-spin" /> Analysing…</>
                : <>Run AI Pre-Grade <ArrowRight size={14} /></>}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg p-4" role="alert" data-testid="text-error">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <p className="text-sm">{error}</p>
            </div>
          )}
        </form>

        {result && (
          <section className="mt-12 border border-[#E8E4DC] rounded-xl overflow-hidden" data-testid="section-result">
            <div className="bg-gradient-to-br from-[#D4AF37]/10 to-transparent p-8 text-center border-b border-[#E8E4DC]">
              <p className="text-[10px] uppercase tracking-[0.3em] text-[#D4AF37] mb-3">Predicted Overall Grade</p>
              <div className="inline-flex items-center justify-center w-28 h-28 rounded-full border-2 border-[#D4AF37]/40 bg-white mb-2" style={{ boxShadow: "0 0 24px rgba(212,175,55,0.12)" }}>
                <span className="text-5xl font-black text-[#1A1A1A]" data-testid="text-overall-grade">
                  {result.overall_grade}
                </span>
              </div>
              <p className="text-[10px] uppercase tracking-wider text-[#888888] mt-2">
                Overall confidence: <span className="font-bold">{result.confidence.overall}</span>
              </p>
            </div>

            <div className="p-8 space-y-5">
              <SubgradeBar label="Centering" value={result.centering.subgrade} confidence={result.confidence.centering} />
              <SubgradeBar label="Corners"   value={result.corners.subgrade}   confidence={result.confidence.corners} />
              <SubgradeBar label="Edges"     value={result.edges.subgrade}     confidence={result.confidence.edges} />
              <SubgradeBar label="Surface"   value={result.surface.subgrade}   confidence={result.confidence.surface} />
            </div>

            <div className="bg-[#F7F7F5] border-t border-[#E8E4DC] p-6 sm:p-8 text-center">
              <p className="text-sm text-[#555555] mb-5 max-w-xl mx-auto">
                This is an AI estimate. Submit your card for an official MintVault grade — physical inspection,
                cryptographic certificate, and full ownership logbook.
              </p>
              <Link
                href="/submit"
                className="inline-flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-sm font-bold uppercase tracking-wider px-8 py-3 rounded-lg hover:opacity-90 transition-opacity"
                data-testid="link-submit"
              >
                Submit for Official Grading <ArrowRight size={14} />
              </Link>
            </div>
          </section>
        )}

        <p className="text-center text-[10px] text-[#888888] mt-12 max-w-md mx-auto leading-relaxed">
          Limit 3 pre-grades per hour per IP. Single-photo AI grading is a sense-check, not a calibrated
          prediction — treat subgrades as directional. Images are not stored.
        </p>
      </main>

      <FooterV2 />
    </div>
  );
}
