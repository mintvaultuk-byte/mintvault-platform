import { useState } from "react";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { LogIn, KeyRound, Eye, EyeOff } from "lucide-react";
import GoldShader from "@/components/admin/gold-shader";

interface Props {
  onLogin?: () => void;
}

export default function AdminLoginPage({ onLogin }: Props) {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const nextPath = params.get("next") || "/admin";
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
      if (data.step === "PIN_SETUP_REQUIRED") {
        // First admin login post-PIN-deploy: pin_hash not yet set. Server keeps
        // pendingAdmin flag in session; /auth/pin/setup uses that as the admin-
        // context authorisation flag. Use window.location.href (not navigate)
        // so the setup page does a fresh fetch and reads the session correctly.
        window.location.href = "/auth/pin/setup";
        return;
      }
      if (data.success) {
        onLogin?.();
        navigate(nextPath);
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
    <div className="admin-root">
      <div className="admin-login">
        <GoldShader className="admin-login__fx" />

        <div className="admin-login__card admin-rise">
          <div className="mb-7">
            <div className="admin-brand__mark" style={{ fontSize: 30 }}>
              MintVault
            </div>
            <div className="admin-brand__sub" style={{ marginTop: 6 }}>
              Admin
            </div>
            <p className="mt-3 text-[13px]" style={{ color: "var(--admin-ink-dim)" }}>
              Grading &amp; Authentication Console
            </p>
          </div>

          {step === "password" ? (
            <form onSubmit={handlePasswordSubmit} className="space-y-5" data-testid="form-password">
              <div>
                <label className="admin-field-label">Operator passphrase</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    autoFocus
                    className="admin-input pr-11"
                    data-testid="input-admin-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-1 transition-colors"
                    style={{ color: "var(--admin-ink-faint)" }}
                    data-testid="button-toggle-password"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-sm" style={{ color: "var(--admin-red)" }} data-testid="text-login-error">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="admin-btn admin-btn--gold w-full"
                style={{ height: 48 }}
                data-testid="button-admin-login"
              >
                <LogIn size={16} />
                {loading ? "Verifying…" : "Continue"}
              </button>
            </form>
          ) : (
            <form onSubmit={handlePinSubmit} className="space-y-5" data-testid="form-pin">
              <div>
                <label className="admin-field-label">Security PIN</label>
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
                    className="admin-input pr-11 text-center text-2xl tracking-[0.5em]"
                    data-testid="input-admin-pin"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin(!showPin)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-1 transition-colors"
                    style={{ color: "var(--admin-ink-faint)" }}
                    data-testid="button-toggle-pin"
                    tabIndex={-1}
                  >
                    {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-sm" style={{ color: "var(--admin-red)" }} data-testid="text-login-error">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading || pin.length < 6}
                className="admin-btn admin-btn--gold w-full"
                style={{ height: 48 }}
                data-testid="button-admin-pin-submit"
              >
                <KeyRound size={16} />
                {loading ? "Verifying…" : "Enter the Vault"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setStep("password");
                  setPin("");
                  setError("");
                }}
                className="w-full text-xs transition-colors"
                style={{ color: "var(--admin-ink-faint)" }}
                data-testid="button-back-to-password"
              >
                Back to passphrase
              </button>
            </form>
          )}

          <div className="admin-login-foot mt-7 flex items-center gap-2">
            <span
              className="admin-env__dot"
              style={{ background: "var(--admin-green)", color: "var(--admin-green)" }}
            />
            <span
              className="font-mono-admin"
              style={{
                fontFamily: "var(--admin-mono)",
                fontSize: 9.5,
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                color: "var(--admin-ink-faint)",
              }}
            >
              MintVault · Staff Access
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
