import { useState, useRef, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Upload, Camera, Loader2, ChevronDown, ChevronUp, ArrowRight, AlertTriangle, RotateCcw, Star, Mail, CheckCircle, Coins } from "lucide-react";
import SeoHead from "@/components/seo-head";

const LS_FREE_KEY = "mv_est_free";
const LS_EMAIL_KEY = "mv_est_email";

interface EstimateResult {
  estimated_grade_low: number;
  estimated_grade_high: number;
  grade_label_low: string;
  grade_label_high: string;
  centering_notes: string;
  corners_notes: string;
  edges_notes: string;
  surface_notes: string;
  potential_issues: (string | { area: string; severity: string; description: string })[];
  recommendation: string;
  confidence: string;
  credits_remaining?: number;
  card_identified?: {
    name: string | null;
    set: string | null;
    year: number | null;
    rarity: string | null;
    confidence: "high" | "medium" | "low";
  };
  subgrades?: {
    centering: { score: number; confidence: string; note: string };
    corners: { score: number; confidence: string; note: string };
    edges: { score: number; confidence: string; note: string };
    surface: { score: number; confidence: string; note: string };
  };
  overall_grade_estimate?: {
    low: number;
    high: number;
    most_likely: number;
    label: string;
  };
}

const PACKAGES = [
  { id: "5",   label: "5 estimates",   price: "£2",  perUnit: "40p each" },
  { id: "15",  label: "15 estimates",  price: "£4",  perUnit: "27p each" },
  { id: "100", label: "100 estimates", price: "£10", perUnit: "10p each", best: true },
];

function gradeColor(g: number): string {
  if (g >= 9) return "text-[#D4AF37]";
  if (g >= 8) return "text-emerald-600";
  if (g >= 6) return "text-amber-600";
  return "text-red-600";
}

export default function PreGradeEstimatePage() {
  const [location] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const paymentStatus = searchParams.get("payment");
  const returnEmail = searchParams.get("email") || "";

  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [error, setError] = useState("");
  const [showAccuracy, setShowAccuracy] = useState(false);
  const [showEmailCheck, setShowEmailCheck] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Free usage tracking (localStorage)
  const [freeUsed, setFreeUsed] = useState(() => localStorage.getItem(LS_FREE_KEY) === "1");

  // Email & credits
  const [creditEmail, setCreditEmail] = useState<string>(() => returnEmail || localStorage.getItem(LS_EMAIL_KEY) || "");
  const [emailInput, setEmailInput] = useState<string>(returnEmail || localStorage.getItem(LS_EMAIL_KEY) || "");
  const [credits, setCredits] = useState<number | null>(null);
  const [checkingCredits, setCheckingCredits] = useState(false);
  const [creditError, setCreditError] = useState("");

  // Paywall purchase
  const [buyingPackage, setBuyingPackage] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);

  // On mount: if returning from successful payment, auto-load credits
  useEffect(() => {
    if (paymentStatus === "success" && returnEmail) {
      setCreditEmail(returnEmail);
      setEmailInput(returnEmail);
      localStorage.setItem(LS_EMAIL_KEY, returnEmail);
      checkCredits(returnEmail);
    }
  }, []);

  async function checkCredits(email: string) {
    if (!email.trim()) return;
    setCheckingCredits(true);
    setCreditError("");
    try {
      const res = await fetch(`/api/tools/estimate/credits?email=${encodeURIComponent(email.trim().toLowerCase())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setCredits(data.credits);
      setCreditEmail(email.trim().toLowerCase());
      localStorage.setItem(LS_EMAIL_KEY, email.trim().toLowerCase());
    } catch (e: any) {
      setCreditError(e.message);
    } finally {
      setCheckingCredits(false);
    }
  }

  async function handleBuyPackage(pkg: string) {
    if (!creditEmail && !emailInput.trim()) {
      setCreditError("Enter your email first");
      return;
    }
    const email = creditEmail || emailInput.trim();
    setBuyingPackage(true);
    setCreditError("");
    try {
      const res = await fetch("/api/tools/estimate/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, package: pkg }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      window.location.href = data.url;
    } catch (e: any) {
      setCreditError(e.message);
      setBuyingPackage(false);
    }
  }

  function handleFile(f: File) {
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setResult(null);
    setError("");
  }

  async function getEstimate(usePaid = false) {
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("image", file);
      if (usePaid && creditEmail) fd.append("email", creditEmail);
      const res = await fetch("/api/tools/estimate", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Estimate failed");
      setResult(data);
      if (!usePaid) {
        // Mark free estimate used
        localStorage.setItem(LS_FREE_KEY, "1");
        setFreeUsed(true);
      }
      if (data.credits_remaining !== undefined) {
        setCredits(data.credits_remaining);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError("");
    setShowAccuracy(false);
  }

  const confidenceBadge: Record<string, string> = {
    high:   "bg-emerald-100 text-emerald-700 border-emerald-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low:    "bg-red-100 text-red-700 border-red-200",
  };

  const hasPaidCredits = credits !== null && credits > 0;
  const canRunFree = !freeUsed;
  const canRunPaid = hasPaidCredits;
  const needsPaywall = freeUsed && !canRunPaid && !result;

  return (
    <>
      <SeoHead
        title="AI Pre-Grade Checker — Card Condition Report | MintVault"
        description="Upload a photo of your trading card and get an AI-assisted grade estimate. Check if your card is worth professional grading before you submit."
        canonical="/tools/estimate"
      />

      <div className="max-w-2xl mx-auto px-4 py-12 space-y-8">

        {/* Payment success banner */}
        {paymentStatus === "success" && (
          <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-2xl px-5 py-4">
            <CheckCircle className="text-emerald-500 shrink-0" size={20} />
            <div>
              <p className="text-emerald-800 font-semibold text-sm">Payment successful!</p>
              <p className="text-emerald-700 text-xs">Your credits have been added. Ready to estimate.</p>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="text-center space-y-3">
          <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">AI-Powered Tool</p>
          <h1 className="text-3xl font-sans font-black text-[#1A1A1A] tracking-tight">AI Pre-Grade Checker</h1>
          <p className="text-[#666666] text-base">Upload a photo of your card and get an AI-assisted condition breakdown — subgrades, card identity, and a grade range.</p>
          {!freeUsed && (
            <p className="text-[#D4AF37] text-xs font-medium">First estimate is free — no account needed.</p>
          )}
        </div>

        {/* Credits bar (when credits loaded) */}
        {credits !== null && (
          <div className="flex items-center justify-between bg-[#FAFAF8] border border-[#D4AF37]/30 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <Coins size={16} className="text-[#D4AF37]" />
              <span className="text-[#1A1A1A] text-sm font-semibold">{credits} estimate{credits !== 1 ? "s" : ""} remaining</span>
            </div>
            <button
              onClick={() => { setCredits(null); setCreditEmail(""); setEmailInput(""); localStorage.removeItem(LS_EMAIL_KEY); }}
              className="text-[#999999] text-xs hover:text-[#666666] transition-colors"
            >
              Switch account
            </button>
          </div>
        )}

        {/* Upload panel */}
        <div className="space-y-4">
          {!preview ? (
            <div
              className="relative bg-white rounded-2xl border border-[#E8E4DC] shadow-sm overflow-hidden"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("ring-2", "ring-[#D4AF37]"); }}
              onDragLeave={e => { e.currentTarget.classList.remove("ring-2", "ring-[#D4AF37]"); }}
              onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove("ring-2", "ring-[#D4AF37]"); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            >
              <div className="px-8 py-10 text-center">
                <div className="mx-auto w-16 h-16 rounded-full bg-[#D4AF37]/10 flex items-center justify-center mb-4">
                  <Upload size={28} className="text-[#D4AF37]" />
                </div>
                <h3 className="text-xl font-bold text-[#1A1A1A] mb-2">Upload your card</h3>
                <p className="text-sm text-[#555555] mb-6">Get an instant AI grading report in ~10 seconds</p>

                <div className="flex flex-col sm:flex-row gap-2 justify-center max-w-md mx-auto">
                  <button type="button" onClick={() => cameraRef.current?.click()}
                    className="flex-1 bg-[#D4AF37] hover:bg-[#B8960C] text-[#1A1400] font-bold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2">
                    <Camera size={18} /> Take Photo
                  </button>
                  <button type="button" onClick={() => inputRef.current?.click()}
                    className="flex-1 bg-white border border-[#E8E4DC] hover:border-[#D4AF37] text-[#1A1A1A] font-bold py-3 px-6 rounded-lg transition-colors flex items-center justify-center gap-2">
                    <Upload size={18} /> Choose Image
                  </button>
                </div>
              </div>

              <div className="bg-[#F7F7F5] border-t border-[#E8E4DC] px-8 py-4">
                <div className="flex flex-col sm:flex-row gap-2 sm:gap-6 text-xs text-[#555555] justify-center">
                  <span className="flex items-center gap-1.5"><CheckCircle size={13} className="text-green-600" /> Remove from sleeve</span>
                  <span className="flex items-center gap-1.5"><CheckCircle size={13} className="text-green-600" /> Good lighting, no glare</span>
                  <span className="flex items-center gap-1.5"><CheckCircle size={13} className="text-green-600" /> Card fills the frame</span>
                </div>
              </div>

              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
              <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
          ) : (
            <div className="space-y-4">
              <img src={preview} alt="Card" className="w-full rounded-2xl object-contain max-h-80 border border-[#E8E4DC]" />
              <div className="flex gap-3">
                <button type="button" onClick={reset}
                  className="flex items-center gap-2 border border-[#E8E4DC] text-[#666666] text-sm py-2.5 px-4 rounded-xl hover:bg-[#F5F5F3] transition-all">
                  <RotateCcw size={14} /> Try Another
                </button>

                {!result && canRunFree && (
                  <button type="button" onClick={() => getEstimate(false)} disabled={loading}
                    className="gold-shimmer flex-1 flex items-center justify-center gap-2 text-sm font-bold py-2.5 rounded-xl disabled:opacity-60">
                    {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                    {loading ? "Analysing your card…" : "Get Free Estimate"}
                  </button>
                )}

                {!result && !canRunFree && canRunPaid && (
                  <button type="button" onClick={() => getEstimate(true)} disabled={loading}
                    className="gold-shimmer flex-1 flex items-center justify-center gap-2 text-sm font-bold py-2.5 rounded-xl disabled:opacity-60">
                    {loading ? <Loader2 size={16} className="animate-spin" /> : null}
                    {loading ? "Analysing your card…" : `Use 1 Credit (${credits} left)`}
                  </button>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <AlertTriangle size={16} className="text-red-500" />
              <p className="text-red-600 text-sm">{error}</p>
            </div>
          )}
        </div>

        {/* Collapsed email credit check — only when free used + no credits loaded */}
        {freeUsed && credits === null && !showPaywall && !result && (
          <div className="text-center">
            {!showEmailCheck ? (
              <button onClick={() => setShowEmailCheck(true)}
                className="text-xs text-[#888888] hover:text-[#D4AF37] underline underline-offset-2 transition-colors">
                Already have credits? Enter your email
              </button>
            ) : (
              <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-4 max-w-md mx-auto">
                <div className="flex items-center gap-2 mb-2">
                  <Mail size={14} className="text-[#D4AF37]" />
                  <p className="text-xs font-bold text-[#1A1A1A] uppercase tracking-wider">Enter your email</p>
                </div>
                <div className="flex gap-2">
                  <input type="email" value={emailInput}
                    onChange={e => { setEmailInput(e.target.value); setCreditError(""); }}
                    onKeyDown={e => e.key === "Enter" && checkCredits(emailInput)}
                    placeholder="you@email.com"
                    className="flex-1 bg-white border border-[#E8E4DC] rounded px-3 py-2 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37]"
                  />
                  <button onClick={() => checkCredits(emailInput)} disabled={checkingCredits || !emailInput.trim()}
                    className="bg-[#D4AF37] hover:bg-[#B8960C] text-[#1A1400] text-xs font-bold uppercase tracking-wider px-4 rounded transition-colors disabled:opacity-50">
                    {checkingCredits ? <Loader2 size={14} className="animate-spin" /> : "Check"}
                  </button>
                </div>
                {creditError && <p className="text-red-500 text-xs mt-2">{creditError}</p>}
                {credits === 0 && creditEmail && (
                  <p className="text-[#888888] text-xs mt-2">No credits for {creditEmail}. <button onClick={() => setShowPaywall(true)} className="text-[#D4AF37] underline">Buy estimates</button></p>
                )}
                <button onClick={() => setShowEmailCheck(false)} className="text-[10px] text-[#888888] hover:text-[#555555] mt-2 underline">Cancel</button>
              </div>
            )}
          </div>
        )}

        {/* Paywall — shown when free used, no paid credits, file uploaded */}
        {(needsPaywall || showPaywall) && (
          <div className="border border-[#D4AF37]/40 rounded-2xl overflow-hidden">
            <div className="bg-[#141414] px-6 py-5">
              <div className="flex items-center gap-2 mb-1">
                <Star size={16} className="text-[#D4AF37]" />
                <p className="text-[#D4AF37] font-black text-sm uppercase tracking-widest">Get More Estimates</p>
              </div>
              <p className="text-[#888888] text-xs">Your free estimate has been used. Buy a pack to continue — credits never expire.</p>
            </div>

            <div className="p-5 bg-[#FAFAF8] space-y-4">
              {/* Email field */}
              {!creditEmail && (
                <div>
                  <label className="text-[#666666] text-xs font-semibold uppercase tracking-wider block mb-1.5">Your Email</label>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={emailInput}
                      onChange={e => { setEmailInput(e.target.value); setCreditError(""); }}
                      placeholder="your@email.com"
                      className="flex-1 border border-[#D4AF37]/30 rounded-lg px-3 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] focus:outline-none focus:border-[#D4AF37]/60"
                    />
                  </div>
                  <p className="text-[#AAAAAA] text-xs mt-1.5">Credits are tied to your email. Enter the same email each time to use them.</p>
                </div>
              )}
              {creditEmail && (
                <div className="flex items-center justify-between bg-white border border-[#D4AF37]/20 rounded-lg px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Mail size={13} className="text-[#D4AF37]" />
                    <span className="text-[#1A1A1A] text-sm">{creditEmail}</span>
                  </div>
                  <button onClick={() => { setCreditEmail(""); setEmailInput(""); }} className="text-[#AAAAAA] text-xs hover:text-[#666666]">Change</button>
                </div>
              )}

              {creditError && <p className="text-red-500 text-xs">{creditError}</p>}

              {/* Package options */}
              <div className="grid grid-cols-3 gap-3">
                {PACKAGES.map(pkg => (
                  <button
                    key={pkg.id}
                    onClick={() => {
                      const email = creditEmail || emailInput.trim();
                      if (!email) { setCreditError("Enter your email first"); return; }
                      if (!creditEmail) setCreditEmail(email);
                      handleBuyPackage(pkg.id);
                    }}
                    disabled={buyingPackage}
                    className={`relative flex flex-col items-center p-4 rounded-xl border transition-all text-center disabled:opacity-60 ${
                      pkg.best
                        ? "border-[#D4AF37] bg-[#FFFAE8] shadow-sm"
                        : "border-[#E8E4DC] bg-white hover:border-[#D4AF37]/50"
                    }`}
                  >
                    {pkg.best && (
                      <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-[#D4AF37] text-[#1A1400] text-[8px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full">Best value</span>
                    )}
                    <p className="text-[#1A1A1A] font-black text-xl mb-0.5">{pkg.price}</p>
                    <p className="text-[#1A1A1A] text-xs font-semibold">{pkg.label}</p>
                    <p className="text-[#AAAAAA] text-[10px] mt-0.5">{pkg.perUnit}</p>
                  </button>
                ))}
              </div>

              {buyingPackage && (
                <div className="flex items-center justify-center gap-2 py-2 text-[#666666] text-sm">
                  <Loader2 size={14} className="animate-spin" />
                  Redirecting to secure checkout…
                </div>
              )}

              <p className="text-[#AAAAAA] text-xs text-center">Secure payment via Stripe. Credits never expire and can be used for any card.</p>
            </div>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Grade estimate — reveal moment */}
            <div className="bg-[#111111] border border-[#D4AF37]/20 rounded-2xl p-8 text-center space-y-3">
              <p className="text-[#888888] text-xs uppercase tracking-widest">AI Estimated Grade</p>
              <p className={`text-7xl font-black leading-none ${gradeColor(result.estimated_grade_high)}`} style={{ textShadow: "0 0 40px rgba(212,175,55,0.3)" }}>
                {result.estimated_grade_low === result.estimated_grade_high
                  ? result.estimated_grade_high
                  : `${result.estimated_grade_low}–${result.estimated_grade_high}`}
              </p>
              <p className="text-[#AAAAAA] text-sm font-medium">
                {result.grade_label_low === result.grade_label_high
                  ? result.grade_label_high
                  : `${result.grade_label_low} to ${result.grade_label_high}`}
              </p>
              <div className="flex items-center justify-center gap-2 pt-1">
                <p className="text-[#555555] text-xs uppercase tracking-widest">AI Confidence</p>
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${confidenceBadge[result.confidence]}`}>
                  {result.confidence}
                </span>
              </div>
              <p className="text-[#555555] text-xs leading-relaxed max-w-sm mx-auto pt-1">
                AI estimate from a single photo. Professional grading uses physical inspection under magnification and may differ.
              </p>
            </div>

            {/* Card identification */}
            {result.card_identified && result.card_identified.confidence !== "low" && result.card_identified.name && (
              <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-bold text-[#D4AF37] uppercase tracking-wider mb-1">Card Identified</p>
                    <p className="text-lg font-bold text-[#1A1A1A]">{result.card_identified.name}</p>
                    <p className="text-sm text-[#555555]">
                      {[result.card_identified.set, result.card_identified.year, result.card_identified.rarity].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] uppercase text-[#888888]">Confidence</p>
                    <p className={`text-xs font-bold uppercase ${result.card_identified.confidence === "high" ? "text-green-600" : "text-amber-600"}`}>
                      {result.card_identified.confidence}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Quick breakdown with subgrade scores */}
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-2xl p-6 space-y-0">
              <h2 className="text-[#1A1A1A] font-sans font-bold tracking-tight mb-3">Quick Breakdown</h2>
              {([
                { key: "centering" as const, label: "Centering", weight: "10%", fallback: result.centering_notes },
                { key: "corners" as const,   label: "Corners",   weight: "25%", fallback: result.corners_notes },
                { key: "edges" as const,     label: "Edges",     weight: "25%", fallback: result.edges_notes },
                { key: "surface" as const,   label: "Surface",   weight: "40%", fallback: result.surface_notes },
              ]).map(({ key, label, weight, fallback }) => {
                const sub = result.subgrades?.[key];
                return (
                  <div key={key} className="flex items-start gap-4 py-3 border-b border-[#E8E4DC] last:border-0">
                    <div className="w-24 flex-shrink-0">
                      <p className="text-[10px] font-bold text-[#D4AF37] uppercase tracking-wider">{label}</p>
                      {sub ? (
                        <div className="flex items-baseline gap-1 mt-0.5">
                          <span className={`text-2xl font-black ${sub.score >= 9 ? "text-[#D4AF37]" : sub.score >= 7 ? "text-[#1A1A1A]" : "text-red-600"}`}>
                            {sub.score}
                          </span>
                          <span className="text-[9px] text-[#888888]">/10</span>
                          <span className="text-[8px] text-[#AAAAAA] ml-1">({weight})</span>
                        </div>
                      ) : (
                        <span className="text-[9px] text-[#AAAAAA]">({weight})</span>
                      )}
                    </div>
                    <p className="text-sm text-[#333333] leading-relaxed flex-1 pt-0.5">
                      {sub?.note || fallback}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* Potential issues with severity */}
            {result.potential_issues?.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 space-y-2">
                <p className="text-amber-800 font-semibold text-sm">Potential Issues Spotted</p>
                {result.potential_issues.map((issue, i) => {
                  const isStructured = typeof issue === "object" && issue !== null && "severity" in issue;
                  const severityColor = isStructured
                    ? (issue as any).severity === "major" ? "bg-red-100 text-red-700 border-red-200"
                    : (issue as any).severity === "moderate" ? "bg-amber-100 text-amber-700 border-amber-200"
                    : "bg-[#F0EEE8] text-[#555555] border-[#E8E4DC]"
                    : "";
                  return (
                    <div key={i} className="flex items-start gap-2">
                      {isStructured && (
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 mt-0.5 ${severityColor}`}>
                          {(issue as any).severity}
                        </span>
                      )}
                      <p className="text-amber-700 text-sm">
                        {isStructured ? (
                          <><strong>{(issue as any).area}:</strong> {(issue as any).description}</>
                        ) : (
                          `· ${issue}`
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Recommendation */}
            {result.recommendation && (
              <p className="text-[#555555] text-sm leading-relaxed italic">"{result.recommendation}"</p>
            )}

            {/* How accurate? */}
            <div className="border border-[#E8E4DC] rounded-xl overflow-hidden">
              <button
                type="button" onClick={() => setShowAccuracy(v => !v)}
                className="w-full flex items-center justify-between px-4 py-3 text-[#666666] text-sm hover:bg-[#F5F5F3] transition-all"
              >
                How accurate is this estimate?
                {showAccuracy ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
              {showAccuracy && (
                <div className="px-4 pb-4 text-[#666666] text-sm leading-relaxed space-y-2 bg-[#FAFAF8]">
                  <p>Pre-grading from a single phone photo is an AI-assisted first-look estimate — useful for a quick sense-check, not a definitive grade. Full grading uses a scanner, multiple image variants, and physical inspection.</p>
                  <p>Professional grading at MintVault uses a high-resolution scanner (600 DPI), 6 image variants including greyscale and high-contrast, and physical inspection under magnification. This is significantly more accurate than any photo-based estimate.</p>
                  <p>Holo cards, in particular, often have surface scratches that are invisible in straight-on photos but clearly visible under angled lighting.</p>
                </div>
              )}
            </div>

            {/* CTA + buy more */}
            {freeUsed && !hasPaidCredits && (
              <div className="border border-[#D4AF37]/30 rounded-2xl p-5 bg-[#FFFAE8] text-center space-y-3">
                <p className="text-[#B8960C] font-bold text-sm">Want to estimate more cards?</p>
                <p className="text-[#888888] text-xs">Credits start from £2 for 5 estimates.</p>
                <button onClick={() => setShowPaywall(true)} className="gold-shimmer px-6 py-2.5 rounded-xl text-sm font-bold">
                  Buy Estimates
                </button>
              </div>
            )}

            <div className="bg-gradient-to-br from-[#1A1400] to-[#2A2000] rounded-2xl p-6 text-center space-y-4">
              <p className="text-[#D4AF37] font-bold text-lg">Ready to get an official grade?</p>
              <p className="text-[#CCCCCC] text-sm">Professional grading from £19/card — includes NFC slab, ownership registry, and full Digital Grading Report.</p>
              <Link href="/submit">
                <button className="gold-shimmer flex items-center justify-center gap-2 text-sm font-bold px-8 py-3 rounded-xl mx-auto">
                  Submit Your Cards <ArrowRight size={14} />
                </button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
