import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, Mail, CheckCircle } from "lucide-react";
import SeoHead from "@/components/seo-head";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/forgot-password", { email: email.trim() });
      return res.json();
    },
    onSuccess: () => setDone(true),
    onError: () => setError("Something went wrong. Please try again."),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    mutation.mutate();
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
        <SeoHead title="Forgot Password | MintVault UK" description="Reset your MintVault account password." canonical="https://mintvaultuk.com/forgot-password" />
        <div className="w-full max-w-md bg-white rounded-2xl border border-[#E8E4DC] shadow-lg p-8 md:p-10">
          {done ? (
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-5">
                <CheckCircle size={24} className="text-[#D4AF37]" />
              </div>
              <h1 className="text-xl font-black text-[#1A1A1A] mb-3">Check Your Inbox</h1>
              <p className="text-sm text-[#666666] mb-6">
                If an account exists for <strong>{email}</strong>, a password reset link has been sent. Check your spam folder if you don't see it within a minute.
              </p>
              <Link href="/login" className="text-sm text-[#B8960C] font-semibold hover:text-[#D4AF37] transition-colors">← Back to sign in</Link>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-black text-[#1A1A1A] mb-1">Reset Password</h1>
              <p className="text-sm text-[#888888] mb-8">Enter your email and we'll send a reset link if an account exists.</p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Email Address</label>
                  <div className="relative">
                    <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
                    <input
                      type="email" required value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full pl-9 pr-4 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
                    />
                  </div>
                </div>
                {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
                <button
                  type="submit"
                  disabled={mutation.isPending}
                  className="w-full py-3 rounded-xl font-bold text-sm text-[#1A1400] flex items-center justify-center gap-2 disabled:opacity-60 transition-all"
                  style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
                >
                  {mutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Sending…</> : "Send Reset Link"}
                </button>
              </form>
              <p className="text-xs text-center text-[#888888] mt-6">
                <Link href="/login" className="text-[#B8960C] font-semibold hover:text-[#D4AF37]">← Back to sign in</Link>
              </p>
            </>
          )}
        </div>
      </div>
  );
}
