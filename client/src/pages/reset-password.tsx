import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff, Loader2, Lock, CheckCircle } from "lucide-react";
import SeoHead from "@/components/seo-head";

function passwordStrength(pw: string): { level: "weak" | "medium" | "strong"; label: string; color: string } {
  const ok = /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw) && pw.length >= 10;
  if (!ok) return { level: "weak", label: "Weak", color: "#ef4444" };
  if (pw.length < 14) return { level: "medium", label: "Medium", color: "#f59e0b" };
  return { level: "strong", label: "Strong", color: "#22c55e" };
}

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";

  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState(!token ? "Missing or invalid reset link." : "");
  const [done, setDone] = useState(false);

  const strength = passwordStrength(newPw);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/auth/reset-password", { token, new_password: newPw });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Password reset failed. Please try again.");
      }
      return res.json();
    },
    onSuccess: () => setDone(true),
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (strength.level === "weak") { setError("Please choose a stronger password (10+ characters, letter and number)."); return; }
    if (newPw !== confirmPw) { setError("Passwords do not match."); return; }
    mutation.mutate();
  };

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
        <SeoHead title="Reset Password | MintVault UK" description="Choose a new password for your MintVault account." canonical="https://mintvaultuk.com/reset-password" />
        <div className="w-full max-w-md bg-white rounded-2xl border border-[#E8E4DC] shadow-lg p-8 md:p-10">
          {done ? (
            <div className="text-center">
              <div className="w-14 h-14 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mx-auto mb-5">
                <CheckCircle size={24} className="text-[#D4AF37]" />
              </div>
              <h1 className="text-xl font-black text-[#1A1A1A] mb-3">Password Updated</h1>
              <p className="text-sm text-[#666666] mb-6">Your password has been changed. You can now sign in with your new password.</p>
              <button
                onClick={() => navigate("/login")}
                className="px-8 py-3 rounded-xl font-bold text-sm text-[#1A1400] transition-all"
                style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
              >
                Sign In
              </button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-black text-[#1A1A1A] mb-1">New Password</h1>
              <p className="text-sm text-[#888888] mb-8">Choose a strong password for your MintVault account.</p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">New Password</label>
                  <div className="relative">
                    <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
                    <input
                      type={showPw ? "text" : "password"} required value={newPw} onChange={e => setNewPw(e.target.value)}
                      placeholder="10+ characters, letter + number"
                      className="w-full pl-9 pr-10 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
                    />
                    <button type="button" onClick={() => setShowPw(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA]">
                      {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  {newPw.length > 0 && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-[#E8E4DC] overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: strength.level === "weak" ? "33%" : strength.level === "medium" ? "66%" : "100%", background: strength.color }} />
                      </div>
                      <span className="text-xs font-bold" style={{ color: strength.color }}>{strength.label}</span>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Confirm Password</label>
                  <div className="relative">
                    <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
                    <input
                      type={showPw ? "text" : "password"} required value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                      placeholder="Repeat your new password"
                      className="w-full pl-9 pr-4 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors"
                    />
                  </div>
                </div>
                {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
                <button
                  type="submit" disabled={mutation.isPending || !token}
                  className="w-full py-3 rounded-xl font-bold text-sm text-[#1A1400] flex items-center justify-center gap-2 disabled:opacity-60 transition-all"
                  style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
                >
                  {mutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Updating…</> : "Set New Password"}
                </button>
              </form>
              <p className="text-xs text-center text-[#888888] mt-6">
                <Link href="/forgot-password" className="text-[#B8960C] font-semibold hover:text-[#D4AF37]">Request a new link</Link>
              </p>
            </>
          )}
        </div>
      </div>
  );
}
