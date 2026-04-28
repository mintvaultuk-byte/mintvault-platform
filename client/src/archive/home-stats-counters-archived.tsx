/**
 * ARCHIVED — original homepage stats trio (cards graded / sets represented /
 * average grade) plus the CountUp animated-counter helper. Removed from
 * client/src/pages/home.tsx in favour of a founding-members CTA + 3-step
 * process strip (see same file, Section B).
 *
 * Reason for removal: pre-launch counters reveal low volume and undermine
 * trust. PSA / Beckett / SGC don't run public counters; we shouldn't either.
 * Replacement is permanent — no plan to reintroduce a counter at any
 * threshold. Kept here verbatim so the implementation can be restored if
 * the policy ever changes.
 *
 * NOT IMPORTED OR USED. Lives outside the build's import graph because the
 * archive directory has no entry point.
 *
 * Last live in production: 2026-04-27.
 */

import { useEffect, useRef, useState } from "react";

// ── Animated counter ───────────────────────────────────────────────────────
export function CountUp({ end, decimals = 0, duration = 1800 }: { end: number; decimals?: number; duration?: number }) {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const start = performance.now();
          function tick(now: number) {
            const progress = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setValue(eased * end);
            if (progress < 1) requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end, duration]);

  return <span ref={ref}>{value.toFixed(decimals)}</span>;
}

// ── Original stats trio JSX (verbatim from home.tsx Section B, pre-removal) ─
//
// Was rendered with these locals:
//   const totalGraded = stats?.total_graded ?? 132;
//   const uniqueSets  = stats?.unique_sets ?? 71;     // STILL USED ELSEWHERE
//   const avgGrade    = stats?.avg_grade ?? 8.9;
//
// Restore by re-inserting the JSX block below into home.tsx and re-adding
// the `totalGraded` and `avgGrade` locals.
export function ArchivedHomepageStatsTrio({
  totalGraded, uniqueSets, avgGrade,
}: { totalGraded: number; uniqueSets: number; avgGrade: number }) {
  return (
    <div className="grid grid-cols-3 gap-6 md:gap-12 mb-12 md:mb-16 text-center">
      {[
        { value: totalGraded, label: "cards graded", decimals: 0 },
        { value: uniqueSets, label: "sets represented", decimals: 0 },
        { value: avgGrade, label: "average grade", decimals: 1 },
      ].map((stat) => (
        <div key={stat.label}>
          <p className="font-display italic font-medium text-3xl md:text-5xl" style={{ color: "var(--v2-ink)" }}>
            <CountUp end={stat.value} decimals={stat.decimals} />
          </p>
          <p className="font-body text-[10px] md:text-xs uppercase tracking-widest mt-2" style={{ color: "var(--v2-ink-mute)" }}>
            {stat.label}
          </p>
        </div>
      ))}
    </div>
  );
}
