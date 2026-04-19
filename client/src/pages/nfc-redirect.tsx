import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { ShieldCheck, Loader2, XCircle } from "lucide-react";

export default function NfcRedirectPage() {
  const { certId } = useParams<{ certId: string }>();
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<"verifying" | "redirecting" | "error">("verifying");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!certId) return;

    const verify = async () => {
      try {
        const res = await fetch(`/api/nfc/${encodeURIComponent(certId.toUpperCase())}`);
        if (!res.ok) {
          const { error: msg } = await res.json().catch(() => ({ error: "Certificate not found" }));
          setError(msg);
          setStatus("error");
          return;
        }
        const data = await res.json();
        setStatus("redirecting");
        setTimeout(() => setLocation(data.redirectTo || `/cert/${certId.toUpperCase()}`), 800);
      } catch {
        setError("Couldn't open this certificate.");
        setStatus("error");
      }
    };

    verify();
  }, [certId, setLocation]);

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-xs text-center">

        {/* Brand mark */}
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5"
          style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)" }}>
          <ShieldCheck className="h-8 w-8 text-[#1A1400]" />
        </div>
        <h1 className="text-lg font-black text-[#D4AF37] tracking-widest uppercase mb-1">MintVault</h1>
        <p className="text-[#999999] text-xs uppercase tracking-widest mb-8 font-mono">Scan Result</p>

        {status === "verifying" && (
          <div className="space-y-3">
            <Loader2 className="h-7 w-7 animate-spin text-[#D4AF37] mx-auto" />
            <p className="text-[#666666] text-sm">Opening certificate…</p>
            <p className="text-[#D4AF37]/30 text-xs font-mono">{certId?.toUpperCase()}</p>
          </div>
        )}

        {status === "redirecting" && (
          <div className="space-y-3">
            <Loader2 className="h-7 w-7 animate-spin text-[#D4AF37] mx-auto" />
            <p className="text-[#666666] text-sm">Opening certificate…</p>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-4">
            <XCircle className="h-7 w-7 text-red-400 mx-auto" />
            <p className="text-red-300 text-sm">{error || "This tag could not be verified."}</p>
            <a
              href="/cert"
              className="inline-block text-[#D4AF37] text-sm border border-[#D4AF37]/30 rounded-lg px-4 py-2 hover:bg-[#D4AF37]/10 transition-colors"
            >
              Search certificates manually
            </a>
          </div>
        )}

      </div>
    </div>
  );
}
