import { useState, useEffect } from "react";
import { ShieldCheck, AlertCircle, Loader2, CheckCircle, KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";

type PageState =
  | { type: "form"; token: string }
  | { type: "success"; message: string }
  | { type: "error"; message: string; retryable: boolean };

export default function TransferAcceptPage() {
  const [referenceNumber, setReferenceNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [pageState, setPageState] = useState<PageState | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (!token) {
      setPageState({ type: "error", message: "Invalid or missing transfer link.", retryable: false });
    } else {
      setPageState({ type: "form", token });
    }
    // Clean the URL
    window.history.replaceState({}, "", "/transfer/accept");
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pageState || pageState.type !== "form") return;
    if (!referenceNumber.trim()) return;

    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/v2/transfers/incoming-confirm", {
        token: pageState.token,
        referenceNumber: referenceNumber.trim(),
      });
      const data = await res.json();
      setPageState({ type: "success", message: data.message || "Transfer verified. A 14-day dispute window is now active." });
    } catch (err: any) {
      let msg = "An error occurred. Please try again.";
      try {
        const body = await err.json?.();
        if (body?.error) msg = body.error;
      } catch {}
      // If it's a ref number mismatch, allow retry
      const retryable = msg.includes("Reference Number") || msg.includes("try again");
      setPageState({
        type: "error",
        message: msg,
        retryable,
      });
    } finally {
      setLoading(false);
    }
  }

  if (!pageState) return null;

  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-lg mx-auto">
        <div className="text-center mb-8">
          <ShieldCheck className="w-12 h-12 text-[#D4AF37] mx-auto mb-4" />
          <h1 className="text-3xl font-sans font-bold text-[#1A1A1A] tracking-tight">
            Accept Keepership Transfer
          </h1>
          <p className="text-[#666666] mt-2">
            Verify the Document Reference Number to accept this transfer
          </p>
        </div>

        {pageState.type === "success" && (
          <Card className="mb-6 border border-green-600/40 bg-green-50">
            <CardContent className="flex items-start gap-3 pt-5 pb-4">
              <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-green-800 font-semibold mb-1">Transfer Verified</p>
                <p className="text-sm text-green-700">{pageState.message}</p>
                <p className="text-xs text-[#999999] mt-3">
                  Both parties will be emailed when the transfer is finalised. If either party raises a dispute within 14 days, the transfer will be paused for review.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {pageState.type === "error" && (
          <Card className="mb-6 border border-red-300 bg-red-50">
            <CardContent className="flex items-start gap-3 pt-5 pb-4">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-700">{pageState.message}</p>
                {!pageState.retryable && (
                  <p className="text-xs text-[#999999] mt-2">
                    If you believe this is an error, contact <a href="mailto:support@mintvaultuk.com" className="text-[#D4AF37] hover:underline">support@mintvaultuk.com</a>.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {(pageState.type === "form" || (pageState.type === "error" && pageState.retryable)) && (
          <Card className="relative z-[3] border-[#D4AF37]/30 bg-white">
            <CardHeader>
              <CardTitle className="text-[#D4AF37] text-lg">Enter Document Reference Number</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="refNumber" className="text-[#444444]">Document Reference Number</Label>
                  <Input
                    id="refNumber"
                    placeholder="e.g. A7K3-B9M2-C4P8"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value.toUpperCase())}
                    className="bg-white border-[#D4AF37]/30 text-[#1A1A1A] placeholder:text-[#999999] font-mono text-lg tracking-wider"
                    maxLength={14}
                    autoComplete="off"
                  />
                  <p className="text-xs text-[#999999]">
                    This 12-character code is on the Logbook document that came with the card. The seller should have provided it to you.
                  </p>
                </div>

                <Button
                  type="submit"
                  disabled={loading || referenceNumber.replace(/-/g, "").length < 8}
                  className="btn-gold w-full text-[#1A1400] font-bold tracking-wide"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Verifying...
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4 mr-2" />
                      VERIFY & ACCEPT
                    </>
                  )}
                </Button>
              </form>

              <div className="mt-6 pt-5 border-t border-[#E8E4DC]">
                <h3 className="text-sm font-semibold text-[#666666] mb-3">What happens next</h3>
                <ol className="text-xs text-[#999999] space-y-2 list-decimal list-inside">
                  <li>Enter the Document Reference Number from the Logbook</li>
                  <li>A 14-day dispute window begins — either party can raise a dispute</li>
                  <li>If no disputes, the transfer finalises automatically and you become the Registered Keeper</li>
                  <li>Both parties receive confirmation emails when the transfer is complete</li>
                </ol>
                <p className="text-xs text-[#999999] mt-3">
                  Don't have the reference number? Ask the seller to provide the Logbook that accompanied the graded card.
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
