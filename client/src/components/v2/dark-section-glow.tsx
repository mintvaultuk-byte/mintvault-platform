import { useEffect, useState } from "react";

/**
 * DarkSectionGlow — breathing radial gold ambience for dark-bg sections.
 *
 * Mounted absolutely inside any dark section (e.g. Section C grading
 * tiers, Section F final CTA on the home page). Slow sine-wave breathing
 * on opacity (0.06 → 0.10), heavily blurred, pointer-events disabled.
 *
 * Parent contract: must have `position: relative` and ideally
 * `overflow: hidden` so the blurred gradient is clipped to the section.
 *
 * Honors `prefers-reduced-motion` — when set, the breathing freezes at
 * mid-opacity rather than oscillating.
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

export default function DarkSectionGlow() {
  const time = useIdleTime();
  // Slow breath: 0..1, full cycle ~42s at 0.005 increment * 0.15 frequency.
  const breathe = (Math.sin(time * 0.15) + 1) / 2;
  const alpha = 0.12 + breathe * 0.10;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "30%",
          left: "50%",
          width: "70%",
          height: "60%",
          transform: "translate(-50%, -50%)",
          background: `radial-gradient(ellipse, rgba(212, 175, 55, ${alpha}) 0%, rgba(212, 175, 55, 0.02) 35%, transparent 70%)`,
          filter: "blur(60px)",
          willChange: "opacity",
        }}
      />
    </div>
  );
}
