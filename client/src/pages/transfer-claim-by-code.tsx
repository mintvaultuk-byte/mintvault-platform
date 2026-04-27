import { useState } from "react";
import { Shield, Mail, CheckCircle, AlertCircle, Loader2, Key } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import CertIdInput from "@/components/cert-id-input";

/**
 * v435 — Buyer-initiated transfer.
 * The new claimant has the printed insert with cert ID + claim code (e.g. they
 * bought the slab on eBay) and starts a transfer from this page. The current
 * keeper is then notified by email and has 14 days to confirm or dispute.
 */
export default function TransferClaimByCodePage() {
  const [certId, setCertId] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!certId.trim() || !claimCode.trim() || !email.trim() || !agreed) return;

    setLoading(true);
    setResult(null);

    try {
      const res = await apiRequest("POST", "/api/v2/transfers/claim-by-code", {
        certId: certId.trim(),
        claimCode: claimCode.trim(),
        claimantEmail: email.trim(),
        claimantName: fullName.trim() || undefined,
      });
      const data = await res.json();
      setResult({
        type: "success",
        message: data.message || "Transfer requested. The current keeper has been notified by email and has 14 days to confirm or dispute.",
      });
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
          <h1 className="text-3xl font-sans font-bold text-[#1A1A1A] tracking-tight" data-testid="text-transfer-claim-title">
            Request Transfer
          </h1>
          <p className="text-[#666666] mt-2">
            Bought a MintVault slab? Use the cert ID and claim code from the printed insert to request a transfer.
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
            <p className={`text-sm font-medium ${result.type === "success" ? "text-green-300" : "text-red-800"}`} data-testid="text-transfer-claim-result">
              {result.message}
            </p>
          </div>
        )}

        <div className="relative z-[3] border border-[#D4AF37]/30 bg-white rounded-2xl p-6">
          <h2 className="text-[#D4AF37] text-lg font-semibold mb-2">Buyer-Initiated Transfer</h2>
          <p className="text-xs text-[#999999] mb-6">
            The current registered keeper will be emailed and must explicitly confirm or dispute within 14 days. If they do not respond, the transfer expires and ownership stays with them.
          </p>

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
              <p className="text-xs text-[#999999]">From the slab label or the claim insert (number after &apos;MV&apos;).</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="claimCode" className="text-[#444444] flex items-center gap-1.5">
                <Key size={13} className="text-[#D4AF37]" />
                Claim Code
              </Label>
              <Input
                id="claimCode"
                data-testid="input-claim-code"
                placeholder="e.g. A3K9-X2M7-PQ4R"
                value={claimCode}
                onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999] font-mono tracking-widest"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <p className="text-xs text-[#999999]">
                Printed on the claim insert that came with the physical slab.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fullName" className="text-[#444444]">Your Full Name (optional)</Label>
              <Input
                id="fullName"
                data-testid="input-claimant-name"
                type="text"
                placeholder="e.g. James Smith"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999]"
                autoComplete="name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email" className="text-[#444444]">Your Email Address</Label>
              <Input
                id="email"
                data-testid="input-claimant-email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999]"
              />
              <p className="text-xs text-[#999999]">
                We&apos;ll email you when the current keeper responds, or after the 14-day deadline.
              </p>
            </div>

            <label className="flex items-start gap-3 pt-2 cursor-pointer select-none">
              <input
                id="agreed"
                data-testid="input-transfer-tos"
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-1 w-4 h-4 accent-[#D4AF37] cursor-pointer"
              />
              <span className="text-sm text-[#444444] leading-snug">
                I confirm I am the rightful new owner of this certificate, having purchased or received it legitimately, and have the printed claim insert.
                <span className="block text-xs text-[#999999] mt-1">
                  Fraudulent claims may result in a permanent ban and legal action.
                </span>
              </span>
            </label>

            <Button
              type="submit"
              data-testid="button-submit-transfer-claim"
              disabled={loading || !certId.trim() || !claimCode.trim() || !email.trim() || !agreed}
              className="btn-gold w-full text-[#1A1400] font-bold tracking-wide"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Requesting transfer...
                </>
              ) : (
                <>
                  <Mail className="w-4 h-4 mr-2" />
                  REQUEST TRANSFER
                </>
              )}
            </Button>
          </form>

          <div className="mt-6 pt-5 border-t border-[#D4AF37]/10">
            <h3 className="text-sm font-semibold text-[#666666] mb-3">How it works</h3>
            <ol className="text-xs text-[#999999] space-y-2 list-decimal list-inside">
              <li>Enter the cert ID + claim code from your insert.</li>
              <li>The current keeper is emailed and has 14 days to respond.</li>
              <li>If they confirm: a 14-day dispute window starts before the transfer finalises.</li>
              <li>If they dispute: no transfer happens; original ownership preserved.</li>
              <li>If they ignore the email for 14 days: the transfer expires; original ownership preserved.</li>
            </ol>
            <p className="text-xs text-[#999999] mt-4">
              First-time owner registering ownership instead?{" "}
              <a href="/claim" className="text-[#D4AF37] hover:underline">Register Ownership →</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
