import { useState, useEffect } from "react";
import { Shield, Mail, CheckCircle, AlertCircle, Loader2, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import CertIdInput from "@/components/cert-id-input";

export default function ClaimPage() {
  const [certId, setCertId] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [declaredNew, setDeclaredNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get("success");
    const error = params.get("error");
    const verifiedCertId = params.get("certId");

    if (success === "true" && verifiedCertId) {
      setResult({ type: "success", message: `Ownership of certificate ${verifiedCertId} has been successfully registered and linked to your email.` });
      window.history.replaceState({}, "", "/claim");
    } else if (error) {
      setResult({ type: "error", message: decodeURIComponent(error) });
      window.history.replaceState({}, "", "/claim");
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!certId.trim() || !claimCode.trim() || !email.trim()) return;

    setLoading(true);
    setResult(null);

    try {
      const res = await apiRequest("POST", "/api/claim/request", {
        certId: certId.trim(),
        claimCode: claimCode.trim(),
        email: email.trim(),
        name: fullName.trim() || undefined,
        declaredNew,
      });
      const data = await res.json();
      setResult({ type: "success", message: data.message });
    } catch (err: any) {
      let msg = "An error occurred. Please try again.";
      try {
        const body = await err.json?.();
        if (body?.error) msg = body.error;
      } catch {}
      setResult({ type: "error", message: msg });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-lg mx-auto">
        <div className="text-center mb-8">
          <Shield className="w-12 h-12 text-[#D4AF37] mx-auto mb-4" />
          <h1 className="text-3xl font-sans font-bold text-[#1A1A1A] tracking-tight" data-testid="text-claim-title">
            Claim Your Card
          </h1>
          <p className="text-[#666666] mt-2">
            Register first-time ownership of your MintVault graded card
          </p>
        </div>

        {result && (
          <div className={`mb-6 flex items-start gap-3 p-4 rounded-lg border ${
            result.type === "success"
              ? "bg-green-950/30 border-green-600"
              : "bg-red-100 border-red-300"
          }`}>
            {result.type === "success" ? (
              <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-red-600" />
            )}
            <p className={`text-sm font-medium ${result.type === "success" ? "text-green-300" : "text-red-800"}`} data-testid="text-claim-result">
              {result.message}
            </p>
          </div>
        )}

        <div className="relative z-[3] border border-[#D4AF37]/30 bg-white rounded-2xl p-6">
          <h2 className="text-[#D4AF37] text-lg font-semibold mb-6">First-Time Ownership Registration</h2>
          <div>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="certId" className="text-[#444444]">Certificate Number</Label>
                <CertIdInput
                  id="certId"
                  testId="input-cert-id"
                  placeholder="141"
                  value={certId}
                  onChange={setCertId}
                  className="rounded-md"
                />
                <p className="text-xs text-[#999999]">
                  Found on your MintVault label — just the number after &apos;MV&apos;
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="claimCode" className="text-[#444444] flex items-center gap-1.5">
                  <Key size={13} className="text-[#D4AF37]" />
                  Claim Code
                </Label>
                <Input
                  id="claimCode"
                  data-testid="input-claim-code"
                  placeholder="e.g. A3K9X2M7PQ4R"
                  value={claimCode}
                  onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                  className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999] font-mono tracking-widest"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <p className="text-xs text-[#999999]">
                  Found on the certificate insert card included with your returned slab. This code is unique to your certificate.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="fullName" className="text-[#444444]">Your Full Name</Label>
                <Input
                  id="fullName"
                  data-testid="input-claim-name"
                  type="text"
                  placeholder="e.g. James Smith"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999]"
                  autoComplete="name"
                />
                <p className="text-xs text-[#999999]">
                  Your name will appear on your Certificate of Authenticity PDF.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-[#444444]">Your Email Address</Label>
                <Input
                  id="email"
                  data-testid="input-claim-email"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999]"
                />
                <p className="text-xs text-[#999999]">
                  We'll send a verification link to confirm your ownership.
                </p>
              </div>

              <label className="flex items-start gap-3 pt-2 cursor-pointer select-none">
                <input
                  id="declaredNew"
                  data-testid="input-declared-new"
                  type="checkbox"
                  checked={declaredNew}
                  onChange={(e) => setDeclaredNew(e.target.checked)}
                  className="mt-1 w-4 h-4 accent-[#D4AF37] cursor-pointer"
                />
                <span className="text-sm text-[#444444] leading-snug">
                  I am the first keeper of this card since grading (no previous owners).
                  <span className="block text-xs text-[#999999] mt-1">
                    Tick only if no-one else has owned this card between grading and now. Recorded on the Logbook.
                  </span>
                </span>
              </label>

              <Button
                type="submit"
                data-testid="button-submit-claim"
                disabled={loading || !certId.trim() || !claimCode.trim() || !email.trim()}
                className="btn-gold w-full text-[#1A1400] font-bold tracking-wide"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4 mr-2" />
                    REGISTER OWNERSHIP
                  </>
                )}
              </Button>
            </form>

            <div className="mt-6 pt-5">
              <h3 className="text-sm font-semibold text-[#666666] mb-3">How it works</h3>
              <ol className="text-xs text-[#999999] space-y-2 list-decimal list-inside">
                <li>Enter your MintVault certificate number and claim code</li>
                <li>Provide your email address</li>
                <li>Check your inbox for a verification link</li>
                <li>Click the link to confirm and register ownership</li>
              </ol>
              <p className="text-xs text-[#999999] mt-4">
                Your claim code is printed on the certificate insert included with every returned slab. If you have lost your insert, contact MintVault support.
              </p>
              <p className="text-xs text-[#999999] mt-3">
                Already own this card and want to transfer it to a new owner?{" "}
                <a href="/transfer" className="text-[#D4AF37] hover:underline">Transfer Ownership →</a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
