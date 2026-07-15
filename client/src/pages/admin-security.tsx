import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { KeyRound, LockKeyhole, RotateCcw, ShieldCheck } from "lucide-react";
import GrainOverlay from "@/components/admin/grain-overlay";

type SecurityStatus = {
  adminPassphraseHashConfigured: boolean;
  breakGlassFallbackActive: boolean;
  credentialVersion: number;
};

const EMPTY_PASSPHRASE = {
  currentPassphrase: "",
  newPassphrase: "",
  confirmPassphrase: "",
  pin: "",
};

const EMPTY_PIN = {
  currentPin: "",
  newPin: "",
  confirmPin: "",
};

function safeMessage(status: number, fallback: string): string {
  if (status === 401) return "Authentication failed.";
  if (status === 403) return "This admin session cannot perform that action.";
  if (status === 429) return "Too many attempts. Please wait and try again.";
  if (status >= 500) return "Server unavailable. Please try again shortly.";
  return fallback;
}

export default function AdminSecurityPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [passphrase, setPassphrase] = useState(EMPTY_PASSPHRASE);
  const [pin, setPin] = useState(EMPTY_PIN);
  const [revokePin, setRevokePin] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function loadStatus() {
    const res = await fetch("/api/admin/credentials/status", { credentials: "include" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        setAuthed(false);
        return;
      }
      throw new Error(data.error || "Unable to load account security.");
    }
    setAuthed(true);
    setStatus(data);
  }

  useEffect(() => {
    (async () => {
      try {
        await loadStatus();
      } catch {
        setAuthed(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/security", { replace: true });
  }, [authed, navigate]);

  async function submitPassphrase(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setBusy("passphrase");
    try {
      const res = await fetch("/api/admin/credentials/passphrase", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(passphrase),
      });
      if (!res.ok) {
        setErr(safeMessage(res.status, "Passphrase was not changed."));
        return;
      }
      setPassphrase(EMPTY_PASSPHRASE);
      setMsg("Admin passphrase updated.");
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    setBusy("pin");
    try {
      const res = await fetch("/api/admin/credentials/pin", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pin),
      });
      if (!res.ok) {
        setErr(safeMessage(res.status, "PIN was not changed."));
        return;
      }
      setPin(EMPTY_PIN);
      setMsg("Admin PIN updated.");
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }

  async function revokeAllSessions(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    if (!window.confirm("Sign out all other admin sessions?")) return;
    setBusy("revoke");
    try {
      const res = await fetch("/api/admin/credentials/revoke-sessions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: revokePin }),
      });
      if (!res.ok) {
        setErr(safeMessage(res.status, "Sessions were not revoked."));
        return;
      }
      setRevokePin("");
      setMsg("Admin sessions revoked.");
      await loadStatus();
    } finally {
      setBusy(null);
    }
  }

  if (authed !== true) {
    return (
      <div className="admin-root flex min-h-screen items-center justify-center">
        <div className="h-8 w-32 animate-pulse rounded bg-[#D4AF37]/10" />
      </div>
    );
  }

  return (
    <div className="admin-root min-h-screen px-4 py-6">
      <GrainOverlay />
      <main className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-extrabold text-[#D4AF37]">Account Security</h1>
            <p className="text-xs uppercase tracking-[0.18em] text-[#E8E4DC]/45">MintVault admin</p>
          </div>
          <button type="button" onClick={() => navigate("/admin")} className="admin-btn admin-btn--sm">
            Admin
          </button>
        </div>

        {msg && (
          <div className="rounded border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-400">
            {msg}
          </div>
        )}
        {err && <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-400">{err}</div>}

        <section className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-[#D4AF37]/20 bg-black/25 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#D4AF37]">
              <ShieldCheck size={16} /> Admin passphrase protection
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[#E8E4DC]/55">Environment fallback active</dt>
                <dd className="font-semibold text-[#E8E4DC]">{status?.breakGlassFallbackActive ? "Yes" : "No"}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[#E8E4DC]/55">Database hash active</dt>
                <dd className="font-semibold text-[#E8E4DC]">{status?.adminPassphraseHashConfigured ? "Yes" : "No"}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border border-[#D4AF37]/20 bg-black/25 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#D4AF37]">
              <RotateCcw size={16} /> Active session security
            </div>
            <dl className="mb-3 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-[#E8E4DC]/55">Credential version</dt>
                <dd className="font-mono text-[#E8E4DC]">{status?.credentialVersion ?? "..."}</dd>
              </div>
            </dl>
            <form onSubmit={revokeAllSessions} className="flex flex-col gap-2 sm:flex-row">
              <input
                className="ss-input"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                placeholder="Confirm PIN"
                value={revokePin}
                onChange={(e) => setRevokePin(e.target.value)}
                required
              />
              <button type="submit" disabled={busy === "revoke"} className="admin-btn admin-btn--sm">
                Sign out all sessions
              </button>
            </form>
          </div>
        </section>

        <section className="rounded-lg border border-[#D4AF37]/20 bg-black/25 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#D4AF37]">
            <KeyRound size={16} /> Change admin passphrase
          </div>
          <form onSubmit={submitPassphrase} className="grid gap-2 md:grid-cols-2">
            <input
              className="ss-input"
              type="password"
              autoComplete="current-password"
              placeholder="Current passphrase"
              value={passphrase.currentPassphrase}
              onChange={(e) => setPassphrase((p) => ({ ...p, currentPassphrase: e.target.value }))}
              required
            />
            <input
              className="ss-input"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              placeholder="Confirm PIN"
              value={passphrase.pin}
              onChange={(e) => setPassphrase((p) => ({ ...p, pin: e.target.value }))}
              required
            />
            <input
              className="ss-input"
              type="password"
              autoComplete="new-password"
              placeholder="New passphrase"
              value={passphrase.newPassphrase}
              onChange={(e) => setPassphrase((p) => ({ ...p, newPassphrase: e.target.value }))}
              required
            />
            <input
              className="ss-input"
              type="password"
              autoComplete="new-password"
              placeholder="Confirm new passphrase"
              value={passphrase.confirmPassphrase}
              onChange={(e) => setPassphrase((p) => ({ ...p, confirmPassphrase: e.target.value }))}
              required
            />
            <div className="md:col-span-2">
              <button type="submit" disabled={busy === "passphrase"} className="admin-btn admin-btn--gold">
                Save passphrase
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-lg border border-[#D4AF37]/20 bg-black/25 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#D4AF37]">
            <LockKeyhole size={16} /> Change admin PIN
          </div>
          <form onSubmit={submitPin} className="grid gap-2 md:grid-cols-3">
            <input
              className="ss-input"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              placeholder="Current PIN"
              value={pin.currentPin}
              onChange={(e) => setPin((p) => ({ ...p, currentPin: e.target.value }))}
              required
            />
            <input
              className="ss-input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder="New PIN"
              value={pin.newPin}
              onChange={(e) => setPin((p) => ({ ...p, newPin: e.target.value }))}
              required
            />
            <input
              className="ss-input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              placeholder="Confirm new PIN"
              value={pin.confirmPin}
              onChange={(e) => setPin((p) => ({ ...p, confirmPin: e.target.value }))}
              required
            />
            <div className="md:col-span-3">
              <button type="submit" disabled={busy === "pin"} className="admin-btn admin-btn--gold">
                Save PIN
              </button>
            </div>
          </form>
        </section>
      </main>
      <style>{`.ss-input{width:100%;background:#000;border:1px solid rgba(212,175,55,0.3);border-radius:4px;padding:8px;color:#E8E4DC;font-size:13px;outline:none}.ss-input:focus{border-color:#D4AF37}`}</style>
    </div>
  );
}
