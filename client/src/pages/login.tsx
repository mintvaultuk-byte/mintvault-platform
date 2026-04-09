import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff, Loader2, Mail, Lock } from "lucide-react";
import SeoHead from "@/components/seo-head";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next") || "/dashboard";
  const errorParam = params.get("error");

  // Password login state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState(errorParam === "expired_link" ? "That login link has expired. Please request a new one." : "");

  // Magic link state
  const [mlEmail, setMlEmail] = useState("");
  const [mlSent, setMlSent] = useState(false);
  const [mlError, setMlError] = useState("");

  const loginMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const res = await apiRequest("POST", "/api/auth/login", data);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || body.error || "Invalid email or password");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      navigate(next.startsWith("/") ? next : "/dashboard");
    },
    onError: (err: Error) => setError(err.message || "Invalid email or password"),
  });

  const magicMutation = useMutation({
    mutationFn: async (mlEmail: string) => {
      const res = await apiRequest("POST", "/api/auth/magic-link", { email: mlEmail });
      return res.json();
    },
    onSuccess: () => setMlSent(true),
    onError: () => setMlError("Failed to send link. Please try again."),
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    loginMutation.mutate({ email: email.trim(), password });
  };

  const handleMagic = (e: React.FormEvent) => {
    e.preventDefault();
    setMlError("");
    magicMutation.mutate(mlEmail.trim());
  };

  return (
    <>
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
        <SeoHead
          title="Log In | MintVault UK"
          description="Sign in to your MintVault account to track submissions and manage your graded cards."
          canonical="https://mintvaultuk.com/login"
        />
        <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-0 rounded-2xl overflow-hidden shadow-xl border border-[#E8E4DC]">

          {/* Left — email + password */}
          <div className="bg-white p-8 md:p-10">
            <h1 className="text-2xl font-black text-[#1A1A1A] mb-1">
              Sign In
            </h1>
            <p className="text-sm text-[#888888] mb-8">Enter your email and password to continue.</p>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Email</label>
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full pl-9 pr-4 py-2.5 border border-[#E8E4DC] rounded-lg text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37] transition-colors"
                  />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-bold text-[#888888] uppercase tracking-wider">Password</label>
                  <Link href="/forgot-password" className="text-xs text-[#B8960C] hover:text-[#D4AF37] transition-colors">
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
                  <input
                    type={showPw ? "text" : "password"}
                    required
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Your password"
                    className="w-full pl-9 pr-10 py-2.5 border border-[#E8E4DC] rounded-lg text-sm text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37] transition-colors"
                  />
                  <button type="button" onClick={() => setShowPw(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA] hover:text-[#666666]">
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

              <button
                type="submit"
                disabled={loginMutation.isPending}
                className="w-full py-3 rounded-xl font-bold text-sm text-[#1A1400] flex items-center justify-center gap-2 disabled:opacity-60 transition-all"
                style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
              >
                {loginMutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Signing in…</> : "Sign In"}
              </button>
            </form>

            <p className="text-xs text-center text-[#888888] mt-6">
              Don't have an account?{" "}
              <Link href="/signup" className="text-[#B8960C] font-semibold hover:text-[#D4AF37]">Create one</Link>
            </p>
          </div>

          {/* Right — magic link */}
          <div className="bg-[#0A0A0A] p-8 md:p-10 flex flex-col justify-center">
            <div className="w-10 h-10 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mb-5">
              <Mail size={18} className="text-[#D4AF37]" />
            </div>
            <h2 className="text-xl font-black text-white mb-2">
              Magic Link
            </h2>
            <p className="text-[#888888] text-sm mb-6">No password needed. We'll email you a one-click sign-in link.</p>

            {mlSent ? (
              <div className="bg-emerald-900/30 border border-emerald-700/40 rounded-xl p-4 text-sm text-emerald-400">
                Link sent! Check your inbox and click it to sign in.
              </div>
            ) : (
              <form onSubmit={handleMagic} className="space-y-3">
                <input
                  type="email"
                  required
                  value={mlEmail}
                  onChange={e => setMlEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="w-full px-4 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white placeholder:text-[#555555] focus:outline-none focus:border-[#D4AF37] transition-colors"
                />
                {mlError && <p className="text-xs text-red-400">{mlError}</p>}
                <button
                  type="submit"
                  disabled={magicMutation.isPending}
                  className="w-full py-2.5 rounded-xl text-sm font-bold text-[#1A1400] disabled:opacity-60 transition-all flex items-center justify-center gap-2"
                  style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
                >
                  {magicMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                  Send Login Link
                </button>
              </form>
            )}
          </div>

        </div>
      </div>
    </>
  );
}
