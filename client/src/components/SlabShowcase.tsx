/**
 * SlabShowcase — CSS 3D floating card showcase for the homepage hero.
 *
 * Pure CSS 3D + a single requestAnimationFrame loop: no Three.js, no WebGL.
 * Each card is the REAL scan (via the same-origin /api/public/slab-image
 * proxy) floating in an arc with depth-of-field blur, mouse parallax, and
 * hover tilt. Clicking a card opens a cert overlay with the MVGS score and
 * a View Certificate CTA. No shine/glass overlay — the scan renders crisp.
 *
 * The white mat border on the scans (V850 scanner output) is INTENTIONAL —
 * against the dark vault background it reads as a physical card mount.
 * Never mask or crop it.
 */
import { useEffect, useRef, useState } from "react";

export interface SlabShowcaseItem {
  certNumber: string;
  dbId: number;
  grade: number;
  gradeLabel: string;
  gradeStrengthScore: number | null;
  cardName: string;
  setName: string | null;
  cardGame: string | null;
  labelType: string;
  frontLabelUrl: string;
  backLabelUrl: string | null;
  frontScanUrl: string | null;
}

interface Props {
  items: SlabShowcaseItem[];
  className?: string;
}

function gradeColor(grade: number): string {
  if (grade >= 10) return "#D4AF37"; // Gold — Gem Mint / Black Label
  if (grade >= 9.5) return "#c8a020"; // Deep gold — Mint+
  if (grade >= 9) return "#22c55e"; // Green — Mint
  if (grade >= 8) return "#16a34a"; // Dark green — NM-Mint+/NM-Mint
  if (grade >= 7) return "#3b82f6"; // Blue — NM+/Near Mint
  if (grade >= 6) return "#f59e0b"; // Amber — EX-Mint+/EX-Mint
  if (grade >= 5) return "#ea580c"; // Orange — Excellent+/Excellent
  if (grade >= 4) return "#ef4444"; // Red — VG-EX+/VG-EX
  return "#991b1b"; // Dark red — below 4
}

interface CardPosition {
  x: number;
  y: number;
  rotY: number;
  rotX: number;
  scale: number;
  blur: number;
  zIndex: number;
  depth: number;
  floatSpeed: number;
  floatAmp: number;
  floatOffset: number;
}

// Arc layout — index 0 is the centre hero card; far cards are smaller,
// blurrier (depth of field), move less with parallax, and bob out of phase.
const CARD_POSITIONS: CardPosition[] = [
  {
    x: 57,
    y: 50,
    rotY: 0, // centre hero card faces the viewer straight-on
    rotX: 0,
    scale: 1.0,
    blur: 0,
    zIndex: 8,
    depth: 1.0,
    floatSpeed: 3.8,
    floatAmp: 11,
    floatOffset: 0,
  },
  {
    x: 41,
    y: 38,
    rotY: 22,
    rotX: -3,
    scale: 0.86,
    blur: 0.3,
    zIndex: 6,
    depth: 0.72,
    floatSpeed: 4.4,
    floatAmp: 8,
    floatOffset: 1.2,
  },
  {
    x: 43,
    y: 68,
    rotY: 28,
    rotX: 6,
    scale: 0.8,
    blur: 0.5,
    zIndex: 5,
    depth: 0.65,
    floatSpeed: 3.6,
    floatAmp: 9,
    floatOffset: 2.4,
  },
  {
    x: 71,
    y: 26,
    rotY: -24,
    rotX: -4,
    scale: 0.76,
    blur: 0.4,
    zIndex: 4,
    depth: 0.6,
    floatSpeed: 5.0,
    floatAmp: 7,
    floatOffset: 0.8,
  },
  {
    x: 74,
    y: 68,
    rotY: -30,
    rotX: 7,
    scale: 0.68,
    blur: 1.0,
    zIndex: 3,
    depth: 0.5,
    floatSpeed: 4.2,
    floatAmp: 6,
    floatOffset: 1.8,
  },
  {
    x: 32,
    y: 22,
    rotY: 35,
    rotX: -5,
    scale: 0.62,
    blur: 1.2,
    zIndex: 2,
    depth: 0.45,
    floatSpeed: 4.8,
    floatAmp: 7,
    floatOffset: 3.0,
  },
  {
    x: 55,
    y: 78,
    rotY: -8,
    rotX: 10,
    scale: 0.58,
    blur: 1.4,
    zIndex: 1,
    depth: 0.4,
    floatSpeed: 3.4,
    floatAmp: 5,
    floatOffset: 2.0,
  },
  {
    x: 83,
    y: 45,
    rotY: -38,
    rotX: 5,
    scale: 0.55,
    blur: 1.6,
    zIndex: 1,
    depth: 0.38,
    floatSpeed: 5.2,
    floatAmp: 5,
    floatOffset: 0.4,
  },
];

// Centre card base size — 63×88mm card aspect.
const BASE_W = 168;
const BASE_H = 235;

export default function SlabShowcase({ items, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rafRef = useRef<number>(0);
  const [selected, setSelected] = useState<SlabShowcaseItem | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);

  // Per-card animation state — lives in refs so the RAF loop never re-renders.
  const floatOffsetY = useRef<number[]>([]);
  const parallaxOffset = useRef<{ x: number; y: number }[]>([]);
  const targetParallax = useRef<{ x: number; y: number }[]>([]);
  const isHoveringRef = useRef<boolean[]>([]);

  // (Re)size animation state when the item list changes.
  useEffect(() => {
    floatOffsetY.current = items.map(() => 0);
    parallaxOffset.current = items.map(() => ({ x: 0, y: 0 }));
    targetParallax.current = items.map(() => ({ x: 0, y: 0 }));
    isHoveringRef.current = items.map(() => false);
  }, [items]);

  // Combined base + parallax + float transform. Called by the RAF loop;
  // skipped while a card is hovered (hover tilt owns the transform then).
  function applyTransform(el: HTMLDivElement, i: number) {
    const pos = CARD_POSITIONS[i];
    if (!pos) return;
    const target = targetParallax.current[i] ?? { x: 0, y: 0 };
    const current = parallaxOffset.current[i] ?? { x: 0, y: 0 };
    // Lerp parallax toward target (smoothing)
    current.x += (target.x - current.x) * 0.06;
    current.y += (target.y - current.y) * 0.06;
    parallaxOffset.current[i] = current;
    if (isHoveringRef.current[i]) return; // hover handler drives the transform
    const fy = floatOffsetY.current[i] || 0;
    el.style.transform = `translate(calc(-50% + ${current.x.toFixed(2)}px), calc(-50% + ${(current.y + fy).toFixed(2)}px)) rotateY(${pos.rotY}deg) rotateX(${pos.rotX}deg)`;
  }

  // Float loop — sine bob per card with individual speed + phase offset.
  // CSS @keyframes can't stagger phases without N generated blocks.
  useEffect(() => {
    const loop = () => {
      const t = performance.now() / 1000;
      cardRefs.current.forEach((el, i) => {
        if (!el) return;
        const pos = CARD_POSITIONS[i];
        if (!pos) return;
        const bob = Math.sin(t * ((2 * Math.PI) / pos.floatSpeed) + pos.floatOffset) * pos.floatAmp;
        floatOffsetY.current[i] = bob;
        applyTransform(el, i);
      });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [items]);

  // Container-level mouse parallax + per-card specular shine tracking.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;

      CARD_POSITIONS.forEach((pos, i) => {
        if (!items[i]) return;
        targetParallax.current[i] = { x: nx * 55 * pos.depth, y: ny * 28 * pos.depth };
      });
    };

    container.addEventListener("mousemove", onMouseMove, { passive: true });
    return () => container.removeEventListener("mousemove", onMouseMove);
  }, [items]);

  if (!items.length) return null;

  const visible = items.slice(0, CARD_POSITIONS.length);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        perspective: "900px",
        perspectiveOrigin: "50% 50%",
        overflow: "hidden",
      }}
    >
      <style>{`@keyframes mv-showcase-spin { to { transform: rotate(360deg) } }`}</style>

      {/* Stage */}
      <div style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d" }}>
        {visible.map((item, index) => {
          const pos = CARD_POSITIONS[index];
          const cardW = Math.round(BASE_W * pos.scale);
          const cardH = Math.round(BASE_H * pos.scale);
          const colour = gradeColor(item.grade);
          const isSelected = selected?.certNumber === item.certNumber;

          return (
            <div
              key={item.certNumber}
              ref={(el) => (cardRefs.current[index] = el)}
              className="card-wrap"
              style={{
                position: "absolute",
                left: pos.x + "%",
                top: pos.y + "%",
                width: cardW + "px",
                height: cardH + "px",
                transform: `translate(-50%, -50%) rotateY(${pos.rotY}deg) rotateX(${pos.rotX}deg)`,
                transformStyle: "preserve-3d",
                zIndex: pos.zIndex,
                filter: pos.blur > 0 ? `blur(${pos.blur}px)` : "none",
                cursor: "pointer",
                transition: "filter 0.4s ease",
                willChange: "transform",
              }}
              onClick={() => setSelected(item)}
              onMouseMove={(e) => {
                const el = cardRefs.current[index];
                if (!el) return;
                isHoveringRef.current[index] = true;
                const rect = el.getBoundingClientRect();
                const cx = (e.clientX - rect.left) / rect.width - 0.5;
                const cy = (e.clientY - rect.top) / rect.height - 0.5;
                const extraRY = cx * 18;
                const extraRX = -cy * 12;
                const p = parallaxOffset.current[index] ?? { x: 0, y: 0 };
                const fy = floatOffsetY.current[index] || 0;
                el.style.transform = `translate(calc(-50% + ${p.x.toFixed(2)}px), calc(-50% + ${(p.y + fy).toFixed(2)}px)) rotateY(${pos.rotY + extraRY}deg) rotateX(${pos.rotX + extraRX}deg) scale(1.04)`;
                const badge = el.querySelector("[data-badge]") as HTMLElement | null;
                if (badge) badge.style.transform = "scale(1.12) translateZ(6px)";
              }}
              onMouseLeave={() => {
                isHoveringRef.current[index] = false;
                const badge = cardRefs.current[index]?.querySelector("[data-badge]") as HTMLElement | null;
                if (badge) badge.style.transform = "";
                // applyTransform restores the base rotation on the next RAF tick
              }}
            >
              {/* Ambient colour glow underneath the card */}
              <div
                style={{
                  position: "absolute",
                  bottom: "-18px",
                  left: "-10%",
                  right: "-10%",
                  height: "36px",
                  background: `radial-gradient(ellipse, ${colour}50 0%, transparent 70%)`,
                  filter: "blur(10px)",
                  pointerEvents: "none",
                }}
              />

              {/* Card face */}
              <div
                className="card-face"
                style={{
                  // No preserve-3d here — a 3D context on the face forces the
                  // image onto its own compositing layer, which softens it.
                  // The thickness edges are decorative and survive flattening.
                  width: "100%",
                  height: "100%",
                  position: "relative",
                  borderRadius: "8px",
                  boxShadow: `0 ${Math.round(22 * pos.scale)}px ${Math.round(55 * pos.scale)}px rgba(0,0,0,0.85), 0 ${Math.round(6 * pos.scale)}px ${Math.round(18 * pos.scale)}px rgba(0,0,0,0.5), 0 0 0 1.5px ${colour}70${isSelected ? `, 0 0 ${Math.round(34 * pos.scale)}px ${colour}66` : ""}`,
                }}
              >
                {/* Card thickness — right edge */}
                <div
                  style={{
                    position: "absolute",
                    top: "1px",
                    right: "-5px",
                    width: "5px",
                    height: "calc(100% - 2px)",
                    background: "linear-gradient(90deg, #d8d8d4, #b0b0aa)",
                    transform: "rotateY(90deg)",
                    transformOrigin: "left center",
                    borderRadius: "0 3px 3px 0",
                  }}
                />

                {/* Card thickness — bottom edge */}
                <div
                  style={{
                    position: "absolute",
                    bottom: "-4px",
                    left: "4%",
                    right: "4%",
                    height: "4px",
                    background: "linear-gradient(180deg, #b8b8b2, #909088)",
                    transform: "rotateX(-90deg)",
                    transformOrigin: "top center",
                    borderRadius: "0 0 2px 2px",
                  }}
                />

                {/* Gold frame ring */}
                <div
                  style={{
                    position: "absolute",
                    inset: "-2.5px",
                    borderRadius: "10.5px",
                    border: `1.5px solid ${colour}90`,
                    boxShadow: `0 0 ${Math.round(16 * pos.scale)}px ${colour}35`,
                    pointerEvents: "none",
                    zIndex: 5,
                  }}
                />

                {/* Real card scan — white mat border is intentional (card mount) */}
                <img
                  src={item.frontScanUrl || item.frontLabelUrl}
                  alt={item.cardName}
                  draggable={false}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    borderRadius: "7px",
                    display: "block",
                    userSelect: "none",
                    imageRendering: "high-quality" as const,
                    WebkitBackfaceVisibility: "hidden" as const,
                  }}
                  onLoad={() => setLoadedCount((c) => c + 1)}
                  onError={(e) => {
                    // Fallback to label if scan fails; count as loaded if both fail
                    if (
                      item.frontLabelUrl &&
                      e.currentTarget.src !== new URL(item.frontLabelUrl, window.location.origin).href
                    ) {
                      e.currentTarget.src = item.frontLabelUrl;
                    } else {
                      console.warn("[SlabShowcase] image load failed:", item.certNumber);
                      setLoadedCount((c) => c + 1);
                    }
                  }}
                />

                {/* Grade badge sticker — bottom right */}
                <div
                  data-badge
                  style={{
                    position: "absolute",
                    bottom: Math.round(-13 * pos.scale) + "px",
                    right: Math.round(-13 * pos.scale) + "px",
                    width: Math.round(50 * pos.scale) + "px",
                    height: Math.round(50 * pos.scale) + "px",
                    borderRadius: "50%",
                    background: `linear-gradient(135deg, ${colour}, ${colour}bb)`,
                    border: "2px solid rgba(255,255,255,0.22)",
                    boxShadow: `0 ${Math.round(4 * pos.scale)}px ${Math.round(16 * pos.scale)}px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.28)`,
                    display: "flex",
                    flexDirection: "column" as const,
                    alignItems: "center",
                    justifyContent: "center",
                    zIndex: 7,
                    transition: "transform 0.3s ease",
                    color: item.grade >= 9.5 ? "#0a0a08" : "#fff",
                  }}
                >
                  <span
                    style={{
                      fontSize: (item.grade % 1 !== 0 ? Math.round(13 * pos.scale) : Math.round(16 * pos.scale)) + "px",
                      fontWeight: 800,
                      lineHeight: 1,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {item.grade}
                  </span>
                  <span
                    style={{
                      fontSize: Math.round(6 * pos.scale) + "px",
                      textTransform: "uppercase" as const,
                      letterSpacing: "0.04em",
                      marginTop: "1px",
                      opacity: 0.85,
                      lineHeight: 1,
                    }}
                  >
                    {item.gradeLabel}
                  </span>
                </div>

                {/* MintVault cert chip — top left */}
                <div
                  style={{
                    position: "absolute",
                    top: Math.round(-9 * pos.scale) + "px",
                    left: Math.round(9 * pos.scale) + "px",
                    background: "rgba(10,10,8,0.94)",
                    border: "1px solid rgba(212,175,55,0.45)",
                    borderRadius: "4px",
                    padding: `${Math.round(2.5 * pos.scale)}px ${Math.round(7 * pos.scale)}px`,
                    fontSize: Math.round(7.5 * pos.scale) + "px",
                    color: "#D4AF37",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase" as const,
                    fontWeight: 700,
                    zIndex: 7,
                    boxShadow: "0 2px 8px rgba(0,0,0,0.6)",
                    whiteSpace: "nowrap" as const,
                  }}
                >
                  MintVault
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Loading spinner — fades out once every card image has resolved */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          opacity: loadedCount >= visible.length ? 0 : 1,
          transition: "opacity 0.6s ease",
          pointerEvents: "none",
          zIndex: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            border: "2px solid rgba(212,175,55,0.3)",
            borderTopColor: "#D4AF37",
            animation: "mv-showcase-spin 0.8s linear infinite",
          }}
        />
      </div>

      {/* Cert overlay */}
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 100,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          background: selected ? "rgba(0,0,0,0.6)" : "transparent",
          backdropFilter: selected ? "blur(4px)" : "none",
          transition: "background 0.35s ease, backdrop-filter 0.35s ease",
          pointerEvents: selected ? "all" : "none",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "700px",
            background: "#111110",
            border: "1px solid rgba(212,175,55,0.22)",
            borderBottom: "none",
            borderRadius: "22px 22px 0 0",
            padding: "28px 32px 32px",
            transform: selected ? "translateY(0)" : "translateY(100%)",
            transition: "transform 0.4s cubic-bezier(0.32,0.72,0,1)",
            boxShadow: "0 -20px 60px rgba(0,0,0,0.5)",
            position: "relative",
          }}
        >
          {/* Close */}
          <button
            onClick={() => setSelected(null)}
            aria-label="Close"
            style={{
              position: "absolute",
              top: 16,
              right: 18,
              width: 32,
              height: 32,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "50%",
              color: "rgba(255,255,255,0.5)",
              fontSize: 17,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>

          {/* Header: grade badge + identity */}
          <div style={{ display: "flex", gap: 18, marginBottom: 22, alignItems: "flex-start" }}>
            <div
              style={{
                width: 68,
                height: 68,
                borderRadius: "50%",
                border: `2px solid ${gradeColor(selected?.grade ?? 0)}55`,
                background: `${gradeColor(selected?.grade ?? 0)}12`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontSize: 25,
                  fontWeight: 800,
                  color: gradeColor(selected?.grade ?? 0),
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {selected?.grade}
              </span>
              <span
                style={{
                  fontSize: 8.5,
                  color: "rgba(255,255,255,0.45)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  marginTop: 3,
                }}
              >
                {selected?.gradeLabel}
              </span>
            </div>

            <div>
              <div style={{ fontSize: 21, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{selected?.cardName}</div>
              {selected?.setName && (
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginBottom: 8 }}>{selected.setName}</div>
              )}
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: 11,
                  color: "rgba(255,255,255,0.22)",
                  letterSpacing: "0.05em",
                }}
              >
                {selected?.certNumber} · MINTVAULT CERTIFIED
              </div>
            </div>
          </div>

          {/* MVGS score bar */}
          {selected?.gradeStrengthScore != null && (
            <div
              style={{
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.06)",
                borderRadius: 10,
                padding: "14px 16px",
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: "rgba(255,255,255,0.28)",
                  marginBottom: 10,
                  fontWeight: 600,
                }}
              >
                MVGS Score
              </div>
              <div
                style={{
                  height: 5,
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: 3,
                  overflow: "hidden",
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${selected.gradeStrengthScore}%`,
                    background: "linear-gradient(90deg, #D4AF37, #f0d070)",
                    borderRadius: 3,
                    transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
                  }}
                />
              </div>
              <div style={{ display: "flex", gap: 20 }}>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                  <b style={{ color: "rgba(255,255,255,0.7)" }}>{selected.gradeStrengthScore}</b>/100
                </span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                  Graded by <b style={{ color: "rgba(255,255,255,0.7)" }}>MintVault UK</b>
                </span>
                <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
                  Standard <b style={{ color: "rgba(255,255,255,0.7)" }}>MVGS v2</b>
                </span>
              </div>
            </div>
          )}

          {/* Footer: QR placeholder + tagline + CTA */}
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 48,
                height: 48,
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 6,
                background: "rgba(255,255,255,0.03)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 7,
                color: "rgba(255,255,255,0.18)",
                letterSpacing: "0.05em",
                flexShrink: 0,
              }}
            >
              QR
            </div>

            <div style={{ flex: 1, fontSize: 11, color: "rgba(255,255,255,0.2)", lineHeight: 1.5 }}>
              Verifiable grading report, NFC-linked
              <br />
              ownership logbook &amp; certificate.
            </div>

            <a
              href={`/cert/${selected?.certNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background: "#D4AF37",
                color: "#0a0a08",
                padding: "12px 22px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 700,
                textDecoration: "none",
                whiteSpace: "nowrap",
                flexShrink: 0,
                display: "inline-block",
              }}
            >
              View Certificate →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
