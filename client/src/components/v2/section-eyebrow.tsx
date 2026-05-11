/**
 * SectionEyebrow — v2 roman-numeral section marker.
 *
 * Mirrors the pattern used across home-v2 (e.g. "I · Grading Tiers",
 * "II · Infrastructure"). JetBrains Mono, gold (#FFCB05 — the v2-gold
 * standard used for SILVER MEMBER badges, gold borders, etc.), uppercase,
 * tight tracking. The .no-text-shadow class strips the .vault-page
 * cascade shadow so gold reads cleanly against the v532 dark scrim
 * baked into the site-wide vault background.
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
      className={`font-mono-v2 text-xs md:text-sm uppercase tracking-[0.25em] no-text-shadow ${className}`}
      style={{ color: "#FFCB05" }}
    >
      {numeral} &middot; {label}
    </p>
  );
}
