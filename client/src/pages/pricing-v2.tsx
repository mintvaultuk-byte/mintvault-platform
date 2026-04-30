// @ts-nocheck — visual mockup; full port pending
/* =========================================================================
   MINTVAULT — PRICING V2 (visual mockup, /pricing-v2 preview route)
   STRICT CONSTRAINT: zero copy/layout/structure changes from live pricing.tsx.
   Visual treatments only:
     1. Hero slab fan inherits 3D + idle drift from the shared HeroSlabFan
        upgrade already shipped to production.
     2. AmbientLayer — page-level warm gold drift behind everything.
     3. DarkSectionGlow — breathing gold ambience inside dark sections
        (Section I Grading Tiers, Section VIII Final CTA).
     4. Tier cards (Section I) — subtle hover lift + shadow deepen.
     5. Add-on items (Section III) — same hover treatment, calmer.
     6. Silver Vault Club card (Section V) — soft inner glow on gold border.
     7. FAQ items (Section VII) — 1px gold left-edge accent that fades in
        on scroll.

   FONT: Geist for everything (matches v465 typography deploy).
   COPY: identical to live pricing.tsx — every word, every CTA, every
         ordinal, every microcopy line preserved verbatim.
   ========================================================================= */

import React, { useEffect, useRef, useState } from "react";

// ── DESIGN TOKENS ──────────────────────────────────────────────────────────
// Mockup-only — production code uses var(--v2-*) CSS variables. Inlined
// here so the .jsx renders standalone in Cornelius's preview browser.
const V = {
  ink: "#0F0E0B",
  inkSoft: "#3A362E",
  inkMute: "#6B6454",
  paper: "#FAF7F1",
  paperRaised: "#FFFFFF",
  paperSunk: "#F4F0E6",
  line: "#E8E1D0",
  lineSoft: "#F0EBE0",
  gold: "#B8960C",
  goldSoft: "#D4AF37",
  panelDark: "#1A1612",
  // Slab gradient stops (hsl)
  slabNavy: "hsl(220, 45%, 15%)",
  slabPetrol: "hsl(200, 50%, 25%)",
  slabTeal: "hsl(160, 30%, 35%)",
  slabBronze: "hsl(45, 45%, 55%)",
};

// 2% fractal noise overlay
const SLAB_NOISE_SVG =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")";

// ── HOOKS ──────────────────────────────────────────────────────────────────

function useIdleTime() {
  const [time, setTime] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
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

function useSectionProgress(ref) {
  const [progress, setProgress] = useState(0);
  const ticking = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
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

// ── AMBIENT BACKGROUND LAYER ──────────────────────────────────────────────

function AmbientLayer() {
  const time = useIdleTime();
  const x1 = 30 + Math.sin(time * 0.05) * 15;
  const y1 = 25 + Math.cos(time * 0.04) * 10;
  const x2 = 70 + Math.cos(time * 0.04) * 12;
  const y2 = 75 + Math.sin(time * 0.03) * 8;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: -1,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: `${y1 - 35}%`,
          left: `${x1 - 35}%`,
          width: "70%",
          height: "70%",
          background:
            "radial-gradient(circle, rgba(212, 175, 55, 0.08) 0%, rgba(212, 175, 55, 0.03) 30%, transparent 60%)",
          filter: "blur(60px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: `${y2 - 30}%`,
          left: `${x2 - 30}%`,
          width: "60%",
          height: "60%",
          background:
            "radial-gradient(circle, rgba(184, 150, 12, 0.06) 0%, rgba(184, 150, 12, 0.02) 30%, transparent 60%)",
          filter: "blur(50px)",
        }}
      />
    </div>
  );
}

function DarkSectionGlow() {
  const time = useIdleTime();
  const breathe = (Math.sin(time * 0.15) + 1) / 2;
  const alpha = 0.06 + breathe * 0.04;
  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          top: "30%",
          left: "50%",
          width: "70%",
          height: "60%",
          transform: "translate(-50%, -50%)",
          background: `radial-gradient(ellipse, rgba(212, 175, 55, ${alpha}) 0%, rgba(212, 175, 55, 0.02) 35%, transparent 70%)`,
          filter: "blur(80px)",
        }}
      />
    </div>
  );
}

// ── 3D SLAB ────────────────────────────────────────────────────────────────

function SlabFace({ children, transform, width, height, style = {} }) {
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

function Slab3D({
  width,
  rotateX = 0,
  rotateY = 0,
  rotateZ = 0,
  translateX = 0,
  translateY = 0,
  translateZ = 0,
  scale = 1,
  topBadge,
  mainLabel,
  rightLabel,
  footnote,
}) {
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
        willChange: "transform",
      }}
    >
      {/* FRONT FACE */}
      <SlabFace transform={`translateZ(${depth / 2}px)`} width={width} height={height}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 12,
            border: `1px solid rgba(212, 175, 55, 0.4)`,
            backgroundColor: V.paperRaised,
            overflow: "hidden",
            boxShadow:
              "0 30px 60px -20px rgba(15,14,11,0.35), 0 12px 24px -10px rgba(15,14,11,0.18)",
          }}
        >
          <div style={{ height: "10%", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 8px" }}>
            {topBadge && (
              <span
                style={{
                  fontFamily: "'Geist Mono', 'JetBrains Mono', monospace",
                  color: V.goldSoft,
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
          <div
            style={{
              height: "65%",
              position: "relative",
              background: `radial-gradient(circle at top left, ${V.slabNavy} 0%, ${V.slabPetrol} 35%, ${V.slabTeal} 70%, ${V.slabBronze} 100%)`,
            }}
          >
            <div aria-hidden="true" style={{ position: "absolute", inset: 0, backgroundImage: SLAB_NOISE_SVG, opacity: 0.02 }} />
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "rgba(255, 255, 255, 0.12)",
                fontStyle: "italic",
                fontFamily: "'Geist', system-ui, sans-serif",
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
          <div
            style={{
              height: "25%",
              padding: "6px 10px",
              backgroundColor: V.paperRaised,
              borderTop: `1px solid rgba(212, 175, 55, 0.3)`,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span
                style={{
                  fontFamily: "'Geist', system-ui, sans-serif",
                  color: V.ink,
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
                  style={{
                    fontFamily: "'Geist Mono', 'JetBrains Mono', monospace",
                    color: V.gold,
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
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: V.gold, display: "inline-block" }} />
                <span
                  style={{
                    fontFamily: "'Geist Mono', 'JetBrains Mono', monospace",
                    color: V.inkMute,
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
      {/* BACK */}
      <SlabFace transform={`translateZ(-${depth / 2}px) rotateY(180deg)`} width={width} height={height}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 12,
            border: `1px solid rgba(212, 175, 55, 0.4)`,
            background: `linear-gradient(155deg, ${V.slabNavy} 0%, ${V.slabPetrol} 100%)`,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
          }}
        >
          <div style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontSize: width * 0.18, color: "rgba(212,175,55,0.55)", fontWeight: 400, lineHeight: 1 }}>MV</div>
          <div style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: width * 0.04, letterSpacing: "0.3em", color: "rgba(212,175,55,0.5)", marginTop: 14 }}>REGISTERED</div>
          {topBadge && <div style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: width * 0.035, letterSpacing: "0.2em", color: "rgba(255,255,255,0.4)", marginTop: 6 }}>{topBadge}</div>}
        </div>
      </SlabFace>
      {/* edges */}
      <SlabFace transform={`rotateY(90deg) translateZ(${width / 2}px)`} width={depth} height={height} style={{ left: width / 2 - depth / 2 }}>
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, ${V.paperSunk} 0%, ${V.paperRaised} 50%, ${V.paperSunk} 100%)` }} />
      </SlabFace>
      <SlabFace transform={`rotateY(-90deg) translateZ(${width / 2}px)`} width={depth} height={height} style={{ left: width / 2 - depth / 2 }}>
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, ${V.paperSunk} 0%, ${V.paperRaised} 50%, ${V.paperSunk} 100%)` }} />
      </SlabFace>
      <SlabFace transform={`rotateX(90deg) translateZ(${height / 2}px)`} width={width} height={depth} style={{ top: height / 2 - depth / 2 }}>
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${V.paperRaised} 0%, ${V.paperSunk} 100%)` }} />
      </SlabFace>
      <SlabFace transform={`rotateX(-90deg) translateZ(${height / 2}px)`} width={width} height={depth} style={{ top: height / 2 - depth / 2 }}>
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, ${V.paperSunk} 0%, ${V.paperRaised} 100%)` }} />
      </SlabFace>
    </div>
  );
}

function HeroSlabFan({ slabs }) {
  const containerRef = useRef(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const time = useIdleTime();
  const driftScale = isMobile ? 0.6 : 1;
  const slabWidth = isMobile ? 150 : 200;
  const rotations = [-8, 4, -2];
  const offsets = isMobile
    ? [{ x: -75, y: 20 }, { x: 0, y: -20 }, { x: 75, y: 20 }]
    : [{ x: -100, y: 20 }, { x: 0, y: -20 }, { x: 100, y: 20 }];

  return (
    <div ref={containerRef} className="relative h-[300px] md:h-[500px] flex items-center justify-center mx-auto" style={{ width: "min(95vw, 520px)", perspective: 1800 }}>
      <div style={{ position: "relative", width: "100%", height: "100%", transformStyle: "preserve-3d" }}>
        {slabs.map((content, i) => {
          const drift = Math.sin(time * 1.0 + i * 1.3) * 10 * driftScale;
          const rotDriftY = Math.sin(time * 0.8 + i * 0.7) * 4 * driftScale;
          const rotDriftZ = Math.sin(time * 0.6 + i) * 1.5 * driftScale;
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
                translateX={offsets[i].x}
                translateY={offsets[i].y + drift}
                rotateZ={rotations[i] + rotDriftZ}
                rotateY={rotDriftY}
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

// ── HEADER (placeholder mirroring HeaderV2 visual) ────────────────────────

function Header() {
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 50, backgroundColor: `${V.paper}E6`, backdropFilter: "blur(8px)", borderBottom: `1px solid ${V.line}` }}>
      <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between">
        <a href="#" style={{ display: "flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
          <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontWeight: 700, color: V.ink, fontSize: 22 }}>Mint</span>
          <span style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", color: V.inkMute, fontSize: 16 }}>·</span>
          <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontWeight: 500, fontStyle: "italic", color: V.ink, fontSize: 22 }}>Vault</span>
        </a>
        <nav className="hidden md:flex items-center gap-8">
          {["Grading", "Vault Club", "Verify", "Technology", "Registry", "Journal"].map((item) => (
            <a key={item} href="#" style={{ fontFamily: "'Geist', system-ui, sans-serif", color: V.inkSoft, fontSize: 14, textDecoration: "none" }}>{item}</a>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <a href="#" style={{ fontFamily: "'Geist', system-ui, sans-serif", color: V.inkSoft, fontSize: 14, textDecoration: "none" }}>Help</a>
          <a href="#" style={{ fontFamily: "'Geist', system-ui, sans-serif", color: V.inkSoft, fontSize: 14, textDecoration: "none" }}>Dashboard</a>
          <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "10px 20px", borderRadius: 999, backgroundColor: V.ink, color: V.paper, textDecoration: "none" }}>
            Submit a card →
          </a>
        </div>
      </div>
    </header>
  );
}

// ── SECTION A: HERO ───────────────────────────────────────────────────────

function SectionAHero() {
  const tierSlabs = [
    { topBadge: "STANDARD", mainLabel: "£25", rightLabel: "15 DAY", footnote: "MOST CHOSEN", key: "standard" },
    { topBadge: "VAULT QUEUE", mainLabel: "£19", rightLabel: "40 DAY", footnote: "BEST VALUE", key: "vault-queue" },
    { topBadge: "EXPRESS", mainLabel: "£45", rightLabel: "5 DAY", footnote: "FASTEST", key: "express" },
  ];

  return (
    <section style={{ position: "relative" }}>
      <div className="mx-auto max-w-7xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-12 md:gap-16 items-center">
        <div>
          <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 24, color: V.gold }}>
            Est. Kent · Pricing
          </p>
          <h1 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, lineHeight: 0.95, marginBottom: 24, fontSize: "clamp(2.75rem, 6vw, 5rem)", color: V.ink }}>
            Grade it once.<br />Get it right.
          </h1>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 17, lineHeight: 1.6, maxWidth: 540, marginBottom: 32, color: V.inkSoft }}>
            Three tiers, 5 to 40 working day turnaround, same four-point inspection on every card. Black Label upgrade when your card earns it — free, never sold.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 24px", borderRadius: 999, backgroundColor: V.ink, color: V.paper, textDecoration: "none" }}>
              Submit a card →
            </a>
            <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 24px", borderRadius: 999, border: `1px solid ${V.line}`, color: V.inkSoft, textDecoration: "none" }}>
              Try AI Pre-Grade →
            </a>
          </div>
          <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: V.inkMute }}>
            From £19 · 3 tiers · Free Black Label upgrade
          </p>
        </div>
        <HeroSlabFan slabs={tierSlabs} />
      </div>
    </section>
  );
}

// ── SECTION I: GRADING TIERS (dark) ───────────────────────────────────────

function TierCard({ tierId, displayName, blurb, featured, priceDisplay, days, features }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        padding: "48px 40px",
        backgroundColor: "transparent",
        border: featured ? "1px solid rgba(212, 175, 55, 0.6)" : "1px solid rgba(212, 175, 55, 0.25)",
        transform: hovered ? "translateY(-4px) scale(1.02)" : "translateY(0) scale(1)",
        boxShadow: hovered
          ? "0 20px 40px -10px rgba(0,0,0,0.5), 0 0 30px rgba(212, 175, 55, 0.15)"
          : "0 0 0 transparent",
        transition: "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 250ms ease-out",
        willChange: "transform",
      }}
    >
      {featured && (
        <span
          style={{
            position: "absolute",
            top: -14,
            left: "50%",
            transform: "translateX(-50%)",
            fontFamily: "'Geist Mono', 'JetBrains Mono', monospace",
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            padding: "6px 16px",
            borderRadius: 4,
            backgroundColor: V.gold,
            color: V.panelDark,
          }}
        >
          Most chosen
        </span>
      )}
      <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 20, color: "rgba(255,255,255,0.4)" }}>
        {displayName}
      </p>
      <div style={{ position: "relative", marginBottom: 4, lineHeight: 1 }}>
        <span
          style={{
            fontFamily: "'Geist', system-ui, sans-serif",
            fontWeight: 600,
            position: "absolute",
            color: "rgba(255,255,255,0.4)",
            fontSize: "clamp(28px, 3vw, 36px)",
            top: 4,
            left: -2,
            transform: "translateX(-100%)",
          }}
        >
          £
        </span>
        <span
          style={{
            fontFamily: "'Geist', system-ui, sans-serif",
            fontWeight: 600,
            color: "#FFFFFF",
            fontSize: "clamp(72px, 6vw, 96px)",
            marginLeft: 20,
          }}
        >
          {priceDisplay}
        </span>
      </div>
      <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", marginBottom: 24, color: "#888888", letterSpacing: "0.15em" }}>
        {days} day turnaround
      </p>
      {blurb && (
        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, lineHeight: 1.6, marginBottom: 32, color: "rgba(255,255,255,0.7)" }}>
          {blurb}
        </p>
      )}
      <ul style={{ marginBottom: 40, flex: 1, display: "flex", flexDirection: "column", gap: 16, listStyle: "none", padding: 0 }}>
        {features.slice(0, 5).map((f) => (
          <li key={f} style={{ display: "flex", alignItems: "flex-start", gap: 12, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, color: "#E8E4DC" }}>
            <span style={{ flexShrink: 0, color: V.gold }}>—</span>
            {f}
          </li>
        ))}
      </ul>
      <a
        href="#"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          fontFamily: "'Geist', system-ui, sans-serif",
          fontSize: 14,
          fontWeight: 600,
          padding: "12px 20px",
          borderRadius: 999,
          width: "100%",
          textDecoration: "none",
          ...(featured
            ? { backgroundColor: V.gold, color: V.panelDark }
            : { border: `1px solid ${V.gold}`, color: V.gold }),
        }}
      >
        Start a submission →
      </a>
    </div>
  );
}

function SectionI() {
  // Locked production data — Vault Queue £19 / Standard £25 / Express £45.
  const tiers = [
    {
      tierId: "standard",
      displayName: "Vault Queue",
      blurb: "No rush. Full grade, NFC chip, registry listing — at the best price per card.",
      featured: false,
      priceDisplay: "19",
      days: 40,
      features: [
        "Professional grade assessment (1–10 scale)",
        "Subgrade breakdown (centering, corners, edges, surface)",
        "Tamper-evident NFC-enabled precision slab",
        "Unique online-verifiable certificate",
        "Claim code for ownership registration",
      ],
    },
    {
      tierId: "priority",
      displayName: "Standard",
      blurb: "The balanced option: fair turnaround, full report, priority you can feel.",
      featured: true,
      priceDisplay: "25",
      days: 15,
      features: [
        "Professional grade assessment (1–10 scale)",
        "Subgrade breakdown (centering, corners, edges, surface)",
        "Tamper-evident NFC-enabled precision slab",
        "Unique online-verifiable certificate",
        "Claim code for ownership registration",
      ],
    },
    {
      tierId: "express",
      displayName: "Express",
      blurb: "Back in under a week. For grails, auction deadlines, and holiday hand-offs.",
      featured: false,
      priceDisplay: "45",
      days: 5,
      features: [
        "Professional grade assessment (1–10 scale)",
        "Subgrade breakdown (centering, corners, edges, surface)",
        "Tamper-evident NFC-enabled precision slab",
        "Unique online-verifiable certificate",
        "Claim code for ownership registration",
      ],
    },
  ];

  return (
    <section style={{ backgroundColor: V.panelDark, position: "relative", overflow: "hidden" }}>
      <DarkSectionGlow />
      <div className="mx-auto max-w-7xl px-6 py-24 md:py-32" style={{ position: "relative", zIndex: 1 }}>
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          I · Grading Tiers
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
          <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, color: "#FFFFFF" }}>
            Three tiers.<br />
            <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 400, color: V.goldSoft }}>One standard.</span>
          </h2>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, alignSelf: "end", color: "rgba(255,255,255,0.6)" }}>
            Every card passes the same four-point inspection: centering, corners, edges, surface. Tier only changes how quickly the work comes back.
          </p>
        </div>

        <div style={{ display: "flex", justifyContent: "center" }}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6" style={{ maxWidth: 1080, width: "100%" }}>
            {tiers.map((t) => <TierCard key={t.tierId} {...t} />)}
          </div>
        </div>

        <div style={{ marginTop: 64, maxWidth: 768, marginInline: "auto", textAlign: "center" }}>
          <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.3em", marginBottom: 12, color: V.goldSoft }}>
            Black Label · Earned, not sold
          </p>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.5rem, 2.5vw, 1.875rem)", lineHeight: 1.3, marginBottom: 12, color: "#FFFFFF" }}>
            When every subgrade scores a 10, the slab upgrades automatically.
          </p>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, color: "rgba(255,255,255,0.6)" }}>
            Black Label is MintVault's top-tier finish — a visual signal that a card hit perfect across centering, corners, edges, and surface. There's no separate fee, no form to tick. If it earns it, you get it.
          </p>
        </div>
      </div>
    </section>
  );
}

// ── SECTION II: VALUE PROTECTION ──────────────────────────────────────────

function SectionII() {
  const bands = [
    { tier: "Standard", value: "Up to £500", fee: "Included", note: "Built into every submission", isFree: true },
    { tier: "Enhanced", value: "Up to £1,500", fee: "+£2", note: "Mid-value cards", isFree: false },
    { tier: "Premium", value: "Up to £3,000", fee: "+£5", note: "High-value grails", isFree: false },
    { tier: "Max", value: "Up to £7,500", fee: "+£10", note: "Cap — contact us above £7.5k", isFree: false },
  ];

  return (
    <section style={{ backgroundColor: V.paper }}>
      <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          II · Value Protection
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
          <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, color: V.ink }}>
            Declare what it's worth.
          </h2>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, alignSelf: "end", color: V.inkSoft }}>
            Declared value is what your card is worth if lost or damaged in our custody. Higher tiers raise our insurance cover with a small per-card surcharge.
          </p>
        </div>

        <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${V.line}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ backgroundColor: V.paperRaised, borderBottom: `1px solid ${V.line}` }}>
                {["Tier", "Declared value", "Per-card surcharge", "Notes"].map((h, i) => (
                  <th key={h} style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", padding: "12px 16px", textAlign: "left", color: V.inkMute, ...(i === 3 ? { display: "none" } : {}) }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bands.map((b, i) => (
                <tr key={b.tier} style={{ borderBottom: i < bands.length - 1 ? `1px solid ${V.lineSoft}` : undefined, backgroundColor: V.paperRaised }}>
                  <td style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 16px", color: V.ink }}>{b.tier}</td>
                  <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, padding: "12px 16px", color: V.ink }}>{b.value}</td>
                  <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, padding: "12px 16px", color: b.isFree ? V.gold : V.ink }}>{b.fee}</td>
                  <td style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 12, padding: "12px 16px", color: V.inkMute, display: "none" }} className="md:table-cell">{b.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ── SECTION III: ADD-ONS ──────────────────────────────────────────────────

function AddonItem({ name, display, description }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 200ms ease-out",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, borderBottom: `1px solid ${V.line}`, paddingBottom: 10 }}>
        <h3 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.25rem, 1.8vw, 1.5rem)", color: V.ink }}>
          {name}
        </h3>
        <span style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 18, fontWeight: 600, color: hovered ? V.gold : V.gold, transition: "color 200ms" }}>
          {display}
        </span>
      </div>
      <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, lineHeight: 1.6, color: V.inkSoft }}>
        {description}
      </p>
    </div>
  );
}

function SectionIII() {
  const addons = [
    { id: "reholder", name: "Reholder", display: "£15", description: "Transfer your card into a new MintVault slab with updated NFC and certificate." },
    { id: "crossover", name: "Crossover", display: "£35", description: "Re-grade a card from PSA, BGS, CGC, or another grading company." },
    { id: "authentication", name: "Authentication", display: "£15", description: "Verify authenticity and check for alterations — no grade assigned." },
  ];

  return (
    <section style={{ backgroundColor: V.paperRaised }}>
      <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          III · Add-ons
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
          <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, color: V.ink }}>
            Optional extras.
          </h2>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, alignSelf: "end", color: V.inkSoft }}>
            Three services you can stack onto a submission. Add only what you need — nothing hidden, nothing default-on.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-10">
          {addons.map((a) => <AddonItem key={a.id} {...a} />)}
        </div>
      </div>
    </section>
  );
}

// ── SECTION IV: RETURN SHIPPING ───────────────────────────────────────────

function SectionIV() {
  const tiers = [
    { value: "Up to £500", shipping: "£4.99" },
    { value: "Up to £1,500", shipping: "£9.99" },
    { value: "Up to £3,000", shipping: "£14.99" },
    { value: "Up to £7,500", shipping: "£24.99" },
  ];
  return (
    <section style={{ backgroundColor: V.paperSunk }}>
      <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          IV · Return Shipping
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-14">
          <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, color: V.ink }}>
            Insured, tracked, UK only.
          </h2>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, alignSelf: "end", color: V.inkSoft }}>
            Every slab returns via Royal Mail Special Delivery with insurance matched to your declared value tier.
          </p>
        </div>
        <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${V.line}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ backgroundColor: V.paperRaised, borderBottom: `1px solid ${V.line}` }}>
                <th style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", padding: "12px 16px", textAlign: "left", color: V.inkMute }}>Declared value</th>
                <th style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", padding: "12px 16px", textAlign: "left", color: V.inkMute }}>Return shipping</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((t, i) => (
                <tr key={t.value} style={{ borderBottom: i < tiers.length - 1 ? `1px solid ${V.lineSoft}` : undefined, backgroundColor: V.paperRaised }}>
                  <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, padding: "12px 16px", color: V.ink }}>{t.value}</td>
                  <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, padding: "12px 16px", color: V.ink }}>{t.shipping}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 12, marginTop: 24, color: V.inkMute }}>
          Fully insured Royal Mail return. UK addresses only. Above £7,500 declared value, please contact us for bespoke carriage.
        </p>
      </div>
    </section>
  );
}

// ── SECTION V: VAULT CLUB TEASER ──────────────────────────────────────────

function SectionV() {
  const time = useIdleTime();
  // Soft glow breathing on the gold border
  const breathe = (Math.sin(time * 0.2) + 1) / 2;
  const glow = 0.15 + breathe * 0.1;

  const perks = [
    "Priority queue within your grading tier",
    "2 free Authentication add-ons every month",
    "Free return shipping on every declared-value tier",
    "100 AI Pre-Grade credits per month",
    "Early access to Population Report insights",
  ];

  return (
    <section style={{ backgroundColor: V.paper }}>
      <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          V · Vault Club
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-10">
          <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, color: V.ink }}>
            Silver membership.
          </h2>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, alignSelf: "end", color: V.inkSoft }}>
            A perks-and-credits membership for collectors who submit regularly. No percentage discount — tangible perks that cover real costs.
          </p>
        </div>
        <div
          style={{
            borderRadius: 12,
            padding: 40,
            backgroundColor: V.paperRaised,
            border: `1px solid ${V.goldSoft}`,
            boxShadow: `0 0 40px rgba(212, 175, 55, ${glow * 0.4}), inset 0 0 30px rgba(212, 175, 55, ${glow * 0.1})`,
            transition: "box-shadow 1s ease-in-out",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 32, borderBottom: `1px solid ${V.line}`, paddingBottom: 20 }} className="md:flex-row md:items-baseline md:justify-between">
            <div>
              <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 8, color: V.gold }}>
                Silver Vault
              </p>
              <h3 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.5rem, 2.5vw, 1.875rem)", color: V.ink }}>
                For the regular submitter.
              </h3>
            </div>
            <div style={{ textAlign: "left" }}>
              <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 20, fontWeight: 600, color: V.ink }}>
                £9.99/mo
              </p>
              <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 12, marginTop: 4, color: V.inkMute }}>
                or £99/year
              </p>
            </div>
          </div>
          <ul style={{ display: "grid", gridTemplateColumns: "1fr", gap: "12px 32px", marginBottom: 32, listStyle: "none", padding: 0 }} className="md:grid-cols-2">
            {perks.map((perk) => (
              <li key={perk} style={{ display: "flex", alignItems: "flex-start", gap: 12, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, color: V.inkSoft }}>
                <span style={{ marginTop: 4, flexShrink: 0, color: V.gold, fontWeight: 600 }}>✓</span>
                <span>{perk}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, justifyContent: "space-between" }} className="md:flex-row md:items-center">
            <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 24px", borderRadius: 999, backgroundColor: V.ink, color: V.paper, textDecoration: "none", alignSelf: "flex-start" }}>
              See Vault Club →
            </a>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: V.inkMute }}>
              Subscriptions temporarily paused — relaunching with full perks system.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── SECTION VI: DISCOUNT STACKING ─────────────────────────────────────────

function SectionVI() {
  return (
    <section style={{ backgroundColor: V.paperRaised }}>
      <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          VI · Discount Stacking
        </p>
        <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, marginBottom: 32, color: V.ink }}>
          One discount at a time.
        </h2>
        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 17, lineHeight: 1.6, marginBottom: 24, color: V.inkSoft }}>
          Your basket uses whichever saves you more — bulk discount, or Vault Club perks. Never both. It keeps the maths honest and the pricing legible.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-10">
          {[
            { label: "Example A", body: <>Submit 10 or more cards? <strong style={{ color: V.ink }}>Bulk discount applies</strong> — graduated from 5% at 10 cards to 15% at 50+.</> },
            { label: "Example B", body: <>Silver member? <strong style={{ color: V.ink }}>Vault Club perks apply</strong> — free return shipping, free Authentication credits, priority queue.</> },
          ].map((ex) => (
            <div key={ex.label} style={{ borderRadius: 8, padding: 24, backgroundColor: V.paperSunk, border: `1px solid ${V.line}` }}>
              <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 12, color: V.gold }}>
                {ex.label}
              </p>
              <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, lineHeight: 1.6, color: V.inkSoft }}>
                {ex.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── SECTION VII: FAQ ──────────────────────────────────────────────────────

function FAQItem({ q, a, index }) {
  const ref = useRef(null);
  const progress = useSectionProgress(ref);
  // Gold left-edge accent fades in as item enters viewport
  const accentOpacity = Math.min(1, progress * 3);

  return (
    <div ref={ref} style={{ position: "relative", paddingLeft: 16 }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 1,
          backgroundColor: V.gold,
          opacity: accentOpacity * 0.6,
          transition: "opacity 300ms ease-out",
        }}
      />
      <h3 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.25rem, 1.8vw, 1.5rem)", lineHeight: 1.3, marginBottom: 12, color: V.ink }}>
        {q}
      </h3>
      <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, color: V.inkSoft }}>
        {a}
      </p>
    </div>
  );
}

function SectionVII() {
  const items = [
    { q: "Why only three tiers? What happened to Gold?", a: "We launched with Vault Queue, Standard, and Express because those cover the three real jobs: cheap-and-patient, balanced, and fast. Demand for a higher-price tier will be re-evaluated post-launch based on submission data rather than guesswork." },
    { q: "Is Black Label a paid upgrade?", a: "No. Black Label is automatic when every subgrade (centering, corners, edges, surface) hits a 10. There's no extra charge, no form to tick. If your card earns it, you get it." },
    { q: "Can I combine Vault Club perks with the bulk discount?", a: "No. Your basket applies whichever saves you more — bulk discount or Vault Club perks — never both stacked. This keeps pricing predictable and fair." },
    { q: "Are cards insured in transit?", a: "Yes. All return shipping is Royal Mail Special Delivery with cover matched to your declared-value tier. Incoming shipping is your responsibility, but we recommend Royal Mail Special Delivery for anything above £100." },
    { q: "Do you grade cards other than Pokémon?", a: "Yes. We grade Pokémon, Magic: The Gathering, Yu-Gi-Oh!, One Piece TCG, sports cards, and most other trading card formats. If you're unsure, submit anyway — we'll flag it before grading if we can't authenticate." },
  ];
  return (
    <section style={{ backgroundColor: V.paper }}>
      <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          VII · FAQ
        </p>
        <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, marginBottom: 48, color: V.ink }}>
          Pricing questions.
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {items.map((item, i) => <FAQItem key={item.q} {...item} index={i} />)}
        </div>
      </div>
    </section>
  );
}

// ── SECTION VIII: FINAL CTA (dark) ────────────────────────────────────────

function SectionVIII() {
  return (
    <section style={{ backgroundColor: V.panelDark, position: "relative", overflow: "hidden" }}>
      <DarkSectionGlow />
      <div className="mx-auto max-w-3xl px-6 py-24 md:py-32" style={{ textAlign: "center", position: "relative", zIndex: 1 }}>
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          VIII · Submit
        </p>
        <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, marginBottom: 24, color: "#FFFFFF" }}>
          Ready when you are.
        </h2>
        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, marginBottom: 40, color: "rgba(255,255,255,0.5)" }}>
          From £19. UK-based. Insured in transit.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 24 }}>
          <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 28px", borderRadius: 999, backgroundColor: V.gold, color: V.panelDark, textDecoration: "none" }}>
            Submit a card →
          </a>
          <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 28px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)", textDecoration: "none" }}>
            Try AI Pre-Grade (free) →
          </a>
        </div>
      </div>
    </section>
  );
}

// ── FOOTER (placeholder mirroring FooterV2) ───────────────────────────────

function Footer() {
  return (
    <footer style={{ backgroundColor: V.panelDark, paddingTop: 80, paddingBottom: 40 }}>
      <div className="mx-auto max-w-7xl px-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 mb-16">
          <div>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 16, color: V.gold }}>Services</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {["Pokemon Card Grading UK", "Trading Card Grading UK", "Card Grading Service UK"].map((x) => (
                <li key={x} style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 16, color: V.gold }}>Guides</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {["How to Grade Pokemon Cards", "Grading Costs Explained", "Beginner's Collecting Guide"].map((x) => (
                <li key={x} style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{x}</li>
              ))}
            </ul>
          </div>
          <div>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 16, color: V.gold }}>Company</p>
            <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {["Pricing", "Submit Cards", "Why MintVault"].map((x) => (
                <li key={x} style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 24, fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.15em" }}>
          © MintVault Ltd · Est. Kent
        </div>
      </div>
    </footer>
  );
}

// ── MAIN ─────────────────────────────────────────────────────────────────

export default function MintVaultPricingV2() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: V.paper, position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @import url('https://fonts.googleapis.com/css2?family=Geist:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700&display=swap');
        @media (prefers-reduced-motion: reduce) {
          * { animation: none !important; transition: none !important; }
        }
      `}</style>
      <AmbientLayer />
      <Header />
      <SectionAHero />
      <SectionI />
      <SectionII />
      <SectionIII />
      <SectionIV />
      <SectionV />
      <SectionVI />
      <SectionVII />
      <SectionVIII />
      <Footer />
    </div>
  );
}
