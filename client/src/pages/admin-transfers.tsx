import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, Clock, CheckCircle, AlertTriangle, XCircle, Shield, Loader2, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import GradientButton from "@/components/ui/gradient-button";

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
  pending_owner: {
    label: "Awaiting Outgoing",
    color:
      "text-[var(--admin-amber)] bg-[color-mix(in_srgb,var(--admin-amber)_18%,transparent)] border-[color-mix(in_srgb,var(--admin-amber)_40%,transparent)]",
    icon: Clock,
  },
  pending_incoming: {
    label: "Awaiting Incoming",
    color: "text-[var(--admin-ink-dim)] bg-[var(--admin-panel2)] border-[var(--admin-line)]",
    icon: Clock,
  },
  pending_dispute: {
    label: "Dispute Window",
    color:
      "text-[var(--admin-gold-hi)] bg-[color-mix(in_srgb,var(--admin-gold)_18%,transparent)] border-[var(--admin-line)]",
    icon: Shield,
  },
  completed: {
    label: "Completed",
    color:
      "text-[var(--admin-green)] bg-[color-mix(in_srgb,var(--admin-green)_18%,transparent)] border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)]",
    icon: CheckCircle,
  },
  disputed: {
    label: "Disputed",
    color:
      "text-[var(--admin-red)] bg-[color-mix(in_srgb,var(--admin-red)_18%,transparent)] border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)]",
    icon: AlertTriangle,
  },
  cancelled: {
    label: "Cancelled",
    color: "text-[var(--admin-ink-faint)] bg-[var(--admin-panel2)] border-[var(--admin-line-soft)]",
    icon: XCircle,
  },
  expired: {
    label: "Expired",
    color: "text-[var(--admin-ink-faint)] bg-[var(--admin-panel2)] border-[var(--admin-line-soft)]",
    icon: XCircle,
  },
};

const ACTIONABLE_STATUSES = ["pending_owner", "pending_incoming", "pending_dispute", "disputed"];
const FINALISABLE_STATUSES = ["pending_dispute", "disputed"];

function StatusBadge({ status, flowVersion }: { status: string; flowVersion: string }) {
  const badge = STATUS_BADGES[status] || {
    label: status,
    color: "text-[var(--admin-ink-faint)] bg-[var(--admin-panel2)] border-[var(--admin-line-soft)]",
    icon: Clock,
  };
  const Icon = badge.icon;
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${badge.color}`}
      >
        <Icon size={10} /> {badge.label}
      </span>
      {flowVersion === "v1" && (
        <span className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)] border border-[var(--admin-line-soft)] rounded px-1.5 py-0.5">
          Legacy
        </span>
      )}
    </div>
  );
}

function formatDate(d: string | null): string {
  if (!d) return "\u2014";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
      const res = await apiRequest("POST", `/api/admin/transfers/${transfer.id}/force-finalise`, {
        reason: finaliseReason,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/transfers"] });
      onClose();
    },
    onError: async (err: any) => {
      let msg = "Force-finalise failed. Please try again.";
      try {
        const b = await err.json?.();
        if (b?.error) msg = b.error;
      } catch {}
      setFinaliseError(msg);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/transfers/${transfer.id}/force-cancel`, {
        reason: cancelReason,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/transfers"] });
      onClose();
    },
    onError: async (err: any) => {
      let msg = "Cancel failed. Please try again.";
      try {
        const b = await err.json?.();
        if (b?.error) msg = b.error;
      } catch {}
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
        className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--admin-line)]">
          <h3 className="text-lg font-bold text-[var(--admin-ink)]">
            Resolve Transfer —{" "}
            <span className="font-mono text-[var(--admin-gold-hi)]" style={{ fontFamily: "var(--admin-mono)" }}>
              {transfer.certId}
            </span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={anyPending}
            className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)] transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Summary */}
        <div className="px-6 py-4 border-b border-[var(--admin-line)] space-y-2 text-sm">
          <div className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1">
            <span className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-wider">Status</span>
            <div>
              <StatusBadge status={transfer.status} flowVersion={transfer.flowVersion} />
            </div>
            <span className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-wider">From</span>
            <span className="text-[var(--admin-ink)] font-mono text-xs" style={{ fontFamily: "var(--admin-mono)" }}>
              {transfer.fromEmail}
            </span>
            <span className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-wider">To</span>
            <span className="text-[var(--admin-ink)] font-mono text-xs" style={{ fontFamily: "var(--admin-mono)" }}>
              {transfer.toEmail}
            </span>
            <span className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-wider">Created</span>
            <span className="text-[var(--admin-ink-dim)] text-xs">{formatDate(transfer.createdAt)}</span>
          </div>
          {transfer.disputeReason && (
            <div className="pt-2 border-t border-[var(--admin-line-soft)]">
              <p className="text-xs text-[var(--admin-ink-faint)] uppercase tracking-wider mb-1">
                Dispute{transfer.disputedBy ? ` (by ${transfer.disputedBy} keeper)` : ""}
              </p>
              <p className="text-xs text-[var(--admin-ink-dim)] italic">&quot;{transfer.disputeReason}&quot;</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-[var(--admin-ink-dim)] font-semibold">Choose an action:</p>

          {/* Force Finalise — only for pending_dispute + disputed */}
          {canFinalise && (
            <div className="border border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)] bg-[color-mix(in_srgb,var(--admin-gold)_8%,transparent)] rounded-lg p-4">
              <div className="flex items-start gap-2 mb-3">
                <AlertTriangle size={16} className="text-[var(--admin-gold-hi)] shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-[var(--admin-ink)]">Force Finalise</p>
                  <p className="text-xs text-[var(--admin-ink-dim)] mt-1">
                    Certificate{" "}
                    <span className="font-mono font-bold" style={{ fontFamily: "var(--admin-mono)" }}>
                      {transfer.certId}
                    </span>{" "}
                    ownership will move:
                  </p>
                  <p
                    className="text-xs text-[var(--admin-ink)] font-mono mt-1 ml-2"
                    style={{ fontFamily: "var(--admin-mono)" }}
                  >
                    FROM: {transfer.fromEmail}
                    <br />
                    TO: {transfer.toEmail}
                  </p>
                  <p className="text-xs text-[var(--admin-gold-hi)] font-semibold mt-2">
                    This action cannot be reversed.
                  </p>
                </div>
              </div>
              <label className="block text-xs text-[var(--admin-ink-faint)] uppercase tracking-wider mb-1.5">
                Reason (required, min 10 chars)
              </label>
              <textarea
                value={finaliseReason}
                onChange={(e) => {
                  setFinaliseReason(e.target.value);
                  setFinaliseError(null);
                }}
                disabled={anyPending}
                rows={3}
                placeholder="e.g. Dispute reviewed, incoming keeper provided proof of delivery..."
                className="w-full bg-transparent border border-[var(--admin-line)] rounded-lg px-3 py-2 text-sm text-[var(--admin-ink)] placeholder:text-[var(--admin-ink-faint)] focus:outline-none focus:border-[var(--admin-gold)] disabled:opacity-60"
              />
              {finaliseError && <p className="text-xs text-[var(--admin-red)] mt-2">{finaliseError}</p>}
              <GradientButton
                as="button"
                type="button"
                onClick={() => finaliseMutation.mutate()}
                disabled={finaliseReason.trim().length < 10 || anyPending}
                height="36px"
                className="gradient-btn-filled mt-3"
              >
                {finaliseMutation.isPending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <AlertTriangle size={12} />
                )}
                {finaliseMutation.isPending ? "Finalising..." : "Force Finalise →"}
              </GradientButton>
            </div>
          )}

          {/* Force Cancel — any non-terminal */}
          <div className="border border-[var(--admin-line)] bg-[var(--admin-panel2)] rounded-lg p-4">
            <div className="flex items-start gap-2 mb-3">
              <XCircle size={16} className="text-[var(--admin-ink-faint)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-[var(--admin-ink)]">Cancel Transfer</p>
                <p className="text-xs text-[var(--admin-ink-dim)] mt-1">
                  Ownership stays with{" "}
                  <span className="font-mono" style={{ fontFamily: "var(--admin-mono)" }}>
                    {transfer.fromEmail}
                  </span>
                  .<br />
                  The transfer to{" "}
                  <span className="font-mono" style={{ fontFamily: "var(--admin-mono)" }}>
                    {transfer.toEmail}
                  </span>{" "}
                  will not proceed.
                </p>
                <p className="text-xs text-[var(--admin-ink-dim)] mt-2">Both parties will be notified by email.</p>
              </div>
            </div>
            <label className="block text-xs text-[var(--admin-ink-faint)] uppercase tracking-wider mb-1.5">
              Reason (required, min 10 chars)
            </label>
            <textarea
              value={cancelReason}
              onChange={(e) => {
                setCancelReason(e.target.value);
                setCancelError(null);
              }}
              disabled={anyPending}
              rows={3}
              placeholder="e.g. Fraud suspected, abandoned by both parties, duplicate transfer..."
              className="w-full bg-transparent border border-[var(--admin-line)] rounded-lg px-3 py-2 text-sm text-[var(--admin-ink)] placeholder:text-[var(--admin-ink-faint)] focus:outline-none focus:border-[var(--admin-gold)] disabled:opacity-60"
            />
            {cancelError && <p className="text-xs text-[var(--admin-red)] mt-2">{cancelError}</p>}
            <button
              type="button"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelReason.trim().length < 10 || anyPending}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-[var(--admin-ink-dim)] border border-[var(--admin-line)] bg-transparent px-4 py-2 rounded-lg hover:bg-[var(--admin-panel3)] disabled:opacity-50"
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
        <p className="text-sm text-[var(--admin-ink-dim)]">Loading transfers...</p>
      </div>
    );
  }

  const rows = transfers || [];
  const active = rows.filter((t) => ["pending_owner", "pending_incoming", "pending_dispute"].includes(t.status));
  const completed = rows.filter((t) => t.status === "completed");
  const other = rows.filter((t) => ["disputed", "cancelled", "expired"].includes(t.status));

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <ArrowRightLeft className="w-5 h-5 text-[var(--admin-gold)]" />
        <h2 className="text-lg font-bold text-[var(--admin-ink)] tracking-tight">Ownership Transfers</h2>
        <span className="text-xs text-[var(--admin-ink-faint)]">{rows.length} total</span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-lg p-4">
          <p className="text-xs text-[var(--admin-ink-faint)] uppercase tracking-wider">Active</p>
          <p className="text-2xl font-bold text-[var(--admin-gold-hi)]" style={{ fontFamily: "var(--admin-mono)" }}>
            {active.length}
          </p>
        </div>
        <div className="bg-[var(--admin-panel)] border border-[color-mix(in_srgb,var(--admin-green)_40%,transparent)] rounded-lg p-4">
          <p className="text-xs text-[var(--admin-ink-faint)] uppercase tracking-wider">Completed</p>
          <p className="text-2xl font-bold text-[var(--admin-green)]" style={{ fontFamily: "var(--admin-mono)" }}>
            {completed.length}
          </p>
        </div>
        <div className="bg-[var(--admin-panel)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] rounded-lg p-4">
          <p className="text-xs text-[var(--admin-ink-faint)] uppercase tracking-wider">Disputed / Cancelled</p>
          <p className="text-2xl font-bold text-[var(--admin-red)]" style={{ fontFamily: "var(--admin-mono)" }}>
            {other.length}
          </p>
        </div>
      </div>

      {/* Transfer table */}
      <div className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--admin-panel2)] text-left text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">
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
              <tr>
                <td colSpan={7} className="text-center py-8 text-[var(--admin-ink-faint)] text-xs">
                  No transfers found
                </td>
              </tr>
            )}
            {rows.map((t) => {
              const actionable = ACTIONABLE_STATUSES.includes(t.status);
              return (
                <tr
                  key={t.id}
                  className="border-t border-[var(--admin-line)] hover:bg-[var(--admin-panel2)] transition-colors"
                >
                  <td
                    className="px-4 py-2 font-mono text-xs text-[var(--admin-gold-hi)]"
                    style={{ fontFamily: "var(--admin-mono)" }}
                  >
                    {t.certId}
                  </td>
                  <td
                    className="px-4 py-2 text-xs text-[var(--admin-ink-dim)] max-w-[160px] truncate"
                    style={{ fontFamily: "var(--admin-mono)" }}
                  >
                    {t.fromEmail}
                  </td>
                  <td
                    className="px-4 py-2 text-xs text-[var(--admin-ink-dim)] max-w-[160px] truncate"
                    style={{ fontFamily: "var(--admin-mono)" }}
                  >
                    {t.toEmail}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={t.status} flowVersion={t.flowVersion} />
                  </td>
                  <td className="px-4 py-2 text-xs text-[var(--admin-ink-faint)]">{formatDate(t.disputeDeadline)}</td>
                  <td className="px-4 py-2 text-xs text-[var(--admin-ink-faint)]">{formatDate(t.createdAt)}</td>
                  <td className="px-4 py-2">
                    {actionable ? (
                      <button
                        type="button"
                        onClick={() => setResolveTarget(t)}
                        className="text-xs font-semibold text-[var(--admin-gold-hi)] hover:text-[var(--admin-gold)] transition-colors"
                      >
                        Resolve →
                      </button>
                    ) : (
                      <span className="text-[10px] text-[var(--admin-ink-faint)]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Disputed transfers detail */}
      {other.filter((t) => t.status === "disputed").length > 0 && (
        <div className="bg-[var(--admin-panel)] border border-[color-mix(in_srgb,var(--admin-red)_40%,transparent)] rounded-lg p-4">
          <h3 className="text-sm font-bold text-[var(--admin-red)] mb-3">Disputed Transfers</h3>
          {other
            .filter((t) => t.status === "disputed")
            .map((t) => (
              <div
                key={t.id}
                className="border-t border-[color-mix(in_srgb,var(--admin-red)_25%,transparent)] py-3 first:border-0 first:pt-0"
              >
                <p className="text-xs text-[var(--admin-ink)]">
                  <strong>{t.certId}</strong> — disputed by <strong>{t.disputedBy}</strong> on{" "}
                  {formatDate(t.disputedAt)}
                </p>
                {t.disputeReason && (
                  <p className="text-xs text-[var(--admin-ink-dim)] mt-1">Reason: {t.disputeReason}</p>
                )}
              </div>
            ))}
        </div>
      )}

      {resolveTarget && <ResolveModal transfer={resolveTarget} onClose={() => setResolveTarget(null)} />}
    </div>
  );
}
