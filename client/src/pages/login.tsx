import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff, Loader2, Lock, Mail } from "lucide-react";
import SeoHead from "@/components/seo-head";
import GradientButton from "@/components/ui/gradient-button";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"magic" | "password">("magic");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
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

  const passwordMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/login", { email: email.trim(), password });
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/customer/me"] });
      navigate("/dashboard");
    },
    onError: () => setError("Email or password incorrect. Please try again."),
  });

  const selectMode = (nextMode: "magic" | "password") => {
    setMode(nextMode);
    setError("");
    setSent(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (mode === "password") passwordMutation.mutate();
    else magicMutation.mutate(email.trim());
  };

  const isPending = magicMutation.isPending || passwordMutation.isPending;

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
        <p className="text-[#888888] text-sm mb-5 text-center">
          {mode === "magic"
            ? "Enter your email and we'll send you a one-click sign-in link."
            : "Sign in with the email and password you used to create your account."}
        </p>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#151515] p-1 mb-6" aria-label="Sign-in method">
          <button
            type="button"
            onClick={() => selectMode("magic")}
            aria-pressed={mode === "magic"}
            className={`rounded-md px-3 py-2 text-xs font-bold transition-colors ${
              mode === "magic" ? "bg-[#D4AF37] text-[#0A0A0A]" : "text-[#888888] hover:text-white"
            }`}
          >
            Email link
          </button>
          <button
            type="button"
            onClick={() => selectMode("password")}
            aria-pressed={mode === "password"}
            className={`rounded-md px-3 py-2 text-xs font-bold transition-colors ${
              mode === "password" ? "bg-[#D4AF37] text-[#0A0A0A]" : "text-[#888888] hover:text-white"
            }`}
          >
            Password
          </button>
        </div>

        {mode === "magic" && sent ? (
          <div
            className="bg-emerald-900/30 border border-emerald-700/40 rounded-xl p-4 text-sm text-emerald-400"
            role="status"
            aria-live="polite"
          >
            Link sent! Check your inbox and click it to sign in.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label
                htmlFor="customer-login-email"
                className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5"
              >
                Email
              </label>
              <input
                id="customer-login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white placeholder:text-[#555555] focus:outline-none focus:border-[#D4AF37] transition-colors"
              />
            </div>
            {mode === "password" && (
              <div>
                <label
                  htmlFor="customer-login-password"
                  className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5"
                >
                  Password
                </label>
                <div className="relative">
                  <Lock
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555555]"
                    aria-hidden="true"
                  />
                  <input
                    id="customer-login-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-9 pr-10 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white focus:outline-none focus:border-[#D4AF37] transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#777777] hover:text-white"
                  >
                    {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <Link
                  href="/forgot-password"
                  className="block text-right text-xs text-[#888888] hover:text-[#D4AF37] transition-colors mt-2"
                >
                  Forgot your password?
                </Link>
              </div>
            )}
            {error && (
              <p className="text-xs text-red-400" role="alert" aria-live="assertive">
                {error}
              </p>
            )}
            <GradientButton
              as="button"
              type="submit"
              disabled={isPending}
              className="gradient-btn-filled w-full"
              height="48px"
            >
              {isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Sending…
                </>
              ) : mode === "magic" ? (
                "Send Login Link"
              ) : (
                "Sign In"
              )}
            </GradientButton>
          </form>
        )}

        {mode === "magic" && (
          <p className="text-xs text-[#666666] mt-6 text-center leading-relaxed">
            No password needed. The link is valid for 15 minutes and can only be used once.
          </p>
        )}

        <div className="border-t border-[#333333] my-6" />

        <div className="space-y-2 text-center">
          <Link href="/signup" className="block text-xs text-[#888888] hover:text-[#D4AF37] transition-colors">
            New here? Create your account →
          </Link>
        </div>
      </div>
    </div>
  );
}
