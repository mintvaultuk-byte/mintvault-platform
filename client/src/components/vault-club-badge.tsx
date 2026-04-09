import { Shield, ShieldCheck } from "lucide-react";

type VaultClubTier = "bronze" | "silver" | "gold" | null;

interface Props {
  tier: VaultClubTier;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
}

const TIER_COLOURS: Record<string, string> = {
  bronze: "#CD7F32",
  silver: "#C0C0C0",
  gold: "#D4AF37",
};

const TIER_LABELS: Record<string, string> = {
  bronze: "Bronze Vault",
  silver: "Silver Vault",
  gold: "Gold Vault",
};

const SIZE_MAP = {
  sm: 12,
  md: 16,
  lg: 22,
};

export default function VaultClubBadge({ tier, size = "md", showLabel = false }: Props) {
  if (!tier) return null;

  const colour = TIER_COLOURS[tier];
  const px = SIZE_MAP[size];
  const Icon = tier === "gold" ? ShieldCheck : Shield;

  return (
    <span
      className="inline-flex items-center gap-1"
      title={TIER_LABELS[tier]}
    >
      <Icon
        size={px}
        style={{ color: colour }}
        strokeWidth={2}
      />
      {showLabel && (
        <span
          className="font-semibold"
          style={{
            color: colour,
            fontSize: size === "sm" ? 10 : size === "md" ? 12 : 14,
          }}
        >
          {TIER_LABELS[tier]}
        </span>
      )}
    </span>
  );
}
