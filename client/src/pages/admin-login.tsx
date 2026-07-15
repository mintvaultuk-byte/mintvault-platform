import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { LogIn, KeyRound, Eye, EyeOff, RotateCcw } from "lucide-react";
import GoldShader from "@/components/admin/gold-shader";

interface Props {
  onLogin?: () => void;
}

export default function AdminLoginPage({ onLogin }: Props) {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const nextPath = params.get("next") || "/admin";
  const initialReason = params.get("reason") || "";
  const [step, setStep] = useState<"password" | "pin">("password");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPin, setShowPin] = useState(false);

  useEffect(() => {
    if (initialReason === "session_expired") {
      setError("Session expired. Please sign in again.");
    } else if (initialReason === "invalid_session" || initialReason === "wrong_portal") {
      setError("Invalid session. Clear the session and sign in again.");
    }
  }, [initialReason]);

  const errorFrom = (err: unknown, fallback: string) => {
    const maybeErr = err as { status?: number; body?: { error?: string }; message?: string };
    const status = maybeErr.status;
    const bodyError = String(maybeErr.body?.error || maybeErr.message || "");
    if (status === 401) {
      if (bodyError.includes("expired") || bodyError.includes("start again"))
        return "Session expired. Please sign in again.";
      return "Incorrect password or PIN.";
    }
    if (status === 429) return "Authentication failed. Please wait a moment and try again.";
    if (typeof status === "number" && status >= 500) return "Server unavailable. Please try again shortly.";
    if (status === 400) return "Authentication failed. Check the details and try again.";
    if (!status) return "Server unavailable. Please check your connection and try again.";
    return fallback;
  };

  const clearAuthStorage = () => {
    const keys = ["mv.admin.auth", "mv.admin.session", "adminAuthenticated"];
    const removeKeys = (storage: Storage) => keys.forEach((key) => storage.removeItem(key));
    try {
      removeKeys(localStorage);
    } catch {
      // Storage can be unavailable in private browsing; cookie clearing still proceeds.
    }
    try {
      removeKeys(sessionStorage);
    } catch {
      // Storage can be unavailable in private browsing; cookie clearing still proceeds.
    }
  };

  const clearSession = async () => {
    setLoading(true);
    setError("");
    try {
      await fetch("/api/admin/clear-session", { method: "POST", credentials: "include" });
    } catch {
      // A network failure should not stop local cleanup.
    } finally {
      clearAuthStorage();
      document.cookie = "mv.sid=; Max-Age=0; path=/; SameSite=Lax";
      window.location.href = "/admin/login";
    }
  };

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
    } catch (err: unknown) {
      setError(errorFrom(err, "Authentication failed. Please try again."));
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
    } catch (err: unknown) {
      const message = errorFrom(err, "Authentication failed. Please try again.");
      if (message.includes("expired")) {
        setError(message);
        setStep("password");
        setPin("");
      } else {
        setError(message);
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
          <button
            type="button"
            onClick={clearSession}
            disabled={loading}
            className="mt-4 inline-flex items-center justify-center gap-2 text-xs transition-colors"
            style={{ color: "var(--admin-ink-faint)" }}
            data-testid="button-clear-admin-session"
          >
            <RotateCcw size={13} />
            Clear Session
          </button>
        </div>
      </div>
    </div>
  );
}
