import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CheckCircle, Package, FileText, Download, Mail } from "lucide-react";
import { pricingTiers, submissionTypes, SUBMISSION_STATUS_LABELS } from "@shared/schema";

export default function SubmitSuccessPage() {
  const params = new URLSearchParams(window.location.search);
  const submissionId = params.get("id") || "";
  const psToken = params.get("pstoken") || "";

  const { data: submission, isLoading } = useQuery<any>({
    queryKey: ["/api/submissions", submissionId],
    enabled: !!submissionId,
  });

  if (isLoading) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="animate-pulse space-y-4">
          <div className="h-12 bg-[#D4AF37]/10 rounded w-12 mx-auto rounded-full" />
          <div className="h-6 bg-[#D4AF37]/10 rounded w-48 mx-auto" />
          <div className="h-4 bg-[#D4AF37]/10 rounded w-32 mx-auto" />
        </div>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="px-4 py-12 text-center">
        <h2 className="text-2xl font-bold text-[#D4AF37] mb-4 glow-gold-sm" data-testid="text-not-found">
          Submission Not Found
        </h2>
        <Link href="/submit">
          <button className="border border-[#D4AF37] bg-black text-[#D4AF37] px-6 py-2.5 rounded font-medium transition-all btn-gold-glow hover:bg-[#D4AF37]/10" data-testid="button-new-submission">
            Start New Submission
          </button>
        </Link>
      </div>
    );
  }

  const subId = submission.submissionId || submission.tracking_number;
  const tierData = pricingTiers.find((t) => t.id === (submission.serviceTier || submission.service_tier));
  const typeData = submissionTypes.find((t) => t.id === (submission.serviceType || submission.service_type));
  const statusLabel = SUBMISSION_STATUS_LABELS[(submission.status || "").toLowerCase()] || submission.status;
  const cardCount = submission.cardCount || submission.card_count || 0;
  const totalPrice = submission.totalPrice || submission.total_price || "0";

  return (
    <div className="px-4 py-12 max-w-xl mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 rounded-full border-2 border-emerald-400 flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="text-emerald-400" size={36} />
        </div>
        <h1 className="text-2xl md:text-3xl font-bold text-[#D4AF37] tracking-wide glow-gold-sm mb-2" data-testid="text-success-title">
          Submission Received!
        </h1>
        <p className="text-gray-400" data-testid="text-success-subtitle">
          Thank you for your order. Your submission has been confirmed.
        </p>
      </div>

      <div className="border border-[#D4AF37]/30 rounded-lg overflow-hidden mb-6">
        <div className="bg-[#D4AF37]/5 p-4 border-b border-[#D4AF37]/20 flex items-center gap-2">
          <FileText size={18} className="text-[#D4AF37]" />
          <h2 className="text-[#D4AF37] font-semibold tracking-wider text-sm uppercase">
            Submission Confirmation
          </h2>
        </div>
        <div className="p-5 space-y-3">
          <ConfirmRow label="Submission ID" value={subId} testId="text-confirm-id" highlight />
          <ConfirmRow label="Status" value={statusLabel} testId="text-confirm-status" />
          {typeData && <ConfirmRow label="Type" value={typeData.name} testId="text-confirm-type" />}
          {tierData && <ConfirmRow label="Tier" value={tierData.name} testId="text-confirm-tier" />}
          <ConfirmRow label="Quantity" value={`${cardCount} card${cardCount > 1 ? "s" : ""}`} testId="text-confirm-qty" />
          <ConfirmRow label="Total Paid" value={`£${parseFloat(totalPrice).toFixed(2)}`} testId="text-confirm-total" />
        </div>
      </div>

      <div className="border border-emerald-500/30 rounded-lg p-5 mb-6 bg-emerald-500/5">
        <div className="flex items-center gap-2 mb-3">
          <Download size={18} className="text-emerald-400" />
          <h3 className="text-emerald-400 font-semibold tracking-wider text-sm uppercase">
            Packing Slip
          </h3>
        </div>
        <p className="text-gray-300 text-sm mb-4">
          Download your packing slip and include it inside your package. This is essential for us to process your submission quickly.
        </p>
        <a
          href={`/api/submissions/${subId}/packing-slip?token=${psToken}`}
          className="inline-flex items-center gap-2 border border-emerald-500 bg-emerald-500/10 text-emerald-400 px-5 py-2.5 rounded font-medium tracking-wide text-sm transition-all hover:bg-emerald-500/20"
          data-testid="button-download-slip"
        >
          <Download size={16} /> Download Packing Slip (PDF)
        </a>
      </div>

      <div className="border border-[#D4AF37]/20 rounded-lg p-5 mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Package size={18} className="text-[#D4AF37]" />
          <h3 className="text-[#D4AF37] font-semibold tracking-wider text-sm uppercase">
            Shipping Instructions
          </h3>
        </div>
        <div className="text-gray-300 text-sm space-y-3">
          <div className="space-y-1.5">
            <p className="text-white font-medium text-xs uppercase tracking-wider">Before you ship:</p>
            <ol className="list-decimal list-inside text-gray-400 text-xs space-y-1">
              <li>Print the packing slip above and include it inside the box</li>
              <li>Write your Submission ID (<span className="text-[#D4AF37] font-mono font-bold">{subId}</span>) on the outside of the box</li>
              <li>Pack your cards securely with adequate protection</li>
              <li>Use tracked, insured shipping for your protection</li>
            </ol>
          </div>
          <p className="text-white font-medium text-xs uppercase tracking-wider mt-3">Send to:</p>
          <div className="border border-[#D4AF37]/10 rounded p-3 bg-[#D4AF37]/5 font-mono text-xs leading-relaxed" data-testid="text-shipping-address">
            MintVault Grading<br />
            2 Temple Gardens<br />
            Strood<br />
            Kent<br />
            ME2 2NG<br />
            United Kingdom
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <Link href="/submit" className="flex-1">
          <button className="w-full border border-[#D4AF37] bg-black text-[#D4AF37] py-2.5 rounded font-medium tracking-wide transition-all btn-gold-glow hover:bg-[#D4AF37]/10" data-testid="button-another-submission">
            Submit Another Order
          </button>
        </Link>
        <Link href="/" className="flex-1">
          <button className="w-full border border-[#D4AF37]/30 text-[#D4AF37]/60 py-2.5 rounded font-medium transition-all hover:border-[#D4AF37]/50 hover:text-[#D4AF37]" data-testid="button-back-home">
            Back to Home
          </button>
        </Link>
      </div>
    </div>
  );
}

function ConfirmRow({ label, value, testId, highlight }: { label: string; value: string; testId: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center border-b border-[#D4AF37]/10 pb-2 last:border-0">
      <span className="text-[#D4AF37]/60 text-sm">{label}</span>
      <span className={`font-medium text-sm ${highlight ? "text-[#D4AF37] font-mono font-bold" : "text-white"}`} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
