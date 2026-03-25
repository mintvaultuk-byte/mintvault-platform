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
        setError("Failed to verify NFC tag.");
        setStatus("error");
      }
    };

    verify();
  }, [certId, setLocation]);

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center space-y-6">
        {/* Logo / branding */}
        <div className="flex justify-center">
          <ShieldCheck className="h-14 w-14 text-yellow-500" />
        </div>
        <h1 className="text-xl font-bold text-yellow-400 tracking-wide">MintVault</h1>
        <p className="text-gray-400 text-sm">Trading Card Grading</p>

        {status === "verifying" && (
          <div className="space-y-3">
            <Loader2 className="h-8 w-8 animate-spin text-yellow-500 mx-auto" />
            <p className="text-gray-300 text-sm">Verifying NFC tag…</p>
            <p className="text-gray-600 text-xs font-mono">{certId?.toUpperCase()}</p>
          </div>
        )}

        {status === "redirecting" && (
          <div className="space-y-3">
            <ShieldCheck className="h-8 w-8 text-emerald-400 mx-auto" />
            <p className="text-gray-300 text-sm">Verified — opening certificate…</p>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-4">
            <XCircle className="h-8 w-8 text-red-400 mx-auto" />
            <p className="text-red-300 text-sm">{error || "This tag could not be verified."}</p>
            <a
              href="/cert"
              className="inline-block text-yellow-500 text-sm underline underline-offset-2"
            >
              Search for a certificate manually
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
