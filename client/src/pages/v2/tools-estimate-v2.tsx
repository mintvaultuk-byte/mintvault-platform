import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import {
  Upload, Loader2, ArrowRight, AlertTriangle, CheckCircle,
} from "lucide-react";
import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";

// ── Types (mirror v1 response shape) ───────────────────────────────────────

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
    corners:   { score: number; confidence: string; note: string };
    edges:     { score: number; confidence: string; note: string };
    surface:   { score: number; confidence: string; note: string };
  };
  overall_grade_estimate?: {
    low: number;
    high: number;
    most_likely: number;
    label: string;
  };
}

type StateKey = "idle-empty" | "idle-previewed" | "loading" | "result" | "paywall" | "error";

// ── Constants ──────────────────────────────────────────────────────────────

const PACKS = [
  { id: "5",   credits: "5 estimates",   price: "£2",  perUnit: "40p each", featured: false },
  { id: "15",  credits: "15 estimates",  price: "£4",  perUnit: "27p each", featured: false },
  { id: "100", credits: "100 estimates", price: "£10", perUnit: "10p each", featured: true  },
];

const LOADING_STAGES = [
  "Reading image…",
  "Identifying card…",
  "Scoring subgrades…",
  "Drafting report…",
];

const TIPS = [
  { label: "Remove from sleeve",      body: "Glare from plastic confuses the AI" },
  { label: "Good lighting, no glare", body: "Even daylight works best" },
  { label: "Card fills the frame",    body: "Crop out the background" },
];

// Mono confidence-pill palette. Colours chosen to read as accents on paper backgrounds.
const CONF_COLOURS: Record<string, { fg: string; bg: string; border: string }> = {
  high:   { fg: "#1a7a3c", bg: "rgba(26, 122, 60, 0.08)",   border: "rgba(26, 122, 60, 0.35)" },
  medium: { fg: "#b8860b", bg: "rgba(184, 134, 11, 0.08)",  border: "rgba(184, 134, 11, 0.35)" },
  low:    { fg: "var(--v2-ink-mute)", bg: "rgba(107, 100, 84, 0.08)", border: "var(--v2-line)" },
};

function ConfidencePill({ value }: { value: string }) {
  const key = (value || "medium").toLowerCase();
  const c = CONF_COLOURS[key] || CONF_COLOURS.medium;
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono-v2 text-[9px] uppercase tracking-widest px-2 py-0.5 rounded border"
      style={{ color: c.fg, backgroundColor: c.bg, borderColor: c.border }}
    >
      {value}
    </span>
  );
}

function isValidEmail(s: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function ToolsEstimateV2() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<EstimateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [email, setEmail] = useState("");
  const [selectedPack, setSelectedPack] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState(0);
  const [showRestore, setShowRestore] = useState(false);
  const [restoreEmail, setRestoreEmail] = useState("");
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived state
  let stateKey: StateKey;
  if (loading)      stateKey = "loading";
  else if (error)   stateKey = "error";
  else if (result)  stateKey = "result";
  else if (showPaywall) stateKey = "paywall";
  else if (file)    stateKey = "idle-previewed";
  else              stateKey = "idle-empty";

  // ── Effects ────────────────────────────────────────────────────────────

  // Cycle loading stage text every 1500ms while loading.
  useEffect(() => {
    if (!loading) { setLoadingStage(0); return; }
    const id = setInterval(() => setLoadingStage(s => (s + 1) % LOADING_STAGES.length), 1500);
    return () => clearInterval(id);
  }, [loading]);

  // On mount: auto-load credits if email is in the URL (post-Stripe-return or stable-link).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const e = qs.get("estimate_credits") || qs.get("email");
    if (e && isValidEmail(e)) {
      setEmail(e);
      fetch(`/api/tools/estimate/credits?email=${encodeURIComponent(e.toLowerCase())}`)
        .then(r => r.json())
        .then(d => { if (typeof d.credits === "number") setCredits(d.credits); })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Revoke preview object URLs when the file changes or the page unmounts.
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  // ── Handlers ───────────────────────────────────────────────────────────

  function handleFileChoose(f: File | null) {
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setResult(null);
    setError(null);
    setShowPaywall(false);
  }

  function handleReset() {
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setResult(null);
    setError(null);
    setShowPaywall(false);
    setSelectedPack(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleGetEstimate() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setShowPaywall(false);
    try {
      const fd = new FormData();
      fd.append("image", file);
      if (email && credits !== null && credits > 0) fd.append("email", email);
      const res = await fetch("/api/tools/estimate", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.status === 402) {
        setShowPaywall(true);
        return;
      }
      if (!res.ok) {
        setError(data.error || "Estimate failed. Try again in a moment.");
        return;
      }
      setResult(data as EstimateResult);
      if (typeof data.credits_remaining === "number") setCredits(data.credits_remaining);
    } catch (e: any) {
      setError(e?.message || "Network error. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePurchasePack() {
    if (!selectedPack || !isValidEmail(email)) return;
    setCheckoutLoading(true);
    try {
      const res = await fetch("/api/tools/estimate/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          package: selectedPack,
          return_path: "/v2-tools/estimate",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || "Checkout failed");
      window.location.href = data.url;
    } catch (e: any) {
      setError(e?.message || "Checkout failed. Try again in a moment.");
      setShowPaywall(false);
      setCheckoutLoading(false);
    }
  }

  async function handleRestoreCredits() {
    if (!isValidEmail(restoreEmail)) {
      setRestoreError("Enter a valid email address.");
      return;
    }
    setRestoreLoading(true);
    setRestoreError(null);
    try {
      const r = await fetch(`/api/tools/estimate/credits?email=${encodeURIComponent(restoreEmail.trim().toLowerCase())}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed");
      if (typeof d.credits !== "number" || d.credits <= 0) {
        setRestoreError("No credits found for that email. Buy a pack above.");
        return;
      }
      setEmail(restoreEmail.trim().toLowerCase());
      setCredits(d.credits);
      setShowPaywall(false);
      setShowRestore(false);
    } catch (e: any) {
      setRestoreError(e?.message || "Couldn't reach credits API.");
    } finally {
      setRestoreLoading(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) handleFileChoose(f);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
      <HeaderV2 />

      {/* ── SECTION A: COMPACT HEADER ──────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-4xl px-6 pt-12 md:pt-20 pb-10 md:pb-12 text-center">
          <p
            className="font-mono-v2 text-[10px] md:text-xs uppercase tracking-[0.25em] mb-4"
            style={{ color: "var(--v2-gold)" }}
          >
            Pre-Grade Tool
          </p>
          <h1
            className="font-display italic font-medium leading-[0.95] mb-5"
            style={{ fontSize: "clamp(2.25rem, 5vw, 3.75rem)", color: "var(--v2-ink)" }}
          >
            Pre-grade your card.
          </h1>
          <p
            className="font-body text-base md:text-lg leading-relaxed max-w-xl mx-auto mb-5"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            Upload one photo. Get a subgrade breakdown, card identity, and a grade range in seconds.
          </p>
          <p
            className="font-mono-v2 text-[9px] md:text-[10px] uppercase tracking-wider"
            style={{ color: "var(--v2-ink-mute)" }}
          >
            First one free today &middot; No account needed &middot; From 10p per estimate
          </p>
        </div>
      </section>

      {/* ── SECTION B: TOOL PANEL ──────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper)" }}>
        <div className="mx-auto max-w-3xl px-6 pb-16 md:pb-24">
          <div
            className="relative rounded-xl p-6 md:p-10"
            style={{
              backgroundColor: "var(--v2-paper-raised)",
              border: "1px solid var(--v2-line)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            {credits !== null && (
              <span
                className="absolute top-4 right-4 font-mono-v2 text-[9px] uppercase tracking-widest px-2.5 py-1 rounded-full border"
                style={{ color: "var(--v2-gold)", borderColor: "var(--v2-gold-soft)", backgroundColor: "rgba(212,175,55,0.06)" }}
              >
                {credits} credits left
              </span>
            )}

            {/* ── B.1 IDLE-EMPTY ── */}
            {stateKey === "idle-empty" && (
              <div>
                <label
                  htmlFor="mv-file-input"
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  className="block cursor-pointer rounded-lg py-16 px-6 text-center transition-colors"
                  style={{
                    border: `2px dashed ${dragging ? "var(--v2-gold)" : "var(--v2-line)"}`,
                    backgroundColor: dragging ? "rgba(212,175,55,0.03)" : "transparent",
                  }}
                >
                  <input
                    ref={fileInputRef}
                    id="mv-file-input"
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    aria-label="Upload card photo"
                    onChange={(e) => handleFileChoose(e.target.files?.[0] ?? null)}
                  />
                  <Upload size={48} strokeWidth={1.5} style={{ color: "var(--v2-ink-mute)" }} className="mx-auto" />
                  <p
                    className="font-display italic font-medium text-2xl mt-5"
                    style={{ color: "var(--v2-ink)" }}
                  >
                    Upload a card photo
                  </p>
                  <p
                    className="font-mono-v2 text-xs uppercase tracking-wider mt-2"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Drag and drop, or click to browse
                  </p>
                </label>

                <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
                  {TIPS.map((t) => (
                    <div key={t.label} className="flex items-start gap-2.5">
                      <CheckCircle size={16} style={{ color: "var(--v2-gold)" }} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-body text-sm font-semibold" style={{ color: "var(--v2-ink)" }}>{t.label}</p>
                        <p className="font-body text-xs mt-0.5" style={{ color: "var(--v2-ink-soft)" }}>{t.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── B.2 IDLE-PREVIEWED ── */}
            {stateKey === "idle-previewed" && preview && (
              <div>
                <img
                  src={preview}
                  alt="Card preview"
                  className="w-full max-h-[400px] object-contain rounded-lg mx-auto"
                  style={{ backgroundColor: "var(--v2-paper)" }}
                />
                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="inline-flex items-center gap-2 font-body text-sm font-semibold px-5 py-2.5 rounded-full border transition-all hover:scale-[1.02]"
                    style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
                  >
                    Replace photo
                  </button>
                  <button
                    type="button"
                    onClick={handleGetEstimate}
                    className="inline-flex items-center gap-2 font-body text-sm font-semibold px-5 py-2.5 rounded-full transition-all hover:scale-[1.03]"
                    style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
                  >
                    Get estimate <ArrowRight size={14} />
                  </button>
                </div>
                <p
                  className="font-mono-v2 text-[10px] uppercase tracking-widest mt-4 text-center"
                  style={{ color: "var(--v2-ink-mute)" }}
                >
                  {credits !== null && credits > 0
                    ? `Uses 1 of ${credits} credits`
                    : email
                      ? ""
                      : "Uses today's free estimate"}
                </p>
              </div>
            )}

            {/* ── B.3 LOADING ── */}
            {stateKey === "loading" && (
              <div className="py-16 text-center" role="status" aria-live="polite">
                <Loader2 size={48} className="mx-auto animate-spin" style={{ color: "var(--v2-gold)" }} />
                <p
                  className="font-display italic text-xl mt-6 min-h-[2rem]"
                  style={{ color: "var(--v2-ink)" }}
                >
                  {LOADING_STAGES[loadingStage]}
                </p>
                <p className="font-body text-sm mt-2" style={{ color: "var(--v2-ink-mute)" }}>
                  Usually back in seconds.
                </p>
              </div>
            )}

            {/* ── B.4 RESULT ── */}
            {stateKey === "result" && result && (
              <div role="region" aria-label="Estimate result">
                {/* Overall grade */}
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                  <p
                    className="font-display italic font-medium leading-none"
                    style={{
                      fontSize: "clamp(48px, 7vw, 84px)",
                      color: "var(--v2-ink)",
                    }}
                  >
                    {(result.overall_grade_estimate?.low ?? result.estimated_grade_low)}
                    <span style={{ color: "var(--v2-ink-mute)" }}>&ndash;</span>
                    {(result.overall_grade_estimate?.high ?? result.estimated_grade_high)}
                  </p>
                  <div className="md:text-right">
                    <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                      Overall
                    </p>
                    <p
                      className="font-display italic text-xl mt-1"
                      style={{ color: "var(--v2-ink)" }}
                    >
                      {result.overall_grade_estimate?.label ?? result.grade_label_high ?? "—"}
                    </p>
                    {result.overall_grade_estimate?.most_likely !== undefined && (
                      <p className="font-mono-v2 text-[10px] uppercase tracking-widest mt-1" style={{ color: "var(--v2-ink-mute)" }}>
                        Most likely: {result.overall_grade_estimate.most_likely}
                      </p>
                    )}
                    <div className="mt-2 inline-block">
                      <ConfidencePill value={result.confidence || "medium"} />
                    </div>
                  </div>
                </div>

                {/* Card ID */}
                {result.card_identified?.name && (
                  <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--v2-line-soft)" }}>
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                      <div>
                        <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                          Identified
                        </p>
                        <p className="font-display italic text-xl mt-1" style={{ color: "var(--v2-ink)" }}>
                          {result.card_identified.name}
                        </p>
                        <p className="font-body text-sm mt-1" style={{ color: "var(--v2-ink-soft)" }}>
                          {[
                            result.card_identified.set,
                            result.card_identified.year,
                            result.card_identified.rarity,
                          ].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <div className="md:text-right">
                        <ConfidencePill value={result.card_identified.confidence} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Subgrades */}
                <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--v2-line-soft)" }}>
                  <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                    Subgrades
                  </p>
                  <div className="mt-4">
                    {(["centering", "corners", "edges", "surface"] as const).map((key, i) => {
                      const sg = result.subgrades?.[key];
                      const fallback = result[`${key}_notes` as const];
                      const score = sg?.score;
                      const confidence = sg?.confidence || result.confidence || "medium";
                      const note = sg?.note || fallback || "";
                      return (
                        <div
                          key={key}
                          className="grid grid-cols-[1fr_auto] md:grid-cols-[140px_100px_120px_1fr] gap-x-4 gap-y-1 py-3"
                          style={{ borderTop: i === 0 ? undefined : "1px solid var(--v2-line-soft)" }}
                        >
                          <p className="font-mono-v2 text-sm uppercase tracking-wider" style={{ color: "var(--v2-ink)" }}>
                            {key}
                          </p>
                          <p
                            className="font-display font-semibold leading-none text-right md:text-left"
                            style={{
                              fontSize: "clamp(1.75rem, 3vw, 2rem)",
                              color: (score ?? 0) >= 9 ? "var(--v2-gold)" : "var(--v2-ink)",
                            }}
                          >
                            {score ?? "—"}
                          </p>
                          <div className="hidden md:block">
                            <ConfidencePill value={confidence} />
                          </div>
                          <p className="font-body text-xs col-span-2 md:col-span-1" style={{ color: "var(--v2-ink-soft)" }}>
                            {note}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Potential issues */}
                {result.potential_issues && result.potential_issues.length > 0 && (
                  <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--v2-line-soft)" }}>
                    <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                      Flagged
                    </p>
                    <ul className="mt-3 space-y-2">
                      {result.potential_issues.map((issue, i) => {
                        const text = typeof issue === "string" ? issue : (issue.description || issue.area || "");
                        return (
                          <li key={i} className="flex items-start gap-2">
                            <AlertTriangle size={14} style={{ color: "var(--v2-ink-mute)" }} className="mt-1 shrink-0" />
                            <span className="font-body text-sm" style={{ color: "var(--v2-ink-soft)" }}>{text}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {/* Recommendation */}
                {result.recommendation && (
                  <div
                    className="mt-8 p-4 rounded-lg"
                    style={{
                      backgroundColor: "rgba(212,175,55,0.05)",
                      border: "1px solid var(--v2-gold-soft)",
                    }}
                  >
                    <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-gold)" }}>
                      Recommendation
                    </p>
                    <p className="font-body text-sm mt-1" style={{ color: "var(--v2-ink)" }}>
                      {result.recommendation}
                    </p>
                  </div>
                )}

                {/* Actions */}
                <div className="mt-8 flex flex-wrap gap-3 justify-between items-center">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="inline-flex items-center gap-2 font-body text-sm font-semibold px-5 py-2.5 rounded-full border transition-all hover:scale-[1.02]"
                    style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
                  >
                    Estimate another card
                  </button>
                  <Link
                    href="/v2-pricing"
                    className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-5 py-2.5 rounded-full transition-all hover:scale-[1.03]"
                    style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
                  >
                    See full grading pricing <ArrowRight size={14} />
                  </Link>
                </div>
              </div>
            )}

            {/* ── B.5 PAYWALL ── */}
            {stateKey === "paywall" && (
              <div>
                <div
                  className="inline-flex items-center gap-2 px-3 py-2 rounded border text-sm"
                  style={{
                    backgroundColor: "rgba(212,175,55,0.08)",
                    borderColor: "var(--v2-gold-soft)",
                    color: "var(--v2-ink)",
                  }}
                >
                  <AlertTriangle size={14} style={{ color: "#b8860b" }} />
                  <span className="font-body">Free estimate used for today</span>
                </div>

                <h2
                  className="font-display italic font-medium mt-6"
                  style={{ fontSize: "clamp(1.875rem, 4vw, 2.25rem)", color: "var(--v2-ink)" }}
                >
                  Buy a credit pack to continue.
                </h2>
                <p className="font-body text-base mt-3" style={{ color: "var(--v2-ink-soft)" }}>
                  Credits never expire. Packs from &pound;2. Pay by card, no subscription.
                </p>

                <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
                  {PACKS.map((p) => {
                    const isSelected = selectedPack === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSelectedPack(p.id)}
                        className="relative p-6 rounded-xl border transition-all hover:scale-[1.02] text-left"
                        style={{
                          borderColor: p.featured
                            ? "var(--v2-gold-soft)"
                            : isSelected
                              ? "var(--v2-gold)"
                              : "var(--v2-line)",
                          backgroundColor: isSelected ? "rgba(212,175,55,0.04)" : "var(--v2-paper)",
                          borderWidth: isSelected ? "2px" : "1px",
                        }}
                      >
                        {p.featured && (
                          <span
                            className="absolute left-1/2 -translate-x-1/2 font-mono-v2 text-[9px] uppercase tracking-widest px-3 py-1 rounded whitespace-nowrap"
                            style={{ top: "-14px", backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
                          >
                            Best
                          </span>
                        )}
                        <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
                          {p.credits}
                        </p>
                        <p
                          className="font-display font-semibold text-3xl mt-2 leading-none"
                          style={{ color: p.featured ? "var(--v2-gold)" : "var(--v2-ink)" }}
                        >
                          {p.price}
                        </p>
                        <p className="font-mono-v2 text-[10px] uppercase mt-1" style={{ color: "var(--v2-ink-soft)" }}>
                          {p.perUnit}
                        </p>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-6">
                  <label
                    htmlFor="mv-email-input"
                    className="font-mono-v2 text-[10px] uppercase tracking-widest"
                    style={{ color: "var(--v2-ink-mute)" }}
                  >
                    Email
                  </label>
                  <input
                    id="mv-email-input"
                    type="email"
                    className="w-full mt-1 px-4 py-3 rounded outline-none"
                    style={{
                      border: "1px solid var(--v2-line)",
                      backgroundColor: "var(--v2-paper)",
                      color: "var(--v2-ink)",
                    }}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                  <p className="font-mono-v2 text-[10px] uppercase tracking-widest mt-2" style={{ color: "var(--v2-ink-mute)" }}>
                    We email your credits &mdash; no password, no account.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handlePurchasePack}
                  disabled={!selectedPack || !isValidEmail(email) || checkoutLoading}
                  className="mt-4 inline-flex items-center justify-center gap-2 font-body text-sm font-semibold px-6 py-3 rounded-full w-full md:w-auto transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
                >
                  {checkoutLoading && <Loader2 size={14} className="animate-spin" />}
                  {selectedPack
                    ? `Continue with ${PACKS.find(p => p.id === selectedPack)?.credits} pack`
                    : "Select a pack"}
                  {!checkoutLoading && selectedPack && <ArrowRight size={14} />}
                </button>

                <div className="mt-6 pt-4" style={{ borderTop: "1px solid var(--v2-line-soft)" }}>
                  <p className="font-body text-sm" style={{ color: "var(--v2-ink-soft)" }}>
                    Already bought credits?{" "}
                    <button
                      type="button"
                      onClick={() => setShowRestore(v => !v)}
                      className="underline"
                      style={{ color: "var(--v2-ink)" }}
                    >
                      Restore from email
                    </button>
                  </p>

                  {showRestore && (
                    <div className="mt-3 flex flex-col md:flex-row gap-2 md:items-stretch">
                      <input
                        type="email"
                        value={restoreEmail}
                        onChange={(e) => setRestoreEmail(e.target.value)}
                        placeholder="your email"
                        aria-label="Restore credits email"
                        className="flex-1 px-4 py-2.5 rounded outline-none font-body text-sm"
                        style={{
                          border: "1px solid var(--v2-line)",
                          backgroundColor: "var(--v2-paper)",
                          color: "var(--v2-ink)",
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleRestoreCredits}
                        disabled={restoreLoading || !isValidEmail(restoreEmail)}
                        className="inline-flex items-center justify-center gap-2 font-body text-sm font-semibold px-5 py-2.5 rounded-full transition-all disabled:opacity-50"
                        style={{ borderColor: "var(--v2-line)", border: "1px solid var(--v2-line)", color: "var(--v2-ink)" }}
                      >
                        {restoreLoading && <Loader2 size={14} className="animate-spin" />}
                        Check
                      </button>
                    </div>
                  )}
                  {restoreError && (
                    <p className="font-body text-xs mt-2" style={{ color: "#c44" }}>{restoreError}</p>
                  )}
                </div>
              </div>
            )}

            {/* ── B.6 ERROR ── */}
            {stateKey === "error" && (
              <div
                role="alert"
                className="p-6 rounded-lg"
                style={{ border: "1px solid #c44", backgroundColor: "#fef5f5" }}
              >
                <AlertTriangle size={24} style={{ color: "#c44" }} />
                <p
                  className="font-display italic text-xl mt-3"
                  style={{ color: "var(--v2-ink)" }}
                >
                  Something went wrong
                </p>
                <p className="font-body text-sm mt-2" style={{ color: "var(--v2-ink-soft)" }}>
                  {error}
                </p>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="mt-4 inline-flex items-center gap-2 font-body text-sm font-semibold px-5 py-2.5 rounded-full border transition-all hover:scale-[1.02]"
                  style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── SECTION C: HONEST LIMITS ────────────────────────────────── */}
      <section style={{ backgroundColor: "var(--v2-paper-raised)", borderTop: "1px solid var(--v2-line)" }}>
        <div className="mx-auto max-w-3xl px-6 py-12 md:py-16">
          <p className="font-mono-v2 text-[10px] uppercase tracking-widest" style={{ color: "var(--v2-ink-mute)" }}>
            Honesty
          </p>
          <h2
            className="font-display italic font-medium text-xl md:text-2xl mt-2"
            style={{ color: "var(--v2-ink)" }}
          >
            What this is &mdash; and what it isn&rsquo;t.
          </h2>
          <p className="font-body text-sm md:text-base mt-4 leading-relaxed" style={{ color: "var(--v2-ink-soft)" }}>
            This is an AI-assisted first-look estimate from a single photo. Full MintVault grading
            uses a high-resolution scanner, multiple image variants (greyscale, high-contrast,
            angled), and physical inspection under magnification. Treat the estimate as directional,
            not definitive. This tool does not authenticate cards or detect counterfeits.
          </p>
          <p className="font-mono-v2 text-[11px] uppercase tracking-widest mt-5 flex flex-wrap gap-x-3 gap-y-1">
            <Link href="/v2-pricing" className="hover:underline" style={{ color: "var(--v2-gold)" }}>
              See full grading pricing &rarr;
            </Link>
            <span style={{ color: "var(--v2-ink-mute)" }}>&middot;</span>
            <Link href="/v2-vault-club" className="hover:underline" style={{ color: "var(--v2-gold)" }}>
              See Vault Club &rarr;
            </Link>
          </p>
        </div>
      </section>

      <FooterV2 />
    </div>
  );
}
