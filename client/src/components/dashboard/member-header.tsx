import { LogOut } from "lucide-react";

interface VaultClubMeMinimal {
  tier: string | null;
  status?: string | null;
  started_at?: string | null;
  renews_at?: string | null;
}

interface AuthMeMinimal {
  display_name: string | null;
  email: string;
}

interface Props {
  me: { email: string };
  authMe: AuthMeMinimal | null;
  vcMe: VaultClubMeMinimal | null | undefined;
  isMember: boolean;
  onLogout: () => void;
}

function fmtMonthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function MemberHeader({ me, authMe, vcMe, isMember, onLogout }: Props) {
  const firstName =
    authMe?.display_name?.split(" ")[0] ||
    me.email.split("@")[0] ||
    "there";
  const avatarSource = (authMe?.display_name || me.email).trim();
  const avatarLetter = (avatarSource[0] || "?").toUpperCase();

  if (isMember) {
    const memberSince = fmtMonthYear(vcMe?.started_at);
    const renews = fmtDate(vcMe?.renews_at);
    return (
      <div className="bg-[#0F0F0F] border-b-[1.5px] border-[#D4AF37] rounded-xl px-5 py-5 mb-[480px]">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold tracking-[0.15em] text-[#D4AF37] uppercase mb-1.5">
              Vault Club
            </p>
            <h1 className="text-xl font-medium text-[#FAF9F5] leading-tight">
              Welcome back, <span className="text-[#D4AF37]">{firstName}</span>
            </h1>
            {(memberSince || renews) && (
              <p className="text-[11px] text-[#888888] mt-1.5">
                {memberSince && <>Member since {memberSince}</>}
                {memberSince && renews && " · "}
                {renews && <>Renews {renews}</>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {/* SILVER MEMBER pill */}
            <div className="inline-flex items-center gap-1.5 border border-[#D4AF37]/60 bg-[#D4AF37]/10 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4AF37] animate-pulse" />
              <span className="text-[9px] font-bold tracking-[0.12em] text-[#D4AF37] uppercase whitespace-nowrap">
                Silver Member
              </span>
            </div>
            {/* Avatar */}
            <div className="w-7 h-7 rounded-full bg-[#D4AF37] flex items-center justify-center text-[#0F0F0F] text-xs font-bold">
              {avatarLetter}
            </div>
            <button
              onClick={onLogout}
              className="text-[10px] text-[#888888] hover:text-[#D4AF37] transition-colors flex items-center gap-1"
              aria-label="Log out"
            >
              <LogOut size={11} />
              <span className="hidden sm:inline">Log out</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Non-member view
  return (
    <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-7 h-7 rounded-full bg-[#D4AF37] flex items-center justify-center text-[#0F0F0F] text-xs font-bold flex-shrink-0">
          {avatarLetter}
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-medium text-[#1A1A1A] leading-tight">
            Welcome back, <span className="text-[#B8960C]">{firstName}</span>
          </h1>
          <p className="text-xs text-[#888888] truncate">{me.email}</p>
        </div>
      </div>
      <button
        onClick={onLogout}
        className="text-xs text-[#888888] hover:text-[#666666] transition-colors flex items-center gap-1.5 flex-shrink-0"
        aria-label="Log out"
      >
        <LogOut size={13} />
        Log out
      </button>
    </div>
  );
}
