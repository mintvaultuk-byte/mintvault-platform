import { useState } from "react";
import { useLocation } from "wouter";
import { Search, Lock } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

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
    <div className="px-4 py-12 max-w-2xl mx-auto">
      <div className="text-center mb-10">
        <h1
          className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest mb-4 glow-gold"
          data-testid="text-cert-title"
        >
          CERTIFICATE LOOKUP
        </h1>
        <p className="text-gray-300 text-base leading-relaxed" data-testid="text-cert-description">
          Verify the authenticity of any MintVault graded card. Enter the
          certificate ID found on your slab label.
        </p>
      </div>

      <form onSubmit={handleSearch} className="max-w-md mx-auto">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/40" size={18} />
            <input
              type="text"
              value={certId}
              onChange={(e) => {
                setCertId(e.target.value);
                setError("");
              }}
              placeholder="e.g. MV3"
              data-testid="input-cert-id"
              className="w-full bg-transparent border border-[#D4AF37]/40 rounded px-4 py-3 pl-10 text-white placeholder:text-[#D4AF37]/30 focus:outline-none focus:border-[#D4AF37] transition-colors font-mono"
            />
          </div>
          <button
            type="submit"
            data-testid="button-cert-search"
            className="border border-[#D4AF37] bg-black text-[#D4AF37] px-6 py-3 rounded font-semibold tracking-wide transition-all btn-gold-glow hover:bg-[#D4AF37]/10"
          >
            Search
          </button>
        </div>
        {error && (
          <p className="text-red-400 text-sm mt-2" data-testid="text-cert-error">{error}</p>
        )}
      </form>

      <div className="mt-16 text-center">
        <h3 className="text-[#D4AF37]/60 text-sm uppercase tracking-widest mb-4">
          Sample Certificate IDs
        </h3>
        <div className="flex flex-col gap-2 items-center">
          {["MV3", "MV4", "MV5"].map((id) => (
            <button
              key={id}
              onClick={() => navigate(`/cert/${id}`)}
              className="text-[#D4AF37]/70 hover:text-[#D4AF37] font-mono text-sm transition-colors"
              data-testid={`link-sample-cert-${id}`}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-20 text-center">
        {!showStaff ? (
          <button
            onClick={() => setShowStaff(true)}
            className="text-gray-600 hover:text-gray-400 text-xs transition-colors inline-flex items-center gap-1.5"
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
                className="flex-1 bg-transparent border border-gray-700 rounded px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-[#D4AF37]/50 transition-colors"
                data-testid="input-staff-password"
              />
              <button
                type="submit"
                disabled={staffLoading}
                className="border border-gray-700 hover:border-[#D4AF37]/40 text-gray-400 hover:text-[#D4AF37] px-4 py-2 rounded text-sm transition-colors disabled:opacity-50"
                data-testid="button-staff-login"
              >
                {staffLoading ? "..." : "Go"}
              </button>
            </div>
            {staffError && (
              <p className="text-red-400 text-xs" data-testid="text-staff-error">{staffError}</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
