import { useState, useEffect, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Lock, CheckCircle } from "lucide-react";
import SeoHead from "@/components/seo-head";

interface SetupResponse {
  ok?: boolean;
  redirect?: string;
  error?: string;
  reason?: string;
}

export default function PinSetupPage() {
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [error, setError] = useState("");
  const [isReset, setIsReset] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("reset") === "1") setIsReset(true);
  }, []);

  // Local feedback only — server is source of truth for strength rules.
  // We just give instant length / numeric / match feedback.
  const localStatus = useMemo(() => {
    if (pin.length === 0) return null;
    if (!/^\d*$/.test(pin)) return { ok: false, msg: "PIN must be digits only." };
    if (pin.length < 6) return { ok: false, msg: `${6 - pin.length} more digit${pin.length === 5 ? "" : "s"}…` };
    if (pin.length === 6 && pinConfirm.length === 6 && pin !== pinConfirm) return { ok: false, msg: "PINs don't match." };
    if (pin.length === 6 && pinConfirm.length < 6) return { ok: false, msg: "Confirm your PIN below." };
    if (pin.length === 6 && pin === pinConfirm) return { ok: true, msg: "PINs match." };
    return null;
  }, [pin, pinConfirm]);

  const setupMutation = useMutation<SetupResponse, Error, { pin: string }>({
    mutationFn: async (body) => {
      const res = await fetch("/api/auth/pin/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(new Error(data.error || "Could not set PIN."), { status: res.status, reason: data.reason });
      }
      return data as SetupResponse;
    },
    onSuccess: (data) => {
      if (data.redirect) window.location.href = data.redirect;
    },
    onError: (err: any) => {
      setError(err.message || "Could not set PIN.");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!/^\d{6}$/.test(pin)) {
      setError("PIN must be exactly 6 digits.");
      return;
    }
    if (pin !== pinConfirm) {
      setError("PINs don't match.");
      return;
    }
    setupMutation.mutate({ pin });
  };

  const heading = isReset ? "Set a new PIN" : "Choose your PIN";
  const subhead = isReset
    ? "Choose a new 6-digit PIN for signing in. The old PIN is now invalid."
    : "From now on, sign in with your email and this 6-digit PIN. Magic-link emails are only for first-time setup and PIN reset.";

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center px-4 py-16">
      <SeoHead
        title="Choose your PIN | MintVault UK"
        description="Set a 6-digit PIN for your MintVault dashboard."
        canonical="https://mintvaultuk.com/auth/pin/setup"
      />
      <div className="w-full max-w-md rounded-2xl overflow-hidden shadow-xl bg-[#0A0A0A] p-8 md:p-10">
        <div className="w-10 h-10 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center mb-5 mx-auto">
          <Lock size={18} className="text-[#D4AF37]" />
        </div>
        <h1 className="text-2xl font-black text-white mb-2 text-center">{heading}</h1>
        <p className="text-[#888888] text-sm mb-6 text-center leading-relaxed">{subhead}</p>

        <form onSubmit={handleSubmit} className="space-y-3" data-testid="pin-setup-form">
          <div>
            <label htmlFor="pin" className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">New PIN</label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
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
          <div>
            <label htmlFor="pinConfirm" className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">Confirm PIN</label>
            <input
              id="pinConfirm"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              required
              maxLength={6}
              pattern="[0-9]{6}"
              value={pinConfirm}
              onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="••••••"
              className="w-full px-4 py-2.5 bg-[#1A1A1A] border border-[#333333] rounded-lg text-sm text-white placeholder:text-[#555555] focus:outline-none focus:border-[#D4AF37] transition-colors tracking-widest text-center"
              data-testid="input-pin-confirm"
            />
          </div>
          {localStatus && (
            <p
              className={`text-xs flex items-center gap-1.5 ${localStatus.ok ? "text-emerald-400" : "text-[#888888]"}`}
              data-testid="local-status"
            >
              {localStatus.ok && <CheckCircle size={12} />}
              {localStatus.msg}
            </p>
          )}
          {error && <p className="text-xs text-red-400" data-testid="setup-error">{error}</p>}
          <button
            type="submit"
            disabled={setupMutation.isPending || pin.length !== 6 || pin !== pinConfirm}
            className="w-full py-3 rounded-xl text-sm font-bold text-[#1A1400] disabled:opacity-60 transition-all flex items-center justify-center gap-2"
            style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
            data-testid="button-set-pin"
          >
            {setupMutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : "Set PIN"}
          </button>
        </form>

        <div className="border-t border-[#333333] my-6" />

        <div className="text-xs text-[#666666] leading-relaxed text-center">
          <p className="mb-2">PIN rules:</p>
          <ul className="text-left inline-block space-y-1">
            <li>• Exactly 6 digits</li>
            <li>• Not all the same digit (000000, 111111…)</li>
            <li>• Not a sequential run (123456, 654321…)</li>
            <li>• Not your date of birth</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
