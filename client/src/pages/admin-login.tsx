import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Shield, LogIn, KeyRound, Eye, EyeOff } from "lucide-react";

interface Props {
  onLogin: () => void;
}

export default function AdminLoginPage({ onLogin }: Props) {
  const [step, setStep] = useState<"password" | "pin">("password");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await apiRequest("POST", "/api/admin/session", { password });
      const data = await res.json();
      if (data.step === "PIN_REQUIRED") {
        setStep("pin");
        setPassword("");
      }
    } catch (err: any) {
      setError("Invalid credentials");
    } finally {
      setLoading(false);
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await apiRequest("POST", "/api/admin/pin", { pin });
      const data = await res.json();
      if (data.success) {
        onLogin();
      }
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("expired") || msg.includes("start again")) {
        setError("Session expired. Please enter your password again.");
        setStep("password");
        setPin("");
      } else {
        setError("Invalid credentials");
        setPin("");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-full border-2 border-[#D4AF37]/40 flex items-center justify-center mx-auto mb-4">
            {step === "password" ? (
              <Shield className="text-[#D4AF37]" size={28} />
            ) : (
              <KeyRound className="text-[#D4AF37]" size={28} />
            )}
          </div>
          <h1 className="text-2xl font-bold text-[#D4AF37] tracking-widest glow-gold-sm" data-testid="text-admin-title">
            STAFF ACCESS
          </h1>
          <p className="text-[#999999] text-sm mt-1">
            {step === "password" ? "MintVault Administration" : "Enter your security PIN"}
          </p>
        </div>

        {step === "password" ? (
          <form onSubmit={handlePasswordSubmit} className="space-y-4" data-testid="form-password">
            <div>
              <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  autoFocus
                  className="w-full bg-transparent border border-[#D4AF37]/40 rounded px-4 py-2.5 pr-12 text-[#1A1A1A] focus:outline-none focus:border-[#D4AF37] transition-colors"
                  data-testid="input-admin-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors z-10 p-1"
                  data-testid="button-toggle-password"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-red-400 text-sm" data-testid="text-login-error">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] py-3 rounded font-bold tracking-widest text-sm transition-all btn-gold-glow hover:bg-[#D4AF37]/20 disabled:opacity-50 flex items-center justify-center gap-2"
              data-testid="button-admin-login"
            >
              <LogIn size={16} />
              {loading ? "Verifying..." : "Continue"}
            </button>
          </form>
        ) : (
          <form onSubmit={handlePinSubmit} className="space-y-4" data-testid="form-pin">
            <div>
              <label className="text-[#D4AF37]/70 text-xs uppercase tracking-wider block mb-1.5">Security PIN</label>
              <div className="relative">
                <input
                  type={showPin ? "text" : "password"}
                  value={pin}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "");
                    if (v.length <= 10) setPin(v);
                  }}
                  required
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoFocus
                  placeholder="Enter PIN"
                  className="w-full bg-transparent border border-[#D4AF37]/40 rounded px-4 py-2.5 pr-12 text-[#1A1A1A] text-center text-2xl tracking-[0.5em] focus:outline-none focus:border-[#D4AF37] transition-colors"
                  data-testid="input-admin-pin"
                />
                <button
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/60 hover:text-[#D4AF37] transition-colors z-10 p-1"
                  data-testid="button-toggle-pin"
                  tabIndex={-1}
                >
                  {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-red-400 text-sm" data-testid="text-login-error">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || pin.length < 6}
              className="w-full border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] py-3 rounded font-bold tracking-widest text-sm transition-all btn-gold-glow hover:bg-[#D4AF37]/20 disabled:opacity-50 flex items-center justify-center gap-2"
              data-testid="button-admin-pin-submit"
            >
              <KeyRound size={16} />
              {loading ? "Verifying..." : "Unlock"}
            </button>

            <button
              type="button"
              onClick={() => { setStep("password"); setPin(""); setError(""); }}
              className="w-full text-[#999999] text-xs hover:text-[#D4AF37] transition-colors"
              data-testid="button-back-to-password"
            >
              Back to password
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
