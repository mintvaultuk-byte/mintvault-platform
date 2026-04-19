import { useEffect, useState } from "react";

/**
 * HeroSlab — single premium graded-slab visual.
 *
 * Three render zones:
 *   TOP (~10%)     — gold pill with topBadge text, top-right.
 *   DISPLAY (~65%) — navy→teal→bronze gradient + 2% noise + centred
 *                    Fraunces "MintVault" monogram (brand signature,
 *                    identical across every slab regardless of content).
 *   BOTTOM (~25%)  — mainLabel (left, body) + rightLabel (right, mono gold)
 *                    on first row, footnote with gold dot below (md+ only).
 *
 * Purely presentational — the caller decides whether to feed cert data,
 * tier pricing data, or anything else. See HeroSlabFan below for the
 * standard 3-slab fan layout used by home-v2 and pricing-v2.
 */

export interface SlabContent {
  /** Top-right pill label. E.g. "MV133" or "STANDARD". Falsy hides the pill. */
  topBadge: string | null;
  /** Bottom-left primary label. E.g. a card name or "£25". */
  mainLabel: string;
  /** Bottom-right mono accent. E.g. "MV 9.5" or "15 DAY". Falsy hides it. */
  rightLabel: string | null;
  /** Bottom footnote row (md+ only). E.g. "NFC · Verified" or "MOST CHOSEN". */
  footnote: string | null;
  /** React key override for stable list identity. */
  key?: string;
}

// 2% fractal noise overlay to break up gradient banding — inline SVG so we
// don't ship a separate asset. `%23` = `#` (URL-encoded for the data URL).
const SLAB_NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

export function HeroSlab({
  content,
  rotation,
  offset,
  zIndex,
}: {
  content: SlabContent;
  rotation: number;
  offset: { x: number; y: number };
  zIndex: number;
}) {
  const { topBadge, mainLabel, rightLabel, footnote } = content;

  return (
    <div
      className="absolute overflow-hidden transition-shadow duration-300 hover:shadow-[0_20px_40px_-12px_rgba(15,14,11,0.25)]"
      style={{
        ["--slab-width" as any]: "clamp(120px, 40vw, 220px)",
        width: "var(--slab-width)",
        aspectRatio: "0.82",
        borderRadius: "12px",
        border: "1px solid rgba(212, 175, 55, 0.4)",
        backgroundColor: "var(--v2-paper-raised)",
        transform: `rotate(${rotation}deg) translate(${offset.x}px, ${offset.y}px)`,
        zIndex,
      }}
    >
      {/* TOP BAR */}
      <div
        style={{
          height: "10%",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          padding: "0 8px",
        }}
      >
        {topBadge && (
          <span
            className="font-mono-v2"
            style={{
              color: "var(--v2-gold-soft)",
              fontSize: "clamp(8px, 2.2vw, 10px)",
              letterSpacing: "0.1em",
              padding: "1px 6px",
              border: "1px solid rgba(212, 175, 55, 0.4)",
              borderRadius: "999px",
              lineHeight: 1,
            }}
          >
            {topBadge}
          </span>
        )}
      </div>

      {/* DISPLAY FIELD */}
      <div
        style={{
          height: "65%",
          position: "relative",
          background:
            "radial-gradient(circle at top left, var(--v2-slab-gradient-navy) 0%, var(--v2-slab-gradient-petrol) 35%, var(--v2-slab-gradient-teal) 70%, var(--v2-slab-gradient-bronze) 100%)",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: SLAB_NOISE_SVG,
            opacity: 0.02,
            pointerEvents: "none",
          }}
        />
        <div
          className="absolute inset-0 flex items-center justify-center font-display italic"
          style={{
            color: "rgba(255, 255, 255, 0.12)",
            fontSize: "calc(var(--slab-width) * 0.14)",
            whiteSpace: "nowrap",
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          MintVault
        </div>
      </div>

      {/* BOTTOM BAR */}
      <div
        style={{
          height: "25%",
          padding: "6px 10px",
          backgroundColor: "var(--v2-paper-raised)",
          borderTop: "1px solid rgba(212, 175, 55, 0.3)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "4px",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="font-body truncate"
            style={{
              color: "var(--v2-ink)",
              fontSize: "clamp(10px, 2.8vw, 14px)",
              fontWeight: 500,
              minWidth: 0,
            }}
          >
            {mainLabel}
          </span>
          {rightLabel && (
            <span
              className="font-mono-v2 shrink-0"
              style={{
                color: "var(--v2-gold)",
                fontSize: "clamp(9px, 2.4vw, 12px)",
                fontWeight: 600,
                lineHeight: 1,
              }}
            >
              {rightLabel}
            </span>
          )}
        </div>
        {footnote && (
          <div className="hidden md:flex items-center gap-1">
            <span
              aria-hidden="true"
              style={{
                width: "5px",
                height: "5px",
                borderRadius: "999px",
                backgroundColor: "var(--v2-gold)",
                display: "inline-block",
              }}
            />
            <span
              className="font-mono-v2"
              style={{
                color: "var(--v2-ink-mute)",
                fontSize: "9px",
                letterSpacing: "0.05em",
                lineHeight: 1,
              }}
            >
              {footnote}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * HeroSlabFan — 3-slab asymmetric fan container used in v2 hero layouts.
 *
 * Fixed rotations [-8°, +4°, -2°] and offsets that spread the slabs into a
 * left/centre/right fan. Desktop uses ±100px offsets; mobile narrows to ±75px
 * to avoid container clip on <768px viewports. Z-indexing stacks slot 0 on
 * top so that overlap regions favour the first slab (newest cert / featured
 * tier).
 */
export default function HeroSlabFan({
  slabs,
}: {
  slabs: readonly [SlabContent, SlabContent, SlabContent];
}) {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const rotations = [-8, 4, -2];
  const offsets = isMobile
    ? [{ x: -75, y: 20 }, { x: 0, y: -20 }, { x: 75, y: 20 }]
    : [{ x: -100, y: 20 }, { x: 0, y: -20 }, { x: 100, y: 20 }];

  return (
    <div
      className="relative h-[300px] md:h-[500px] flex items-center justify-center mx-auto"
      style={{ width: "min(95vw, 520px)", maxWidth: "none" }}
    >
      {slabs.map((content, i) => (
        <HeroSlab
          key={content.key ?? `slot-${i}`}
          content={content}
          rotation={rotations[i]}
          offset={offsets[i]}
          zIndex={slabs.length - i}
        />
      ))}
    </div>
  );
}
