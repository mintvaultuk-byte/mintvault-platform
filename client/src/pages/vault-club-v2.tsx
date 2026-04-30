// @ts-nocheck — visual mockup; full port pending
/* =========================================================================
   MINTVAULT — VAULT CLUB V2 (visual mockup, /vault-club-v2 preview route)
   STRICT CONSTRAINT: zero copy/layout/structure changes from live vault-club.tsx.

   Visual treatments:
     1. Hero slab fan inherits 3D + idle drift from shipped HeroSlabFan.
     2. AmbientLayer — page-level warm gold drift behind everything.
     3. DarkSectionGlow — breathing gold ambience inside Section I (Why Silver)
        and Section VI (Final CTA).
     4. Numbered perk rows (Section I) — IntersectionObserver fade-in on the
        big "01 / 02 / 03 / 04 / 05" numerals; numerals brighten from
        rgba(212,175,55,0.15) → rgba(212,175,55,0.35) when in view.
     5. Annual pricing card (Section III) — breathing gold glow on the box
        shadow (reuses the .silver-vault-card pattern from pricing).
     6. Math-table rows (Section II) — calmer treatment. Subtle row hover
        with a 1px gold left-edge accent. Restrained — table is dense,
        readability comes first.
     7. FAQ items (Section V) — same gold left-edge fade-in as pricing.

   Paused-state copy preserved at all THREE sites:
     - Hero "Subscriptions are paused while we finish the perk system"
     - Section III "Subscriptions temporarily paused — relaunching..."
     - Section VI "Subscriptions are paused while we finish..."
   Hero CTA stays mailto:support@mintvaultuk.com?subject=Vault%20Club%20waitlist.
   No fake "Subscribe Now" buttons. No claim that membership is currently sold.

   FONT: Geist for everything (matches v465 typography deploy).
   COPY: identical to live vault-club.tsx — every word, every CTA, every
         ordinal, every microcopy line preserved verbatim.
   ========================================================================= */

import React, { useEffect, useRef, useState } from "react";

// ── DESIGN TOKENS ──────────────────────────────────────────────────────────
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
  slabNavy: "hsl(220, 45%, 15%)",
  slabPetrol: "hsl(200, 50%, 25%)",
  slabTeal: "hsl(160, 30%, 35%)",
  slabBronze: "hsl(45, 45%, 55%)",
};

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

// IntersectionObserver-based "has been in view" hook. Once true, stays true.
function useHasBeenVisible(ref, threshold = 0.3) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return visible;
}

// ── AMBIENT LAYER ──────────────────────────────────────────────────────────

function AmbientLayer() {
  const time = useIdleTime();
  const x1 = 30 + Math.sin(time * 0.05) * 15;
  const y1 = 25 + Math.cos(time * 0.04) * 10;
  const x2 = 70 + Math.cos(time * 0.04) * 12;
  const y2 = 75 + Math.sin(time * 0.03) * 8;
  return (
    <div aria-hidden="true" style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: -1, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: `${y1 - 35}%`, left: `${x1 - 35}%`, width: "70%", height: "70%", background: "radial-gradient(circle, rgba(212, 175, 55, 0.08) 0%, rgba(212, 175, 55, 0.03) 30%, transparent 60%)", filter: "blur(60px)" }} />
      <div style={{ position: "absolute", top: `${y2 - 30}%`, left: `${x2 - 30}%`, width: "60%", height: "60%", background: "radial-gradient(circle, rgba(184, 150, 12, 0.06) 0%, rgba(184, 150, 12, 0.02) 30%, transparent 60%)", filter: "blur(50px)" }} />
    </div>
  );
}

function DarkSectionGlow() {
  const time = useIdleTime();
  const breathe = (Math.sin(time * 0.15) + 1) / 2;
  const alpha = 0.06 + breathe * 0.04;
  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: "30%", left: "50%", width: "70%", height: "60%", transform: "translate(-50%, -50%)", background: `radial-gradient(ellipse, rgba(212, 175, 55, ${alpha}) 0%, rgba(212, 175, 55, 0.02) 35%, transparent 70%)`, filter: "blur(80px)" }} />
    </div>
  );
}

// ── 3D SLAB ────────────────────────────────────────────────────────────────

function SlabFace({ children, transform, width, height, style = {} }) {
  return (
    <div style={{ position: "absolute", width, height, top: 0, left: 0, transform, backfaceVisibility: "hidden", ...style }}>
      {children}
    </div>
  );
}

function Slab3D({ width, rotateX = 0, rotateY = 0, rotateZ = 0, translateX = 0, translateY = 0, translateZ = 0, scale = 1, topBadge, mainLabel, rightLabel, footnote }) {
  const aspect = 0.82;
  const height = width / aspect;
  const depth = 14;

  return (
    <div style={{ position: "absolute", width, height, transformStyle: "preserve-3d", transform: `translate3d(${translateX}px, ${translateY}px, ${translateZ}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg) scale(${scale})`, willChange: "transform" }}>
      {/* FRONT */}
      <SlabFace transform={`translateZ(${depth / 2}px)`} width={width} height={height}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 12, border: "1px solid rgba(212, 175, 55, 0.4)", backgroundColor: V.paperRaised, overflow: "hidden", boxShadow: "0 30px 60px -20px rgba(15,14,11,0.35), 0 12px 24px -10px rgba(15,14,11,0.18)" }}>
          <div style={{ height: "10%", display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 8px" }}>
            {topBadge && (
              <span style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", color: V.goldSoft, fontSize: width * 0.05, letterSpacing: "0.1em", padding: "1px 6px", border: "1px solid rgba(212, 175, 55, 0.4)", borderRadius: 999, lineHeight: 1 }}>
                {topBadge}
              </span>
            )}
          </div>
          <div style={{ height: "65%", position: "relative", background: `radial-gradient(circle at top left, ${V.slabNavy} 0%, ${V.slabPetrol} 35%, ${V.slabTeal} 70%, ${V.slabBronze} 100%)` }}>
            <div aria-hidden="true" style={{ position: "absolute", inset: 0, backgroundImage: SLAB_NOISE_SVG, opacity: 0.02 }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255, 255, 255, 0.12)", fontStyle: "italic", fontFamily: "'Geist', system-ui, sans-serif", fontSize: width * 0.14, whiteSpace: "nowrap", lineHeight: 1, userSelect: "none", fontWeight: 500 }}>
              MintVault
            </div>
          </div>
          <div style={{ height: "25%", padding: "6px 10px", backgroundColor: V.paperRaised, borderTop: "1px solid rgba(212, 175, 55, 0.3)", display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontFamily: "'Geist', system-ui, sans-serif", color: V.ink, fontSize: width * 0.07, fontWeight: 500, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {mainLabel}
              </span>
              {rightLabel && (
                <span style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", color: V.gold, fontSize: width * 0.06, fontWeight: 600, lineHeight: 1, flexShrink: 0 }}>
                  {rightLabel}
                </span>
              )}
            </div>
            {footnote && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: V.gold, display: "inline-block" }} />
                <span style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", color: V.inkMute, fontSize: 9, letterSpacing: "0.05em", lineHeight: 1 }}>
                  {footnote}
                </span>
              </div>
            )}
          </div>
        </div>
      </SlabFace>
      <SlabFace transform={`translateZ(-${depth / 2}px) rotateY(180deg)`} width={width} height={height}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 12, border: "1px solid rgba(212, 175, 55, 0.4)", background: `linear-gradient(155deg, ${V.slabNavy} 0%, ${V.slabPetrol} 100%)`, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
          <div style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontSize: width * 0.18, color: "rgba(212,175,55,0.55)", fontWeight: 400, lineHeight: 1 }}>MV</div>
          <div style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: width * 0.04, letterSpacing: "0.3em", color: "rgba(212,175,55,0.5)", marginTop: 14 }}>REGISTERED</div>
          {topBadge && <div style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: width * 0.035, letterSpacing: "0.2em", color: "rgba(255,255,255,0.4)", marginTop: 6 }}>{topBadge}</div>}
        </div>
      </SlabFace>
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
            <div key={content.key ?? `slot-${i}`} style={{ position: "absolute", left: "50%", top: "50%", marginLeft: -slabWidth / 2, marginTop: -slabWidth / 0.82 / 2, zIndex: slabs.length - i }}>
              <Slab3D width={slabWidth} translateX={offsets[i].x} translateY={offsets[i].y + drift} rotateZ={rotations[i] + rotDriftZ} rotateY={rotDriftY} topBadge={content.topBadge} mainLabel={content.mainLabel} rightLabel={content.rightLabel} footnote={content.footnote} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── HEADER ────────────────────────────────────────────────────────────────

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
  const slabs = [
    { topBadge: "AUTHENTICATION", mainLabel: "×2 free", rightLabel: "/mo", footnote: "£30.00 VALUE · MONTHLY", key: "auth" },
    { topBadge: "RETURN SHIPPING", mainLabel: "Free", rightLabel: "Always", footnote: "ALL TIERS INSURED", key: "shipping" },
    { topBadge: "AI CREDITS", mainLabel: "×100", rightLabel: "/mo", footnote: "PRE-GRADE UNLIMITED", key: "credits" },
  ];

  return (
    <section style={{ position: "relative" }}>
      <div className="mx-auto max-w-7xl px-6 pt-10 pb-20 md:pt-16 md:pb-32 grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-12 md:gap-16 items-center">
        <div>
          <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 24, color: V.gold }}>
            Est. Kent · Vault Club
          </p>
          <h1 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, lineHeight: 0.95, marginBottom: 24, fontSize: "clamp(2.75rem, 6vw, 5rem)", color: V.ink }}>
            For the<br />regular submitter.
          </h1>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 17, lineHeight: 1.6, maxWidth: 540, marginBottom: 32, color: V.inkSoft }}>
            Silver is a perks-and-credits membership for collectors who submit regularly. Subscriptions are paused while we finish the perk system — join the waitlist and you'll be first when it reopens.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <a href="mailto:support@mintvaultuk.com?subject=Vault%20Club%20waitlist" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 24px", borderRadius: 999, backgroundColor: V.ink, color: V.paper, textDecoration: "none" }}>
              Notify me when it reopens →
            </a>
            <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 24px", borderRadius: 999, border: `1px solid ${V.line}`, color: V.inkSoft, textDecoration: "none" }}>
              Try AI Pre-Grade (free) →
            </a>
          </div>
          <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: V.inkMute }}>
            £9.99 / month · 5 perks · Membership paused
          </p>
        </div>
        <HeroSlabFan slabs={slabs} />
      </div>
    </section>
  );
}

// ── SECTION I: WHY SILVER (dark) ──────────────────────────────────────────

function PerkRow({ number, title, body, value, isFirst }) {
  const ref = useRef(null);
  const visible = useHasBeenVisible(ref, 0.4);

  return (
    <div
      ref={ref}
      className="grid grid-cols-[auto_1fr] md:grid-cols-[auto_1fr_auto] gap-6 md:gap-10 py-8 md:py-10"
      style={{
        borderTop: isFirst ? "1px solid rgba(255,255,255,0.1)" : undefined,
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(20px)",
        transition: "opacity 700ms ease-out, transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1)",
      }}
    >
      <p
        style={{
          fontFamily: "'Geist', system-ui, sans-serif",
          fontStyle: "italic",
          fontWeight: 500,
          lineHeight: 1,
          fontSize: "clamp(2rem, 4vw, 3rem)",
          // Big numerals: faint gold by default, brighten when in view.
          color: visible ? "rgba(212, 175, 55, 0.45)" : "rgba(212, 175, 55, 0.15)",
          transition: "color 1000ms ease-out 200ms",
          textShadow: visible ? "0 0 20px rgba(212, 175, 55, 0.2)" : "none",
        }}
      >
        {number}
      </p>
      <div>
        <h3 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.25rem, 1.8vw, 1.5rem)", lineHeight: 1.3, marginBottom: 12, color: "#FFFFFF" }}>
          {title}
        </h3>
        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 15, lineHeight: 1.6, maxWidth: 540, color: "rgba(255,255,255,0.6)" }}>
          {body}
        </p>
        {value && (
          <p className="md:hidden" style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", marginTop: 12, color: V.gold }}>
            {value}
          </p>
        )}
      </div>
      {value && (
        <p className="hidden md:block" style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", alignSelf: "flex-start", textAlign: "right", whiteSpace: "nowrap", color: V.gold }}>
          {value}
        </p>
      )}
    </div>
  );
}

function SectionI() {
  const PERKS = [
    { number: "01", title: "Priority queue within your grading tier", body: "Members jump ahead within their chosen tier. No turnaround SLA change, but first in, first out — every time.", value: null },
    { number: "02", title: "Two free Authentication add-ons every month", body: "Worth £15 each. If you submit cards that need authentication, this alone covers the membership.", value: "£30.00/mo value" },
    { number: "03", title: "Free return shipping on every declared-value tier", body: "High-value submitters save most. Standard tier saves £4.99 per submission; Max tier saves £24.99.", value: "£4.99–£24.99 / submission" },
    { number: "04", title: "100 AI Pre-Grade credits every month", body: "Test cards before submitting. Credits reset monthly — no rollover — so use them or lose them.", value: "Unlimited practical use" },
    { number: "05", title: "Early access to Population Report features", body: "See new filters, exports, and analytics before they ship publicly. Shape the tool as it grows.", value: "Priority access" },
  ];

  return (
    <section style={{ backgroundColor: V.panelDark, position: "relative", overflow: "hidden" }}>
      <DarkSectionGlow />
      <div className="mx-auto max-w-7xl px-6 py-24 md:py-32" style={{ position: "relative", zIndex: 1 }}>
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          I · Why Silver
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-16">
          <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, color: "#FFFFFF" }}>
            Perks, not<br />
            <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 400, color: V.goldSoft }}>percentages.</span>
          </h2>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, alignSelf: "end", color: "rgba(255,255,255,0.6)" }}>
            A percentage discount scales with the cheapest cards and hurts our margin on Express. Perks do the opposite — they give members tangible, predictable value that stays honest on both sides of the transaction.
          </p>
        </div>

        <div style={{ maxWidth: 1024 }}>
          {PERKS.map((perk, i) => (
            <PerkRow key={perk.number} {...perk} isFirst={i === 0} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ── SECTION II: THE MATH ──────────────────────────────────────────────────

function MathRow({ cards, authCount, authValue, shipping, shippingLabel, total, net, isLast }) {
  const [hovered, setHovered] = useState(false);
  return (
    <tr
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        borderBottom: isLast ? undefined : `1px solid ${V.lineSoft}`,
        backgroundColor: V.paperRaised,
        position: "relative",
        boxShadow: hovered ? `inset 3px 0 0 ${V.gold}` : "inset 0 0 0 transparent",
        transition: "box-shadow 200ms ease-out",
      }}
    >
      <td style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "16px", color: V.ink }}>{cards}</td>
      <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, padding: "16px", color: V.ink }}>{authCount} · {authValue}</td>
      <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, padding: "16px", color: V.ink }}>
        {shipping}
        <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 12, marginLeft: 6, color: V.inkMute }}>({shippingLabel})</span>
      </td>
      <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, padding: "16px", color: V.ink }}>{total}</td>
      <td style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600, padding: "16px", color: V.gold }}>+{net} saved</td>
    </tr>
  );
}

function SectionII() {
  const SCENARIOS = [
    { cards: "1 card", authCount: "1", authValue: "£15.00", shipping: "£4.99", shippingLabel: "Standard", total: "£19.99", net: "£10.00" },
    { cards: "3 cards", authCount: "2 (max)", authValue: "£30.00", shipping: "£4.99", shippingLabel: "Standard", total: "£34.99", net: "£25.00" },
    { cards: "5 cards", authCount: "2 (max)", authValue: "£30.00", shipping: "£9.99", shippingLabel: "Enhanced", total: "£39.99", net: "£30.00" },
  ];

  return (
    <section style={{ backgroundColor: V.paper }}>
      <div className="mx-auto max-w-5xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          II · The Math
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-16 mb-12">
          <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, color: V.ink }}>
            When Silver<br />pays off.
          </h2>
          <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, alignSelf: "end", color: V.inkSoft }}>
            Membership is £9.99/month. Here's what you'd save at different submission cadences, assuming Standard grading tier with one Authentication add-on per submission.
          </p>
        </div>

        <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${V.line}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
            <thead>
              <tr style={{ backgroundColor: V.paperRaised, borderBottom: `1px solid ${V.line}` }}>
                {["Submissions / month", "Authentication", "Shipping saved", "Total value", "Net vs £9.99"].map((h) => (
                  <th key={h} style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", padding: "12px 16px", textAlign: "left", color: V.inkMute }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SCENARIOS.map((s, i) => (
                <MathRow key={s.cards} {...s} isLast={i === SCENARIOS.length - 1} />
              ))}
            </tbody>
          </table>
        </div>

        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 12, marginTop: 24, color: V.inkMute }}>
          Based on Standard grading tier. Higher declared values save more on shipping. AI Pre-Grade credits excluded — bonus on top.
        </p>
      </div>
    </section>
  );
}

// ── SECTION III: MONTHLY VS ANNUAL ────────────────────────────────────────

function SectionIII() {
  const time = useIdleTime();
  // Slow breathing on the annual card's outer glow
  const breathe = (Math.sin(time * 0.2) + 1) / 2;
  const glow = 0.15 + breathe * 0.25;

  return (
    <section style={{ backgroundColor: V.paperRaised }}>
      <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          III · Pricing
        </p>
        <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, marginBottom: 48, color: V.ink }}>
          Monthly or annual.
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Monthly card — calm, no glow */}
          <div style={{ borderRadius: 12, padding: 32, backgroundColor: V.paper, border: `1px solid ${V.line}` }}>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 16, color: V.inkMute }}>
              Monthly
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontWeight: 600, color: V.ink, fontSize: "clamp(48px, 5vw, 64px)", lineHeight: 1 }}>£9.99</span>
              <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, color: V.inkMute }}>/ month</span>
            </div>
            <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, marginBottom: 24, color: V.inkSoft }}>
              Cancel anytime. Bill renews monthly.
            </p>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: V.inkMute }}>
              Good for month-to-month flexibility.
            </p>
          </div>

          {/* Annual card — breathing glow */}
          <div
            style={{
              position: "relative",
              borderRadius: 12,
              padding: 32,
              backgroundColor: V.paper,
              border: `1px solid ${V.goldSoft}`,
              boxShadow: `0 0 40px rgba(212, 175, 55, ${glow * 0.4}), inset 0 0 30px rgba(212, 175, 55, ${glow * 0.1})`,
              transition: "box-shadow 1s ease-in-out",
            }}
          >
            <span style={{ position: "absolute", top: -14, left: "50%", transform: "translateX(-50%)", fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.15em", padding: "6px 16px", borderRadius: 4, whiteSpace: "nowrap", backgroundColor: V.gold, color: V.panelDark }}>
              Save £20.88
            </span>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 16, color: V.gold }}>
              Annual
            </p>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontWeight: 600, color: V.ink, fontSize: "clamp(48px, 5vw, 64px)", lineHeight: 1 }}>£99</span>
              <span style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, color: V.inkMute }}>/ year</span>
            </div>
            <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, marginBottom: 24, color: V.inkSoft }}>
              Equivalent to two months free. Bill renews yearly.
            </p>
            <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: V.gold }}>
              Best value for regular submitters.
            </p>
          </div>
        </div>

        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", marginTop: 40, textAlign: "center", color: V.gold }}>
          Subscriptions temporarily paused — relaunching with the full perks system.
        </p>
        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 12, textAlign: "center", marginTop: 8, color: V.inkMute }}>
          Contact support@mintvaultuk.com to join the waitlist.
        </p>
      </div>
    </section>
  );
}

// ── SECTION IV: WHAT SILVER ISN'T ─────────────────────────────────────────

function SectionIV() {
  return (
    <section style={{ backgroundColor: V.paper }}>
      <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          IV · Honesty
        </p>
        <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, marginBottom: 48, color: V.ink }}>
          What Silver isn't.
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          <div>
            <h3 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.25rem, 1.8vw, 1.5rem)", lineHeight: 1.3, marginBottom: 12, color: V.ink }}>
              Not a percentage discount on grading.
            </h3>
            <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, color: V.inkSoft }}>
              Perks are flag-based — specific fees waived (Authentication, return shipping), not a blanket percentage off the price per card. Your grading fee is the same as a non-member's.
            </p>
          </div>
          <div>
            <h3 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.25rem, 1.8vw, 1.5rem)", lineHeight: 1.3, marginBottom: 12, color: V.ink }}>
              Not stackable with the bulk discount.
            </h3>
            <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, color: V.inkSoft }}>
              Your basket applies whichever saves more — Silver perks or the bulk discount — never both combined. Submitting 10 or more cards? The basket may use bulk instead. It's always the better of the two.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── SECTION V: FAQ ────────────────────────────────────────────────────────

function FAQItem({ q, a }) {
  const ref = useRef(null);
  const visible = useHasBeenVisible(ref, 0.3);
  return (
    <div ref={ref} style={{ position: "relative", paddingLeft: 16 }}>
      <div aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 1, backgroundColor: V.gold, opacity: visible ? 0.6 : 0, transition: "opacity 600ms ease-out" }} />
      <h3 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.25rem, 1.8vw, 1.5rem)", lineHeight: 1.3, marginBottom: 12, color: V.ink }}>
        {q}
      </h3>
      <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, lineHeight: 1.6, color: V.inkSoft }}>
        {a}
      </p>
    </div>
  );
}

function SectionV() {
  const FAQS = [
    { q: "Why no Gold or Bronze tier?", a: "We launched Silver-only to learn what collectors actually use. Bronze and Gold return once the data supports them." },
    { q: "Can I cancel anytime?", a: "Yes. Monthly plans cancel from the next billing cycle. Annual plans run to the end of the paid term — no partial refunds, but you keep every perk until it ends." },
    { q: "Do unused credits roll over?", a: "No. Free Authentication add-ons and AI Pre-Grade credits reset every month. Use them within the month or lose them." },
    { q: "Can I combine Silver with the bulk discount?", a: "No. Your basket applies whichever saves more — Silver perks or the bulk discount — never both stacked." },
    { q: "Why is checkout paused right now?", a: "We're finishing the perk-evaluator so every waived fee (shipping, Authentication) applies correctly at checkout. Relaunching soon." },
    { q: "What if I don't submit often?", a: "Silver pays for itself at roughly one Authentication per month. If you submit less than that, skip membership and pay per-card — honestly, it's the better deal." },
  ];
  return (
    <section style={{ backgroundColor: V.paperRaised }}>
      <div className="mx-auto max-w-4xl px-6 py-24 md:py-32">
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          V · FAQ
        </p>
        <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, marginBottom: 48, color: V.ink }}>
          Silver questions.
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>
          {FAQS.map((item) => <FAQItem key={item.q} {...item} />)}
        </div>
      </div>
    </section>
  );
}

// ── SECTION VI: FINAL CTA (dark) ──────────────────────────────────────────

function SectionVI() {
  return (
    <section style={{ backgroundColor: V.panelDark, position: "relative", overflow: "hidden" }}>
      <DarkSectionGlow />
      <div className="mx-auto max-w-3xl px-6 py-24 md:py-32" style={{ textAlign: "center", position: "relative", zIndex: 1 }}>
        <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.25em", marginBottom: 16, color: V.gold }}>
          VI · Waitlist
        </p>
        <h2 style={{ fontFamily: "'Geist', system-ui, sans-serif", fontStyle: "italic", fontWeight: 500, fontSize: "clamp(1.875rem, 4vw, 3rem)", lineHeight: 1.1, marginBottom: 24, color: "#FFFFFF" }}>
          Ready when we are.
        </h2>
        <p style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 16, marginBottom: 40, color: "rgba(255,255,255,0.5)" }}>
          Subscriptions are paused while we finish the perks system. Join the waitlist — you'll be first when we reopen.
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 24 }}>
          <a href="mailto:support@mintvaultuk.com?subject=Vault%20Club%20waitlist" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 28px", borderRadius: 999, backgroundColor: V.gold, color: V.panelDark, textDecoration: "none" }}>
            Email the waitlist →
          </a>
          <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "'Geist', system-ui, sans-serif", fontSize: 14, fontWeight: 600, padding: "12px 28px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.2)", color: "rgba(255,255,255,0.7)", textDecoration: "none" }}>
            Try AI Pre-Grade →
          </a>
        </div>
      </div>
    </section>
  );
}

// ── FOOTER ────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer style={{ backgroundColor: V.panelDark, paddingTop: 80, paddingBottom: 40 }}>
      <div className="mx-auto max-w-7xl px-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 mb-16">
          {[
            { title: "Services", items: ["Pokemon Card Grading UK", "Trading Card Grading UK", "Card Grading Service UK"] },
            { title: "Guides", items: ["How to Grade Pokemon Cards", "Grading Costs Explained", "Beginner's Collecting Guide"] },
            { title: "Company", items: ["Pricing", "Submit Cards", "Why MintVault"] },
          ].map((col) => (
            <div key={col.title}>
              <p style={{ fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 16, color: V.gold }}>{col.title}</p>
              <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {col.items.map((x) => (
                  <li key={x} style={{ fontFamily: "'Geist', system-ui, sans-serif", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{x}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 24, fontFamily: "'Geist Mono', 'JetBrains Mono', monospace", fontSize: 10, color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: "0.15em" }}>
          © MintVault Ltd · Est. Kent
        </div>
      </div>
    </footer>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────

export default function MintVaultVaultClubV2() {
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
      <Footer />
    </div>
  );
}
