/**
 * GradeDistributionChart — public Population Registry analytics card.
 *
 * Dark glass panel with gold bars, rendered from REAL live data via
 * /api/public/grade-distribution. Whole grades 1–10 always show (count 0 = no
 * bar); half grades appear only when real certs exist at them. If the registry
 * is empty (total 0) the whole panel hides — no placeholder bars, no fabrication.
 *
 * Styled divs (no chart lib) so the gold glow, half-grade tint, and custom
 * tooltip match the reference exactly. No background image — sits on the vault page.
 */
import { useEffect, useMemo, useState } from "react";

interface GradeDatum {
  grade: number;
  count: number;
}

const GOLD = "#D4AF37";
const GOLD_HALF = "rgba(212,175,55,0.45)";

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

  const { ticks, scaleMax } = useMemo(() => {
    const maxCount = Math.max(1, ...(data ?? []).map((d) => d.count));
    const step = niceStep(maxCount);
    const top = step * Math.ceil(maxCount / step);
    const out: number[] = [];
    for (let t = 0; t <= top; t += step) out.push(t);
    return { ticks: out, scaleMax: top };
  }, [data]);

  // Empty / not-yet-loaded → render nothing (no empty chart).
  if (!data || total === 0) return null;

  return (
    <div
      className="mb-10 w-full"
      style={{
        background: "rgba(18,17,14,0.78)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: "0.5px solid rgba(212,175,55,0.4)",
        borderRadius: 12,
        padding: "28px 32px",
      }}
    >
      {/* Eyebrow + heading */}
      <p
        className="font-mono-v2"
        style={{ color: GOLD, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}
      >
        Grade Distribution
      </p>
      <h3 className="font-display" style={{ color: "#f0ede8", fontSize: 20, margin: 0, marginBottom: 24 }}>
        {total.toLocaleString()} certified card{total !== 1 ? "s" : ""} by grade
      </h3>

      {/* Plot: left count scale + bar area with horizontal gridlines */}
      <div style={{ display: "flex", gap: 12 }}>
        {/* Y-axis count scale */}
        <div
          style={{
            position: "relative",
            width: 28,
            height: 200,
            flexShrink: 0,
          }}
        >
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

        {/* Bar area */}
        <div style={{ flex: 1 }}>
          <div style={{ position: "relative", height: 200 }}>
            {/* Horizontal gridlines */}
            {ticks.map((t) => (
              <div
                key={t}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: `${(t / scaleMax) * 100}%`,
                  borderTop: "1px solid rgba(212,175,55,0.08)",
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
                paddingLeft: 4,
                paddingRight: 4,
              }}
            >
              {data.map((d) => {
                const isHalf = !Number.isInteger(d.grade);
                const heightPct = (d.count / scaleMax) * 100;
                return (
                  <div
                    key={d.grade}
                    style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", position: "relative" }}
                    onMouseEnter={() => setHovered(d.grade)}
                    onMouseLeave={() => setHovered(null)}
                  >
                    {/* Tooltip */}
                    {hovered === d.grade && (
                      <div
                        style={{
                          position: "absolute",
                          bottom: `calc(${Math.max(heightPct, 0)}% + 8px)`,
                          left: "50%",
                          transform: "translateX(-50%)",
                          background: "#1a1812",
                          border: `0.5px solid rgba(212,175,55,0.5)`,
                          borderRadius: 6,
                          padding: "5px 9px",
                          color: "#f0ede8",
                          fontSize: 11,
                          whiteSpace: "nowrap",
                          pointerEvents: "none",
                          zIndex: 10,
                          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
                        }}
                      >
                        Grade {d.grade} &middot; {d.count} cert{d.count !== 1 ? "s" : ""}
                      </div>
                    )}
                    <div
                      style={{
                        width: "100%",
                        height: `${heightPct}%`,
                        background: isHalf ? GOLD_HALF : GOLD,
                        borderTopLeftRadius: 3,
                        borderTopRightRadius: 3,
                        boxShadow: d.count > 0 ? "0 0 12px rgba(212,175,55,0.25)" : "none",
                        transition: "filter 0.15s ease",
                        filter: hovered === d.grade ? "brightness(1.15)" : "none",
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* X-axis grade labels */}
          <div style={{ display: "flex", gap: 8, paddingLeft: 4, paddingRight: 4, marginTop: 8 }}>
            {data.map((d) => (
              <span
                key={d.grade}
                style={{ flex: 1, textAlign: "center", color: "#8a8680", fontSize: 12, lineHeight: 1 }}
              >
                {d.grade}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
