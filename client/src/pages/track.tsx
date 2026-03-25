import { useState } from "react";
import { Package, Search, Truck, CheckCircle, Clock, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { SUBMISSION_STATUS_LABELS } from "@shared/schema";

interface TrackingResult {
  submissionId: string;
  status: string;
  serviceTier: string | null;
  serviceType: string | null;
  cardCount: number;
  createdAt: string;
  receivedAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  returnTracking: string | null;
  returnCarrier: string | null;
  turnaroundDays: number | null;
}

const STATUS_ICON: Record<string, typeof Package> = {
  new: Package,
  paid: Package,
  received: CheckCircle,
  in_grading: Clock,
  ready_to_return: CheckCircle,
  shipped: Truck,
  completed: CheckCircle,
};

const STATUS_STEPS = [
  { key: "new", label: "Submitted" },
  { key: "received", label: "Received" },
  { key: "in_grading", label: "Grading" },
  { key: "ready_to_return", label: "Ready" },
  { key: "shipped", label: "Shipped" },
  { key: "completed", label: "Complete" },
];

function getStepIndex(status: string): number {
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : 0;
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
      const res = await apiRequest(
        "POST",
        `/api/submissions/${encodeURIComponent(trimmedId)}/track`,
        { email: trimmedEmail }
      );
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      const msg = err.message || "";
      if (msg.includes("404")) {
        setError("Submission not found. Please check your submission ID.");
      } else if (msg.includes("403")) {
        setError("Email address does not match this submission.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const currentStep = result ? getStepIndex(result.status) : -1;

  return (
    <div className="px-4 py-12 max-w-2xl mx-auto">
      <div className="text-center mb-10">
        <h1
          className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest mb-4 glow-gold"
          data-testid="text-track-title"
        >
          TRACK YOUR SUBMISSION
        </h1>
        <p className="text-gray-300 text-base leading-relaxed" data-testid="text-track-description">
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
            className="bg-transparent border-[#D4AF37]/40 pl-10 text-white placeholder:text-[#D4AF37]/30 focus:border-[#D4AF37] font-mono"
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
          className="bg-transparent border-[#D4AF37]/40 text-white placeholder:text-[#D4AF37]/30 focus:border-[#D4AF37]"
        />
        <Button
          type="submit"
          disabled={loading}
          data-testid="button-track-submit"
          className="w-full border border-[#D4AF37] bg-black text-[#D4AF37] font-semibold tracking-wide btn-gold-glow hover:bg-[#D4AF37]/10"
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
          <Card className="border-[#D4AF37]/20 bg-black/40">
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-[#D4AF37] text-lg font-mono" data-testid="text-track-result-id">
                {result.submissionId}
              </CardTitle>
              <Badge
                data-testid="badge-track-status"
                className="bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/30"
              >
                {SUBMISSION_STATUS_LABELS[result.status] || result.status}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-6 overflow-x-auto py-2">
                {STATUS_STEPS.map((step, idx) => {
                  const isActive = idx <= currentStep;
                  const isCurrent = idx === currentStep;
                  return (
                    <div key={step.key} className="flex flex-col items-center min-w-[60px]">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                          isCurrent
                            ? "bg-[#D4AF37] text-black"
                            : isActive
                            ? "bg-[#D4AF37]/30 text-[#D4AF37]"
                            : "bg-gray-800 text-gray-500"
                        }`}
                        data-testid={`step-${step.key}`}
                      >
                        {idx + 1}
                      </div>
                      <span
                        className={`text-xs mt-1 ${
                          isActive ? "text-[#D4AF37]" : "text-gray-500"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                {result.serviceType && (
                  <div>
                    <span className="text-gray-500">Service</span>
                    <p className="text-gray-200 capitalize" data-testid="text-track-service">
                      {result.serviceType}
                    </p>
                  </div>
                )}
                {result.serviceTier && (
                  <div>
                    <span className="text-gray-500">Tier</span>
                    <p className="text-gray-200 uppercase" data-testid="text-track-tier">
                      {result.serviceTier}
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-gray-500">Cards</span>
                  <p className="text-gray-200" data-testid="text-track-cards">
                    {result.cardCount}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Submitted</span>
                  <p className="text-gray-200" data-testid="text-track-date">
                    {new Date(result.createdAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                </div>
                {result.turnaroundDays && (
                  <div>
                    <span className="text-gray-500">Est. Turnaround</span>
                    <p className="text-gray-200" data-testid="text-track-turnaround">
                      {result.turnaroundDays} working days
                    </p>
                  </div>
                )}
                {result.receivedAt && (
                  <div>
                    <span className="text-gray-500">Received</span>
                    <p className="text-gray-200" data-testid="text-track-received">
                      {new Date(result.receivedAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                )}
              </div>

              {(result.status === "shipped" || result.status === "completed") && result.returnTracking && (
                <div className="border-t border-[#D4AF37]/10 pt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Truck size={16} className="text-[#D4AF37]" />
                    <span className="text-gray-300 text-sm font-medium">Return Shipping</span>
                  </div>
                  {result.returnCarrier && (
                    <p className="text-gray-400 text-sm" data-testid="text-track-carrier">
                      Carrier: {result.returnCarrier}
                    </p>
                  )}
                  <p className="text-[#D4AF37] font-mono text-sm" data-testid="text-track-tracking">
                    {result.returnTracking}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
