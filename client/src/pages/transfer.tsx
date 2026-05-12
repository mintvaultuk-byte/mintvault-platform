import { useState, useEffect } from "react";
import { ArrowRightLeft, Mail, CheckCircle, AlertCircle, Loader2, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import CertIdInput from "@/components/cert-id-input";

type PageState =
  | { type: "form" }
  | { type: "success"; message: string }
  | { type: "error"; message: string }
  | { type: "owner_confirmed"; certId: string }
  | { type: "outgoing_confirmed"; certId: string };

export default function TransferPage() {
  const [certId, setCertId] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [newOwnerName, setNewOwnerName] = useState("");
  const [loading, setLoading] = useState(false);
  const [pageState, setPageState] = useState<PageState>({ type: "form" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get("success");
    const error = params.get("error");
    const step = params.get("step");
    const verifiedCertId = params.get("certId");

    const version = params.get("v");

    if (success === "true" && verifiedCertId) {
      setPageState({ type: "success", message: `Ownership of certificate ${verifiedCertId} has been successfully transferred. The new owner now holds the registration.` });
      window.history.replaceState({}, "", "/transfer");
    } else if (step === "outgoing_confirmed" && verifiedCertId && version === "2") {
      setPageState({ type: "outgoing_confirmed", certId: verifiedCertId });
      window.history.replaceState({}, "", "/transfer");
    } else if (step === "owner_confirmed" && verifiedCertId) {
      setPageState({ type: "owner_confirmed", certId: verifiedCertId });
      window.history.replaceState({}, "", "/transfer");
    } else if (error) {
      const decoded = decodeURIComponent(error);
      const msg = decoded === "missing_token" ? "Invalid or missing confirmation link."
        : decoded === "server_error" ? "A server error occurred. Please try again."
        : decoded;
      setPageState({ type: "error", message: msg });
      window.history.replaceState({}, "", "/transfer");
    }

    // Pre-fill cert ID from URL (e.g. from logbook Transfer button)
    const prefillCert = params.get("certId");
    if (prefillCert && !success && !error && !step) {
      setCertId(prefillCert);
      window.history.replaceState({}, "", "/transfer");
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!certId.trim() || !fromEmail.trim() || !toEmail.trim()) return;

    setLoading(true);

    try {
      const res = await apiRequest("POST", "/api/v2/transfers/initiate", {
        certId: certId.trim(),
        fromEmail: fromEmail.trim(),
        toEmail: toEmail.trim(),
        newOwnerName: newOwnerName.trim() || undefined,
      });
      const data = await res.json();
      setPageState({ type: "success", message: data.message });
    } catch (err: any) {
      let msg = "An error occurred. Please try again.";
      try {
        const body = await err.json?.();
        if (body?.error) msg = body.error;
      } catch {}
      setPageState({ type: "error", message: msg });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-lg mx-auto">
        <div className="text-center mb-8">
          <ArrowRightLeft className="w-12 h-12 text-[#D4AF37] mx-auto mb-4" />
          <h1 className="text-3xl font-sans font-bold text-[#1A1A1A] tracking-tight">
            Transfer Ownership
          </h1>
          <p className="text-[#666666] mt-2">
            Transfer your MintVault graded card to a new owner
          </p>
        </div>

        {/* v2: Outgoing keeper confirmed — waiting for incoming keeper */}
        {pageState.type === "outgoing_confirmed" && (
          <Card className="mb-6 border border-[#D4AF37]/40 bg-[#FFF9E6]">
            <CardContent className="flex items-start gap-3 pt-5 pb-4">
              <Clock className="w-5 h-5 text-[#D4AF37] flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-[#D4AF37] font-semibold mb-1">Your authorisation received</p>
                <p className="text-sm text-[#444444]">
                  Certificate <strong className="text-[#1A1A1A]">{pageState.certId}</strong> — the new keeper has been emailed. They must verify the Document Reference Number from the Logbook within 14 days. A further 14-day dispute window applies after they confirm.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* v1: Owner confirmed — waiting for new owner */}
        {pageState.type === "owner_confirmed" && (
          <Card className="mb-6 border border-[#D4AF37]/40 bg-[#FFF9E6]">
            <CardContent className="flex items-start gap-3 pt-5 pb-4">
              <Clock className="w-5 h-5 text-[#D4AF37] flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-[#D4AF37] font-semibold mb-1">Your confirmation received</p>
                <p className="text-sm text-[#444444]">
                  Certificate <strong className="text-[#1A1A1A]">{pageState.certId}</strong> — the new owner has been emailed a confirmation link. The transfer will complete once they accept.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Success */}
        {pageState.type === "success" && (
          <Card className="mb-6 border border-green-600 bg-green-950/30">
            <CardContent className="flex items-start gap-3 pt-5 pb-4">
              <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-green-300">{pageState.message}</p>
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {pageState.type === "error" && (
          <Card className="mb-6 border border-red-600 bg-red-950/30">
            <CardContent className="flex items-start gap-3 pt-5 pb-4">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-300">{pageState.message}</p>
                <button
                  onClick={() => setPageState({ type: "form" })}
                  className="text-xs text-[#D4AF37] hover:underline mt-2 block"
                >
                  ← Try again
                </button>
              </div>
            </CardContent>
          </Card>
        )}

        {(pageState.type === "form" || pageState.type === "error") && (
          <Card className="relative z-[3] border-[#D4AF37]/30 bg-white">
            <CardHeader>
              <CardTitle className="text-[#D4AF37] text-lg">Ownership Transfer</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="certId" className="text-[#444444]">Certificate Number</Label>
                  <CertIdInput
                    id="certId"
                    placeholder="141"
                    value={certId}
                    onChange={setCertId}
                    className="rounded-md"
                  />
                  <p className="text-xs text-[#999999]">The certificate number from your slab label — just the number after &apos;MV&apos;</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="fromEmail" className="text-[#444444]">Your Email (Current Owner)</Label>
                  <Input
                    id="fromEmail"
                    type="email"
                    placeholder="your@email.com"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999]"
                  />
                  <p className="text-xs text-[#999999]">Must match the email you used to register ownership.</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="toEmail" className="text-[#444444]">New Owner's Email</Label>
                  <Input
                    id="toEmail"
                    type="email"
                    placeholder="newowner@email.com"
                    value={toEmail}
                    onChange={(e) => setToEmail(e.target.value)}
                    className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999]"
                  />
                  <p className="text-xs text-[#999999]">The person you are transferring the card to.</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="newOwnerName" className="text-[#444444]">New Owner's Full Name</Label>
                  <Input
                    id="newOwnerName"
                    type="text"
                    placeholder="e.g. James Smith"
                    value={newOwnerName}
                    onChange={(e) => setNewOwnerName(e.target.value)}
                    className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999]"
                    autoComplete="off"
                  />
                  <p className="text-xs text-[#999999]">Their name will appear on their Certificate of Authenticity PDF.</p>
                </div>

                <Button
                  type="submit"
                  disabled={loading || !certId.trim() || !fromEmail.trim() || !toEmail.trim()}
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
                      INITIATE TRANSFER
                    </>
                  )}
                </Button>
              </form>

              <div className="mt-6 pt-5 border-t border-[#E8E4DC]">
                <h3 className="text-sm font-semibold text-[#666666] mb-3">How transfer works</h3>
                <ol className="text-xs text-[#999999] space-y-2 list-decimal list-inside">
                  <li>You enter the certificate number, your email, and the new keeper's email</li>
                  <li>You receive a confirmation email — click to authorise the transfer</li>
                  <li>The new keeper receives an email — they verify the Document Reference Number from the Logbook</li>
                  <li>A 14-day dispute window begins — either party can raise a concern</li>
                  <li>Transfer finalises automatically — the registry is updated</li>
                </ol>
                <p className="text-xs text-[#999999] mt-3">
                  Registering a card for the first time?{" "}
                  <a href="/claim" className="text-[#D4AF37] hover:underline">Register Ownership →</a>
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
