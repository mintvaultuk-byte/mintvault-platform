import { useState, useEffect } from "react";
import { Shield, Mail, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";

export default function ClaimPage() {
  const [certId, setCertId] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [, setLocation] = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get("success");
    const error = params.get("error");
    const verifiedCertId = params.get("certId");

    if (success === "true" && verifiedCertId) {
      setResult({ type: "success", message: `Ownership of certificate ${verifiedCertId} has been successfully claimed and linked to your email.` });
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
          <h1 className="text-3xl font-bold text-white tracking-wide" data-testid="text-claim-title">
            CLAIM YOUR CARD
          </h1>
          <p className="text-gray-400 mt-2">
            Register ownership of your MintVault graded card
          </p>
        </div>

        {result && (
          <Card className={`mb-6 border ${result.type === "success" ? "border-green-600 bg-green-950/30" : "border-red-600 bg-red-950/30"}`}>
            <CardContent className="flex items-start gap-3 pt-5 pb-4">
              {result.type === "success" ? (
                <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              )}
              <p className={`text-sm ${result.type === "success" ? "text-green-300" : "text-red-300"}`} data-testid="text-claim-result">
                {result.message}
              </p>
            </CardContent>
          </Card>
        )}

        <Card className="border-[#D4AF37]/20 bg-[#111]">
          <CardHeader>
            <CardTitle className="text-[#D4AF37] text-lg">Ownership Claim</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="certId" className="text-gray-300">Certificate Number</Label>
                <Input
                  id="certId"
                  data-testid="input-cert-id"
                  placeholder="e.g. MV-2025-0042"
                  value={certId}
                  onChange={(e) => setCertId(e.target.value)}
                  className="bg-black/50 border-gray-700 text-white placeholder:text-gray-500"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="claimCode" className="text-gray-300">Claim Code</Label>
                <Input
                  id="claimCode"
                  data-testid="input-claim-code"
                  placeholder="Enter your 12-character claim code"
                  value={claimCode}
                  onChange={(e) => setClaimCode(e.target.value.toUpperCase())}
                  className="bg-black/50 border-gray-700 text-white placeholder:text-gray-500 font-mono tracking-wider"
                />
                <p className="text-xs text-gray-500">
                  Your claim code was provided with your graded card or by MintVault directly.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-gray-300">Your Email Address</Label>
                <Input
                  id="email"
                  data-testid="input-claim-email"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-black/50 border-gray-700 text-white placeholder:text-gray-500"
                />
                <p className="text-xs text-gray-500">
                  We'll send a verification link to confirm your ownership.
                </p>
              </div>

              <Button
                type="submit"
                data-testid="button-submit-claim"
                disabled={loading || !certId.trim() || !claimCode.trim() || !email.trim()}
                className="w-full bg-[#D4AF37] hover:bg-[#B8962E] text-black font-bold tracking-wide"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4 mr-2" />
                    CLAIM OWNERSHIP
                  </>
                )}
              </Button>
            </form>

            <div className="mt-6 pt-5 border-t border-gray-800">
              <h3 className="text-sm font-semibold text-gray-400 mb-3">How it works</h3>
              <ol className="text-xs text-gray-500 space-y-2 list-decimal list-inside">
                <li>Enter your certificate number and claim code</li>
                <li>Provide your email address</li>
                <li>Check your inbox for a verification link</li>
                <li>Click the link to confirm ownership</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
