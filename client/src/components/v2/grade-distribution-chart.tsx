/**
 * GradeDistributionChart — public Population Registry analytics card.
 *
 * Dark glass panel with metallic gold bars, rendered from REAL live data via
 * /api/public/grade-distribution. Whole grades 1–10 always show (count 0 = no
 * bar); half grades appear only when real certs exist at them. If the registry
 * is empty (total 0) the whole panel hides — no placeholder bars, no fabrication.
 *
 * Rendered with styled divs (no chart lib): the metallic vertical-gradient bars,
 * gold-gradient border + sheen, and per-bar value labels all need pixel control
 * that a generic chart lib can't give. No background image — sits on the vault page.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";

interface GradeDatum {
  grade: number;
  count: number;
}

// Metallic gold — horizontal sheen band so each bar reads like a polished
// cylinder: darker left edge, bright highlight just left of centre, mid body,
// dark right edge. Layered over a faint vertical top→bottom fall-off.
const BAR_METAL =
  "linear-gradient(to bottom, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 18%)," +
  "linear-gradient(to right, #9A7B1C 0%, #E9CB5F 26%, #F7E89B 40%, #D9B43E 58%, #B5901F 80%, #876A18 100%)";
const BAR_METAL_HALF =
  "linear-gradient(to bottom, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 18%)," +
  "linear-gradient(to right, rgba(154,123,28,0.55) 0%, rgba(233,203,95,0.6) 26%, rgba(247,232,155,0.6) 40%, rgba(217,180,62,0.55) 58%, rgba(181,144,31,0.55) 80%, rgba(135,106,24,0.55) 100%)";

// Gold-gradient text (heading + stat numbers).
const goldText: React.CSSProperties = {
  background: "linear-gradient(135deg, #F7E89B 0%, #D4AF37 45%, #B8960C 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  WebkitTextFillColor: "transparent",
  color: "transparent",
};

/** Smallest "nice" axis step (1/2/5 × 10ⁿ) giving ~4 integer ticks. */
function niceStep(max: number): number {
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const frac = raw / pow;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return Math.max(1, niceFrac * pow);
}

export default function GradeDistributionChart() {
  const [data, setData] = useState<GradeDatum[] | null>(null);
  const [total, setTotal] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/public/grade-distribution")
      .then((r) => r.json())
      .then((d) => {
        setData(Array.isArray(d.distribution) ? d.distribution : []);
        setTotal(Number(d.total) || 0);
      })
      .catch(() => {}); // fail silently — panel stays hidden
  }, []);

  const { ticks, scaleMax, avgGrade } = useMemo(() => {
    const rows = data ?? [];
    const maxCount = Math.max(1, ...rows.map((d) => d.count));
    const step = niceStep(maxCount);
    let top = step * Math.ceil(maxCount / step);
    if (top <= maxCount) top += step; // guarantee headroom for the value label
    const out: number[] = [];
    for (let t = 0; t <= top; t += step) out.push(t);

    const weighted = rows.reduce((s, d) => s + d.grade * d.count, 0);
    const counted = rows.reduce((s, d) => s + d.count, 0);
    const avg = counted > 0 ? weighted / counted : 0;
    return { ticks: out, scaleMax: top, avgGrade: avg };
  }, [data]);

  // Empty / not-yet-loaded → render nothing (no empty chart).
  if (!data || total === 0) return null;

  const PLOT_H = 220;

  return (
    <div
      className="mb-10 w-full"
      style={{
        position: "relative",
        borderRadius: 16,
        // Gold-gradient hairline border: panel fill (padding-box) over a gold
        // gradient (border-box), brighter top-left → darker bottom-right.
        border: "1px solid transparent",
        background:
          "linear-gradient(rgba(15,14,12,0.82), rgba(15,14,12,0.82)) padding-box," +
          "linear-gradient(135deg, rgba(247,232,155,0.85) 0%, rgba(212,175,55,0.5) 40%, rgba(120,96,20,0.35) 100%) border-box",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        boxShadow: "0 0 40px rgba(212,175,55,0.12), 0 20px 50px rgba(0,0,0,0.45)",
        padding: "28px 32px 24px",
        overflow: "hidden",
      }}
    >
      {/* Diagonal sheen across the top-left */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          borderRadius: 16,
          background: "linear-gradient(135deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 38%)",
        }}
      />

      {/* Header */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 28,
        }}
      >
        <h3 className="font-display" style={{ ...goldText, fontSize: 28, fontWeight: 600, margin: 0, lineHeight: 1 }}>
          Grade distribution
        </h3>
        <Link
          href="/registry"
          className="no-underline font-mono-v2"
          style={{
            color: "#D4AF37",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          Population registry &rarr;
        </Link>
      </div>

      {/* Body: chart + side stats */}
      <div style={{ position: "relative", display: "flex", gap: 28, alignItems: "stretch" }}>
        {/* Chart block */}
        <div style={{ flex: 1, display: "flex", gap: 10 }}>
          {/* Rotated Y-axis label */}
          <div style={{ display: "flex", alignItems: "center", height: PLOT_H }}>
            <span
              className="font-mono-v2"
              style={{
                writingMode: "vertical-rl",
                transform: "rotate(180deg)",
                color: "#8a8680",
                fontSize: 10,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
              }}
            >
              Certs graded
            </span>
          </div>

          {/* Count scale */}
          <div style={{ position: "relative", width: 22, height: PLOT_H, flexShrink: 0 }}>
            {ticks.map((t) => (
              <span
                key={t}
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: `${(t / scaleMax) * 100}%`,
                  transform: "translateY(50%)",
                  color: "#6a6660",
                  fontSize: 11,
                  lineHeight: 1,
                }}
              >
                {t}
              </span>
            ))}
          </div>

          {/* Plot + x-axis */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ position: "relative", height: PLOT_H }}>
              {/* Horizontal gridlines */}
              {ticks.map((t) => (
                <div
                  key={t}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: `${(t / scaleMax) * 100}%`,
                    borderTop: "1px solid rgba(212,175,55,0.12)",
                  }}
                />
              ))}

              {/* Bars */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 8,
                  paddingLeft: 2,
                  paddingRight: 2,
                }}
              >
                {data.map((d) => {
                  const isHalf = !Number.isInteger(d.grade);
                  const heightPct = (d.count / scaleMax) * 100;
                  const isHot = hovered === d.grade;
                  return (
                    <div
                      key={d.grade}
                      style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", position: "relative" }}
                      onMouseEnter={() => setHovered(d.grade)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      {/* Value label above the bar */}
                      <span
                        className="font-mono-v2"
                        style={{
                          position: "absolute",
                          bottom: `calc(${Math.max(heightPct, 0)}% + 5px)`,
                          left: "50%",
                          transform: "translateX(-50%)",
                          color: d.count > 0 ? "#E8C84E" : "#5a564e",
                          fontSize: 11,
                          fontWeight: 600,
                          lineHeight: 1,
                          pointerEvents: "none",
                        }}
                      >
                        {d.count}
                      </span>
                      <div
                        style={{
                          width: "100%",
                          height: `${heightPct}%`,
                          minHeight: d.count > 0 ? 2 : 0,
                          background: isHalf ? BAR_METAL_HALF : BAR_METAL,
                          borderTopLeftRadius: 2,
                          borderTopRightRadius: 2,
                          boxShadow: d.count > 0 ? "0 0 12px rgba(212,175,55,0.3)" : "none",
                          filter: isHot ? "brightness(1.12)" : "none",
                          transition: "filter 0.15s ease",
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* X-axis grade labels */}
            <div style={{ display: "flex", gap: 8, paddingLeft: 2, paddingRight: 2, marginTop: 8 }}>
              {data.map((d) => (
                <span
                  key={d.grade}
                  className="font-mono-v2"
                  style={{
                    flex: 1,
                    textAlign: "center",
                    color: hovered === d.grade ? "#D4AF37" : "#8a8680",
                    fontSize: 12,
                    lineHeight: 1,
                    transition: "color 0.15s ease",
                  }}
                >
                  {d.grade}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Side stats */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 14,
            flexShrink: 0,
            width: 120,
          }}
        >
          {[
            { label: "Avg grade", value: avgGrade.toFixed(1) },
            { label: "Total certified", value: total.toLocaleString() },
          ].map((s) => (
            <div
              key={s.label}
              style={{
                borderRadius: 12,
                border: "0.5px solid rgba(212,175,55,0.25)",
                background: "rgba(212,175,55,0.04)",
                padding: "14px 16px",
              }}
            >
              <div className="font-display" style={{ ...goldText, fontSize: 30, fontWeight: 600, lineHeight: 1 }}>
                {s.value}
              </div>
              <div
                className="font-mono-v2"
                style={{
                  color: "#8a8680",
                  fontSize: 10,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  marginTop: 7,
                }}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
