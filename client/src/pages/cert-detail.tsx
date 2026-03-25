import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useRef } from "react";
import { ArrowLeft, Shield, Award, Calendar, Layers, Hash, Globe, Tag, CheckCircle, XOctagon, FileText, Printer } from "lucide-react";
import type { PublicCertificate, PopulationData } from "@shared/schema";
import { isNonNumericGrade } from "@shared/schema";
import SeoHead, { SITE_URL } from "@/components/seo-head";

const CERT_URL_BASE = "https://mintvaultuk.com/cert/";

function gradeColor(grade: number): string {
  if (grade >= 10) return "text-emerald-400";
  if (grade >= 9) return "text-[#D4AF37]";
  if (grade >= 8) return "text-blue-400";
  return "text-gray-400";
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

/* ── Print certificate view ───────────────────────────── */
function CertPrintView({ cert }: { cert: PublicCertificate }) {
  const certUrl = `${CERT_URL_BASE}${cert.certId}`;
  const qrDataUrl = useQrDataUrl(certUrl);
  const isNonNum = isNonNumericGrade(cert.gradeType);

  const gradeDate = cert.gradedDate
    ? new Date(cert.gradedDate).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    : "—";

  const hasSubgrades =
    cert.gradeCentering != null ||
    cert.gradeCorners != null ||
    cert.gradeEdges != null ||
    cert.gradeSurface != null;

  return (
    <div
      id="cert-print-view"
      style={{
        display: "none",
        position: "relative",
        width: "100%",
        background: "#ffffff",
        color: "#111111",
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        padding: "0",
        overflow: "hidden",
      }}
    >
      {/* Watermark */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%) rotate(-35deg)",
          fontSize: "58px",
          fontWeight: 900,
          color: "rgba(184, 148, 31, 0.055)",
          whiteSpace: "nowrap",
          pointerEvents: "none",
          userSelect: "none",
          letterSpacing: "0.25em",
          textTransform: "uppercase",
          zIndex: 0,
        }}
      >
        MintVault Certified Copy
      </div>

      {/* Content */}
      <div style={{ position: "relative", zIndex: 1, padding: "32px 40px" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: "24px", borderBottom: "2px solid #b8941f", paddingBottom: "20px" }}>
          {/* Logo */}
          <div style={{ marginBottom: "4px" }}>
            <span style={{
              fontSize: "32px",
              fontWeight: 900,
              letterSpacing: "0.25em",
              color: "#b8941f",
              textTransform: "uppercase",
            }}>
              MintVault
            </span>
            <span style={{
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.3em",
              color: "#888",
              textTransform: "uppercase",
              display: "block",
              marginTop: "2px",
            }}>
              Professional Card Grading &amp; Authentication · United Kingdom
            </span>
          </div>
        </div>

        {/* Cert ID + status row */}
        <div className="pv-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "22px" }}>
          <div>
            <div style={{ fontSize: "10px", letterSpacing: "0.2em", color: "#888", textTransform: "uppercase", marginBottom: "3px" }}>
              Certificate ID
            </div>
            <div style={{ fontSize: "22px", fontWeight: 800, fontFamily: "monospace", letterSpacing: "0.08em", color: "#1a1a1a" }}>
              {cert.certId}
            </div>
          </div>
          <div style={{
            padding: "6px 18px",
            border: "2px solid",
            borderColor: cert.status === "voided" ? "#cc2222" : "#b8941f",
            borderRadius: "4px",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: cert.status === "voided" ? "#cc2222" : "#b8941f",
          }}>
            {cert.status === "voided" ? "VOIDED" : "Verified"}
          </div>
        </div>

        {/* Main content: grade + card details + QR */}
        <div className="pv-row" style={{ display: "flex", gap: "32px", alignItems: "flex-start", marginBottom: "28px" }}>

          {/* Left: grade box */}
          <div style={{
            flexShrink: 0,
            width: "140px",
            textAlign: "center",
          }}>
            <div style={{
              border: "3px solid #b8941f",
              borderRadius: "8px",
              padding: "16px 12px",
              background: "linear-gradient(180deg, #fffdf5 0%, #fff8e1 100%)",
              marginBottom: "10px",
            }}>
              {isNonNum ? (
                <>
                  <div style={{ fontSize: "26px", fontWeight: 900, color: "#b8941f", lineHeight: 1 }}>
                    {cert.grade}
                  </div>
                  <div style={{ fontSize: "9px", color: "#888", letterSpacing: "0.15em", marginTop: "4px", textTransform: "uppercase" }}>
                    Non-Numeric
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: "60px", fontWeight: 900, color: "#b8941f", lineHeight: 1 }}>
                    {cert.gradeNumeric}
                  </div>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: "#555", letterSpacing: "0.12em", marginTop: "4px", textTransform: "uppercase" }}>
                    {cert.grade}
                  </div>
                </>
              )}
            </div>

            {/* Subgrades */}
            {hasSubgrades && !isNonNum && (
              <div style={{ border: "1px solid #e8d08a", borderRadius: "6px", padding: "8px 6px", background: "#fffdf5" }}>
                <div style={{ fontSize: "8px", letterSpacing: "0.15em", color: "#888", textTransform: "uppercase", marginBottom: "6px" }}>
                  Subgrades
                </div>
                {[
                  { label: "Centering", val: cert.gradeCentering },
                  { label: "Corners", val: cert.gradeCorners },
                  { label: "Edges", val: cert.gradeEdges },
                  { label: "Surface", val: cert.gradeSurface },
                ].map(({ label, val }) => val != null && (
                  <div key={label} className="pv-row" style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderTop: "1px solid #f0e0a0" }}>
                    <span style={{ fontSize: "9px", color: "#666" }}>{label}</span>
                    <span style={{ fontSize: "10px", fontWeight: 700, color: "#333" }}>{val}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Centre: card details */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {[
                  { label: "Card Name", value: cert.cardName },
                  { label: "Set", value: `${cert.cardSet} (${cert.cardYear})` },
                  { label: "Card Number", value: cert.cardNumber },
                  cert.collection ? { label: "Collection", value: cert.collection } : null,
                  cert.rarityLabel || cert.rarity ? { label: "Rarity", value: cert.rarityLabel || cert.rarity || "" } : null,
                  cert.variant ? { label: "Variant", value: cert.variant } : null,
                  cert.designations && cert.designations.length > 0 ? { label: "Designations", value: cert.designations.join(", ") } : null,
                  { label: "Language", value: cert.language },
                  cert.cardGame ? { label: "Game", value: cert.cardGame } : null,
                  { label: "Date Graded", value: gradeDate },
                ]
                  .filter(Boolean)
                  .map((row, i) => row && (
                    <tr key={i} style={{ borderBottom: "1px solid #f0ead0" }}>
                      <td style={{ padding: "5px 8px 5px 0", fontSize: "10px", letterSpacing: "0.1em", color: "#888", textTransform: "uppercase", whiteSpace: "nowrap", width: "110px" }}>
                        {row.label}
                      </td>
                      <td style={{ padding: "5px 0", fontSize: "12px", fontWeight: 600, color: "#1a1a1a" }}>
                        {row.value}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>

            {/* Grader notes (if any) */}
            {cert.notes && cert.notes.trim() && (
              <div style={{ marginTop: "12px", padding: "10px 12px", background: "#fffdf5", border: "1px solid #e8d08a", borderRadius: "6px" }}>
                <div style={{ fontSize: "9px", letterSpacing: "0.15em", color: "#888", textTransform: "uppercase", marginBottom: "5px" }}>
                  Grader Notes
                </div>
                {cert.notes.split("\n").filter((l) => l.trim()).map((line, i) => (
                  <div key={i} style={{ fontSize: "10px", color: "#444", lineHeight: "1.5" }}>{line.trim()}</div>
                ))}
              </div>
            )}
          </div>

          {/* Right: QR code */}
          <div style={{ flexShrink: 0, textAlign: "center" }}>
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="Verify certificate QR code"
                style={{ width: "110px", height: "110px", display: "block", border: "1px solid #e8d08a", borderRadius: "4px" }}
              />
            ) : (
              <div style={{ width: "110px", height: "110px", border: "1px dashed #ccc", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontSize: "9px", color: "#aaa" }}>QR loading…</span>
              </div>
            )}
            <div style={{ fontSize: "8px", color: "#888", marginTop: "5px", wordBreak: "break-all", maxWidth: "110px" }}>
              Scan to verify
            </div>
          </div>
        </div>

        {/* Divider */}
        <div style={{ borderTop: "1px solid #e8d08a", marginBottom: "16px" }} />

        {/* Footer */}
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "10px", color: "#555", letterSpacing: "0.05em", marginBottom: "4px" }}>
            This certificate is valid only when verified at{" "}
            <span style={{ fontWeight: 700, color: "#b8941f" }}>mintvaultuk.com</span>
          </div>
          <div style={{ fontSize: "9px", color: "#aaa", letterSpacing: "0.05em" }}>
            MintVault UK Ltd · Tamper-evident precision grading · {certUrl}
          </div>
        </div>

      </div>
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

  if (isLoading) {
    return (
      <div className="px-4 py-12 max-w-2xl mx-auto text-center">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#D4AF37]/10 rounded w-64 mx-auto" />
          <div className="h-4 bg-[#D4AF37]/10 rounded w-48 mx-auto" />
          <div className="h-64 bg-[#D4AF37]/5 rounded mt-8" />
        </div>
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
        <p className="text-gray-400 mb-6" data-testid="text-cert-not-found-desc">
          No certificate exists with ID: <span className="font-mono text-white">{certId}</span>
        </p>
        <Link href="/cert">
          <button
            className="border border-[#D4AF37] bg-black text-[#D4AF37] px-6 py-2.5 rounded font-medium tracking-wide transition-all btn-gold-glow hover:bg-[#D4AF37]/10"
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
    <>
      {/* ── Hidden print view – shown only via @media print ── */}
      <CertPrintView cert={cert} />

      {/* ── Screen view ────────────────────────────────────── */}
      <div className="px-4 py-8 max-w-3xl mx-auto">
        <SeoHead
          title={certTitle}
          description={certDesc}
          canonical={certCanonical}
          ogType="product"
          schema={certSchema}
          ogImage={cert.frontImageUrl || undefined}
        />

        {/* Back link + Print button row */}
        <div className="flex items-center justify-between mb-6">
          <Link href="/cert" className="inline-flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors text-sm" data-testid="link-back-lookup">
            <ArrowLeft size={16} />
            Back to Lookup
          </Link>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 border border-[#D4AF37]/40 bg-black text-[#D4AF37]/70 hover:text-[#D4AF37] hover:border-[#D4AF37] px-4 py-2 rounded text-sm font-medium tracking-wide transition-all btn-gold-glow"
            data-testid="button-print-certificate"
          >
            <Printer size={15} />
            Print Certificate
          </button>
        </div>

        {cert.status === "voided" && (
          <div className="border border-red-500/40 bg-red-950/30 rounded-lg p-4 mb-4 flex items-center gap-3" data-testid="banner-voided">
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
                      className="max-h-80 mx-auto rounded border border-[#D4AF37]/20 object-contain bg-gray-900"
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
                      className="max-h-80 mx-auto rounded border border-[#D4AF37]/20 object-contain bg-gray-900"
                      data-testid="img-card-back"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="p-6">
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
                <p className="text-gray-500 text-xs mt-2">No Numerical Grade</p>
              </div>
            ) : (
              <div className="text-center mb-8">
                <div className={`text-6xl font-bold ${gradeColor(cert.gradeNumeric)} mb-1`} data-testid="text-grade-numeric">
                  {cert.gradeNumeric}
                </div>
                <div className="text-[#D4AF37] font-semibold tracking-widest text-sm" data-testid="text-grade-label">
                  {cert.grade}
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
                        <div className="text-gray-500 text-[10px] mt-0.5">{label}</div>
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
              {(cert.rarityLabel || cert.rarity) && <DetailRow icon={<Tag size={16} />} label="Rarity" value={cert.rarityLabel || cert.rarity} testId="text-rarity" />}
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
                    <p key={i} className="text-gray-300 text-sm leading-relaxed" data-testid={`text-grader-note-${i}`}>
                      {line.trim()}
                    </p>
                  ))}
                </div>
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
            </div>
          </div>
        </div>

        <PopulationSection certId={cert.certId} />

        {/* Bottom print button */}
        <div className="mt-6 flex justify-center">
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 border border-[#D4AF37]/30 bg-black text-[#D4AF37]/60 hover:text-[#D4AF37] hover:border-[#D4AF37]/60 px-5 py-2.5 rounded text-sm font-medium tracking-wide transition-all"
            data-testid="button-print-certificate-bottom"
          >
            <Printer size={15} />
            Print Certificate
          </button>
        </div>
      </div>
    </>
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
      <p className="text-gray-500 text-xs uppercase tracking-wider mt-1">{label}</p>
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
          <span className="text-gray-500 text-xs">{d.grade}</span>
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
    <div className="flex items-center justify-between border-b border-[#D4AF37]/10 pb-3">
      <div className="flex items-center gap-2 text-[#D4AF37]/60">
        {icon}
        <span className="text-sm uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-white font-medium" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
