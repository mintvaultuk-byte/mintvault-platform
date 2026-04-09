import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import SeoHead from "@/components/seo-head";

const SECTIONS = [
  {
    num: "01",
    title: "The Hero",
    body: "At the top of every Vault, you'll see a high-resolution image of your card with the overall grade displayed in a gold badge. This is the headline number — but it's only part of the story.",
  },
  {
    num: "02",
    title: "Grade Breakdown",
    body: "Below the hero you'll see four subgrades: Centering, Corners, Edges, and Surface. Each is scored on the same 1–10 scale. The overall grade reflects the lowest of these four — a card with three perfect 10s and one 7 will be capped at grade 7 overall.",
  },
  {
    num: "03",
    title: "Centering Analysis",
    body: "Our centering blueprint shows the exact left/right and top/bottom border ratios as measured by our AI. A perfect card centres at 50/50 on both axes. PSA Gem Mint 10 requires 55/45 or better. Our exclusive Black Label requires near-perfect centering across both axes.",
  },
  {
    num: "04",
    title: "Defect Analysis",
    body: "Toggle the defect view to see every imperfection identified during grading. Each pin marker shows you exactly where on the card the defect is located, along with its type and severity. A perfect card shows 'Perfect Specimen' with a gold checkmark.",
  },
  {
    num: "05",
    title: "Ownership History",
    body: "Every transfer of ownership is logged here. The current owner is verified via email-confirmed handover. This creates a permanent, tamper-proof record of provenance.",
  },
  {
    num: "06",
    title: "Population Data",
    body: "See exactly how many cards of this exact type have been graded by MintVault, broken down by grade. A '1 of 1' card at grade 10 is significantly rarer than a '1 of 100' card.",
  },
  {
    num: "07",
    title: "Authentication",
    body: "Every slab has multiple verification methods: NFC chip, QR code, certificate ID, and tamper-evident seal. All must be intact for the card to remain verified.",
  },
];

export default function HowToReadVaultPage() {
  return (
    <>
      <SeoHead
        title="How to Read a Vault | MintVault UK"
        description="A guide to understanding your MintVault Vault — grades, centering, defects, ownership, and population data explained."
        canonical="/vault-reports/how-to-read"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-[#FAFAF8]">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-20 text-center">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-4">Vault Reports</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-4 leading-tight tracking-tight">
            How to Read a Vault
          </h1>
          <p className="text-lg text-[#666666]">A guide to understanding your card's assessment</p>
        </div>
      </section>

      {/* Sections */}
      <div className="max-w-2xl mx-auto px-6 py-16">
        <div className="space-y-0">
          {SECTIONS.map(({ num, title, body }, i) => (
            <div
              key={num}
              className="flex gap-6 py-10 border-b border-[#E8E4DC] last:border-0"
            >
              <div className="flex-shrink-0 w-12 text-center">
                <span
                  className="font-black leading-none"
                  style={{ fontSize: 36, color: "#D4AF37", opacity: 0.25 }}
                >
                  {num}
                </span>
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-black text-[#1A1A1A] mb-3">
                  {title}
                </h2>
                <p className="text-[#555555] text-base leading-relaxed">{body}</p>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="text-center pt-12 space-y-4">
          <p className="text-[#888888] text-sm">Ready to see one in action?</p>
          <Link href="/vault/MV1">
            <button className="gold-shimmer inline-flex items-center gap-2 font-bold text-sm px-8 py-4 rounded-xl">
              Open Sample Vault <ArrowRight size={15} />
            </button>
          </Link>
        </div>
      </div>
    </>
  );
}
