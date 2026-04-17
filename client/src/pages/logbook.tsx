import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Shield, Download, Lock, ExternalLink, Check, X, ChevronDown, ChevronUp, ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import SeoHead from "@/components/seo-head";

interface LogbookData {
  certId: string;
  currentOwnerUserId?: string | null;
  ownerEmail?: string | null;
  card: { name: string | null; set: string | null; number: string | null; year: string | null; game: string | null; variant: string | null; language: string; rarity: string | null; collection: string | null; designations: string[] };
  grades: { overall: number | string; gradeLabel: string; centering: number | null; corners: number | null; edges: number | null; surface: number | null; isBlackLabel: boolean; isNonNumeric: boolean; gradeType: string; labelType: string };
  centering: { frontLR: string | null; frontTB: string | null; backLR: string | null; backTB: string | null };
  authentication: { status: string; notes: string | null };
  defects: Array<{ id: number; type: string; location: string; severity: string; description: string }>;
  gradingReport: { centering: string | null; corners: string | null; edges: string | null; surface: string | null; overall: string | null };
  images: { front: string | null; back: string | null };
  population: any;
  provenance: { issuedAt: string | null; gradedAt: string | null; ownershipStatus: string; nfcEnabled: boolean; nfcScanCount: number; stolenStatus: string | null };
  verification: { signature: string | null; signedAt: string; verifyUrl: string };
  ownership: { previousOwnersCount: number; currentOwnerNumber: number; chain: Array<{ ownerNumber: number; displayName: string | null; claimedAt: string; releasedAt: string | null; durationDays: number | null; isCurrent: boolean; claimMethod: string }> };
}

function safe(v: any, fallback = "\u2014"): string {
  if (v === null || v === undefined || v === "") return fallback;
  return String(v);
}

function titleCase(s: string | null | undefined): string {
  if (!s) return "\u2014";
  // Special cases
  const specials: Record<string, string> = { pokemon: "Pok\u00e9mon", "pokémon": "Pok\u00e9mon" };
  return s.split(" ").map(w => specials[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");
}

function GoldDivider() {
  return <div className="h-px bg-gradient-to-r from-transparent via-[#D4AF37]/40 to-transparent my-8" />;
}

function SubgradeBox({ label, value }: { label: string; value: number | string | null }) {
  const v = value !== null && value !== undefined ? String(value) : "\u2014";
  const num = typeof value === "number" ? value : parseFloat(String(value));
  const color = isNaN(num) ? "text-[#888888]" : num >= 10 ? "text-[#D4AF37]" : num >= 8 ? "text-[#16A34A]" : num >= 6 ? "text-[#CA8A04]" : "text-[#DC2626]";
  return (
    <div className="text-center">
      <p className="text-[10px] uppercase tracking-[0.15em] text-[#888888] mb-1">{label}</p>
      <p className={`text-2xl font-black ${color}`}>{v}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-12">
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

export default function LogbookPage() {
  const params = useParams<{ certId?: string; id?: string }>();
  const certId = params.certId || params.id || "";
  const [showDefects, setShowDefects] = useState(false);

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
      } catch { return null; }
    },
  });
  const isOwner = !!(me?.email && data?.ownerEmail && me.email.toLowerCase() === data.ownerEmail.toLowerCase());

  if (isLoading) return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-[#888888] text-sm">Loading logbook...</p>
      </div>
    </div>
  );

  if (error || !data) return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="text-center">
        <Shield className="w-12 h-12 text-[#E8E4DC] mx-auto mb-4" />
        <p className="text-[#555555] text-lg mb-2">Certificate Not Found</p>
        <p className="text-[#888888] text-sm">The certificate {certId} could not be verified.</p>
      </div>
    </div>
  );

  const { card, grades, centering, authentication, defects, gradingReport, images, provenance, verification } = data;

  return (
    <>
      <SeoHead
        title={`${titleCase(card.name)} — Grade ${safe(grades.overall)} | MintVault Logbook`}
        description={`Official MintVault Ownership Logbook for ${titleCase(card.name)} (${safe(card.set)}). Grade: ${safe(grades.overall)} ${grades.gradeLabel}. Certificate ${data.certId}.`}
        canonical={`/vault/${data.certId}`}
      />

      <div className="min-h-screen bg-white text-[#1A1A1A]">
        {/* Cover Hero */}
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
              <div className="inline-flex items-center justify-center w-28 h-28 rounded-full border-2 border-[#D4AF37]/40 bg-white mb-2" style={{ boxShadow: "0 0 24px rgba(212,175,55,0.12)" }}>
                <span className={`text-5xl font-black ${grades.isBlackLabel ? "text-[#D4AF37]" : grades.isNonNumeric ? "text-amber-500" : "text-[#1A1A1A]"}`}>
                  {safe(grades.overall)}
                </span>
              </div>
              <div className={`text-sm uppercase tracking-[0.2em] font-bold mt-1 ${grades.isBlackLabel ? "text-[#D4AF37]" : "text-[#888888]"}`}>
                {grades.gradeLabel}
              </div>
              {grades.isBlackLabel && (
                <div className="text-[10px] uppercase tracking-[0.3em] text-[#D4AF37] mt-2 animate-pulse">Black Label</div>
              )}
            </div>

            <h1 className="text-3xl md:text-4xl font-black text-[#1A1A1A] mt-4 mb-2">{titleCase(card.name)}</h1>
            <p className="text-[#888888] text-sm">{safe(card.set)} {card.number ? `#${card.number}` : ""} {card.year ? `(${card.year})` : ""}</p>

            <GoldDivider />

            {/* Cert ID */}
            <p className="font-mono text-lg text-[#D4AF37] tracking-wider">{data.certId}</p>
            {provenance.issuedAt && (
              <p className="text-[#888888] text-xs mt-1">Issued {new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</p>
            )}
          </div>
        </section>

        {/* Verification strip */}
        <section className="bg-[#F7F7F5] border-y border-[#E8E4DC] py-4 px-4">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-[#D4AF37]" />
              <span className="text-[10px] uppercase tracking-[0.15em] text-[#D4AF37] font-bold">VaultSeal Verified</span>
            </div>
            <span className="font-mono text-[10px] text-[#888888]">{verification.signature?.slice(0, 16)}...</span>
          </div>
        </section>

        {/* Content sections */}
        <div className="max-w-3xl mx-auto px-4 py-12">

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
          {(grades.centering != null || grades.corners != null || grades.edges != null || grades.surface != null) && (
          <Section title="Grade Analysis">
            <div className="grid grid-cols-4 gap-6 mb-4">
              <SubgradeBox label="Centering" value={grades.centering} />
              <SubgradeBox label="Corners" value={grades.corners} />
              <SubgradeBox label="Edges" value={grades.edges} />
              <SubgradeBox label="Surface" value={grades.surface} />
            </div>
            <p className="text-[10px] text-[#888888] text-center mb-6">Surface 40% · Corners 25% · Edges 25% · Centering 10%</p>

            {/* Centering ratios */}
            {(centering.frontLR || centering.backLR) && (
              <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-4 mb-4">
                <p className="text-[10px] uppercase tracking-[0.15em] text-[#888888] mb-3">Centering Measurement</p>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {centering.frontLR && <div><span className="text-[#888888] text-xs">Front L/R</span> <span className="text-[#1A1A1A] font-mono ml-2">{centering.frontLR}</span></div>}
                  {centering.frontTB && <div><span className="text-[#888888] text-xs">Front T/B</span> <span className="text-[#1A1A1A] font-mono ml-2">{centering.frontTB}</span></div>}
                  {centering.backLR && <div><span className="text-[#888888] text-xs">Back L/R</span> <span className="text-[#1A1A1A] font-mono ml-2">{centering.backLR}</span></div>}
                  {centering.backTB && <div><span className="text-[#888888] text-xs">Back T/B</span> <span className="text-[#1A1A1A] font-mono ml-2">{centering.backTB}</span></div>}
                </div>
              </div>
            )}

            {/* Grader notes */}
            {(gradingReport.overall || gradingReport.centering) && (
              <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-lg p-4">
                <p className="text-[10px] uppercase tracking-[0.15em] text-[#888888] mb-3">Grader Notes</p>
                <div className="text-sm text-[#555555] space-y-2 leading-relaxed">
                  {gradingReport.centering && <p><span className="text-[#888888]">Centering:</span> {gradingReport.centering}</p>}
                  {gradingReport.corners && <p><span className="text-[#888888]">Corners:</span> {gradingReport.corners}</p>}
                  {gradingReport.edges && <p><span className="text-[#888888]">Edges:</span> {gradingReport.edges}</p>}
                  {gradingReport.surface && <p><span className="text-[#888888]">Surface:</span> {gradingReport.surface}</p>}
                  {gradingReport.overall && <p><span className="text-[#888888]">Overall:</span> {gradingReport.overall}</p>}
                </div>
              </div>
            )}
          </Section>
          )}

          {/* Authentication */}
          <Section title="Authentication">
            <div className="flex items-center gap-3">
              {authentication.status === "genuine" ? (
                <><Check className="w-5 h-5 text-[#16A34A]" /><span className="text-[#16A34A] font-bold text-sm">Genuine</span></>
              ) : authentication.status === "authentic_altered" ? (
                <><Shield className="w-5 h-5 text-amber-500" /><span className="text-amber-500 font-bold text-sm">Authentic Altered</span></>
              ) : (
                <><X className="w-5 h-5 text-[#DC2626]" /><span className="text-[#DC2626] font-bold text-sm">Not Original</span></>
              )}
            </div>
            {authentication.notes && <p className="text-[#555555] text-sm mt-3 leading-relaxed">{authentication.notes}</p>}
          </Section>

          {/* Condition / Defects */}
          {defects.length > 0 && (
            <Section title="Condition Report">
              <button onClick={() => setShowDefects(!showDefects)} className="flex items-center gap-2 text-sm text-[#555555] hover:text-[#1A1A1A] transition-colors">
                {defects.length} defect{defects.length !== 1 ? "s" : ""} detected
                {showDefects ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showDefects && (
                <div className="mt-4 space-y-2">
                  {defects.map(d => (
                    <div key={d.id} className="flex items-start gap-3 py-2 border-b border-[#E8E4DC]">
                      <span className={`text-[9px] uppercase px-1.5 py-0.5 rounded border ${
                        d.severity === "minor" ? "text-amber-600 border-amber-200 bg-amber-50" :
                        d.severity === "moderate" ? "text-orange-600 border-orange-200 bg-orange-50" :
                        "text-red-600 border-red-200 bg-red-50"
                      }`}>{d.severity}</span>
                      <div>
                        <p className="text-sm text-[#1A1A1A]">{d.type}</p>
                        <p className="text-xs text-[#888888]">{d.location}{d.description ? ` — ${d.description}` : ""}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Ownership Status */}
          <Section title="Ownership">
            {provenance.ownershipStatus === "unclaimed" ? (
              <div className="bg-[#FFF9E6] border border-[#D4AF37]/30 rounded-lg p-5 text-center">
                <p className="text-[#B8960C] text-sm font-bold uppercase tracking-wider mb-2">Unclaimed Certificate</p>
                <p className="text-[#888888] text-xs mb-4">This certificate has not been registered to an owner yet.</p>
                <a href={`/claim?certId=${encodeURIComponent(data.certId)}`}
                  className="inline-flex items-center gap-2 bg-[#D4AF37] hover:bg-[#B8960C] text-[#1A1400] text-sm font-bold uppercase tracking-wider px-6 py-2.5 rounded-lg transition-colors">
                  Claim This Certificate
                </a>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-[#16A34A]" />
                <span className="text-[#16A34A] text-sm font-bold">Verified Ownership</span>
              </div>
            )}
          </Section>

          {/* Provenance */}
          <Section title="Provenance">
            <div className="space-y-0">
              {provenance.issuedAt && <Field label="Certificate Issued" value={new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} />}
              {provenance.gradedAt && <Field label="Grade Approved" value={new Date(provenance.gradedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} />}
              {provenance.nfcEnabled && <Field label="NFC Enabled" value="Yes" />}
              {provenance.nfcScanCount > 0 && <Field label="NFC Scans" value={String(provenance.nfcScanCount)} />}
              {provenance.stolenStatus && <Field label="Stolen Flag" value="REPORTED STOLEN" />}
            </div>
          </Section>

          {/* Ownership Chain */}
          {data.ownership && data.ownership.chain.length > 0 && (
            <Section title="Ownership History">
              <p className="text-sm text-[#888888] mb-4">
                {data.ownership.previousOwnersCount > 0
                  ? `${data.ownership.previousOwnersCount} previous owner${data.ownership.previousOwnersCount !== 1 ? "s" : ""}`
                  : "Original owner"}
              </p>
              <div className="space-y-3">
                {data.ownership.chain.map(owner => (
                  <div key={owner.ownerNumber} className="flex items-start gap-3">
                    <div className={`w-3 h-3 rounded-full mt-1 shrink-0 ${owner.isCurrent ? "bg-[#D4AF37]" : "border border-[#E8E4DC]"}`} />
                    <div>
                      <p className="text-sm text-[#1A1A1A]">
                        Owner {owner.ownerNumber}
                        {owner.displayName && <span className="text-[#888888]"> — {owner.displayName}</span>}
                      </p>
                      <p className="text-xs text-[#888888]">
                        {new Date(owner.claimedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                        {owner.releasedAt
                          ? ` to ${new Date(owner.releasedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} (${owner.durationDays} days)`
                          : " (Current)"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <GoldDivider />

          {/* Footer — Verification + Download */}
          <div className="text-center py-8">
            <div className="bg-[#F7F7F5] border border-[#E8E4DC] rounded-xl p-6 mb-6">
              <p className="text-[10px] uppercase tracking-[0.2em] text-[#D4AF37] mb-3">Digital Signature</p>
              <p className="font-mono text-xs text-[#555555] break-all mb-2">{verification.signature || "\u2014"}</p>
              <p className="text-[10px] text-[#888888]">Cryptographic hash covering certificate ID, card identity, and all grade data. Any modification invalidates this signature.</p>
            </div>

            <div className="flex flex-col items-center gap-3">
              <a href={`/cert/${data.certId}.pdf`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] text-sm font-bold uppercase tracking-wider px-8 py-3 rounded-lg hover:opacity-90 transition-opacity">
                <Download className="w-4 h-4" /> Download Logbook PDF
              </a>
              {isOwner && (
                <>
                  <a href={`/logbook/${data.certId}/owner.pdf`} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 border border-[#D4AF37]/40 text-[#D4AF37] text-xs font-bold uppercase tracking-wider px-6 py-2 rounded-lg hover:bg-[#D4AF37]/10 transition-colors">
                    <Lock className="w-3 h-3" /> Download Owner Copy (with Reference Number)
                  </a>
                  <a href={`/transfer?certId=${encodeURIComponent(data.certId)}`}
                    className="inline-flex items-center gap-2 border border-[#E8E4DC] text-[#888888] text-xs font-bold uppercase tracking-wider px-6 py-2 rounded-lg hover:border-[#D4AF37]/40 hover:text-[#D4AF37] transition-colors">
                    <ArrowRightLeft className="w-3 h-3" /> Transfer Keepership
                  </a>
                </>
              )}
            </div>

            <p className="text-[#888888] text-[10px] mt-8 max-w-md mx-auto leading-relaxed">
              This Ownership Logbook is an official record issued by MintVault Ltd. The cryptographic signature covers the certificate ID, card identity, and all grade data. Any modification to the underlying data will invalidate the signature.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
