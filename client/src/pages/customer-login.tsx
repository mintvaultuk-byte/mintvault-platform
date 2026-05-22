import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Lock } from "lucide-react";
import SeoHead from "@/components/seo-head";
import GradientButton from "@/components/ui/gradient-button";

interface LoginResponse {
  ok?: boolean;
  redirect?: string;
  error?: string;
  retryAfterSeconds?: number;
}

interface MagicLinkResponse {
  message?: string;
  error?: string;
}

export default function CustomerLoginPage() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [magicSent, setMagicSent] = useState(false);
  const [magicError, setMagicError] = useState("");

  // Surface query-string errors from server-side redirects
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "reset_link_invalid") {
      setError("That reset link is invalid or has already been used. Request a new one below.");
      window.history.replaceState({}, "", "/customer-login");
    }
  }, []);

  const loginMutation = useMutation<LoginResponse, Error, { email: string; pin: string }>({
    mutationFn: async (body) => {
      const res = await fetch("/api/auth/pin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(new Error(data.error || "Sign-in failed."), {
          status: res.status,
          retryAfterSeconds: data.retryAfterSeconds,
        });
      }
      return data as LoginResponse;
    },
    onSuccess: (data) => {
      if (data.redirect) {
        // Using window.location for the redirect so the destination page
        // gets a fresh fetch (queryClient on the new page sees the new
        // session cookie). setLocation would client-route which can leave
        // TanStack caches stale.
        window.location.href = data.redirect;
      }
    },
    onError: (err: any) => {
      if (err.status === 423 && err.retryAfterSeconds) {
        const mins = Math.max(1, Math.ceil(err.retryAfterSeconds / 60));
        setError(`Too many incorrect attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
      } else {
        setError(err.message || "Email or PIN incorrect.");
      }
    },
  });

  const magicMutation = useMutation<MagicLinkResponse, Error, string>({
    mutationFn: async (addr) => {
      const res = await fetch("/api/customer/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: addr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Could not send link.");
      }
      return data;
    },
    onSuccess: () => setMagicSent(true),
    onError: (err) => setMagicError(err.message || "Could not send link."),
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setError("PIN must be 6 digits.");
      return;
    }
    loginMutation.mutate({ email: email.trim().toLowerCase(), pin });
  };

  const handleMagicLink = () => {
    setMagicError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setMagicError("Enter your email above first.");
      return;
    }
    magicMutation.mutate(email.trim().toLowerCase());
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
      <SeoHead
        title="Sign In | MintVault UK"
        description="Sign in to your MintVault dashboard with your email and 6-digit PIN."
        canonical="https://mintvaultuk.com/customer-login"
      />
      <div className="w-full max-w-md rounded-2xl overflow-hidden shadow-xl bg-[#0A0A0A] p-8 md:p-10">
        <div className="w-10 h-10 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mb-5 mx-auto">
          <Lock size={18} className="text-[#D4AF37]" />
        </div>
        <h1 className="text-2xl font-black text-white mb-2 text-center">Sign In</h1>
        <p className="text-[#888888] text-sm mb-6 text-center">Enter your email and 6-digit PIN.</p>

        <form onSubmit={handleLogin} className="space-y-3" data-testid="customer-login-form">
          <div>
            <label htmlFor="email" className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-4 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white placeholder:text-[#555555] focus:outline-none focus:border-[#D4AF37] transition-colors"
              data-testid="input-email"
            />
          </div>
          <div>
            <label htmlFor="pin" className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">
              PIN
            </label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={6}
              pattern="[0-9]{6}"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="••••••"
              className="w-full px-4 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white placeholder:text-[#555555] focus:outline-none focus:border-[#D4AF37] transition-colors tracking-widest text-center"
              data-testid="input-pin"
            />
          </div>
          {error && (
            <p className="text-xs text-red-400" data-testid="login-error">
              {error}
            </p>
          )}
          <GradientButton
            as="button"
            type="submit"
            disabled={loginMutation.isPending || pin.length !== 6}
            className="gradient-btn-filled w-full"
            height="48px"
            data-testid="button-sign-in"
          >
            {loginMutation.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Signing In…
              </>
            ) : (
              "Sign In"
            )}
          </GradientButton>
        </form>

        <div className="border-t border-[#333333] my-6" />

        <div className="space-y-3 text-center">
          <Link href="/auth/pin/forgot" className="block text-xs text-[#888888] hover:text-[#D4AF37] transition-colors">
            Forgot your PIN?
          </Link>
          <div className="text-xs text-[#666666] leading-relaxed">
            First time? Enter your email above, then{" "}
            <button
              type="button"
              onClick={handleMagicLink}
              disabled={magicMutation.isPending || magicSent}
              className="underline text-[#888888] hover:text-[#D4AF37] disabled:opacity-60"
              data-testid="button-magic-link"
            >
              {magicMutation.isPending ? "sending…" : magicSent ? "link sent — check your inbox" : "send a setup link"}
            </button>
            .
          </div>
          {magicError && <p className="text-xs text-red-400">{magicError}</p>}
        </div>
      </div>
    </div>
  );
}
