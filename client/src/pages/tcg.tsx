import { Swords, Flame, Zap, Trophy, Star, Target, Crown, Gem } from "lucide-react";

const tcgList = [
  {
    name: "Pokémon TCG",
    description: "All sets from Base Set to modern expansions, including Japanese and promo cards.",
    icon: <Zap size={28} />,
  },
  {
    name: "Yu-Gi-Oh!",
    description: "First Edition, Limited Edition, and all booster sets. OCG and TCG variants accepted.",
    icon: <Swords size={28} />,
  },
  {
    name: "Magic: The Gathering",
    description: "Alpha through modern sets. Foils, extended art, and special editions welcome.",
    icon: <Gem size={28} />,
  },
  {
    name: "Sports Cards",
    description: "Football, basketball, baseball, cricket, and more. Topps, Panini, Upper Deck accepted.",
    icon: <Trophy size={28} />,
  },
  {
    name: "Dragon Ball Super",
    description: "All booster sets, promo cards, and tournament prize cards.",
    icon: <Flame size={28} />,
  },
  {
    name: "One Piece TCG",
    description: "Japanese and English sets, including leader cards and special art variants.",
    icon: <Crown size={28} />,
  },
  {
    name: "Digimon TCG",
    description: "All booster sets and promo cards from the modern Digimon card game.",
    icon: <Star size={28} />,
  },
  {
    name: "Other TCGs",
    description: "We accept most major trading card games. Contact us if your TCG isn't listed.",
    icon: <Target size={28} />,
  },
];

export default function TcgPage() {
  return (
    <div className="px-4 py-12 max-w-3xl mx-auto">
      <h1
        className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest text-center mb-4 glow-gold"
        data-testid="text-tcg-title"
      >
        SUPPORTED TCGs
      </h1>
      <p className="text-gray-300 text-center mb-12 max-w-xl mx-auto" data-testid="text-tcg-subtitle">
        MintVault grades cards from all major trading card games. If you collect it, we can grade it.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {tcgList.map((tcg, i) => (
          <div
            key={i}
            className="border border-[#D4AF37]/20 rounded-lg p-5 flex flex-col items-center text-center"
            data-testid={`card-tcg-${i}`}
          >
            <div className="w-14 h-14 border border-[#D4AF37]/40 rounded-lg flex items-center justify-center text-[#D4AF37] mb-3">
              {tcg.icon}
            </div>
            <h3 className="text-[#D4AF37] font-semibold text-lg mb-1.5" data-testid={`text-tcg-name-${i}`}>
              {tcg.name}
            </h3>
            <p className="text-gray-400 text-sm leading-relaxed" data-testid={`text-tcg-desc-${i}`}>
              {tcg.description}
            </p>
          </div>
        ))}
      </div>

      <div className="border border-[#D4AF37]/20 rounded-lg p-6 mt-10 text-center" data-testid="card-tcg-cta">
        <h3 className="text-[#D4AF37] font-semibold text-lg mb-2 glow-gold-sm">
          Don't see your TCG?
        </h3>
        <p className="text-gray-400 text-sm mb-4">
          We're always expanding our grading capabilities. Get in touch and we'll let you know
          if we can grade your cards.
        </p>
        <a
          href="mailto:info@mintvaultuk.co.uk"
          className="inline-block border border-[#D4AF37] bg-black text-[#D4AF37] px-6 py-2.5 rounded font-medium tracking-wide transition-all btn-gold-glow hover:bg-[#D4AF37]/10"
          data-testid="button-contact-tcg"
        >
          Contact Us
        </a>
      </div>
    </div>
  );
}
