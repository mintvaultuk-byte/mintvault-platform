import { Link } from "wouter";
import { ArrowRight, Shield, Wifi, MapPin } from "lucide-react";
import SeoHead from "@/components/seo-head";
import MintVaultWordmark from "@/components/mintvault-wordmark";

export default function OurStoryPage() {
  return (
    <>
      <SeoHead
        title="Our Story — MintVault UK"
        description="Why we built the UK's only verified ownership grader. The MintVault founding story."
        canonical="/about/our-story"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-[#FAFAF8]">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-24 text-center">
          <div className="flex justify-center mb-10">
            <MintVaultWordmark size="lg" />
          </div>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-4">Our Story</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-6 leading-tight tracking-tight">
            Why We Built the UK's Only Verified Ownership Grader
          </h1>
        </div>
      </section>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-6 py-16 md:py-24 space-y-16">

        <section>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-4">The Beginning</p>
          <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] mb-5 leading-tight">
            A collector's frustration
          </h2>
          <p className="text-[#555555] text-base leading-relaxed">
            MintVault was founded in 2023 in Rochester, Kent by a collector frustrated with the gap in the UK trading card grading market. Cards were being sent overseas, taking months to return, with no transparency on grading decisions and no way to prove ownership when reselling.
          </p>
        </section>

        <div className="border-l-2 border-[#D4AF37]/30 pl-6">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-4">The Vision</p>
          <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] mb-5 leading-tight">
            Something different
          </h2>
          <p className="text-[#555555] text-base leading-relaxed">
            We set out to build something different: a UK-based grading service with full digital transparency, AI-assisted grading verified by human experts, and the world's first verified ownership registry for trading cards.
          </p>
        </div>

        <section>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-6">What Makes Us Different</p>
          <div className="space-y-5">
            {[
              {
                icon: <MapPin size={18} className="text-[#B8960C]" />,
                title: "UK-Based",
                desc: "No customs delays, no overseas shipping, fast Royal Mail tracked returns. Your cards never leave the country.",
              },
              {
                icon: <Wifi size={18} className="text-[#B8960C]" />,
                title: "Verified Ownership",
                desc: "NFC-authenticated slabs and a tamper-proof ownership registry. Prove who owns your card at any point in time.",
              },
              {
                icon: <Shield size={18} className="text-[#B8960C]" />,
                title: "Full Transparency",
                desc: "Every card receives a complete Vault — images, measurements, defect analysis, and ownership history. Every card has a Vault.",
              },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="flex gap-4 p-5 rounded-2xl bg-white border border-[#E8E4DC]">
                <div className="w-10 h-10 rounded-xl bg-[#FFF9E6] border border-[#D4AF37]/20 flex items-center justify-center flex-shrink-0">
                  {icon}
                </div>
                <div>
                  <p className="font-bold text-[#1A1A1A] mb-1">{title}</p>
                  <p className="text-[#666666] text-sm leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-4">Looking Forward</p>
          <h2 className="text-2xl md:text-3xl font-black text-[#1A1A1A] mb-5 leading-tight">
            Built to last
          </h2>
          <p className="text-[#555555] text-base leading-relaxed">
            We're building MintVault to become the standard for trading card grading in the UK. Every slab, every grade, every report is designed to outlast trends and protect your collection for decades.
          </p>
        </section>
      </div>

      {/* CTA */}
      <section className="border-t border-[#E8E4DC] bg-[#FAFAF8] px-6 py-16">
        <div className="max-w-xl mx-auto text-center space-y-6">
          <h2 className="text-2xl font-black text-[#1A1A1A]">
            Ready to grade your collection?
          </h2>
          <Link href="/submit">
            <button className="gold-shimmer inline-flex items-center gap-2 font-bold text-sm px-8 py-4 rounded-xl">
              Submit Your Cards <ArrowRight size={15} />
            </button>
          </Link>
        </div>
      </section>
    </>
  );
}
