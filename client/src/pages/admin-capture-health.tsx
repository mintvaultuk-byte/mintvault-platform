import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Activity, RefreshCw, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

// ── /api/admin/ai-capture-health response types ────────────────────────────
type CheckStatus = "green" | "amber" | "red";

interface CheckBase { status: CheckStatus }
interface CardMetadataCheck  extends CheckBase { missing: string[] | null }
interface GradeFieldsCheck   extends CheckBase { missing: string[] | null }
interface DefectsCheck       extends CheckBase { note: string | null }
interface ImagesCheck        extends CheckBase { missing: string[] | null }
interface GradingTimeCheck   extends CheckBase { value_seconds: number | null }
interface EmbeddingCheck     extends CheckBase { embedded_at: string | null; minutes_since_approved: number | null }
interface AiPredictionsCheck extends CheckBase { count: number }
interface AuditLogCheck      extends CheckBase { actions_seen: string[] }

interface CertRow {
  cert_id: string;
  grade_approved_at: string | null;
  card_name: string | null;
  grade_overall: string | null;
  checks: {
    card_metadata:  CardMetadataCheck;
    grade_fields:   GradeFieldsCheck;
    defects:        DefectsCheck;
    images:         ImagesCheck;
    grading_time:   GradingTimeCheck;
    embedding:      EmbeddingCheck;
    ai_predictions: AiPredictionsCheck;
    audit_log:      AuditLogCheck;
  };
  any_red:   boolean;
  any_amber: boolean;
}

interface ApiResponse {
  generated_at: string;
  summary: {
    total_checked: number;
    fully_green:   number;
    any_red:       number;
    any_amber:     number;
    by_field: Record<string, { green: number; amber: number; red: number }>;
  };
  certs: CertRow[];
}

// ── Visual helpers ─────────────────────────────────────────────────────────
const FIELDS: { key: keyof CertRow["checks"]; col: string; label: string }[] = [
  { key: "card_metadata",  col: "M", label: "Metadata"     },
  { key: "grade_fields",   col: "G", label: "Grade"        },
  { key: "defects",        col: "D", label: "Defects"      },
  { key: "images",         col: "I", label: "Images"       },
  { key: "grading_time",   col: "T", label: "Time"         },
  { key: "embedding",      col: "E", label: "Embedding"    },
  { key: "ai_predictions", col: "P", label: "Predictions"  },
  { key: "audit_log",      col: "A", label: "Audit"        },
];

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "green") return <CheckCircle2 size={14} className="text-green-600" />;
  if (status === "amber") return <AlertTriangle size={14} className="text-amber-600" />;
  return <XCircle size={14} className="text-red-600" />;
}

function StatusBadge({ status, label }: { status: CheckStatus; label: string }) {
  const cls = status === "green"
    ? "bg-green-100 text-green-800 border-green-200"
    : status === "amber"
      ? "bg-amber-100 text-amber-800 border-amber-200"
      : "bg-red-100 text-red-800 border-red-200";
  return <span className={`text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full border ${cls}`}>{label}</span>;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)        return "just now";
  if (ms < 3_600_000)     return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function FieldDetail({ check, fieldKey }: { check: any; fieldKey: keyof CertRow["checks"] }) {
  // Per-field dropdown content. Mirrors the API's per-check shape so the
  // operator sees exactly which subfields are missing or pending.
  switch (fieldKey) {
    case "card_metadata":
    case "grade_fields":
    case "images":
      if (check.missing?.length) {
        return <span className="text-red-700">missing: {check.missing.join(", ")}</span>;
      }
      return <span className="text-green-700">all fields populated</span>;
    case "defects":
      if (check.note) return <span className="text-green-700">{check.note}</span>;
      return check.status === "green"
        ? <span className="text-green-700">defects array populated</span>
        : <span className="text-red-700">no defects recorded — and grade is not 10</span>;
    case "grading_time":
      return check.value_seconds
        ? <span className="text-green-700">{check.value_seconds}s grading time captured</span>
        : <span className="text-red-700">grading_time_seconds not captured (pre-deploy or skipped)</span>;
    case "embedding":
      if (check.status === "green") return <span className="text-green-700">embedded {fmtRelative(check.embedded_at)}</span>;
      if (check.status === "amber") return <span className="text-amber-700">pending — {check.minutes_since_approved}m since approval (cron runs hourly)</span>;
      return <span className="text-red-700">no embedding {check.minutes_since_approved != null ? `(${check.minutes_since_approved}m since approval)` : ""}</span>;
    case "ai_predictions":
      return check.count > 0
        ? <span className="text-green-700">{check.count} ai_predictions row(s)</span>
        : <span className="text-red-700">no ai_predictions rows captured</span>;
    case "audit_log":
      return check.actions_seen?.length > 0
        ? <span className="text-green-700">actions: {check.actions_seen.join(", ")}</span>
        : <span className="text-red-700">no canonical audit_log entries</span>;
  }
  return null;
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function AdminCaptureHealthPage() {
  const [sinceDays, setSinceDays] = useState<number | null>(7);
  const [onlyFailing, setOnlyFailing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const limit = sinceDays === null ? 100 : 100;
  const queryKey = ["/api/admin/ai-capture-health", { sinceDays, onlyFailing, limit }];
  const { data, isLoading, refetch, isFetching } = useQuery<ApiResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("onlyFailing", String(onlyFailing));
      if (sinceDays != null) params.set("sinceDays", String(sinceDays));
      const res = await fetch(`/api/admin/ai-capture-health?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const summary = data?.summary;
  const certs   = data?.certs || [];
  const totalForBars = summary?.total_checked || 1;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Activity size={22} className="text-[#FFCB05]" />
          <div>
            <h1 className="text-xl font-bold text-[#1A1A1A]">AI Capture Health</h1>
            <p className="text-[#888888] text-sm">
              Per-cert check that every approved cert is recording the 8 fields the future RAG/training corpus needs.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sinceDays ?? ""}
            onChange={e => setSinceDays(e.target.value === "" ? null : Number(e.target.value))}
            className="text-xs px-3 py-1.5 rounded border border-[#D4D0C8] text-[#333] bg-white"
          >
            <option value="1">Last 24h</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="">All approved (max 100)</option>
          </select>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-[#D4D0C8] text-[#333] hover:border-[#FFCB05] hover:text-[#FFCB05] disabled:opacity-60"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-[#FFCB05] border-t-transparent rounded-full" />
        </div>
      )}

      {!isLoading && summary && (
        <>
          {/* ── Summary panel ─────────────────────────────────────────────── */}
          <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[#1A1A1A] text-sm">
                Checking <strong>{summary.total_checked}</strong> approved cert{summary.total_checked === 1 ? "" : "s"}
                {sinceDays != null ? ` (last ${sinceDays} day${sinceDays === 1 ? "" : "s"})` : " (all time, max 100)"}
              </p>
              <div className="flex items-center gap-3 text-sm">
                <span className="flex items-center gap-1"><CheckCircle2 size={14} className="text-green-600" /><strong>{summary.fully_green}</strong> fully green</span>
                <span className="flex items-center gap-1"><AlertTriangle size={14} className="text-amber-600" /><strong>{summary.any_amber}</strong> amber</span>
                <span className="flex items-center gap-1"><XCircle size={14} className="text-red-600" /><strong>{summary.any_red}</strong> red</span>
              </div>
            </div>

            <div className="space-y-2">
              {FIELDS.map(({ key, label }) => {
                const f = summary.by_field[key] || { green: 0, amber: 0, red: 0 };
                const totalThis = f.green + f.amber + f.red;
                const greenPct = totalThis > 0 ? Math.round((f.green / totalThis) * 100) : 0;
                return (
                  <div key={key} className="grid grid-cols-[140px_1fr_140px] items-center gap-3">
                    <p className="text-sm text-[#1A1A1A] font-medium">{label}</p>
                    <div className="h-2 bg-[#E8E4DC] rounded-full overflow-hidden flex">
                      {f.green > 0 && <div className="bg-green-500 h-full" style={{ width: `${(f.green / Math.max(1, totalForBars)) * 100}%` }} />}
                      {f.amber > 0 && <div className="bg-amber-500 h-full" style={{ width: `${(f.amber / Math.max(1, totalForBars)) * 100}%` }} />}
                      {f.red   > 0 && <div className="bg-red-500   h-full" style={{ width: `${(f.red   / Math.max(1, totalForBars)) * 100}%` }} />}
                    </div>
                    <p className="text-xs text-[#555] text-right tabular-nums">
                      {f.green}/{totalThis} <span className="text-[#888]">({greenPct}%)</span>
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Filter ────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-[#333] cursor-pointer">
              <input
                type="checkbox"
                checked={onlyFailing}
                onChange={e => setOnlyFailing(e.target.checked)}
                className="accent-[#FFCB05]"
              />
              Only show failing certs (any field RED)
            </label>
            <span className="text-[#888] text-xs">
              · auto-refresh 60s · last fetched {fmtRelative(data?.generated_at || null)}
            </span>
          </div>

          {/* ── Per-cert table ────────────────────────────────────────────── */}
          {certs.length === 0 ? (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-12 text-center text-[#888] text-sm">
              {onlyFailing ? "No failing certs in this window — all green." : "No approved certs in this window."}
            </div>
          ) : (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[#F0EDE5] border-b border-[#E8E4DC]">
                  <tr className="text-[10px] uppercase tracking-widest text-[#888]">
                    <th className="text-left  px-3 py-2 w-8"></th>
                    <th className="text-left  px-3 py-2 w-20">Cert</th>
                    <th className="text-left  px-3 py-2">Card</th>
                    <th className="text-left  px-3 py-2 w-24">Approved</th>
                    {FIELDS.map(f => (
                      <th key={f.key} className="text-center px-2 py-2 w-8" title={f.label}>{f.col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {certs.map(cert => {
                    const isOpen = expanded === cert.cert_id;
                    const rowCls = cert.any_red
                      ? "border-b border-[#E8E4DC] hover:bg-red-50/30 cursor-pointer"
                      : cert.any_amber
                        ? "border-b border-[#E8E4DC] hover:bg-amber-50/30 cursor-pointer"
                        : "border-b border-[#E8E4DC] hover:bg-white cursor-pointer";
                    return (
                      <>
                        <tr key={cert.cert_id} className={rowCls} onClick={() => setExpanded(isOpen ? null : cert.cert_id)}>
                          <td className="px-3 py-2 text-[#888]">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                          <td className="px-3 py-2 font-mono text-[#1A1A1A] text-xs">{cert.cert_id}</td>
                          <td className="px-3 py-2 text-[#333] truncate max-w-[200px]">
                            {cert.card_name || <span className="text-red-600">— missing —</span>}
                            {cert.grade_overall && <span className="text-[#888] ml-2 text-xs">grade {cert.grade_overall}</span>}
                          </td>
                          <td className="px-3 py-2 text-[#888] text-xs whitespace-nowrap">{fmtRelative(cert.grade_approved_at)}</td>
                          {FIELDS.map(f => (
                            <td key={f.key} className="px-2 py-2 text-center">
                              <StatusIcon status={cert.checks[f.key].status} />
                            </td>
                          ))}
                        </tr>
                        {isOpen && (
                          <tr key={cert.cert_id + "-detail"} className="bg-[#FBFAF6] border-b border-[#E8E4DC]">
                            <td colSpan={4 + FIELDS.length} className="px-6 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {FIELDS.map(f => {
                                  const c = cert.checks[f.key];
                                  return (
                                    <div key={f.key} className="flex items-start gap-2">
                                      <StatusIcon status={c.status} />
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-0.5">
                                          <span className="text-[#1A1A1A] font-bold text-xs">{f.label}</span>
                                          <StatusBadge status={c.status} label={c.status} />
                                        </div>
                                        <div className="text-xs">
                                          <FieldDetail check={c} fieldKey={f.key} />
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <p className="text-[#888] text-xs">
        Read-only dashboard — click any row to see which specific fields are missing. Auto-refreshes every 60 seconds.
      </p>
    </div>
  );
}
