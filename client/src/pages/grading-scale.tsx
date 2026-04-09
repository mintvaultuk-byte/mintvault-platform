import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import { Shield, Target, CheckCircle } from "lucide-react";

const grades = [
  { grade: "10",  label: "GEM MINT",           desc: "Virtually perfect. Flawless corners, edges, and surface. Centering within 55/45 on front, 75/25 on back." },
  { grade: "9",   label: "MINT",                desc: "Outstanding condition. Minor imperfection visible only under close inspection." },
  { grade: "8",   label: "NEAR MINT-MINT",      desc: "Minor wear on corners or edges. Slight surface marks or a small print defect." },
  { grade: "7",   label: "NEAR MINT",           desc: "Visible minor wear. Light scratching or minor edge wear with small surface marks." },
  { grade: "6",   label: "EXCELLENT-NEAR MINT", desc: "Noticeable wear but still presentable. Minor creasing possible. Light loss of gloss." },
  { grade: "5",   label: "EXCELLENT",           desc: "Moderate wear including corner and edge wear, surface scratches, and possible print defects." },
  { grade: "4",   label: "VERY GOOD-EXCELLENT", desc: "Heavier wear. Visible creasing or surface damage. Card is still intact." },
  { grade: "3",   label: "VERY GOOD",           desc: "Significant wear. Creasing, staining, or heavy edge wear visible without magnification." },
  { grade: "2",   label: "GOOD",                desc: "Heavy damage. Major creasing, tears, or significant staining throughout." },
  { grade: "1",   label: "POOR",                desc: "Extensive damage. Card is heavily worn but still identifiable as a trading card." },
  { grade: "AA",  label: "AUTHENTIC ALTERED",   desc: "Genuine card that has been trimmed, recoloured, or otherwise altered from its original state." },
  { grade: "NO",  label: "NOT ORIGINAL",        desc: "Card is a counterfeit or reproduction and does not originate from an official print run." },
];

function gradeBarColor(g: string): string {
  const n = parseFloat(g);
  if (isNaN(n)) return "#888888";
  if (n >= 10) return "#D4AF37";
  if (n >= 9)  return "#B8960C";
  if (n >= 8)  return "#2563EB";
  if (n >= 7)  return "#16A34A";
  if (n >= 6)  return "#CA8A04";
  if (n >= 5)  return "#EA580C";
  return "#DC2626";
}

function gradeBarPct(g: string): number {
  const n = parseFloat(g);
  if (isNaN(n)) return 0;
  return (n / 10) * 100;
}

const criteria = [
  { title: "Centering",  desc: "How well the printed image is positioned within the card borders. Evaluated front and back. Tolerances tighten at higher grades — a 10 requires 55/45 or better." },
  { title: "Corners",    desc: "The sharpness and integrity of all four corners. Any rounding, fraying, or tip wear lowers the grade. Corners must be razor-sharp for a 9 or above." },
  { title: "Edges",      desc: "The condition along all four edges. Whitening, chipping, or roughness is assessed under magnification. Clean edges are essential for top grades." },
  { title: "Surface",    desc: "Front and back surface quality — scratches, print lines, ink spots, haze, indentations, and loss of gloss are all considered. Surface damage is the most common grade limiter." },
];

export default function GradingScalePage() {
  return (
    <div className="px-4 py-10 max-w-3xl mx-auto">
      <SeoHead
        title="MintVault Grading Scale | 1–10 Trading Card Grading Standards"
        description="Full breakdown of the MintVault 1–10 grading scale. Understand what each grade means, what graders examine, and how to assess your own cards before submission."
        canonical="https://mintvaultuk.com/grading-scale"
      />

      <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide mb-2" data-testid="text-h1-grading-scale">
        MintVault Grading Scale
      </h1>
      <p className="text-[#666666] text-base leading-relaxed mb-10">
        Every card graded by MintVault is assessed on our professional 1–10 scale. Grades are whole numbers only — no half-point grades. Grades reflect the overall condition of the card at the time of grading.
      </p>

      {/* Grade table */}
      <section className="mb-12" data-testid="section-grade-table">
        <div className="border border-[#D4AF37]/20 rounded-xl overflow-hidden">
          {grades.map((row, i) => {
            const isSpecial = isNaN(parseFloat(row.grade));
            return (
              <div
                key={row.grade}
                className={`flex items-start gap-4 px-5 py-4 ${i % 2 === 0 ? "bg-white" : "bg-[#FAFAF8]"} ${i < grades.length - 1 ? "border-b border-[#E8E4DC]" : ""}`}
                data-testid={`row-grade-${row.grade}`}
              >
                {/* Grade badge */}
                <div
                  className="flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center font-black text-sm font-mono"
                  style={{
                    background: isSpecial ? "#F5F5F5" : `linear-gradient(135deg, ${gradeBarColor(row.grade)}22, ${gradeBarColor(row.grade)}11)`,
                    border: `2px solid ${isSpecial ? "#E0E0E0" : gradeBarColor(row.grade)}`,
                    color: isSpecial ? "#666666" : gradeBarColor(row.grade),
                  }}
                >
                  {row.grade}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <span className="font-bold text-[#1A1A1A] text-sm">{row.label}</span>
                    {!isSpecial && (
                      <div className="flex-1 min-w-[60px] max-w-[120px] h-1.5 bg-[#E8E4DC] rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${gradeBarPct(row.grade)}%`, background: gradeBarColor(row.grade) }}
                        />
                      </div>
                    )}
                  </div>
                  <p className="text-[#666666] text-xs leading-relaxed">{row.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* What we examine */}
      <section className="mb-12 reveal-on-scroll" data-testid="section-what-we-examine">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg,#D4AF37,#B8960C)" }}>
            <Target size={16} className="text-[#1A1400]" />
          </div>
          <h2 className="text-xl font-bold text-[#1A1A1A] tracking-wide">What We Examine</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {criteria.map((c, i) => (
            <div key={i} className="border border-[#D4AF37]/20 rounded-xl p-5" data-testid={`card-criteria-${i}`}>
              <h3 className="text-[#1A1A1A] font-bold text-sm mb-2 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37] flex-shrink-0" />
                {c.title}
              </h3>
              <p className="text-[#666666] text-xs leading-relaxed">{c.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Grading promise */}
      <section className="mb-12 reveal-on-scroll" data-testid="section-grading-promise">
        <div className="border-l-4 border-[#D4AF37] pl-5 py-2">
          <div className="flex items-center gap-2 mb-2">
            <Shield size={16} className="text-[#D4AF37]" />
            <h2 className="text-[#1A1A1A] font-bold text-sm uppercase tracking-widest">Our Grading Promise</h2>
          </div>
          <p className="text-[#444444] text-sm leading-relaxed">
            Every card is graded by trained professionals using consistent, documented standards. MintVault does not buy or sell cards — eliminating any conflict of interest in the grading process. Our goal is to give you an honest, accurate grade every time.
          </p>
        </div>
      </section>

      {/* CTA */}
      <div className="border border-[#D4AF37]/30 rounded-xl p-6 bg-[#FFF9E6] text-center reveal-on-scroll">
        <CheckCircle size={24} className="text-[#D4AF37] mx-auto mb-3" />
        <h3 className="text-[#1A1A1A] font-bold mb-2">Ready to grade your cards?</h3>
        <p className="text-[#666666] text-sm mb-4">Submit online and receive expert grading with a verifiable certificate.</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/submit">
            <span className="inline-flex items-center gap-2 gold-shimmer text-[#1A1400] px-6 py-2.5 rounded-lg font-bold text-sm tracking-wide cursor-pointer">
              Submit Cards
            </span>
          </Link>
          <Link href="/grading-glossary">
            <span className="inline-flex items-center gap-2 border border-[#D4AF37]/40 text-[#B8960C] px-6 py-2.5 rounded-lg font-medium text-sm tracking-wide cursor-pointer hover:bg-[#FFF9E6]">
              Grading Glossary →
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}
