// @ts-nocheck — visual mockup; full port pending
import { useEffect, useState, useRef } from "react";

/* =========================================================================
   MINTVAULT — HOW IT WORKS
   Five acts, one slab journey. Same tokens, fonts, portal pattern as home.
   ========================================================================= */

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

function useIdleTime() {
  const [time, setTime] = useState(0);
  useEffect(() => {
    let raf;
    const tick = () => { setTime((t) => t + 0.005); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return time;
}

/* =========================================================================
   PORTAL — same as homepage
   ========================================================================= */
function Portal({ children, height = "75vh" }) {
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
      <div style={{
        position: "absolute", inset: 8, borderRadius: 12,
        border: `1px solid rgba(212, 175, 55, 0.18)`,
        pointerEvents: "none", zIndex: 2,
      }} />
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
   RAW CARD — a trading card before slabbing (no border, just the card art)
   ========================================================================= */
function RawCard({ width = 200, rotateY = 0, rotateX = 0, translateX = 0, translateY = 0, translateZ = 0, scale = 1, opacity = 1, glow = 0 }) {
  const aspect = 0.71; // standard TCG aspect
  const height = width / aspect;

  return (
    <div style={{
      position: "absolute",
      width, height,
      transformStyle: "preserve-3d",
      transform: `translate3d(${translateX}px, ${translateY}px, ${translateZ}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale})`,
      opacity,
      willChange: "transform, opacity",
    }}>
      {/* Front */}
      <div style={{
        position: "absolute",
        inset: 0,
        borderRadius: 12,
        background: `radial-gradient(ellipse at top left, ${V.slabNavy} 0%, ${V.slabPetrol} 35%, ${V.slabTeal} 70%, ${V.slabBronze} 100%)`,
        backfaceVisibility: "hidden",
        boxShadow: `0 30px 60px -20px rgba(15,14,11,0.5), 0 ${glow * 40}px ${glow * 80}px rgba(212, 175, 55, ${glow * 0.4})`,
        overflow: "hidden",
      }}>
        {/* Noise */}
        <div style={{
          position: "absolute",
          inset: 0,
          backgroundImage: SLAB_NOISE_SVG,
          opacity: 0.025,
        }} />
        {/* Card name top */}
        <div style={{
          position: "absolute",
          top: 12, left: 14,
          fontFamily: "'Fraunces', Georgia, serif",
          fontStyle: "italic",
          fontSize: width * 0.07,
          color: "rgba(255, 255, 255, 0.95)",
          fontWeight: 500,
          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
        }}>
          Holo Charizard
        </div>
        {/* Frame inner */}
        <div style={{
          position: "absolute",
          top: 36, left: 14, right: 14, bottom: 60,
          borderRadius: 4,
          border: "2px solid rgba(212, 175, 55, 0.55)",
          background: "linear-gradient(160deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.15) 100%)",
        }}>
          {/* Holo shimmer */}
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(105deg, transparent 30%, rgba(255, 220, 100, 0.18) 50%, transparent 70%)",
          }} />
          {/* Faux art silhouette */}
          <div style={{
            position: "absolute", inset: "10% 15%",
            background: "radial-gradient(ellipse at 50% 60%, rgba(255, 140, 60, 0.35) 0%, transparent 70%)",
            borderRadius: 4,
          }} />
          <div style={{
            position: "absolute",
            top: "30%", left: "50%",
            transform: "translateX(-50%)",
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic",
            fontSize: width * 0.32,
            color: "rgba(255,180,80,0.5)",
            fontWeight: 400,
            lineHeight: 1,
          }}>
            ◆
          </div>
        </div>
        {/* Bottom info bar */}
        <div style={{
          position: "absolute",
          bottom: 14, left: 14, right: 14,
          display: "flex", justifyContent: "space-between", alignItems: "flex-end",
        }}>
          <div style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: width * 0.05,
            color: "rgba(255,255,255,0.85)",
            letterSpacing: "0.05em",
          }}>
            #4 / 102
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: width * 0.04,
            color: "rgba(255,255,255,0.55)",
            letterSpacing: "0.1em",
          }}>
            BASE SET · 1999
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   ACT I — SUBMISSION
   Raw card enters frame. Sits centre, gentle drift. "It starts with one card."
   ========================================================================= */
function ActSubmission() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);
  const time = useIdleTime();

  const entry = easeOutCubic(range(p, 0.05, 0.4));
  const exit = range(p, 0.85, 1);

  const drift = Math.sin(time * 0.7) * 8;
  const driftRot = Math.sin(time * 0.5) * 3;

  return (
    <section ref={ref} style={{
      backgroundColor: V.paper,
      position: "relative",
      minHeight: "200vh",
    }}>
      <div style={{
        position: "sticky",
        top: 64,
        height: "calc(100vh - 64px)",
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
        display: "grid",
        gridTemplateColumns: "1fr 1.1fr",
        gap: 64,
        alignItems: "center",
      }}>
        {/* LEFT — copy */}
        <div>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11, color: V.gold,
            letterSpacing: "0.3em", textTransform: "uppercase",
            fontWeight: 500, margin: 0, marginBottom: 24,
          }}>
            ── 01 / Submission
          </p>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: "clamp(2.5rem, 5.5vw, 4.5rem)",
            lineHeight: 0.95, color: V.ink,
            margin: 0, marginBottom: 32,
          }}>
            It starts with<br />one card.
          </h2>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 18, lineHeight: 1.65, color: V.inkSoft,
            margin: 0, marginBottom: 24, maxWidth: 480,
          }}>
            Sleeve it. Top-load it. Box it with bubble wrap. Send it
            insured to our Kent grading facility — we'll cover return
            postage either way.
          </p>
          <div style={{
            borderTop: `1px solid ${V.line}`,
            paddingTop: 24,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20,
            maxWidth: 480,
          }}>
            <div>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10, color: V.inkMute,
                letterSpacing: "0.15em", textTransform: "uppercase",
              }}>Submitted via</div>
              <div style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 22, color: V.ink,
                fontWeight: 500, marginTop: 4,
                fontStyle: "italic",
              }}>Royal Mail Special</div>
            </div>
            <div>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10, color: V.inkMute,
                letterSpacing: "0.15em", textTransform: "uppercase",
              }}>Insured to</div>
              <div style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 22, color: V.ink,
                fontWeight: 500, marginTop: 4,
                fontStyle: "italic",
              }}>£2,500</div>
            </div>
          </div>
        </div>

        {/* RIGHT — portal with raw card floating */}
        <Portal height="78vh">
          <div style={{ position: "absolute", inset: 0, perspective: 1800 }}>
            <div style={{ position: "absolute", left: "50%", top: "50%" }}>
              <RawCard
                width={200}
                translateX={-100}
                translateY={-141 + drift}
                rotateY={driftRot * 2}
                rotateX={driftRot * 0.5}
                scale={lerp(0.5, 1, entry) - exit * 0.1}
                opacity={entry - exit}
                glow={0.3}
              />
            </div>
          </div>
          <div style={{
            position: "absolute",
            top: 24, left: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: V.goldSoft,
            letterSpacing: "0.3em",
            opacity: 0.85,
          }}>
            ◆ HOLO CHARIZARD · BASE SET 1999
          </div>
          <div style={{
            position: "absolute",
            bottom: 24, right: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: "rgba(212,175,55,0.55)",
            letterSpacing: "0.3em",
          }}>
            STATUS · INTAKE
          </div>
        </Portal>
      </div>
    </section>
  );
}

/* =========================================================================
   ACT II — RECEIPT
   Card photographed. Serial label engraves alongside it.
   ========================================================================= */
function ActReceipt() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);

  const entry = easeOutCubic(range(p, 0.05, 0.3));
  const rotation = easeInOutCubic(range(p, 0.25, 0.65));
  const labelReveal = easeOutCubic(range(p, 0.45, 0.8));
  const flash = range(p, 0.5, 0.55);

  const cardRotY = rotation * 30 - 15;
  const serialChars = "MV-2026-0001";
  const serialVisibleCount = Math.floor(labelReveal * serialChars.length);

  return (
    <section ref={ref} style={{
      backgroundColor: V.paper,
      position: "relative",
      minHeight: "250vh",
    }}>
      <div style={{
        position: "sticky",
        top: 64,
        height: "calc(100vh - 64px)",
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
        display: "grid",
        gridTemplateColumns: "1.1fr 1fr",
        gap: 64,
        alignItems: "center",
      }}>
        {/* LEFT — portal */}
        <Portal height="78vh">
          {/* Camera flash overlay */}
          <div style={{
            position: "absolute",
            inset: 0,
            background: "rgba(255, 255, 255, 0.95)",
            opacity: Math.sin(flash * Math.PI),
            pointerEvents: "none",
            zIndex: 5,
          }} />

          <div style={{ position: "absolute", inset: 0, perspective: 1800 }}>
            <div style={{ position: "absolute", left: "50%", top: "50%" }}>
              <RawCard
                width={180}
                translateX={-90 - 80}
                translateY={-127}
                rotateY={cardRotY}
                opacity={entry}
                scale={lerp(0.6, 0.95, entry)}
                glow={0.4}
              />
            </div>

            {/* Serial label appearing alongside */}
            <div style={{
              position: "absolute",
              left: "50%", top: "50%",
              transform: `translate(${lerp(40, 80, labelReveal)}px, -60px)`,
              opacity: labelReveal,
              width: 220,
            }}>
              <div style={{
                backgroundColor: V.paperRaised,
                borderRadius: 6,
                border: "1px solid rgba(212, 175, 55, 0.6)",
                padding: "12px 16px",
                boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
              }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 9,
                  color: V.gold,
                  letterSpacing: "0.25em",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}>
                  Serial assigned
                </div>
                <div style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 18,
                  color: V.ink,
                  letterSpacing: "0.1em",
                  fontWeight: 600,
                }}>
                  {serialChars.slice(0, serialVisibleCount)}
                  <span style={{
                    display: "inline-block",
                    width: 2,
                    height: 18,
                    backgroundColor: V.gold,
                    marginLeft: 2,
                    verticalAlign: "middle",
                    opacity: serialVisibleCount < serialChars.length ? 1 : 0,
                  }} />
                </div>
                <div style={{
                  fontFamily: "'Geist Variable', system-ui, sans-serif",
                  fontSize: 11,
                  color: V.inkMute,
                  marginTop: 8,
                  borderTop: `1px solid ${V.line}`,
                  paddingTop: 8,
                }}>
                  Photographed at receipt — front, back, edges. Stored in
                  the case file forever.
                </div>
              </div>
            </div>

            {/* Camera bracket marks */}
            <div style={{
              position: "absolute", inset: "20%",
              pointerEvents: "none",
              opacity: entry * 0.6,
            }}>
              {[
                { top: 0, left: 0, t: "translate(0,0)" },
                { top: 0, right: 0, t: "translate(0,0)" },
                { bottom: 0, left: 0, t: "translate(0,0)" },
                { bottom: 0, right: 0, t: "translate(0,0)" },
              ].map((c, i) => (
                <div key={i} style={{
                  position: "absolute", ...c,
                  width: 24, height: 24,
                  borderTop: i < 2 ? `1px solid ${V.gold}` : "none",
                  borderBottom: i >= 2 ? `1px solid ${V.gold}` : "none",
                  borderLeft: i % 2 === 0 ? `1px solid ${V.gold}` : "none",
                  borderRight: i % 2 === 1 ? `1px solid ${V.gold}` : "none",
                }} />
              ))}
            </div>
          </div>

          <div style={{
            position: "absolute",
            top: 24, left: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: V.goldSoft,
            letterSpacing: "0.3em",
            opacity: 0.85,
          }}>
            ◆ INTAKE · PHOTOGRAPHIC RECORD
          </div>
          <div style={{
            position: "absolute",
            bottom: 24, right: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: "rgba(212,175,55,0.55)",
            letterSpacing: "0.3em",
          }}>
            STATUS · LOGGED
          </div>
        </Portal>

        {/* RIGHT — copy */}
        <div>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11, color: V.gold,
            letterSpacing: "0.3em", textTransform: "uppercase",
            fontWeight: 500, margin: 0, marginBottom: 24,
          }}>
            ── 02 / Receipt
          </p>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: "clamp(2.5rem, 5.5vw, 4.5rem)",
            lineHeight: 0.95, color: V.ink,
            margin: 0, marginBottom: 32,
          }}>
            Logged.<br />Photographed.<br />Numbered.
          </h2>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 18, lineHeight: 1.65, color: V.inkSoft,
            margin: 0, marginBottom: 24, maxWidth: 460,
          }}>
            On arrival, your card is photographed under controlled lighting —
            front, back, all four edges. A unique reference number is assigned
            and written to the case file. From this point on, every event
            attaches to that number for the life of the card.
          </p>
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   ACT III — GRADING
   Four-point inspection. Counters animate up with scroll.
   ========================================================================= */
function ActGrading() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);

  const entry = easeOutCubic(range(p, 0.05, 0.25));
  const metricsReveal = range(p, 0.2, 0.85);

  // Each metric reveals in sequence
  const m1 = clamp((metricsReveal - 0.0) * 4);
  const m2 = clamp((metricsReveal - 0.15) * 4);
  const m3 = clamp((metricsReveal - 0.30) * 4);
  const m4 = clamp((metricsReveal - 0.45) * 4);

  // Scan line position
  const scanY = (metricsReveal % 0.25) * 4; // 0..1 cycling

  const metrics = [
    { label: "Centring", value: 9.5, progress: m1, position: "tl" },
    { label: "Corners", value: 10.0, progress: m2, position: "tr" },
    { label: "Edges", value: 9.5, progress: m3, position: "bl" },
    { label: "Surface", value: 10.0, progress: m4, position: "br" },
  ];

  return (
    <section ref={ref} style={{
      backgroundColor: V.paper,
      position: "relative",
      minHeight: "350vh",
    }}>
      <div style={{
        position: "sticky",
        top: 64,
        height: "calc(100vh - 64px)",
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}>
        <div style={{ marginBottom: 32, maxWidth: 720 }}>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11, color: V.gold,
            letterSpacing: "0.3em", textTransform: "uppercase",
            fontWeight: 500, margin: 0, marginBottom: 18,
          }}>
            ── 03 / Grading
          </p>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: "clamp(2.5rem, 5vw, 4rem)",
            lineHeight: 0.95, color: V.ink,
            margin: 0, marginBottom: 16,
          }}>
            Four points.<br />One verdict.
          </h2>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 17, lineHeight: 1.6, color: V.inkSoft,
            margin: 0, maxWidth: 560,
          }}>
            Centring measured to 0.1mm. Corners examined under 10× magnification.
            Edges checked for whitening. Surface reviewed for print defects, scratches,
            and indentation. Each scored independently. The lowest sub-grade caps the headline grade.
          </p>
        </div>

        {/* Wide portal */}
        <Portal height="56vh">
          <div style={{ position: "absolute", inset: 0, perspective: 1600 }}>
            <div style={{ position: "absolute", left: "50%", top: "50%" }}>
              <RawCard
                width={180}
                translateX={-90}
                translateY={-127}
                rotateY={Math.sin(metricsReveal * Math.PI) * 6}
                opacity={entry}
                scale={lerp(0.7, 1, entry)}
                glow={0.5}
              />
            </div>

            {/* Scan line sweeping across */}
            <div style={{
              position: "absolute",
              left: "30%", right: "30%",
              top: `${20 + scanY * 60}%`,
              height: 1,
              background: `linear-gradient(90deg, transparent 0%, ${V.gold} 50%, transparent 100%)`,
              boxShadow: `0 0 8px ${V.gold}`,
              opacity: 0.7,
              pointerEvents: "none",
            }} />

            {/* Four metric corners */}
            {metrics.map((m, i) => {
              const positions = {
                tl: { top: 32, left: 32 },
                tr: { top: 32, right: 32 },
                bl: { bottom: 32, left: 32 },
                br: { bottom: 32, right: 32 },
              };
              return (
                <div key={i} style={{
                  position: "absolute",
                  ...positions[m.position],
                  width: 200,
                  opacity: m.progress,
                  transform: `translateY(${(1 - m.progress) * 12}px)`,
                  textAlign: m.position.includes("r") ? "right" : "left",
                }}>
                  <div style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 9,
                    color: V.goldSoft,
                    letterSpacing: "0.3em",
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}>
                    {m.label}
                  </div>
                  <div style={{
                    fontFamily: "'Fraunces', Georgia, serif",
                    fontSize: 56,
                    color: "#FFFFFF",
                    fontWeight: 400,
                    lineHeight: 1,
                    textShadow: "0 0 24px rgba(212, 175, 55, 0.3)",
                  }}>
                    {(m.value * m.progress).toFixed(1)}
                  </div>
                  {/* Progress bar */}
                  <div style={{
                    marginTop: 10,
                    height: 1,
                    backgroundColor: "rgba(212,175,55,0.2)",
                    position: "relative",
                  }}>
                    <div style={{
                      position: "absolute",
                      top: 0,
                      left: m.position.includes("r") ? "auto" : 0,
                      right: m.position.includes("r") ? 0 : "auto",
                      height: "100%",
                      width: `${m.progress * 100}%`,
                      backgroundColor: V.gold,
                      boxShadow: `0 0 4px ${V.gold}`,
                    }} />
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{
            position: "absolute",
            bottom: 24, left: "50%",
            transform: "translateX(-50%)",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: "rgba(212,175,55,0.65)",
            letterSpacing: "0.3em",
            textTransform: "uppercase",
          }}>
            Final grade · MV {Math.min(...metrics.map(m => m.value * (m.progress > 0.95 ? 1 : 0))).toFixed(1) || "—"}
          </div>
        </Portal>
      </div>
    </section>
  );
}

/* =========================================================================
   ACT IV — SLABBING
   The slab assembles around the card.
   ========================================================================= */
function ActSlabbing() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);

  // Stages of assembly
  const cardEntry = easeOutCubic(range(p, 0.05, 0.20));
  const frameSlideUp = easeInOutCubic(range(p, 0.20, 0.40));     // back panel slides up
  const frameSlideDown = easeInOutCubic(range(p, 0.30, 0.50));    // front panel slides down
  const edgesIn = easeInOutCubic(range(p, 0.45, 0.60));           // gold edges close
  const labelEngrave = easeOutCubic(range(p, 0.55, 0.72));        // top + bottom labels appear
  const sealLight = easeInOutCubic(range(p, 0.7, 0.85));          // seal flash
  const finalReveal = easeOutCubic(range(p, 0.82, 1.0));

  const slabWidth = 220;
  const slabHeight = slabWidth / 0.82;
  const cardWidth = 180;
  const cardHeight = cardWidth / 0.71;

  return (
    <section ref={ref} style={{
      backgroundColor: V.paper,
      position: "relative",
      minHeight: "400vh",
    }}>
      <div style={{
        position: "sticky",
        top: 64,
        height: "calc(100vh - 64px)",
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
        display: "grid",
        gridTemplateColumns: "1fr 1.1fr",
        gap: 64,
        alignItems: "center",
      }}>
        {/* LEFT — copy */}
        <div>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11, color: V.gold,
            letterSpacing: "0.3em", textTransform: "uppercase",
            fontWeight: 500, margin: 0, marginBottom: 24,
          }}>
            ── 04 / Slabbing
          </p>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: "clamp(2.5rem, 5.5vw, 4.5rem)",
            lineHeight: 0.95, color: V.ink,
            margin: 0, marginBottom: 32,
          }}>
            Sealed for life.
          </h2>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 18, lineHeight: 1.65, color: V.inkSoft,
            margin: 0, marginBottom: 24, maxWidth: 460,
          }}>
            Two-piece archival enclosure, ultrasonically welded. Once sealed,
            the slab cannot be opened without visible damage. Inside: a sub-millimetre
            NFC chip bonded to your reference number, readable by any phone, on any continent.
          </p>
          <div style={{
            borderTop: `1px solid ${V.line}`,
            paddingTop: 24,
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20,
            maxWidth: 460,
          }}>
            <div>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10, color: V.inkMute,
                letterSpacing: "0.15em", textTransform: "uppercase",
              }}>Material</div>
              <div style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 22, color: V.ink,
                fontStyle: "italic",
                fontWeight: 500, marginTop: 4,
              }}>UV-stable acrylic</div>
            </div>
            <div>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 10, color: V.inkMute,
                letterSpacing: "0.15em", textTransform: "uppercase",
              }}>NFC range</div>
              <div style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontSize: 22, color: V.ink,
                fontStyle: "italic",
                fontWeight: 500, marginTop: 4,
              }}>2 cm · ISO 14443</div>
            </div>
          </div>
        </div>

        {/* RIGHT — assembly portal */}
        <Portal height="80vh">
          <div style={{ position: "absolute", inset: 0, perspective: 1800 }}>
            <div style={{
              position: "absolute",
              left: "50%", top: "50%",
              transform: "translate(-50%, -50%)",
              width: slabWidth,
              height: slabHeight,
              transformStyle: "preserve-3d",
            }}>
              {/* Back panel — slides up from below */}
              <div style={{
                position: "absolute",
                inset: 0,
                borderRadius: 12,
                backgroundColor: V.paperRaised,
                border: "1px solid rgba(212, 175, 55, 0.4)",
                transform: `translate3d(0, ${(1 - frameSlideUp) * 200}px, -8px)`,
                opacity: frameSlideUp,
                boxShadow: "0 30px 60px -20px rgba(15,14,11,0.5)",
              }} />

              {/* Card — sits in middle layer */}
              <div style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                marginLeft: -cardWidth / 2,
                marginTop: -cardHeight / 2,
                opacity: cardEntry,
                transform: `translate3d(0, ${(1 - cardEntry) * -100}px, 0)`,
              }}>
                <RawCard
                  width={cardWidth}
                  glow={0.3 + sealLight * 0.6}
                />
              </div>

              {/* Front panel sections — top, bottom, with display window */}
              {/* Top label strip — slides down */}
              <div style={{
                position: "absolute",
                top: 0, left: 0, right: 0,
                height: "10%",
                backgroundColor: V.paperRaised,
                borderTopLeftRadius: 12,
                borderTopRightRadius: 12,
                borderBottom: "1px solid rgba(212, 175, 55, 0.4)",
                transform: `translate3d(0, ${(1 - frameSlideDown) * -120}px, 8px)`,
                opacity: frameSlideDown,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                padding: "0 8px",
              }}>
                <span style={{
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 11,
                  color: V.goldSoft,
                  letterSpacing: "0.1em",
                  padding: "1px 6px",
                  border: "1px solid rgba(212, 175, 55, 0.4)",
                  borderRadius: 999,
                  opacity: labelEngrave,
                }}>
                  MV001
                </span>
              </div>

              {/* Bottom label strip */}
              <div style={{
                position: "absolute",
                bottom: 0, left: 0, right: 0,
                height: "25%",
                backgroundColor: V.paperRaised,
                borderBottomLeftRadius: 12,
                borderBottomRightRadius: 12,
                borderTop: "1px solid rgba(212, 175, 55, 0.4)",
                transform: `translate3d(0, ${(1 - frameSlideDown) * 200}px, 8px)`,
                opacity: frameSlideDown,
                padding: "6px 10px",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 4,
              }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  opacity: labelEngrave,
                }}>
                  <span style={{
                    fontFamily: "'Geist Variable', system-ui, sans-serif",
                    fontSize: 14,
                    color: V.ink,
                    fontWeight: 500,
                  }}>
                    Holo Charizard #4
                  </span>
                  <span style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 12,
                    color: V.gold,
                    fontWeight: 600,
                  }}>
                    MV 9.5
                  </span>
                </div>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  opacity: labelEngrave,
                }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: 999,
                    backgroundColor: V.gold,
                  }} />
                  <span style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 9,
                    color: V.inkMute,
                    letterSpacing: "0.05em",
                  }}>
                    NFC · Tracked
                  </span>
                </div>
              </div>

              {/* Gold edge glow seal flash */}
              <div style={{
                position: "absolute",
                inset: -4,
                borderRadius: 14,
                border: `1px solid rgba(212, 175, 55, ${0.3 + sealLight * 0.6})`,
                boxShadow: `0 0 ${sealLight * 60}px rgba(212, 175, 55, ${sealLight * 0.5})`,
                opacity: edgesIn,
                pointerEvents: "none",
              }} />
            </div>
          </div>

          <div style={{
            position: "absolute",
            top: 24, left: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: V.goldSoft,
            letterSpacing: "0.3em",
            opacity: 0.85,
          }}>
            ◆ ASSEMBLY · MV-2026-0001
          </div>
          <div style={{
            position: "absolute",
            bottom: 24, right: 24,
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10, color: "rgba(212,175,55,0.55)",
            letterSpacing: "0.3em",
          }}>
            STATUS · {finalReveal > 0.5 ? "SEALED" : edgesIn > 0.5 ? "BONDING" : "ASSEMBLY"}
          </div>
        </Portal>
      </div>
    </section>
  );
}

/* =========================================================================
   ACT V — REGISTRY (final placement + CTA)
   The new slab takes its place in the vault.
   ========================================================================= */
function ActRegistry() {
  const ref = useRef(null);
  const p = useSectionProgress(ref);
  const cameraGlide = easeInOutCubic(range(p, 0.0, 0.6));
  const ctaReveal = easeOutCubic(range(p, 0.5, 0.9));
  const time = useIdleTime();

  return (
    <section ref={ref} style={{
      backgroundColor: V.paper,
      position: "relative",
      minHeight: "300vh",
    }}>
      <div style={{
        position: "sticky",
        top: 64,
        height: "calc(100vh - 64px)",
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}>
        <div style={{ marginBottom: 32 }}>
          <p style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 11, color: V.gold,
            letterSpacing: "0.3em", textTransform: "uppercase",
            fontWeight: 500, margin: 0, marginBottom: 18,
          }}>
            ── 05 / Registry
          </p>
          <h2 style={{
            fontFamily: "'Fraunces', Georgia, serif",
            fontStyle: "italic", fontWeight: 500,
            fontSize: "clamp(2.5rem, 5vw, 4rem)",
            lineHeight: 0.95, color: V.ink,
            margin: 0, marginBottom: 16,
            maxWidth: 800,
          }}>
            Returned to you.<br />Recorded for everyone.
          </h2>
        </div>

        <Portal height="55vh">
          <div style={{ position: "absolute", inset: 0, perspective: 1400, perspectiveOrigin: "50% 50%" }}>
            <Shelving side="left" cameraGlide={cameraGlide} />
            <Shelving side="right" cameraGlide={cameraGlide} />
          </div>

          {/* Hero slab arriving — flies in from behind, settles at centre */}
          <div style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}>
            <div style={{
              opacity: ctaReveal,
              transform: `translateY(${(1 - ctaReveal) * 30}px) scale(${lerp(0.6, 1, ctaReveal)})`,
              textAlign: "center",
            }}>
              <div style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontStyle: "italic",
                fontSize: 56,
                color: "rgba(255,255,255,0.95)",
                fontWeight: 500,
                textShadow: "0 0 40px rgba(0,0,0,0.6)",
                lineHeight: 1,
              }}>
                MV-2026-0001
              </div>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11,
                color: V.goldSoft,
                letterSpacing: "0.4em",
                textTransform: "uppercase",
                marginTop: 12,
              }}>
                ◆ Now in the registry
              </div>
            </div>
          </div>
        </Portal>

        {/* CTA below */}
        <div style={{
          marginTop: 40,
          textAlign: "center",
          opacity: ctaReveal,
          transform: `translateY(${(1 - ctaReveal) * 20}px)`,
        }}>
          <p style={{
            fontFamily: "'Geist Variable', system-ui, sans-serif",
            fontSize: 17, color: V.inkSoft,
            maxWidth: 540, margin: "0 auto 24px",
            lineHeight: 1.6,
          }}>
            Your slab returns by insured post. Its grade, photos, and
            transfer history live on the public registry — searchable by
            anyone, editable only by you.
          </p>
          <div style={{ display: "inline-flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <button style={{
              backgroundColor: V.ink, color: V.paper,
              border: "none", borderRadius: 999,
              padding: "14px 28px",
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 15, fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 8,
            }}>
              Submit a card →
            </button>
            <button style={{
              backgroundColor: "transparent",
              color: V.inkSoft,
              border: `1px solid ${V.line}`, borderRadius: 999,
              padding: "14px 28px",
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 15, fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: 8,
            }}>
              Browse the registry →
            </button>
          </div>
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
   HERO INTRO — sets the stage before Act I
   ========================================================================= */
function HeroIntro() {
  return (
    <section style={{
      backgroundColor: V.paper,
      paddingTop: 80,
      paddingBottom: 64,
    }}>
      <div style={{
        maxWidth: 1280,
        margin: "0 auto",
        padding: "0 24px",
      }}>
        <p style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 12, color: V.gold,
          letterSpacing: "0.25em", textTransform: "uppercase",
          fontWeight: 500, margin: 0, marginBottom: 24,
        }}>
          The Process · Five Stages
        </p>
        <h1 style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontStyle: "italic", fontWeight: 500,
          fontSize: "clamp(3rem, 7vw, 6rem)",
          lineHeight: 0.95, color: V.ink,
          margin: 0, marginBottom: 32,
          maxWidth: "85%",
        }}>
          From your hand<br />to the registry,<br />in fourteen days.
        </h1>
        <p style={{
          fontFamily: "'Geist Variable', system-ui, sans-serif",
          fontSize: 19, lineHeight: 1.6, color: V.inkSoft,
          margin: 0, maxWidth: 640,
        }}>
          Every card we receive passes through the same five stages.
          Same standards regardless of value. Scroll to follow one card —
          MV-2026-0001 — through every step.
        </p>
        <div style={{
          marginTop: 48,
          paddingTop: 32,
          borderTop: `1px solid ${V.line}`,
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 24,
        }}>
          {[
            { num: "01", label: "Submission" },
            { num: "02", label: "Receipt" },
            { num: "03", label: "Grading" },
            { num: "04", label: "Slabbing" },
            { num: "05", label: "Registry" },
          ].map((s) => (
            <div key={s.num}>
              <div style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11, color: V.gold,
                letterSpacing: "0.2em",
              }}>
                {s.num}
              </div>
              <div style={{
                fontFamily: "'Fraunces', Georgia, serif",
                fontStyle: "italic",
                fontSize: 22, color: V.ink,
                fontWeight: 500, marginTop: 6,
              }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================================
   HEADER + FOOTER (compressed — same as home)
   ========================================================================= */
function Header() {
  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 50,
      backgroundColor: V.paper,
      borderBottom: `1px solid ${V.line}`,
    }}>
      <div style={{
        maxWidth: 1280, margin: "0 auto",
        padding: "0 24px", height: 64,
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
          <span style={{ fontFamily: "'Geist Variable', system-ui, sans-serif", fontSize: 18, fontWeight: 700, color: V.ink }}>Mint</span>
          <span style={{ fontSize: 18, color: V.inkMute }}>·</span>
          <span style={{ fontFamily: "'Fraunces', Georgia, serif", fontStyle: "italic", fontSize: 18, fontWeight: 500, color: V.ink }}>Vault</span>
        </div>
        <nav style={{ display: "flex", gap: 24 }}>
          {["Grading ▾", "Vault Club", "Verify", "Technology", "Registry", "Journal"].map((l) => (
            <span key={l} style={{
              fontFamily: "'Geist Variable', system-ui, sans-serif",
              fontSize: 14, fontWeight: 500,
              color: l === "Technology" ? V.gold : V.inkSoft,
              cursor: "pointer",
            }}>{l}</span>
          ))}
        </nav>
        <button style={{
          backgroundColor: V.ink, color: V.paper, border: "none",
          borderRadius: 999, padding: "8px 20px",
          fontFamily: "'Geist Variable', system-ui, sans-serif",
          fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>
          Submit a card →
        </button>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer style={{
      backgroundColor: V.paperSunk,
      borderTop: `1px solid ${V.line}`,
      padding: "40px 24px",
    }}>
      <div style={{
        maxWidth: 1280, margin: "0 auto",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{
          fontFamily: "'Fraunces', Georgia, serif",
          fontStyle: "italic", fontSize: 18,
          color: V.inkMute, fontWeight: 500,
        }}>
          MintVault
        </span>
        <span style={{
          fontFamily: "'Geist Variable', system-ui, sans-serif",
          fontSize: 12, color: V.inkMute,
        }}>
          © 2026 Mint Vault UK Ltd · Company No. 17170013
        </span>
      </div>
    </footer>
  );
}

/* =========================================================================
   PAGE
   ========================================================================= */
export default function MintVaultHowItWorks() {
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
      <HeroIntro />
      <ActSubmission />
      <ActReceipt />
      <ActGrading />
      <ActSlabbing />
      <ActRegistry />
      <Footer />
    </div>
  );
}
