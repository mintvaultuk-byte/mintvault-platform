import { Link } from "wouter";
import SeoHead from "@/components/seo-head";
import { BookOpen, ArrowRight } from "lucide-react";

const terms = [
  {
    term: "Centering",
    definition:
      "The alignment of the printed image within the card's borders. Measured as a ratio — e.g. 60/40 means the left border is 60% of the space and the right is 40%. MintVault requires 55/45 or better on the front for a grade of 10.",
  },
  {
    term: "Corner Wear",
    definition:
      "Damage or rounding at any of the four card corners. Ranges from microscopic tip fraying (visible only under magnification) to visible blunting or white cotton fibre exposure. Corners are one of the primary grade-limiting factors.",
  },
  {
    term: "Creasing",
    definition:
      "A fold or bend in the card that leaves a permanent mark in the cardstock. Light creases may only be visible under raking light; severe creases break the card's surface. Any crease significantly impacts the grade.",
  },
  {
    term: "Deionisation",
    definition:
      "A cleaning process that uses deionised (mineral-free) water to gently remove surface dust, oils, and light contaminants without damaging the card. MintVault performs safe surface preparation as part of card care — included with every submission.",
  },
  {
    term: "Edge Wear",
    definition:
      "Damage along any of the four card edges. Manifests as whitening (loss of ink), chipping, roughness, or nicking. Edge wear is assessed under magnification and is a common grade limiter on heavily played cards.",
  },
  {
    term: "Foil Bleed",
    definition:
      "A manufacturing defect where the foil layer on holographic or foil cards bleeds, separates, or buckles away from the cardstock. Foil bleed is treated as a print defect and cannot be corrected — it is factored into the surface sub-grade.",
  },
  {
    term: "Holo Bleed",
    definition:
      "Similar to foil bleed, this refers specifically to the rainbow holographic layer on Pokémon and other TCG cards separating or showing tide-mark lines. Even minor holo bleed will limit the grade to a 7 or below in most cases.",
  },
  {
    term: "Indentation",
    definition:
      "A dent or depression in the card's surface caused by pressure — often from a fingernail, ring, or rubber band. Indentations are permanent and visible under raking light. Severity determines grade impact.",
  },
  {
    term: "Off-Centre",
    definition:
      "When the printed image is not centred within the card borders. A card can be off-centre left/right, top/bottom, or both. Severe off-centering is a manufacturing defect and can prevent a card from reaching grades above 7–8.",
  },
  {
    term: "Print Line",
    definition:
      "A line or streak on the card's surface caused by a defect in the printing process — typically a foreign particle or roller mark. Print lines are factory-origin defects and are noted on the grading report.",
  },
  {
    term: "Silvering",
    definition:
      "A silver or white haze that appears along the edges or surface of older cards where the top layer has begun to separate or oxidise. Common on vintage cards stored without sleeves. Silvering is permanent and impacts the surface sub-grade.",
  },
  {
    term: "Surface Scratch",
    definition:
      "A mark on the front or back surface of the card caused by friction — often from card-to-card contact in a binder or unsleeved storage. Light scratches may only be visible under light; deep scratches catch light at all angles.",
  },
  {
    term: "Whitening",
    definition:
      "Loss of ink or coating along the card's edges, corners, or surface, exposing the white cardstock beneath. Whitening is the most common form of card wear and is the primary indicator of how well a card has been stored.",
  },
];

export default function GradingGlossaryPage() {
  return (
    <div className="px-4 py-10 max-w-3xl mx-auto">
      <SeoHead
        title="Grading Glossary | MintVault Card Grading Terms Explained"
        description="Plain-English definitions of every term used in professional trading card grading. Understand centering, corner wear, silvering, print lines, and more."
        canonical="https://mintvaultuk.com/grading-glossary"
      />

      <div className="flex items-center gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg,#D4AF37,#B8960C)" }}>
          <BookOpen size={18} className="text-[#1A1400]" />
        </div>
        <h1 className="text-3xl md:text-4xl font-bold text-[#1A1A1A] tracking-wide" data-testid="text-h1-grading-glossary">
          Grading Glossary
        </h1>
      </div>
      <p className="text-[#666666] text-base leading-relaxed mb-10">
        Plain-English definitions of every term used in professional trading card grading. Bookmark this page before submitting your first order.
      </p>

      {/* Alphabetical terms */}
      <section className="mb-12" data-testid="section-glossary-terms">
        <div className="space-y-3">
          {terms.map((item, i) => (
            <div
              key={i}
              className="border border-[#D4AF37]/20 rounded-xl px-5 py-4 bg-white"
              data-testid={`glossary-term-${item.term.toLowerCase().replace(/\s+/g, "-")}`}
            >
              <h2 className="text-[#1A1A1A] font-bold text-sm mb-1.5 flex items-center gap-2">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: "#D4AF37" }}
                />
                {item.term}
              </h2>
              <p className="text-[#666666] text-xs leading-relaxed">{item.definition}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Cross-link to grading scale */}
      <section className="mb-12 reveal-on-scroll">
        <div className="border-l-4 border-[#D4AF37] pl-5 py-2">
          <p className="text-[#444444] text-sm leading-relaxed">
            <span className="font-semibold text-[#1A1A1A]">Want to see how these factors affect grades?</span>{" "}
            Visit the{" "}
            <Link href="/grading-scale">
              <span className="text-[#B8960C] font-semibold underline underline-offset-2 cursor-pointer">
                MintVault Grading Scale
              </span>
            </Link>{" "}
            for a full breakdown of each grade from 1 to 10.
          </p>
        </div>
      </section>

      {/* CTA */}
      <div className="border border-[#D4AF37]/30 rounded-xl p-6 bg-[#FFF9E6] text-center reveal-on-scroll">
        <h3 className="text-[#1A1A1A] font-bold mb-2">Ready to submit your cards?</h3>
        <p className="text-[#666666] text-sm mb-4">
          Now you know the terminology — let's grade your collection.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/submit">
            <span className="inline-flex items-center gap-2 bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] px-6 py-2.5 rounded-lg font-bold text-sm tracking-wide cursor-pointer">
              Submit Cards
            </span>
          </Link>
          <Link href="/grading-scale">
            <span className="inline-flex items-center gap-2 border border-[#D4AF37]/40 text-[#B8960C] px-6 py-2.5 rounded-lg font-medium text-sm tracking-wide cursor-pointer hover:bg-[#FFF9E6]">
              Grading Scale <ArrowRight size={14} />
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}
