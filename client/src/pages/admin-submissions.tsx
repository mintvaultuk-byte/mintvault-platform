import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { SUBMISSION_STATUS_LABELS, SUBMISSION_STATUS_TRANSITIONS, pricingTiers, submissionTypes } from "@shared/schema";
import {
  ArrowLeft, Package, Search, Printer, CheckCircle, Truck, Clock,
  MapPin, Phone, Mail, FileText, ChevronRight, ScanLine, X, Edit2, Save, XCircle, CreditCard, Download,
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
  shippedAt: string;
  completedAt: string;
  returnCarrier: string;
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
    case "new": case "paid": return "bg-blue-500/20 text-blue-400 border-blue-500/40";
    case "received": return "bg-amber-500/20 text-amber-400 border-amber-500/40";
    case "in_grading": return "bg-purple-500/20 text-purple-400 border-purple-500/40";
    case "ready_to_return": return "bg-emerald-500/20 text-emerald-400 border-emerald-500/40";
    case "shipped": return "bg-cyan-500/20 text-cyan-400 border-cyan-500/40";
    case "completed": return "bg-green-500/20 text-green-400 border-green-500/40";
    case "draft": return "bg-gray-500/20 text-gray-400 border-gray-500/40";
    default: return "bg-gray-500/20 text-gray-400 border-gray-500/40";
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
          <h1 className="text-2xl font-bold text-[#D4AF37] tracking-widest" data-testid="text-submissions-title">
            SUBMISSIONS
          </h1>
          <p className="text-gray-500 text-sm">{subs.length} total submissions{hasActiveFilters ? " (filtered)" : ""}</p>
        </div>
        <a
          href="/api/admin/submissions/export-csv"
          className="inline-flex items-center gap-2 border border-[#D4AF37]/40 text-[#D4AF37] px-4 py-2 rounded text-sm font-medium hover:bg-[#D4AF37]/10 transition-colors"
          data-testid="button-export-submissions-csv"
        >
          <Download size={16} /> Export CSV
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/40" size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search ID, name, email, postcode..."
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-4 py-2 pl-9 text-white text-sm placeholder:text-[#D4AF37]/30 focus:outline-none focus:border-[#D4AF37] transition-colors"
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
                  ? "bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40"
                  : "text-gray-500 border-gray-700 hover:text-gray-300"
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
          <label className="text-gray-500 text-xs">From:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37] transition-colors"
            data-testid="input-date-from-subs"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-gray-500 text-xs">To:</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37] transition-colors"
            data-testid="input-date-to-subs"
          />
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => { setStatusFilter("all"); setDateFrom(""); setDateTo(""); setSearchQuery(""); }}
            className="text-xs text-gray-500 hover:text-[#D4AF37] flex items-center gap-1 transition-colors"
            data-testid="button-clear-filters-subs"
          >
            <X size={12} /> Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-[#D4AF37]/5 rounded" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-[#D4AF37]/10 rounded-lg">
          <Package className="mx-auto text-[#D4AF37]/20 mb-3" size={40} />
          <p className="text-gray-500">{searchQuery ? "No matching submissions" : "No submissions yet"}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((sub) => (
            <button
              key={sub.id}
              onClick={() => setSelectedSub(sub.submissionId)}
              className="w-full border border-[#D4AF37]/15 rounded-lg p-4 flex items-center justify-between gap-3 hover:border-[#D4AF37]/30 transition-colors text-left"
              data-testid={`sub-row-${sub.submissionId}`}
            >
              <div className="flex items-center gap-4 min-w-0 flex-1">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[#D4AF37] font-mono text-xs font-bold">{sub.submissionId}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${statusColor(sub.status)}`}>
                      {SUBMISSION_STATUS_LABELS[sub.status?.toLowerCase()] || sub.status}
                    </span>
                    {sub.highValueFlag && (
                      <span className="text-xs px-1.5 py-0.5 rounded border bg-red-500/20 text-red-400 border-red-500/40">
                        HV
                      </span>
                    )}
                  </div>
                  <p className="text-white text-sm">
                    {sub.customerFirstName} {sub.customerLastName}
                    <span className="text-gray-500 ml-2 text-xs">{sub.returnPostcode}</span>
                  </p>
                  <p className="text-gray-500 text-xs">
                    {sub.cardCount || 0} cards · {pricingTiers.find(t => t.id === sub.serviceTier)?.name || sub.serviceTier || "—"}
                    · £{parseFloat(sub.totalPrice || "0").toFixed(2)}
                    · {sub.createdAt ? new Date(sub.createdAt).toLocaleDateString() : ""}
                  </p>
                </div>
              </div>
              <ChevronRight size={16} className="text-[#D4AF37]/30 shrink-0" />
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
  const [carrierInput, setCarrierInput] = useState("Royal Mail");
  const [postageCostInput, setPostageCostInput] = useState("");
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [adminNotesInput, setAdminNotesInput] = useState<string>("");
  const [adminFlaggedInput, setAdminFlaggedInput] = useState<boolean>(false);
  const [notesSaved, setNotesSaved] = useState(false);

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
        trackingNumber: trackingInput,
        postageCost: postageCostInput,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", submissionId] });
      setShowReturnForm(false);
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

  useEffect(() => {
    if (sub) {
      setAdminNotesInput(sub.adminNotes ?? "");
      setAdminFlaggedInput(!!sub.adminFlagged);
    }
  }, [sub?.submissionId]);

  if (isLoading || !sub) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <button onClick={onBack} className="text-[#D4AF37]/60 hover:text-[#D4AF37] text-sm mb-4" data-testid="button-back-subs">
          <ArrowLeft size={14} className="inline mr-1" /> Back to Submissions
        </button>
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-[#D4AF37]/10 rounded w-48" />
          <div className="h-64 bg-[#D4AF37]/5 rounded" />
        </div>
      </div>
    );
  }

  const currentStatus = sub.status?.toLowerCase();
  const nextStatus = SUBMISSION_STATUS_TRANSITIONS[currentStatus];
  const tierData = pricingTiers.find(t => t.id === sub.serviceTier);
  const typeData = submissionTypes.find(t => t.id === sub.serviceType);

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
      <button onClick={onBack} className="text-[#D4AF37]/60 hover:text-[#D4AF37] text-sm mb-4 transition-colors" data-testid="button-back-subs">
        <ArrowLeft size={14} className="inline mr-1" /> Back to Submissions
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-[#D4AF37] font-mono tracking-wider" data-testid="text-sub-detail-id">
            {sub.submissionId}
          </h2>
          <span className={`text-xs px-2 py-0.5 rounded border ${statusColor(sub.status)}`}>
            {SUBMISSION_STATUS_LABELS[currentStatus] || sub.status}
          </span>
          {sub.highValueFlag && (
            <span className="text-xs px-2 py-0.5 rounded border bg-red-500/20 text-red-400 border-red-500/40 ml-1" data-testid="badge-high-value">
              High Value
            </span>
          )}
          {sub.requiresManualApproval && (
            <span className="text-xs px-2 py-0.5 rounded border bg-amber-500/20 text-amber-400 border-amber-500/40 ml-1" data-testid="badge-manual-approval">
              Requires Approval
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/admin/submissions/${submissionId}/packing-slip`}
            className="text-xs border border-[#D4AF37]/30 text-[#D4AF37]/60 hover:text-[#D4AF37] px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors"
            data-testid="button-print-slip"
          >
            <Printer size={12} /> Print Slip
          </a>
        </div>
      </div>

      {nextStatus && (
        <div className="border border-[#D4AF37]/30 rounded-lg p-4 mb-6 bg-[#D4AF37]/5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-[#D4AF37] text-sm font-medium">
                Next step: {SUBMISSION_STATUS_LABELS[nextStatus]}
              </p>
              <p className="text-gray-500 text-xs">
                {SUBMISSION_STATUS_LABELS[currentStatus]} → {SUBMISSION_STATUS_LABELS[nextStatus]}
              </p>
            </div>

            {nextStatus === "shipped" ? (
              <button
                onClick={() => setShowReturnForm(true)}
                disabled={statusMutation.isPending}
                className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[#D4AF37]/20 flex items-center gap-2 disabled:opacity-50"
                data-testid="button-advance-status"
              >
                <Truck size={14} /> Mark Shipped
              </button>
            ) : (
              <button
                onClick={handleAdvanceStatus}
                disabled={statusMutation.isPending}
                className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[#D4AF37]/20 flex items-center gap-2 disabled:opacity-50"
                data-testid="button-advance-status"
              >
                <CheckCircle size={14} />
                {statusMutation.isPending ? "Updating..." : `Mark ${SUBMISSION_STATUS_LABELS[nextStatus]}`}
              </button>
            )}
          </div>
        </div>
      )}

      {showReturnForm && (
        <div className="border border-[#D4AF37]/30 rounded-lg p-4 mb-6">
          <h3 className="text-[#D4AF37] font-semibold text-sm uppercase tracking-wider mb-3">
            Shipping Details
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-gray-400 text-xs block mb-1">Carrier</label>
              <select
                value={carrierInput}
                onChange={(e) => setCarrierInput(e.target.value)}
                className="w-full bg-black border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37]"
                data-testid="select-carrier"
              >
                <option value="Royal Mail">Royal Mail</option>
                <option value="Evri">Evri</option>
                <option value="DPD">DPD</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs block mb-1">Tracking Number *</label>
              <input
                type="text"
                value={trackingInput}
                onChange={(e) => setTrackingInput(e.target.value)}
                className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37]"
                data-testid="input-return-tracking"
              />
            </div>
          </div>
          <div className="max-w-[200px] mb-3">
            <label className="text-gray-400 text-xs block mb-1">Return Postage Cost (pence)</label>
            <input
              type="number"
              value={postageCostInput}
              onChange={(e) => setPostageCostInput(e.target.value)}
              placeholder="Optional"
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37]"
              data-testid="input-postage-cost"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!trackingInput) return;
                statusMutation.mutate({
                  status: "shipped",
                  extra: { returnTracking: trackingInput, returnCarrier: carrierInput },
                });
              }}
              disabled={!trackingInput || statusMutation.isPending}
              className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[#D4AF37]/20 disabled:opacity-50 flex items-center gap-2"
              data-testid="button-confirm-shipped"
            >
              <Truck size={14} /> {statusMutation.isPending ? "Shipping..." : "Confirm Shipped"}
            </button>
            <button
              onClick={() => setShowReturnForm(false)}
              className="text-gray-400 hover:text-white text-sm px-4 py-2 rounded border border-gray-700 hover:border-gray-500 transition-colors"
              data-testid="button-cancel-ship"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="border border-[#D4AF37]/20 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <MapPin size={14} className="text-[#D4AF37]" />
            <h3 className="text-[#D4AF37] font-semibold text-xs uppercase tracking-wider">Return Address</h3>
          </div>
          <div className="text-white text-sm space-y-0.5" data-testid="text-return-address">
            <p className="font-medium">{sub.customerFirstName} {sub.customerLastName}</p>
            <p>{sub.returnAddressLine1}</p>
            {sub.returnAddressLine2 && <p>{sub.returnAddressLine2}</p>}
            <p>{sub.returnCity}</p>
            {sub.returnCounty && <p>{sub.returnCounty}</p>}
            <p className="font-bold">{sub.returnPostcode}</p>
          </div>
        </div>

        <div className="border border-[#D4AF37]/20 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Mail size={14} className="text-[#D4AF37]" />
            <h3 className="text-[#D4AF37] font-semibold text-xs uppercase tracking-wider">Contact</h3>
          </div>
          <div className="text-sm space-y-1.5">
            <p className="text-white">{sub.customerEmail}</p>
            {sub.phone && <p className="text-gray-400 flex items-center gap-1"><Phone size={12} /> {sub.phone}</p>}
          </div>
        </div>
      </div>

      <div className="border border-[#D4AF37]/20 rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={14} className="text-[#D4AF37]" />
          <h3 className="text-[#D4AF37] font-semibold text-xs uppercase tracking-wider">Order Details</h3>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <DetailRow label="Service" value={typeData?.name || sub.serviceType} />
          <DetailRow label="Tier" value={tierData?.name || sub.serviceTier} />
          <DetailRow label="Cards" value={`${sub.cardCount || 0}`} />
          <DetailRow label="Declared Value" value={`£${sub.totalDeclaredValue?.toLocaleString() || "0"}`} />
          <DetailRow label="Service Cost" value={`£${((sub.gradingCost || 0) / 100).toFixed(2)}`} />
          <DetailRow label="Shipping" value={`£${((sub.shippingCost || 0) / 100).toFixed(2)}`} />
          <DetailRow label="Shipping Insurance" value={sub.shippingInsuranceTier || "—"} />
          {sub.insuranceFee > 0 && <DetailRow label="Insurance Surcharge" value={`£${(sub.insuranceFee / 100).toFixed(2)}`} />}
          <DetailRow label="Total Paid" value={`£${parseFloat(sub.totalPrice || "0").toFixed(2)}`} highlight />
          <DetailRow label="Payment Ref" value={sub.paymentIntentId?.slice(0, 20) || "—"} />
          {sub.notes && <div className="col-span-2"><DetailRow label="Notes" value={sub.notes} /></div>}
        </div>
      </div>

      {sub.serviceType === "crossover" && (
        <div className="border border-amber-500/30 rounded-lg p-4 mb-6 bg-amber-500/5" data-testid="section-crossover-details">
          <div className="flex items-center gap-2 mb-3">
            <ScanLine size={14} className="text-amber-400" />
            <h3 className="text-amber-400 font-semibold text-xs uppercase tracking-wider">Crossover Details</h3>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <DetailRow label="Original Company" value={sub.crossoverCompany || "—"} testId="text-admin-crossover-company" />
            {sub.crossoverOriginalGrade && <DetailRow label="Original Grade" value={sub.crossoverOriginalGrade} testId="text-admin-crossover-grade" />}
            {sub.crossoverCertNumber && <DetailRow label="Cert Number" value={sub.crossoverCertNumber} testId="text-admin-crossover-cert" />}
          </div>
          <p className="text-amber-400/60 text-xs mt-3">⚠️ Subject to review — return cards that do not meet crossover standards.</p>
        </div>
      )}

      {sub.serviceType === "reholder" && (sub.reholderCompany || sub.reholderReason || sub.reholderCondition) && (
        <div className="border border-purple-500/30 rounded-lg p-4 mb-6 bg-purple-500/5" data-testid="section-reholder-details">
          <div className="flex items-center gap-2 mb-3">
            <Package size={14} className="text-purple-400" />
            <h3 className="text-purple-400 font-semibold text-xs uppercase tracking-wider">Reholder Details</h3>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {sub.reholderCompany && <DetailRow label="Current Grader" value={sub.reholderCompany} testId="text-admin-reholder-company" />}
            {sub.reholderReason && <DetailRow label="Reason" value={sub.reholderReason} testId="text-admin-reholder-reason" />}
            {sub.reholderCondition && <DetailRow label="Slab Condition" value={sub.reholderCondition} testId="text-admin-reholder-condition" />}
          </div>
        </div>
      )}

      {sub.serviceType === "authentication" && (sub.authReason || sub.authConcerns) && (
        <div className="border border-blue-500/30 rounded-lg p-4 mb-6 bg-blue-500/5" data-testid="section-auth-details">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={14} className="text-blue-400" />
            <h3 className="text-blue-400 font-semibold text-xs uppercase tracking-wider">Authentication Details</h3>
          </div>
          <div className="grid grid-cols-1 gap-y-2 text-sm">
            {sub.authReason && <DetailRow label="Reason for Authentication" value={sub.authReason} testId="text-admin-auth-reason" />}
            {sub.authConcerns && <DetailRow label="Specific Concerns" value={sub.authConcerns} testId="text-admin-auth-concerns" />}
          </div>
        </div>
      )}

      {sub.items && sub.items.length > 0 && (
        <SubmissionItemsSection submissionId={sub.submissionId} items={sub.items} />
      )}

      {(sub.returnCarrier || sub.returnTracking) && (
        <div className="border border-cyan-500/20 rounded-lg p-4 mb-6 bg-cyan-500/5">
          <div className="flex items-center gap-2 mb-3">
            <Truck size={14} className="text-cyan-400" />
            <h3 className="text-cyan-400 font-semibold text-xs uppercase tracking-wider">Return Shipping</h3>
          </div>
          <div className="text-sm space-y-1">
            {sub.returnCarrier && <p className="text-white">Carrier: {sub.returnCarrier}</p>}
            {sub.returnTracking && <p className="text-white font-mono">Tracking: {sub.returnTracking}</p>}
            {sub.returnPostageCost && <p className="text-gray-400">Postage: £{(sub.returnPostageCost / 100).toFixed(2)}</p>}
          </div>
        </div>
      )}

      <div className="border border-red-500/30 rounded-lg p-4 mb-6 bg-red-500/5" data-testid="section-admin-notes">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={14} className="text-red-400" />
          <h3 className="text-red-400 font-semibold text-xs uppercase tracking-wider">Admin Notes</h3>
          {sub.adminFlagged && (
            <span className="ml-auto text-xs bg-red-500/20 text-red-400 border border-red-500/40 rounded px-2 py-0.5" data-testid="badge-flagged">Flagged</span>
          )}
        </div>
        <textarea
          value={adminNotesInput}
          onChange={(e) => setAdminNotesInput(e.target.value)}
          placeholder="Internal notes visible to admin only…"
          rows={3}
          className="w-full bg-black/40 border border-[#D4AF37]/20 rounded px-3 py-2 text-white text-sm resize-none focus:outline-none focus:border-[#D4AF37]/60 placeholder:text-gray-600"
          data-testid="textarea-admin-notes"
        />
        <div className="flex items-center gap-4 mt-3">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none" data-testid="label-flag-submission">
            <input
              type="checkbox"
              checked={adminFlaggedInput}
              onChange={(e) => setAdminFlaggedInput(e.target.checked)}
              className="accent-red-500 w-4 h-4"
              data-testid="checkbox-admin-flagged"
            />
            Flag this submission for review
          </label>
          <button
            onClick={() => adminNotesMutation.mutate()}
            disabled={adminNotesMutation.isPending}
            className="ml-auto border border-[#D4AF37]/50 bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-1.5 rounded text-sm font-medium hover:bg-[#D4AF37]/20 transition-all disabled:opacity-50"
            data-testid="button-save-admin-notes"
          >
            {adminNotesMutation.isPending ? "Saving…" : notesSaved ? "Saved ✓" : "Save Notes"}
          </button>
        </div>
      </div>

      <div className="border border-[#D4AF37]/20 rounded-lg p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={14} className="text-[#D4AF37]" />
          <h3 className="text-[#D4AF37] font-semibold text-xs uppercase tracking-wider">Timeline</h3>
        </div>
        <div className="space-y-2 text-sm">
          <TimelineEntry label="Created" time={sub.createdAt} />
          <TimelineEntry label="Received" time={sub.receivedAt} />
          <TimelineEntry label="Shipped" time={sub.shippedAt} />
          <TimelineEntry label="Completed" time={sub.completedAt} />
        </div>
      </div>

      {!showReturnForm && currentStatus === "ready_to_return" && (
        <div className="border border-[#D4AF37]/20 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Truck size={14} className="text-[#D4AF37]" />
            <h3 className="text-[#D4AF37] font-semibold text-xs uppercase tracking-wider">Create Return Label</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-gray-400 text-xs block mb-1">Carrier</label>
              <select
                value={carrierInput}
                onChange={(e) => setCarrierInput(e.target.value)}
                className="w-full bg-black border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37]"
                data-testid="select-return-carrier"
              >
                <option value="Royal Mail">Royal Mail</option>
                <option value="Evri">Evri</option>
                <option value="DPD">DPD</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-gray-400 text-xs block mb-1">Tracking Number</label>
              <input
                type="text"
                value={trackingInput}
                onChange={(e) => setTrackingInput(e.target.value)}
                className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37]"
                data-testid="input-ret-tracking"
              />
            </div>
          </div>
          <div className="max-w-[200px] mb-3">
            <label className="text-gray-400 text-xs block mb-1">Postage Cost (pence, optional)</label>
            <input
              type="number"
              value={postageCostInput}
              onChange={(e) => setPostageCostInput(e.target.value)}
              className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#D4AF37]"
              data-testid="input-ret-postage"
            />
          </div>
          <button
            onClick={() => returnLabelMutation.mutate()}
            disabled={returnLabelMutation.isPending}
            className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-2 rounded font-medium text-sm transition-all hover:bg-[#D4AF37]/20 disabled:opacity-50"
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
    <div className="border border-[#D4AF37]/20 rounded-lg p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <CreditCard size={14} className="text-[#D4AF37]" />
        <h3 className="text-[#D4AF37] font-semibold text-xs uppercase tracking-wider">Customer Card Details</h3>
        <span className="text-gray-500 text-xs ml-auto">{items.length} item{items.length !== 1 ? "s" : ""}</span>
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
              <div key={item.id} className="border border-[#D4AF37]/30 rounded p-3 bg-[#D4AF37]/5" data-testid={`item-edit-${item.id}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[#D4AF37] text-xs font-bold">Card #{index}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => saveEdit(item.id)}
                      disabled={updateItemMutation.isPending}
                      className="text-emerald-400 hover:text-emerald-300 p-1 transition-colors"
                      data-testid={`button-save-item-${item.id}`}
                    >
                      <Save size={14} />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="text-gray-400 hover:text-white p-1 transition-colors"
                      data-testid={`button-cancel-item-${item.id}`}
                    >
                      <XCircle size={14} />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  <div>
                    <label className="text-gray-500 text-xs block mb-0.5">Game</label>
                    <select
                      value={editData.game}
                      onChange={(e) => setEditData({ ...editData, game: e.target.value })}
                      className="w-full bg-black border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37]"
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
                    <label className="text-gray-500 text-xs block mb-0.5">Card Name</label>
                    <input
                      type="text"
                      value={editData.cardName}
                      onChange={(e) => setEditData({ ...editData, cardName: e.target.value })}
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37]"
                      data-testid={`input-cardname-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-0.5">Set</label>
                    <input
                      type="text"
                      value={editData.cardSet}
                      onChange={(e) => setEditData({ ...editData, cardSet: e.target.value })}
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37]"
                      data-testid={`input-cardset-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-0.5">Card #</label>
                    <input
                      type="text"
                      value={editData.cardNumber}
                      onChange={(e) => setEditData({ ...editData, cardNumber: e.target.value })}
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37]"
                      data-testid={`input-cardnumber-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-0.5">Year</label>
                    <input
                      type="text"
                      value={editData.year}
                      onChange={(e) => setEditData({ ...editData, year: e.target.value })}
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37]"
                      data-testid={`input-year-${item.id}`}
                    />
                  </div>
                  <div>
                    <label className="text-gray-500 text-xs block mb-0.5">Declared (£)</label>
                    <input
                      type="number"
                      value={editData.declaredValue}
                      onChange={(e) => setEditData({ ...editData, declaredValue: e.target.value })}
                      className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37]"
                      data-testid={`input-declared-${item.id}`}
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <label className="text-gray-500 text-xs block mb-0.5">Notes</label>
                  <input
                    type="text"
                    value={editData.notes}
                    onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                    className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37]"
                    data-testid={`input-notes-${item.id}`}
                  />
                </div>
              </div>
            );
          }

          return (
            <div
              key={item.id}
              className="border border-[#D4AF37]/10 rounded p-3 flex items-start justify-between gap-3 group"
              data-testid={`item-row-${item.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="text-[#D4AF37] text-xs font-bold">#{index}</span>
                  {item.game && <span className="text-xs text-gray-400">{item.game}</span>}
                  {cardName ? (
                    <span className="text-white text-sm font-medium">{cardName}</span>
                  ) : (
                    <span className="text-gray-600 text-sm italic">(Not provided)</span>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap text-xs text-gray-500">
                  <span>Set: {cardSet || <span className="text-gray-600 italic">(Not provided)</span>}</span>
                  <span>#{cardNumber || <span className="text-gray-600 italic">—</span>}</span>
                  <span>Year: {item.year || <span className="text-gray-600 italic">—</span>}</span>
                  <span>£{declaredValue.toLocaleString()}</span>
                  {item.notes && <span className="text-gray-400 truncate max-w-[150px]">{item.notes}</span>}
                </div>
              </div>
              <button
                onClick={() => startEdit(item)}
                className="text-gray-600 hover:text-[#D4AF37] p-1 transition-colors shrink-0"
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

function DetailRow({ label, value, highlight, testId }: { label: string; value: string; highlight?: boolean; testId?: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-gray-500 text-xs">{label}</span>
      <span className={`font-medium ${highlight ? "text-[#D4AF37] font-bold" : "text-white"}`} data-testid={testId}>{value}</span>
    </div>
  );
}

function TimelineEntry({ label, time }: { label: string; time?: string }) {
  if (!time) return (
    <div className="flex items-center gap-3 text-gray-600">
      <div className="w-2 h-2 rounded-full bg-gray-700" />
      <span className="text-xs">{label}</span>
      <span className="text-xs">—</span>
    </div>
  );
  return (
    <div className="flex items-center gap-3 text-emerald-400">
      <div className="w-2 h-2 rounded-full bg-emerald-400" />
      <span className="text-xs font-medium">{label}</span>
      <span className="text-xs text-gray-400">{new Date(time).toLocaleString()}</span>
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
        <ScanLine size={40} className="text-[#D4AF37] mx-auto mb-3" />
        <h1 className="text-2xl font-bold text-[#D4AF37] tracking-widest" data-testid="text-intake-title">
          INTAKE SCANNER
        </h1>
        <p className="text-gray-500 text-sm">Scan or enter a Submission ID to mark as received</p>
      </div>

      <div className="flex gap-2 mb-6">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLookup()}
          placeholder="MV-SUB-000001"
          className="flex-1 bg-transparent border-2 border-[#D4AF37]/40 rounded px-4 py-3 text-white text-lg font-mono tracking-wider placeholder:text-[#D4AF37]/20 focus:outline-none focus:border-[#D4AF37] transition-colors text-center"
          autoFocus
          data-testid="input-intake-scan"
        />
        <button
          onClick={handleLookup}
          disabled={loading}
          className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-6 rounded font-medium transition-all hover:bg-[#D4AF37]/20 disabled:opacity-50"
          data-testid="button-intake-lookup"
        >
          {loading ? "..." : "Lookup"}
        </button>
      </div>

      {error && (
        <div className="text-center py-8 border border-red-500/20 rounded-lg bg-red-500/5 mb-4">
          <p className="text-red-400" data-testid="text-intake-error">{error}</p>
        </div>
      )}

      {result && (
        <div className="border border-[#D4AF37]/30 rounded-lg overflow-hidden">
          <div className="bg-[#D4AF37]/5 p-4 border-b border-[#D4AF37]/20 flex items-center justify-between">
            <div>
              <span className="text-[#D4AF37] font-mono font-bold text-lg">{result.submissionId}</span>
              <span className={`ml-3 text-xs px-2 py-0.5 rounded border ${statusColor(result.status)}`}>
                {SUBMISSION_STATUS_LABELS[result.status?.toLowerCase()] || result.status}
              </span>
            </div>
          </div>

          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-gray-500 text-xs">Customer</p>
                <p className="text-white font-medium">{result.customerFirstName} {result.customerLastName}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs">Cards</p>
                <p className="text-white font-medium">{result.cardCount || 0}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs">Email</p>
                <p className="text-white text-sm">{result.customerEmail}</p>
              </div>
              {result.phone && (
                <div>
                  <p className="text-gray-500 text-xs">Phone</p>
                  <p className="text-white text-sm">{result.phone}</p>
                </div>
              )}
            </div>

            <div className="border-t border-[#D4AF37]/10 pt-3">
              <p className="text-gray-500 text-xs mb-1">Return Address</p>
              <div className="text-white text-sm" data-testid="text-intake-address">
                <p>{result.returnAddressLine1}</p>
                {result.returnAddressLine2 && <p>{result.returnAddressLine2}</p>}
                <p>{result.returnCity}{result.returnCounty ? `, ${result.returnCounty}` : ""}</p>
                <p className="font-bold">{result.returnPostcode}</p>
              </div>
            </div>

            {(result.status?.toLowerCase() === "new" || result.status?.toLowerCase() === "paid") && (
              <div className="border-t border-[#D4AF37]/10 pt-3">
                <button
                  onClick={() => markReceivedMutation.mutate(result.submissionId)}
                  disabled={markReceivedMutation.isPending}
                  className="w-full border-2 border-emerald-500 bg-emerald-500/10 text-emerald-400 py-3 rounded font-bold tracking-widest text-sm transition-all hover:bg-emerald-500/20 disabled:opacity-50 flex items-center justify-center gap-2"
                  data-testid="button-intake-received"
                >
                  <CheckCircle size={18} />
                  {markReceivedMutation.isPending ? "Marking..." : "MARK RECEIVED"}
                </button>
              </div>
            )}

            {result.status?.toLowerCase() === "received" && (
              <div className="border-t border-[#D4AF37]/10 pt-3 text-center">
                <p className="text-emerald-400 font-medium flex items-center justify-center gap-2" data-testid="text-already-received">
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
