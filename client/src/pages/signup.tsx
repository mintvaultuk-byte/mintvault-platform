import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff, Loader2, Mail, Lock, User, CheckCircle } from "lucide-react";
import SeoHead from "@/components/seo-head";
import GradientButton from "@/components/ui/gradient-button";

function passwordStrength(pw: string): { level: "weak" | "medium" | "strong"; label: string; color: string } {
  const hasLetter = /[a-zA-Z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  const ok = hasLetter && hasNumber && pw.length >= 10;
  if (!ok || pw.length < 10) return { level: "weak", label: "Weak", color: "#ef4444" };
  if (pw.length < 14) return { level: "medium", label: "Medium", color: "#f59e0b" };
  return { level: "strong", label: "Strong", color: "#22c55e" };
}

export default function SignupPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  const strength = passwordStrength(password);

  const signupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/signup", {
        email: email.trim(),
        password,
        display_name: displayName.trim() || undefined,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Signup failed. Please try again.");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      setDone(true);
    },
    onError: (err: Error) => setError(err.message),
  });

  const resendMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/resend-verification", {}),
    onSuccess: () => setResendSent(true),
    onError: () => setError("Failed to resend the verification email. Please try again."),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (strength.level === "weak") {
      setError("Please choose a stronger password (10+ characters, letter and number).");
      return;
    }
    if (!terms) {
      setError("Please accept the Terms & Conditions to continue.");
      return;
    }
    signupMutation.mutate();
  };

  if (done) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-6">
            <CheckCircle size={28} className="text-[#D4AF37]" />
          </div>
          <h1 className="text-2xl font-black text-[#1A1A1A] mb-3">Account Created</h1>
          <p className="text-[#666666] mb-3">
            We've sent a verification link to <strong>{email}</strong>.
          </p>
          <p className="text-sm text-[#888888] mb-8">
            Click the link in your inbox before accessing customer records or paid account features. This protects any
            existing MintVault cards and submissions associated with your address.
          </p>
          {resendSent ? (
            <p className="text-sm text-emerald-700 font-semibold" role="status" aria-live="polite">
              Verification email sent. Check your inbox.
            </p>
          ) : (
            <GradientButton
              as="button"
              type="button"
              onClick={() => resendMutation.mutate()}
              disabled={resendMutation.isPending}
              className="gradient-btn-filled"
              height="48px"
            >
              {resendMutation.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin" /> Sending…
                </>
              ) : (
                "Resend Verification Email"
              )}
            </GradientButton>
          )}
          {error && (
            <p className="text-xs text-red-600 mt-4" role="alert" aria-live="assertive">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => navigate("/")}
            className="block mx-auto mt-5 text-xs text-[#888888] hover:text-[#B8960C] transition-colors"
          >
            Return to MintVault
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
      <SeoHead
        title="Create Account | MintVault UK"
        description="Create your MintVault account to track submissions, manage ownership, and verify your graded cards."
        canonical="https://mintvaultuk.com/signup"
      />
      <div className="w-full max-w-md bg-white rounded-2xl border border-[#E8E4DC] shadow-lg p-8 md:p-10">
        <h1 className="text-2xl font-black text-[#1A1A1A] mb-1">Create Account</h1>
        <p className="text-sm text-[#888888] mb-8">Start tracking your graded cards in minutes.</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Email *</label>
            <div className="relative">
              <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full pl-9 pr-4 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">
              Display Name <span className="text-[#BBBBBB] font-normal normal-case">(optional)</span>
            </label>
            <div className="relative">
              <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How we'll address you"
                className="w-full pl-9 pr-4 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Password *</label>
            <div className="relative">
              <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
              <input
                type={showPw ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="10+ characters, letter + number"
                className="w-full pl-9 pr-10 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA] hover:text-[#666666]"
              >
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {password.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-[#E8E4DC] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: strength.level === "weak" ? "33%" : strength.level === "medium" ? "66%" : "100%",
                      background: strength.color,
                    }}
                  />
                </div>
                <span className="text-xs font-bold" style={{ color: strength.color }}>
                  {strength.label}
                </span>
              </div>
            )}
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={terms}
              onChange={(e) => setTerms(e.target.checked)}
              className="mt-0.5 accent-[#D4AF37]"
            />
            <span className="text-xs text-[#666666]">
              I agree to the{" "}
              <Link href="/terms-and-conditions" target="_blank" className="text-[#B8960C] underline">
                Terms & Conditions
              </Link>{" "}
              and{" "}
              <Link href="/liability-and-insurance" target="_blank" className="text-[#B8960C] underline">
                Liability Policy
              </Link>
            </span>
          </label>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <GradientButton
            as="button"
            type="submit"
            disabled={signupMutation.isPending}
            className="gradient-btn-filled w-full"
            height="48px"
          >
            {signupMutation.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Creating account…
              </>
            ) : (
              "Create Account"
            )}
          </GradientButton>
        </form>

        <p className="text-xs text-center text-[#888888] mt-6">
          Already have an account?{" "}
          <Link href="/login" className="text-[#B8960C] font-semibold hover:text-[#D4AF37]">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
