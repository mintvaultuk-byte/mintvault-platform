import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";
import SeoHead from "@/components/seo-head";

interface ForgotResponse {
  ok?: boolean;
  message?: string;
  error?: string;
}

export default function PinForgotPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const forgotMutation = useMutation<ForgotResponse, Error, string>({
    mutationFn: async (addr) => {
      const res = await fetch("/api/auth/pin/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: addr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not send reset link.");
      return data as ForgotResponse;
    },
    onSuccess: () => setSent(true),
    onError: (err) => setError(err.message || "Could not send reset link."),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    forgotMutation.mutate(email.trim().toLowerCase());
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
      <SeoHead
        title="Reset Your PIN | MintVault UK"
        description="Request a PIN reset link for your MintVault dashboard."
        canonical="https://mintvaultuk.com/auth/pin/forgot"
      />
      <div className="w-full max-w-md rounded-2xl overflow-hidden shadow-xl bg-[#0A0A0A] p-8 md:p-10">
        <div className="w-10 h-10 rounded-full bg-[#FFCB05]/10 border border-[#FFCB05]/30 flex items-center justify-center mb-5 mx-auto">
          <Mail size={18} className="text-[#FFCB05]" />
        </div>
        <h1 className="text-2xl font-black text-white mb-2 text-center">Reset Your PIN</h1>
        <p className="text-[#888888] text-sm mb-6 text-center">
          Enter your email and we'll send a reset link.
        </p>

        {sent ? (
          <div
            className="bg-emerald-900/30 border border-emerald-700/40 rounded-xl p-4 text-sm text-emerald-400"
            data-testid="forgot-success"
          >
            If an account exists for that email, a reset link has been sent. Check your inbox — the link is valid for 15 minutes.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3" data-testid="pin-forgot-form">
            <div>
              <label htmlFor="email" className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white placeholder:text-[#555555] focus:outline-none focus:border-[#FFCB05] transition-colors"
                data-testid="input-email"
              />
            </div>
            {error && <p className="text-xs text-red-400" data-testid="forgot-error">{error}</p>}
            <button
              type="submit"
              disabled={forgotMutation.isPending}
              className="w-full py-3 rounded-xl text-sm font-bold text-[#1A1400] disabled:opacity-60 transition-all flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg,#FFCB05,#FFCB05)" }}
              data-testid="button-send-reset"
            >
              {forgotMutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Sending…</> : "Send Reset Link"}
            </button>
          </form>
        )}

        <div className="border-t border-[#333333] my-6" />

        <Link href="/customer-login" className="block text-xs text-[#888888] hover:text-[#FFCB05] transition-colors text-center">
          Back to sign-in
        </Link>
      </div>
    </div>
  );
}
