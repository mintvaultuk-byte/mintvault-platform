/**
 * SectionEyebrow — v2 roman-numeral section marker.
 *
 * Mirrors the pattern used across home-v2 (e.g. "I · Grading Tiers",
 * "II · Infrastructure"). JetBrains Mono, gold, uppercase, tight tracking.
 * Pass a `onDark` prop for dark-panel sections where the gold needs to pop
 * against ink; default styling is tuned for paper backgrounds.
 */
export default function SectionEyebrow({
  numeral,
  label,
  className = "",
}: {
  numeral: string;
  label: string;
  className?: string;
}) {
  return (
    <p
      className={`font-mono-v2 text-[10px] uppercase tracking-[0.25em] ${className}`}
      style={{ color: "var(--v2-gold)" }}
    >
      {numeral} &middot; {label}
    </p>
  );
}
