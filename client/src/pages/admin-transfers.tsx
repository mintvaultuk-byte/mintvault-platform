import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Clock, CheckCircle, AlertTriangle, XCircle, Shield } from "lucide-react";

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

export default function AdminTransfers() {
  const { data: transfers, isLoading } = useQuery<TransferRow[]>({
    queryKey: ["/api/admin/transfers"],
    refetchInterval: 30000,
  });

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
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-[#999999] text-xs">No transfers found</td></tr>
            )}
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-[#F0F0F0] hover:bg-[#FAFAF5] transition-colors">
                <td className="px-4 py-2 font-mono text-xs text-[#D4AF37]">{t.certId}</td>
                <td className="px-4 py-2 text-xs text-[#666666] max-w-[160px] truncate">{t.fromEmail}</td>
                <td className="px-4 py-2 text-xs text-[#666666] max-w-[160px] truncate">{t.toEmail}</td>
                <td className="px-4 py-2"><StatusBadge status={t.status} flowVersion={t.flowVersion} /></td>
                <td className="px-4 py-2 text-xs text-[#888888]">{formatDate(t.disputeDeadline)}</td>
                <td className="px-4 py-2 text-xs text-[#888888]">{formatDate(t.createdAt)}</td>
              </tr>
            ))}
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
    </div>
  );
}
