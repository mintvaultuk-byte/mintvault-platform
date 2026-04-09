import { Link } from "wouter";
import { ArrowRight, Check, X } from "lucide-react";
import SeoHead from "@/components/seo-head";

const ELIGIBLE = [
  { game: "Pokémon TCG", desc: "All sets from Base Set to current releases. English, Japanese, and other languages welcome." },
  { game: "Magic: The Gathering", desc: "All sets from Alpha to current. Includes vintage, modern, and Commander cards." },
  { game: "Yu-Gi-Oh!", desc: "All TCG and OCG cards. English, Japanese, Asian English, Korean." },
  { game: "One Piece TCG", desc: "All Bandai-licensed sets." },
  { game: "Lorcana", desc: "All Disney Lorcana sets." },
  { game: "Sports Cards", desc: "Football, basketball, baseball, hockey, soccer, F1, UFC. Topps, Panini, Upper Deck, and more." },
  { game: "Other TCGs", desc: "Digimon, Dragon Ball Super, Weiss Schwarz, Cardfight Vanguard, and others. Contact us if your card type isn't listed." },
];

const INELIGIBLE = [
  "Oversized cards (jumbo cards over standard size)",
  "Custom or fan-made cards",
  "Damaged cards beyond grade 1",
  "Cards with visible signs of cleaning, trimming, or alteration",
  "Counterfeit cards",
];

export default function EligibleCardsPage() {
  return (
    <>
      <SeoHead
        title="Eligible Cards — What We Grade | MintVault UK"
        description="MintVault grades Pokémon, Magic: The Gathering, Yu-Gi-Oh!, sports cards, and more. See the full list of eligible trading cards."
        canonical="/grading/eligible-cards"
      />

      {/* Hero */}
      <section className="border-b border-[#E8E4DC] bg-[#FAFAF8]">
        <div className="max-w-3xl mx-auto px-6 py-16 md:py-20 text-center">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.25em] mb-4">Grading</p>
          <h1 className="text-4xl md:text-5xl font-black text-[#1A1A1A] mb-4 leading-tight tracking-tight">
            Eligible Cards
          </h1>
          <p className="text-lg text-[#666666]">What we grade</p>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-6 py-16 space-y-16">

        {/* Currently grading */}
        <section>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-6">Currently Grading</p>
          <div className="space-y-3">
            {ELIGIBLE.map(({ game, desc }) => (
              <div key={game} className="flex gap-4 p-5 rounded-2xl bg-white border border-[#E8E4DC]">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#FFF9E6] border border-[#D4AF37]/30 flex items-center justify-center mt-0.5">
                  <Check size={12} className="text-[#B8960C]" />
                </div>
                <div>
                  <p className="font-bold text-[#1A1A1A] mb-1">{game}</p>
                  <p className="text-[#666666] text-sm leading-relaxed">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* What we don't grade */}
        <section>
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-6">What We Don't Grade</p>
          <div className="rounded-2xl overflow-hidden border border-[#E8E4DC]">
            {INELIGIBLE.map((item, i) => (
              <div
                key={item}
                className="flex items-center gap-4 px-5 py-3.5"
                style={{ background: i % 2 === 0 ? "#fff" : "#FAFAF8", borderBottom: i < INELIGIBLE.length - 1 ? "1px solid #E8E4DC" : "none" }}
              >
                <X size={14} className="text-[#CC4444] flex-shrink-0" />
                <span className="text-sm text-[#555555]">{item}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Conditions accepted */}
        <section className="p-6 rounded-2xl bg-[#FFF9E6] border border-[#D4AF37]/20">
          <p className="text-[#B8960C] text-xs font-bold uppercase tracking-[0.2em] mb-3">Card Conditions Accepted</p>
          <p className="text-[#555555] text-base leading-relaxed">
            We grade cards in any condition from grade 1 to grade 10 Black Label. Even heavily played cards can be graded for population reports and authentication purposes.
          </p>
        </section>
      </div>

      {/* CTA */}
      <section className="border-t border-[#E8E4DC] bg-[#FAFAF8] px-6 py-16">
        <div className="max-w-xl mx-auto text-center space-y-6">
          <h2 className="text-2xl font-black text-[#1A1A1A]">
            Ready to submit?
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
