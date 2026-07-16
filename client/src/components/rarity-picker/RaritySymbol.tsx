/**
 * Visual rarity-symbol renderer. Draws the ACTUAL symbol (circle / diamond / 1-2-3
 * stars / shiny / code) filled with the correct colour so gold vs silver and 2★ vs 1★
 * are distinguishable by SHAPE + FILL, never by text colour alone.
 */
import type { RaritySymbol as RaritySymbolMeta, SymbolColour } from "@shared/pokemon-rarity-catalogue";

const FILL: Record<SymbolColour, string> = {
  gold: "#C8A227",
  silver: "#AEB4BC",
  black: "#1b1b1f",
  bronze: "#A9713B",
  white: "#f5f5f5",
  rainbow: "url(#mv-rarity-rainbow)",
  none: "transparent",
};
const STROKE: Record<SymbolColour, string> = {
  gold: "#8a6d12",
  silver: "#7d828a",
  black: "#000",
  bronze: "#6f4a24",
  white: "#c9c9c9",
  rainbow: "#7a3ea8",
  none: "#9aa0a8",
};

function Star({ x, size, fill, stroke }: { x: number; size: number; fill: string; stroke: string }) {
  // A five-pointed star path, centred at (x, 12), scaled to `size`.
  const s = size / 24;
  const pts = [
    [12, 2], [15, 9], [22, 9.3], [16.5, 14], [18.5, 21], [12, 17], [5.5, 21], [7.5, 14], [2, 9.3], [9, 9],
  ]
    .map(([px, py]) => `${x + (px - 12) * s},${12 + (py - 12) * s}`)
    .join(" ");
  return <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={0.8} strokeLinejoin="round" />;
}

export function RaritySymbol({ symbol, size = 30 }: { symbol: RaritySymbolMeta; size?: number }) {
  const fill = FILL[symbol.colour];
  const stroke = STROKE[symbol.colour];
  const count = symbol.count ?? 1;
  const w = symbol.shape === "stars" ? size * (count === 3 ? 2.2 : 1.7) : size;
  return (
    <svg width={w} height={size} viewBox={`0 0 ${symbol.shape === "stars" ? (count === 3 ? 53 : 41) : 24} 24`} aria-hidden>
      <defs>
        <linearGradient id="mv-rarity-rainbow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="35%" stopColor="#ffd24d" />
          <stop offset="65%" stopColor="#4dd2ff" />
          <stop offset="100%" stopColor="#b14dff" />
        </linearGradient>
      </defs>
      {symbol.shape === "circle" && <circle cx={12} cy={12} r={8} fill={fill} stroke={stroke} strokeWidth={0.8} />}
      {symbol.shape === "diamond" && <rect x={6} y={6} width={12} height={12} transform="rotate(45 12 12)" fill={fill} stroke={stroke} strokeWidth={0.8} />}
      {symbol.shape === "star" && <Star x={12} size={20} fill={fill} stroke={stroke} />}
      {symbol.shape === "stars" &&
        Array.from({ length: count }).map((_, i) => <Star key={i} x={9 + i * 16} size={16} fill={fill} stroke={stroke} />)}
      {symbol.shape === "shiny" && (
        <text x={12} y={17} textAnchor="middle" fontSize={16} fill={fill} stroke={stroke} strokeWidth={0.3}>✦</text>
      )}
      {symbol.shape === "text" && (
        <text x={12} y={16} textAnchor="middle" fontSize={9} fontWeight={800} fill={symbol.colour === "black" ? "#1b1b1f" : fill} stroke={symbol.colour === "black" ? "none" : stroke} strokeWidth={0.3}>
          {symbol.glyph}
        </text>
      )}
      {symbol.shape === "none" && <text x={12} y={17} textAnchor="middle" fontSize={14} fill="#9aa0a8">—</text>}
    </svg>
  );
}
