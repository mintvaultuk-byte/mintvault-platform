import { useState } from "react";
import { useLocation } from "wouter";

/**
 * Unified staff login. Email + password against /api/staff/login, which loads
 * the person's capabilities (grade/scan/print) into the session. No self-signup
 * — admins create staff accounts. Lands on /staff (tools they're enabled for).
 */
export default function StaffLoginPage() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/staff/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError(res.status === 429 ? "Too many attempts — please wait a few minutes." : "Invalid email or password.");
        return;
      }
      navigate("/staff", { replace: true });
    } catch {
      setError("Login failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    // Shared MintVault operator design language (var(--admin-*) tokens) — the
    // canonical Staff/Grader login. Focused unauthenticated panel: NO AdminShell,
    // NO AdminHeaderRow, no authenticated sidebar. Same dark/gold system as the
    // /staff + /grader workspaces so the login visibly belongs to the operator
    // product. Auth flow (endpoint/payload/redirect/errors) is unchanged.
    <div className="min-h-screen bg-[var(--admin-bg)] flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm border border-[var(--admin-gold)]/30 rounded-xl p-6 bg-[var(--admin-panel)] space-y-4"
      >
        <div className="text-center">
          <h1 className="text-[var(--admin-gold)] text-xl font-extrabold tracking-wide">Staff Sign In</h1>
          <p className="text-[var(--admin-ink)]/60 text-xs mt-1">MintVault staff workspace</p>
        </div>
        {error && (
          <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2" role="alert">
            {error}
          </div>
        )}
        <label className="block">
          <span className="text-[var(--admin-ink)] text-xs">Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="mt-1 w-full bg-[var(--admin-bg)] border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:border-[var(--admin-gold)] outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[var(--admin-ink)] text-xs">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="mt-1 w-full bg-[var(--admin-bg)] border border-[var(--admin-gold)]/30 rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:border-[var(--admin-gold)] outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-[var(--admin-gold)] text-[#1A1400] font-bold py-2.5 rounded hover:bg-[#B8960C] transition-colors disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-[var(--admin-gold)]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--admin-bg)]"
        >
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}
