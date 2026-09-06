import { useState } from "react";
import { Search, Truck, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { SUBMISSION_STATUS_LABELS } from "@shared/commerce";
import { carrierIdFromLegacyName, carrierLabel, serviceLabel, trackUrl } from "@shared/carriers";
import SubmissionProgress, { CUSTOMER_LABELS } from "@/components/submission-progress";

interface TrackingResult {
  submissionId: string;
  status: string;
  serviceTier: string | null;
  serviceType: string | null;
  cardCount: number;
  createdAt: string;
  receivedAt: string | null;
  inGradingAt: string | null;
  readyToReturnAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  returnTracking: string | null;
  returnCarrier: string | null;
  returnService: string | null;
  turnaroundDays: number | null;
}

export default function TrackPage() {
  const [submissionId, setSubmissionId] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrackingResult | null>(null);

  const handleTrack = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResult(null);

    const trimmedId = submissionId.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedId) {
      setError("Please enter your submission ID");
      return;
    }
    if (!trimmedEmail) {
      setError("Please enter your email address");
      return;
    }

    setLoading(true);
    try {
      const res = await apiRequest("POST", `/api/submissions/${encodeURIComponent(trimmedId)}/track`, {
        email: trimmedEmail,
      });
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      const msg = err.message || "";
      if (msg.includes("404") || msg.includes("403")) {
        // Keep missing ids and mismatched email addresses indistinguishable;
        // the server deliberately uses the same response for both.
        setError("Submission not found or details do not match. Check both entries and try again.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="px-4 py-12 max-w-2xl mx-auto">
      <div className="text-center mb-10">
        <h1
          className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest mb-4 glow-gold"
          data-testid="text-track-title"
        >
          TRACK YOUR SUBMISSION
        </h1>
        <p className="text-[#666666] text-base leading-relaxed" data-testid="text-track-description">
          Enter your submission ID and email address to check the status of your grading order.
        </p>
      </div>

      <form onSubmit={handleTrack} className="max-w-md mx-auto space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/40" size={18} />
          <Input
            type="text"
            value={submissionId}
            onChange={(e) => {
              setSubmissionId(e.target.value);
              setError("");
            }}
            placeholder="Submission ID (e.g. MV-SUB-001)"
            data-testid="input-track-submission-id"
            className="bg-transparent border-[#D4AF37]/40 pl-10 text-[#1A1A1A] placeholder:text-[#999999] focus:border-[#D4AF37] font-mono"
          />
        </div>
        <Input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError("");
          }}
          placeholder="Email address used at checkout"
          data-testid="input-track-email"
          className="bg-transparent border-[#D4AF37]/40 text-[#1A1A1A] placeholder:text-[#999999] focus:border-[#D4AF37]"
        />
        <Button
          type="submit"
          disabled={loading}
          data-testid="button-track-submit"
          className="w-full border border-[#D4AF37] bg-white text-[#D4AF37] font-semibold tracking-wide hover:bg-[#D4AF37]/10"
          variant="outline"
        >
          {loading ? "Looking up..." : "Track Submission"}
        </Button>
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm" data-testid="text-track-error">
            <AlertCircle size={14} />
            {error}
          </div>
        )}
      </form>

      {result && (
        <div className="mt-10 space-y-6">
          <Card className="border-[#D4AF37]/20 bg-[#FAFAF8]">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-[#D4AF37] text-lg font-mono" data-testid="text-track-result-id">
                {result.submissionId}
              </CardTitle>
              <Badge data-testid="badge-track-status" className="bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/30">
                {SUBMISSION_STATUS_LABELS[result.status] || result.status}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* 5-node progress stepper (shared with admin). Delivered
                  lights up only when carrier confirms delivery — today
                  manual via admin, later via Royal Mail Tracking API. */}
              <SubmissionProgress
                variant="customer"
                labels={CUSTOMER_LABELS}
                status={result.status}
                receivedAt={result.receivedAt}
                inGradingAt={result.inGradingAt}
                readyToReturnAt={result.readyToReturnAt}
                shippedAt={result.shippedAt}
                deliveredAt={result.deliveredAt}
              />

              <div className="grid grid-cols-2 gap-4 text-sm">
                {result.serviceType && (
                  <div>
                    <span className="text-[#999999]">Service</span>
                    <p className="text-gray-200 capitalize" data-testid="text-track-service">
                      {result.serviceType}
                    </p>
                  </div>
                )}
                {result.serviceTier && (
                  <div>
                    <span className="text-[#999999]">Tier</span>
                    <p className="text-gray-200 uppercase" data-testid="text-track-tier">
                      {result.serviceTier}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-gray-500">Cards</span>
                  <p className="text-[#1A1A1A]" data-testid="text-track-cards">
                    {result.cardCount}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Submitted</span>
                  <p className="text-[#1A1A1A]" data-testid="text-track-date">
                    {new Date(result.createdAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </div>
                {result.turnaroundDays && (
                  <div>
                    <span className="text-[#999999]">Est. Turnaround</span>
                    <p className="text-[#1A1A1A]" data-testid="text-track-turnaround">
                      {result.turnaroundDays} working days
                    </p>
                  </div>
                )}
                {result.receivedAt && (
                  <div>
                    <span className="text-[#999999]">Received</span>
                    <p className="text-[#1A1A1A]" data-testid="text-track-received">
                      {new Date(result.receivedAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                )}
              </div>

              {(result.status === "shipped" || result.status === "completed") &&
                result.returnTracking &&
                (() => {
                  // Carrier may be a stable id ("royal_mail") or a legacy
                  // free-text label ("Royal Mail") on historical rows — map
                  // through the shared helper before deriving labels + URL.
                  const cid = carrierIdFromLegacyName(result.returnCarrier);
                  const carrierDisplay = cid ? carrierLabel(cid) : result.returnCarrier || "";
                  const svcText = cid && result.returnService ? serviceLabel(cid, result.returnService) : null;
                  const href = cid ? trackUrl(cid, result.returnTracking) : null;
                  return (
                    <div className="border-t border-[#E8E4DC] pt-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Truck size={16} className="text-[#D4AF37]" />
                        <span className="text-[#444444] text-sm font-medium">Return Shipping</span>
                      </div>
                      {carrierDisplay && (
                        <p className="text-[#666666] text-sm" data-testid="text-track-carrier">
                          Carrier: {carrierDisplay}
                        </p>
                      )}
                      {svcText && (
                        <p className="text-[#666666] text-sm" data-testid="text-track-service">
                          Service: {svcText}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <button
                          type="button"
                          onClick={() => navigator.clipboard?.writeText(result.returnTracking ?? "")}
                          className="text-[#D4AF37] font-mono text-sm underline-offset-2 hover:underline cursor-pointer"
                          title="Click to copy tracking number"
                          data-testid="text-track-tracking"
                        >
                          {result.returnTracking}
                        </button>
                        {href && (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-2.5 py-1 rounded hover:bg-[#D4AF37]/20 transition-colors"
                            data-testid="link-track-carrier"
                          >
                            Track →
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })()}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
