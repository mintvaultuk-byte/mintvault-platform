import { useState } from "react";
import { useLocation } from "wouter";
import { Search, Lock, Shield, Award, CheckCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import SeoHead from "@/components/seo-head";

export default function CertLookupPage() {
  const [certId, setCertId] = useState("");
  const [, navigate] = useLocation();
  const [error, setError] = useState("");
  const [showStaff, setShowStaff] = useState(false);
  const [staffPassword, setStaffPassword] = useState("");
  const [staffError, setStaffError] = useState("");
  const [staffLoading, setStaffLoading] = useState(false);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = certId.trim().toUpperCase();
    if (!trimmed) {
      setError("Please enter a certificate ID");
      return;
    }
    setError("");
    navigate(`/cert/${trimmed}`);
  };

  return (
    <div
      className="relative flex flex-col items-center px-4 py-16 overflow-hidden bg-[#131313]"
      style={{ minHeight: "calc(100vh - 60px)" }}
    >
      <SeoHead
        title="Certificate Lookup | MintVault UK"
        description="Verify any MintVault-graded card instantly. Enter the certificate ID to view the grade, subgrades, and full authentication record."
        canonical="https://mintvaultuk.com/cert"
      />
      {/* Background: warm amber spotlight from top */}
      <div
        className="absolute top-0 left-0 right-0 h-[480px] pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 90% 65% at 50% -5%, rgba(242,202,80,0.10) 0%, rgba(180,130,30,0.04) 45%, transparent 70%)",
        }}
      />
      {/* Background: very faint bronze warmth at bottom */}
      <div
        className="absolute bottom-0 left-0 right-0 h-64 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 100%, rgba(100,65,10,0.04) 0%, transparent 70%)",
        }}
      />
      {/* Background: left/right vignette to focus the eye centre */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 100% at 50% 50%, transparent 40%, rgba(0,0,0,0.35) 100%)",
        }}
      />

      <div className="relative z-10 w-full max-w-md">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <div className="text-center mb-10">
          {/* Eyebrow badge */}
          <div className="inline-flex items-center gap-2 border border-[#f2ca50]/25 bg-[#f2ca50]/[0.06] rounded-full px-4 py-1.5 mb-6">
            <Shield size={11} className="text-[#f2ca50]" />
            <span className="text-[#f2ca50]/75 text-[10px] tracking-[0.2em] uppercase font-semibold">
              Verification Portal
            </span>
          </div>

          {/* Heading */}
          <h1
            className="text-4xl md:text-5xl font-black text-[#e5e2e1] tracking-tighter leading-none mb-0"
            data-testid="text-cert-title"
          >
            CERTIFICATE
            <br />
            LOOKUP
          </h1>

          {/* Gold hairline divider */}
          <div className="flex items-center gap-3 my-5 max-w-[200px] mx-auto">
            <div className="flex-1 h-px bg-gradient-to-r from-transparent to-[#f2ca50]/40" />
            <div className="w-1 h-1 rounded-full bg-[#f2ca50]/60" />
            <div className="flex-1 h-px bg-gradient-to-l from-transparent to-[#f2ca50]/40" />
          </div>

          {/* Subtitle */}
          <p
            className="text-[#e5e2e1]/60 text-sm leading-relaxed max-w-[320px] mx-auto"
            data-testid="text-cert-description"
          >
            Verify the authenticity of any MintVault graded card. Enter the
            certificate ID from your slab label.
          </p>
        </div>

        {/* ── Search panel ─────────────────────────────────────── */}
        <div
          className="relative rounded-2xl p-7 mb-8 bg-[#1c1b1b] border border-[#f2ca50]/12"
        >
          {/* Top edge highlight */}
          <div className="absolute top-0 left-10 right-10 h-px bg-gradient-to-r from-transparent via-[#f2ca50]/40 to-transparent" />

          <form onSubmit={handleSearch} className="space-y-3">
            <div className="flex gap-2.5">
              <div className="flex-1 relative">
                <Search
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#f2ca50]/40 pointer-events-none"
                  size={15}
                />
                <input
                  type="text"
                  value={certId}
                  onChange={(e) => {
                    setCertId(e.target.value);
                    setError("");
                  }}
                  placeholder="e.g. MV3"
                  data-testid="input-cert-id"
                  style={{ background: "rgba(19,19,19,0.8)" }}
                  className="w-full border border-[#f2ca50]/20 rounded-xl px-4 py-3 pl-10 text-[#e5e2e1] placeholder:text-[#f2ca50]/25 focus:outline-none focus:border-[#f2ca50]/50 transition-all font-mono text-sm"
                />
              </div>
              <button
                type="submit"
                data-testid="button-cert-search"
                className="px-7 py-3 rounded-xl font-black tracking-widest text-sm shrink-0 text-[#3c2f00] active:scale-95 transition-transform"
                style={{ background: "linear-gradient(135deg,#f2ca50 0%,#d4af37 100%)" }}
              >
                VERIFY
              </button>
            </div>
            {error && (
              <p className="text-red-400 text-xs pt-0.5" data-testid="text-cert-error">
                {error}
              </p>
            )}
          </form>

          {/* Sample certs */}
          <div className="mt-6 pt-5 border-t border-[#f2ca50]/[0.10]">
            <p className="text-[#f2ca50]/30 text-[10px] uppercase tracking-[0.2em] mb-3 text-center">
              Sample certificates
            </p>
            <div className="flex gap-2 justify-center">
              {["MV3", "MV4", "MV5"].map((id) => (
                <button
                  key={id}
                  onClick={() => navigate(`/cert/${id}`)}
                  className="border border-[#f2ca50]/20 bg-[#f2ca50]/[0.04] hover:bg-[#f2ca50]/[0.09] hover:border-[#f2ca50]/45 rounded-md px-5 py-2 font-mono text-xs text-[#f2ca50]/55 hover:text-[#f2ca50]/90 transition-all"
                  data-testid={`link-sample-cert-${id}`}
                >
                  {id}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Trust badges ─────────────────────────────────────── */}
        <div className="border-t border-[#f2ca50]/[0.07] pt-6 mb-20">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2.5">
            {[
              { icon: <Shield size={11} />, label: "Tamper-Evident Slabs" },
              { icon: <Award size={11} />, label: "Professional Grading" },
              { icon: <CheckCircle size={11} />, label: "Public Verification" },
            ].map(({ icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-1.5 text-[#f2ca50]/30 text-[11px] tracking-wide"
              >
                {icon}
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Staff access ─────────────────────────────────────── */}
        <div className="text-center">
          {!showStaff ? (
            <button
              onClick={() => setShowStaff(true)}
              className="text-gray-700 hover:text-gray-500 text-xs transition-colors inline-flex items-center gap-1.5"
              data-testid="button-staff-access"
            >
              <Lock size={10} />
              Staff access
            </button>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setStaffError("");
                setStaffLoading(true);
                try {
                  await apiRequest("POST", "/api/admin/session", { password: staffPassword });
                  navigate("/admin");
                } catch {
                  setStaffError("Incorrect password");
                } finally {
                  setStaffLoading(false);
                }
              }}
              className="max-w-xs mx-auto space-y-3"
            >
              <div className="flex gap-2">
                <input
                  type="password"
                  value={staffPassword}
                  onChange={(e) => { setStaffPassword(e.target.value); setStaffError(""); }}
                  placeholder="Staff password"
                  autoFocus
                  className="flex-1 bg-transparent border border-gray-800 rounded px-3 py-2 text-white text-sm placeholder:text-gray-700 focus:outline-none focus:border-[#f2ca50]/40 transition-colors"
                  data-testid="input-staff-password"
                />
                <button
                  type="submit"
                  disabled={staffLoading}
                  className="border border-gray-800 hover:border-[#f2ca50]/30 text-gray-600 hover:text-[#f2ca50] px-4 py-2 rounded text-sm transition-colors disabled:opacity-50"
                  data-testid="button-staff-login"
                >
                  {staffLoading ? "..." : "Go"}
                </button>
              </div>
              {staffError && (
                <p className="text-red-400 text-xs" data-testid="text-staff-error">
                  {staffError}
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
