import type { ReactElement } from "react";

interface Props {
  /** Colour scheme. gold = on dark backgrounds, black = on light backgrounds,
   *  white = on photographic or strongly-coloured backgrounds. */
  variant?: "gold" | "black" | "white";
  /** Type scale — pick the size that matches the surrounding text. */
  size?: "xs" | "sm" | "md" | "lg";
  /** Extra classes for the wrapping <svg>. Use for margin/alignment tweaks
   *  at the call site; the component handles its own colour and font. */
  className?: string;
}

const SIZES = {
  xs: { font: 8, padX: 3, padY: 2 },
  sm: { font: 10, padX: 4, padY: 2 },
  md: { font: 15, padX: 6, padY: 3 },
  lg: { font: 22, padX: 10, padY: 5 },
};

const COLORS = {
  gold: "#D4AF37",
  black: "#1A1A1A",
  white: "#FFFFFF",
};

export function MvgsMark({ variant = "gold", size = "md", className = "" }: Props): ReactElement {
  const s = SIZES[size];
  const color = COLORS[variant];
  const textW = s.font * 4 * 0.62;
  const trackW = s.font * 0.12 * 3;
  const w = Math.round(textW + trackW + s.padX * 2);
  const h = s.font + s.padY * 2;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="MVGS"
      className={`inline-block ${className}`.trim()}
      style={{ verticalAlign: "-0.18em" }}
    >
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke={color} strokeWidth={1} />
      <text
        x={w / 2}
        y={h / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fill={color}
        style={{
          fontFamily: "'Cinzel', Georgia, serif",
          fontSize: s.font,
          fontWeight: 600,
          letterSpacing: "0.12em",
        }}
      >
        MVGS
      </text>
    </svg>
  );
}

export default MvgsMark;
