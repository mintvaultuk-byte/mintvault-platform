import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_TRANSITIONS, pricingTiers, submissionTypes } from "@shared/schema";
import {
  CARRIERS,
  carrierIdFromLegacyName,
  carrierLabel,
  serviceLabel,
  servicesForCarrier,
  suggestServiceForSubmission,
} from "@shared/carriers";
import SubmissionProgress, { ADMIN_LABELS } from "@/components/submission-progress";
import {
  ArrowLeft,
  Package,
  Search,
  Printer,
  CheckCircle,
  Truck,
  Clock,
  MapPin,
  Phone,
  Mail,
  FileText,
  ChevronRight,
  ScanLine,
  X,
  Edit2,
  Save,
  XCircle,
  CreditCard,
  Download,
  Camera,
  Upload,
  Loader2,
} from "lucide-react";

interface SubmissionRow {
  id: number;
  submissionId: string;
  status: string;
  customerEmail: string;
  customerFirstName: string;
  customerLastName: string;
  phone: string;
  returnAddressLine1: string;
  returnAddressLine2: string;
  returnCity: string;
  returnCounty: string;
  returnPostcode: string;
  serviceType: string;
  serviceTier: string;
  turnaroundDays: number;
  cardCount: number;
  totalDeclaredValue: number;
  totalPrice: string;
  shippingCost: number;
  shippingInsuranceTier: string;
  gradingCost: number;
  insuranceFee: number;
  paymentIntentId: string;
  notes: string;
  receivedAt: string;
  inGradingAt: string | null;
  readyToReturnAt: string | null;
  shippedAt: string;
  deliveredAt: string | null;
  completedAt: string;
  returnCarrier: string;
  returnService: string | null;
  returnTracking: string;
  returnPostageCost: number;
  highValueFlag: boolean;
  requiresManualApproval: boolean;
  liabilityAccepted: boolean;
  crossoverCompany?: string;
  crossoverOriginalGrade?: string;
  crossoverCertNumber?: string;
  reholderCompany?: string;
  reholderReason?: string;
  reholderCondition?: string;
  authReason?: string;
  authConcerns?: string;
  adminNotes?: string | null;
  adminFlagged?: boolean;
  adminFlaggedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  items?: any[];
}

function statusColor(status: string) {
  switch (status?.toLowerCase()) {
    case "new":
    case "paid":
      return "bg-[color-mix(in_srgb,var(--admin-gold)_18%,transparent)] text-[var(--admin-gold-hi)] border-[var(--admin-line)]";
    case "received":
      return "bg-[color-mix(in_srgb,var(--admin-amber)_18%,transparent)] text-[var(--admin-amber)] border-[color-mix(in_srgb,var(--admin-amber)_40%,transparent)]";
    case "in_grading":
      return "bg-[color-mix(in_srgb,var(--admin-gold)_18%,transparent)] text-[var(--admin-gold-hi)] border-[var(--admin-line)]";
    case "ready_to_return":
      return "bg-[color-mix(in_srgb,var(--admin-green)_18%,transparent)] text-[var(--admin-green)] border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)]";
    case "shipped":
      return "bg-[color-mix(in_srgb,var(--admin-green)_18%,transparent)] text-[var(--admin-green)] border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)]";
    case "completed":
      return "bg-[color-mix(in_srgb,var(--admin-green)_18%,transparent)] text-[var(--admin-green)] border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)]";
    case "draft":
      return "bg-[var(--admin-panel2)] text-[var(--admin-ink-faint)] border-[var(--admin-line-soft)]";
    default:
      return "bg-[var(--admin-panel2)] text-[var(--admin-ink-faint)] border-[var(--admin-line-soft)]";
  }
}

export default function AdminSubmissions() {
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const queryParams = new URLSearchParams();
  if (statusFilter !== "all") queryParams.set("status", statusFilter);
  if (dateFrom) queryParams.set("dateFrom", dateFrom);
  if (dateTo) queryParams.set("dateTo", dateTo);
  const queryString = queryParams.toString();
  const apiUrl = `/api/admin/submissions${queryString ? `?${queryString}` : ""}`;

  const { data: subs = [], isLoading } = useQuery<SubmissionRow[]>({
    queryKey: ["/api/admin/submissions", statusFilter, dateFrom, dateTo],
    queryFn: async () => {
      const res = await fetch(apiUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch submissions");
      return res.json();
    },
  });

  if (selectedSub) {
    return <SubmissionDetail submissionId={selectedSub} onBack={() => setSelectedSub(null)} />;
  }

  const filtered = subs.filter((s) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        s.submissionId?.toLowerCase().includes(q) ||
        s.customerFirstName?.toLowerCase().includes(q) ||
        s.customerLastName?.toLowerCase().includes(q) ||
        s.customerEmail?.toLowerCase().includes(q) ||
        s.returnPostcode?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const statusCounts: Record<string, number> = {};
  for (const s of subs) {
    const st = s.status?.toLowerCase() || "unknown";
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }

  const hasActiveFilters = statusFilter !== "all" || dateFrom || dateTo || searchQuery;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1
            className="text-2xl font-bold text-[var(--admin-gold-hi)] tracking-widest"
            data-testid="text-submissions-title"
          >
            SUBMISSIONS
          </h1>
          <p className="text-[var(--admin-ink-faint)] text-sm">
            {subs.length} total submissions{hasActiveFilters ? " (filtered)" : ""}
          </p>
        </div>
        <a
          href="/api/admin/submissions/export-csv"
          className="inline-flex items-center gap-2 border border-[var(--admin-line)] text-[var(--admin-gold-hi)] px-4 py-2 rounded text-sm font-medium hover:bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] transition-colors"
          data-testid="button-export-submissions-csv"
        >
          <Download size={16} /> Export CSV
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--admin-gold)]/40" size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ID, name, email, postcode..."
            className="w-full bg-transparent border border-[var(--admin-line)] rounded px-4 py-2 pl-9 text-[var(--admin-ink)] text-sm placeholder:text-[var(--admin-ink-faint)] focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
            data-testid="input-search-subs"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {["all", "new", "paid", "received", "in_grading", "ready_to_return", "shipped", "completed"].map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${
                statusFilter === f
                  ? "bg-[color-mix(in_srgb,var(--admin-gold)_18%,transparent)] text-[var(--admin-gold-hi)] border-[var(--admin-line)]"
                  : "text-[var(--admin-ink-faint)] border-[var(--admin-line-soft)] hover:text-[var(--admin-ink-dim)]"
              }`}
              data-testid={`filter-sub-${f}`}
            >
              {SUBMISSION_STATUS_LABELS[f] || f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-[var(--admin-ink-faint)] text-xs">From:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
            data-testid="input-date-from-subs"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[var(--admin-ink-faint)] text-xs">To:</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)] transition-colors"
            data-testid="input-date-to-subs"
          />
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => {
              setStatusFilter("all");
              setDateFrom("");
              setDateTo("");
              setSearchQuery("");
            }}
            className="text-xs text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)] flex items-center gap-1 transition-colors"
            data-testid="button-clear-filters-subs"
          >
            <X size={12} /> Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-[var(--admin-line-soft)] rounded" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-[var(--admin-line-soft)] rounded-lg">
          <Package className="mx-auto text-[var(--admin-ink-faint)]/50 mb-3" size={40} />
          <p className="text-[var(--admin-ink-dim)]">
            {searchQuery ? "No matching submissions" : "No submissions yet"}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((sub) => (
            <button
              key={sub.id}
              onClick={() => setSelectedSub(sub.submissionId)}
              className="w-full border border-[var(--admin-line)] rounded-lg p-4 flex items-center justify-between gap-3 hover:border-[color-mix(in_srgb,var(--admin-gold)_30%,transparent)] transition-colors text-left"
              data-testid={`sub-row-${sub.submissionId}`}
            >
              <div className="flex items-center gap-4 min-w-0 flex-1">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="text-[var(--admin-gold-hi)] text-xs font-bold"
                      style={{ fontFamily: "var(--admin-mono)" }}
                    >
                      {sub.submissionId}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${statusColor(sub.status)}`}>
                      {SUBMISSION_STATUS_LABELS[sub.status?.toLowerCase()] || sub.status}
                    </span>
                    {sub.highValueFlag && (
                      <span className="text-xs px-1.5 py-0.5 rounded border bg-[color-mix(in_srgb,var(--admin-red)_18%,transparent)] text-[var(--admin-red)] border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)]">
                        HV
                      </span>
                    )}
                  </div>
                  <p className="text-[var(--admin-ink)] text-sm">
                    {sub.customerFirstName} {sub.customerLastName}
                    <span className="text-[var(--admin-ink-faint)] ml-2 text-xs">{sub.returnPostcode}</span>
                  </p>
                  <p className="text-[var(--admin-ink-faint)] text-xs">
                    {sub.cardCount || 0} cards ·{" "}
                    {pricingTiers.find((t) => t.id === sub.serviceTier)?.name || sub.serviceTier || "—"}· £
                    {parseFloat(sub.totalPrice || "0").toFixed(2)}·{" "}
                    {sub.createdAt ? new Date(sub.createdAt).toLocaleDateString() : ""}
                  </p>
                </div>
              </div>
              <ChevronRight size={16} className="text-[var(--admin-gold)]/30 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SubmissionDetail({ submissionId, onBack }: { submissionId: string; onBack: () => void }) {
  const { data: sub, isLoading } = useQuery<SubmissionRow>({
    queryKey: ["/api/admin/submissions", submissionId],
  });

  const [trackingInput, setTrackingInput] = useState("");
  const [carrierInput, setCarrierInput] = useState<string>("royal_mail");
  const [serviceInput, setServiceInput] = useState<string>("");
  const [postageCostInput, setPostageCostInput] = useState("");
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [adminNotesInput, setAdminNotesInput] = useState<string>("");
  const [adminFlaggedInput, setAdminFlaggedInput] = useState<boolean>(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [showMarkReceived, setShowMarkReceived] = useState(false);
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);

  // Edit-shipping panel. Separate state from the Create Return Label form
  // so the auto-suggest doesn't overwrite the operator's current stored
  // service when they open the editor to fix a typo.
  const [isEditingShipping, setIsEditingShipping] = useState(false);
  const [editCarrier, setEditCarrier] = useState<string>("royal_mail");
  const [editService, setEditService] = useState<string>("");
  const [editTracking, setEditTracking] = useState<string>("");
  const [editPostage, setEditPostage] = useState<string>("");
  const [editError, setEditError] = useState<string | null>(null);
  // Post-edit notice + resend confirmation. Notice only appears when the
  // edit happened AFTER shipped_at was set (i.e. the customer already
  // got an email referencing the old details).
  const [showResendNotice, setShowResendNotice] = useState(false);
  const [resendDone, setResendDone] = useState(false);

  const statusMutation = useMutation({
    mutationFn: async ({ status, extra }: { status: string; extra?: any }) => {
      await apiRequest("POST", `/api/admin/submissions/${submissionId}/status`, {
        status,
        ...extra,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
    },
  });

  const returnLabelMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/admin/submissions/${submissionId}/return-label`, {
        carrier: carrierInput,
        service: carrierInput === "other" ? null : serviceInput || null,
        trackingNumber: trackingInput,
        postageCost: postageCostInput,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      setShowReturnForm(false);
    },
  });

  const editShippingMutation = useMutation({
    mutationFn: async () => {
      const wasShipped = !!sub?.shippedAt;
      const res = await fetch(`/api/admin/submissions/${submissionId}/return-label`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          carrier: editCarrier,
          service: editCarrier === "other" ? null : editService || null,
          trackingNumber: editTracking,
          postageCost: editPostage,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || "Failed to save");
      }
      return { wasShipped };
    },
    onSuccess: ({ wasShipped }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
      setIsEditingShipping(false);
      setEditError(null);
      // Notice only when the customer was already notified (shipped_at
      // set). Edits before shipped don't need a resend.
      if (wasShipped) {
        setShowResendNotice(true);
        setResendDone(false);
      }
    },
    onError: (err: Error) => setEditError(err.message),
  });

  const resendShippingMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/submissions/${submissionId}/resend-shipping`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || "Failed to resend shipping email");
      }
    },
    onSuccess: () => {
      setResendDone(true);
      setShowResendNotice(false);
    },
  });

  // Manual delivery confirmation — stopgap until the Royal Mail Tracking
  // API is wired up. Idempotent server-side: re-clicking a row that's
  // already delivered is a no-op (unchanged:true).
  const markDeliveredMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/submissions/${submissionId}/mark-delivered`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || "Failed to mark delivered");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
    },
  });

  // Clear (un-confirm) — mis-click recovery. Audited separately. The UI
  // affordance is deliberately small (icon-only on the stepper area).
  const clearDeliveredMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/submissions/${submissionId}/mark-delivered/clear`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || "Failed to clear delivery");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
    },
  });

  const adminNotesMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/admin/submissions/${submissionId}/notes`, {
        notes: adminNotesInput || null,
        flagged: adminFlaggedInput,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    },
  });

  // One-step-back status correction (mis-click recovery). NEVER triggers
  // a customer email — that's the whole point of using a dedicated endpoint
  // rather than POSTing a "previous status" through /status. Server gates
  // floor (received) hard with a 400.
  const stepBackMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/submissions/${submissionId}/step-back`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || "Failed to step back");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
    },
  });

  const markReceivedMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      files.forEach((f) => form.append("photos", f));
      const res = await fetch(`/api/admin/submissions/${submissionId}/mark-received`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).error || "Failed to mark received");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      setShowMarkReceived(false);
      setReceiptFiles([]);
    },
  });

  useEffect(() => {
    if (sub) {
      setAdminNotesInput(sub.adminNotes ?? "");
      setAdminFlaggedInput(!!sub.adminFlagged);
    }
  }, [sub?.submissionId]);

  // Pre-fill carrier from any existing value (legacy data may store free-text
  // like "Royal Mail" — map back to the stable id).
  useEffect(() => {
    if (sub?.returnCarrier) {
      const mapped = carrierIdFromLegacyName(sub.returnCarrier);
      if (mapped) setCarrierInput(mapped);
    }
  }, [sub?.submissionId, sub?.returnCarrier]);

  // totalDeclaredValue is stored in whole pounds; carriers.ts auto-suggest
  // expects pence, so convert at the boundary. Grading submissions default
  // to the carrier's express-band service regardless of declared value —
  // see suggestServiceForSubmission for the rule.
  const declaredValuePence = (sub?.totalDeclaredValue ?? 0) * 100;
  const subServiceType = sub?.serviceType ?? null;
  useEffect(() => {
    const suggested = suggestServiceForSubmission(carrierInput, subServiceType, declaredValuePence);
    setServiceInput(suggested ?? "");
  }, [carrierInput, subServiceType, declaredValuePence]);

  if (isLoading || !sub) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <button
          onClick={onBack}
          className="text-[var(--admin-gold)] hover:text-[var(--admin-gold-hi)] text-sm mb-4"
          data-testid="button-back-subs"
        >
          <ArrowLeft size={14} className="inline mr-1" /> Back to Submissions
        </button>
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[var(--admin-line)] rounded w-48" />
          <div className="h-64 bg-[var(--admin-line-soft)] rounded" />
        </div>
      </div>
    );
  }

  const currentStatus = sub.status?.toLowerCase();
  const nextStatus = SUBMISSION_STATUS_TRANSITIONS[currentStatus];
  const tierData = pricingTiers.find((t) => t.id === sub.serviceTier);
  const typeData = submissionTypes.find((t) => t.id === sub.serviceType);

  const handleAdvanceStatus = () => {
    if (!nextStatus) return;
    if (nextStatus === "shipped" && !trackingInput) {
      setShowReturnForm(true);
      return;
    }
    statusMutation.mutate({
      status: nextStatus,
      extra: nextStatus === "shipped" ? { returnTracking: trackingInput, returnCarrier: carrierInput } : undefined,
    });
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <button
        onClick={onBack}
        className="text-[var(--admin-gold)] hover:text-[var(--admin-gold-hi)] text-sm mb-4 transition-colors"
        data-testid="button-back-subs"
      >
        <ArrowLeft size={14} className="inline mr-1" /> Back to Submissions
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2
            className="text-xl font-bold text-[var(--admin-gold-hi)] tracking-wider"
            style={{ fontFamily: "var(--admin-mono)" }}
            data-testid="text-sub-detail-id"
          >
            {sub.submissionId}
          </h2>
          <span className={`text-xs px-2 py-0.5 rounded border ${statusColor(sub.status)}`}>
            {SUBMISSION_STATUS_LABELS[currentStatus] || sub.status}
          </span>
          {sub.highValueFlag && (
            <span
              className="text-xs px-2 py-0.5 rounded border bg-[color-mix(in_srgb,var(--admin-red)_18%,transparent)] text-[var(--admin-red)] border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] ml-1"
              data-testid="badge-high-value"
            >
              High Value
            </span>
          )}
          {sub.requiresManualApproval && (
            <span
              className="text-xs px-2 py-0.5 rounded border bg-[color-mix(in_srgb,var(--admin-amber)_18%,transparent)] text-[var(--admin-amber)] border-[color-mix(in_srgb,var(--admin-amber)_40%,transparent)] ml-1"
              data-testid="badge-manual-approval"
            >
              Requires Approval
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/admin/submissions/${submissionId}/packing-slip`}
            className="text-xs border border-[var(--admin-line)] text-[var(--admin-gold)] hover:text-[var(--admin-gold-hi)] px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors"
            data-testid="button-print-slip"
          >
            <Printer size={12} /> Print Slip
          </a>
        </div>
      </div>

      {nextStatus && (
        <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6 bg-[color-mix(in_srgb,var(--admin-gold)_5%,transparent)]">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-[var(--admin-gold-hi)] text-sm font-medium">
                Next step: {SUBMISSION_STATUS_LABELS[nextStatus]}
              </p>
              <p className="text-[var(--admin-ink-faint)] text-xs">
                {SUBMISSION_STATUS_LABELS[currentStatus]} → {SUBMISSION_STATUS_LABELS[nextStatus]}
              </p>
            </div>

            {nextStatus === "shipped" ? (
              <button
                onClick={() => setShowReturnForm(true)}
                disabled={statusMutation.isPending}
                className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] flex items-center gap-2 disabled:opacity-50"
                data-testid="button-advance-status"
              >
                <Truck size={14} /> Mark Shipped
              </button>
            ) : nextStatus === "received" ? (
              <button
                onClick={() => setShowMarkReceived(true)}
                disabled={statusMutation.isPending}
                className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] flex items-center gap-2 disabled:opacity-50"
                data-testid="button-advance-status"
              >
                <Camera size={14} /> Mark Received
              </button>
            ) : (
              <button
                onClick={handleAdvanceStatus}
                disabled={statusMutation.isPending}
                className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] flex items-center gap-2 disabled:opacity-50"
                data-testid="button-advance-status"
              >
                <CheckCircle size={14} />
                {statusMutation.isPending ? "Updating..." : `Mark ${SUBMISSION_STATUS_LABELS[nextStatus]}`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Mis-click correction — understated link to walk back ONE step.
          Hidden at received and pre-received (received is the floor).
          Never triggers a customer email (the server uses a dedicated
          endpoint that doesn't share the forward /status email path). */}
      {(() => {
        const STEP_BACK_PREV: Record<string, string> = {
          in_grading: "received",
          ready_to_return: "in_grading",
          shipped: "ready_to_return",
          completed: "shipped",
        };
        const prev = STEP_BACK_PREV[currentStatus];
        if (!prev) return null;
        const prevLabel = SUBMISSION_STATUS_LABELS[prev] ?? prev;
        return (
          <div className="mb-4 flex items-center gap-2" data-testid="step-back-row">
            <button
              onClick={() => {
                if (window.confirm(`Step back to ${prevLabel}? This won't notify the customer.`)) {
                  stepBackMutation.mutate();
                }
              }}
              disabled={stepBackMutation.isPending}
              className="text-[11px] text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)] underline-offset-2 hover:underline disabled:opacity-50"
              data-testid="link-step-back"
            >
              ↩ {stepBackMutation.isPending ? "Stepping back…" : `Step back to ${prevLabel}`}
            </button>
            {stepBackMutation.isError && (
              <span className="text-[10px] text-[var(--admin-red)]">{(stepBackMutation.error as Error)?.message}</span>
            )}
          </div>
        );
      })()}

      {/* 5-node progress stepper. Mirrors the customer track surface so
          admin and customer see the same shape. Delivered lights up only
          when delivered_at is set (manual today, RM API later). */}
      <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6">
        <SubmissionProgress
          variant="admin"
          labels={ADMIN_LABELS}
          status={sub.status}
          receivedAt={sub.receivedAt}
          inGradingAt={sub.inGradingAt}
          readyToReturnAt={sub.readyToReturnAt}
          shippedAt={sub.shippedAt}
          deliveredAt={sub.deliveredAt}
        />
        {/* Mark Delivered — manual bridge until Royal Mail Tracking API is
            wired. Only available once shipped_at is set AND delivered_at
            is still NULL. Status "completed" alone does NOT enable this. */}
        {sub.shippedAt && !sub.deliveredAt && (
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => markDeliveredMutation.mutate()}
              disabled={markDeliveredMutation.isPending}
              className="text-xs border border-[var(--admin-green)] bg-[color-mix(in_srgb,var(--admin-green)_15%,transparent)] text-[var(--admin-green)] px-3 py-1.5 rounded font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--admin-green)_25%,transparent)] disabled:opacity-50 flex items-center gap-1.5"
              data-testid="button-mark-delivered"
            >
              <CheckCircle size={12} />
              {markDeliveredMutation.isPending ? "Marking..." : "Mark as Delivered"}
            </button>
            <span className="text-[10px] text-[var(--admin-ink-faint)]">
              Manual bridge — Royal Mail Tracking API will replace this.
            </span>
          </div>
        )}
        {sub.deliveredAt && (
          <div className="mt-4 flex items-center gap-2">
            <span className="text-[11px] text-[var(--admin-green)] flex items-center gap-1">
              <CheckCircle size={12} /> Delivered confirmed
            </span>
            <button
              onClick={() => {
                if (window.confirm("Clear the delivery confirmation? Used for mis-clicks.")) {
                  clearDeliveredMutation.mutate();
                }
              }}
              disabled={clearDeliveredMutation.isPending}
              className="text-[10px] text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)] underline-offset-2 hover:underline disabled:opacity-50"
              data-testid="button-clear-delivered"
              title="Clear delivery confirmation (mis-click recovery)"
            >
              clear
            </button>
          </div>
        )}
        {(markDeliveredMutation.isError || clearDeliveredMutation.isError) && (
          <p className="mt-2 text-[var(--admin-red)] text-xs">
            {(markDeliveredMutation.error as Error)?.message ?? (clearDeliveredMutation.error as Error)?.message}
          </p>
        )}
      </div>

      {showReturnForm && (
        <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6">
          <h3 className="text-[var(--admin-gold-hi)] font-semibold text-sm uppercase tracking-wider mb-3">
            Shipping Details
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Carrier</label>
              <select
                value={carrierInput}
                onChange={(e) => setCarrierInput(e.target.value)}
                className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                data-testid="select-carrier"
              >
                {CARRIERS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Tracking Number *</label>
              <input
                type="text"
                value={trackingInput}
                onChange={(e) => setTrackingInput(e.target.value)}
                className="w-full bg-transparent border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                data-testid="input-return-tracking"
              />
            </div>
          </div>
          {carrierInput !== "other" && servicesForCarrier(carrierInput).length > 0 && (
            <div className="mb-3">
              <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Service</label>
              <select
                value={serviceInput}
                onChange={(e) => setServiceInput(e.target.value)}
                className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                data-testid="select-service"
              >
                {servicesForCarrier(carrierInput).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="text-[var(--admin-ink-faint)] text-[11px] mt-1">
                {subServiceType === "grading" || !subServiceType
                  ? `Defaults to Express for graded slabs (declared £${(sub.totalDeclaredValue ?? 0).toLocaleString()}). Override if needed.`
                  : `Auto-selected from declared value (£${(sub.totalDeclaredValue ?? 0).toLocaleString()}). Override if needed.`}
              </p>
            </div>
          )}
          {carrierInput === "dpd" && (sub.totalDeclaredValue ?? 0) > 500 && (
            <div
              className="mb-3 border border-[color-mix(in_srgb,var(--admin-amber)_50%,transparent)] bg-[color-mix(in_srgb,var(--admin-amber)_10%,transparent)] text-[var(--admin-amber)] text-xs rounded px-3 py-2"
              data-testid="warning-dpd-cover"
            >
              ⚠️ DPD cover may be insufficient above £500 — Royal Mail Special Delivery recommended.
            </div>
          )}
          <div className="max-w-[200px] mb-3">
            <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Return Postage Cost (pence)</label>
            <input
              type="number"
              value={postageCostInput}
              onChange={(e) => setPostageCostInput(e.target.value)}
              placeholder="Optional"
              className="w-full bg-transparent border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
              data-testid="input-postage-cost"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!trackingInput) return;
                statusMutation.mutate({
                  status: "shipped",
                  extra: {
                    returnTracking: trackingInput,
                    returnCarrier: carrierInput,
                    returnService: carrierInput === "other" ? null : serviceInput || null,
                  },
                });
              }}
              disabled={!trackingInput || statusMutation.isPending}
              className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] disabled:opacity-50 flex items-center gap-2"
              data-testid="button-confirm-shipped"
            >
              <Truck size={14} /> {statusMutation.isPending ? "Shipping..." : "Confirm Shipped"}
            </button>
            <button
              onClick={() => setShowReturnForm(false)}
              className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] text-sm px-4 py-2 rounded border border-[var(--admin-line-soft)] hover:border-[var(--admin-line)] transition-colors"
              data-testid="button-cancel-ship"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Mark Received Modal ────────────────────────────────────────────── */}
      {showMarkReceived && (
        <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6 bg-[color-mix(in_srgb,var(--admin-gold)_5%,transparent)]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Camera size={14} className="text-[var(--admin-gold)]" />
              <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">
                Mark Cards Received
              </h3>
            </div>
            <button
              onClick={() => {
                setShowMarkReceived(false);
                setReceiptFiles([]);
              }}
              className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <p className="text-[var(--admin-ink-dim)] text-xs mb-3">
            Upload receipt photos (up to 6) showing the cards as they arrived. These will be emailed to the customer.
          </p>

          {/* File picker */}
          <label className="flex items-center gap-2 border border-dashed border-[var(--admin-line)] rounded-lg px-4 py-3 cursor-pointer hover:border-[color-mix(in_srgb,var(--admin-gold)_60%,transparent)] transition-colors mb-3">
            <Upload size={14} className="text-[var(--admin-gold)]" />
            <span className="text-[var(--admin-ink-dim)] text-xs">Click to add photos (JPEG/PNG, max 6)</span>
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const newFiles = Array.from(e.target.files ?? []).slice(0, 6 - receiptFiles.length);
                setReceiptFiles((prev) => [...prev, ...newFiles].slice(0, 6));
                e.target.value = "";
              }}
            />
          </label>

          {/* Preview */}
          {receiptFiles.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-3">
              {receiptFiles.map((f, i) => (
                <div key={i} className="relative group">
                  <img
                    src={URL.createObjectURL(f)}
                    alt={f.name}
                    className="w-16 h-16 object-cover rounded border border-[var(--admin-line)]"
                  />
                  <button
                    onClick={() => setReceiptFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute -top-1 -right-1 bg-[var(--admin-red)] text-[var(--admin-bg)] rounded-full w-4 h-4 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {markReceivedMutation.isError && (
            <p className="text-[var(--admin-red)] text-xs mb-3">{(markReceivedMutation.error as Error)?.message}</p>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => markReceivedMutation.mutate(receiptFiles)}
              disabled={markReceivedMutation.isPending}
              className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] disabled:opacity-50 flex items-center gap-2"
              data-testid="button-confirm-received"
            >
              {markReceivedMutation.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <CheckCircle size={13} />
              )}
              {markReceivedMutation.isPending ? "Saving..." : "Confirm Received"}
            </button>
            <button
              onClick={() => {
                setShowMarkReceived(false);
                setReceiptFiles([]);
              }}
              className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] text-sm px-4 py-2 rounded border border-[var(--admin-line-soft)] hover:border-[var(--admin-line)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="border border-[var(--admin-line)] rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <MapPin size={14} className="text-[var(--admin-gold)]" />
            <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">
              Return Address
            </h3>
          </div>
          <div className="text-[var(--admin-ink)] text-sm space-y-0.5" data-testid="text-return-address">
            <p className="font-medium">
              {sub.customerFirstName} {sub.customerLastName}
            </p>
            <p>{sub.returnAddressLine1}</p>
            {sub.returnAddressLine2 && <p>{sub.returnAddressLine2}</p>}
            <p>{sub.returnCity}</p>
            {sub.returnCounty && <p>{sub.returnCounty}</p>}
            <p className="font-bold">{sub.returnPostcode}</p>
          </div>
        </div>

        <div className="border border-[var(--admin-line)] rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Mail size={14} className="text-[var(--admin-gold)]" />
            <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">Contact</h3>
          </div>
          <div className="text-sm space-y-1.5">
            <p className="text-[var(--admin-ink)]">{sub.customerEmail}</p>
            {sub.phone && (
              <p className="text-[var(--admin-ink-dim)] flex items-center gap-1">
                <Phone size={12} /> {sub.phone}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={14} className="text-[var(--admin-gold)]" />
          <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">Order Details</h3>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <DetailRow label="Service" value={typeData?.name || sub.serviceType} />
          <DetailRow label="Tier" value={tierData?.name || sub.serviceTier} />
          <DetailRow label="Cards" value={`${sub.cardCount || 0}`} />
          <DetailRow label="Declared Value" value={`£${sub.totalDeclaredValue?.toLocaleString() || "0"}`} />
          <DetailRow label="Service Cost" value={`£${((sub.gradingCost || 0) / 100).toFixed(2)}`} />
          <DetailRow label="Shipping" value={`£${((sub.shippingCost || 0) / 100).toFixed(2)}`} />
          <DetailRow label="Shipping Insurance" value={sub.shippingInsuranceTier || "—"} />
          {sub.insuranceFee > 0 && (
            <DetailRow label="Insurance Surcharge" value={`£${(sub.insuranceFee / 100).toFixed(2)}`} />
          )}
          <DetailRow label="Total Paid" value={`£${parseFloat(sub.totalPrice || "0").toFixed(2)}`} highlight />
          <DetailRow label="Payment Ref" value={sub.paymentIntentId?.slice(0, 20) || "—"} />
          {sub.notes && (
            <div className="col-span-2">
              <DetailRow label="Notes" value={sub.notes} />
            </div>
          )}
        </div>
      </div>

      {sub.serviceType === "crossover" && (
        <div
          className="border border-[color-mix(in_srgb,var(--admin-amber)_30%,transparent)] rounded-lg p-4 mb-6 bg-[color-mix(in_srgb,var(--admin-amber)_5%,transparent)]"
          data-testid="section-crossover-details"
        >
          <div className="flex items-center gap-2 mb-3">
            <ScanLine size={14} className="text-[var(--admin-amber)]" />
            <h3 className="text-[var(--admin-amber)] font-semibold text-xs uppercase tracking-wider">
              Crossover Details
            </h3>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <DetailRow
              label="Original Company"
              value={sub.crossoverCompany || "—"}
              testId="text-admin-crossover-company"
            />
            {sub.crossoverOriginalGrade && (
              <DetailRow
                label="Original Grade"
                value={sub.crossoverOriginalGrade}
                testId="text-admin-crossover-grade"
              />
            )}
            {sub.crossoverCertNumber && (
              <DetailRow label="Cert Number" value={sub.crossoverCertNumber} testId="text-admin-crossover-cert" />
            )}
          </div>
          <p className="text-[var(--admin-amber)]/70 text-xs mt-3">
            ⚠️ Subject to review — return cards that do not meet crossover standards.
          </p>
        </div>
      )}

      {sub.serviceType === "reholder" && (sub.reholderCompany || sub.reholderReason || sub.reholderCondition) && (
        <div
          className="border border-[var(--admin-line)] rounded-lg p-4 mb-6 bg-[color-mix(in_srgb,var(--admin-gold)_5%,transparent)]"
          data-testid="section-reholder-details"
        >
          <div className="flex items-center gap-2 mb-3">
            <Package size={14} className="text-[var(--admin-gold)]" />
            <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">
              Reholder Details
            </h3>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {sub.reholderCompany && (
              <DetailRow label="Current Grader" value={sub.reholderCompany} testId="text-admin-reholder-company" />
            )}
            {sub.reholderReason && (
              <DetailRow label="Reason" value={sub.reholderReason} testId="text-admin-reholder-reason" />
            )}
            {sub.reholderCondition && (
              <DetailRow label="Slab Condition" value={sub.reholderCondition} testId="text-admin-reholder-condition" />
            )}
          </div>
        </div>
      )}

      {sub.serviceType === "authentication" && (sub.authReason || sub.authConcerns) && (
        <div
          className="border border-[var(--admin-line)] rounded-lg p-4 mb-6 bg-[color-mix(in_srgb,var(--admin-gold)_5%,transparent)]"
          data-testid="section-auth-details"
        >
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={14} className="text-[var(--admin-gold)]" />
            <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">
              Authentication Details
            </h3>
          </div>
          <div className="grid grid-cols-1 gap-y-2 text-sm">
            {sub.authReason && (
              <DetailRow label="Reason for Authentication" value={sub.authReason} testId="text-admin-auth-reason" />
            )}
            {sub.authConcerns && (
              <DetailRow label="Specific Concerns" value={sub.authConcerns} testId="text-admin-auth-concerns" />
            )}
          </div>
        </div>
      )}

      {sub.items && sub.items.length > 0 && (
        <SubmissionItemsSection submissionId={sub.submissionId} items={sub.items} />
      )}

      {(sub.returnCarrier || sub.returnTracking) &&
        (() => {
          // Normalise carrier (free-text legacy values resolve to a stable
          // id) so display labels match the catalogue and the edit form
          // can pre-fill the carrier dropdown correctly.
          const carrierId = carrierIdFromLegacyName(sub.returnCarrier) ?? "";
          const carrierDisplay = carrierId ? carrierLabel(carrierId) : sub.returnCarrier || "";
          const svcText = carrierId && sub.returnService ? serviceLabel(carrierId, sub.returnService) : null;
          return (
            <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6 bg-[color-mix(in_srgb,var(--admin-gold)_5%,transparent)]">
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Truck size={14} className="text-[var(--admin-gold)]" />
                  <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">
                    Return Shipping
                  </h3>
                </div>
                {!isEditingShipping && (
                  <button
                    onClick={() => {
                      // Pre-fill from current stored values (NOT auto-suggest).
                      setEditCarrier(carrierId || "royal_mail");
                      setEditService(sub.returnService ?? "");
                      setEditTracking(sub.returnTracking ?? "");
                      setEditPostage(sub.returnPostageCost ? String(sub.returnPostageCost) : "");
                      setEditError(null);
                      setIsEditingShipping(true);
                    }}
                    className="text-[10px] uppercase tracking-widest text-[var(--admin-gold)] hover:text-[var(--admin-gold-hi)] border border-[var(--admin-line)] px-2 py-1 rounded"
                    data-testid="button-edit-shipping"
                  >
                    <Edit2 size={11} className="inline mr-1" /> Edit shipping
                  </button>
                )}
              </div>

              {!isEditingShipping ? (
                <div className="text-sm space-y-1">
                  {carrierDisplay && (
                    <p className="text-[var(--admin-ink)]" data-testid="text-return-carrier">
                      Carrier: {carrierDisplay}
                    </p>
                  )}
                  {svcText && (
                    <p className="text-[var(--admin-ink)]" data-testid="text-return-service">
                      Service: {svcText}
                    </p>
                  )}
                  {sub.returnTracking && (
                    <p
                      className="text-[var(--admin-ink)]"
                      style={{ fontFamily: "var(--admin-mono)" }}
                      data-testid="text-return-tracking"
                    >
                      Tracking: {sub.returnTracking}
                    </p>
                  )}
                  {sub.returnPostageCost && (
                    <p className="text-[var(--admin-ink-dim)]">Postage: £{(sub.returnPostageCost / 100).toFixed(2)}</p>
                  )}
                </div>
              ) : (
                <div data-testid="form-edit-shipping">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Carrier</label>
                      <select
                        value={editCarrier}
                        onChange={(e) => setEditCarrier(e.target.value)}
                        className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                        data-testid="select-edit-carrier"
                      >
                        {CARRIERS.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Tracking Number</label>
                      <input
                        type="text"
                        value={editTracking}
                        onChange={(e) => setEditTracking(e.target.value)}
                        className="w-full bg-transparent border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                        data-testid="input-edit-tracking"
                      />
                    </div>
                  </div>
                  {editCarrier !== "other" && servicesForCarrier(editCarrier).length > 0 && (
                    <div className="mb-3">
                      <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Service</label>
                      <select
                        value={editService}
                        onChange={(e) => setEditService(e.target.value)}
                        className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                        data-testid="select-edit-service"
                      >
                        <option value="">— select —</option>
                        {servicesForCarrier(editCarrier).map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {editCarrier === "dpd" && (sub.totalDeclaredValue ?? 0) > 500 && (
                    <div
                      className="mb-3 border border-[color-mix(in_srgb,var(--admin-amber)_50%,transparent)] bg-[color-mix(in_srgb,var(--admin-amber)_10%,transparent)] text-[var(--admin-amber)] text-xs rounded px-3 py-2"
                      data-testid="warning-edit-dpd-cover"
                    >
                      ⚠️ DPD cover may be insufficient above £500 — Royal Mail Special Delivery recommended.
                    </div>
                  )}
                  <div className="max-w-[200px] mb-3">
                    <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">
                      Postage Cost (pence, optional)
                    </label>
                    <input
                      type="number"
                      value={editPostage}
                      onChange={(e) => setEditPostage(e.target.value)}
                      className="w-full bg-transparent border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                      data-testid="input-edit-postage"
                    />
                  </div>
                  {editError && (
                    <p className="text-[var(--admin-red)] text-xs mb-2" data-testid="text-edit-error">
                      {editError}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => editShippingMutation.mutate()}
                      disabled={editShippingMutation.isPending}
                      className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] disabled:opacity-50 flex items-center gap-2"
                      data-testid="button-save-edit-shipping"
                    >
                      <Save size={13} /> {editShippingMutation.isPending ? "Saving..." : "Save changes"}
                    </button>
                    <button
                      onClick={() => {
                        setIsEditingShipping(false);
                        setEditError(null);
                      }}
                      disabled={editShippingMutation.isPending}
                      className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] text-sm px-4 py-2 rounded border border-[var(--admin-line-soft)] hover:border-[var(--admin-line)] transition-colors"
                      data-testid="button-cancel-edit-shipping"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {showResendNotice && !isEditingShipping && (
                <div
                  className="mt-3 border border-[color-mix(in_srgb,var(--admin-amber)_50%,transparent)] bg-[color-mix(in_srgb,var(--admin-amber)_10%,transparent)] text-[var(--admin-amber)] text-xs rounded px-3 py-2 flex items-center justify-between gap-3"
                  data-testid="notice-resend-shipping"
                >
                  <span>Tracking updated after the customer was notified.</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => resendShippingMutation.mutate()}
                      disabled={resendShippingMutation.isPending}
                      className="text-[10px] uppercase tracking-widest border border-[var(--admin-amber)] text-[var(--admin-amber)] px-2 py-1 rounded hover:bg-[color-mix(in_srgb,var(--admin-amber)_20%,transparent)] transition-colors disabled:opacity-50"
                      data-testid="button-resend-shipping"
                    >
                      {resendShippingMutation.isPending ? "Sending..." : "Resend shipping email"}
                    </button>
                    <button
                      onClick={() => setShowResendNotice(false)}
                      className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)] text-xs"
                      aria-label="Dismiss"
                      data-testid="button-dismiss-resend-notice"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
              )}
              {resendDone && !isEditingShipping && (
                <p
                  className="mt-3 text-[var(--admin-green)] text-xs flex items-center gap-1"
                  data-testid="text-resend-done"
                >
                  <CheckCircle size={12} /> Shipping email resent
                </p>
              )}
              {resendShippingMutation.isError && (
                <p className="mt-2 text-[var(--admin-red)] text-xs">
                  {(resendShippingMutation.error as Error)?.message}
                </p>
              )}
            </div>
          );
        })()}

      <div
        className="border border-[color-mix(in_srgb,var(--admin-red)_30%,transparent)] rounded-lg p-4 mb-6 bg-[color-mix(in_srgb,var(--admin-red)_5%,transparent)]"
        data-testid="section-admin-notes"
      >
        <div className="flex items-center gap-2 mb-3">
          <FileText size={14} className="text-[var(--admin-red)]" />
          <h3 className="text-[var(--admin-red)] font-semibold text-xs uppercase tracking-wider">Admin Notes</h3>
          {sub.adminFlagged && (
            <span
              className="ml-auto text-xs bg-[color-mix(in_srgb,var(--admin-red)_18%,transparent)] text-[var(--admin-red)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] rounded px-2 py-0.5"
              data-testid="badge-flagged"
            >
              Flagged
            </span>
          )}
        </div>
        <textarea
          value={adminNotesInput}
          onChange={(e) => setAdminNotesInput(e.target.value)}
          placeholder="Internal notes visible to admin only…"
          rows={3}
          className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm resize-none focus:outline-none focus:border-[color-mix(in_srgb,var(--admin-gold)_60%,transparent)] placeholder:text-[var(--admin-ink-faint)]"
          data-testid="textarea-admin-notes"
        />
        <div className="flex items-center gap-4 mt-3">
          <label
            className="flex items-center gap-2 text-sm text-[var(--admin-ink-dim)] cursor-pointer select-none"
            data-testid="label-flag-submission"
          >
            <input
              type="checkbox"
              checked={adminFlaggedInput}
              onChange={(e) => setAdminFlaggedInput(e.target.checked)}
              className="w-4 h-4"
              style={{ accentColor: "var(--admin-red)" }}
              data-testid="checkbox-admin-flagged"
            />
            Flag this submission for review
          </label>
          <button
            onClick={() => adminNotesMutation.mutate()}
            disabled={adminNotesMutation.isPending}
            className="ml-auto border border-[var(--admin-line)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-1.5 rounded text-sm font-medium hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] transition-all disabled:opacity-50"
            data-testid="button-save-admin-notes"
          >
            {adminNotesMutation.isPending ? "Saving…" : notesSaved ? "Saved ✓" : "Save Notes"}
          </button>
        </div>
      </div>

      <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={14} className="text-[var(--admin-gold)]" />
          <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">Timeline</h3>
        </div>
        <div className="space-y-2 text-sm">
          <TimelineEntry label="Created" time={sub.createdAt} />
          <TimelineEntry label="Received" time={sub.receivedAt} />
          <TimelineEntry label="Shipped" time={sub.shippedAt} />
          <TimelineEntry label="Completed" time={sub.completedAt} />
        </div>
      </div>

      {!showReturnForm && currentStatus === "ready_to_return" && (
        <div className="border border-[var(--admin-line)] rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Truck size={14} className="text-[var(--admin-gold)]" />
            <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">
              Create Return Label
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Carrier</label>
              <select
                value={carrierInput}
                onChange={(e) => setCarrierInput(e.target.value)}
                className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                data-testid="select-return-carrier"
              >
                {CARRIERS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Tracking Number</label>
              <input
                type="text"
                value={trackingInput}
                onChange={(e) => setTrackingInput(e.target.value)}
                className="w-full bg-transparent border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                data-testid="input-ret-tracking"
              />
            </div>
          </div>
          {carrierInput !== "other" && servicesForCarrier(carrierInput).length > 0 && (
            <div className="mb-3">
              <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Service</label>
              <select
                value={serviceInput}
                onChange={(e) => setServiceInput(e.target.value)}
                className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
                data-testid="select-return-service"
              >
                {servicesForCarrier(carrierInput).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <p className="text-[var(--admin-ink-faint)] text-[11px] mt-1">
                {subServiceType === "grading" || !subServiceType
                  ? `Defaults to Express for graded slabs (declared £${(sub.totalDeclaredValue ?? 0).toLocaleString()}). Override if needed.`
                  : `Auto-selected from declared value (£${(sub.totalDeclaredValue ?? 0).toLocaleString()}). Override if needed.`}
              </p>
            </div>
          )}
          {carrierInput === "dpd" && (sub.totalDeclaredValue ?? 0) > 500 && (
            <div
              className="mb-3 border border-[color-mix(in_srgb,var(--admin-amber)_50%,transparent)] bg-[color-mix(in_srgb,var(--admin-amber)_10%,transparent)] text-[var(--admin-amber)] text-xs rounded px-3 py-2"
              data-testid="warning-return-dpd-cover"
            >
              ⚠️ DPD cover may be insufficient above £500 — Royal Mail Special Delivery recommended.
            </div>
          )}
          <div className="max-w-[200px] mb-3">
            <label className="text-[var(--admin-ink-dim)] text-xs block mb-1">Postage Cost (pence, optional)</label>
            <input
              type="number"
              value={postageCostInput}
              onChange={(e) => setPostageCostInput(e.target.value)}
              className="w-full bg-transparent border border-[var(--admin-line)] rounded px-3 py-2 text-[var(--admin-ink)] text-sm focus:outline-none focus:border-[var(--admin-gold)]"
              data-testid="input-ret-postage"
            />
          </div>
          <button
            onClick={() => returnLabelMutation.mutate()}
            disabled={returnLabelMutation.isPending}
            className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] disabled:opacity-50"
            data-testid="button-save-return-label"
          >
            {returnLabelMutation.isPending ? "Saving..." : "Save Return Label"}
          </button>
        </div>
      )}
    </div>
  );
}

interface SubmissionItemData {
  id: number;
  card_index?: number;
  cardIndex?: number;
  game: string | null;
  card_name?: string | null;
  cardName?: string | null;
  card_set?: string | null;
  cardSet?: string | null;
  card_number?: string | null;
  cardNumber?: string | null;
  year: string | null;
  declared_value?: number;
  declaredValue?: number;
  notes: string | null;
  submission_item_id?: number;
  submissionItemId?: number;
}

function SubmissionItemsSection({ submissionId, items }: { submissionId: string; items: SubmissionItemData[] }) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editData, setEditData] = useState<Record<string, string>>({});

  const updateItemMutation = useMutation({
    mutationFn: async ({ itemId, data }: { itemId: number; data: Record<string, any> }) => {
      await apiRequest("PATCH", `/api/admin/submissions/${submissionId}/items/${itemId}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      setEditingId(null);
      setEditData({});
    },
  });

  const startEdit = (item: SubmissionItemData) => {
    setEditingId(item.id);
    setEditData({
      game: item.game || "",
      cardName: item.card_name ?? item.cardName ?? "",
      cardSet: item.card_set ?? item.cardSet ?? "",
      cardNumber: item.card_number ?? item.cardNumber ?? "",
      year: item.year || "",
      declaredValue: String(item.declared_value ?? item.declaredValue ?? 0),
      notes: item.notes || "",
    });
  };

  const saveEdit = (itemId: number) => {
    updateItemMutation.mutate({
      itemId,
      data: {
        game: editData.game || null,
        cardName: editData.cardName || null,
        cardSet: editData.cardSet || null,
        cardNumber: editData.cardNumber || null,
        year: editData.year || null,
        declaredValue: parseInt(editData.declaredValue) || 0,
        notes: editData.notes || null,
      },
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditData({});
  };

  return (
    <div className="border border-[var(--admin-line)] rounded-lg p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <CreditCard size={14} className="text-[var(--admin-gold)]" />
        <h3 className="text-[var(--admin-gold-hi)] font-semibold text-xs uppercase tracking-wider">
          Customer Card Details
        </h3>
        <span className="text-[var(--admin-ink-faint)] text-xs ml-auto">
          {items.length} item{items.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="space-y-2">
        {items.map((item, idx) => {
          const index = item.card_index ?? item.cardIndex ?? idx + 1;
          const cardName = item.card_name ?? item.cardName;
          const cardSet = item.card_set ?? item.cardSet;
          const cardNumber = item.card_number ?? item.cardNumber;
          const declaredValue = item.declared_value ?? item.declaredValue ?? 0;
          const isEditing = editingId === item.id;

          if (isEditing) {
            return (
              <div
                key={item.id}
                className="border border-[var(--admin-line)] rounded p-3 bg-[color-mix(in_srgb,var(--admin-gold)_5%,transparent)]"
                data-testid={`item-edit-${item.id}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[var(--admin-gold-hi)] text-xs font-bold">Card #{index}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => saveEdit(item.id)}
                      disabled={updateItemMutation.isPending}
                      className="text-[var(--admin-green)] hover:text-[var(--admin-gold-hi)] p-1 transition-colors"
                      data-testid={`button-save-item-${item.id}`}
                    >
                      <Save size={14} />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="text-[var(--admin-ink-dim)] hover:text-[var(--admin-ink)] p-1 transition-colors"
                      data-testid={`button-cancel-item-${item.id}`}
                    >
                      <XCircle size={14} />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div>
                    <label className="text-[var(--admin-ink-faint)] text-xs block mb-0.5">Game</label>
                    <select
                      value={editData.game}
                      onChange={(e) => setEditData({ ...editData, game: e.target.value })}
                      className="w-full bg-[var(--admin-bg2)] border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)]"
                      data-testid={`select-game-${item.id}`}
                    >
                      <option value="">—</option>
                      <option value="pokemon">Pokémon</option>
                      <option value="yugioh">Yu-Gi-Oh!</option>
                      <option value="mtg">Magic: The Gathering</option>
                      <option value="one_piece">One Piece</option>
                      <option value="dragon_ball">Dragon Ball</option>
                      <option value="digimon">Digimon</option>
                      <option value="sports">Sports</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[var(--admin-ink-faint)] text-xs block mb-0.5">Card Name</label>
                    <input
                      type="text"
                      value={editData.cardName}
                      onChange={(e) => setEditData({ ...editData, cardName: e.target.value })}
                      className="w-full bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)]"
                      data-testid={`input-cardname-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-[var(--admin-ink-faint)] text-xs block mb-0.5">Set</label>
                    <input
                      type="text"
                      value={editData.cardSet}
                      onChange={(e) => setEditData({ ...editData, cardSet: e.target.value })}
                      className="w-full bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)]"
                      data-testid={`input-cardset-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-[var(--admin-ink-faint)] text-xs block mb-0.5">Card #</label>
                    <input
                      type="text"
                      value={editData.cardNumber}
                      onChange={(e) => setEditData({ ...editData, cardNumber: e.target.value })}
                      className="w-full bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)]"
                      data-testid={`input-cardnumber-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-[var(--admin-ink-faint)] text-xs block mb-0.5">Year</label>
                    <input
                      type="text"
                      value={editData.year}
                      onChange={(e) => setEditData({ ...editData, year: e.target.value })}
                      className="w-full bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)]"
                      data-testid={`input-year-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-[var(--admin-ink-faint)] text-xs block mb-0.5">Declared (£)</label>
                    <input
                      type="number"
                      value={editData.declaredValue}
                      onChange={(e) => setEditData({ ...editData, declaredValue: e.target.value })}
                      className="w-full bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)]"
                      data-testid={`input-declared-${item.id}`}
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <label className="text-[var(--admin-ink-faint)] text-xs block mb-0.5">Notes</label>
                  <input
                    type="text"
                    value={editData.notes}
                    onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                    className="w-full bg-transparent border border-[var(--admin-line)] rounded px-2 py-1.5 text-[var(--admin-ink)] text-xs focus:outline-none focus:border-[var(--admin-gold)]"
                    data-testid={`input-notes-${item.id}`}
                  />
                </div>
              </div>
            );
          }

          return (
            <div
              key={item.id}
              className="border border-[var(--admin-line-soft)] rounded p-3 flex items-start justify-between gap-3 group"
              data-testid={`item-row-${item.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-[var(--admin-gold-hi)] text-xs font-bold">#{index}</span>
                  {item.game && <span className="text-xs text-[var(--admin-ink-dim)]">{item.game}</span>}
                  {cardName ? (
                    <span className="text-[var(--admin-ink)] text-sm font-medium">{cardName}</span>
                  ) : (
                    <span className="text-[var(--admin-ink-faint)] text-sm italic">(Not provided)</span>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap text-xs text-[var(--admin-ink-faint)]">
                  <span>
                    Set: {cardSet || <span className="text-[var(--admin-ink-faint)] italic">(Not provided)</span>}
                  </span>
                  <span>#{cardNumber || <span className="text-[var(--admin-ink-faint)] italic">—</span>}</span>
                  <span>Year: {item.year || <span className="text-[var(--admin-ink-faint)] italic">—</span>}</span>
                  <span>£{declaredValue.toLocaleString()}</span>
                  {item.notes && (
                    <span className="text-[var(--admin-ink-dim)] truncate max-w-[150px]">{item.notes}</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => startEdit(item)}
                className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)] p-1 transition-colors shrink-0"
                data-testid={`button-edit-item-${item.id}`}
              >
                <Edit2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  highlight,
  testId,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-[var(--admin-ink-faint)] text-xs">{label}</span>
      <span
        className={`font-medium ${highlight ? "text-[var(--admin-gold-hi)] font-bold" : "text-[var(--admin-ink)]"}`}
        data-testid={testId}
      >
        {value}
      </span>
    </div>
  );
}

function TimelineEntry({ label, time }: { label: string; time?: string }) {
  if (!time)
    return (
      <div className="flex items-center gap-3 text-[var(--admin-ink-faint)]">
        <div className="w-2 h-2 rounded-full bg-[var(--admin-line-hard)]" />
        <span className="text-xs">{label}</span>
        <span className="text-xs">—</span>
      </div>
    );
  return (
    <div className="flex items-center gap-3 text-[var(--admin-green)]">
      <div className="w-2 h-2 rounded-full bg-[var(--admin-green)]" />
      <span className="text-xs font-medium">{label}</span>
      <span className="text-xs text-[var(--admin-ink-dim)]">{new Date(time).toLocaleString()}</span>
    </div>
  );
}

export function AdminIntake() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<SubmissionRow | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const markReceivedMutation = useMutation({
    mutationFn: async (subId: string) => {
      await apiRequest("POST", `/api/admin/submissions/${subId}/status`, { status: "received" });
    },
    onSuccess: () => {
      if (result) {
        setResult({ ...result, status: "received" } as any);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions"] });
    },
  });

  const handleLookup = async () => {
    const trimmed = input.trim().toUpperCase();
    if (!trimmed) return;
    setError("");
    setResult(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/submissions/${trimmed}`, { credentials: "include" });
      if (!res.ok) {
        setError("Submission not found");
        return;
      }
      const data = await res.json();
      setResult(data);
    } catch {
      setError("Failed to look up submission");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto px-4 py-6">
      <div className="text-center mb-8">
        <ScanLine size={40} className="text-[var(--admin-gold)] mx-auto mb-3" />
        <h1 className="text-2xl font-bold text-[var(--admin-gold-hi)] tracking-widest" data-testid="text-intake-title">
          INTAKE SCANNER
        </h1>
        <p className="text-[var(--admin-ink-faint)] text-sm">Scan or enter a Submission ID to mark as received</p>
      </div>

      <div className="flex gap-2 mb-6">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          placeholder="MV-SUB-000001"
          className="flex-1 bg-transparent border-2 border-[var(--admin-line)] rounded px-4 py-3 text-[var(--admin-ink)] text-lg tracking-wider placeholder:text-[var(--admin-ink-faint)] focus:outline-none focus:border-[var(--admin-gold)] transition-colors text-center"
          style={{ fontFamily: "var(--admin-mono)" }}
          autoFocus
          data-testid="input-intake-scan"
        />
        <button
          onClick={handleLookup}
          disabled={loading}
          className="border border-[var(--admin-gold)] bg-[color-mix(in_srgb,var(--admin-gold)_10%,transparent)] text-[var(--admin-gold-hi)] px-6 rounded font-medium transition-all hover:bg-[color-mix(in_srgb,var(--admin-gold)_20%,transparent)] disabled:opacity-50"
          data-testid="button-intake-lookup"
        >
          {loading ? "..." : "Lookup"}
        </button>
      </div>

      {error && (
        <div className="text-center py-8 border border-[color-mix(in_srgb,var(--admin-red)_30%,transparent)] rounded-lg bg-[color-mix(in_srgb,var(--admin-red)_5%,transparent)] mb-4">
          <p className="text-[var(--admin-red)]" data-testid="text-intake-error">
            {error}
          </p>
        </div>
      )}

      {result && (
        <div className="border border-[var(--admin-line)] rounded-lg overflow-hidden">
          <div className="bg-[color-mix(in_srgb,var(--admin-gold)_5%,transparent)] p-4 border-b border-[var(--admin-line)] flex items-center justify-between">
            <div>
              <span
                className="text-[var(--admin-gold-hi)] font-bold text-lg"
                style={{ fontFamily: "var(--admin-mono)" }}
              >
                {result.submissionId}
              </span>
              <span className={`ml-3 text-xs px-2 py-0.5 rounded border ${statusColor(result.status)}`}>
                {SUBMISSION_STATUS_LABELS[result.status?.toLowerCase()] || result.status}
              </span>
            </div>
          </div>

          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-[var(--admin-ink-faint)] text-xs">Customer</p>
                <p className="text-[var(--admin-ink)] font-medium">
                  {result.customerFirstName} {result.customerLastName}
                </p>
              </div>
              <div>
                <p className="text-[var(--admin-ink-faint)] text-xs">Cards</p>
                <p className="text-[var(--admin-ink)] font-medium">{result.cardCount || 0}</p>
              </div>
              <div>
                <p className="text-[var(--admin-ink-faint)] text-xs">Email</p>
                <p className="text-[var(--admin-ink)] text-sm">{result.customerEmail}</p>
              </div>
              {result.phone && (
                <div>
                  <p className="text-[var(--admin-ink-faint)] text-xs">Phone</p>
                  <p className="text-[var(--admin-ink)] text-sm">{result.phone}</p>
                </div>
              )}
            </div>

            <div className="border-t border-[var(--admin-line)] pt-3">
              <p className="text-[var(--admin-ink-faint)] text-xs mb-1">Return Address</p>
              <div className="text-[var(--admin-ink)] text-sm" data-testid="text-intake-address">
                <p>{result.returnAddressLine1}</p>
                {result.returnAddressLine2 && <p>{result.returnAddressLine2}</p>}
                <p>
                  {result.returnCity}
                  {result.returnCounty ? `, ${result.returnCounty}` : ""}
                </p>
                <p className="font-bold">{result.returnPostcode}</p>
              </div>
            </div>

            {(result.status?.toLowerCase() === "new" || result.status?.toLowerCase() === "paid") && (
              <div className="border-t border-[var(--admin-line)] pt-3">
                <button
                  onClick={() => markReceivedMutation.mutate(result.submissionId)}
                  disabled={markReceivedMutation.isPending}
                  className="w-full border-2 border-[var(--admin-green)] bg-[color-mix(in_srgb,var(--admin-green)_10%,transparent)] text-[var(--admin-green)] py-3 rounded font-bold tracking-widest text-sm transition-all hover:bg-[color-mix(in_srgb,var(--admin-green)_20%,transparent)] disabled:opacity-50 flex items-center justify-center gap-2"
                  data-testid="button-intake-received"
                >
                  <CheckCircle size={18} />
                  {markReceivedMutation.isPending ? "Marking..." : "MARK RECEIVED"}
                </button>
              </div>
            )}

            {result.status?.toLowerCase() === "received" && (
              <div className="border-t border-[var(--admin-line)] pt-3 text-center">
                <p
                  className="text-[var(--admin-green)] font-medium flex items-center justify-center gap-2"
                  data-testid="text-already-received"
                >
                  <CheckCircle size={16} /> Already marked as received
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
