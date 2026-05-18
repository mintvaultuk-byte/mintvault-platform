// /pre-grade — public-facing AI pre-grade upload tool.
//
// Two file inputs (front + back) → POST /api/pre-grade → display the
// returned grading with per-subgrade confidence. No persistence — the
// backend processes in memory and discards. Rate-limited to 3/hour per
// IP server-side; this page surfaces the 429 response if hit.

import { useState, useRef, useEffect } from "react";
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

// ── Crossover comparison table ─────────────────────────────────────────────
// Maps MintVault 1–10 to PSA / BGS / CGC equivalents. The 5–10 mappings are
// the rubric Cornelius supplied; 1–4 follow the same MV ↔ BGS/CGC half-grade
// shift (BGS/CGC ≈ MV × 0.5 + 5) with industry-standard labels.

const CROSSOVER: Record<number, {
  mv:  { grade: string; label: string };
  psa: { grade: string; label: string };
  bgs: { grade: string; label: string };
  cgc: { grade: string; label: string };
}> = {
  10: { mv: { grade: "10",  label: "GEM MT" }, psa: { grade: "10",  label: "GEM MT" }, bgs: { grade: "10",  label: "Pristine" }, cgc: { grade: "10",  label: "Pristine" } },
  9:  { mv: { grade: "9",   label: "MINT" },   psa: { grade: "9",   label: "MINT" },   bgs: { grade: "9.5", label: "GEM MT" },   cgc: { grade: "9.5", label: "GEM MT" } },
  8:  { mv: { grade: "8",   label: "NM-MT" },  psa: { grade: "8",   label: "NM-MT" },  bgs: { grade: "9",   label: "MINT" },     cgc: { grade: "9",   label: "MINT" } },
  7:  { mv: { grade: "7",   label: "NM" },     psa: { grade: "7",   label: "NM" },     bgs: { grade: "8.5", label: "NM-MT+" },   cgc: { grade: "8.5", label: "NM-MT+" } },
  6:  { mv: { grade: "6",   label: "EX-MT" },  psa: { grade: "6",   label: "EX-MT" },  bgs: { grade: "8",   label: "NM-MT" },    cgc: { grade: "8",   label: "NM-MT" } },
  5:  { mv: { grade: "5",   label: "EX" },     psa: { grade: "5",   label: "EX" },     bgs: { grade: "7.5", label: "NM" },       cgc: { grade: "7.5", label: "NM" } },
  4:  { mv: { grade: "4",   label: "VG-EX" },  psa: { grade: "4",   label: "VG-EX" },  bgs: { grade: "7",   label: "EX" },       cgc: { grade: "7",   label: "EX" } },
  3:  { mv: { grade: "3",   label: "VG" },     psa: { grade: "3",   label: "VG" },     bgs: { grade: "6.5", label: "EX" },       cgc: { grade: "6.5", label: "EX" } },
  2:  { mv: { grade: "2",   label: "GOOD" },   psa: { grade: "2",   label: "GOOD" },   bgs: { grade: "6",   label: "VG-EX" },    cgc: { grade: "6",   label: "VG-EX" } },
  1:  { mv: { grade: "1",   label: "PR" },     psa: { grade: "1",   label: "PR" },     bgs: { grade: "5.5", label: "VG" },       cgc: { grade: "5.5", label: "VG" } },
};

function CrossoverTable({ grade }: { grade: number }) {
  const key = Math.max(1, Math.min(10, Math.round(grade)));
  const row = CROSSOVER[key];
  const companies: Array<{ key: string; name: string; data: { grade: string; label: string }; highlight: boolean }> = [
    { key: "mv",  name: "MintVault", data: row.mv,  highlight: true  },
    { key: "psa", name: "PSA",       data: row.psa, highlight: false },
    { key: "bgs", name: "BGS",       data: row.bgs, highlight: false },
    { key: "cgc", name: "CGC",       data: row.cgc, highlight: false },
  ];
  return (
    <div className="px-6 sm:px-8 py-8 border-t border-[#E8E4DC]" data-testid="section-crossover">
      <h3 className="text-[10px] uppercase tracking-[0.2em] text-[#D4AF37] font-bold mb-1">How does this compare?</h3>
      <p className="text-xs text-[#888888] mb-4">Approximate equivalents on the major grading scales.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-[#E8E4DC]">
              <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em] text-[#888888]">Company</th>
              <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em] text-[#888888]">Equivalent Grade</th>
              <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em] text-[#888888]">Label</th>
            </tr>
          </thead>
          <tbody>
            {companies.map(c => (
              <tr
                key={c.key}
                className={`border-b border-[#F0EDE5] ${c.highlight ? "bg-gradient-to-r from-[#D4AF37]/15 to-transparent" : ""}`}
                data-testid={`crossover-row-${c.key}`}
              >
                <td className={`py-2 px-3 ${c.highlight ? "text-[#B8960C] font-bold" : "text-[#1A1A1A]"}`}>{c.name}</td>
                <td className={`py-2 px-3 ${c.highlight ? "text-[#B8960C] font-bold" : "text-[#1A1A1A]"}`}>{c.data.grade}</td>
                <td className={`py-2 px-3 ${c.highlight ? "text-[#B8960C] font-bold" : "text-[#555555]"}`}>{c.data.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[10px] text-[#888888]">
        Equivalent grades are approximate. Different grading companies apply different standards.
      </p>
    </div>
  );
}

// ── Value calculator ───────────────────────────────────────────────────────
// Live calc — no submit. Multiplier follows the rubric Cornelius supplied;
// fee follows the service dropdown. Grade is pre-filled from the AI result
// but editable. All client-side.

const GRADING_FEES = { mintvault: 25, psa: 22, cgc: 15 } as const;
type Service = keyof typeof GRADING_FEES;

function gradeMultiplier(grade: number): number {
  if (grade >= 10) return 3;
  if (grade >= 9)  return 2;
  if (grade >= 8)  return 1.4;
  if (grade >= 7)  return 1.1;
  return 1;
}

function ValueCalculator({ initialGrade }: { initialGrade: number }) {
  const [rawValue, setRawValue] = useState<string>("");
  const [service, setService] = useState<Service>("mintvault");
  const [grade, setGrade] = useState<number>(initialGrade);

  // Reset grade if a new AI result comes in with a different overall.
  useEffect(() => { setGrade(initialGrade); }, [initialGrade]);

  const rawNum = parseFloat(rawValue);
  const hasRaw = Number.isFinite(rawNum) && rawNum > 0;
  const fee = GRADING_FEES[service];
  const mult = gradeMultiplier(grade);
  const expected = hasRaw ? rawNum * mult : 0;
  const net = hasRaw ? expected - rawNum - fee : 0;
  const worthIt = hasRaw && net > 0;

  const fmt = (n: number) => `£${n.toFixed(2)}`;

  return (
    <div className="px-6 sm:px-8 py-8 border-t border-[#E8E4DC] bg-[#FAFAF7]" data-testid="section-value-calc">
      <h3 className="text-[10px] uppercase tracking-[0.2em] text-[#D4AF37] font-bold mb-1">Is it worth grading?</h3>
      <p className="text-xs text-[#888888] mb-5">
        Enter your raw card value below. Calculation updates live.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[#888888] block mb-1.5">Raw card value</span>
          <div className="flex items-center border border-[#E8E4DC] rounded-lg overflow-hidden focus-within:border-[#D4AF37]">
            <span className="px-3 py-2 text-[#888888] text-sm bg-[#F7F7F5] border-r border-[#E8E4DC]">£</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={rawValue}
              onChange={e => setRawValue(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2 text-sm focus:outline-none"
              data-testid="input-raw-value"
            />
          </div>
        </label>

        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[#888888] block mb-1.5">Grading service</span>
          <select
            value={service}
            onChange={e => setService(e.target.value as Service)}
            className="w-full px-3 py-2 text-sm border border-[#E8E4DC] rounded-lg focus:outline-none focus:border-[#D4AF37] bg-white"
            data-testid="select-service"
          >
            <option value="mintvault">MintVault (£25)</option>
            <option value="psa">PSA (£22)</option>
            <option value="cgc">CGC (£15)</option>
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[#888888] block mb-1.5">Grade</span>
          <select
            value={grade}
            onChange={e => setGrade(parseInt(e.target.value, 10))}
            className="w-full px-3 py-2 text-sm border border-[#E8E4DC] rounded-lg focus:outline-none focus:border-[#D4AF37] bg-white"
            data-testid="select-grade"
          >
            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="bg-white border border-[#E8E4DC] rounded-lg overflow-hidden">
        <dl className="divide-y divide-[#F0EDE5]">
          <div className="flex justify-between items-baseline px-4 py-2.5">
            <dt className="text-xs text-[#888888]">Grading fee</dt>
            <dd className="text-sm font-medium text-[#1A1A1A]" data-testid="text-fee">{fmt(fee)}</dd>
          </div>
          <div className="flex justify-between items-baseline px-4 py-2.5">
            <dt className="text-xs text-[#888888]">Grade premium multiplier</dt>
            <dd className="text-sm font-medium text-[#1A1A1A]" data-testid="text-mult">{mult}×</dd>
          </div>
          <div className="flex justify-between items-baseline px-4 py-2.5">
            <dt className="text-xs text-[#888888]">Expected graded value</dt>
            <dd className="text-sm font-medium text-[#1A1A1A]" data-testid="text-expected">
              {hasRaw ? fmt(expected) : "—"}
            </dd>
          </div>
          <div className="flex justify-between items-baseline px-4 py-2.5 bg-[#FAFAF7]">
            <dt className="text-xs text-[#888888] font-medium">Net gain</dt>
            <dd
              className={`text-sm font-bold ${
                !hasRaw ? "text-[#888888]" : net > 0 ? "text-emerald-700" : "text-[#1A1A1A]"
              }`}
              data-testid="text-net"
            >
              {hasRaw ? `${net >= 0 ? "+" : ""}${fmt(net)}` : "—"}
            </dd>
          </div>
        </dl>
      </div>

      {hasRaw && (
        <div
          className={`mt-5 text-center py-3 rounded-lg text-sm font-bold uppercase tracking-wider ${
            worthIt
              ? "bg-gradient-to-r from-[#D4AF37]/15 to-[#D4AF37]/5 text-[#B8960C] border border-[#D4AF37]/40"
              : "bg-[#F7F7F5] text-[#888888] border border-[#E8E4DC]"
          }`}
          data-testid="text-verdict"
        >
          {worthIt ? "Worth grading ✓" : "Not worth grading"}
        </div>
      )}
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

            <CrossoverTable grade={result.overall_grade} />
            <ValueCalculator initialGrade={result.overall_grade} />

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
