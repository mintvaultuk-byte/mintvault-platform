import { useEffect, useRef, useState } from "react";

/**
 * HeroSlab — premium 3D graded-slab visual.
 *
 * Six-face composition (front, back, left/right edges, top/bottom edges)
 * inside a preserve-3d transform container. Front face mirrors the
 * original 2D layout (top badge / display field / bottom bar) so the
 * SlabContent contract is unchanged. The other five faces give physical
 * depth — the brand identity is the same, the rendering has weight.
 *
 * Public API preserved exactly: `SlabContent` interface and the default
 * `HeroSlabFan` export consumed by home, pricing, vault-club,
 * ai-pre-grade, and verify pages. Idle drift applies on every page.
 * Scroll-driven separation is opt-in via the `scrollResponse` prop —
 * home enables it; the other heroes stay calmer.
 *
 * Accessibility: respects `prefers-reduced-motion` by freezing both the
 * idle drift and the scroll response.
 */

export interface SlabContent {
  /** Top-right pill label. E.g. "MV133" or "STANDARD". Falsy hides the pill. */
  topBadge: string | null;
  /** Bottom-left primary label. E.g. a card name or "£25". */
  mainLabel: string;
  /** Bottom-right mono accent. E.g. "MV 9.5" or "15 DAY". Falsy hides it. */
  rightLabel: string | null;
  /** Bottom footnote row (md+ only). E.g. "NFC · Tracked" or "MOST CHOSEN". */
  footnote: string | null;
  /** React key override for stable list identity. */
  key?: string;
}

// 2% fractal noise overlay to break gradient banding — inline SVG, no asset.
const SLAB_NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Internal idle clock — slow monotonic time for sine-wave drift.
function useIdleTime(): number {
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let raf = 0;
    const tick = () => {
      setTime((t) => t + 0.005);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return time;
}

// Scroll progress 0..1 across an element's full pass through the viewport.
// p=0 when the element's top is at the viewport bottom, p=1 when it has
// scrolled fully past the viewport top. Uses passive scroll listener +
// rAF coalescing so this is cheap.
function useSectionProgress(ref: React.RefObject<HTMLElement>): number {
  const [progress, setProgress] = useState(0);
  const ticking = useRef(false);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const update = () => {
      const el = ref.current;
      ticking.current = false;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const total = rect.height + vh;
      const scrolled = vh - rect.top;
      const p = Math.max(0, Math.min(1, scrolled / total));
      setProgress(p);
    };
    const onScroll = () => {
      if (!ticking.current) {
        window.requestAnimationFrame(update);
        ticking.current = true;
      }
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ref]);
  return progress;
}

const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const range = (p: number, start: number, end: number) =>
  clamp((p - start) / (end - start));

interface SlabFaceProps {
  children?: React.ReactNode;
  transform: string;
  width: number;
  height: number;
  style?: React.CSSProperties;
}

function SlabFace({ children, transform, width, height, style = {} }: SlabFaceProps) {
  return (
    <div
      style={{
        position: "absolute",
        width,
        height,
        top: 0,
        left: 0,
        transform,
        backfaceVisibility: "hidden",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

interface Slab3DProps extends SlabContent {
  width: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  translateX?: number;
  translateY?: number;
  translateZ?: number;
  scale?: number;
  opacity?: number;
}

function Slab3D({
  width,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  translateX = 0,
  translateY = 0,
  translateZ = 0,
  scale = 1,
  opacity = 1,
  topBadge,
  mainLabel,
  rightLabel,
  footnote,
}: Slab3DProps) {
  const aspect = 0.82;
  const height = width / aspect;
  const depth = 14;

  return (
    <div
      style={{
        position: "absolute",
        width,
        height,
        transformStyle: "preserve-3d",
        transform: `translate3d(${translateX}px, ${translateY}px, ${translateZ}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scale})`,
        opacity,
        willChange: "transform, opacity",
      }}
    >
      {/* FRONT FACE — mirrors original 2D slab layout */}
      <SlabFace transform={`translateZ(${depth / 2}px)`} width={width} height={height}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 12,
            border: "1px solid rgba(212, 175, 55, 0.4)",
            backgroundColor: "var(--v2-paper-raised)",
            overflow: "hidden",
            boxShadow:
              "0 30px 60px -20px rgba(15,14,11,0.35), 0 12px 24px -10px rgba(15,14,11,0.18)",
          }}
        >
          {/* Top bar (10%) */}
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
                  fontSize: width * 0.05,
                  letterSpacing: "0.1em",
                  padding: "1px 6px",
                  border: "1px solid rgba(212, 175, 55, 0.4)",
                  borderRadius: 999,
                  lineHeight: 1,
                }}
              >
                {topBadge}
              </span>
            )}
          </div>

          {/* Display field (65%) */}
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
              className="font-display italic"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "rgba(255, 255, 255, 0.12)",
                fontSize: width * 0.14,
                whiteSpace: "nowrap",
                lineHeight: 1,
                userSelect: "none",
                fontWeight: 500,
              }}
            >
              MintVault
            </div>
          </div>

          {/* Bottom bar (25%) */}
          <div
            style={{
              height: "25%",
              padding: "6px 10px",
              backgroundColor: "var(--v2-paper-raised)",
              borderTop: "1px solid rgba(212, 175, 55, 0.3)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 4,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span
                className="font-body"
                style={{
                  color: "var(--v2-ink)",
                  fontSize: width * 0.07,
                  fontWeight: 500,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {mainLabel}
              </span>
              {rightLabel && (
                <span
                  className="font-mono-v2"
                  style={{
                    color: "var(--v2-gold)",
                    fontSize: width * 0.06,
                    fontWeight: 600,
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  {rightLabel}
                </span>
              )}
            </div>
            {footnote && (
              <div className="hidden md:flex" style={{ alignItems: "center", gap: 4 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    backgroundColor: "var(--v2-gold)",
                    display: "inline-block",
                  }}
                />
                <span
                  className="font-mono-v2"
                  style={{
                    color: "var(--v2-ink-mute)",
                    fontSize: 9,
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
      </SlabFace>

      {/* BACK FACE — registry mark + cert number */}
      <SlabFace
        transform={`translateZ(-${depth / 2}px) rotateY(180deg)`}
        width={width}
        height={height}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 12,
            border: "1px solid rgba(212, 175, 55, 0.4)",
            background:
              "linear-gradient(155deg, var(--v2-slab-gradient-navy) 0%, var(--v2-slab-gradient-petrol) 100%)",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
          }}
        >
          <div
            className="font-display italic"
            style={{
              fontSize: width * 0.18,
              color: "rgba(212,175,55,0.55)",
              fontWeight: 400,
              lineHeight: 1,
            }}
          >
            MV
          </div>
          <div
            className="font-mono-v2"
            style={{
              fontSize: width * 0.04,
              letterSpacing: "0.3em",
              color: "rgba(212,175,55,0.5)",
              marginTop: 14,
            }}
          >
            REGISTERED
          </div>
          {topBadge && (
            <div
              className="font-mono-v2"
              style={{
                fontSize: width * 0.035,
                letterSpacing: "0.2em",
                color: "rgba(255,255,255,0.4)",
                marginTop: 6,
              }}
            >
              {topBadge}
            </div>
          )}
        </div>
      </SlabFace>

      {/* LEFT EDGE */}
      <SlabFace
        transform={`rotateY(90deg) translateZ(${width / 2}px)`}
        width={depth}
        height={height}
        style={{ left: width / 2 - depth / 2 }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(90deg, var(--v2-paper-sunk) 0%, var(--v2-paper-raised) 50%, var(--v2-paper-sunk) 100%)",
          }}
        />
      </SlabFace>
      {/* RIGHT EDGE */}
      <SlabFace
        transform={`rotateY(-90deg) translateZ(${width / 2}px)`}
        width={depth}
        height={height}
        style={{ left: width / 2 - depth / 2 }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(90deg, var(--v2-paper-sunk) 0%, var(--v2-paper-raised) 50%, var(--v2-paper-sunk) 100%)",
          }}
        />
      </SlabFace>
      {/* TOP EDGE */}
      <SlabFace
        transform={`rotateX(90deg) translateZ(${height / 2}px)`}
        width={width}
        height={depth}
        style={{ top: height / 2 - depth / 2 }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, var(--v2-paper-raised) 0%, var(--v2-paper-sunk) 100%)",
          }}
        />
      </SlabFace>
      {/* BOTTOM EDGE */}
      <SlabFace
        transform={`rotateX(-90deg) translateZ(${height / 2}px)`}
        width={width}
        height={depth}
        style={{ top: height / 2 - depth / 2 }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, var(--v2-paper-sunk) 0%, var(--v2-paper-raised) 100%)",
          }}
        />
      </SlabFace>
    </div>
  );
}

interface HeroSlabFanProps {
  slabs: readonly [SlabContent, SlabContent, SlabContent];
  /**
   * When true, slabs rotate apart and tilt forward as the user scrolls past
   * the fan. Default false — only the home hero opts in. Other heroes
   * (pricing, vault-club, ai-pre-grade, verify) stay with idle drift only.
   */
  scrollResponse?: boolean;
}

export default function HeroSlabFan({ slabs, scrollResponse = false }: HeroSlabFanProps) {
  const containerRef = useRef<HTMLDivElement>(null);
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

  const time = useIdleTime();
  const sectionProgress = useSectionProgress(containerRef as React.RefObject<HTMLElement>);
  const scrollPush = scrollResponse ? range(sectionProgress, 0.35, 0.85) : 0;

  // Lighter idle drift on mobile to keep frame rate up on lower-end devices.
  const driftScale = isMobile ? 0.6 : 1;
  const slabWidth = isMobile ? 150 : 200;

  const rotations = [-8, 4, -2];
  const offsets = isMobile
    ? [{ x: -75, y: 20 }, { x: 0, y: -20 }, { x: 75, y: 20 }]
    : [{ x: -100, y: 20 }, { x: 0, y: -20 }, { x: 100, y: 20 }];

  return (
    <div
      ref={containerRef}
      className="relative h-[300px] md:h-[500px] flex items-center justify-center mx-auto"
      style={{
        width: "min(95vw, 520px)",
        maxWidth: "none",
        perspective: 1800,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          transformStyle: "preserve-3d",
        }}
      >
        {slabs.map((content, i) => {
          // Idle drift — sine waves with phase offset per slab.
          const drift = Math.sin(time * 1.0 + i * 1.3) * 18 * driftScale;
          const rotDriftY = Math.sin(time * 0.8 + i * 0.7) * 7 * driftScale;
          const rotDriftZ = Math.sin(time * 0.6 + i) * 3 * driftScale;

          // Scroll-driven separation (zeroed when scrollResponse=false).
          const slabScrollRotY = scrollPush * (20 - i * 6);
          const slabScrollX = scrollPush * (i - 1) * 50;
          const slabScrollTilt = scrollPush * 8;

          return (
            <div
              key={content.key ?? `slot-${i}`}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                marginLeft: -slabWidth / 2,
                marginTop: -slabWidth / 0.82 / 2,
                zIndex: slabs.length - i,
              }}
            >
              <Slab3D
                width={slabWidth}
                translateX={offsets[i].x + slabScrollX}
                translateY={offsets[i].y + drift}
                rotateZ={rotations[i] + rotDriftZ}
                rotateY={slabScrollRotY + rotDriftY}
                rotateX={slabScrollTilt}
                topBadge={content.topBadge}
                mainLabel={content.mainLabel}
                rightLabel={content.rightLabel}
                footnote={content.footnote}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
