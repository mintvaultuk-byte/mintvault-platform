/**
 * CardPopulationChart — per-card grade distribution (search result).
 *
 * Presentational only: the parent passes a distribution + total for ONE card,
 * fetched from /api/public/population. Reuses the gold metallic-bar glass-panel
 * style. Shows "N graded" for that card. Never displays a global aggregate.
 */
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

interface GradeDatum {
  grade: number;
  count: number;
}

interface Props {
  cardName: string;
  setName?: string | null;
  distribution: GradeDatum[];
  total: number;
}

// Metallic gold — horizontal sheen band so each bar reads like a polished
// cylinder: darker left edge, bright highlight just left of centre, dark right.
const BAR_METAL =
  "linear-gradient(to bottom, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 18%)," +
  "linear-gradient(to right, #9A7B1C 0%, #E9CB5F 26%, #F7E89B 40%, #D9B43E 58%, #B5901F 80%, #876A18 100%)";
const BAR_METAL_HALF =
  "linear-gradient(to bottom, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 18%)," +
  "linear-gradient(to right, rgba(154,123,28,0.55) 0%, rgba(233,203,95,0.6) 26%, rgba(247,232,155,0.6) 40%, rgba(217,180,62,0.55) 58%, rgba(181,144,31,0.55) 80%, rgba(135,106,24,0.55) 100%)";

const goldText: CSSProperties = {
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

export default function CardPopulationChart({ cardName, setName, distribution, total }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);

  const { ticks, scaleMax } = useMemo(() => {
    const maxCount = Math.max(1, ...distribution.map((d) => d.count));
    const step = niceStep(maxCount);
    let top = step * Math.ceil(maxCount / step);
    if (top <= maxCount) top += step; // headroom for the value label
    const out: number[] = [];
    for (let t = 0; t <= top; t += step) out.push(t);
    return { ticks: out, scaleMax: top };
  }, [distribution]);

  const PLOT_H = 150;

  return (
    <div
      style={{
        position: "relative",
        borderRadius: 16,
        border: "1px solid transparent",
        background:
          "linear-gradient(rgba(15,14,12,0.82), rgba(15,14,12,0.82)) padding-box," +
          "linear-gradient(135deg, rgba(247,232,155,0.85) 0%, rgba(212,175,55,0.5) 40%, rgba(120,96,20,0.35) 100%) border-box",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        boxShadow: "0 0 40px rgba(212,175,55,0.12), 0 20px 50px rgba(0,0,0,0.45)",
        padding: "24px 28px 20px",
        overflow: "hidden",
      }}
    >
      {/* Diagonal sheen */}
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

      {/* Header: card identity + N graded */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 22,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3
            className="font-display"
            style={{
              ...goldText,
              fontSize: 20,
              fontWeight: 600,
              margin: 0,
              lineHeight: 1.1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {cardName}
          </h3>
          {setName && (
            <p
              className="font-mono-v2"
              style={{ color: "#8a8680", fontSize: 11, letterSpacing: "0.08em", margin: "5px 0 0" }}
            >
              {setName}
            </p>
          )}
        </div>
        <div
          className="font-mono-v2"
          style={{
            color: "#D4AF37",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {total.toLocaleString()} graded
        </div>
      </div>

      {/* Plot */}
      <div style={{ position: "relative", display: "flex", gap: 10 }}>
        {/* Count scale */}
        <div style={{ position: "relative", width: 18, height: PLOT_H, flexShrink: 0 }}>
          {ticks.map((t) => (
            <span
              key={t}
              style={{
                position: "absolute",
                right: 0,
                bottom: `${(t / scaleMax) * 100}%`,
                transform: "translateY(50%)",
                color: "#6a6660",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              {t}
            </span>
          ))}
        </div>

        {/* Bars + x-axis */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ position: "relative", height: PLOT_H }}>
            {/* Gridlines */}
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
                gap: 6,
                paddingLeft: 2,
                paddingRight: 2,
              }}
            >
              {distribution.map((d) => {
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
                    <span
                      className="font-mono-v2"
                      style={{
                        position: "absolute",
                        bottom: `calc(${Math.max(heightPct, 0)}% + 4px)`,
                        left: "50%",
                        transform: "translateX(-50%)",
                        color: d.count > 0 ? "#E8C84E" : "#5a564e",
                        fontSize: 10,
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
          <div style={{ display: "flex", gap: 6, paddingLeft: 2, paddingRight: 2, marginTop: 7 }}>
            {distribution.map((d) => (
              <span
                key={d.grade}
                className="font-mono-v2"
                style={{
                  flex: 1,
                  textAlign: "center",
                  color: hovered === d.grade ? "#D4AF37" : "#8a8680",
                  fontSize: 11,
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
    </div>
  );
}
