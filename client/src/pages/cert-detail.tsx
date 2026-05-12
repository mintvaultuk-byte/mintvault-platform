import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Shield, Award, Calendar, Layers, Hash, Globe, Tag, CheckCircle, XOctagon, FileText, Wifi, ChevronDown, ChevronUp, ClipboardList, ExternalLink } from "lucide-react";
import type { PublicCertificate, PopulationData } from "@shared/schema";
import { isNonNumericGrade } from "@shared/schema";
import SeoHead, { SITE_URL } from "@/components/seo-head";

const CERT_URL_BASE = "https://mintvaultuk.com/cert/";

function gradeColor(grade: number): string {
  if (grade >= 10) return "text-emerald-400";
  if (grade >= 9) return "text-[#D4AF37]";
  if (grade >= 8) return "text-blue-400";
  return "text-[#999999]";
}

function gameGradient(game: string | null | undefined): string {
  const g = (game ?? "").toLowerCase();
  if (g.includes("pokémon") || g.includes("pokemon"))
    return "radial-gradient(ellipse at top, rgba(227,53,13,0.07) 0%, transparent 70%)";
  if (g.includes("yu-gi-oh") || g.includes("yugioh"))
    return "radial-gradient(ellipse at top, rgba(123,45,139,0.08) 0%, transparent 70%)";
  if (g.includes("magic"))
    return "radial-gradient(ellipse at top, rgba(26,111,181,0.08) 0%, transparent 70%)";
  if (g.includes("one piece"))
    return "radial-gradient(ellipse at top, rgba(232,65,24,0.07) 0%, transparent 70%)";
  return "radial-gradient(ellipse at top, rgba(212,175,55,0.07) 0%, transparent 70%)";
}

function spawnConfetti(container: HTMLElement) {
  const colors = ["#D4AF37", "#FFD700", "#FFF8DC", "#B8960C", "#FFFACD"];
  for (let i = 0; i < 60; i++) {
    const el = document.createElement("div");
    const size = 6 + Math.random() * 8;
    el.className = "confetti-particle";
    el.style.cssText = [
      `left:${10 + Math.random() * 80}%`,
      `width:${size}px`,
      `height:${size * (0.5 + Math.random())}px`,
      `background:${colors[Math.floor(Math.random() * colors.length)]}`,
      `border-radius:${Math.random() > 0.5 ? "50%" : "2px"}`,
      `animation-duration:${1.5 + Math.random() * 1.5}s`,
      `animation-delay:${Math.random() * 0.6}s`,
    ].join(";");
    container.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }
}

function useGradeReveal(target: number | null): number | null {
  const [displayed, setDisplayed] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (target == null) return;
    setDisplayed(null);
    setRevealed(false);
    const timer = setTimeout(() => {
      setRevealed(true);
      if (target <= 1) { setDisplayed(target); return; }
      let current = 1;
      const step = () => {
        setDisplayed(current);
        if (current < target) {
          current = Math.min(current + 1, target);
          setTimeout(step, current >= target - 1 ? 120 : 60);
        }
      };
      step();
    }, 1000);
    return () => clearTimeout(timer);
  }, [target]);

  return revealed ? displayed : null;
}

/* ── QR code hook ─────────────────────────────────────── */
function useQrDataUrl(url: string): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    import("qrcode").then((QRCode) => {
      QRCode.toDataURL(url, {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#1a1100", light: "#ffffff" },
      }).then((du) => { if (alive) setDataUrl(du); });
    });
    return () => { alive = false; };
  }, [url]);
  return dataUrl;
}

/* ── Grading Report expandable panel ─────────────────── */
function GradingReportPanel({
  report,
}: {
  report: { centering?: string; corners?: string; edges?: string; surface?: string; overall?: string };
}) {
  const [open, setOpen] = useState(false);
  const entries = [
    { key: "centering", label: "Centering", val: report.centering },
    { key: "corners",   label: "Corners",   val: report.corners },
    { key: "edges",     label: "Edges",     val: report.edges },
    { key: "surface",   label: "Surface",   val: report.surface },
    { key: "overall",   label: "Overall",   val: report.overall },
  ].filter((e) => e.val?.trim());

  return (
    <div className="mt-5 pt-4 border-t border-[#D4AF37]/15" data-testid="section-grading-report">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between w-full text-left group"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <ClipboardList size={14} className="text-[#D4AF37]/60 shrink-0" />
          <p className="text-[#D4AF37]/60 text-xs uppercase tracking-widest">Grading Report</p>
        </div>
        {open
          ? <ChevronUp size={14} className="text-[#D4AF37]/40 group-hover:text-[#D4AF37]/70 transition-colors" />
          : <ChevronDown size={14} className="text-[#D4AF37]/40 group-hover:text-[#D4AF37]/70 transition-colors" />}
      </button>
      {open && (
        <div className="mt-3 space-y-3" data-testid="grading-report-body">
          {entries.map(({ key, label, val }) => (
            <div key={key}>
              <p className="text-[#D4AF37]/50 text-[10px] uppercase tracking-wider mb-0.5">{label}</p>
              <p className="text-[#444444] text-sm leading-relaxed" data-testid={`text-report-${key}`}>{val}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main page ────────────────────────────────────────── */
export default function CertDetailPage() {
  const [, params] = useRoute("/cert/:id");
  const certId = params?.id || "";

  const { data: cert, isLoading, error } = useQuery<PublicCertificate>({
    queryKey: ["/api/cert", certId],
    enabled: !!certId,
  });

  const screenQrDataUrl = useQrDataUrl(certId ? `${CERT_URL_BASE}${certId}` : "");

  // Grade reveal: count-up animation with 1s delay
  const gradeNumericTarget = cert && !isNonNumericGrade(cert.gradeType) ? cert.gradeNumeric : null;
  const displayedGrade = useGradeReveal(gradeNumericTarget);

  // Confetti ref — spawned once when grade=10 is finally displayed
  const confettiContainerRef = useRef<HTMLDivElement | null>(null);
  const confettiFiredRef = useRef(false);
  useEffect(() => {
    if (displayedGrade === 10 && !confettiFiredRef.current && confettiContainerRef.current) {
      confettiFiredRef.current = true;
      spawnConfetti(confettiContainerRef.current);
    }
  }, [displayedGrade]);

  if (isLoading) {
    return (
      <div className="px-4 py-12 max-w-2xl mx-auto text-center flex flex-col items-center gap-4">
        <div className="pokeball-spinner" aria-label="Loading…" />
        <p className="text-[#999999] text-sm">Verifying certificate…</p>
      </div>
    );
  }

  if (error || !cert) {
    return (
      <div className="px-4 py-12 max-w-2xl mx-auto text-center">
        <Shield className="mx-auto text-[#D4AF37]/30 mb-4" size={48} />
        <h2 className="text-2xl font-bold text-[#D4AF37] mb-2 glow-gold-sm" data-testid="text-cert-not-found">
          Certificate Not Found
        </h2>
        <p className="text-[#666666] mb-6" data-testid="text-cert-not-found-desc">
          No certificate exists with ID: <span className="font-mono text-[#1A1A1A]">{certId}</span>
        </p>
        <Link href="/verify">
          <button
            className="border border-[#D4AF37] bg-white text-[#D4AF37] px-6 py-2.5 rounded font-medium tracking-wide transition-all hover:bg-[#D4AF37]/10"
            data-testid="button-back-to-lookup"
          >
            Back to Lookup
          </button>
        </Link>
      </div>
    );
  }

  const isNonNum = isNonNumericGrade(cert.gradeType);

  const certTitle = `${cert.cardName} – ${cert.grade} | MintVault Certificate ${cert.certId}`;
  const certDesc = `Verify MintVault certificate ${cert.certId}: ${cert.cardName} from ${cert.cardSet} (${cert.cardYear}), grade ${cert.grade}. Authenticated by MintVault UK.`;
  const certCanonical = `${SITE_URL}/cert/${cert.certId}`;
  const certSchema = {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": cert.cardName,
    "description": certDesc,
    "url": certCanonical,
    "brand": { "@type": "Brand", "name": "MintVault UK" },
    "additionalProperty": [
      { "@type": "PropertyValue", "name": "Certificate ID", "value": cert.certId },
      { "@type": "PropertyValue", "name": "Grade", "value": cert.grade },
      { "@type": "PropertyValue", "name": "Set", "value": cert.cardSet },
      { "@type": "PropertyValue", "name": "Year", "value": cert.cardYear },
    ],
  };

  return (
    <div className="px-4 py-8 max-w-3xl mx-auto" style={{ background: gameGradient(cert.cardGame) }}>
        <SeoHead
          title={certTitle}
          description={certDesc}
          canonical={certCanonical}
          ogType="product"
          schema={certSchema}
          ogImage={cert.frontImageUrl || undefined}
        />

        {/* Back link + action buttons row */}
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <Link href="/verify" className="inline-flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors text-sm" data-testid="link-back-lookup">
            <ArrowLeft size={16} />
            Back to Lookup
          </Link>
        </div>

        {cert.status === "voided" && (
          <div className="border border-red-300 bg-red-50 rounded-lg p-4 mb-4 flex items-center gap-3" data-testid="banner-voided">
            <XOctagon className="text-red-400 shrink-0" size={24} />
            <div>
              <p className="text-red-400 font-bold tracking-wider text-sm uppercase">VOIDED</p>
              <p className="text-red-400/70 text-xs">This certificate has been voided and is no longer valid.</p>
            </div>
          </div>
        )}

        <div className={`border rounded-lg overflow-hidden ${cert.status === "voided" ? "border-red-500/20 opacity-70" : "border-[#D4AF37]/30"}`}>
          <div className={`p-6 border-b ${cert.status === "voided" ? "bg-gradient-to-r from-red-500/10 to-transparent border-red-500/20" : "bg-gradient-to-r from-[#D4AF37]/10 to-transparent border-[#D4AF37]/20"}`}>
            <div className="flex items-center gap-2 mb-1">
              <Shield className={cert.status === "voided" ? "text-red-400" : "text-[#D4AF37]"} size={20} />
              <span className={`text-xs uppercase tracking-widest ${cert.status === "voided" ? "text-red-400/60" : "text-[#D4AF37]/60"}`}>
                {cert.status === "voided" ? "Voided Certificate" : "Verified Certificate"}
              </span>
            </div>
            <h1 className={`font-mono text-xl font-bold tracking-wider ${cert.status === "voided" ? "text-red-400 line-through" : "text-[#D4AF37] glow-gold-sm"}`} data-testid="text-cert-id">
              {cert.certId}
            </h1>
          </div>

          {(cert.frontImageUrl || cert.backImageUrl) && (
            <div className="p-6 border-b border-[#D4AF37]/20">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {cert.frontImageUrl && (
                  <div className="text-center">
                    <p className="text-[#D4AF37]/40 text-xs uppercase tracking-wider mb-2">Front</p>
                    <img
                      src={cert.frontImageUrl}
                      alt={`${cert.cardName} front`}
                      className="max-h-80 mx-auto rounded border border-[#D4AF37]/20 object-contain bg-[#FAFAF8]"
                      data-testid="img-card-front"
                    />
                  </div>
                )}
                {cert.backImageUrl && (
                  <div className="text-center">
                    <p className="text-[#D4AF37]/40 text-xs uppercase tracking-wider mb-2">Back</p>
                    <img
                      src={cert.backImageUrl}
                      alt={`${cert.cardName} back`}
                      className="max-h-80 mx-auto rounded border border-[#D4AF37]/20 object-contain bg-[#FAFAF8]"
                      data-testid="img-card-back"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="p-6 relative">
            {/* Confetti container — absolutely positioned so particles fly over the card */}
            <div ref={confettiContainerRef} className="absolute inset-0 pointer-events-none overflow-hidden rounded-b-lg" aria-hidden="true" />

            {isNonNum ? (
              <div className="text-center mb-8">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <CheckCircle className="text-[#D4AF37]" size={28} />
                </div>
                <div className="text-3xl font-bold text-[#D4AF37] mb-1" data-testid="text-grade-label">
                  {cert.grade}
                </div>
                {cert.gradeType === "AA" && (
                  <div className="text-amber-400/80 text-sm tracking-wider uppercase mt-1" data-testid="text-grade-status">
                    Status: Altered
                  </div>
                )}
                <p className="text-[#999999] text-xs mt-2">No Numerical Grade</p>
              </div>
            ) : (
              <div className="text-center mb-8">
                {/* Card name/set fades in immediately; grade counts up after 1s */}
                <div className="mb-4 opacity-0 animate-[fadeIn_0.6s_ease_0.1s_forwards]"
                  style={{ animation: "fadeIn 0.6s ease 0.1s forwards" }}>
                  <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`}</style>
                  <p className="text-[#1A1A1A] font-semibold text-base">{cert.cardName}</p>
                  <p className="text-[#999999] text-xs mt-0.5">{cert.cardSet} · {cert.cardYear}</p>
                </div>
                {displayedGrade == null ? (
                  <div className="text-6xl font-bold text-[#D4AF37]/20 mb-1 select-none" aria-hidden="true">—</div>
                ) : (
                  <div
                    key={displayedGrade}
                    className={`text-6xl font-bold ${gradeColor(cert.gradeNumeric)} mb-1 grade-count-anim${displayedGrade === 10 ? " grade-gem-glow" : ""}`}
                    data-testid="text-grade-numeric"
                  >
                    {displayedGrade}
                  </div>
                )}
                <div className="text-[#D4AF37] font-semibold tracking-widest text-sm" data-testid="text-grade-label">
                  {displayedGrade != null ? cert.grade : "\u00a0"}
                </div>

                {/* Subgrades (screen) */}
                {(cert.gradeCentering != null || cert.gradeCorners != null || cert.gradeEdges != null || cert.gradeSurface != null) && (
                  <div className="mt-4 grid grid-cols-4 gap-2 max-w-xs mx-auto">
                    {[
                      { label: "Centering", val: cert.gradeCentering },
                      { label: "Corners", val: cert.gradeCorners },
                      { label: "Edges", val: cert.gradeEdges },
                      { label: "Surface", val: cert.gradeSurface },
                    ].map(({ label, val }) => val != null && (
                      <div key={label} className="border border-[#D4AF37]/20 rounded p-2 text-center">
                        <div className="text-[#D4AF37] text-sm font-bold" data-testid={`text-subgrade-${label.toLowerCase()}`}>{val}</div>
                        <div className="text-[#999999] text-[10px] mt-0.5">{label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-4">
              <DetailRow icon={<Award size={16} />} label="Card" value={cert.cardName} testId="text-card-name" />
              <DetailRow icon={<Layers size={16} />} label="Set" value={`${cert.cardSet} (${cert.cardYear})`} testId="text-card-set" />
              {cert.collection && <DetailRow icon={<Layers size={16} />} label="Collection / Subset" value={cert.collection} testId="text-collection" />}
              <DetailRow icon={<Hash size={16} />} label="Card Number" value={cert.cardNumber} testId="text-card-number" />
              {(cert.rarityLabel || cert.rarity) && <DetailRow icon={<Tag size={16} />} label="Rarity" value={cert.rarityLabel || cert.rarity || ""} testId="text-rarity" />}
              {cert.designations && cert.designations.length > 0 && (
                <DetailRow icon={<Tag size={16} />} label="Designations" value={cert.designations.join(", ")} testId="text-designations" />
              )}
              {cert.variant && <DetailRow icon={<Tag size={16} />} label="Variant" value={cert.variant} testId="text-variant" />}
              <DetailRow icon={<Globe size={16} />} label="Language" value={cert.language} testId="text-language" />
              {cert.cardGame && <DetailRow icon={<Layers size={16} />} label="Game" value={cert.cardGame} testId="text-card-game" />}
              <DetailRow icon={<Calendar size={16} />} label="Date Graded" value={cert.gradedDate ? new Date(cert.gradedDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : cert.gradedDate} testId="text-graded-date" />
            </div>

            {cert.notes && cert.notes.trim() && (
              <div className="mt-5 pt-4 border-t border-[#D4AF37]/15" data-testid="section-grader-notes">
                <div className="flex items-center gap-2 mb-3">
                  <FileText size={14} className="text-[#D4AF37]/60 shrink-0" />
                  <p className="text-[#D4AF37]/60 text-xs uppercase tracking-widest">Grader Notes</p>
                </div>
                <div className="space-y-1.5">
                  {cert.notes.split("\n").filter((l) => l.trim()).map((line, i) => (
                    <p key={i} className="text-[#444444] text-sm leading-relaxed" data-testid={`text-grader-note-${i}`}>
                      {line.trim()}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Grading Report — expandable, only shown when at least one field has content */}
            {cert.gradingReport && Object.values(cert.gradingReport).some(Boolean) && (
              <GradingReportPanel report={cert.gradingReport} />
            )}

            {/* View Full Grading Report — shown when certificate has a grade */}
            {(cert.gradeNumeric > 0 || isNonNumericGrade(cert.gradeType)) && (
              <div className="mt-5 pt-4 border-t border-[#D4AF37]/15">
                <Link
                  href={`/cert/${cert.certId}/report`}
                  className="flex items-center justify-between w-full rounded-xl border border-[#D4AF37]/30 bg-[#D4AF37]/5 px-4 py-3 hover:bg-[#D4AF37]/10 transition-all group"
                  data-testid="link-view-report"
                >
                  <div className="flex items-center gap-3">
                    <FileText size={16} className="text-[#D4AF37]" />
                    <div>
                      <p className="text-[#D4AF37] text-xs font-bold uppercase tracking-widest">View Full Grading Report</p>
                      <p className="text-[#999999] text-[10px] mt-0.5">Images, subgrades, defects & authentication</p>
                    </div>
                  </div>
                  <ExternalLink size={14} className="text-[#D4AF37]/50 group-hover:text-[#D4AF37] transition-colors" />
                </Link>
              </div>
            )}

            {/* QR verification widget */}
            <div className="mt-6 pt-5 border-t border-[#D4AF37]/15 flex flex-col items-center gap-3" data-testid="section-qr-verify">
              <p className="text-[#D4AF37]/50 text-xs uppercase tracking-widest">Verify Online</p>
              <div className="qr-wrapper">
                <div className="qr-frame">
                  {screenQrDataUrl ? (
                    <div className="qr-box">
                      <img src={screenQrDataUrl} alt={`QR code for certificate ${cert.certId}`} data-testid="img-qr-code" />
                    </div>
                  ) : (
                    <div className="qr-box" style={{ width: 152, height: 152, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <div className="animate-pulse w-full h-full bg-gray-100 rounded" />
                    </div>
                  )}
                </div>
                <p className="qr-id font-mono tracking-widest" data-testid="text-qr-cert-id">{cert.certId}</p>
              </div>
              {cert.nfcEnabled && cert.nfcScanCount != null && (
                <div className="flex items-center gap-1.5 text-[#D4AF37]/40 text-xs" data-testid="text-nfc-scan-count">
                  <Wifi size={11} />
                  <span>
                    NFC scanned {cert.nfcScanCount} {cert.nfcScanCount === 1 ? "time" : "times"}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        <PopulationSection certId={cert.certId} />

      </div>
  );
}

function PopulationSection({ certId }: { certId: string }) {
  const queryUrl = `/api/cert/${certId}/population`;

  const { data: pop, isLoading } = useQuery<PopulationData>({
    queryKey: ["/api/cert", certId, "population"],
    queryFn: async () => {
      const res = await fetch(queryUrl);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!certId,
  });

  if (isLoading) {
    return (
      <div className="mt-6 border border-[#D4AF37]/20 rounded-lg p-6 animate-pulse">
        <div className="h-6 bg-[#D4AF37]/10 rounded w-48 mb-4" />
        <div className="h-32 bg-[#D4AF37]/5 rounded" />
      </div>
    );
  }

  if (!pop) return null;

  return (
    <div className="mt-6 border border-[#D4AF37]/30 rounded-lg overflow-hidden" data-testid="section-population">
      <div className="bg-gradient-to-r from-[#D4AF37]/10 to-transparent p-4 border-b border-[#D4AF37]/20">
        <div className="flex items-center gap-2">
          <Layers size={18} className="text-[#D4AF37]" />
          <h2 className="text-[#D4AF37] font-bold tracking-widest text-sm" data-testid="text-pop-title">POPULATION HIGHLIGHTS</h2>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <PopStat label="Lower Grade" value={pop.lowerCount} testId="text-pop-lower" />
          <PopStat label="Same Grade" value={pop.sameCount} testId="text-pop-same" />
          <PopStat label="Higher Grade" value={pop.higherCount} testId="text-pop-higher" />
          <PopStat label="Total Submitted" value={pop.totalCount} testId="text-pop-total" />
        </div>

        {(pop.authenticOnlyCount > 0 || pop.authenticAlteredCount > 0) && (
          <div className="grid grid-cols-2 gap-3 mb-6">
            <PopStat label="Authentic Only" value={pop.authenticOnlyCount} testId="text-pop-auth-only" />
            <PopStat label="Authentic Altered" value={pop.authenticAlteredCount} testId="text-pop-auth-altered" />
          </div>
        )}

        {pop.gradeDistribution && pop.totalCount > 0 && (
          <div>
            <p className="text-[#D4AF37]/50 text-xs uppercase tracking-wider mb-3">Grade Distribution (1–10)</p>
            <PopGradeChart data={pop.gradeDistribution} />
          </div>
        )}
      </div>
    </div>
  );
}

function PopStat({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div className="text-center border border-[#D4AF37]/15 rounded-lg p-3">
      <p className="text-2xl font-bold text-[#D4AF37]" data-testid={testId}>{value}</p>
      <p className="text-[#999999] text-xs uppercase tracking-wider mt-1">{label}</p>
    </div>
  );
}

function PopGradeChart({ data }: { data: { grade: number; count: number }[] }) {
  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <div className="flex items-end gap-2 h-32" data-testid="chart-pop-grades">
      {data.map((d) => (
        <div key={d.grade} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
          <span className="text-[#D4AF37] text-xs font-bold">{d.count > 0 ? d.count : ""}</span>
          <div
            className="w-full bg-[#D4AF37]/30 rounded-t transition-all"
            style={{ height: `${Math.max((d.count / maxCount) * 100, d.count > 0 ? 8 : 2)}%` }}
          />
          <span className="text-[#999999] text-xs">{d.grade}</span>
        </div>
      ))}
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[#E8E4DC] pb-3">
      <div className="flex items-center gap-2 text-[#D4AF37]/60">
        {icon}
        <span className="text-sm uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-[#1A1A1A] font-medium" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
