import { useState } from "react";
import { useLocation } from "wouter";
import { Search, Shield, Award, CheckCircle } from "lucide-react";
import SeoHead from "@/components/seo-head";

export default function CertLookupPage() {
  const [certId, setCertId] = useState("");
  const [, navigate] = useLocation();
  const [error, setError] = useState("");

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
      className="relative flex flex-col items-center px-4 py-16 overflow-hidden bg-white"
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
            "radial-gradient(ellipse 90% 65% at 50% -5%, rgba(212,175,55,0.10) 0%, rgba(180,130,30,0.04) 45%, transparent 70%)",
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

      <div className="relative z-10 w-full max-w-md">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <div className="text-center mb-10">
          {/* Eyebrow badge */}
          <div className="inline-flex items-center gap-2 border border-[#D4AF37]/45 bg-[#FAFAF8] rounded-full px-4 py-1.5 mb-6">
            <Shield size={11} className="text-[#D4AF37]" />
            <span className="text-[#D4AF37] text-[10px] tracking-[0.2em] uppercase font-semibold">
              Verification Portal
            </span>
          </div>

          {/* Heading */}
          <h1
            className="text-4xl md:text-5xl font-sans font-black text-[#1A1A1A] tracking-tight leading-none mb-0"
            data-testid="text-cert-title"
          >
            Certificate
            <br />
            Lookup
          </h1>

          {/* Gold hairline divider */}
          <div className="flex items-center gap-3 my-5 max-w-[200px] mx-auto">
            <div className="flex-1 h-px bg-gradient-to-r from-transparent to-[#D4AF37]/65" />
            <div className="w-1 h-1 rounded-full bg-[#D4AF37]/90" />
            <div className="flex-1 h-px bg-gradient-to-l from-transparent to-[#D4AF37]/65" />
          </div>

          {/* Subtitle */}
          <p
            className="text-[#1A1A1A] text-sm leading-relaxed max-w-[320px] mx-auto"
            data-testid="text-cert-description"
          >
            Verify the authenticity of any MintVault graded card. Enter the
            certificate ID from your slab label.
          </p>
        </div>

        {/* ── Search panel ─────────────────────────────────────── */}
        <div
          className="glass-card relative rounded-2xl p-7 mb-8"
        >
          {/* Top edge highlight */}
          <div className="absolute top-0 left-10 right-10 h-px bg-gradient-to-r from-transparent via-[#D4AF37]/40 to-transparent" />

          <form onSubmit={handleSearch} className="space-y-3">
            <div className="flex gap-2.5">
              <div className="flex-1 relative">
                <Search
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#D4AF37]/65 pointer-events-none"
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
                  style={{ background: "#FFFFFF" }}
                  className="w-full border border-[#D4AF37]/40 rounded-xl px-4 py-3 pl-10 text-[#1A1A1A] placeholder:text-[#D4AF37]/45 focus:outline-none focus:border-[#D4AF37]/70 transition-all font-mono text-sm"
                />
              </div>
              <button
                type="submit"
                data-testid="button-cert-search"
                className="gold-shimmer px-7 py-3 rounded-xl font-black tracking-widest text-sm shrink-0 text-[#1A1400] active:scale-95 transition-transform"
              >
                Verify →
              </button>
            </div>
            {error && (
              <p className="text-red-600 text-xs pt-0.5" data-testid="text-cert-error">
                {error}
              </p>
            )}
          </form>

          {/* Sample certs */}
          <div className="mt-6 pt-5 border-t border-[#D4AF37]/25">
            <p className="text-[#D4AF37]/60 text-[10px] uppercase tracking-[0.2em] mb-3 text-center">
              Sample certificates
            </p>
            <div className="flex gap-2 justify-center">
              {["MV3", "MV4", "MV5"].map((id) => (
                <button
                  key={id}
                  onClick={() => navigate(`/cert/${id}`)}
                  className="relative z-[3] border border-[#D4AF37]/25 bg-[#FAFAF8] hover:bg-[#FAFAF8] hover:border-[#D4AF37]/50 rounded-md px-5 py-2 font-mono text-xs text-[#D4AF37]/70 hover:text-[#D4AF37] transition-all"
                  data-testid={`link-sample-cert-${id}`}
                >
                  {id}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Trust badges ─────────────────────────────────────── */}
        <div className="border-t border-[#E8E4DC] pt-6 mb-16 reveal-on-scroll">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2.5">
            {[
              { icon: <Shield size={11} />, label: "Tamper-Evident Slabs" },
              { icon: <Award size={11} />, label: "Professional Grading" },
              { icon: <CheckCircle size={11} />, label: "Public Verification" },
            ].map(({ icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-1.5 text-[#D4AF37]/60 text-[11px] tracking-wide"
              >
                {icon}
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
