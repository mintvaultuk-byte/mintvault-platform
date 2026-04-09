import { Link } from "wouter";
import { ArrowRight, BarChart2, Shield, Crosshair, Users } from "lucide-react";
import SeoHead from "@/components/seo-head";

const FEATURES = [
  {
    icon: <BarChart2 size={20} className="text-[#B8960C]" />,
    title: "Grade Breakdown",
    desc: "Overall grade plus four subgrades (centering, corners, edges, surface) with visual progress indicators.",
  },
  {
    icon: <Crosshair size={20} className="text-[#B8960C]" />,
    title: "Defect Analysis",
    desc: "Every imperfection identified by AI and verified by our expert grader, with annotated pin markers on the card image.",
  },
  {
    icon: <Shield size={20} className="text-[#B8960C]" />,
    title: "Centering Diagram",
    desc: "Technical blueprint showing exact L/R and T/B border ratios, with PSA and Black Label threshold checks.",
  },
  {
    icon: <Users size={20} className="text-[#B8960C]" />,
    title: "Ownership Timeline",
    desc: "Verified chain of custody from original owner to current owner.",
  },
];

export default function VaultReportsAboutPage() {
  return (
    <>
      <SeoHead
        title="About Vault Reports | MintVault UK"
        description="MintVault Vault reports give you full digital transparency for every graded card — AI defect analysis, centering measurements, ownership history, and population data."
        canonical="/vault-reports/about"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-[#FAFAF8]">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-24 text-center">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-4">Vault Reports</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-4 leading-tight tracking-tight">
            Vault Reports
          </h1>
          <p className="text-xl text-[#666666]">Full transparency for every graded card</p>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-6 py-16 md:py-24 space-y-16">

        {/* What is */}
        <section>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-4">What is a Vault?</p>
          <p className="text-[#555555] text-base leading-relaxed text-lg">
            A Vault is a complete digital record of every MintVault graded card. It includes high-resolution images, AI-detected defect analysis, centering measurements, ownership history, population data, and authentication status — all accessible by scanning the QR code on the slab or visiting the unique cert URL. Every card has a Vault.
          </p>
        </section>

        {/* What's included */}
        <section>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-6">What's Included</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {FEATURES.map(({ icon, title, desc }) => (
              <div key={title} className="p-5 rounded-2xl bg-white border border-[#E8E4DC]">
                <div className="w-10 h-10 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center mb-4">
                  {icon}
                </div>
                <p className="font-bold text-[#1A1A1A] mb-2">{title}</p>
                <p className="text-[#666666] text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Why it matters */}
        <section className="p-6 rounded-2xl border-l-4 bg-[#FAFAF8] border border-[#E8E4DC]" style={{ borderLeftColor: "#D4AF37" }}>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-4">Why It Matters</p>
          <p className="text-[#555555] text-base leading-relaxed">
            Other graders give you a number on a slab and nothing else. We believe every collector deserves to see exactly how their card was assessed. Full transparency builds trust — and protects the value of your collection.
          </p>
        </section>

        {/* Sample CTA */}
        <section className="text-center space-y-4">
          <p className="text-[#888888] text-sm">Open a sample Vault</p>
          <Link href="/vault/MV1">
            <button className="gold-shimmer inline-flex items-center gap-2 font-bold text-sm px-8 py-4 rounded-xl">
              View Sample Vault <ArrowRight size={15} />
            </button>
          </Link>
          <p className="text-[#AAAAAA] text-xs">Then <Link href="/vault-reports/how-to-read" className="text-[#B8960C] hover:underline">learn how to read one →</Link></p>
        </section>
      </div>
    </>
  );
}
