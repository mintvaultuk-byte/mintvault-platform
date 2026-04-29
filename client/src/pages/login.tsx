import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Mail } from "lucide-react";
import SeoHead from "@/components/seo-head";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const magicMutation = useMutation({
    mutationFn: async (addr: string) => {
      const res = await apiRequest("POST", "/api/auth/magic-link", { email: addr });
      return res.json();
    },
    onSuccess: () => setSent(true),
    onError: () => setError("Failed to send link. Please try again."),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    magicMutation.mutate(email.trim());
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
      <SeoHead
        title="Sign In | MintVault UK"
        description="Sign in to MintVault with a one-click email link. No password required."
        canonical="https://mintvaultuk.com/login"
      />
      <div className="w-full max-w-md rounded-2xl overflow-hidden shadow-xl bg-[#0A0A0A] p-8 md:p-10">
        <div className="w-10 h-10 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mb-5 mx-auto">
          <Mail size={18} className="text-[#D4AF37]" />
        </div>
        <h1 className="text-2xl font-black text-white mb-2 text-center">Sign In</h1>
        <p className="text-[#888888] text-sm mb-6 text-center">
          Enter your email and we'll send you a one-click sign-in link.
        </p>

        {sent ? (
          <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-xl p-4 text-sm text-emerald-400">
            Link sent! Check your inbox and click it to sign in.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white placeholder:text-[#555555] focus:outline-none focus:border-[#D4AF37] transition-colors"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={magicMutation.isPending}
              className="w-full py-3 rounded-xl text-sm font-bold text-[#1A1400] disabled:opacity-60 transition-all flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
            >
              {magicMutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Sending…</> : "Send Login Link"}
            </button>
          </form>
        )}

        <p className="text-xs text-[#666666] mt-6 text-center leading-relaxed">
          No password needed. The link is valid for 24 hours and can only be used once.
        </p>

        <div className="border-t border-[#333333] my-6" />

        <div className="space-y-2 text-center">
          <Link href="/signup" className="block text-xs text-[#888888] hover:text-[#D4AF37] transition-colors">
            New here? Create your account →
          </Link>
          <Link href="/forgot-password" className="block text-xs text-[#888888] hover:text-[#D4AF37] transition-colors">
            Already have a password? Sign in with password →
          </Link>
        </div>
      </div>
    </div>
  );
}
