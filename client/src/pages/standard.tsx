/**
 * /standard (alias: /grading-standard) — the public MintVault Grading
 * Standard (MVGS) specification document.
 *
 * Layout pattern: mirrors client/src/pages/terms.tsx (back link, centered
 * gold title, numbered sections with gold h2s). Adapted to a dark
 * background to match the marketing-side pages (/reels, /share/reel)
 * since this page is meant to be referenced/shared by third-party
 * graders adopting MVGS, not buried in the legal section.
 *
 * Static — no DB, no React Query. SEO meta + canonical via SeoHead.
 */

import { Link } from "wouter";
import { ArrowLeft, ExternalLink } from "lucide-react";
import SeoHead from "@/components/seo-head";

// ── Reference tables ──────────────────────────────────────────────────────
// Mirrors shared/mvgs-scoring.ts deductions. Numbers here are static
// documentation; the scoring engine is the source of truth at runtime.

const DEFECT_CODES: Array<{ code: string; label: string }> = [
  { code: "WH", label: "Whitening" },
  { code: "CH", label: "Chip" },
  { code: "FR", label: "Fray" },
  { code: "SC", label: "Scratch (surface)" },
  { code: "SP", label: "Scratch (gloss-penetrating)" },
  { code: "PI", label: "Pit / Dent" },
  { code: "PL", label: "Print Line" },
  { code: "PS", label: "Print Spot" },
  { code: "SV", label: "Silvering (holo)" },
  { code: "ST", label: "Stain" },
  { code: "GL", label: "Gloss Loss" },
  { code: "CR", label: "Crease" },
  { code: "RD", label: "Corner Rounding" },
  { code: "DG", label: "Corner Ding" },
  { code: "OC", label: "Off-centre (noted)" },
];

const CENTERING_FRONT: Array<{ ratio: string; deduction: string }> = [
  { ratio: "≤ 55/45",        deduction: "0" },
  { ratio: "56-60 / 40-44",  deduction: "-2" },
  { ratio: "61-65 / 35-39",  deduction: "-5" },
  { ratio: "66-70 / 30-34",  deduction: "-8" },
  { ratio: "71-75 / 25-29",  deduction: "-12" },
  { ratio: "76-80 / 20-24",  deduction: "-15" },
  { ratio: "81-85 / 15-19",  deduction: "-18" },
  { ratio: "> 85/15",        deduction: "-20" },
];

const CENTERING_BACK: Array<{ ratio: string; deduction: string }> = [
  { ratio: "≤ 75/25",        deduction: "0" },
  { ratio: "76-85 / 15-24",  deduction: "-1" },
  { ratio: "86-90 / 10-14",  deduction: "-3" },
  { ratio: "> 90/10",        deduction: "-5" },
];

// ── Reusable styling helpers ──────────────────────────────────────────────

const sectionTitle = "text-[#D4AF37] font-bold tracking-wider text-lg mb-3";
const subTitle = "text-[#ccc] font-semibold mt-4 mb-2";
const para = "text-[#aaa] text-sm leading-relaxed";
const bullet = "flex items-start gap-2";
const bulletDot = <span className="text-[#D4AF37] mt-0.5">•</span>;
const tableWrap = "overflow-x-auto -mx-4 sm:mx-0";
const tableCls = "w-full text-sm";
const thCls = "text-[#D4AF37] text-[10px] uppercase tracking-widest font-bold text-left py-2 px-4 border-b border-[#D4AF37]/30";
const tdCls = "text-[#ccc] py-2 px-4 border-b border-[#222]";
const codeCls = "font-mono text-[#D4AF37] py-2 px-4 border-b border-[#222]";

export default function StandardPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ccc]">
      <SeoHead
        title="MintVault Grading Standard (MVGS) | MintVault"
        description="The open, transparent grading specification for trading cards. MintVault is the reference implementation and founding body. Free to adopt and self-certify."
        canonical="/standard"
      />

      <div className="px-4 py-10 max-w-3xl mx-auto">
        <Link href="/">
          <button
            className="flex items-center gap-1.5 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors mb-8"
            data-testid="button-back-home"
          >
            <ArrowLeft size={16} /> Back to Home
          </button>
        </Link>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <h1
          className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest mb-3 text-center"
          data-testid="text-standard-title"
        >
          MINTVAULT GRADING STANDARD
        </h1>
        <p className="text-[#888] text-sm text-center mb-2 italic">
          The open, transparent standard for trading card grading.
        </p>
        <p className="text-[#888] text-xs text-center mb-12">
          Published by MintVault UK Ltd.
        </p>

        <div className="space-y-10">
          {/* ── 1. Intro ──────────────────────────────────────────────── */}
          <section>
            <p className={para}>
              MVGS is a free, openly licensed grading specification. Any
              grading company can self-certify MVGS compliance and display the
              "MVGS Compliant" mark. MintVault is the reference implementation
              and founding body — every card we grade ships with a full MVGS
              score, a published defect report, and a 600 DPI scan.
            </p>
          </section>

          {/* ── 2. Compliance Requirements ────────────────────────────── */}
          <section id="compliance">
            <h2 className={sectionTitle}>1. MVGS Compliance Requirements</h2>
            <p className={`${para} mb-4`}>
              To display the "MVGS Compliant" mark, a grading service must:
            </p>
            <ul className="space-y-2.5">
              {[
                "Scan every card at a minimum of 600 DPI front and back before grading.",
                "Inspect each card under a minimum of 10× magnification.",
                "Apply the published MVGS deduction tables when scoring.",
                "Publish a defect report with every certificate — D1 defects annotated on the scan image with their location codes.",
                "Upload the scan to a public URL tied to the cert ID, with zoom capability so anyone can verify the defect map.",
                "Display the 100-point MVGS score alongside the 1–10 grade on every certificate.",
              ].map((item, i) => (
                <li key={i} className={bullet}>
                  {bulletDot}
                  <span className={para}>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ── 3. 100-Point Scoring ──────────────────────────────────── */}
          <section id="scoring">
            <h2 className={sectionTitle}>2. The 100-Point Scoring System</h2>
            <p className={`${para} mb-3`}>
              Every card starts at 100 points. Deductions are applied per
              defect across four categories:
            </p>
            <ul className="space-y-1.5 mb-4 ml-1">
              {[
                ["Centering", "25 points"],
                ["Corners", "25 points"],
                ["Edges", "25 points"],
                ["Surface", "25 points"],
              ].map(([label, weight]) => (
                <li key={label} className={bullet}>
                  {bulletDot}
                  <span className={para}>
                    <strong className="text-[#ccc]">{label}</strong> · {weight}
                  </span>
                </li>
              ))}
            </ul>
            <p className={`${para} mb-3`}>
              The score maps to the familiar 1–10 grade. Within a grade, the
              score shows strength — a 94/100 and a 91/100 are both Gem
              Mint 10, but the score differentiates them:
            </p>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Score</th>
                    <th className={thCls}>Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["96-100", "Pristine 10P"],
                    ["91-95",  "Gem Mint 10"],
                    ["86-90",  "Mint+ 9.5"],
                    ["81-85",  "Mint 9"],
                    ["76-80",  "NM-Mint+ 8.5"],
                    ["71-75",  "NM-Mint 8"],
                    ["66-70",  "NM+ 7.5"],
                    ["61-65",  "Near Mint 7"],
                    ["51-60",  "Excellent-Mint 6"],
                    ["41-50",  "Excellent 5"],
                    ["31-40",  "Very Good-Excellent 4"],
                    ["21-30",  "Good 3"],
                    ["11-20",  "Fair 2"],
                    ["1-10",   "Poor 1"],
                  ].map(([score, grade]) => (
                    <tr key={score}>
                      <td className={codeCls}>{score}</td>
                      <td className={tdCls}>{grade}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={`${para} mt-4`}>
              The 0–100 score is shown on every MintVault certificate beside
              the headline grade.
            </p>
          </section>

          {/* ── 4. Defect Classification (D1/D2/D3) ──────────────────── */}
          <section id="tiers">
            <h2 className={sectionTitle}>3. Defect Classification</h2>
            <p className={`${para} mb-4`}>
              Every defect is classified into one of three tiers:
            </p>
            <div className="space-y-3">
              {[
                { tier: "D1", label: "Grade-Significant", desc: "Directly caused a point deduction and influenced the final grade." },
                { tier: "D2", label: "Observable",        desc: "Documented for the record; minor contribution to the score." },
                { tier: "D3", label: "Factory",           desc: "Manufacturing defect — recorded, but minimised in scoring." },
              ].map((t) => (
                <div
                  key={t.tier}
                  className="border border-[#D4AF37]/20 rounded-lg p-3 flex items-baseline gap-3"
                >
                  <span className="font-mono text-[#D4AF37] text-sm font-bold">{t.tier}</span>
                  <div className="min-w-0">
                    <div className="text-[#ccc] text-sm font-semibold">{t.label}</div>
                    <div className="text-[#888] text-xs mt-0.5">{t.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── 5. Defect Codes ──────────────────────────────────────── */}
          <section id="codes">
            <h2 className={sectionTitle}>4. Defect Type Codes</h2>
            <p className={`${para} mb-4`}>
              Each defect on a certificate is recorded with a two-letter code
              for fast, language-neutral reference:
            </p>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Code</th>
                    <th className={thCls}>Defect</th>
                  </tr>
                </thead>
                <tbody>
                  {DEFECT_CODES.map(({ code, label }) => (
                    <tr key={code}>
                      <td className={codeCls}>{code}</td>
                      <td className={tdCls}>{label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 6. Centering Tables ──────────────────────────────────── */}
          <section id="centering">
            <h2 className={sectionTitle}>5. Centering Deduction Tables</h2>
            <p className={`${para} mb-4`}>
              Centering is measured as the wider side of the off-centre axis
              (e.g. "55/45" = 55 on the wider side). The worse of left/right
              vs top/bottom is applied to each side of the card. Front and
              back are scored separately.
            </p>

            <h3 className={subTitle}>Front centering — up to -20 points</h3>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Ratio (worse axis)</th>
                    <th className={thCls}>Deduction</th>
                  </tr>
                </thead>
                <tbody>
                  {CENTERING_FRONT.map(({ ratio, deduction }) => (
                    <tr key={ratio}>
                      <td className={codeCls}>{ratio}</td>
                      <td className={tdCls}>{deduction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className={subTitle}>Back centering — up to -5 points</h3>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Ratio (worse axis)</th>
                    <th className={thCls}>Deduction</th>
                  </tr>
                </thead>
                <tbody>
                  {CENTERING_BACK.map(({ ratio, deduction }) => (
                    <tr key={ratio}>
                      <td className={codeCls}>{ratio}</td>
                      <td className={tdCls}>{deduction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 6. Corner / Edge / Surface deductions ─────────────────
                 Mirrors the per-defect tables in shared/mvgs-scoring.ts.
                 Numbers are static documentation; the scoring engine is
                 the source of truth at runtime. */}
          <section id="defects-scoring">
            <h2 className={sectionTitle}>6. Corner, Edge &amp; Surface Deductions</h2>
            <p className={`${para} mb-4`}>
              Each defect on the card is classified by code and tier, then
              its location decides which deduction table applies. Deductions
              are cumulative within each category and capped at -25 points.
            </p>

            <h3 className={subTitle}>Corners — per pin, max -25 total</h3>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Side</th>
                    <th className={thCls}>D1</th>
                    <th className={thCls}>D2</th>
                    <th className={thCls}>D3</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={tdCls}>Front corners</td>
                    <td className={codeCls}>-4</td>
                    <td className={codeCls}>-0.50</td>
                    <td className={codeCls}>0</td>
                  </tr>
                  <tr>
                    <td className={tdCls}>Back corners</td>
                    <td className={codeCls}>-2</td>
                    <td className={codeCls}>-0.25</td>
                    <td className={codeCls}>0</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 className={subTitle}>Edges — per pin, max -25 total</h3>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Side</th>
                    <th className={thCls}>D1</th>
                    <th className={thCls}>D2</th>
                    <th className={thCls}>D3</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={tdCls}>Front edges</td>
                    <td className={codeCls}>-3</td>
                    <td className={codeCls}>-0.50</td>
                    <td className={codeCls}>0</td>
                  </tr>
                  <tr>
                    <td className={tdCls}>Back edges</td>
                    <td className={codeCls}>-2</td>
                    <td className={codeCls}>-0.25</td>
                    <td className={codeCls}>0</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className={`${para} mt-3 text-xs italic`}>
              <strong className="text-[#D4AF37]/80 not-italic">Dark-border note:</strong>{" "}
              <code className="text-[#D4AF37]">WH</code> (whitening) defects on dark-bordered
              cards apply a ×1.25 multiplier to that edge deduction.
            </p>

            <h3 className={subTitle}>Surface — per pin, max -25 total</h3>
            <p className={`${para} mb-2`}>
              <strong className="text-[#ccc]">D1 defects</strong>
            </p>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Code</th>
                    <th className={thCls}>Defect</th>
                    <th className={thCls}>Front</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { c: "SP", l: "Scratch (gloss-penetrating)", v: "-4 pts (×1.5 in art/holo zone)" },
                    { c: "CR", l: "Crease",                       v: "-10 pts + hard cap: final score ≤ 74" },
                    { c: "SC", l: "Scratch (surface)",            v: "-2 pts" },
                    { c: "SV", l: "Silvering (holo)",             v: "-3 pts" },
                    { c: "ST", l: "Stain",                        v: "-2 pts" },
                    { c: "GL", l: "Gloss Loss",                   v: "-4 pts" },
                  ].map(({ c, l, v }) => (
                    <tr key={c}>
                      <td className={codeCls}>{c}</td>
                      <td className={tdCls}>{l}</td>
                      <td className={tdCls}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className={`${para} mb-2 mt-4`}>
              <strong className="text-[#ccc]">D2 defects</strong>
            </p>
            <div className={tableWrap}>
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Code</th>
                    <th className={thCls}>Defect</th>
                    <th className={thCls}>Front</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { c: "PL", l: "Print Line",          v: "-0.50 pts" },
                    { c: "PS", l: "Print Spot",          v: "-0.25 pts" },
                    { c: "PI", l: "Pit / Dent",          v: "-0.50 pts" },
                    { c: "SC", l: "Scratch (surface)",   v: "-0.50 pts" },
                    { c: "WH", l: "Whitening",           v: "-0.50 pts" },
                  ].map(({ c, l, v }) => (
                    <tr key={c}>
                      <td className={codeCls}>{c}</td>
                      <td className={tdCls}>{l}</td>
                      <td className={tdCls}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className={`${para} mt-4 text-xs`}>
              <strong className="text-[#ccc]">D3 defects:</strong> 0 pts (factory origin,
              documented only).
            </p>
            <p className={`${para} mt-2 text-xs italic`}>
              <strong className="text-[#D4AF37]/80 not-italic">Back surface:</strong>{" "}
              all surface deductions × 0.5.
            </p>

            <h3 className={subTitle}>Overall Grade Floor Rule</h3>
            <p className={`${para} mb-3`}>
              The overall grade cannot exceed the lowest MVGS category subgrade
              plus 0.5. If the gap between the lowest and all other subgrades
              is less than 4 aggregate points, the overall equals the lowest
              subgrade exactly — no bump.
            </p>
            <p className={`${para} mb-3`}>
              Example: a card with Centering 10, Corners 10, Edges 2,
              Surface 10 cannot grade overall higher than 2.5. A single
              destroyed category is never hidden by strong scores elsewhere.
            </p>
            <p className={para}>
              This mirrors the BGS published algorithm — the most trusted
              formula in the industry.
            </p>
          </section>

          {/* ── 7. Anti-fraud fingerprint ────────────────────────────── */}
          <section id="fingerprint">
            <h2 className={sectionTitle}>7. Anti-Fraud: MVGS Authenticity Fingerprint</h2>
            <p className={`${para} mb-3`}>
              The defect map published on every certificate is unique to that
              card. The combination of defect codes, zone placements, and pin
              positions — captured at 600 DPI — cannot be replicated by
              another physical card.
            </p>
            <p className={para}>
              This makes card swapping inside a slab detectable. If the card
              presented for verification does not match the published defect
              map, the certificate is no longer authentic. The fingerprint
              is the standard's tamper-evidence layer.
            </p>
          </section>

          {/* ── 8a. Grading-company CTA — small, understated, sits above
                  the main customer CTA so it doesn't out-shout it. */}
          <p className="text-center text-xs text-[#888] pt-6 border-t border-[#222]">
            Are you a grading company?{" "}
            <Link
              href="/mvgs/join"
              className="text-[#D4AF37]/80 hover:text-[#D4AF37] underline underline-offset-2 transition-colors"
              data-testid="cta-mvgs-join"
            >
              Apply for MVGS compliance →
            </Link>
          </p>

          {/* ── 8b. Footer CTA ───────────────────────────────────────── */}
          <section>
            <p className={`${para} text-center mb-5`}>
              MintVault is the reference implementation of MVGS. Every card
              graded by MintVault receives a full MVGS score, a defect
              report, and a 600 DPI scan.
            </p>
            <div className="flex justify-center">
              <Link
                href="/submit"
                className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-widest px-6 py-3 rounded-lg bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] hover:opacity-90 transition-opacity"
                data-testid="cta-submit"
              >
                Submit your card <ExternalLink size={14} />
              </Link>
            </div>
          </section>
        </div>

        {/* MVGS version lock — quiet footer note; spec lineage in case a
            future revision changes weights / rules. Issued certificates
            stay bound to the version active at grading time. */}
        <div className="text-center mt-12 space-y-1.5 text-[10px] text-[#666] leading-relaxed">
          <p>MVGS v1.0 · Published 21 May 2026 · MintVault UK Ltd.</p>
          <p>
            Grades issued under MVGS v1.0 are certified to this specification.
            Future revisions carry a new version number and do not retroactively
            alter issued certificates.
          </p>
        </div>
      </div>
    </div>
  );
}
