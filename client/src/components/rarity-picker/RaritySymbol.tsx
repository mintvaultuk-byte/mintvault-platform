/**
 * Visual rarity-symbol renderer. Draws the ACTUAL symbol (circle / diamond / 1-2-3
 * stars / shiny / code) filled with the REAL PRINTED colour — Common/Uncommon/Rare
 * stay black, one/two silver stars stay silver, gold stays gold — so the symbol
 * always represents what is physically printed on the card.
 *
 * The admin grading picker is a DARK-themed surface, where a literal printed-black
 * symbol would be invisible drawn directly on a dark tile. Instead of recolouring
 * the symbol (which previously made every rarity the same off-white — a real
 * regression), every symbol renders inside a small fixed-size contrast BADGE: a
 * light neutral/ivory badge behind black symbols, a dark charcoal badge with a
 * subtle silver or gold halo behind silver/gold symbols. The badge provides
 * contrast; the symbol fill is always the true printed colour.
 */
import {
  describeSymbol,
  type RaritySymbol as RaritySymbolMeta,
  type SymbolColour,
} from "@shared/pokemon-rarity-catalogue";

// Real printed colours — never recoloured for display.
const FILL: Record<SymbolColour, string> = {
  gold: "#C9A227",
  silver: "#B9C0C9",
  black: "#000000",
  bronze: "#8C5A2B",
  white: "#FFFFFF",
  rainbow: "url(#mv-rarity-rainbow)",
  none: "transparent",
};
const STROKE: Record<SymbolColour, string> = {
  gold: "#7a5f10",
  silver: "#6b7480",
  black: "#000000",
  bronze: "#5c3c1a",
  white: "#9aa0a8",
  rainbow: "#7a3ea8",
  none: "#9aa0a8",
};

// Contrast badge behind the symbol — chosen for legibility on a dark tile,
// never used as the symbol's own fill colour.
const BADGE_BG: Record<SymbolColour, string> = {
  black: "#F3EFE3",
  bronze: "#F3EFE3",
  silver: "#23262d",
  gold: "#23262d",
  white: "#23262d",
  rainbow: "#23262d",
  none: "#2b303a",
};
const BADGE_RING: Record<SymbolColour, string> = {
  black: "#D8D2BD",
  bronze: "#C79A67",
  silver: "#B9C0C9",
  gold: "#C9A227",
  white: "#5c7c96",
  rainbow: "#7a3ea8",
  none: "#4a5160",
};

function Star({ cx, cy, size, fill, stroke }: { cx: number; cy: number; size: number; fill: string; stroke: string }) {
  // A five-pointed star path, centred at (cx, cy), scaled to `size`.
  const s = size / 24;
  const pts = [
    [12, 2],
    [15, 9],
    [22, 9.3],
    [16.5, 14],
    [18.5, 21],
    [12, 17],
    [5.5, 21],
    [7.5, 14],
    [2, 9.3],
    [9, 9],
  ]
    .map(([px, py]) => `${cx + (px - 12) * s},${cy + (py - 12) * s}`)
    .join(" ");
  return <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={0.7} strokeLinejoin="round" />;
}

/** Fixed badge geometry — IDENTICAL across every rarity so tiles line up. */
const BADGE_VIEWBOX = 28;
const BADGE_CX = 14;
const BADGE_CY = 14;
const BADGE_R = 12;

export function RaritySymbol({ symbol, size = 26 }: { symbol: RaritySymbolMeta; size?: number }) {
  const fill = FILL[symbol.colour];
  const stroke = STROKE[symbol.colour];
  const badgeBg = BADGE_BG[symbol.colour];
  const badgeRing = BADGE_RING[symbol.colour];
  const count = symbol.count ?? 1;
  const glyph = symbol.shape === "text" ? (symbol.glyph ?? "") : "";
  // Longer printed codes (RRR, MUR, CSR…) shrink slightly to stay inside the
  // fixed badge instead of overflowing it.
  const textFontSize = glyph.length >= 4 ? 6.5 : glyph.length === 3 ? 7.5 : 9;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${BADGE_VIEWBOX} ${BADGE_VIEWBOX}`}
      role="img"
      aria-label={describeSymbol(symbol)}
    >
      <defs>
        <linearGradient id="mv-rarity-rainbow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="35%" stopColor="#ffd24d" />
          <stop offset="65%" stopColor="#4dd2ff" />
          <stop offset="100%" stopColor="#b14dff" />
        </linearGradient>
      </defs>

      {/* Fixed-size contrast badge — same size/position for every rarity. */}
      <circle
        cx={BADGE_CX}
        cy={BADGE_CY}
        r={BADGE_R}
        fill={badgeBg}
        stroke={badgeRing}
        strokeWidth={1}
        data-badge-colour={symbol.colour}
      />

      {symbol.shape === "circle" && (
        <circle cx={BADGE_CX} cy={BADGE_CY} r={6.5} fill={fill} stroke={stroke} strokeWidth={0.7} />
      )}
      {symbol.shape === "diamond" && (
        <rect
          x={7.5}
          y={7.5}
          width={13}
          height={13}
          transform={`rotate(45 ${BADGE_CX} ${BADGE_CY})`}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.7}
        />
      )}
      {symbol.shape === "star" && <Star cx={BADGE_CX} cy={BADGE_CY} size={15} fill={fill} stroke={stroke} />}
      {symbol.shape === "stars" &&
        // 2-3 stars scale down together so the cluster fits inside the SAME
        // fixed badge as every single-symbol rarity — the badge never grows.
        Array.from({ length: count }).map((_, i) => {
          const starSize = count === 3 ? 8 : 10;
          const spacing = count === 3 ? 7.5 : 8.5;
          const startX = BADGE_CX - (spacing * (count - 1)) / 2;
          return <Star key={i} cx={startX + i * spacing} cy={BADGE_CY} size={starSize} fill={fill} stroke={stroke} />;
        })}
      {symbol.shape === "shiny" && (
        <text
          x={BADGE_CX}
          y={BADGE_CY + 4.5}
          textAnchor="middle"
          fontSize={13}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.3}
        >
          ✦
        </text>
      )}
      {symbol.shape === "text" && (
        // Always the REAL printed colour (never recoloured) — sits on the
        // contrast badge so it stays legible on the dark UI.
        <text
          x={BADGE_CX}
          y={BADGE_CY + 3}
          textAnchor="middle"
          fontSize={textFontSize}
          fontWeight={800}
          fill={fill}
          stroke={stroke}
          strokeWidth={0.25}
        >
          {glyph}
        </text>
      )}
      {symbol.shape === "none" && (
        <text x={BADGE_CX} y={BADGE_CY + 4} textAnchor="middle" fontSize={12} fill="#9aa0a8">
          —
        </text>
      )}
    </svg>
  );
}
