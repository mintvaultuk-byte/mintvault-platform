import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import SeoHead from "@/components/seo-head";
import {
  Shield, CheckCircle2, AlertTriangle, ExternalLink, Download,
  ChevronDown, ChevronUp, Scissors, Minus, Circle, Star,
  ZoomIn, X,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface ReportData {
  certificate: {
    certId: string; cardName: string; cardGame: string; cardSet: string;
    cardYear: string; cardNumber: string; language: string; rarity: string | null;
    variant: string | null; gradedDate: string; gradedBy: string; status: string;
  };
  grade: {
    overall: number | string; label: string; labelType: string;
    isBlackLabel: boolean; explanation: string | null;
    approvedBy: string | null; approvedAt: string | null;
  };
  subgrades: { centering: number | null; corners: number | null; edges: number | null; surface: number | null };
  centering: { frontLR: string | null; frontTB: string | null; backLR: string | null; backTB: string | null };
  corners: any | null;
  edges: any | null;
  surface: { front: number | null; back: number | null } | null;
  defects: Array<{ id: number; type: string; severity: string; description: string; location: string; imageSide: string; xPercent: number; yPercent: number }>;
  authentication: { status: string; notes: string | null };
  images: { front: string | null; back: string | null; frontGreyscale: string | null; frontHighcontrast: string | null; frontEdge: string | null; frontInverted: string | null; backGreyscale: string | null; backHighcontrast: string | null; backEdge: string | null; backInverted: string | null; angled: string | null; closeup: string | null };
  population: { totalGraded: number; sameGradeCount: number; higherGradeCount: number; percentile: number };
  ownership: { status: string; nfcEnabled: boolean };
  marketValue: { estimatedLow: null; estimatedHigh: null; currency: string };
}

// ── Theme ──────────────────────────────────────────────────────────────────

function useTheme(isBlack: boolean) {
  return {
    bg:       isBlack ? "bg-[#0A0A0A]"  : "bg-[#FFFFFF]",
    text:     isBlack ? "text-white"     : "text-[#1A1A1A]",
    textSec:  isBlack ? "text-[#AAAAAA]" : "text-[#666666]",
    textMut:  isBlack ? "text-[#666666]" : "text-[#999999]",
    border:   isBlack ? "border-[#333333]" : "border-[#E8E4DC]",
    section:  isBlack ? "bg-[#141414]"  : "bg-[#FAFAF8]",
    card:     isBlack ? "bg-[#111111] border border-[#222222]" : "bg-white border border-[#E8E4DC]",
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function subgradeStyle(v: number | null): { bg: string; text: string } {
  if (v === null) return { bg: "bg-[#333333]", text: "text-[#888888]" };
  if (v >= 10)  return { bg: "bg-[#D4AF37]", text: "text-[#1A1400]" };
  if (v >= 9)   return { bg: "bg-[#22C55E]", text: "text-white" };
  if (v >= 7)   return { bg: "bg-[#EAB308]", text: "text-[#1A1A1A]" };
  if (v >= 5)   return { bg: "bg-[#F97316]", text: "text-white" };
  return { bg: "bg-[#EF4444]", text: "text-white" };
}

function cornerColor(v: number): string {
  if (v >= 9.5) return "text-[#D4AF37]";
  if (v >= 8)   return "text-[#22C55E]";
  if (v >= 6)   return "text-[#EAB308]";
  return "text-[#EF4444]";
}

function defectIcon(type: string) {
  const t = (type || "").toLowerCase();
  if (t.includes("scratch") || t.includes("holo")) return <Scissors size={14} />;
  if (t.includes("print") || t.includes("line"))   return <Minus size={14} />;
  return <Circle size={14} />;
}

const SEV_BADGE: Record<string, string> = {
  minor:       "bg-yellow-900/30 text-yellow-400 border-yellow-700/40",
  moderate:    "bg-orange-900/30 text-orange-400 border-orange-700/40",
  significant: "bg-red-900/30 text-red-400 border-red-700/40",
};

// ── Image viewer with variants + defect overlay ────────────────────────────

type ImgVariant = "original" | "greyscale" | "highcontrast";

function CardImagePanel({
  side, images, defects, showDefects, isBlack,
  onLightbox,
}: {
  side: "front" | "back";
  images: ReportData["images"];
  defects: ReportData["defects"];
  showDefects: boolean;
  isBlack: boolean;
  onLightbox: (url: string) => void;
}) {
  const [variant, setVariant] = useState<ImgVariant>("original");

  const VARIANTS: { key: ImgVariant; label: string; url: string | null }[] = [
    { key: "original",     label: "Original",    url: side === "front" ? images.front          : images.back },
    { key: "greyscale",    label: "Greyscale",   url: side === "front" ? images.frontGreyscale : images.backGreyscale },
    { key: "highcontrast", label: "Hi-Contrast", url: side === "front" ? images.frontHighcontrast : images.backHighcontrast },
  ];

  const currentUrl = VARIANTS.find(v => v.key === variant)?.url ?? images.front;
  const sideDefects = defects.filter(d => d.imageSide === side);

  if (!currentUrl) return null;

  return (
    <div className="space-y-2">
      {/* Image */}
      <div
        className="relative rounded-xl overflow-hidden cursor-zoom-in group"
        onClick={() => currentUrl && onLightbox(currentUrl)}
      >
        <img
          src={currentUrl}
          alt={`${side} card image`}
          className="w-full object-contain aspect-[5/7] transition-opacity duration-200"
        />
        {/* Defect markers */}
        {showDefects && sideDefects.map(d => (
          <div
            key={d.id}
            className="absolute w-6 h-6 rounded-full bg-red-600 border-2 border-white flex items-center justify-center text-white text-[9px] font-black pointer-events-none"
            style={{ left: `calc(${d.xPercent}% - 12px)`, top: `calc(${d.yPercent}% - 12px)` }}
          >
            {d.id}
          </div>
        ))}
        {/* Hover zoom hint */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
          <ZoomIn size={24} className="text-white drop-shadow-lg" />
        </div>
      </div>
      {/* Variant tabs */}
      <div className="flex gap-1 flex-wrap">
        {VARIANTS.filter(v => v.url).map(v => (
          <button
            key={v.key}
            type="button"
            onClick={() => setVariant(v.key)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all border ${
              variant === v.key
                ? "border-[#D4AF37] text-[#D4AF37] bg-[#D4AF37]/10"
                : "border-[#333333] text-[#888888] hover:border-[#555555]"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      <p className={`text-[10px] text-center capitalize ${isBlack ? "text-[#555555]" : "text-[#999999]"}`}>{side}</p>
    </div>
  );
}

// ── Subgrade card with expandable details ──────────────────────────────────

function SubgradeCard({
  label, value, isBlack, children,
}: {
  label: string; value: number | null; isBlack: boolean; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const style = subgradeStyle(value);
  const pct = value !== null ? (value / 10) * 100 : 0;

  return (
    <div className={`rounded-xl overflow-hidden ${isBlack ? "border border-[#222222]" : "border border-[#E8E4DC]"}`}>
      <button
        type="button"
        onClick={() => children && setOpen(!open)}
        className={`w-full p-4 text-left ${isBlack ? "bg-[#111111]" : "bg-white"} ${children ? "cursor-pointer" : "cursor-default"}`}
      >
        <div className="flex items-center justify-between mb-2">
          <p className={`text-[10px] font-bold uppercase tracking-widest ${isBlack ? "text-[#888888]" : "text-[#999999]"}`}>{label}</p>
          {children && (
            open ? <ChevronUp size={12} className="text-[#D4AF37]" /> : <ChevronDown size={12} className="text-[#888888]" />
          )}
        </div>
        <div className={`text-4xl font-black mb-2 ${style.text === "text-[#1A1400]" ? "" : style.text}`}
          style={value !== null && value >= 10 ? { color: "#D4AF37" } : {}}>
          {value !== null ? value : "—"}
        </div>
        <div className={`h-1.5 rounded-full overflow-hidden ${isBlack ? "bg-[#222222]" : "bg-[#F0EDE6]"}`}>
          <div className={`h-full rounded-full transition-all ${style.bg}`} style={{ width: `${pct}%` }} />
        </div>
      </button>
      {open && children && (
        <div className={`px-4 pb-4 border-t ${isBlack ? "border-[#222222] bg-[#0D0D0D]" : "border-[#F0EDE6] bg-[#FAFAF8]"}`}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="min-h-screen bg-[#FAFAF8] px-4 py-10">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="h-6 bg-[#E8E4DC] rounded animate-pulse w-1/3 mx-auto" />
        <div className="h-4 bg-[#E8E4DC] rounded animate-pulse w-1/2 mx-auto" />
        <div className="h-48 bg-[#E8E4DC] rounded-xl animate-pulse" />
        <div className="grid grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-28 bg-[#E8E4DC] rounded-xl animate-pulse" />)}
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function GradingReportPage() {
  const params = useParams<{ id: string }>();
  const certId = params.id;
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [showDefects, setShowDefects] = useState(true);

  const { data: report, isLoading, error } = useQuery<ReportData>({
    queryKey: [`/api/cert/${certId}/report`],
    queryFn: async () => {
      const res = await fetch(`/api/cert/${certId}/report`);
      if (!res.ok) throw new Error(await res.json().then(d => d.error).catch(() => "Not found"));
      return res.json();
    },
    retry: false,
  });

  if (isLoading) return <Skeleton />;

  if (error || !report) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4">
        <div className="text-center">
          <AlertTriangle size={32} className="text-[#D4AF37] mx-auto mb-4" />
          <h1 className="text-[#1A1A1A] font-bold text-lg mb-2">Report Not Found</h1>
          <p className="text-[#666666] text-sm mb-4">
            {(error as any)?.message === "Grading report not yet available for this certificate"
              ? "This certificate has not yet been graded. Check back soon."
              : "This certificate does not have a public grading report."}
          </p>
          <Link href="/" className="text-[#D4AF37] text-sm hover:underline">← Back to MintVault</Link>
        </div>
      </div>
    );
  }

  const { certificate: cert, grade, subgrades, centering, corners, edges, surface, defects, authentication, images, population, ownership, marketValue } = report;
  const isBlack = grade.isBlackLabel;
  const t = useTheme(isBlack);

  const approvedDateFmt = grade.approvedAt
    ? new Date(grade.approvedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    : null;
  const gradedDateFmt = cert.gradedDate
    ? new Date(cert.gradedDate).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    : "—";

  return (
    <div className={`${t.bg} ${t.text} min-h-screen print:bg-white print:text-black`}>
      <SeoHead
        title={`${cert.cardName} — ${grade.overall} ${grade.label} | Digital Grading Report | MintVault`}
        description={`${cert.cardName} from ${cert.cardSet} (${cert.cardYear}) graded ${grade.overall} ${grade.label} by MintVault UK. View the full Digital Grading Report with high-res images, subgrades, and defect analysis.`}
        canonical={`https://mintvaultuk.com/cert/${cert.certId}/report`}
        ogImage={images.front || undefined}
      />

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 print:hidden"
          onClick={() => setLightboxUrl(null)}
        >
          <button className="absolute top-4 right-4 text-white hover:text-[#D4AF37]" onClick={() => setLightboxUrl(null)}>
            <X size={28} />
          </button>
          <img src={lightboxUrl} alt="Card image" className="max-h-[90vh] max-w-[90vw] object-contain rounded-xl" onClick={e => e.stopPropagation()} />
        </div>
      )}

      <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">

        {/* ── Header ── */}
        <div className="text-center space-y-1 reveal-on-scroll">
          <p className="text-[#D4AF37] text-[10px] font-bold uppercase tracking-[0.2em]">MintVault UK</p>
          <p className={`text-xs font-bold uppercase tracking-widest ${t.textSec}`}>Digital Grading Report</p>
          <p className={`font-mono font-bold text-lg ${t.text}`}>{cert.certId}</p>
          <div className={`mt-3 h-px ${isBlack ? "bg-[#D4AF37]/20" : "bg-[#D4AF37]/30"}`} />
        </div>

        {/* Download + defect controls */}
        <div className="flex items-center justify-between flex-wrap gap-2 print:hidden reveal-on-scroll">
          <a
            href={`/api/cert/${cert.certId}/report/pdf`}
            download
            className="flex items-center gap-2 bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-[#D4AF37] px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest hover:bg-[#D4AF37]/20 transition-all"
          >
            <Download size={14} />
            Download PDF
          </a>
          {defects.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDefects(!showDefects)}
              className={`text-xs border px-3 py-2 rounded-lg transition-all ${
                showDefects
                  ? `border-[#D4AF37]/40 text-[#D4AF37]`
                  : `${isBlack ? "border-[#333333] text-[#888888]" : "border-[#E8E4DC] text-[#999999]"}`
              }`}
            >
              {showDefects ? "Hide Defects" : "Show Defects"} ({defects.length})
            </button>
          )}
        </div>

        {/* ── Card identity ── */}
        <div className={`rounded-2xl p-6 ${t.card} reveal-on-scroll`}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <h1 className={`text-2xl font-black tracking-tight mb-1 ${t.text}`}>{cert.cardName || "—"}</h1>
              <p className={`text-sm mb-0.5 ${t.textSec}`}>{cert.cardSet}{cert.cardYear ? ` · ${cert.cardYear}` : ""}{cert.cardNumber ? ` · #${cert.cardNumber}` : ""}</p>
              {cert.cardGame && <p className={`text-xs ${t.textMut}`}>{cert.cardGame} · {cert.language}</p>}
              {cert.rarity && <p className={`text-xs ${t.textMut}`}>{cert.rarity}</p>}
              {cert.variant && <p className={`text-xs ${t.textMut}`}>{cert.variant}</p>}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] uppercase tracking-widest ${t.textMut}`}>Date Graded</span>
                <span className={`text-xs font-medium ${t.textSec}`}>{gradedDateFmt}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] uppercase tracking-widest ${t.textMut}`}>Graded By</span>
                <span className={`text-xs font-medium ${t.textSec}`}>{grade.approvedBy || "MintVault UK"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] uppercase tracking-widest ${t.textMut}`}>Certificate</span>
                <span className="text-xs font-mono font-medium text-[#D4AF37]">{cert.certId}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 font-bold uppercase`}>
                  <CheckCircle2 size={10} /> Active
                </span>
                {ownership.nfcEnabled && (
                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-[#D4AF37]/15 text-[#D4AF37] font-bold uppercase">
                    NFC Verified ✓
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Card images ── */}
        {(images.front || images.back) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 reveal-on-scroll">
            {images.front && (
              <CardImagePanel side="front" images={images} defects={defects} showDefects={showDefects} isBlack={isBlack} onLightbox={setLightboxUrl} />
            )}
            {images.back && (
              <CardImagePanel side="back" images={images} defects={defects} showDefects={showDefects} isBlack={isBlack} onLightbox={setLightboxUrl} />
            )}
          </div>
        )}

        {/* ── Overall grade hero ── */}
        <div className="reveal-on-scroll">
          {isBlack && (
            <div className={`flex items-center justify-center gap-2 mb-3 text-[#D4AF37] text-xs font-bold uppercase tracking-widest animate-pulse`}>
              <Star size={14} className="fill-[#D4AF37]" />
              BLACK LABEL
              <Star size={14} className="fill-[#D4AF37]" />
            </div>
          )}
          <div className={`rounded-2xl p-8 text-center border-2 ${isBlack ? "border-[#D4AF37]/40 bg-[#111111]" : "border-[#E8E4DC] bg-white"}`}
            style={isBlack ? { boxShadow: "0 0 40px rgba(212,175,55,0.15)" } : {}}>
            <p className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${t.textMut}`}>Overall Grade</p>
            <p className="text-8xl font-black leading-none" style={{ color: "#D4AF37" }}>{grade.overall}</p>
            <p className={`text-xl font-bold uppercase tracking-widest mt-2 ${t.text}`}>{grade.label}</p>
            {approvedDateFmt && (
              <p className={`text-xs mt-2 ${t.textMut}`}>Approved {approvedDateFmt}</p>
            )}
          </div>
          {grade.explanation && (
            <div className={`mt-4 rounded-xl p-5 border-l-4 border-[#D4AF37] ${isBlack ? "bg-[#111111]" : "bg-[#FFF9E6]"}`}>
              <p className={`text-sm leading-relaxed italic ${isBlack ? "text-[#AAAAAA]" : "text-[#444444]"}`}>"{grade.explanation}"</p>
            </div>
          )}
        </div>

        {/* ── Subgrade breakdown ── */}
        {(subgrades.centering !== null || subgrades.corners !== null || subgrades.edges !== null || subgrades.surface !== null) && (
          <div className="reveal-on-scroll">
            <h2 className={`text-xs font-bold uppercase tracking-widest mb-4 text-[#D4AF37]`}>Subgrade Breakdown</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">

              <SubgradeCard label="Centering" value={subgrades.centering} isBlack={isBlack}>
                {(centering.frontLR || centering.frontTB) && (
                  <div className="pt-3 space-y-1.5">
                    {[["Front L/R", centering.frontLR], ["Front T/B", centering.frontTB], ["Back L/R", centering.backLR], ["Back T/B", centering.backTB]].map(([l, v]) => v ? (
                      <div key={String(l)} className="flex justify-between">
                        <span className={`text-[10px] ${t.textMut}`}>{l}</span>
                        <span className="text-[10px] font-mono font-bold text-[#D4AF37]">{v}</span>
                      </div>
                    ) : null)}
                  </div>
                )}
              </SubgradeCard>

              <SubgradeCard label="Corners" value={subgrades.corners} isBlack={isBlack}>
                {corners && (
                  <div className="pt-3 space-y-2">
                    {[["Front", ["frontTL", "frontTR", "frontBL", "frontBR"]], ["Back", ["backTL", "backTR", "backBL", "backBR"]]].map(([side, keys]) => (
                      <div key={String(side)}>
                        <p className={`text-[9px] uppercase tracking-wider mb-1 ${t.textMut}`}>{side}</p>
                        <div className="grid grid-cols-2 gap-1">
                          {(keys as string[]).map(k => (
                            <span key={k} className={`text-[10px] font-bold ${cornerColor(corners[k])}`}>
                              {k.replace(/^(front|back)/, "").replace(/([A-Z])/g, " $1").trim()}: {corners[k]}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SubgradeCard>

              <SubgradeCard label="Edges" value={subgrades.edges} isBlack={isBlack}>
                {edges && (
                  <div className="pt-3 space-y-2">
                    {[["Front", ["frontTop", "frontRight", "frontBottom", "frontLeft"]], ["Back", ["backTop", "backRight", "backBottom", "backLeft"]]].map(([side, keys]) => (
                      <div key={String(side)}>
                        <p className={`text-[9px] uppercase tracking-wider mb-1 ${t.textMut}`}>{side}</p>
                        <div className="grid grid-cols-2 gap-1">
                          {(keys as string[]).map(k => (
                            <span key={k} className={`text-[10px] font-bold ${cornerColor(edges[k])}`}>
                              {k.replace(/^(front|back)/, "").replace(/([A-Z])/g, " $1").trim()}: {edges[k]}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </SubgradeCard>

              <SubgradeCard label="Surface" value={subgrades.surface} isBlack={isBlack}>
                {surface && (
                  <div className="pt-3 space-y-1">
                    {surface.front != null && <div className="flex justify-between"><span className={`text-[10px] ${t.textMut}`}>Front</span><span className={`text-[10px] font-bold ${cornerColor(surface.front)}`}>{surface.front}</span></div>}
                    {surface.back  != null && <div className="flex justify-between"><span className={`text-[10px] ${t.textMut}`}>Back</span><span className={`text-[10px] font-bold ${cornerColor(surface.back)}`}>{surface.back}</span></div>}
                  </div>
                )}
              </SubgradeCard>

            </div>
            <p className={`text-[10px] mt-2 ${t.textMut}`}>Tap a subgrade to expand details.</p>
          </div>
        )}

        {/* ── Defects ── */}
        <div className="reveal-on-scroll">
          <h2 className="text-xs font-bold uppercase tracking-widest mb-4 text-[#D4AF37]">Identified Defects</h2>
          {defects.length === 0 ? (
            <div className={`rounded-xl p-6 text-center ${t.card}`}>
              <CheckCircle2 size={28} className="text-emerald-500 mx-auto mb-2" />
              <p className={`font-bold text-sm ${t.text}`}>No defects identified</p>
              <p className={`text-xs mt-1 ${t.textSec}`}>This card is in exceptional condition.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {defects.map(d => (
                <div key={d.id} className={`flex items-start gap-3 rounded-xl px-4 py-3 ${t.card}`}>
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-red-600 flex items-center justify-center text-white text-[9px] font-black mt-0.5">{d.id}</span>
                  <div className={`flex-shrink-0 mt-1 ${t.textMut}`}>{defectIcon(d.type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                      <span className={`text-xs font-bold ${t.text}`}>{d.type}</span>
                      <span className={`text-[9px] uppercase px-1.5 py-0.5 rounded-full border ${SEV_BADGE[d.severity] || SEV_BADGE.minor}`}>{d.severity}</span>
                      <span className={`text-[10px] ${t.textMut}`}>{d.location}</span>
                    </div>
                    {d.description && <p className={`text-xs leading-relaxed ${t.textSec}`}>{d.description}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Authentication ── */}
        <div className={`rounded-xl p-5 ${t.card} reveal-on-scroll`}>
          <div className="flex items-center gap-3 mb-3">
            <Shield size={18} className={authentication.status === "genuine" ? "text-emerald-500" : "text-red-400"} />
            <h2 className={`text-xs font-bold uppercase tracking-widest text-[#D4AF37]`}>Authentication</h2>
          </div>
          <p className={`text-sm ${t.textSec}`}>
            {authentication.status === "genuine"
              ? "This card has been authenticated as genuine by MintVault UK."
              : authentication.status === "authentic_altered"
                ? "This card has been identified as AUTHENTIC ALTERED."
                : "This card has been identified as NOT ORIGINAL."}
          </p>
          {authentication.notes && <p className={`text-xs mt-2 italic ${t.textMut}`}>{authentication.notes}</p>}
          {ownership.nfcEnabled && <p className={`text-xs mt-2 ${t.textMut}`}>This slab contains an NFC chip. Tap to verify authenticity.</p>}
          {ownership.status === "claimed" && <p className={`text-xs mt-2 text-[#D4AF37]`}>✓ Registered owner on file.</p>}
        </div>

        {/* ── Population ── */}
        {population.totalGraded > 0 && (
          <div className={`rounded-xl p-5 ${t.card} reveal-on-scroll`}>
            <h2 className={`text-xs font-bold uppercase tracking-widest mb-3 text-[#D4AF37]`}>Population Context</h2>
            <p className={`text-sm ${t.textSec}`}>
              MintVault has graded <strong className={t.text}>{population.totalGraded}</strong> {population.totalGraded === 1 ? "copy" : "copies"} of this card.
            </p>
            {population.percentile > 0 && (
              <p className={`text-sm mt-1 ${t.textSec}`}>
                This card is graded higher than <strong className={t.text}>{population.percentile}%</strong> of copies in our registry.
              </p>
            )}
            {isBlack && (
              <p className="text-sm mt-1 text-[#D4AF37] font-bold">
                ★ This is one of {population.sameGradeCount} Black Label {population.sameGradeCount === 1 ? "copy" : "copies"} — the rarest grade at MintVault.
              </p>
            )}
            {population.higherGradeCount === 0 && population.totalGraded > 1 && (
              <p className="text-sm mt-1 text-[#D4AF37]">★ Highest graded copy in the MintVault registry.</p>
            )}
          </div>
        )}

        {/* ── Market Value ── */}
        {marketValue?.estimatedLow && marketValue?.estimatedHigh && (
          <div className={`rounded-xl p-5 ${t.card} reveal-on-scroll`}>
            <h2 className="text-xs font-bold uppercase tracking-widest mb-3 text-[#D4AF37]">Estimated Market Value</h2>
            <p className={`text-2xl font-black ${t.text}`}>
              {marketValue.currency === "GBP" ? "£" : "$"}{marketValue.estimatedLow} – {marketValue.currency === "GBP" ? "£" : "$"}{marketValue.estimatedHigh}
            </p>
            <p className={`text-xs mt-1 ${t.textMut}`}>AI-estimated retail value for a card of this grade. Not a guarantee of sale price.</p>
          </div>
        )}

        {/* ── Footer ── */}
        <div className={`text-center pt-6 border-t ${isBlack ? "border-[#222222]" : "border-[#E8E4DC]"} reveal-on-scroll`}>
          <p className={`text-xs mb-1 ${t.textMut}`}>Graded by MintVault UK · Rochester, Kent · mintvaultuk.com</p>
          <p className={`text-[10px] mb-2 ${isBlack ? "text-[#444444]" : "text-[#CCCCCC]"}`}>
            This report is permanent and cannot be altered. Certificate {cert.certId}.
          </p>
          <p className={`text-[10px] ${isBlack ? "text-[#333333]" : "text-[#DDDDDD]"}`}>© 2026 MintVault UK</p>
          <div className="mt-4 print:hidden">
            <a
              href={`/api/cert/${cert.certId}/report/pdf`}
              download
              className="inline-flex items-center gap-2 bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-[#D4AF37] px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest hover:bg-[#D4AF37]/20 transition-all"
            >
              <Download size={14} />
              Download PDF Report
            </a>
          </div>
        </div>

      </div>

      {/* Print styles */}
      <style>{`
        @media print {
          .print\\:hidden { display: none !important; }
          .reveal-on-scroll { opacity: 1 !important; transform: none !important; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          @page { margin: 20mm; }
        }
      `}</style>
    </div>
  );
}
