/**
 * Admin → Sets / Variants → Legacy Review.
 *
 * Read-only audit of the historical flat `certificates.variant` values, each with
 * a proposed structured mapping + confidence, and Approve / Edit / Reject / Ignore
 * controls. Approving records the mapping RULE only — it never rewrites a
 * certificate. Any future backfill is a separate, explicitly-confirmed action.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, AdminButton, Badge } from "@/components/admin";

type Classification = "rarity" | "finish" | "promo" | "subset" | "ambiguous";
type Status = "pending" | "approved" | "rejected" | "ignored";

interface ReviewItem {
  legacyValue: string;
  recordCount: number;
  classification: Classification;
  proposedValue: string | null;
  confidence: "high" | "medium" | "low";
  reviewRequired: boolean;
  reason: string;
  exampleCertIds: string[];
  status: Status;
  reviewedBy: string | null;
  reviewedAt: string | null;
}
interface AuditResponse {
  items: ReviewItem[];
  summary: { distinctValues: number; totalRecords: number; high: number; medium: number; low: number; reviewRequired: number };
}

const CONF_VARIANT: Record<string, "act" | "wait" | "red" | "neu"> = {
  high: "act",
  medium: "wait",
  low: "red",
};
const STATUS_VARIANT: Record<Status, "act" | "wait" | "red" | "neu"> = {
  approved: "act",
  pending: "wait",
  rejected: "red",
  ignored: "neu",
};

export default function AdminLegacyReviewPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch, isFetching } = useQuery<AuditResponse>({
    queryKey: ["/api/admin/rarity-mapping-reviews"],
  });
  const [editing, setEditing] = useState<Record<string, { classification: Classification; proposedValue: string }>>({});

  const decide = useMutation({
    mutationFn: async (body: {
      legacyValue: string;
      decision: Status;
      proposedClassification?: string | null;
      proposedValue?: string | null;
    }) => {
      const res = await fetch("/api/admin/rarity-mapping-reviews/decision", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to record decision");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/rarity-mapping-reviews"] }),
  });

  const items = data?.items ?? [];
  const summary = data?.summary;
  const pendingCount = useMemo(() => items.filter((i) => i.status === "pending").length, [items]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 text-slate-100">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Legacy Variant Review</h1>
          <p className="text-xs text-slate-400">
            Map historical variant values onto the structured catalogue. Approving records the mapping{" "}
            <b>rule only</b> — no certificate is changed and no data is backfilled.
          </p>
        </div>
        <AdminButton type="button" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Refreshing…" : "Refresh"}
        </AdminButton>
      </div>

      {summary && (
        <Panel>
          <div className="flex flex-wrap gap-4 text-xs text-slate-300">
            <span>{summary.distinctValues} distinct value(s)</span>
            <span>{summary.totalRecords} certificate(s)</span>
            <span className="text-emerald-300">{summary.high} high-confidence</span>
            <span className="text-amber-300">{summary.medium} medium</span>
            <span className="text-rose-300">{summary.low} low</span>
            <span>{pendingCount} pending your review</span>
          </div>
        </Panel>
      )}

      {isLoading && <Panel>Loading…</Panel>}
      {isError && <Panel>Could not load the audit. Try Refresh.</Panel>}
      {!isLoading && items.length === 0 && <Panel>No legacy variant values found.</Panel>}

      <div className="space-y-2">
        {items.map((item) => {
          const edit = editing[item.legacyValue];
          return (
            <Panel key={item.legacyValue}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-slate-800 px-1.5 py-0.5 text-xs font-bold">{item.legacyValue}</code>
                    <span className="text-xs text-slate-400">{item.recordCount} cert(s)</span>
                    <Badge variant={STATUS_VARIANT[item.status]}>{item.status}</Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                    <span>
                      → <b>{item.classification}</b>
                      {item.proposedValue ? `: ${item.proposedValue}` : ""}
                    </span>
                    <Badge variant={CONF_VARIANT[item.confidence] ?? "neu"}>{item.confidence}</Badge>
                    {item.reviewRequired && <span className="text-amber-300">needs review</span>}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">{item.reason}</div>
                  {item.exampleCertIds.length > 0 && (
                    <div className="mt-1 text-[11px] text-slate-500">e.g. {item.exampleCertIds.join(", ")}</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <AdminButton
                    type="button"
                    size="sm"
                    onClick={() =>
                      decide.mutate({
                        legacyValue: item.legacyValue,
                        decision: "approved",
                        proposedClassification: edit?.classification ?? item.classification,
                        proposedValue: edit?.proposedValue ?? item.proposedValue,
                      })
                    }
                    disabled={decide.isPending || (item.classification === "ambiguous" && !edit)}
                    title={
                      item.classification === "ambiguous" && !edit
                        ? "Ambiguous — use Edit Mapping to set the target first"
                        : "Approve this mapping rule (no certificate is changed)"
                    }
                  >
                    Approve
                  </AdminButton>
                  <AdminButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing((e) => ({
                        ...e,
                        [item.legacyValue]: {
                          classification: item.classification,
                          proposedValue: item.proposedValue ?? "",
                        },
                      }))
                    }
                  >
                    Edit Mapping
                  </AdminButton>
                  <AdminButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => decide.mutate({ legacyValue: item.legacyValue, decision: "rejected" })}
                    disabled={decide.isPending}
                  >
                    Reject
                  </AdminButton>
                  <AdminButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => decide.mutate({ legacyValue: item.legacyValue, decision: "ignored" })}
                    disabled={decide.isPending}
                  >
                    Ignore
                  </AdminButton>
                </div>
              </div>

              {edit && (
                <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-2">
                  <label className="flex flex-col gap-1 text-[11px] text-slate-400">
                    Classification
                    <select
                      value={edit.classification}
                      onChange={(ev) =>
                        setEditing((e) => ({
                          ...e,
                          [item.legacyValue]: { ...edit, classification: ev.target.value as Classification },
                        }))
                      }
                      className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                    >
                      {(["rarity", "finish", "promo", "subset", "ambiguous"] as Classification[]).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-1 flex-col gap-1 text-[11px] text-slate-400">
                    Canonical value
                    <input
                      value={edit.proposedValue}
                      onChange={(ev) =>
                        setEditing((e) => ({
                          ...e,
                          [item.legacyValue]: { ...edit, proposedValue: ev.target.value },
                        }))
                      }
                      placeholder="e.g. reverse_holo"
                      className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                    />
                  </label>
                  <AdminButton
                    type="button"
                    size="sm"
                    onClick={() =>
                      decide.mutate({
                        legacyValue: item.legacyValue,
                        decision: "approved",
                        proposedClassification: edit.classification,
                        proposedValue: edit.proposedValue || null,
                      })
                    }
                    disabled={decide.isPending}
                  >
                    Save &amp; Approve rule
                  </AdminButton>
                </div>
              )}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
