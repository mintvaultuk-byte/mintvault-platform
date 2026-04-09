import { useState } from "react";
import { useLocation, Link } from "wouter";
import AuthRequiredPage from "@/components/auth-required-page";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Eye, EyeOff, Loader2, Lock, Mail, User, Trash2,
  CheckCircle, AlertTriangle, Settings,
} from "lucide-react";
import SeoHead from "@/components/seo-head";

interface AuthMe {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
  created_at: string;
}

function passwordStrength(pw: string): { level: "weak" | "medium" | "strong"; label: string; color: string } {
  const ok = /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw) && pw.length >= 10;
  if (!ok) return { level: "weak", label: "Weak", color: "#ef4444" };
  if (pw.length < 14) return { level: "medium", label: "Medium", color: "#f59e0b" };
  return { level: "strong", label: "Strong", color: "#22c55e" };
}

type Tab = "profile" | "password" | "email" | "danger";

// ── Shared field wrapper ───────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-bold text-[#888888] uppercase tracking-wider mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function InputBase({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full px-3 py-2.5 border border-[#E8E4DC] rounded-lg text-sm focus:outline-none focus:border-[#D4AF37] transition-colors ${className}`}
    />
  );
}

function GoldButton({
  children, className = "", ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`px-6 py-2.5 rounded-xl font-bold text-sm text-[#1A1400] flex items-center justify-center gap-2 disabled:opacity-60 transition-all ${className}`}
      style={{ background: "linear-gradient(135deg,#B8960C,#D4AF37)" }}
    >
      {children}
    </button>
  );
}

function SuccessBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
      <CheckCircle size={15} className="shrink-0" />
      {msg}
    </div>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{msg}</p>
  );
}

// ── Profile tab ────────────────────────────────────────────────────────────────
function ProfileTab({ me }: { me: AuthMe }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(me.display_name ?? "");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/auth/profile", { display_name: displayName.trim() || null }),
    onSuccess: () => {
      setSuccess("Display name updated.");
      setError("");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
    onError: (err: Error) => { setError(err.message); setSuccess(""); },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
    >
      <Field label="Email Address">
        <div className="relative">
          <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
          <InputBase value={me.email} readOnly className="pl-9 bg-[#FAFAF8] text-[#888888] cursor-not-allowed" />
        </div>
        <p className="text-xs text-[#AAAAAA] mt-1">To change your email, use the Email tab.</p>
      </Field>

      <Field label="Display Name (optional)">
        <div className="relative">
          <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
          <InputBase
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="How we'll address you"
            className="pl-9"
          />
        </div>
      </Field>

      {success && <SuccessBanner msg={success} />}
      {error && <ErrorBanner msg={error} />}

      <GoldButton type="submit" disabled={mutation.isPending}>
        {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
        Save Changes
      </GoldButton>
    </form>
  );
}

// ── Password tab ───────────────────────────────────────────────────────────────
function PasswordTab() {
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const strength = passwordStrength(newPw);

  const mutation = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/auth/change-password", {
      current_password: currentPw,
      new_password: newPw,
    }),
    onSuccess: () => {
      setSuccess("Password changed. A confirmation email has been sent.");
      setError("");
      setCurrentPw(""); setNewPw("");
    },
    onError: (err: Error) => { setError(err.message); setSuccess(""); },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (strength.level === "weak") {
      setError("New password must be 10+ characters with a letter and number.");
      return;
    }
    mutation.mutate();
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <Field label="Current Password">
        <div className="relative">
          <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
          <InputBase
            type={showCurrent ? "text" : "password"} required
            value={currentPw} onChange={e => setCurrentPw(e.target.value)}
            placeholder="Your current password"
            className="pl-9 pr-10"
          />
          <button type="button" onClick={() => setShowCurrent(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA]">
            {showCurrent ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </Field>

      <Field label="New Password">
        <div className="relative">
          <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
          <InputBase
            type={showNew ? "text" : "password"} required
            value={newPw} onChange={e => setNewPw(e.target.value)}
            placeholder="10+ characters, letter + number"
            className="pl-9 pr-10"
          />
          <button type="button" onClick={() => setShowNew(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA]">
            {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {newPw.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-[#E8E4DC] overflow-hidden">
              <div className="h-full rounded-full transition-all"
                style={{ width: strength.level === "weak" ? "33%" : strength.level === "medium" ? "66%" : "100%", background: strength.color }} />
            </div>
            <span className="text-xs font-bold" style={{ color: strength.color }}>{strength.label}</span>
          </div>
        )}
      </Field>

      {success && <SuccessBanner msg={success} />}
      {error && <ErrorBanner msg={error} />}

      <GoldButton type="submit" disabled={mutation.isPending}>
        {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
        Update Password
      </GoldButton>
    </form>
  );
}

// ── Email tab ──────────────────────────────────────────────────────────────────
function EmailTab({ me }: { me: AuthMe }) {
  const queryClient = useQueryClient();
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/auth/change-email", {
      new_email: newEmail.trim().toLowerCase(),
      password,
    }),
    onSuccess: () => {
      setSuccess("Email updated. Check your new inbox for a verification link.");
      setError("");
      setNewEmail(""); setPassword("");
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
    onError: (err: Error) => { setError(err.message); setSuccess(""); },
  });

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}>
      <Field label="Current Email">
        <div className="relative">
          <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
          <InputBase value={me.email} readOnly className="pl-9 bg-[#FAFAF8] text-[#888888] cursor-not-allowed" />
        </div>
      </Field>

      <Field label="New Email Address">
        <div className="relative">
          <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
          <InputBase
            type="email" required
            value={newEmail} onChange={e => setNewEmail(e.target.value)}
            placeholder="new@email.com"
            className="pl-9"
          />
        </div>
      </Field>

      <Field label="Confirm with Password">
        <div className="relative">
          <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
          <InputBase
            type={showPw ? "text" : "password"} required
            value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Your current password"
            className="pl-9 pr-10"
          />
          <button type="button" onClick={() => setShowPw(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA]">
            {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </Field>

      {success && <SuccessBanner msg={success} />}
      {error && <ErrorBanner msg={error} />}

      <GoldButton type="submit" disabled={mutation.isPending}>
        {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
        Update Email
      </GoldButton>
    </form>
  );
}

// ── Danger zone tab ────────────────────────────────────────────────────────────
function DangerTab() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/auth/delete-account", {
      password,
      confirm: confirm,
    }),
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/me"], null);
      navigate("/");
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (confirm !== "DELETE") {
      setError('Please type DELETE (all caps) to confirm.');
      return;
    }
    mutation.mutate();
  };

  return (
    <div>
      <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
        <AlertTriangle size={18} className="text-red-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-bold text-red-700 mb-1">Permanent action</p>
          <p className="text-xs text-red-600">
            Deleting your account will remove your personal information. Your certificates and
            ownership history are preserved for registry integrity, but all account data (name,
            email, login) will be anonymised. This cannot be undone.
          </p>
        </div>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <Field label="Your Password">
          <div className="relative">
            <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#CCCCCC]" />
            <InputBase
              type={showPw ? "text" : "password"} required
              value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Confirm with your password"
              className="pl-9 pr-10"
            />
            <button type="button" onClick={() => setShowPw(s => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA]">
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </Field>

        <Field label='Type DELETE to confirm'>
          <InputBase
            type="text" required
            value={confirm} onChange={e => setConfirm(e.target.value)}
            placeholder="DELETE"
          />
        </Field>

        {error && <ErrorBanner msg={error} />}

        <button
          type="submit"
          disabled={mutation.isPending || confirm !== "DELETE"}
          className="w-full py-3 rounded-xl font-bold text-sm text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all"
        >
          {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          Delete My Account
        </button>
      </form>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function AccountSettingsPage() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<Tab>("profile");

  const { data: me, isLoading } = useQuery<AuthMe | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me");
      if (res.status === 401) return null;
      return res.json();
    },
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center">
        <Loader2 size={28} className="text-[#D4AF37] animate-spin" />
      </div>
    );
  }

  if (!me) {
    return <AuthRequiredPage currentPath="/account/settings" />;
  }

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "profile",  label: "Profile",       icon: <User size={14} /> },
    { key: "password", label: "Password",       icon: <Lock size={14} /> },
    { key: "email",    label: "Email",          icon: <Mail size={14} /> },
    { key: "danger",   label: "Delete Account", icon: <Trash2 size={14} /> },
  ];

  return (
    <>
      <SeoHead
        title="Account Settings | MintVault UK"
        description="Manage your MintVault account settings — profile, password, email, and more."
        canonical="https://mintvaultuk.com/account/settings"
      />
      <div className="min-h-screen bg-[#FAFAF8] px-4 py-12">
        <div className="max-w-2xl mx-auto">

          {/* Page header */}
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/30 flex items-center justify-center">
              <Settings size={18} className="text-[#D4AF37]" />
            </div>
            <div>
              <h1 className="text-xl font-black text-[#1A1A1A]">
                Account Settings
              </h1>
              <p className="text-xs text-[#888888]">{me.email}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
            {/* Sidebar tabs */}
            <nav className="flex md:flex-col gap-1 flex-wrap">
              {TABS.map(t => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all text-left ${
                    tab === t.key
                      ? "bg-[#D4AF37]/10 text-[#B8960C] border border-[#D4AF37]/30"
                      : t.key === "danger"
                        ? "text-red-500 hover:bg-red-50"
                        : "text-[#666666] hover:bg-[#F5F2EB]"
                  }`}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
              <div className="hidden md:block mt-4 pt-4 border-t border-[#E8E4DC]">
                <Link href="/dashboard" className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm text-[#666666] hover:bg-[#F5F2EB] transition-all">
                  ← Dashboard
                </Link>
              </div>
            </nav>

            {/* Panel */}
            <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6 md:p-8">
              {tab === "profile"  && <ProfileTab me={me} />}
              {tab === "password" && <PasswordTab />}
              {tab === "email"    && <EmailTab me={me} />}
              {tab === "danger"   && <DangerTab />}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
