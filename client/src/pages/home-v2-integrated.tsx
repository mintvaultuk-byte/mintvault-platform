// @ts-nocheck — visual mockup; full port pending
import { useEffect, useState, useRef } from "react";

/* =========================================================================
   MINTVAULT — INTEGRATED HOME MOCKUP
   Built against actual /v2-tokens.css values + hero-slab.tsx structure.
   Mirrors home.tsx Sections A–F. Adds 3D scroll choreography.
   ========================================================================= */

// EXACT v2 tokens from client/src/styles/v2-tokens.css
const V = {
  ink: "#0F0E0B",
  inkSoft: "#3A362E",
  inkMute: "#6B6454",
  paper: "#FAF7F1",
  paperRaised: "#FFFFFF",
  paperSunk: "#F4F0E6",
  line: "#E8E1D0",
  lineSoft: "#EFE9DA",
  gold: "#B8960C",
  goldSoft: "#D4AF37",
  goldDark: "#8A6F08",
  panelDark: "#1A1612",
  panelDarkSoft: "#2A241C",
  slabNavy: "hsl(220, 45%, 15%)",
  slabPetrol: "hsl(200, 50%, 25%)",
  slabTeal: "hsl(160, 30%, 35%)",
  slabBronze: "hsl(45, 45%, 55%)",
};

const SLAB_NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

// --- Section progress hook ---
function useSectionProgress(ref) {
  const [progress, setProgress] = useState(0);
  const ticking = useRef(false);
  useEffect(() => {
    const update = () => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      const vh = window.innerHeight;
      const total = rect.height + vh;
      const scrolled = vh - rect.top;
      const p = Math.max(0, Math.min(1, scrolled / total));
      setProgress(p);
      ticking.current = false;
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

const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const range = (p, start, end) => clamp((p - start) / (end - start));

// Idle drift hook — gentle floating animation
function useIdleTime() {
  const [time, setTime] = useState(0);
  useEffect(() => {
    let raf;
    const tick = () => {
      setTime((t) => t + 0.005);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return time;
}

/* =========================================================================
   3D SLAB — exact reproduction of hero-slab.tsx structure with depth
   ========================================================================= */
function Slab3D({
  width = 200,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  translateX = 0,
  translateY = 0,
  translateZ = 0,
  scale = 1,
  opacity = 1,
  topBadge = "MV234",
  mainLabel = "MintVault",
  rightLabel = "MV 9.0",
  footnote = "NFC \u00b7 Tracked",
}) {
  const aspect = 0.82;
  const height = width / aspect;
  const depth = 14;

  return (
    <div style={{
      position: "absolute",
      width,
      height,
      transformStyle: "preserve-3d",
      transform: `translate3d(${translateX}px, ${translateY}px, ${translateZ}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scale})`,
      opacity,
      willChange: "transform, opacity",
    }}>
      {/* FRONT FACE — exact replica of HeroSlab structure */}
      <SlabFace transform={`translateZ(${depth / 2}px)`} width={width} height={height}>
        <div style={{
          position: "absolute",
          inset: 0,
          borderRadius: 12,
          border: "1px solid rgba(212, 175, 55, 0.4)",
          backgroundColor: V.paperRaised,
          overflow: "hidden",
          boxShadow: "0 30px 60px -20px rgba(15,14,11,0.35), 0 12px 24px -10px rgba(15,14,11,0.18)",
        }}>
          {/* TOP BAR (10%) */}
          <div style={{
            height: "10%",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            padding: "0 8px",
          }}>
            {topBadge && (
              <span style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: V.goldSoft,
                fontSize: width * 0.05,
                letterSpacing: "0.1em",
                padding: "1px 6px",
                border: "1px solid rgba(212, 175, 55, 0.4)",
                borderRadius: 999,
                lineHeight: 1,
              }}>
                {topBadge}
              </span>
            )}
          </div>

          {/* DISPLAY FIELD (65%) — exact gradient from v2-tokens */}
          <div style={{
            height: "65%",
            position: "relative",
            background: `radial-gradient(circle at top left, ${V.slabNavy} 0%, ${V.slabPetrol} 35%, ${V.slabTeal} 70%, ${V.slabBronze} 100%)`,
          }}>
            {/* Noise overlay */}
            <div style={{
              position: "absolute",
              inset: 0,
              backgroundImage: SLAB_NOISE_SVG,
              opacity: 0.02,
              pointerEvents: "none",
            }} />
            {/* MintVault watermark */}
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "'Fraunces', Georgia, serif",
              fontStyle: "italic",
              color: "rgba(255, 255, 255, 0.12)",
              fontSize: width * 0.14,
              whiteSpace: "nowrap",
              lineHeight: 1,
              userSelect: "none",
              fontWeight: 500,
            }}>
              MintVault
            </div>
          </div>

          {/* BOTTOM BAR (25%) */}
          <div style={{
            height: "25%",
            padding: "6px 10px",
            backgroundColor: V.paperRaised,
            borderTop: "1px solid rgba(212, 175, 55, 0.3)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 4,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{
                fontFamily: "'Geist Variable', 'Geist', system-ui, sans-serif",
                color: V.ink,
                fontSize: width * 0.07,
                fontWeight: 500,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}>
                {mainLabel}
              </span>
              {rightLabel && (
                <span style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  color: V.gold,
                  fontSize: width * 0.06,
                  fontWeight: 600,
                  lineHeight: 1,
                  flexShrink: 0,
                }}>
                  {rightLabel}
                </span>
              )}
            </div>
            {footnote && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{
                  width: 5,
                  height: 5,
                  borderRadius: 999,
                  backgroundColor: V.gold,
                  display: "inline-block",
                }} />
                <span style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  color: V.inkMute,
                  fontSize: 9,
                  letterSpacing: "0.05em",
                  lineHeight: 1,
                }}>
                  {footnote}
                </span>
              </div>
            )}
          </div>
        </div>
      </SlabFace>

      {/* BACK FACE */}
      <SlabFace transform={`translateZ(-${depth / 2}px) rotateY(180deg)`} width={width} height={height}>
        <div style={{
          position: "absolute",
          inset: 0,
          borderRadius: 12,
          border: "1px solid rgba(212, 175, 55, 0.4)",
          background: `linear-gradient(155deg, ${V.slabNavy} 0%, ${V.slabPetrol} 100%)`,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "column",
        }}>
          <div style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic",
            fontSize: width * 0.18,
            color: `rgba(212,175,55,0.55)`,
            fontWeight: 400,
            lineHeight: 1,
          }}>
            MV
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: width * 0.04,
            letterSpacing: "0.3em",
            color: "rgba(212,175,55,0.5)",
            marginTop: 14,
          }}>
            REGISTERED
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: width * 0.035,
            letterSpacing: "0.2em",
            color: "rgba(255,255,255,0.4)",
            marginTop: 6,
          }}>
            {topBadge}
          </div>
        </div>
      </SlabFace>

      {/* EDGES — paper-coloured (slab is in a paper-coloured frame) */}
      <SlabFace transform={`rotateY(90deg) translateZ(${width / 2}px)`} width={depth} height={height} style={{ left: width / 2 - depth / 2 }}>
        <div style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(90deg, ${V.paperSunk} 0%, ${V.paperRaised} 50%, ${V.paperSunk} 100%)`,
        }} />
      </SlabFace>
      <SlabFace transform={`rotateY(-90deg) translateZ(${width / 2}px)`} width={depth} height={height} style={{ left: width / 2 - depth / 2 }}>
        <div style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(90deg, ${V.paperSunk} 0%, ${V.paperRaised} 50%, ${V.paperSunk} 100%)`,
        }} />
      </SlabFace>
      <SlabFace transform={`rotateX(90deg) translateZ(${height / 2}px)`} width={width} height={depth} style={{ top: height / 2 - depth / 2 }}>
        <div style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(180deg, ${V.paperRaised} 0%, ${V.paperSunk} 100%)`,
        }} />
      </SlabFace>
      <SlabFace transform={`rotateX(-90deg) translateZ(${height / 2}px)`} width={width} height={depth} style={{ top: height / 2 - depth / 2 }}>
        <div style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(180deg, ${V.paperSunk} 0%, ${V.paperRaised} 100%)`,
        }} />
      </SlabFace>
    </div>
  );
}

function SlabFace({ children, transform, width, height, style = {} }) {
  return (
    <div style={{
      position: "absolute",
      width,
      height,
      top: 0,
      left: 0,
      transform,
      backfaceVisibility: "hidden",
      ...style,
    }}>
      {children}
    </div>
  );
}

/* =========================================================================
   HEADER — replica of header-v2.tsx
   ========================================================================= */
function Header() {
  return (
    <header style={{
      position: "sticky",
      top: 0,
      zIndex: 50,
      backgroundColor: V.paper,
      borderBottom: `1px solid ${V.line}`,
    }}>
      <div style={{
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
        height: 64,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
          <span style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", color: V.ink,
          }}>Mint</span>
          <span style={{ fontSize: 18, color: V.inkMute }}>·</span>
          <span style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic",
            fontSize: 18, fontWeight: 500, color: V.ink,
          }}>Vault</span>
        </div>

        {/* Nav */}
        <nav style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {[
            { label: "Grading", caret: true },
            { label: "Vault Club" },
            { label: "Verify" },
            { label: "Technology" },
            { label: "Registry" },
            { label: "Journal" },
          ].map((item) => (
            <span key={item.label} style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 14, fontWeight: 500, color: V.inkSoft,
              cursor: "pointer",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              {item.label}
              {item.caret && <span style={{ fontSize: 10 }}>▾</span>}
            </span>
          ))}
        </nav>

        {/* Right utility */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 14, fontWeight: 500, color: V.inkSoft,
            display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          }}>
            <span style={{
              width: 14, height: 14, borderRadius: "50%",
              border: `1.5px solid ${V.inkSoft}`,
              fontSize: 9, display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}>?</span>
            Help
          </span>
          <span style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 14, fontWeight: 500, color: V.inkSoft,
            display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          }}>
            ⊞ Dashboard
          </span>
          <button style={{
            backgroundColor: V.ink,
            color: V.paper,
            border: "none",
            borderRadius: 999,
            padding: "8px 20px",
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 14, fontWeight: 600,
            cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            Submit a card →
          </button>
        </div>
      </div>
    </header>
  );
}

/* =========================================================================
   SECTION A — HERO with 3D animated slab fan
   ========================================================================= */
function SectionAHero() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);
  const time = useIdleTime();

  // As you scroll past hero into Section B, slabs begin to rotate (preview of inspection)
  const scrollPush = range(p, 0.45, 0.85);

  // EXACT same fan layout as HeroSlabFan.tsx — rotations [-8, 4, -2], offsets ±100/0/+100, y 20/-20/20
  const slabs = [
    { idx: 0, rot: -8, ox: -100, oy: 20, topBadge: "MV234", mainLabel: "Holo Charizard #4", rightLabel: "MV 9.0", footnote: "NFC \u00b7 Tracked" },
    { idx: 1, rot: 4, ox: 0, oy: -20, topBadge: "MV232", mainLabel: "Pikachu Illustrator", rightLabel: "MV 8.0", footnote: "NFC \u00b7 Tracked" },
    { idx: 2, rot: -2, ox: 100, oy: 20, topBadge: "MV229", mainLabel: "Lugia Neo Genesis", rightLabel: "MV 7.0", footnote: "NFC \u00b7 Tracked" },
  ];

  return (
    <section ref={ref} style={{ position: "relative" }}>
      <div style={{
        maxWidth: 1280,
        margin: "0 auto",
        padding: "40px 24px 128px",
        display: "grid",
        gridTemplateColumns: "1.4fr 1fr",
        gap: 64,
        alignItems: "center",
      }}>
        {/* LEFT — copy (1:1 with home.tsx) */}
        <div>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 12,
            color: V.gold,
            letterSpacing: "0.25em",
            textTransform: "uppercase",
            marginBottom: 24,
            fontWeight: 500,
          }}>
            Est. Kent · MintVault UK
          </p>
          <h1 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic",
            fontWeight: 500,
            fontSize: "clamp(2.75rem, 6vw, 5rem)",
            lineHeight: 0.95,
            color: V.ink,
            margin: 0,
            marginBottom: 24,
          }}>
            The standard for<br />graded collectibles.
          </h1>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 18,
            lineHeight: 1.625,
            color: V.inkSoft,
            maxWidth: 576,
            margin: 0,
            marginBottom: 32,
          }}>
            AI-powered precision grading with NFC-linked certification.
            Every grade logged, every slab traceable.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 20 }}>
            <button style={{
              backgroundColor: V.ink, color: V.paper, border: "none", borderRadius: 999,
              padding: "12px 24px",
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 14, fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 8,
            }}>
              Submit a card →
            </button>
            <button style={{
              backgroundColor: "transparent", color: V.inkSoft,
              border: `1px solid ${V.line}`, borderRadius: 999,
              padding: "12px 24px",
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 14, fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 8,
            }}>
              Try AI Pre-Grade →
            </button>
          </div>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10,
            color: V.inkMute,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            margin: 0,
          }}>
            From £19 · 40 day turnaround · UK return shipping insured
          </p>
        </div>

        {/* RIGHT — 3D animated slab fan, exact same layout as HeroSlabFan */}
        <div style={{
          position: "relative",
          height: 500,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto",
          width: "min(95vw, 520px)",
          perspective: 1800,
        }}>
          <div style={{
            position: "relative",
            width: "100%",
            height: "100%",
            transformStyle: "preserve-3d",
          }}>
            {slabs.map((s) => {
              // Idle drift
              const drift = Math.sin(time * 1.0 + s.idx * 1.3) * 5;
              const rotDrift = Math.sin(time * 0.7 + s.idx) * 1.2;

              // Scroll-driven separation — slabs rotate apart and tilt
              const slabScrollRotY = scrollPush * (12 - s.idx * 4);
              const slabScrollX = scrollPush * (s.idx - 1) * 30;

              const slabWidth = 200;

              return (
                <div key={s.idx} style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  marginLeft: -slabWidth / 2,
                  marginTop: -(slabWidth / 0.82) / 2,
                  zIndex: slabs.length - s.idx,
                }}>
                  <Slab3D
                    width={slabWidth}
                    translateX={s.ox + slabScrollX}
                    translateY={s.oy + drift}
                    rotateZ={s.rot + rotDrift * 0.5}
                    rotateY={slabScrollRotY + rotDrift}
                    topBadge={s.topBadge}
                    mainLabel={s.mainLabel}
                    rightLabel={s.rightLabel}
                    footnote={s.footnote}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   NEW SECTION A.5 — INSPECTION PORTAL
   Sits between Hero and Section B. Demonstrates "every slab traceable".
   ========================================================================= */
function SectionInspection() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);

  const entry = easeOutCubic(range(p, 0.05, 0.4));
  const rot = easeInOutCubic(range(p, 0.2, 0.85));
  const exit = range(p, 0.85, 1);

  return (
    <section ref={ref} style={{
      backgroundColor: V.paper,
      position: "relative",
      minHeight: "280vh",
    }}>
      <div style={{
        position: "sticky",
        top: 64, // header offset
        height: "calc(100vh - 64px)",
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
        display: "grid",
        gridTemplateColumns: "1fr 1.2fr",
        gap: 64,
        alignItems: "center",
      }}>
        {/* LEFT — copy */}
        <div>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10,
            color: V.gold,
            letterSpacing: "0.25em",
            textTransform: "uppercase",
            marginBottom: 16,
            fontWeight: 500,
          }}>
            00 · The Slab
          </p>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic",
            fontWeight: 500,
            fontSize: "clamp(2rem, 4.5vw, 3.5rem)",
            lineHeight: 1.05,
            color: V.ink,
            margin: 0,
            marginBottom: 16,
          }}>
            Every face<br />examined.
          </h2>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 16,
            lineHeight: 1.65,
            color: V.inkSoft,
            margin: 0,
            maxWidth: 440,
          }}>
            Centring within 50/50. Surface free of print defects.
            Edges square to within 0.1mm. Corners untouched.
            Scroll to inspect every face.
          </p>
          <div style={{
            marginTop: 32,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20,
            maxWidth: 440,
          }}>
            {[
              { label: "Centring", value: "9.5" },
              { label: "Corners", value: "10.0" },
              { label: "Edges", value: "9.5" },
              { label: "Surface", value: "10.0" },
            ].map((m) => (
              <div key={m.label} style={{
                borderTop: `1px solid ${V.line}`,
                paddingTop: 12,
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 10,
                  color: V.inkMute,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                }}>
                  {m.label}
                </div>
                <div style={{
                  fontFamily: "'Fraunces', Georgia, serif",
                  fontSize: 28,
                  color: V.ink,
                  marginTop: 4,
                  fontWeight: 500,
                }}>
                  {m.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT — dark portal */}
        <Portal height="78vh">
          <div style={{ position: "absolute", inset: 0, perspective: 1800 }}>
            <div style={{ position: "absolute", left: "50%", top: "50%" }}>
              <Slab3D
                width={240}
                translateX={-120}
                translateY={-146}
                rotateY={rot * 360}
                translateZ={Math.sin(rot * Math.PI) * 40}
                scale={lerp(0.5, 1, entry) - exit * 0.1}
                opacity={entry - exit}
                topBadge="MV001"
                mainLabel="Holo Charizard #4"
                rightLabel="MV 10"
                footnote="NFC · Tracked"
              />
            </div>
          </div>

          <div style={{
            position: "absolute",
            top: 24, left: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10,
            color: V.goldSoft,
            letterSpacing: "0.3em",
            opacity: 0.85,
          }}>
            ◆ MV001 · INSPECTION
          </div>
          <div style={{
            position: "absolute",
            bottom: 24, right: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10,
            color: "rgba(212,175,55,0.55)",
            letterSpacing: "0.3em",
          }}>
            {Math.round(rot * 360)}°
          </div>
        </Portal>
      </div>
    </section>
  );
}

/* =========================================================================
   PORTAL — dark window cut into cream page
   ========================================================================= */
function Portal({ children, height = "70vh" }) {
  return (
    <div style={{
      position: "relative",
      width: "100%",
      height,
      background: `radial-gradient(ellipse at center, ${V.panelDarkSoft} 0%, ${V.panelDark} 80%)`,
      borderRadius: 16,
      overflow: "hidden",
      boxShadow: `inset 0 0 80px rgba(0,0,0,0.6), inset 0 2px 0 rgba(212,175,55,0.18), 0 40px 80px -30px rgba(15,14,11,0.4)`,
      border: `1px solid ${V.line}`,
    }}>
      {/* Inner gold frame line */}
      <div style={{
        position: "absolute",
        inset: 8,
        borderRadius: 12,
        border: `1px solid rgba(212, 175, 55, 0.18)`,
        pointerEvents: "none",
        zIndex: 2,
      }} />
      {/* Ambient glow */}
      <div style={{
        position: "absolute",
        top: "50%", left: "50%",
        width: "60%", height: "60%",
        transform: "translate(-50%, -50%)",
        background: `radial-gradient(ellipse, rgba(212,175,55,0.12) 0%, transparent 70%)`,
        filter: "blur(40px)",
        pointerEvents: "none",
      }} />
      {children}
    </div>
  );
}

/* =========================================================================
   SECTION B — Founding Members + Promises (1:1 with home.tsx)
   ========================================================================= */
function SectionB() {
  return (
    <section style={{ backgroundColor: V.paperSunk }}>
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "80px 24px" }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 48,
          alignItems: "start",
          marginBottom: 64,
        }}>
          {/* Founding members */}
          <div>
            <p style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 12, color: V.gold,
              letterSpacing: "0.15em", textTransform: "uppercase",
              fontWeight: 500, margin: 0, marginBottom: 12,
            }}>
              Founding members · Limited cohort
            </p>
            <h3 style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontStyle: "italic", fontWeight: 500,
              fontSize: 30, lineHeight: 1.15, color: V.ink,
              margin: 0, marginBottom: 12,
            }}>
              Founding member submissions now open
            </h3>
            <p style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 16, lineHeight: 1.6, color: V.inkSoft,
              margin: 0, marginBottom: 20,
            }}>
              Join the first cohort of UK collectors grading with MintVault.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="email"
                placeholder="you@email.com"
                style={{
                  flex: 1,
                  fontFamily: "'Geist Variable', system-ui, sans-serif",
                  fontSize: 14,
                  padding: "12px 16px",
                  borderRadius: 6,
                  border: `1px solid ${V.line}`,
                  backgroundColor: V.paper,
                  color: V.ink,
                }}
              />
              <button style={{
                backgroundColor: V.gold,
                color: V.panelDark,
                border: "none",
                borderRadius: 6,
                padding: "12px 20px",
                fontFamily: "'Geist Variable', system-ui, sans-serif",
                fontSize: 14, fontWeight: 600,
                cursor: "pointer",
              }}>
                Join the waitlist
              </button>
            </div>
          </div>

          {/* 3-step process */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 24 }}>
            {[
              { num: "01", title: "Submit", desc: "Send your card insured to our UK grading facility." },
              { num: "02", title: "Grade", desc: "Our team grades, photographs, and slabs your card." },
              { num: "03", title: "Track", desc: "Every slab links to a live logbook with NFC." },
            ].map((step) => (
              <div key={step.num}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 12, color: V.gold,
                    letterSpacing: "0.15em",
                  }}>
                    {step.num}
                  </span>
                  <span style={{
                    fontFamily: "'Fraunces', Georgia, serif",
                    fontStyle: "italic", fontWeight: 500,
                    fontSize: 18, color: V.ink,
                  }}>
                    {step.title}
                  </span>
                </div>
                <p style={{
                  fontFamily: "'Geist Variable', system-ui, sans-serif",
                  fontSize: 14, lineHeight: 1.6, color: V.inkSoft,
                  margin: 0,
                }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Promises row */}
        <div style={{
          borderTop: `1px solid ${V.line}`,
          paddingTop: 48,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 32,
        }}>
          {[
            { icon: "⚙", title: "NFC-tracked", desc: "Every slab links to a live logbook" },
            { icon: "📍", title: "UK-based", desc: "Graded in Kent · shipped across the UK" },
            { icon: "↻", title: "Reholder guarantee", desc: "Free regrade if we make a mistake" },
          ].map((p) => (
            <div key={p.title}>
              <div style={{ fontSize: 18, color: V.gold, marginBottom: 8 }}>{p.icon}</div>
              <p style={{
                fontFamily: "'Geist Variable', system-ui, sans-serif",
                fontSize: 14, fontWeight: 600, color: V.ink,
                margin: 0, marginBottom: 4,
              }}>
                {p.title}
              </p>
              <p style={{
                fontFamily: "'Geist Variable', system-ui, sans-serif",
                fontSize: 12, color: V.inkMute, margin: 0,
              }}>
                {p.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION C — Grading Tiers (dark) — 1:1 with home.tsx
   ========================================================================= */
function SectionC() {
  return (
    <section style={{ backgroundColor: V.panelDark }}>
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "128px 24px" }}>
        <p style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 10, color: V.gold,
          letterSpacing: "0.25em", textTransform: "uppercase",
          fontWeight: 500, margin: 0, marginBottom: 16,
        }}>
          I · Grading Tiers
        </p>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 64,
          marginBottom: 56,
        }}>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: 48, lineHeight: 1.1, color: "#FFFFFF",
            margin: 0,
          }}>
            Three tiers.<br />
            <span style={{ color: V.goldSoft, fontWeight: 400 }}>One standard.</span>
          </h2>
          <p style={{
            alignSelf: "end",
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 16, lineHeight: 1.65,
            color: "rgba(255,255,255,0.6)",
            margin: 0,
          }}>
            Every card, regardless of service level, passes the same four-point
            inspection (centering, corners, edges, surface). Tier only changes
            how quickly you see it back.
          </p>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 24,
          maxWidth: 1080,
          margin: "0 auto",
        }}>
          {[
            { name: "Vault Queue", price: "19", days: "45 day", featured: false, features: ["Same 4-point inspection", "NFC ownership chip", "Registry listing", "Value up to £500"] },
            { name: "Standard", price: "25", days: "21 day", featured: true, features: ["Same 4-point inspection", "NFC ownership chip", "Registry listing", "Photographic report", "Value up to £2,500"] },
            { name: "Express", price: "45", days: "5 day", featured: false, features: ["Same 4-point inspection", "NFC ownership chip", "Registry listing", "Photographic report", "Priority handling", "Value up to £10,000"] },
          ].map((tier) => (
            <div key={tier.name} style={{
              position: "relative",
              padding: "48px 40px",
              borderRadius: 12,
              backgroundColor: "transparent",
              border: tier.featured
                ? `1px solid rgba(212, 175, 55, 0.6)`
                : `1px solid rgba(212, 175, 55, 0.25)`,
              display: "flex",
              flexDirection: "column",
            }}>
              {tier.featured && (
                <span style={{
                  position: "absolute",
                  top: -14, left: "50%",
                  transform: "translateX(-50%)",
                  backgroundColor: V.gold,
                  color: V.panelDark,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 9,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  padding: "6px 16px",
                  borderRadius: 4,
                }}>
                  Most chosen
                </span>
              )}
              <p style={{
                fontFamily: "'Geist Variable', system-ui, sans-serif",
                fontSize: 12, color: "rgba(255,255,255,0.4)",
                letterSpacing: "0.15em", textTransform: "uppercase",
                margin: 0, marginBottom: 20, fontWeight: 500,
              }}>
                {tier.name}
              </p>
              <div style={{ position: "relative", marginBottom: 4, lineHeight: 1 }}>
                <span style={{
                  position: "absolute",
                  fontFamily: "'Fraunces', Georgia, serif",
                  color: "rgba(255,255,255,0.4)",
                  fontSize: 32,
                  top: 4, left: -2,
                  transform: "translateX(-100%)",
                  fontWeight: 600,
                }}>£</span>
                <span style={{
                  fontFamily: "'Fraunces', Georgia, serif",
                  color: "#FFFFFF",
                  fontSize: 88,
                  marginLeft: 20,
                  fontWeight: 600,
                }}>
                  {tier.price}
                </span>
              </div>
              <p style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10, color: "#888",
                letterSpacing: "0.15em", textTransform: "uppercase",
                margin: 0, marginBottom: 32,
              }}>
                {tier.days} turnaround
              </p>
              <ul style={{
                listStyle: "none", padding: 0, margin: 0, marginBottom: 40,
                flex: 1, display: "flex", flexDirection: "column", gap: 16,
              }}>
                {tier.features.map((f) => (
                  <li key={f} style={{
                    display: "flex", alignItems: "flex-start", gap: 12,
                    fontFamily: "'Geist Variable', system-ui, sans-serif",
                    fontSize: 14, color: "#E8E4DC",
                  }}>
                    <span style={{ color: V.gold, flexShrink: 0 }}>—</span>
                    {f}
                  </li>
                ))}
              </ul>
              <button style={{
                width: "100%",
                padding: "12px 20px",
                borderRadius: 999,
                border: tier.featured ? "none" : `1px solid ${V.gold}`,
                backgroundColor: tier.featured ? V.gold : "transparent",
                color: tier.featured ? V.panelDark : V.gold,
                fontFamily: "'Geist Variable', system-ui, sans-serif",
                fontSize: 14, fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}>
                Start a submission →
              </button>
            </div>
          ))}
        </div>
        <p style={{
          textAlign: "center", marginTop: 32,
          fontFamily: "'Geist Variable', system-ui, sans-serif",
          fontSize: 12, color: "rgba(255,255,255,0.35)",
        }}>
          Bulk discounts from 10 cards.
        </p>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION D — Infrastructure (1:1 with home.tsx) — 3 cards: NFC / AI / Vault Club
   ========================================================================= */
function SectionD() {
  return (
    <section style={{ backgroundColor: V.paper }}>
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "128px 24px" }}>
        <p style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 10, color: V.gold,
          letterSpacing: "0.25em", textTransform: "uppercase",
          fontWeight: 500, margin: 0, marginBottom: 16,
        }}>
          II · Infrastructure
        </p>
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 64,
          marginBottom: 56,
        }}>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: 48, lineHeight: 1.1, color: V.ink,
            margin: 0,
          }}>
            Three pieces of quiet infrastructure.
          </h2>
          <p style={{
            alignSelf: "end",
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 16, lineHeight: 1.65,
            color: V.inkSoft,
            margin: 0,
          }}>
            Grading is the visible part. What makes a MintVault slab worth
            more is what happens around it.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
          {/* NFC card — dark */}
          <div style={{
            backgroundColor: V.panelDark,
            borderRadius: 12,
            padding: "32px",
            display: "flex", flexDirection: "column",
          }}>
            <p style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 9, color: V.gold,
              letterSpacing: "0.2em", textTransform: "uppercase",
              fontWeight: 500, margin: 0, marginBottom: 16,
            }}>
              01 · NFC Ownership
            </p>
            <h3 style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontStyle: "italic", fontWeight: 500,
              fontSize: 22, lineHeight: 1.2, color: "#FFFFFF",
              margin: 0, marginBottom: 16,
            }}>
              Every slab knows who owns it.
            </h3>
            <p style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 12, lineHeight: 1.65,
              color: "rgba(255,255,255,0.6)",
              margin: 0, marginBottom: 24, flex: 1,
            }}>
              A sub-millimetre NFC chip inside each slab links to an ownership
              registry. Tap with any phone — instantly see provenance, transfer
              history, and authenticity. Stolen, faked, or altered slabs
              invalidate on scan.
            </p>
            {/* Radar ring */}
            <div style={{ display: "flex", justifyContent: "center", height: 96, alignItems: "center" }}>
              <div style={{ position: "relative", width: 64, height: 64 }}>
                {[0, 0.3, 0.6].map((delay, i) => (
                  <div key={i} style={{
                    position: "absolute",
                    inset: i * 8,
                    borderRadius: "50%",
                    border: `1px solid ${V.gold}`,
                    opacity: 0.15 + i * 0.1,
                  }} />
                ))}
                <div style={{
                  position: "absolute",
                  inset: 26,
                  borderRadius: "50%",
                  backgroundColor: V.gold,
                }} />
              </div>
            </div>
          </div>

          {/* AI Pre-Grade card */}
          <div style={{
            backgroundColor: V.paperRaised,
            border: `1px solid ${V.line}`,
            borderRadius: 12,
            padding: 32,
            display: "flex", flexDirection: "column",
          }}>
            <p style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 9, color: V.gold,
              letterSpacing: "0.2em", textTransform: "uppercase",
              fontWeight: 500, margin: 0, marginBottom: 16,
            }}>
              02 · AI Pre-Grade
            </p>
            <h3 style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontStyle: "italic", fontWeight: 500,
              fontSize: 22, lineHeight: 1.2, color: V.ink,
              margin: 0, marginBottom: 16,
            }}>
              Know your grade before you post.
            </h3>
            <p style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 12, lineHeight: 1.65, color: V.inkSoft,
              margin: 0, marginBottom: 24, flex: 1,
            }}>
              Upload two photos. Our centering, corner, edge and surface model
              returns a likely grade in under 10 seconds. Trained on 114 unique cards
              across 71 sets. Free.
            </p>
            <div style={{
              backgroundColor: V.paperSunk,
              borderRadius: 8,
              padding: 16,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 10, lineHeight: 1.7, color: V.inkSoft,
            }}>
              <p style={{ color: V.ink, margin: 0 }}>1999 Holo Charizard #4</p>
              <div style={{ marginTop: 8 }}>
                {[
                  { l: "Centering", v: "9.5" },
                  { l: "Corners", v: "9.0" },
                  { l: "Edges", v: "9.5" },
                  { l: "Surface", v: "10.0" },
                ].map((x) => (
                  <div key={x.l} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{x.l}</span><span style={{ color: V.ink }}>{x.v}</span>
                  </div>
                ))}
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  borderTop: `1px solid ${V.line}`,
                  paddingTop: 4,
                  marginTop: 4,
                  fontWeight: 600,
                  color: V.gold,
                }}>
                  <span>Predicted</span><span>MV 9.5</span>
                </div>
              </div>
            </div>
          </div>

          {/* Vault Club card */}
          <div style={{
            backgroundColor: V.paperSunk,
            border: `1px solid ${V.lineSoft}`,
            borderRadius: 12,
            padding: 32,
            display: "flex", flexDirection: "column",
          }}>
            <p style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 9, color: V.gold,
              letterSpacing: "0.2em", textTransform: "uppercase",
              fontWeight: 500, margin: 0, marginBottom: 16,
            }}>
              03 · Vault Club
            </p>
            <h3 style={{
              fontFamily: "'Fraunces', Georgia, serif",
              fontStyle: "italic", fontWeight: 500,
              fontSize: 22, lineHeight: 1.2, color: V.ink,
              margin: 0, marginBottom: 16,
            }}>
              Membership for the serious.
            </h3>
            <p style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 12, lineHeight: 1.65, color: V.inkSoft,
              margin: 0, marginBottom: 24, flex: 1,
            }}>
              Free Authentication add-ons, free return shipping, 100 AI Pre-Grade credits, priority queue,
              and a reserved username on the public registry.
            </p>
            <div style={{ marginBottom: 20 }}>
              <div style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                fontFamily: "'Geist Variable', system-ui, sans-serif",
                fontSize: 14, fontWeight: 600, color: V.ink,
              }}>
                <span>Silver</span>
                <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11 }}>£9.99/mo</span>
              </div>
              <div style={{
                display: "flex", justifyContent: "space-between",
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10, color: V.inkMute,
                marginTop: 2,
              }}>
                <span></span>
                <span>£99/year</span>
              </div>
            </div>
            <span style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 12, fontWeight: 600, color: V.gold,
            }}>
              View all benefits →
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   SECTION E — Population Registry with Vault Aisle Portal added above table
   ========================================================================= */
function SectionE() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);
  const cameraGlide = easeInOutCubic(range(p, 0.0, 0.7));

  // Mock cert data
  const certs = [
    { num: "MV234", card: "Holo Charizard #4", grade: "9.0", set: "Base Set 1999" },
    { num: "MV232", card: "Pikachu Illustrator", grade: "8.0", set: "Promo 1998" },
    { num: "MV229", card: "Lugia Neo Genesis", grade: "7.0", set: "Neo Genesis" },
    { num: "MV207", card: "Blastoise Holo", grade: "9.5", set: "Base Set 1999" },
    { num: "MV192", card: "Mewtwo Promo", grade: "8.5", set: "Movie Promo" },
  ];

  return (
    <section ref={ref} style={{ backgroundColor: V.paperSunk }}>
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "128px 24px" }}>
        <p style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 10, color: V.gold,
          letterSpacing: "0.25em", textTransform: "uppercase",
          fontWeight: 500, margin: 0, marginBottom: 16,
        }}>
          III · Population Registry
        </p>
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr",
          gap: 64, marginBottom: 56,
        }}>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: 48, lineHeight: 1.1, color: V.ink,
            margin: 0,
          }}>
            The open population record.
          </h2>
          <p style={{
            alignSelf: "end",
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 16, lineHeight: 1.65, color: V.inkSoft,
            margin: 0,
          }}>
            Every card we grade, visible to the public. Populations, grade
            distributions, last known sale. Collectors deserve to see the market
            they trade in.
          </p>
        </div>

        {/* NEW — Vault Aisle Portal above the table */}
        <div style={{ marginBottom: 40 }}>
          <Portal height="50vh">
            <div style={{ position: "absolute", inset: 0, perspective: 1200, perspectiveOrigin: "50% 50%" }}>
              <Shelving side="left" cameraGlide={cameraGlide} />
              <Shelving side="right" cameraGlide={cameraGlide} />
            </div>
            <div style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              flexDirection: "column",
              gap: 8,
            }}>
              <div style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontStyle: "italic",
                fontSize: 56,
                color: "rgba(255,255,255,0.95)",
                fontWeight: 500,
                textShadow: "0 0 40px rgba(0,0,0,0.6)",
                margin: 0,
                lineHeight: 1,
              }}>
                4,128
              </div>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11,
                color: V.goldSoft,
                letterSpacing: "0.4em",
                textTransform: "uppercase",
              }}>
                Slabs in vault
              </div>
            </div>
          </Portal>
        </div>

        {/* Ticker */}
        <div style={{
          overflow: "hidden",
          marginBottom: 32,
          borderRadius: 8,
          padding: "12px 16px",
          backgroundColor: V.paperRaised,
          border: `1px solid ${V.line}`,
        }}>
          <div style={{
            display: "flex", gap: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: V.inkMute,
            whiteSpace: "nowrap",
          }}>
            {[...certs, ...certs].map((c, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: V.gold }}>{c.num}</span>
                <span>·</span>
                <span>{c.card}</span>
                <span>·</span>
                <span style={{ color: V.ink }}>MV {c.grade}</span>
                <span>·</span>
                <span>{c.set}</span>
              </span>
            ))}
          </div>
        </div>

        {/* Mini table */}
        <div style={{
          borderRadius: 12,
          border: `1px solid ${V.line}`,
          overflow: "hidden",
        }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{
                backgroundColor: V.paperRaised,
                borderBottom: `1px solid ${V.line}`,
              }}>
                {["#", "Card", "Grade", "Set"].map((h) => (
                  <th key={h} style={{
                    fontFamily: "'Geist Variable', system-ui, sans-serif",
                    fontSize: 10,
                    color: V.inkMute,
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    padding: "12px 16px",
                    textAlign: "left",
                    fontWeight: 500,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {certs.map((c, i) => (
                <tr key={c.num} style={{
                  borderBottom: i < certs.length - 1 ? `1px solid ${V.lineSoft}` : "none",
                  backgroundColor: V.paperRaised,
                }}>
                  <td style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 11, color: V.gold,
                    padding: "12px 16px",
                  }}>{c.num}</td>
                  <td style={{
                    fontFamily: "'Geist Variable', system-ui, sans-serif",
                    fontSize: 14, color: V.ink,
                    padding: "12px 16px",
                  }}>{c.card}</td>
                  <td style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 14, color: V.ink, fontWeight: 600,
                    padding: "12px 16px",
                  }}>{c.grade}</td>
                  <td style={{
                    fontFamily: "'Geist Variable', system-ui, sans-serif",
                    fontSize: 12, color: V.inkMute,
                    padding: "12px 16px",
                  }}>{c.set}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ textAlign: "center", marginTop: 32 }}>
          <button style={{
            backgroundColor: "transparent",
            color: V.inkSoft,
            border: `1px solid ${V.line}`,
            borderRadius: 999,
            padding: "12px 24px",
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 14, fontWeight: 600,
            cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 8,
          }}>
            Browse the full registry →
          </button>
        </div>
      </div>
    </section>
  );
}

function Shelving({ side, cameraGlide }) {
  const rows = 4;
  const cols = 6;
  const xBase = side === "left" ? -600 : 600;

  return (
    <div style={{
      position: "absolute", top: "50%", left: "50%",
      transform: `translate3d(${xBase}px, -50%, 0)`,
      transformStyle: "preserve-3d",
    }}>
      {Array.from({ length: rows }).map((_, r) =>
        Array.from({ length: cols }).map((_, c) => {
          const z = -c * 320;
          const y = (r - rows / 2) * 80;
          const slabRotY = side === "left" ? -20 : 20;
          const offsetZ = z + cameraGlide * 1800;
          if (offsetZ > 300 || offsetZ < -2400) return null;
          const opacity = clamp((offsetZ + 2400) / 1200, 0, 1) * clamp((300 - offsetZ) / 600, 0, 1);
          return (
            <div key={`${r}-${c}`} style={{
              position: "absolute",
              top: y, left: 0,
              transform: `translate3d(0, 0, ${offsetZ}px) rotateY(${slabRotY}deg)`,
              transformStyle: "preserve-3d",
              opacity,
            }}>
              <MiniSlab grade={["MV 9", "MV 9.5", "MV 10"][((r * cols + c) * 7) % 3]} />
            </div>
          );
        })
      )}
    </div>
  );
}

function MiniSlab({ grade }) {
  return (
    <div style={{
      width: 60, height: 73,
      backgroundColor: V.paperRaised,
      borderRadius: 5,
      padding: 3,
      boxShadow: "0 4px 10px rgba(0,0,0,0.45)",
      border: "1px solid rgba(212,175,55,0.3)",
    }}>
      <div style={{
        position: "relative",
        width: "100%", height: "100%",
        borderRadius: 3,
        background: `radial-gradient(circle at top left, ${V.slabNavy} 0%, ${V.slabPetrol} 35%, ${V.slabTeal} 70%, ${V.slabBronze} 100%)`,
        overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", bottom: 3, right: 3,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 7, color: V.gold, fontWeight: 600,
        }}>
          {grade}
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   SECTION F — Final CTA (dark)
   ========================================================================= */
function SectionF() {
  return (
    <section style={{ backgroundColor: V.panelDark }}>
      <div style={{
        maxWidth: 768, margin: "0 auto",
        padding: "128px 24px", textAlign: "center",
      }}>
        <p style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 10, color: V.gold,
          letterSpacing: "0.25em", textTransform: "uppercase",
          fontWeight: 500, margin: 0, marginBottom: 16,
        }}>
          IV · Submit
        </p>
        <h2 style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontStyle: "italic", fontWeight: 500,
          fontSize: 48, lineHeight: 1.1, color: "#FFFFFF",
          margin: 0, marginBottom: 24,
        }}>
          Submit a card.<br />See yourself on the registry.
        </h2>
        <p style={{
          fontFamily: "'Geist Variable', system-ui, sans-serif",
          fontSize: 16, color: "rgba(255,255,255,0.5)",
          margin: 0, marginBottom: 40,
        }}>
          From £19. UK-based. Insured in transit.
        </p>
        <div style={{
          display: "flex", flexWrap: "wrap",
          justifyContent: "center", gap: 12, marginBottom: 24,
        }}>
          <button style={{
            backgroundColor: V.gold, color: V.panelDark,
            border: "none", borderRadius: 999,
            padding: "12px 28px",
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 14, fontWeight: 600, cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 8,
          }}>
            Submit a card →
          </button>
          <button style={{
            backgroundColor: "transparent",
            color: "rgba(255,255,255,0.7)",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: 999,
            padding: "12px 28px",
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 14, fontWeight: 600, cursor: "pointer",
            display: "inline-flex", alignItems: "center", gap: 8,
          }}>
            Try AI Pre-Grade (free) →
          </button>
        </div>
        <p style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 9, color: V.gold,
          letterSpacing: "0.15em", textTransform: "uppercase",
          margin: 0,
        }}>
          No login required for pre-grade · Submission in 3 minutes
        </p>
      </div>
    </section>
  );
}

/* =========================================================================
   FOOTER (compressed replica of footer-v2.tsx)
   ========================================================================= */
function Footer() {
  return (
    <footer style={{
      backgroundColor: V.paperSunk,
      borderTop: `1px solid ${V.line}`,
    }}>
      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "64px 24px" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 32,
          marginBottom: 48,
        }}>
          {[
            { title: "Services", links: ["Pokemon Card Grading UK", "Trading Card Grading UK", "Sports Card Grading UK", "Card Grading Cost UK", "PSA Alternative UK"] },
            { title: "Grading", links: ["Submit a card", "Grading standards", "AI Pre-Grade", "Pricing"] },
            { title: "Technology", links: ["How it works", "NFC tracking", "Population report"] },
            { title: "Company", links: ["About", "Vault Club", "Journal", "Contact"] },
            { title: "Contact", links: ["hello@mintvaultuk.com", "Kent, England"] },
          ].map((col) => (
            <div key={col.title}>
              <p style={{
                fontFamily: "'Geist Variable', system-ui, sans-serif",
                fontSize: 12, fontWeight: 600,
                color: V.inkMute,
                letterSpacing: "0.15em", textTransform: "uppercase",
                margin: 0, marginBottom: 16,
              }}>{col.title}</p>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {col.links.map((l) => (
                  <li key={l} style={{
                    fontFamily: "'Geist Variable', system-ui, sans-serif",
                    fontSize: 14, color: V.inkSoft,
                    marginBottom: 10, cursor: "pointer",
                  }}>{l}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div style={{
          borderTop: `1px solid ${V.line}`,
          paddingTop: 24,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexWrap: "wrap", gap: 16,
        }}>
          <span style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: 18, color: V.inkMute,
          }}>
            MintVault
          </span>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 12, color: V.inkMute,
            margin: 0,
          }}>
            © 2026 Mint Vault UK Ltd · Registered in England &amp; Wales · Company No. 17170013 · ICO Reg. [PENDING]
          </p>
        </div>
      </div>
    </footer>
  );
}

/* =========================================================================
   PAGE
   ========================================================================= */
export default function MintVaultHomeIntegrated() {
  return (
    <div style={{
      backgroundColor: V.paper,
      color: V.ink,
      minHeight: "100vh",
      overflowX: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500;1,9..144,600&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
        body { background: ${V.paper}; }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
      `}</style>

      <Header />
      <SectionAHero />
      <SectionInspection />
      <SectionB />
      <SectionC />
      <SectionD />
      <SectionE />
      <SectionF />
      <Footer />
    </div>
  );
}
