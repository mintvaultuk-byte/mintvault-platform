import { Link } from "wouter";
import { Lock } from "lucide-react";

/**
 * AuthRequiredPage — shown whenever a protected page is visited while logged out.
 * Never shows a raw 401 to the user.
 */
export default function AuthRequiredPage({ currentPath }: { currentPath?: string }) {
  const next = currentPath ? `?next=${encodeURIComponent(currentPath)}` : "";
  return (
    <div className="min-h-[60vh] bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-[#D4AF37]/30 shadow-lg p-8 text-center">
        <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-5">
          <Lock size={22} className="text-[#D4AF37]" />
        </div>
        <h2
          className="text-xl font-black text-[#1A1A1A] mb-2"
         
        >
          Sign in to continue
        </h2>
        <p className="text-sm text-[#888888] mb-7">
          You need to be logged in to view this page.
        </p>
        <div className="flex flex-col gap-3">
          <Link href={`/login${next}`}>
            <button
              className="w-full py-3 rounded-xl font-bold text-sm text-[#1A1400] transition-all"
              style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
            >
              Log In
            </button>
          </Link>
          <Link href={`/signup${next}`}>
            <button className="w-full py-3 rounded-xl font-bold text-sm text-[#B8960C] border border-[#D4AF37]/40 hover:bg-[#D4AF37]/5 transition-all">
              Create Account
            </button>
          </Link>
        </div>
        <p className="mt-6 text-xs text-[#AAAAAA]">
          <Link href="/" className="hover:text-[#B8960C] transition-colors">
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
