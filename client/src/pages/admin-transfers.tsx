import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Clock, CheckCircle, AlertTriangle, XCircle, Shield, Loader2, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface TransferRow {
  id: number;
  certId: string;
  fromEmail: string;
  toEmail: string;
  flowVersion: string;
  status: string;
  ownerConfirmedAt: string | null;
  disputeDeadline: string | null;
  disputedAt: string | null;
  disputeReason: string | null;
  disputedBy: string | null;
  finalisedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
}

const STATUS_BADGES: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  pending_owner:    { label: "Awaiting Outgoing",   color: "text-amber-600 bg-amber-50 border-amber-200",     icon: Clock },
  pending_incoming: { label: "Awaiting Incoming",   color: "text-blue-600 bg-blue-50 border-blue-200",        icon: Clock },
  pending_dispute:  { label: "Dispute Window",      color: "text-purple-600 bg-purple-50 border-purple-200",  icon: Shield },
  completed:        { label: "Completed",           color: "text-green-600 bg-green-50 border-green-200",     icon: CheckCircle },
  disputed:         { label: "Disputed",            color: "text-red-600 bg-red-50 border-red-200",           icon: AlertTriangle },
  cancelled:        { label: "Cancelled",           color: "text-gray-500 bg-gray-50 border-gray-200",        icon: XCircle },
  expired:          { label: "Expired",             color: "text-gray-400 bg-gray-50 border-gray-200",        icon: XCircle },
};

const ACTIONABLE_STATUSES = ["pending_owner", "pending_incoming", "pending_dispute", "disputed"];
const FINALISABLE_STATUSES = ["pending_dispute", "disputed"];

function StatusBadge({ status, flowVersion }: { status: string; flowVersion: string }) {
  const badge = STATUS_BADGES[status] || { label: status, color: "text-gray-500 bg-gray-50 border-gray-200", icon: Clock };
  const Icon = badge.icon;
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${badge.color}`}>
        <Icon size={10} /> {badge.label}
      </span>
      {flowVersion === "v1" && (
        <span className="text-[9px] uppercase tracking-wider text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">Legacy</span>
      )}
    </div>
  );
}

function formatDate(d: string | null): string {
  if (!d) return "\u2014";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── Resolve modal ──────────────────────────────────────────────────────────────
function ResolveModal({ transfer, onClose }: { transfer: TransferRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [finaliseReason, setFinaliseReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [finaliseError, setFinaliseError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const canFinalise = FINALISABLE_STATUSES.includes(transfer.status);

  const finaliseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/transfers/${transfer.id}/force-finalise`, { reason: finaliseReason });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/transfers"] });
      onClose();
    },
    onError: async (err: any) => {
      let msg = "Force-finalise failed. Please try again.";
      try { const b = await err.json?.(); if (b?.error) msg = b.error; } catch {}
      setFinaliseError(msg);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/transfers/${transfer.id}/force-cancel`, { reason: cancelReason });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/transfers"] });
      onClose();
    },
    onError: async (err: any) => {
      let msg = "Cancel failed. Please try again.";
      try { const b = await err.json?.(); if (b?.error) msg = b.error; } catch {}
      setCancelError(msg);
    },
  });

  const anyPending = finaliseMutation.isPending || cancelMutation.isPending;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50"
      onClick={anyPending ? undefined : onClose}
    >
      <div
        className="bg-white rounded-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8E4DC]">
          <h3 className="text-lg font-bold text-[#1A1A1A]">
            Resolve Transfer — <span className="font-mono text-[#D4AF37]">{transfer.certId}</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={anyPending}
            className="text-[#999999] hover:text-[#1A1A1A] transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Summary */}
        <div className="px-6 py-4 border-b border-[#E8E4DC] space-y-2 text-sm">
          <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1">
            <span className="text-[#888888] text-xs uppercase tracking-wider">Status</span>
            <div><StatusBadge status={transfer.status} flowVersion={transfer.flowVersion} /></div>
            <span className="text-[#888888] text-xs uppercase tracking-wider">From</span>
            <span className="text-[#1A1A1A] font-mono text-xs">{transfer.fromEmail}</span>
            <span className="text-[#888888] text-xs uppercase tracking-wider">To</span>
            <span className="text-[#1A1A1A] font-mono text-xs">{transfer.toEmail}</span>
            <span className="text-[#888888] text-xs uppercase tracking-wider">Created</span>
            <span className="text-[#666666] text-xs">{formatDate(transfer.createdAt)}</span>
          </div>
          {transfer.disputeReason && (
            <div className="pt-2 border-t border-[#F0EDE6]">
              <p className="text-xs text-[#888888] uppercase tracking-wider mb-1">
                Dispute{transfer.disputedBy ? ` (by ${transfer.disputedBy} keeper)` : ""}
              </p>
              <p className="text-xs text-[#444444] italic">&quot;{transfer.disputeReason}&quot;</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-[#444444] font-semibold">Choose an action:</p>

          {/* Force Finalise — only for pending_dispute + disputed */}
          {canFinalise && (
            <div className="border border-[#D4AF37]/40 bg-[#FFFDF5] rounded-lg p-4">
              <div className="flex items-start gap-2 mb-3">
                <AlertTriangle size={16} className="text-[#B8960C] shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-[#1A1A1A]">Force Finalise</p>
                  <p className="text-xs text-[#666666] mt-1">
                    Certificate <span className="font-mono font-bold">{transfer.certId}</span> ownership will move:
                  </p>
                  <p className="text-xs text-[#1A1A1A] font-mono mt-1 ml-2">
                    FROM: {transfer.fromEmail}<br />
                    TO:   {transfer.toEmail}
                  </p>
                  <p className="text-xs text-[#B8960C] font-semibold mt-2">This action cannot be reversed.</p>
                </div>
              </div>
              <label className="block text-xs text-[#888888] uppercase tracking-wider mb-1.5">
                Reason (required, min 10 chars)
              </label>
              <textarea
                value={finaliseReason}
                onChange={(e) => { setFinaliseReason(e.target.value); setFinaliseError(null); }}
                disabled={anyPending}
                rows={3}
                placeholder="e.g. Dispute reviewed, incoming keeper provided proof of delivery..."
                className="w-full bg-white border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37] disabled:opacity-60"
              />
              {finaliseError && (
                <p className="text-xs text-red-600 mt-2">{finaliseError}</p>
              )}
              <button
                type="button"
                onClick={() => finaliseMutation.mutate()}
                disabled={finaliseReason.trim().length < 10 || anyPending}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-[#1A1400] btn-gold px-4 py-2 rounded-lg disabled:opacity-50"
              >
                {finaliseMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <AlertTriangle size={12} />}
                {finaliseMutation.isPending ? "Finalising..." : "Force Finalise →"}
              </button>
            </div>
          )}

          {/* Force Cancel — any non-terminal */}
          <div className="border border-[#E8E4DC] bg-[#FAFAF8] rounded-lg p-4">
            <div className="flex items-start gap-2 mb-3">
              <XCircle size={16} className="text-[#888888] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-[#1A1A1A]">Cancel Transfer</p>
                <p className="text-xs text-[#666666] mt-1">
                  Ownership stays with <span className="font-mono">{transfer.fromEmail}</span>.<br />
                  The transfer to <span className="font-mono">{transfer.toEmail}</span> will not proceed.
                </p>
                <p className="text-xs text-[#666666] mt-2">Both parties will be notified by email.</p>
              </div>
            </div>
            <label className="block text-xs text-[#888888] uppercase tracking-wider mb-1.5">
              Reason (required, min 10 chars)
            </label>
            <textarea
              value={cancelReason}
              onChange={(e) => { setCancelReason(e.target.value); setCancelError(null); }}
              disabled={anyPending}
              rows={3}
              placeholder="e.g. Fraud suspected, abandoned by both parties, duplicate transfer..."
              className="w-full bg-white border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm text-[#1A1A1A] placeholder:text-[#999999] focus:outline-none focus:border-[#D4AF37] disabled:opacity-60"
            />
            {cancelError && (
              <p className="text-xs text-red-600 mt-2">{cancelError}</p>
            )}
            <button
              type="button"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelReason.trim().length < 10 || anyPending}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-[#444444] border border-[#999999] bg-white px-4 py-2 rounded-lg hover:bg-[#F5F2EB] disabled:opacity-50"
            >
              {cancelMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
              {cancelMutation.isPending ? "Cancelling..." : "Cancel Transfer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminTransfers() {
  const { data: transfers, isLoading } = useQuery<TransferRow[]>({
    queryKey: ["/api/admin/transfers"],
    refetchInterval: 30000,
  });

  const [resolveTarget, setResolveTarget] = useState<TransferRow | null>(null);

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <p className="text-sm text-[#999999]">Loading transfers...</p>
      </div>
    );
  }

  const rows = transfers || [];
  const active = rows.filter(t => ["pending_owner", "pending_incoming", "pending_dispute"].includes(t.status));
  const completed = rows.filter(t => t.status === "completed");
  const other = rows.filter(t => ["disputed", "cancelled", "expired"].includes(t.status));

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <ArrowRightLeft className="w-5 h-5 text-[#D4AF37]" />
        <h2 className="text-lg font-bold text-[#1A1A1A] tracking-tight">Ownership Transfers</h2>
        <span className="text-xs text-[#999999]">{rows.length} total</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-[#D4AF37]/20 rounded-lg p-4">
          <p className="text-xs text-[#999999] uppercase tracking-wider">Active</p>
          <p className="text-2xl font-bold text-[#D4AF37]">{active.length}</p>
        </div>
        <div className="bg-white border border-green-200 rounded-lg p-4">
          <p className="text-xs text-[#999999] uppercase tracking-wider">Completed</p>
          <p className="text-2xl font-bold text-green-600">{completed.length}</p>
        </div>
        <div className="bg-white border border-red-200 rounded-lg p-4">
          <p className="text-xs text-[#999999] uppercase tracking-wider">Disputed / Cancelled</p>
          <p className="text-2xl font-bold text-red-500">{other.length}</p>
        </div>
      </div>

      {/* Transfer table */}
      <div className="bg-white border border-[#D4AF37]/20 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[#FAFAF5] text-left text-[10px] uppercase tracking-wider text-[#999999]">
              <th className="px-4 py-2">Cert ID</th>
              <th className="px-4 py-2">From</th>
              <th className="px-4 py-2">To</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Dispute Deadline</th>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-[#999999] text-xs">No transfers found</td></tr>
            )}
            {rows.map((t) => {
              const actionable = ACTIONABLE_STATUSES.includes(t.status);
              return (
                <tr key={t.id} className="border-t border-[#F0F0F0] hover:bg-[#FAFAF5] transition-colors">
                  <td className="px-4 py-2 font-mono text-xs text-[#D4AF37]">{t.certId}</td>
                  <td className="px-4 py-2 text-xs text-[#666666] max-w-[160px] truncate">{t.fromEmail}</td>
                  <td className="px-4 py-2 text-xs text-[#666666] max-w-[160px] truncate">{t.toEmail}</td>
                  <td className="px-4 py-2"><StatusBadge status={t.status} flowVersion={t.flowVersion} /></td>
                  <td className="px-4 py-2 text-xs text-[#888888]">{formatDate(t.disputeDeadline)}</td>
                  <td className="px-4 py-2 text-xs text-[#888888]">{formatDate(t.createdAt)}</td>
                  <td className="px-4 py-2">
                    {actionable ? (
                      <button
                        type="button"
                        onClick={() => setResolveTarget(t)}
                        className="text-xs font-semibold text-[#B8960C] hover:text-[#D4AF37] transition-colors"
                      >
                        Resolve →
                      </button>
                    ) : (
                      <span className="text-[10px] text-[#CCCCCC]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Disputed transfers detail */}
      {other.filter(t => t.status === "disputed").length > 0 && (
        <div className="bg-white border border-red-200 rounded-lg p-4">
          <h3 className="text-sm font-bold text-red-600 mb-3">Disputed Transfers</h3>
          {other.filter(t => t.status === "disputed").map(t => (
            <div key={t.id} className="border-t border-red-100 py-3 first:border-0 first:pt-0">
              <p className="text-xs"><strong>{t.certId}</strong> — disputed by <strong>{t.disputedBy}</strong> on {formatDate(t.disputedAt)}</p>
              {t.disputeReason && <p className="text-xs text-[#666666] mt-1">Reason: {t.disputeReason}</p>}
            </div>
          ))}
        </div>
      )}

      {resolveTarget && (
        <ResolveModal
          transfer={resolveTarget}
          onClose={() => setResolveTarget(null)}
        />
      )}
    </div>
  );
}
