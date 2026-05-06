/**
 * SectionEyebrow — v2 roman-numeral section marker.
 *
 * Mirrors the pattern used across home-v2 (e.g. "I · Grading Tiers",
 * "II · Infrastructure"). JetBrains Mono, white-on-vault, uppercase,
 * tight tracking. Always rendered at section level on transparent
 * .frost-* sections — gold disappeared against the gold deposit boxes
 * in the v524 vault image, so we use solid white with the inherited
 * .vault-page text-shadow for legibility.
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
      className={`font-mono-v2 text-xs md:text-sm uppercase tracking-[0.25em] ${className}`}
      style={{ color: "#ffffff" }}
    >
      {numeral} &middot; {label}
    </p>
  );
}
