import React, { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Shield, ShieldCheck, Share2, Download, Eye, EyeOff, ChevronDown, Check, X, ExternalLink } from "lucide-react";
import VaultClubBadge from "@/components/vault-club-badge";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VaultReport {
  certId: string;
  card: {
    name: string;
    set: string;
    year: string;
    number: string;
    variant: string | null;
    language: string;
    rarity: string | null;
    manufacturer: string;
    collection: string | null;
  };
  grades: {
    overall: number | string;
    centering: number | null;
    corners: number | null;
    edges: number | null;
    surface: number | null;
    isBlackLabel: boolean;
    isNonNumeric: boolean;
    gradeLabel: string;
  };
  centering: {
    leftRight: string | null;
    topBottom: string | null;
    meetsPsaGemMt10: boolean;
    meetsBlackLabel: boolean;
  };
  defects: Array<{
    id: number;
    type: string;
    severity: string;
    x: number;
    y: number;
    description: string;
  }>;
  images: { front: string | null; back: string | null };
  ownership: Array<{
    owner: string;
    date: string;
    method: string;
    verified: boolean;
  }>;
  population: {
    thisGrade: number;
    totalGraded: number;
    distribution: Record<string, number>;
  };
  authentication: {
    nfcActive: boolean;
    nfcUid: string | null;
    qrVerified: boolean;
    certId: string;
    slabSerial: string | null;
    tamperSealIntact: boolean;
  };
  gradedAt: string | null;
  gradedBy: string;
  stolenStatus?: string | null;
  stolenReportedAt?: string | null;
  ownerVaultClubTier?: "bronze" | "silver" | "gold" | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function useScrollReveal(threshold = 0.12) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, visible };
}

function RevealSection({ children, delay = 0, className = "" }: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, visible } = useScrollReveal();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(32px)",
        transition: `opacity 0.7s cubic-bezier(0.16,1,0.3,1) ${delay}ms, transform 0.7s cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-bold uppercase tracking-[0.25em] mb-8" style={{ color: "#B8960C" }}>
      {children}
    </p>
  );
}

function GradeBar({ score }: { score: number | null }) {
  const pct = score !== null ? (score / 10) * 100 : 0;
  return (
    <div className="w-full h-1.5 rounded-full mt-2" style={{ background: "rgba(212,175,55,0.15)" }}>
      <div
        className="h-1.5 rounded-full transition-all duration-700"
        style={{ width: `${pct}%`, background: "linear-gradient(90deg,#B8960C,#D4AF37,#FFD700)" }}
      />
    </div>
  );
}

// ── Grade condition label map ─────────────────────────────────────────────────

function conditionLabel(overall: number | string, isBlackLabel: boolean, isNonNumeric: boolean, gradeLabel: string): string {
  if (isNonNumeric) return gradeLabel.toUpperCase();
  if (isBlackLabel) return "BLACK LABEL";
  const n = Number(overall);
  if (n >= 10) return "GEM MINT";
  if (n >= 9)  return "MINT";
  if (n >= 8)  return "NM-MT";
  if (n >= 7)  return "NM";
  if (n >= 6)  return "EX-MT";
  if (n >= 5)  return "EX";
  if (n >= 4)  return "VG-EX";
  if (n >= 3)  return "VG";
  if (n >= 2)  return "GOOD";
  return "POOR";
}

// ── Section 1 — Hero ──────────────────────────────────────────────────────────

function HeroSection({ report }: { report: VaultReport }) {
  const [gradeReady, setGradeReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGradeReady(true), 200);
    return () => clearTimeout(t);
  }, []);

  const overall = report.grades.overall;
  const displayGrade = report.grades.isNonNumeric ? report.grades.gradeLabel : String(overall);
  const condition = conditionLabel(overall, report.grades.isBlackLabel, report.grades.isNonNumeric, report.grades.gradeLabel);
  const isBlackLabel = report.grades.isBlackLabel;

  return (
    <section
      className="relative flex flex-col items-center justify-center min-h-[90vh] md:min-h-screen px-4 pb-12 pt-8 border-b border-[#E8E4DC]"
      style={{ background: "linear-gradient(180deg,#FAFAF8 0%,#F0EDE4 100%)" }}
    >
      {/* Ambient gold glow */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: 500, height: 500,
          background: "radial-gradient(circle,rgba(212,175,55,0.07) 0%,transparent 70%)",
          top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        }}
      />

      {/* Grade banner — sits above card image */}
      <div className="relative z-10 flex flex-col items-center text-center mb-6 mt-2">
        {/* Condition label */}
        <p
          className="text-xs font-bold uppercase tracking-[0.35em] mb-1"
          style={{
            color: isBlackLabel ? "#888888" : "#B8860B",
            opacity: gradeReady ? 1 : 0,
            transition: "opacity 0.5s ease 0.1s",
          }}
        >
          {condition}
        </p>

        {/* Grade number */}
        <p
          style={{
                        fontSize: "clamp(72px, 16vw, 112px)",
            fontWeight: 900,
            lineHeight: 1,
            color: isBlackLabel ? "#D4AF37" : "#B8860B",
            transform: gradeReady ? "scale(1)" : "scale(0.6)",
            opacity: gradeReady ? 1 : 0,
            transition: "transform 1.1s cubic-bezier(0.34,1.56,0.64,1) 0.1s, opacity 0.6s ease 0.1s",
            textShadow: gradeReady
              ? (isBlackLabel
                  ? "0 0 60px rgba(212,175,55,0.35)"
                  : "0 0 60px rgba(184,134,11,0.25)")
              : "none",
          }}
        >
          {displayGrade}
        </p>

        {/* Gold ornament divider */}
        <div
          className="flex items-center gap-3 mt-3"
          style={{
            opacity: gradeReady ? 1 : 0,
            transition: "opacity 0.6s ease 0.4s",
          }}
        >
          <div style={{ width: 48, height: 1, background: "linear-gradient(90deg, transparent, #D4AF37)" }} />
          <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#D4AF37", flexShrink: 0 }} />
          <div style={{ width: 48, height: 1, background: "linear-gradient(90deg, #D4AF37, transparent)" }} />
        </div>
      </div>

      {/* Card image */}
      <div className="relative z-10">
        {report.images.front ? (
          <img
            src={report.images.front}
            alt={report.card.name}
            className="rounded-lg"
            style={{
              maxWidth: "min(340px, 85vw)",
              width: "100%",
              boxShadow: "0 4px 32px rgba(0,0,0,0.12), 0 16px 48px rgba(212,175,55,0.1)",
            }}
          />
        ) : (
          <div
            className="rounded-lg flex items-center justify-center"
            style={{
              width: 300, height: 420,
              background: "#F5F4F0",
              border: "1px solid #E8E4DC",
            }}
          >
            <Shield size={48} style={{ color: "rgba(184,150,12,0.35)" }} />
          </div>
        )}
      </div>

      {/* Card info */}
      <div className="relative z-10 text-center mt-10 px-4 max-w-lg">
        <h1
          className="font-black leading-tight mb-2"
          style={{
                        fontSize: "clamp(28px,6vw,48px)",
            color: "#1A1A1A",
          }}
        >
          {report.card.name || "Unknown Card"}
        </h1>
        <p className="text-sm font-medium mb-6" style={{ color: "#B8960C" }}>
          {[report.card.set, report.card.year].filter(Boolean).join(" · ")}
        </p>

        {/* Verified badge */}
        <div
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest"
          style={{
            border: "1px solid rgba(184,150,12,0.4)",
            color: "#B8960C",
            background: "rgba(212,175,55,0.08)",
          }}
        >
          <Check size={12} />
          MINTVAULT VERIFIED
        </div>
      </div>

      {/* Scroll cue */}
      <div
        className="absolute bottom-6 left-1/2 -translate-x-1/2 animate-bounce"
        style={{ color: "#B8960C" }}
      >
        <ChevronDown size={20} />
      </div>
    </section>
  );
}

// ── Section 2 — Grade Breakdown ───────────────────────────────────────────────

function GradeBreakdown({ report }: { report: VaultReport }) {
  const subgrades = [
    { label: "CENTERING", score: report.grades.centering, tip: "Measures how centred the card artwork is within its borders." },
    { label: "CORNERS", score: report.grades.corners, tip: "Assesses sharpness and condition of all four corners." },
    { label: "EDGES", score: report.grades.edges, tip: "Checks for whitening, chipping, or wear along all four edges." },
    { label: "SURFACE", score: report.grades.surface, tip: "Examines scratches, print lines, stains, and gloss integrity." },
  ];

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FFFFFF" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Grade Breakdown</SectionHeading>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {subgrades.map(({ label, score, tip }, i) => (
              <RevealSection key={label} delay={i * 80}>
                <div
                  className="group relative p-4 rounded-xl"
                  style={{ background: "#FAFAF8", border: "1px solid #E8E4DC" }}
                >
                  <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: "#888" }}>
                    {label}
                  </p>
                  <p
                    className="font-black leading-none"
                    style={{
                                            fontSize: 40,
                      color: "#B8960C",
                    }}
                  >
                    {score !== null ? score : "—"}
                  </p>
                  <GradeBar score={score} />
                  {/* Tooltip */}
                  <div
                    className="absolute bottom-full left-0 mb-2 w-48 p-2 rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10"
                    style={{ background: "#1A1A1A", border: "1px solid rgba(212,175,55,0.4)", color: "#bbb" }}
                  >
                    {tip}
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 3 — Centering Blueprint ──────────────────────────────────────────

function CenteringBlueprint({ report }: { report: VaultReport }) {
  const lr = report.centering.leftRight;
  const tb = report.centering.topBottom;

  if (!lr && !tb) return null;

  const [lv, rv] = (lr || "50/50").split("/").map(Number);
  const [tv, bv] = (tb || "50/50").split("/").map(Number);

  // SVG dimensions for the card outline blueprint
  const W = 200, H = 280;
  const borderL = Math.round((lv / (lv + rv)) * 40);
  const borderR = 40 - borderL;
  const borderT = Math.round((tv / (tv + bv)) * 40);
  const borderB = 40 - borderT;

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FAFAF8" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Centering Analysis</SectionHeading>
          <div className="flex flex-col md:flex-row gap-8 items-start">
            {/* SVG Blueprint */}
            <RevealSection delay={100}>
              <div className="flex justify-center">
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  width={W}
                  height={H}
                  style={{ maxWidth: "100%", background: "#F0EDE4", borderRadius: 8, border: "1px solid #E8E4DC" }}
                >
                  {/* Outer card outline */}
                  <rect x={10} y={10} width={W - 20} height={H - 20} fill="none" stroke="rgba(212,175,55,0.15)" strokeWidth={1} />
                  {/* Inner artwork area */}
                  <rect
                    x={10 + borderL * 3.8}
                    y={10 + borderT * 5}
                    width={W - 20 - borderL * 3.8 - borderR * 3.8}
                    height={H - 20 - borderT * 5 - borderB * 5}
                    fill="rgba(212,175,55,0.03)"
                    stroke="rgba(212,175,55,0.5)"
                    strokeWidth={1}
                  />

                  {/* Dimension lines — left */}
                  <line x1={10} y1={H / 2} x2={10 + borderL * 3.8} y2={H / 2} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={10} y1={H / 2 - 6} x2={10} y2={H / 2 + 6} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={10 + borderL * 3.8} y1={H / 2 - 6} x2={10 + borderL * 3.8} y2={H / 2 + 6} stroke="#D4AF37" strokeWidth={1} />
                  <text x={10 + (borderL * 3.8) / 2} y={H / 2 - 8} textAnchor="middle" fill="#D4AF37" fontSize={9} fontFamily="monospace">{lv}</text>

                  {/* Dimension lines — right */}
                  <line x1={W - 10 - borderR * 3.8} y1={H / 2} x2={W - 10} y2={H / 2} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={W - 10 - borderR * 3.8} y1={H / 2 - 6} x2={W - 10 - borderR * 3.8} y2={H / 2 + 6} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={W - 10} y1={H / 2 - 6} x2={W - 10} y2={H / 2 + 6} stroke="#D4AF37" strokeWidth={1} />
                  <text x={W - 10 - (borderR * 3.8) / 2} y={H / 2 - 8} textAnchor="middle" fill="#D4AF37" fontSize={9} fontFamily="monospace">{rv}</text>

                  {/* Dimension lines — top */}
                  <line x1={W / 2} y1={10} x2={W / 2} y2={10 + borderT * 5} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={W / 2 - 6} y1={10} x2={W / 2 + 6} y2={10} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={W / 2 - 6} y1={10 + borderT * 5} x2={W / 2 + 6} y2={10 + borderT * 5} stroke="#D4AF37" strokeWidth={1} />
                  <text x={W / 2 + 10} y={10 + (borderT * 5) / 2 + 4} textAnchor="start" fill="#D4AF37" fontSize={9} fontFamily="monospace">{tv}</text>

                  {/* Dimension lines — bottom */}
                  <line x1={W / 2} y1={H - 10 - borderB * 5} x2={W / 2} y2={H - 10} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={W / 2 - 6} y1={H - 10 - borderB * 5} x2={W / 2 + 6} y2={H - 10 - borderB * 5} stroke="#D4AF37" strokeWidth={1} />
                  <line x1={W / 2 - 6} y1={H - 10} x2={W / 2 + 6} y2={H - 10} stroke="#D4AF37" strokeWidth={1} />
                  <text x={W / 2 + 10} y={H - 10 - (borderB * 5) / 2 + 4} textAnchor="start" fill="#D4AF37" fontSize={9} fontFamily="monospace">{bv}</text>

                  {/* Corner markers */}
                  {[[10, 10], [W - 10, 10], [10, H - 10], [W - 10, H - 10]].map(([cx, cy], i) => (
                    <circle key={i} cx={cx} cy={cy} r={2} fill="rgba(212,175,55,0.4)" />
                  ))}
                </svg>
              </div>
            </RevealSection>

            {/* Stats panel */}
            <RevealSection delay={200} className="flex-1">
              <div className="space-y-3">
                {[
                  { label: "L/R RATIO", value: lr || "—" },
                  { label: "T/B RATIO", value: tb || "—" },
                  {
                    label: "MEETS PSA GEM MT 10",
                    value: report.centering.meetsPsaGemMt10 ? "✓" : "✗",
                    color: report.centering.meetsPsaGemMt10 ? "#4ade80" : "#f87171",
                  },
                  {
                    label: "MEETS BLACK LABEL",
                    value: report.centering.meetsBlackLabel ? "✓" : "✗",
                    color: report.centering.meetsBlackLabel ? "#4ade80" : "#f87171",
                  },
                ].map(({ label, value, color }) => (
                  <div
                    key={label}
                    className="flex items-center justify-between py-3 border-b"
                    style={{ borderColor: "#E8E4DC" }}
                  >
                    <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#888" }}>{label}</span>
                    <span className="font-bold font-mono text-sm" style={{ color: color || "#B8960C" }}>{value}</span>
                  </div>
                ))}
              </div>
            </RevealSection>
          </div>
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 4 — Defect Annotations ───────────────────────────────────────────

const DEFECT_TYPE_LABELS: Record<string, string> = {
  edge_whitening: "Edge Whitening",
  corner_wear: "Corner Wear",
  surface_scratch: "Surface Scratch",
  print_line: "Print Line",
  indentation: "Indentation",
  stain: "Stain",
  fading: "Fading",
  centering_issue: "Centering Issue",
};

const SEVERITY_COLORS: Record<string, string> = {
  low: "#4ade80",
  medium: "#fbbf24",
  high: "#f87171",
};

function DefectSection({ report }: { report: VaultReport }) {
  const [showDefects, setShowDefects] = useState(false);
  const [activePin, setActivePin] = useState<number | null>(null);
  const defects = report.defects;

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FFFFFF" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Defect Analysis</SectionHeading>

          {defects.length === 0 ? (
            <div
              className="text-center py-12 px-6 rounded-2xl"
              style={{ background: "rgba(74,222,128,0.04)", border: "1px solid rgba(74,222,128,0.15)" }}
            >
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                style={{ background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)" }}
              >
                <Check size={28} style={{ color: "#4ade80" }} />
              </div>
              <p className="font-black text-xl mb-2" style={{ color: "#4ade80" }}>
                PERFECT SPECIMEN
              </p>
              <p className="text-sm" style={{ color: "#666" }}>
                No defects detected. This card is in flawless condition.
              </p>
            </div>
          ) : (
            <>
              {/* Toggle button */}
              <button
                onClick={() => setShowDefects(!showDefects)}
                className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest px-4 py-2 rounded-full mb-8 transition-all"
                style={{
                  border: `1px solid rgba(212,175,55,${showDefects ? "0.6" : "0.25"})`,
                  color: showDefects ? "#D4AF37" : "#666",
                  background: showDefects ? "rgba(212,175,55,0.08)" : "transparent",
                }}
              >
                {showDefects ? <Eye size={14} /> : <EyeOff size={14} />}
                {showDefects ? "HIDE DEFECTS" : "SHOW DEFECTS"}
              </button>

              {/* Card with defect pins */}
              {report.images.front && (
                <div className="relative inline-block mb-8 max-w-xs">
                  <img
                    src={report.images.front}
                    alt={report.card.name}
                    className="rounded-lg w-full"
                    style={{ filter: showDefects ? "none" : "none" }}
                  />
                  {showDefects && defects.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => setActivePin(activePin === d.id ? null : d.id)}
                      className="absolute flex items-center justify-center rounded-full text-xs font-black transition-transform hover:scale-110"
                      style={{
                        left: `${d.x}%`,
                        top: `${d.y}%`,
                        transform: "translate(-50%,-50%)",
                        width: 22,
                        height: 22,
                        background: SEVERITY_COLORS[d.severity] || "#D4AF37",
                        color: "#0a0a0a",
                        boxShadow: `0 0 12px ${SEVERITY_COLORS[d.severity] || "#D4AF37"}80`,
                      }}
                    >
                      {d.id}
                    </button>
                  ))}
                  {/* Active pin popup */}
                  {showDefects && activePin !== null && (() => {
                    const d = defects.find(x => x.id === activePin);
                    if (!d) return null;
                    return (
                      <div
                        className="absolute left-1/2 -translate-x-1/2 bottom-full mb-3 p-3 rounded-lg text-left w-56 z-20 shadow-lg"
                        style={{ background: "#1A1A1A", border: "1px solid rgba(212,175,55,0.4)" }}
                      >
                        <p className="text-xs font-bold mb-1" style={{ color: SEVERITY_COLORS[d.severity] || "#D4AF37" }}>
                          #{d.id} — {DEFECT_TYPE_LABELS[d.type] || d.type}
                        </p>
                        <p className="text-xs capitalize mb-1" style={{ color: "#aaa" }}>
                          Severity: <span style={{ color: SEVERITY_COLORS[d.severity] }}>{d.severity}</span>
                        </p>
                        <p className="text-xs" style={{ color: "#ccc" }}>{d.description}</p>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* Defect list */}
              {showDefects && (
                <div className="space-y-2">
                  {defects.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-start gap-3 p-3 rounded-xl"
                      style={{ background: "#FAFAF8", border: "1px solid #E8E4DC" }}
                    >
                      <div
                        className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-black"
                        style={{ background: SEVERITY_COLORS[d.severity] || "#D4AF37", color: "#0a0a0a" }}
                      >
                        {d.id}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold" style={{ color: "#1A1A1A" }}>
                          {DEFECT_TYPE_LABELS[d.type] || d.type}
                          <span className="ml-2 capitalize" style={{ color: SEVERITY_COLORS[d.severity], fontWeight: 400 }}>
                            ({d.severity})
                          </span>
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: "#666" }}>{d.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 5 — Card Details ──────────────────────────────────────────────────

function CardDetailsSection({ report }: { report: VaultReport }) {
  const rows = [
    { label: "Card Name", value: report.card.name },
    { label: "Set", value: report.card.set },
    { label: "Year", value: report.card.year },
    { label: "Card Number", value: report.card.number },
    { label: "Variant", value: report.card.variant },
    { label: "Collection", value: report.card.collection },
    { label: "Language", value: report.card.language },
    { label: "Rarity", value: report.card.rarity },
    { label: "Manufacturer / Publisher", value: report.card.manufacturer },
  ].filter(r => r.value);

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FAFAF8" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Card Details</SectionHeading>
          <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid #E8E4DC" }}>
            {rows.map(({ label, value }, i) => (
              <div
                key={label}
                className="flex items-center justify-between px-4 py-3"
                style={{
                  background: i % 2 === 0 ? "#FFFFFF" : "#FAFAF8",
                  borderBottom: i < rows.length - 1 ? "1px solid #E8E4DC" : "none",
                }}
              >
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: "#888" }}>{label}</span>
                <span className="text-sm font-medium text-right ml-4" style={{ color: "#1A1A1A" }}>{value}</span>
              </div>
            ))}
          </div>
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 5b — eBay UK Graded Market ───────────────────────────────────────

interface EbayListing {
  title: string;
  price_pence: number;
  currency: string;
  url: string;
  image_url: string | null;
  end_time: string | null;
  condition: string;
  grade: string | null;
}

interface EbayPriceData {
  averagePence: number;
  gradeAverages: Record<string, { averagePence: number; count: number }>;
  listings: EbayListing[];
  cachedAt: string;
}

function formatPence(pence: number): string {
  const pounds = pence / 100;
  return `£${pounds % 1 === 0 ? pounds.toFixed(0) : pounds.toFixed(2)}`;
}

function timeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs !== 1 ? "s" : ""} ago`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
}

function EbaySkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: "rgba(212,175,55,0.12)" }}>
      <div className="w-10 h-10 rounded flex-shrink-0 animate-pulse" style={{ background: "rgba(212,175,55,0.1)" }} />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 rounded animate-pulse" style={{ background: "rgba(212,175,55,0.1)", width: "75%" }} />
        <div className="h-2.5 rounded animate-pulse" style={{ background: "rgba(212,175,55,0.07)", width: "40%" }} />
      </div>
      <div className="w-14 h-4 rounded animate-pulse" style={{ background: "rgba(212,175,55,0.1)" }} />
    </div>
  );
}

function EbaySection({ certId }: { certId: string }) {
  const { data, isLoading } = useQuery<EbayPriceData>({
    queryKey: ["ebay-prices", certId],
    queryFn: () => apiRequest("GET", `/api/vault/${certId}/ebay-prices`).then((r) => r.json()),
    staleTime: 1000 * 60 * 60 * 24,
    retry: false,
  });

  const listings = data?.listings ?? [];
  const gradeAverages = data?.gradeAverages ?? {};
  const cachedAt = data?.cachedAt ?? null;

  // Sort grade averages: PSA 10 first, then descending by grade number
  const sortedGrades = Object.entries(gradeAverages).sort(([a], [b]) => {
    const numA = parseFloat(a.replace(/[^0-9.]/g, "")) || 0;
    const numB = parseFloat(b.replace(/[^0-9.]/g, "")) || 0;
    return numB - numA;
  });

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FFFFFF" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Graded Card Market — eBay UK</SectionHeading>

          {/* Grade-by-grade averages */}
          {!isLoading && sortedGrades.length > 0 && (
            <div className="mb-6 rounded-2xl overflow-hidden" style={{ border: "1px solid #E8E4DC" }}>
              <div className="px-4 py-2.5" style={{ background: "#FAFAF8", borderBottom: "1px solid #E8E4DC" }}>
                <p className="text-xs font-bold uppercase tracking-[0.2em]" style={{ color: "#B8960C" }}>
                  Currently asking on eBay UK
                </p>
              </div>
              {sortedGrades.map(([grade, { averagePence, count }], i) => (
                <div
                  key={grade}
                  className="flex items-center justify-between px-4 py-2.5"
                  style={{
                    borderBottom: i < sortedGrades.length - 1 ? "1px solid rgba(212,175,55,0.1)" : "none",
                    background: i % 2 === 0 ? "#FFFFFF" : "#FAFAF8",
                  }}
                >
                  <span
                    className="text-xs font-black uppercase tracking-wider px-2 py-0.5 rounded"
                    style={{
                      background: "rgba(212,175,55,0.12)",
                      color: "#B8960C",
                      border: "1px solid rgba(212,175,55,0.25)",
                    }}
                  >
                    {grade}
                  </span>
                  <div className="flex items-center gap-3">
                    <span
                      className="font-black"
                      style={{ fontSize: 20, color: "#B8960C" }}
                    >
                      {formatPence(averagePence)}
                    </span>
                    <span className="text-xs" style={{ color: "#AAA" }}>
                      {count} listing{count !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Loading skeleton */}
          {isLoading && (
            <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid #E8E4DC" }}>
              {[0, 1, 2].map((i) => <EbaySkeletonRow key={i} />)}
            </div>
          )}

          {/* Listings table */}
          {!isLoading && listings.length > 0 && (
            <div className="rounded-2xl overflow-hidden" style={{ border: "1px solid #E8E4DC" }}>
              {listings.map((listing, i) => (
                <a
                  key={i}
                  href={listing.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 py-3 transition-colors"
                  style={{
                    borderBottom: i < listings.length - 1 ? "1px solid rgba(212,175,55,0.12)" : "none",
                    background: "transparent",
                    display: "flex",
                    textDecoration: "none",
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(212,175,55,0.04)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  {/* Thumbnail */}
                  <div
                    className="flex-shrink-0 rounded overflow-hidden"
                    style={{ width: 48, height: 48, background: "#F5F4F0", border: "1px solid #E8E4DC" }}
                  >
                    {listing.image_url ? (
                      <img
                        src={listing.image_url}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Shield size={18} style={{ color: "rgba(184,150,12,0.3)" }} />
                      </div>
                    )}
                  </div>

                  {/* Title + grade pill */}
                  <div className="flex-1 min-w-0">
                    <p
                      className="text-sm font-medium leading-snug mb-1"
                      style={{
                        color: "#1A1A1A",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {listing.title}
                    </p>
                    {listing.grade && (
                      <span
                        className="inline-block text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{
                          background: "rgba(212,175,55,0.12)",
                          color: "#B8960C",
                          border: "1px solid rgba(212,175,55,0.25)",
                        }}
                      >
                        {listing.grade}
                      </span>
                    )}
                  </div>

                  {/* Price + external icon */}
                  <div className="flex-shrink-0 flex flex-col items-end gap-1 ml-2">
                    <span
                      className="font-black text-sm"
                      style={{ color: "#B8960C" }}
                    >
                      {formatPence(listing.price_pence)}
                    </span>
                    <ExternalLink size={11} style={{ color: "rgba(184,150,12,0.5)" }} />
                  </div>
                </a>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!isLoading && listings.length === 0 && (
            <div
              className="text-center py-10 px-6 rounded-2xl"
              style={{ background: "#FAFAF8", border: "1px solid #E8E4DC" }}
            >
              <p className="font-black text-sm uppercase tracking-widest mb-2" style={{ color: "#CCC" }}>
                No Graded Listings Found on eBay UK
              </p>
              <p className="text-xs" style={{ color: "#AAA" }}>
                This card may be rare, recently released, or graded copies may not currently be listed. Check back later or search eBay directly.
              </p>
            </div>
          )}

          {/* Footer */}
          {!isLoading && (
            <div className="mt-4 space-y-1">
              {cachedAt && (
                <p className="text-xs" style={{ color: "#BBBBBB" }}>
                  Last updated: {timeAgo(cachedAt)}
                </p>
              )}
              <p className="text-xs" style={{ color: "#CCCCCC" }}>
                Prices shown are based on currently active eBay UK listings of graded cards. These represent asking prices, not completed sales. Actual market value may vary.
              </p>
            </div>
          )}
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 6 — Ownership Timeline ───────────────────────────────────────────

function OwnershipSection({ report }: { report: VaultReport }) {
  const entries = report.ownership;
  const ownerTier = report.ownerVaultClubTier || null;

  // Tier-based accent colours for the section border
  const tierAccent: Record<string, string> = {
    bronze: "rgba(205,127,50,0.20)",
    silver: "rgba(192,192,192,0.25)",
    gold: "rgba(212,175,55,0.30)",
  };
  const borderStyle = ownerTier ? { borderLeft: `3px solid ${tierAccent[ownerTier]?.replace(/[\d.]+\)$/, "0.8)")}`, paddingLeft: 16 } : {};

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FFFFFF" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <div className="flex items-center gap-3 mb-6">
            <SectionHeading>Ownership History</SectionHeading>
            {ownerTier && (
              <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full border" style={{
                borderColor: ownerTier === "gold" ? "rgba(212,175,55,0.4)" : ownerTier === "silver" ? "rgba(192,192,192,0.4)" : "rgba(205,127,50,0.4)",
                background: ownerTier === "gold" ? "rgba(212,175,55,0.08)" : ownerTier === "silver" ? "rgba(192,192,192,0.08)" : "rgba(205,127,50,0.08)",
                color: ownerTier === "gold" ? "#D4AF37" : ownerTier === "silver" ? "#C0C0C0" : "#CD7F32",
              }}>
                <VaultClubBadge tier={ownerTier} size="sm" />
                {ownerTier.charAt(0).toUpperCase() + ownerTier.slice(1)} Vault Member
              </span>
            )}
          </div>
          {entries.length === 0 ? (
            <p className="text-sm" style={{ color: "#888" }}>This card has not yet been claimed.</p>
          ) : (
            <div className="relative pl-8">
              {/* Connecting line */}
              {entries.length > 1 && (
                <div
                  className="absolute left-3 top-4 bottom-4"
                  style={{ width: 2, background: "linear-gradient(180deg,#D4AF37,rgba(212,175,55,0.1))" }}
                />
              )}
              <div className="space-y-8">
                {entries.map((entry, i) => (
                  <RevealSection key={i} delay={i * 100}>
                    <div className="relative flex items-start gap-4">
                      {/* Gold circle */}
                      <div
                        className="absolute -left-8 flex items-center justify-center rounded-full font-black text-xs flex-shrink-0"
                        style={{
                          width: 28, height: 28,
                          background: i === 0 ? "linear-gradient(135deg,#B8960C,#D4AF37)" : "#FAFAF8",
                          border: "2px solid #D4AF37",
                          color: i === 0 ? "#1A1400" : "#B8960C",
                                                  }}
                      >
                        {i + 1}
                      </div>
                      {/* Content */}
                      <div
                        className="flex-1 rounded-xl p-4"
                        style={{
                          background: "#FAFAF8",
                          border: i === 0 && ownerTier === "gold"
                            ? "2px solid rgba(212,175,55,0.35)"
                            : i === 0 && ownerTier === "silver"
                            ? "1.5px solid rgba(192,192,192,0.35)"
                            : i === 0 && ownerTier === "bronze"
                            ? "1px solid rgba(205,127,50,0.25)"
                            : "1px solid #E8E4DC",
                        }}
                      >
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-sm" style={{ color: "#1A1A1A" }}>{entry.owner}</p>
                            {i === 0 && ownerTier && <VaultClubBadge tier={ownerTier} size="sm" />}
                          </div>
                          <div className="flex items-center gap-1 text-xs" style={{ color: "#4ade80" }}>
                            <Check size={10} />
                            VERIFIED
                          </div>
                        </div>
                        <p className="text-xs mt-1" style={{ color: "#B8960C" }}>{entry.method}</p>
                        <p className="text-xs mt-1" style={{ color: "#888" }}>
                          {entry.date ? new Date(entry.date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : ""}
                        </p>
                      </div>
                    </div>
                  </RevealSection>
                ))}
              </div>
            </div>
          )}
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 7 — Population Data ───────────────────────────────────────────────

function PopulationSection({ report }: { report: VaultReport }) {
  const { population, grades } = report;
  const overallNum = typeof grades.overall === "number" ? grades.overall : null;

  const gradeKeys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  const maxCount = Math.max(...gradeKeys.map(k => population.distribution[k] || 0), 1);

  if (population.totalGraded === 0) return null;

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FAFAF8" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Population Report</SectionHeading>
          <div className="mb-8">
            <p
              className="font-black leading-none mb-2"
              style={{
                                fontSize: "clamp(36px,8vw,64px)",
                color: "#B8960C",
              }}
            >
              {population.thisGrade} <span className="text-2xl md:text-3xl" style={{ color: "#888" }}>of {population.totalGraded}</span>
            </p>
            <p className="text-sm" style={{ color: "#666" }}>graded at this level for this card</p>
          </div>

          {/* Bar chart */}
          <div className="flex items-end gap-1 md:gap-2 h-32 mb-3">
            {gradeKeys.map((k) => {
              const count = population.distribution[k] || 0;
              const isThis = overallNum !== null && String(Math.round(overallNum)) === k;
              const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
              return (
                <div key={k} className="flex-1 flex flex-col items-center justify-end gap-1 h-full">
                  <div
                    className="w-full rounded-t transition-all duration-700"
                    style={{
                      height: `${Math.max(pct, count > 0 ? 4 : 0)}%`,
                      background: isThis
                        ? "linear-gradient(180deg,#FFD700,#D4AF37)"
                        : "rgba(212,175,55,0.2)",
                      boxShadow: isThis ? "0 0 12px rgba(212,175,55,0.4)" : "none",
                    }}
                  />
                  <span className="text-[9px] md:text-xs" style={{ color: isThis ? "#B8960C" : "#AAAAAA" }}>
                    {k}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="text-xs" style={{ color: "#AAAAAA" }}>
            Updated live from MintVault registry · Showing {report.card.name || "this card"} by grade
          </p>
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 8 — Authentication ────────────────────────────────────────────────

function AuthenticationSection({ report }: { report: VaultReport }) {
  const auth = report.authentication;
  const checks = [
    { label: "VaultLock NFC", value: auth.nfcActive ? "Active" : "Not Registered", ok: auth.nfcActive },
    { label: "VaultLink QR", value: "Verified", ok: true },
    { label: "Certificate ID", value: auth.certId, ok: true },
    { label: "MintSeal", value: auth.tamperSealIntact ? "Intact" : "Unknown", ok: auth.tamperSealIntact },
    ...(auth.slabSerial ? [{ label: "Slab Serial", value: auth.slabSerial, ok: true }] : []),
  ];

  return (
    <section className="px-4 py-16 md:py-24 border-b border-[#E8E4DC]" style={{ background: "#FFFFFF" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Authentication</SectionHeading>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {checks.map(({ label, value, ok }, i) => (
              <RevealSection key={label} delay={i * 60}>
                <div
                  className="flex items-center justify-between p-4 rounded-xl"
                  style={{
                    background: "#FAFAF8",
                    border: `1px solid ${ok ? "rgba(74,222,128,0.35)" : "rgba(248,113,113,0.35)"}`,
                  }}
                >
                  <div>
                    <p className="text-xs font-bold uppercase tracking-wider" style={{ color: "#888" }}>{label}</p>
                    <p className="text-sm font-medium mt-0.5 font-mono" style={{ color: ok ? "#1A1A1A" : "#888" }}>{value}</p>
                  </div>
                  <div
                    className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center"
                    style={{ background: ok ? "rgba(74,222,128,0.15)" : "rgba(248,113,113,0.15)" }}
                  >
                    {ok
                      ? <Check size={12} style={{ color: "#4ade80" }} />
                      : <X size={12} style={{ color: "#f87171" }} />
                    }
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </RevealSection>
      </div>
    </section>
  );
}

// ── Section 9 — Share & Download ─────────────────────────────────────────────

function StolenReportModal({ certId, onClose }: { certId: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/stolen/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ certId, reporterName: name, reporterEmail: email, description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setDone(true);
    } catch (err: any) {
      setError(err.message || "Failed to submit report");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="relative max-w-md w-full rounded-2xl p-6" style={{ background: "#FAFAF8", border: "1px solid #E8E4DC" }} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 text-[#AAAAAA] hover:text-[#1A1A1A]">
          <X size={18} />
        </button>
        {done ? (
          <div className="text-center py-4">
            <p className="font-bold text-[#1A1A1A] text-lg mb-2">Report Submitted</p>
            <p className="text-sm text-[#666666]">Check your inbox — we've sent a verification link. Click it to confirm and flag this certificate.</p>
            <button onClick={onClose} className="mt-6 text-sm font-bold text-[#B8960C] border border-[#B8960C] rounded-lg px-6 py-2 hover:bg-[#B8960C]/5 transition-colors">Close</button>
          </div>
        ) : (
          <>
            <h3 className="font-black text-[#1A1A1A] text-lg mb-1">Report Stolen Card</h3>
            <p className="text-xs text-[#888888] mb-4">We'll email you a verification link. Once confirmed, a warning appears on this certificate's public page.</p>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input required value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="w-full border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#B8960C]" />
              <input required type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Your email" className="w-full border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#B8960C]" />
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional: describe how it was stolen" rows={3} className="w-full border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm text-[#1A1A1A] focus:outline-none focus:border-[#B8960C] resize-none" />
              {error && <p className="text-xs text-red-600">{error}</p>}
              <button type="submit" disabled={submitting} className="w-full py-2.5 rounded-lg text-sm font-bold text-white transition-all disabled:opacity-50" style={{ background: "linear-gradient(135deg,#c0392b,#e74c3c)" }}>
                {submitting ? "Submitting…" : "Submit Report"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function ShareSection({ report }: { report: VaultReport }) {
  const [copied, setCopied] = useState(false);
  const [showStolenModal, setShowStolenModal] = useState(false);

  function handleShare() {
    const url = `https://mintvaultuk.com/vault/${report.certId}`;
    if (navigator.share) {
      navigator.share({ title: `${report.card.name} — MintVault Vault`, url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }

  return (
    <section className="px-4 py-16 md:py-24" style={{ background: "#FAFAF8" }}>
      <div className="max-w-2xl mx-auto">
        <RevealSection>
          <SectionHeading>Share & Download</SectionHeading>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleShare}
              className="flex-1 flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-sm uppercase tracking-widest transition-all"
              style={{
                background: "linear-gradient(135deg,#B8960C,#D4AF37)",
                color: "#1A1400",
              }}
            >
              <Share2 size={16} />
              {copied ? "Copied!" : "Share"}
            </button>

            <a
              href={`/api/cert/${report.certId}/report/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-sm uppercase tracking-widest transition-all"
              style={{
                border: "1px solid #B8960C",
                color: "#B8960C",
                background: "rgba(184,150,12,0.04)",
              }}
            >
              <Download size={16} />
              Download PDF
            </a>

            <button
              disabled
              className="flex-1 flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-sm uppercase tracking-widest cursor-not-allowed"
              style={{
                border: "1px solid #E8E4DC",
                color: "#BBBBBB",
                background: "transparent",
              }}
            >
              <Shield size={16} />
              View Slab
            </button>
          </div>

          {report.stolenStatus !== "reported_stolen" && (
            <div className="mt-6 text-center">
              <button
                onClick={() => setShowStolenModal(true)}
                className="text-xs text-[#AAAAAA] hover:text-red-600 transition-colors underline underline-offset-2"
              >
                Report this card as stolen
              </button>
            </div>
          )}
        </RevealSection>
      </div>
      {showStolenModal && <StolenReportModal certId={report.certId} onClose={() => setShowStolenModal(false)} />}
    </section>
  );
}

// ── Loading/Error states ──────────────────────────────────────────────────────

function VaultLoading() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center"
      style={{ background: "#FAFAF8" }}
    >
      <div
        className="w-12 h-12 rounded-full border-2 border-t-transparent animate-spin mb-4"
        style={{ borderColor: "#B8960C", borderTopColor: "transparent" }}
      />
      <p className="text-xs font-bold uppercase tracking-widest" style={{ color: "#B8960C" }}>
        Loading Vault
      </p>
    </div>
  );
}

function VaultError({ certId }: { certId: string }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-4 text-center"
      style={{ background: "#FAFAF8" }}
    >
      <div className="mb-6" style={{ color: "rgba(184,150,12,0.35)" }}>
        <Shield size={56} />
      </div>
      <p
        className="font-black text-2xl mb-3"
        style={{ color: "#1A1A1A" }}
      >
        Vault Not Found
      </p>
      <p className="text-sm mb-2" style={{ color: "#666" }}>
        No certificate found for <span className="font-mono" style={{ color: "#888" }}>{certId}</span>
      </p>
      <p className="text-xs" style={{ color: "#AAAAAA" }}>
        Verify the cert ID and try again, or visit{" "}
        <a href="/cert" style={{ color: "#B8960C" }}>Certificate Lookup</a>
      </p>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function VaultReportPage() {
  const params = useParams<{ certId: string }>();
  const certId = params.certId || "";

  const heroRef = useRef<HTMLDivElement>(null);

  const { data: report, isLoading, isError } = useQuery<VaultReport>({
    queryKey: ["/api/vault", certId],
    queryFn: () => apiRequest("GET", `/api/vault/${encodeURIComponent(certId)}`).then(r => r.json()),
    enabled: !!certId,
    retry: false,
  });


  if (isLoading) return <VaultLoading />;
  if (isError || !report) return <VaultError certId={certId} />;

  // Tier-based outer border for Gold members
  const ownerTier = report.ownerVaultClubTier || null;
  const outerStyle: React.CSSProperties = {
    background: "#FAFAF8", minHeight: "100vh", color: "#1A1A1A",
    ...(ownerTier === "gold" ? { outline: "2px solid rgba(212,175,55,0.35)", outlineOffset: -2 } : {}),
  };

  return (
    <div style={outerStyle}>
      {/* Stolen card banner */}
      {report.stolenStatus === "reported_stolen" && (
        <div className="w-full bg-red-600 text-white text-center py-3 px-4 flex items-center justify-center gap-3" role="alert">
          <svg xmlns="http://www.w3.org/2000/svg" className="shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span className="text-sm font-bold tracking-wide">
            ⚠ This card has been reported stolen. If you have seen it for sale, please contact us at mintvaultuk@gmail.com.
          </span>
        </div>
      )}
      {/* Sections */}
      <div ref={heroRef}>
        <HeroSection report={report} />
      </div>

      <GradeBreakdown report={report} />
      <CenteringBlueprint report={report} />
      <DefectSection report={report} />
      <CardDetailsSection report={report} />
      <EbaySection certId={certId} />
      <OwnershipSection report={report} />
      <PopulationSection report={report} />
      <AuthenticationSection report={report} />
      <ShareSection report={report} />

      {/* Footer strip */}
      <div
        className="text-center py-8 px-4"
        style={{ borderTop: "1px solid #E8E4DC", background: "#FAFAF8" }}
      >
        <p className="text-xs" style={{ color: "#AAAAAA" }}>
          MintVault UK · Vault Report · {report.certId}
        </p>
      </div>
    </div>
  );
}
