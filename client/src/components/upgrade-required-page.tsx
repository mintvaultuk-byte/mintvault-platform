import { Link } from "wouter";
import { Shield, ArrowLeft } from "lucide-react";

interface Props {
  minTier?: "bronze" | "silver" | "gold";
  currentTier?: string | null;
  featureName?: string;
}

const TIER_LABELS: Record<string, string> = {
  bronze: "Bronze Vault",
  silver: "Silver Vault",
  gold: "Gold Vault",
};

export default function UpgradeRequiredPage({ minTier = "bronze", currentTier, featureName }: Props) {
  const needed = TIER_LABELS[minTier] || "Vault Club";
  const isUpgrade = currentTier && currentTier !== minTier;

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-16 bg-[#FAFAF8]">
      <div className="max-w-md w-full border border-[#D4AF37]/30 bg-white rounded-2xl p-8 shadow-sm text-center">
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
          style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
        >
          <Shield size={28} className="text-[#1A1400]" />
        </div>

        <h1
          className="text-2xl font-black text-[#1A1A1A] mb-3"
         
        >
          {isUpgrade ? "Upgrade Required" : "Vault Club Required"}
        </h1>

        <p className="text-sm text-[#666666] mb-2">
          {featureName
            ? <><strong className="text-[#1A1A1A]">{featureName}</strong> requires</>
            : "This feature requires"
          }{" "}
          a <strong className="text-[#B8960C]">{needed}</strong> membership{isUpgrade ? " or higher" : ""}.
        </p>

        {isUpgrade && currentTier && (
          <p className="text-xs text-[#999999] mb-6">
            You're currently on {TIER_LABELS[currentTier] || currentTier}. Upgrade to unlock this feature.
          </p>
        )}
        {!isUpgrade && (
          <p className="text-xs text-[#999999] mb-6">
            Join Vault Club to unlock discounts, AI credits, your own Showroom, and more.
          </p>
        )}

        <Link href="/vault-club">
          <button
            className="w-full py-3 rounded-xl font-bold text-sm text-[#1A1400] mb-4 transition-all active:scale-95"
            style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
          >
            {isUpgrade ? "Upgrade Vault Club →" : "View Vault Club →"}
          </button>
        </Link>

        <Link href="/" className="flex items-center justify-center gap-1.5 text-xs text-[#AAAAAA] hover:text-[#666666] transition-colors">
          <ArrowLeft size={12} />
          Back to home
        </Link>
      </div>
    </div>
  );
}
