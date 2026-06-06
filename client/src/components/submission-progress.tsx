import { Check } from "lucide-react";

/**
 * Shared 5-node submission progress stepper. Used by:
 *   - Admin submission detail (variant="admin", admin labelMap)
 *   - Customer /track page (variant="customer", customer labelMap)
 *
 * Node → data source mapping (see server/storage.ts firstStatusHistoryTime
 * for the in_grading / ready_to_return derivation):
 *   1. Received         = receivedAt
 *   2. In grading       = inGradingAt        (derived from status_history)
 *   3. Ready/preparing  = readyToReturnAt    (derived from status_history)
 *   4. On its way       = shippedAt
 *   5. Delivered        = deliveredAt        (NEW; manual admin bridge today,
 *                                              Royal Mail API later — see
 *                                              migrations/add-delivered-at.sql)
 *
 * Current-stage rule:
 *   - For nodes 1–4: highlight by STATUS (current === STAGE_FOR_STATUS).
 *   - For node 5 (Delivered): light up ONLY when deliveredAt is non-null.
 *     Status "completed" does NOT light Delivered — these are separate
 *     concepts, "completed" is operational, "delivered" is carrier-confirmed.
 *
 * Pre-received states (new/paid/draft): everything greyed, bar empty.
 */

export type StepKey = "received" | "in_grading" | "ready_to_return" | "shipped" | "delivered";

export type SubmissionProgressLabels = Record<StepKey, string>;

export const ADMIN_LABELS: SubmissionProgressLabels = {
  received: "Received",
  in_grading: "In Grading",
  ready_to_return: "Ready to Return",
  shipped: "Shipped",
  delivered: "Delivered",
};

export const CUSTOMER_LABELS: SubmissionProgressLabels = {
  received: "Received",
  in_grading: "Being graded",
  ready_to_return: "Graded — preparing to ship",
  shipped: "On its way",
  delivered: "Delivered",
};

export interface SubmissionProgressProps {
  status: string | null | undefined;
  receivedAt: string | null | undefined;
  inGradingAt: string | null | undefined;
  readyToReturnAt: string | null | undefined;
  shippedAt: string | null | undefined;
  deliveredAt: string | null | undefined;
  labels: SubmissionProgressLabels;
  /** Picks the colour tokens. "admin" uses the admin gold palette; "customer"
   *  matches the customer-facing track page. */
  variant: "admin" | "customer";
}

interface NodeDef {
  key: StepKey;
  label: string;
  timestamp: string | null | undefined;
  /** Set to true when this node should be considered complete (filled tick). */
  done: boolean;
  /** Set to true when this is the active stage (highlighted dot). */
  active: boolean;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

function buildNodes(props: SubmissionProgressProps): NodeDef[] {
  const { status, labels, receivedAt, inGradingAt, readyToReturnAt, shippedAt, deliveredAt } = props;
  const s = (status ?? "").toLowerCase();

  // statusOrder maps each app status to a "reached up to here" index in the
  // 5-node line. Nodes at index < currentIdx are done; node at currentIdx is
  // active. Delivered (idx 4) is special — only ever active when delivered_at
  // is set, never by status alone.
  const statusIndex: Record<string, number> = {
    received: 0,
    in_grading: 1,
    ready_to_return: 2,
    shipped: 3,
    completed: 3, // "completed" stops at the Shipped node visually; Delivered is its own thing
  };
  const reached = s in statusIndex ? statusIndex[s] : -1; // pre-received → -1
  const isDelivered = !!deliveredAt;

  return [
    {
      key: "received",
      label: labels.received,
      timestamp: receivedAt ?? null,
      done: reached > 0 || isDelivered,
      active: reached === 0 && !isDelivered,
    },
    {
      key: "in_grading",
      label: labels.in_grading,
      timestamp: inGradingAt ?? null,
      done: reached > 1 || isDelivered,
      active: reached === 1 && !isDelivered,
    },
    {
      key: "ready_to_return",
      label: labels.ready_to_return,
      timestamp: readyToReturnAt ?? null,
      done: reached > 2 || isDelivered,
      active: reached === 2 && !isDelivered,
    },
    {
      key: "shipped",
      label: labels.shipped,
      timestamp: shippedAt ?? null,
      // "Shipped" is done once delivered_at lights up; active when status is
      // shipped/completed AND not yet delivered.
      done: isDelivered,
      active: reached === 3 && !isDelivered,
    },
    {
      key: "delivered",
      label: labels.delivered,
      timestamp: deliveredAt ?? null,
      done: isDelivered,
      active: isDelivered,
    },
  ];
}

export default function SubmissionProgress(props: SubmissionProgressProps) {
  const nodes = buildNodes(props);
  const isAdmin = props.variant === "admin";

  // Tokens. Admin uses the admin gold (--admin-gold / --admin-line) tokens
  // already used by the admin shell. Customer uses the same gold/cream
  // palette the existing /track page uses (#D4AF37 + neutrals) so the
  // stepper feels native to that page.
  const tokens = isAdmin
    ? {
        dotDone: "bg-[var(--admin-gold)] border-[var(--admin-gold)] text-[var(--admin-bg)]",
        dotActive:
          "bg-[color-mix(in_srgb,var(--admin-gold)_22%,transparent)] border-[var(--admin-gold)] text-[var(--admin-gold-hi)] ring-2 ring-[color-mix(in_srgb,var(--admin-gold)_30%,transparent)] ring-offset-1 ring-offset-[var(--admin-bg)]",
        dotIdle: "bg-[var(--admin-panel2)] border-[var(--admin-line-soft)] text-[var(--admin-ink-faint)]",
        labelDone: "text-[var(--admin-gold-hi)]",
        labelActive: "text-[var(--admin-ink)]",
        labelIdle: "text-[var(--admin-ink-faint)]",
        timestamp: "text-[var(--admin-ink-faint)]",
        connectorDone: "bg-[var(--admin-gold)]",
        connectorIdle: "bg-[var(--admin-line-soft)]",
      }
    : {
        dotDone: "bg-[#D4AF37] border-[#D4AF37] text-white",
        dotActive: "bg-[#D4AF37]/20 border-[#D4AF37] text-[#B8960C] ring-2 ring-[#D4AF37]/30 ring-offset-1",
        dotIdle: "bg-[#F1EFE8] border-[#E0DBD0] text-[#AAAAAA]",
        labelDone: "text-[#B8960C]",
        labelActive: "text-[#1A1A1A]",
        labelIdle: "text-[#AAAAAA]",
        timestamp: "text-[#888888]",
        connectorDone: "bg-[#D4AF37]",
        connectorIdle: "bg-[#E0DBD0]",
      };

  return (
    <div className="w-full" data-testid="submission-progress">
      {/* Horizontal layout on sm+ */}
      <ol className="hidden sm:flex items-start gap-0 w-full">
        {nodes.map((n, i) => {
          const isLast = i === nodes.length - 1;
          const dotCls = n.done ? tokens.dotDone : n.active ? tokens.dotActive : tokens.dotIdle;
          const labelCls = n.done ? tokens.labelDone : n.active ? tokens.labelActive : tokens.labelIdle;
          const connectorCls = nodes[i + 1]?.done || nodes[i + 1]?.active ? tokens.connectorDone : tokens.connectorIdle;
          return (
            <li key={n.key} className="flex-1 flex flex-col items-center text-center relative">
              <div className="flex items-center w-full">
                <div
                  className={`flex-1 h-px ${i === 0 ? "invisible" : n.done || n.active ? tokens.connectorDone : tokens.connectorIdle}`}
                />
                <div
                  className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold transition-colors shrink-0 ${dotCls}`}
                  data-testid={`progress-node-${n.key}`}
                  data-state={n.done ? "done" : n.active ? "active" : "idle"}
                >
                  {n.done ? <Check size={12} strokeWidth={3} /> : i + 1}
                </div>
                <div className={`flex-1 h-px ${isLast ? "invisible" : connectorCls}`} />
              </div>
              <div className={`mt-2 text-[11px] font-medium leading-tight ${labelCls}`}>{n.label}</div>
              {n.timestamp && (n.done || n.active) ? (
                <div className={`text-[10px] mt-0.5 ${tokens.timestamp}`} data-testid={`progress-ts-${n.key}`}>
                  {fmtTime(n.timestamp)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Vertical layout on narrow screens (mobile customer view) */}
      <ol className="sm:hidden space-y-3 w-full">
        {nodes.map((n, i) => {
          const dotCls = n.done ? tokens.dotDone : n.active ? tokens.dotActive : tokens.dotIdle;
          const labelCls = n.done ? tokens.labelDone : n.active ? tokens.labelActive : tokens.labelIdle;
          const connectorCls = n.done || n.active ? tokens.connectorDone : tokens.connectorIdle;
          const isLast = i === nodes.length - 1;
          return (
            <li key={n.key} className="flex items-start gap-3" data-testid={`progress-row-${n.key}`}>
              <div className="flex flex-col items-center">
                <div
                  className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-[10px] font-bold ${dotCls}`}
                  data-state={n.done ? "done" : n.active ? "active" : "idle"}
                >
                  {n.done ? <Check size={12} strokeWidth={3} /> : i + 1}
                </div>
                {!isLast ? <div className={`w-0.5 grow min-h-[18px] mt-1 ${connectorCls}`} /> : null}
              </div>
              <div className="pt-0.5">
                <div className={`text-sm font-medium ${labelCls}`}>{n.label}</div>
                {n.timestamp && (n.done || n.active) ? (
                  <div className={`text-xs mt-0.5 ${tokens.timestamp}`}>{fmtTime(n.timestamp)}</div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
