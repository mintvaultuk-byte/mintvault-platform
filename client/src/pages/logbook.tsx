import { useParams, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Shield,
  Download,
  Lock,
  ExternalLink,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  ArrowRightLeft,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import SeoHead from "@/components/seo-head";
import ShareStudio from "@/components/ShareStudio";

interface LogbookData {
  certId: string;
  currentOwnerUserId?: string | null;
  ownerEmail?: string | null;
  // Optional public display name — present only when PUBLIC_NAME_TOGGLE_LIVE
  // is on AND owner has opted in AND owner.display_name is non-empty.
  // Field omitted otherwise (anonymous = no row rendered).
  ownerDisplayName?: string;
  card: {
    name: string | null;
    set: string | null;
    number: string | null;
    year: string | null;
    game: string | null;
    variant: string | null;
    language: string;
    rarity: string | null;
    collection: string | null;
    designations: string[];
  };
  grades: {
    overall: number | string;
    gradeLabel: string;
    centering: number | null;
    corners: number | null;
    edges: number | null;
    surface: number | null;
    isBlackLabel: boolean;
    isNonNumeric: boolean;
    gradeType: string;
    labelType: string;
  };
  centering: { frontLR: string | null; frontTB: string | null; backLR: string | null; backTB: string | null };
  authentication: { status: string; notes: string | null };
  defects: Array<{
    id: number;
    type: string;
    location: string;
    severity: string;
    description: string;
    x_percent?: number | null;
    y_percent?: number | null;
    image_side?: "front" | "back";
  }>;
  // MVGS v2 — operator-drawn whitening segments. Colour is chosen for
  // legibility against the card; render as-stored. Engine never sees colour.
  whiteningLines?: Array<{
    id: string | null;
    side: "front" | "back";
    edge: "top" | "right" | "bottom" | "left";
    coveragePct: number | null;
    start: { x: number; y: number };
    end: { x: number; y: number };
    color: string | null;
  }>;
  // MVGS v2 — multi-crease spans. Same display-only colour rule.
  creaseLines?: Array<{
    id: string | null;
    side: "front" | "back";
    spanPct: number | null;
    start: { x: number; y: number };
    end: { x: number; y: number };
    color: string | null;
  }>;
  gradingReport: {
    centering: string | null;
    corners: string | null;
    edges: string | null;
    surface: string | null;
    overall: string | null;
  };
  images: { front: string | null; back: string | null };
  population: any;
  provenance: {
    issuedAt: string | null;
    gradedAt: string | null;
    ownershipStatus: string;
    nfcEnabled: boolean;
    nfcScanCount: number;
    stolenStatus: string | null;
  };
  verification: { signature: string | null; signedAt: string; verifyUrl: string };
  ownership: {
    previousOwnersCount: number;
    currentOwnerNumber: number;
    chain: Array<{
      ownerNumber: number;
      displayName: string | null;
      claimedAt: string;
      releasedAt: string | null;
      durationDays: number | null;
      isCurrent: boolean;
      claimMethod: string;
    }>;
  };
}

function safe(v: any, fallback = "\u2014"): string {
  if (v === null || v === undefined || v === "") return fallback;
  return String(v);
}

function titleCase(s: string | null | undefined): string {
  if (!s) return "\u2014";
  // Special cases
  const specials: Record<string, string> = { pokemon: "Pok\u00e9mon", pokémon: "Pok\u00e9mon" };
  return s
    .split(" ")
    .map((w) => specials[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function GoldDivider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-[#D4AF37]/40 to-transparent my-6" />;
}

function SubgradeBox({ label, value }: { label: string; value: number | string | null }) {
  const v = value !== null && value !== undefined ? String(value) : "\u2014";
  const num = typeof value === "number" ? value : parseFloat(String(value));
  const color = isNaN(num)
    ? "text-[#888888]"
    : num >= 10
      ? "text-[#D4AF37]"
      : num >= 8
        ? "text-[#16A34A]"
        : num >= 6
          ? "text-[#CA8A04]"
          : "text-[#DC2626]";
  return (
    <div className="text-center">
      <p className="text-[10px] uppercase tracking-[0.15em] text-[#888888] mb-1">{label}</p>
      <p className={`text-2xl font-black ${color}`}>{v}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-[10px] uppercase tracking-[0.2em] text-[#D4AF37] font-bold mb-4">{title}</h2>
      <div className="h-px bg-[#E8E4DC] mb-6" />
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline py-2 border-b border-[#E8E4DC]">
      <span className="text-[#888888] text-xs">{label}</span>
      <span className="text-[#1A1A1A] text-sm font-medium">{value}</span>
    </div>
  );
}

// ── Defect circles overlay (Q2) ────────────────────────────────────────────
// Renders the cert's front + back images with numbered circles at each
// defect's stored x_percent / y_percent. ONLY for the Condition Report
// section — never the hero card images at the top of the page. Sides
// with no positioned defects render nothing for that side.
type OverlayDefect = {
  id: number;
  type: string;
  severity: string;
  x_percent?: number | null;
  y_percent?: number | null;
  image_side?: "front" | "back";
};
// MVGS v2 line entries — same shape on the front + back overlay. Colour is
// the operator's display-only pick (already stored on the row); we render
// it as-given so it reads against the operator's chosen background.
type OverlayLine = {
  side: "front" | "back";
  start: { x: number; y: number };
  end: { x: number; y: number };
  color: string | null;
};
function DefectOverlayPair({
  defects,
  whiteningLines = [],
  creaseLines = [],
  images,
  highlightId,
  onHighlight,
}: {
  defects: OverlayDefect[];
  whiteningLines?: OverlayLine[];
  creaseLines?: OverlayLine[];
  images: { front: string | null; back: string | null };
  highlightId: number | null;
  onHighlight: (id: number | null) => void;
}) {
  const positioned = defects.filter((d) => typeof d.x_percent === "number" && typeof d.y_percent === "number");
  const frontDefects = positioned.filter((d) => d.image_side !== "back");
  const backDefects = positioned.filter((d) => d.image_side === "back");
  const frontLines = [
    ...whiteningLines.filter((l) => l.side !== "back"),
    ...creaseLines.filter((l) => l.side !== "back"),
  ];
  const backLines = [
    ...whiteningLines.filter((l) => l.side === "back"),
    ...creaseLines.filter((l) => l.side === "back"),
  ];
  // Always render both sides if their image URL exists, regardless of defect
  // presence on that side. Sides with no positioned defects render the image
  // bare. Defensive: if neither URL exists we render nothing — caller
  // already gates the section on defects.length > 0.
  if (!images.front && !images.back) return null;

  const sevBorder = (s: string) =>
    s === "significant"
      ? "border-red-600 text-red-600 bg-red-50"
      : s === "moderate"
        ? "border-orange-600 text-orange-600 bg-orange-50"
        : "border-amber-600 text-amber-600 bg-amber-50";

  function SidePanel({
    url,
    label,
    defects,
    lines,
  }: {
    url: string;
    label: string;
    defects: OverlayDefect[];
    lines: OverlayLine[];
  }) {
    return (
      <div className="flex flex-col items-center">
        <p className="text-[10px] uppercase tracking-[0.2em] text-[#888888] mb-2">{label}</p>
        <div className="relative inline-block">
          <img src={url} alt={label} className="h-64 rounded-lg shadow-lg" draggable={false} />
          {/* SVG overlay for whitening + crease line segments. preserveAspectRatio
              "none" stretches the 0..100% coordinate space exactly over the
              image regardless of its rendered aspect ratio, so the line lands
              where the operator drew it. */}
          {lines.length > 0 && (
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 w-full h-full pointer-events-none"
              data-testid={`overlay-lines-${label.toLowerCase()}`}
            >
              {lines.map((l, i) => (
                <line
                  key={i}
                  x1={l.start.x}
                  y1={l.start.y}
                  x2={l.end.x}
                  y2={l.end.y}
                  stroke={l.color || "#D4AF37"}
                  strokeWidth={0.6}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ strokeWidth: 3 }}
                />
              ))}
            </svg>
          )}
          {defects.map((d) => {
            const isHi = highlightId === d.id;
            return (
              <button
                key={d.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onHighlight(isHi ? null : d.id);
                }}
                title={`#${d.id} ${d.type} (${d.severity})`}
                aria-label={`Defect ${d.id} ${d.type} ${d.severity}`}
                data-testid={`defect-circle-${d.id}`}
                className={`absolute flex items-center justify-center font-bold text-[10px] rounded-full border-2 transition-transform ${sevBorder(
                  d.severity
                )} ${isHi ? "scale-125 ring-2 ring-[#D4AF37]" : "hover:scale-110"}`}
                style={{
                  left: `${d.x_percent}%`,
                  top: `${d.y_percent}%`,
                  width: 28,
                  height: 28,
                  transform: `translate(-50%, -50%)${isHi ? " scale(1.25)" : ""}`,
                  backgroundColor: "rgba(255,255,255,0.85)",
                  cursor: "pointer",
                }}
              >
                {d.id}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex justify-center gap-4">
      {images.front && <SidePanel url={images.front} label="Front" defects={frontDefects} lines={frontLines} />}
      {images.back && <SidePanel url={images.back} label="Back" defects={backDefects} lines={backLines} />}
    </div>
  );
}

// Admin-only "Reprocess Images" button — re-runs the full display
// pipeline (deskew → detectCardEdgesByCoverage → reCentreBitmap →
// tightenForDisplay → whitewashEdgesBySaturation → maskRoundedCorners)
// on the cert's R2 originals and overwrites the existing R2 image
// keys. On success, invalidates the logbook query so the images viewer
// refetches with fresh presigned URLs — no full page reload.
function AdminReprocessButton({ certId }: { certId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  return (
    <button
      type="button"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        try {
          const r = await fetch(`/api/admin/certs/${certId}/reprocess-images`, {
            method: "POST",
            credentials: "include",
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
          // Refetch logbook so the viewer picks up the new presigned
          // URLs without a page reload. The server also returns
          // front_url / back_url in d for direct swap if needed.
          await qc.invalidateQueries({ queryKey: ["/api/logbook", certId] });
          toast({ title: "Images reprocessed ✓", description: "Image viewer refreshed." });
        } catch (e: any) {
          toast({
            title: "Reprocess failed",
            description: e.message || String(e),
            variant: "destructive",
          });
        } finally {
          setLoading(false);
        }
      }}
      className={`inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-all ${
        loading
          ? "border border-[#D4AF37]/40 text-[#D4AF37] bg-[#D4AF37]/5 cursor-wait"
          : "border border-[#D4AF37]/40 text-[#D4AF37] hover:bg-[#D4AF37]/10"
      }`}
      data-testid="btn-reprocess-images"
    >
      {loading ? (
        <>
          <Loader2 size={12} className="animate-spin" /> Reprocessing…
        </>
      ) : (
        "Reprocess Images"
      )}
    </button>
  );
}

// Admin-only population report panel — fetches /api/admin/certs/:certId/
// pop-report (requireAdmin) and renders a Grade | Count | % table with
// the current cert's grade row highlighted in gold. Only shown when the
// route path starts with /admin/ (LogbookPage is also the public cert
// view, and this data is admin-only).
type PopReportResponse = {
  cert_id: string;
  card: { name: string | null; set: string | null; number: string | null };
  current_grade: string | null;
  total: number;
  distribution: Array<{ grade: string; count: number; percent: number }>;
  note?: string;
};

function AdminPopReportPanel({ certId }: { certId: string }) {
  const { data, isLoading, error } = useQuery<PopReportResponse>({
    queryKey: ["/api/admin/certs", certId, "pop-report"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/certs/${certId}/pop-report`, { credentials: "include" });
      if (!res.ok) throw new Error("pop-report fetch failed");
      return res.json();
    },
    enabled: !!certId,
  });

  if (isLoading) {
    return (
      <Section title="Population Report (admin)">
        <p className="text-xs text-[#888888]">Loading…</p>
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section title="Population Report (admin)">
        <p className="text-xs text-[#888888]">Population report unavailable.</p>
      </Section>
    );
  }
  if (data.distribution.length === 0) {
    return (
      <Section title="Population Report (admin)">
        <p className="text-xs text-[#888888]">
          {data.note ??
            `No other active graded certs match ${data.card.name ?? "this card"}${data.card.set ? ` (${data.card.set}` : ""}${data.card.number ? ` #${data.card.number})` : data.card.set ? ")" : ""}.`}
        </p>
      </Section>
    );
  }
  return (
    <Section title="Population Report (admin)">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-[#E8E4DC]">
              <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em] text-[#888888]">Grade</th>
              <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em] text-[#888888] text-right">Count</th>
              <th className="py-2 px-3 text-[10px] uppercase tracking-[0.15em] text-[#888888] text-right">
                % of total
              </th>
            </tr>
          </thead>
          <tbody>
            {data.distribution.map((row) => {
              const isCurrent = row.grade === data.current_grade;
              const rowCls = isCurrent ? "bg-gradient-to-r from-[#D4AF37]/15 to-transparent" : "";
              const txt = isCurrent ? "text-[#B8960C] font-bold" : "text-[#1A1A1A]";
              const muted = isCurrent ? "text-[#B8960C] font-bold" : "text-[#555555]";
              return (
                <tr key={row.grade} className={`border-b border-[#F0EDE5] ${rowCls}`}>
                  <td className={`py-2 px-3 ${txt}`}>
                    {row.grade}
                    {isCurrent && (
                      <span className="ml-2 text-[10px] uppercase tracking-[0.15em] text-[#D4AF37]">This cert</span>
                    )}
                  </td>
                  <td className={`py-2 px-3 text-right ${txt}`}>{row.count}</td>
                  <td className={`py-2 px-3 text-right ${muted}`}>{row.percent.toFixed(1)}%</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-[#D4AF37]/30">
              <td className="py-2 px-3 text-[10px] uppercase tracking-[0.15em] text-[#888888]">Total graded</td>
              <td className="py-2 px-3 text-right text-[#1A1A1A] font-bold">{data.total}</td>
              <td className="py-2 px-3 text-right text-[#555555]">100.0%</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-[10px] text-[#888888]">
          Matched on card_name + set_name + card_number_display. Active + published + graded certs only.
        </p>
      </div>
    </Section>
  );
}

export default function LogbookPage() {
  const params = useParams<{ certId?: string; id?: string }>();
  const certId = params.certId || params.id || "";
  const [location] = useLocation();
  const isAdminView = location.startsWith("/admin/");
  // Admin-only tab state — partitions the page into IMAGES / GRADING /
  // POPULATION / ACTIONS in admin view. Public /cert/:id ignores this
  // (no tab bar rendered, all sections stack vertically).
  type AdminTab = "images" | "grading" | "population" | "actions";
  const [adminTab, setAdminTab] = useState<AdminTab>("images");
  const [showDefects, setShowDefects] = useState(false);
  const [highlightDefectId, setHighlightDefectId] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery<LogbookData>({
    queryKey: ["/api/logbook", certId],
    queryFn: async () => {
      const res = await fetch(`/api/logbook/${certId}`);
      if (!res.ok) throw new Error("Certificate not found");
      return res.json();
    },
    enabled: !!certId,
  });

  // Check if current user is the owner (for Owner Copy button)
  const { data: me } = useQuery<{ email?: string } | null>({
    queryKey: ["/api/customer/me"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/customer/me", { credentials: "include" });
        if (!res.ok) return null;
        return res.json();
      } catch {
        return null;
      }
    },
  });
  const isOwner = !!(me?.email && data?.ownerEmail && me.email.toLowerCase() === data.ownerEmail.toLowerCase());

  if (isLoading)
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[#888888] text-sm">Loading logbook...</p>
        </div>
      </div>
    );

  if (error || !data)
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <Shield className="w-12 h-12 text-[#E8E4DC] mx-auto mb-4" />
          <p className="text-[#555555] text-lg mb-2">Certificate Not Found</p>
          <p className="text-[#888888] text-sm">The certificate {certId} could not be verified.</p>
        </div>
      </div>
    );

  const { card, grades, centering, authentication, defects, gradingReport, images, provenance, verification } = data;
  const whiteningLines = Array.isArray(data.whiteningLines) ? data.whiteningLines : [];
  const creaseLines = Array.isArray(data.creaseLines) ? data.creaseLines : [];
  // Lines count toward the visible "N defects" total since they ARE defects —
  // the operator drew them as evidence of damage. Hides the section when nothing
  // is recorded; keeps the existing behaviour when only pins exist.
  const totalDefectCount = defects.length + whiteningLines.length + creaseLines.length;

  return (
    <>
      <SeoHead
        title={`${titleCase(card.name)} — Grade ${safe(grades.overall)} | MintVault Logbook`}
        description={`Official MintVault Ownership Logbook for ${titleCase(card.name)} (${safe(card.set)}). Grade: ${safe(grades.overall)} ${grades.gradeLabel}. Certificate ${data.certId}.`}
        canonical={`/vault/${data.certId}`}
        ogTitle={`${titleCase(card.name)} — Grade ${safe(grades.overall)} ${grades.gradeLabel} | MintVault`}
        ogDescription="Certified by MintVault UK. Verify this certificate at mintvaultuk.com."
        ogImage={`https://mintvaultuk.com/api/public/share/${data.certId}/feed`}
        ogImageWidth="1080"
        ogImageHeight="1080"
        noindex
      />

      <div className="min-h-screen bg-white text-[#1A1A1A]">
        {/* Stolen banner — prominent, unmissable, full-width at the top of
            the page. Shown to any visitor when a verified stolen report
            exists. Pulses bright-red to deep-red with an outward glow.
            Inline Field row further down keeps the detail in the
            provenance summary. */}
        {provenance.stolenStatus === "reported_stolen" && (
          <>
            <style>{`
              @keyframes stolen-banner-pulse {
                0%, 100% { background-color: #DC2626; box-shadow: inset 0 0 0 0 rgba(255,255,255,0); }
                50%      { background-color: #991B1B; box-shadow: 0 4px 24px 0 rgba(220, 38, 38, 0.55); }
              }
              .stolen-banner-pulse { animation: stolen-banner-pulse 1.6s ease-in-out infinite; }
            `}</style>
            <div
              className="stolen-banner-pulse w-full text-white text-center py-3 px-4 flex items-center justify-center gap-3"
              role="alert"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="shrink-0"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span className="text-sm font-bold tracking-wide">
                ⚠ This card has been reported stolen. If you have seen it for sale, please contact us at
                support@mintvaultuk.com
              </span>
            </div>
          </>
        )}

        {/* Admin tab bar — only rendered on /admin/cert/:id. Full-width
            stacked on mobile (flex-col), inline on desktop (sm:flex-row).
            Active tab indicator: gold bottom border + gold text. */}
        {isAdminView && (
          <nav className="border-b border-[#E8E4DC] bg-white">
            <div className="max-w-3xl mx-auto px-4 flex flex-col sm:flex-row">
              {(["images", "grading", "population", "actions"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAdminTab(t)}
                  className={`flex-1 sm:flex-none sm:px-8 py-3 text-xs font-bold uppercase tracking-[0.15em] transition-all border-b-2 ${
                    adminTab === t
                      ? "text-[#D4AF37] border-[#D4AF37]"
                      : "text-[#888888] border-transparent hover:text-[#1A1A1A]"
                  }`}
                  data-testid={`tab-${t}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </nav>
        )}

        {/* Cover Hero — IMAGES tab (admin) / always (public) */}
        {(!isAdminView || adminTab === "images") && (
          <section className="pt-12 pb-8 px-4">
            <div className="max-w-3xl mx-auto text-center">
              <p className="text-[10px] uppercase tracking-[0.3em] text-[#D4AF37] mb-6">MintVault Ownership Logbook</p>

              {/* Card images */}
              {(images.front || images.back) && (
                <div className="flex justify-center gap-4 mb-8">
                  {images.front && <img src={images.front} alt="Front" className="h-64 rounded-lg shadow-lg" />}
                  {images.back && <img src={images.back} alt="Back" className="h-64 rounded-lg shadow-lg" />}
                </div>
              )}

              {/* Grade badge */}
              <div className="inline-block mb-4">
                <div
                  className="inline-flex items-center justify-center w-28 h-28 rounded-full border-2 border-[#D4AF37]/40 bg-white mb-2"
                  style={{ boxShadow: "0 0 24px rgba(212,175,55,0.12)" }}
                >
                  <span
                    className={`text-5xl font-black ${grades.isBlackLabel ? "text-[#D4AF37]" : grades.isNonNumeric ? "text-amber-500" : "text-[#1A1A1A]"}`}
                  >
                    {safe(grades.overall)}
                  </span>
                </div>
                <div
                  className={`text-sm uppercase tracking-[0.2em] font-bold mt-1 ${grades.isBlackLabel ? "text-[#D4AF37]" : "text-[#888888]"}`}
                >
                  {grades.gradeLabel}
                </div>
                {grades.isBlackLabel && grades.gradeLabel !== "PRISTINE 10P" && (
                  <div className="text-[10px] uppercase tracking-[0.3em] text-[#D4AF37] mt-2 animate-pulse">
                    Pristine 10P
                  </div>
                )}
              </div>

              <h1 className="text-3xl md:text-4xl font-black text-[#1A1A1A] mt-4 mb-2">{titleCase(card.name)}</h1>
              <p className="text-[#888888] text-sm">
                {safe(card.set)} {card.number ? `#${card.number}` : ""} {card.year ? `(${card.year})` : ""}
              </p>

              <GoldDivider />

              {/* Cert ID */}
              <p className="font-mono text-lg text-[#D4AF37] tracking-wider">{data.certId}</p>
              {provenance.issuedAt && (
                <p className="text-[#888888] text-xs mt-1">
                  Issued{" "}
                  {new Date(provenance.issuedAt).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </p>
              )}
            </div>
          </section>
        )}

        {/* Verification strip — IMAGES tab (admin) / always (public) */}
        {(!isAdminView || adminTab === "images") && (
          <section className="bg-[#F7F7F5] border-y border-[#E8E4DC] py-4 px-4">
            <div className="max-w-3xl mx-auto flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-[#D4AF37]" />
                <span className="text-[10px] uppercase tracking-[0.15em] text-[#D4AF37] font-bold">
                  VaultSeal Verified
                </span>
              </div>
              <span className="font-mono text-[10px] text-[#888888]">{verification.signature?.slice(0, 16)}...</span>
            </div>
          </section>
        )}

        {/* Content sections */}
        <div className="max-w-3xl mx-auto px-4 py-12">
          {/* GRADING tab (admin) / always (public) — Card Identity through
              Ownership History stack together. */}
          {(!isAdminView || adminTab === "grading") && (
            <>
              {/* Card Identity */}
              <Section title="Card Identity">
                <div className="space-y-0">
                  {card.game && <Field label="Game" value={titleCase(card.game)} />}
                  <Field label="Card Name" value={titleCase(card.name)} />
                  {card.set && <Field label="Set" value={safe(card.set)} />}
                  {card.number && <Field label="Card Number" value={safe(card.number)} />}
                  {card.year && <Field label="Year" value={safe(card.year)} />}
                  {card.variant && <Field label="Variant" value={card.variant} />}
                  {card.rarity && <Field label="Rarity" value={safe(card.rarity)} />}
                  <Field label="Language" value={safe(card.language)} />
                  {card.designations.length > 0 && <Field label="Designations" value={card.designations.join(", ")} />}
                </div>
              </Section>

              {/* Grade Breakdown — only show if at least one subgrade exists */}
              {(grades.centering != null ||
                grades.corners != null ||
                grades.edges != null ||
                grades.surface != null) && (
                <Section title="Grade Analysis">
                  <div className="grid grid-cols-4 gap-6 mb-4">
                    <SubgradeBox label="Centering" value={grades.centering} />
                    <SubgradeBox label="Corners" value={grades.corners} />
                    <SubgradeBox label="Edges" value={grades.edges} />
                    <SubgradeBox label="Surface" value={grades.surface} />
                  </div>
                  <p className="text-[10px] text-[#888888] text-center mb-6">
                    Surface 40% · Corners 25% · Edges 25% · Centering 10%
                  </p>

                  {/* Centering ratios */}
                  {(centering.frontLR || centering.backLR) && (
                    <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-4 mb-4">
                      <p className="text-[10px] uppercase tracking-[0.15em] text-[#888888] mb-3">
                        Centering Measurement
                      </p>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        {centering.frontLR && (
                          <div>
                            <span className="text-[#888888] text-xs">Front L/R</span>{" "}
                            <span className="text-[#1A1A1A] font-mono ml-2">{centering.frontLR}</span>
                          </div>
                        )}
                        {centering.frontTB && (
                          <div>
                            <span className="text-[#888888] text-xs">Front T/B</span>{" "}
                            <span className="text-[#1A1A1A] font-mono ml-2">{centering.frontTB}</span>
                          </div>
                        )}
                        {centering.backLR && (
                          <div>
                            <span className="text-[#888888] text-xs">Back L/R</span>{" "}
                            <span className="text-[#1A1A1A] font-mono ml-2">{centering.backLR}</span>
                          </div>
                        )}
                        {centering.backTB && (
                          <div>
                            <span className="text-[#888888] text-xs">Back T/B</span>{" "}
                            <span className="text-[#1A1A1A] font-mono ml-2">{centering.backTB}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Grader notes */}
                  {(gradingReport.overall || gradingReport.centering) && (
                    <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-4">
                      <p className="text-[10px] uppercase tracking-[0.15em] text-[#888888] mb-3">Grader Notes</p>
                      <div className="text-sm text-[#555555] space-y-2 leading-relaxed">
                        {gradingReport.centering && (
                          <p>
                            <span className="text-[#888888]">Centering:</span> {gradingReport.centering}
                          </p>
                        )}
                        {gradingReport.corners && (
                          <p>
                            <span className="text-[#888888]">Corners:</span> {gradingReport.corners}
                          </p>
                        )}
                        {gradingReport.edges && (
                          <p>
                            <span className="text-[#888888]">Edges:</span> {gradingReport.edges}
                          </p>
                        )}
                        {gradingReport.surface && (
                          <p>
                            <span className="text-[#888888]">Surface:</span> {gradingReport.surface}
                          </p>
                        )}
                        {gradingReport.overall && (
                          <p>
                            <span className="text-[#888888]">Overall:</span> {gradingReport.overall}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </Section>
              )}

              {/* Authentication */}
              <Section title="Authentication">
                <div className="flex items-center gap-3">
                  {authentication.status === "genuine" ? (
                    <>
                      <Check className="w-5 h-5 text-[#16A34A]" />
                      <span className="text-[#16A34A] font-bold text-sm">Genuine</span>
                    </>
                  ) : authentication.status === "authentic_altered" ? (
                    <>
                      <Shield className="w-5 h-5 text-amber-500" />
                      <span className="text-amber-500 font-bold text-sm">Authentic Altered</span>
                    </>
                  ) : (
                    <>
                      <X className="w-5 h-5 text-[#DC2626]" />
                      <span className="text-[#DC2626] font-bold text-sm">Not Original</span>
                    </>
                  )}
                </div>
                {authentication.notes && (
                  <p className="text-[#555555] text-sm mt-3 leading-relaxed">{authentication.notes}</p>
                )}
              </Section>

              {/* Condition / Defects */}
              {totalDefectCount > 0 && (
                <Section title="Condition Report">
                  <button
                    onClick={() => setShowDefects(!showDefects)}
                    className="flex items-center gap-2 text-sm text-[#555555] hover:text-[#1A1A1A] transition-colors"
                  >
                    {totalDefectCount} defect{totalDefectCount !== 1 ? "s" : ""} detected
                    {showDefects ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  {showDefects && (
                    <>
                      {/* Overlay images — Condition Report only. Hero card images
                      at the top of the page stay clean. Pins render at their
                      stored x/y%; v2 whitening + crease lines render as SVG
                      segments in the operator's chosen colour. */}
                      <DefectOverlayPair
                        defects={defects}
                        whiteningLines={whiteningLines}
                        creaseLines={creaseLines}
                        images={images}
                        highlightId={highlightDefectId}
                        onHighlight={setHighlightDefectId}
                      />
                      <div className="mt-4 space-y-2">
                        {defects.map((d) => {
                          const isHighlighted = highlightDefectId === d.id;
                          return (
                            <div
                              key={d.id}
                              className={`flex items-start gap-3 py-2 border-b transition-colors cursor-pointer ${
                                isHighlighted ? "border-[#D4AF37]/60 bg-[#D4AF37]/5" : "border-[#E8E4DC]"
                              }`}
                              onClick={() => setHighlightDefectId(isHighlighted ? null : d.id)}
                              data-testid={`defect-row-${d.id}`}
                            >
                              <span
                                className={`text-[9px] uppercase px-1.5 py-0.5 rounded border ${
                                  d.severity === "minor"
                                    ? "text-amber-600 border-amber-200 bg-amber-50"
                                    : d.severity === "moderate"
                                      ? "text-orange-600 border-orange-200 bg-orange-50"
                                      : "text-red-600 border-red-200 bg-red-50"
                                }`}
                              >
                                {d.severity}
                              </span>
                              <div>
                                <p className="text-sm text-[#1A1A1A]">
                                  #{d.id} · {d.type}
                                </p>
                                <p className="text-xs text-[#888888]">
                                  {d.location}
                                  {d.description ? ` — ${d.description}` : ""}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                        {/* MVGS v2 — line entries. No numbered pin marker (lines
                            identify themselves visually by colour + position).
                            Coverage% / span% drives the readable label. */}
                        {whiteningLines.map((w, i) => (
                          <div
                            key={`w-${i}`}
                            className="flex items-start gap-3 py-2 border-b border-[#E8E4DC]"
                            data-testid={`whitening-row-${i}`}
                          >
                            <span
                              className="text-[9px] uppercase px-1.5 py-0.5 rounded border"
                              style={{
                                color: w.color || "#D4AF37",
                                borderColor: w.color || "#D4AF37",
                                backgroundColor: "transparent",
                              }}
                            >
                              line
                            </span>
                            <div>
                              <p className="text-sm text-[#1A1A1A]">
                                Whitening · {w.edge}
                                {typeof w.coveragePct === "number" ? ` (${Math.round(w.coveragePct)}% of edge)` : ""}
                              </p>
                              <p className="text-xs text-[#888888]">{w.side}</p>
                            </div>
                          </div>
                        ))}
                        {creaseLines.map((cr, i) => (
                          <div
                            key={`c-${i}`}
                            className="flex items-start gap-3 py-2 border-b border-[#E8E4DC]"
                            data-testid={`crease-row-${i}`}
                          >
                            <span
                              className="text-[9px] uppercase px-1.5 py-0.5 rounded border"
                              style={{
                                color: cr.color || "#D4AF37",
                                borderColor: cr.color || "#D4AF37",
                                backgroundColor: "transparent",
                              }}
                            >
                              line
                            </span>
                            <div>
                              <p className="text-sm text-[#1A1A1A]">
                                Crease{typeof cr.spanPct === "number" ? ` · ${Math.round(cr.spanPct)}%` : ""}
                              </p>
                              <p className="text-xs text-[#888888]">{cr.side}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </Section>
              )}

              {/* Ownership Status */}
              <Section title="Ownership">
                {provenance.ownershipStatus === "unclaimed" ? (
                  <div className="bg-[#FFF9E6] border border-[#D4AF37]/30 rounded-lg p-5 text-center">
                    <p className="text-[#B8960C] text-sm font-bold uppercase tracking-wider mb-2">
                      Unclaimed Certificate
                    </p>
                    <p className="text-[#888888] text-xs mb-4">
                      This certificate has not been registered to an owner yet.
                    </p>
                    <a
                      href={`/claim?certId=${encodeURIComponent(data.certId)}`}
                      className="inline-flex items-center gap-2 bg-[#D4AF37] hover:bg-[#B8960C] text-[#1A1400] text-sm font-bold uppercase tracking-wider px-6 py-2.5 rounded-lg transition-colors"
                    >
                      Claim This Certificate
                    </a>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-[#16A34A]" />
                      <span className="text-[#16A34A] text-sm font-bold">Verified Ownership</span>
                    </div>
                    {data.ownerDisplayName && (
                      <p className="text-xs text-[#888888] mt-2" data-testid="logbook-owner-display-name">
                        Owned by {data.ownerDisplayName}
                      </p>
                    )}
                  </>
                )}
              </Section>

              {/* Share — Instagram feed/story image + caption (numeric grades only;
                  the share render needs a numeric grade for the badge) */}
              {!grades.isNonNumeric && (
                <Section title="Share">
                  <ShareStudio
                    certNumber={data.certId}
                    cardName={titleCase(card.name)}
                    grade={
                      typeof grades.overall === "number" ? grades.overall : parseFloat(String(grades.overall)) || 0
                    }
                    tier={grades.gradeLabel}
                  />
                </Section>
              )}

              {/* Provenance */}
              <Section title="Provenance">
                <div className="space-y-0">
                  {provenance.issuedAt && (
                    <Field
                      label="Certificate Issued"
                      value={new Date(provenance.issuedAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                    />
                  )}
                  {provenance.gradedAt && (
                    <Field
                      label="Grade Approved"
                      value={new Date(provenance.gradedAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                    />
                  )}
                  {provenance.nfcEnabled && <Field label="NFC Enabled" value="Yes" />}
                  {provenance.nfcScanCount > 0 && <Field label="NFC Scans" value={String(provenance.nfcScanCount)} />}
                  {provenance.stolenStatus && <Field label="Stolen Flag" value="REPORTED STOLEN" />}
                </div>
              </Section>

              {/* Ownership Chain */}
              <Section title="Ownership History">
                {!data.ownership || data.ownership.chain.length === 0 ? (
                  <p className="text-sm text-[#888888]">
                    Awaiting first owner — claim this card to begin its registry history
                  </p>
                ) : (
                  <>
                    {data.ownership.chain.length > 1 && (
                      <p className="text-sm text-[#888888] mb-4">
                        {data.ownership.chain.length - 1} previous owner
                        {data.ownership.chain.length - 1 !== 1 ? "s" : ""}
                      </p>
                    )}
                    <div className="space-y-3">
                      {data.ownership.chain.map((owner) => (
                        <div key={owner.ownerNumber} className="flex items-start gap-3">
                          <div
                            className={`w-3 h-3 rounded-full mt-1 shrink-0 ${owner.isCurrent ? "bg-[#D4AF37]" : "border border-[#E8E4DC]"}`}
                          />
                          <div>
                            <p className="text-sm text-[#1A1A1A]">
                              Owner {owner.ownerNumber}
                              {owner.displayName && <span className="text-[#888888]"> — {owner.displayName}</span>}
                            </p>
                            <p className="text-xs text-[#888888]">
                              {new Date(owner.claimedAt).toLocaleDateString("en-GB", {
                                day: "numeric",
                                month: "short",
                                year: "numeric",
                              })}
                              {owner.releasedAt
                                ? ` to ${new Date(owner.releasedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} (${owner.durationDays} days)`
                                : " (Current)"}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </Section>
            </>
          )}

          {/* ACTIONS tab (admin only) — admin operations on this cert */}
          {isAdminView && adminTab === "actions" && (
            <Section title="Admin Actions">
              <AdminReprocessButton certId={data.certId} />
              <p className="mt-2 text-[10px] text-[#888888]">
                Re-runs deskew → detect → recentre → tightenForDisplay → whitewash → rounded mask on the R2 originals
                (grading_{`{front,back}`}_original.jpg) and overwrites the display image keys. Refreshes the image
                viewer in place.
              </p>
            </Section>
          )}

          {/* POPULATION tab (admin only) — pop-report panel */}
          {isAdminView && adminTab === "population" && <AdminPopReportPanel certId={data.certId} />}

          {/* Footer — ACTIONS tab (admin) / always (public). The PDF
              download buttons + signature block read as "actions" the
              admin or owner can take. */}
          {(!isAdminView || adminTab === "actions") && (
            <>
              <GoldDivider />

              {/* Footer — Verification + Download */}
              <div className="text-center py-8">
                <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-xl p-6 mb-6">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-[#D4AF37] mb-3">Digital Signature</p>
                  <p className="font-mono text-xs text-[#555555] break-all mb-2">
                    {verification.signature || "\u2014"}
                  </p>
                  <p className="text-[10px] text-[#888888]">
                    Cryptographic hash covering certificate ID, card identity, and all grade data. Any modification
                    invalidates this signature.
                  </p>
                </div>

                <div className="flex flex-col items-center gap-3">
                  <a
                    href={`/cert/${data.certId}.pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-sm font-bold uppercase tracking-wider px-8 py-3 rounded-lg hover:opacity-90 transition-opacity"
                  >
                    <Download className="w-4 h-4" /> Download Logbook PDF
                  </a>
                  {isOwner && (
                    <>
                      <a
                        href={`/logbook/${data.certId}/owner.pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 border border-[#D4AF37]/40 text-[#D4AF37] text-xs font-bold uppercase tracking-wider px-6 py-2 rounded-lg hover:bg-[#D4AF37]/10 transition-colors"
                      >
                        <Lock className="w-3 h-3" /> Download Owner Copy (with Reference Number)
                      </a>
                      <a
                        href={`/transfer?certId=${encodeURIComponent(data.certId)}`}
                        className="inline-flex items-center gap-2 border border-[#E8E4DC] text-[#888888] text-xs font-bold uppercase tracking-wider px-6 py-2 rounded-lg hover:border-[#D4AF37]/40 hover:text-[#D4AF37] transition-colors"
                      >
                        <ArrowRightLeft className="w-3 h-3" /> Transfer Keepership
                      </a>
                    </>
                  )}
                </div>

                <p className="text-[#888888] text-[10px] mt-8 max-w-md mx-auto leading-relaxed">
                  This Ownership Logbook is an official record issued by Mint Vault UK Ltd. The cryptographic signature
                  covers the certificate ID, card identity, and all grade data. Any modification to the underlying data
                  will invalidate the signature.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
