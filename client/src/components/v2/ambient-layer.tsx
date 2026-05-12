import { useEffect, useState } from "react";

/**
 * AmbientLayer — page-level fixed warm glow.
 *
 * Two soft gold radial gradients drifting in slow opposing arcs (~60s
 * cycles), heavily blurred, very low total opacity (5-8%). Sits behind
 * all section content via z-index. Visible only where sections have
 * transparent backgrounds — e.g. hero — so the rest of the page stays
 * exactly as it is.
 *
 * Mounting pattern: render inside a wrapper that has `position: relative`
 * so the AmbientLayer's negative z-index stacks against that container's
 * stacking context (rather than escaping behind the page bg).
 *
 * Honors `prefers-reduced-motion` by freezing the gradient positions.
 */

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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

export default function AmbientLayer() {
  const time = useIdleTime();

  // Two large radial gradients drifting in opposing arcs.
  // ~30s cycle — visible warmth, the page never feels static.
  const x1 = 30 + Math.sin(time * 0.10) * 22;
  const y1 = 25 + Math.cos(time * 0.04) * 10;
  const x2 = 70 + Math.cos(time * 0.08) * 18;
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
      {/* Warm gold drift — top-left arc */}
      <div
        style={{
          position: "absolute",
          top: `${y1 - 35}%`,
          left: `${x1 - 35}%`,
          width: "70%",
          height: "70%",
          background:
            "radial-gradient(circle, rgba(212, 175, 55, 0.18) 0%, rgba(212, 175, 55, 0.06) 30%, transparent 60%)",
          filter: "blur(60px)",
          willChange: "transform",
        }}
      />
      {/* Warm bronze drift — bottom-right arc */}
      <div
        style={{
          position: "absolute",
          top: `${y2 - 30}%`,
          left: `${x2 - 30}%`,
          width: "60%",
          height: "60%",
          background:
            "radial-gradient(circle, rgba(184, 150, 12, 0.13) 0%, rgba(184, 150, 12, 0.05) 30%, transparent 60%)",
          filter: "blur(50px)",
          willChange: "transform",
        }}
      />
    </div>
  );
}
