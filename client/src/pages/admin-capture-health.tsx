import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Activity, RefreshCw, ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Panel, Badge, AdminButton, type AdminBadgeVariant } from "@/components/admin";

// ── /api/admin/ai-capture-health response types ────────────────────────────
type CheckStatus = "green" | "amber" | "red";

interface CheckBase {
  status: CheckStatus;
}
interface CardMetadataCheck extends CheckBase {
  missing: string[] | null;
}
interface GradeFieldsCheck extends CheckBase {
  missing: string[] | null;
}
interface DefectsCheck extends CheckBase {
  note: string | null;
}
interface ImagesCheck extends CheckBase {
  missing: string[] | null;
}
interface GradingTimeCheck extends CheckBase {
  value_seconds: number | null;
}
interface EmbeddingCheck extends CheckBase {
  embedded_at: string | null;
  minutes_since_approved: number | null;
}
interface AiPredictionsCheck extends CheckBase {
  count: number;
}
interface AuditLogCheck extends CheckBase {
  actions_seen: string[];
}

interface CertRow {
  cert_id: string;
  grade_approved_at: string | null;
  card_name: string | null;
  grade_overall: string | null;
  checks: {
    card_metadata: CardMetadataCheck;
    grade_fields: GradeFieldsCheck;
    defects: DefectsCheck;
    images: ImagesCheck;
    grading_time: GradingTimeCheck;
    embedding: EmbeddingCheck;
    ai_predictions: AiPredictionsCheck;
    audit_log: AuditLogCheck;
  };
  any_red: boolean;
  any_amber: boolean;
}

interface ApiResponse {
  generated_at: string;
  summary: {
    total_checked: number;
    fully_green: number;
    any_red: number;
    any_amber: number;
    by_field: Record<string, { green: number; amber: number; red: number }>;
  };
  certs: CertRow[];
}

// ── Visual helpers ─────────────────────────────────────────────────────────
const FIELDS: { key: keyof CertRow["checks"]; col: string; label: string }[] = [
  { key: "card_metadata", col: "M", label: "Metadata" },
  { key: "grade_fields", col: "G", label: "Grade" },
  { key: "defects", col: "D", label: "Defects" },
  { key: "images", col: "I", label: "Images" },
  { key: "grading_time", col: "T", label: "Time" },
  { key: "embedding", col: "E", label: "Embedding" },
  { key: "ai_predictions", col: "P", label: "Predictions" },
  { key: "audit_log", col: "A", label: "Audit" },
];

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "green") return <CheckCircle2 size={14} className="text-[var(--admin-green)]" />;
  if (status === "amber") return <AlertTriangle size={14} className="text-[var(--admin-amber)]" />;
  return <XCircle size={14} className="text-[var(--admin-red)]" />;
}

function StatusBadge({ status, label }: { status: CheckStatus; label: string }) {
  const variant: AdminBadgeVariant = status === "green" ? "act" : status === "amber" ? "prog" : "red";
  return <Badge variant={variant}>{label}</Badge>;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
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
        return <span className="text-[var(--admin-red)]">missing: {check.missing.join(", ")}</span>;
      }
      return <span className="text-[var(--admin-green)]">all fields populated</span>;
    case "defects":
      if (check.note) return <span className="text-[var(--admin-green)]">{check.note}</span>;
      return check.status === "green" ? (
        <span className="text-[var(--admin-green)]">defects array populated</span>
      ) : (
        <span className="text-[var(--admin-red)]">no defects recorded — and grade is not 10</span>
      );
    case "grading_time":
      return check.value_seconds ? (
        <span className="text-[var(--admin-green)]">{check.value_seconds}s grading time captured</span>
      ) : (
        <span className="text-[var(--admin-red)]">grading_time_seconds not captured (pre-deploy or skipped)</span>
      );
    case "embedding":
      if (check.status === "green")
        return <span className="text-[var(--admin-green)]">embedded {fmtRelative(check.embedded_at)}</span>;
      if (check.status === "amber")
        return (
          <span className="text-[var(--admin-amber)]">
            pending — {check.minutes_since_approved}m since approval (cron runs hourly)
          </span>
        );
      return (
        <span className="text-[var(--admin-red)]">
          no embedding {check.minutes_since_approved != null ? `(${check.minutes_since_approved}m since approval)` : ""}
        </span>
      );
    case "ai_predictions":
      return check.count > 0 ? (
        <span className="text-[var(--admin-green)]">{check.count} ai_predictions row(s)</span>
      ) : (
        <span className="text-[var(--admin-red)]">no ai_predictions rows captured</span>
      );
    case "audit_log":
      return check.actions_seen?.length > 0 ? (
        <span className="text-[var(--admin-green)]">actions: {check.actions_seen.join(", ")}</span>
      ) : (
        <span className="text-[var(--admin-red)]">no canonical audit_log entries</span>
      );
  }
  return null;
}

// ── Page ───────────────────────────────────────────────────────────────────
// ── Incomplete-scan surfacing ──────────────────────────────────────────────
// Makes a stuck ingest visible instead of silent-until-a-customer-opens-it:
//   • failed   — background pipeline failed; the server reconciler re-drives it
//                from retained R2 raw on its 5-min sweep.
//   • rawNotConfirmed — raw scans never confirmed in R2 (>10 min); the server
//                can't fix it (no bytes) — the scanner must re-supply.
function ScanHealthPanel() {
  const { data, refetch, isFetching } = useQuery<{
    failed: Array<{ certId: string; scanStatus: string; at: string | null }>;
    rawNotConfirmed: Array<{ certId: string; at: string | null }>;
  }>({
    queryKey: ["/api/admin/scan-health"],
    queryFn: async () => {
      const res = await fetch("/api/admin/scan-health", { credentials: "include" });
      if (!res.ok) throw new Error(`scan-health ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const failed = data?.failed ?? [];
  const noRaw = data?.rawNotConfirmed ?? [];
  if (!failed.length && !noRaw.length) return null;

  return (
    <Panel bodyClassName="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--admin-ink)] flex items-center gap-1.5">
          <AlertTriangle size={14} className="text-[var(--admin-amber)]" />
          Incomplete scans
        </p>
        <AdminButton type="button" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
          Refresh
        </AdminButton>
      </div>
      {failed.length > 0 && (
        <div className="text-xs text-[var(--admin-ink-dim)]">
          <strong className="text-[var(--admin-ink)]">{failed.length}</strong> pipeline-failed (auto re-driving):{" "}
          {failed.map((f) => f.certId).join(", ")}
        </div>
      )}
      {noRaw.length > 0 && (
        <div className="text-xs text-[var(--admin-ink-dim)]">
          <strong className="text-[var(--admin-amber)]">{noRaw.length}</strong> raw-not-confirmed &gt;10 min (awaiting
          scanner re-supply): {noRaw.map((f) => f.certId).join(", ")}
        </div>
      )}
    </Panel>
  );
}

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
  const certs = data?.certs || [];
  const totalForBars = summary?.total_checked || 1;

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Activity size={22} className="text-[var(--admin-gold-hi)]" />
          <div>
            <h1 className="text-xl font-bold text-[var(--admin-ink)]">AI Capture Health</h1>
            <p className="text-[var(--admin-ink-dim)] text-sm">
              Per-cert check that every approved cert is recording the 8 fields the future RAG/training corpus needs.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sinceDays ?? ""}
            onChange={(e) => setSinceDays(e.target.value === "" ? null : Number(e.target.value))}
            className="admin-input text-xs !w-auto !py-1.5"
          >
            <option value="1">Last 24h</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="">All approved (max 100)</option>
          </select>
          <AdminButton type="button" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </AdminButton>
        </div>
      </div>

      <ScanHealthPanel />

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-[var(--admin-gold)] border-t-transparent rounded-full" />
        </div>
      )}

      {!isLoading && summary && (
        <>
          {/* ── Summary panel ─────────────────────────────────────────────── */}
          <Panel bodyClassName="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[var(--admin-ink)] text-sm">
                Checking <strong>{summary.total_checked}</strong> approved cert{summary.total_checked === 1 ? "" : "s"}
                {sinceDays != null ? ` (last ${sinceDays} day${sinceDays === 1 ? "" : "s"})` : " (all time, max 100)"}
              </p>
              <div className="flex items-center gap-3 text-sm text-[var(--admin-ink-dim)]">
                <span className="flex items-center gap-1">
                  <CheckCircle2 size={14} className="text-[var(--admin-green)]" />
                  <strong>{summary.fully_green}</strong> fully green
                </span>
                <span className="flex items-center gap-1">
                  <AlertTriangle size={14} className="text-[var(--admin-amber)]" />
                  <strong>{summary.any_amber}</strong> amber
                </span>
                <span className="flex items-center gap-1">
                  <XCircle size={14} className="text-[var(--admin-red)]" />
                  <strong>{summary.any_red}</strong> red
                </span>
              </div>
            </div>

            <div className="space-y-2">
              {FIELDS.map(({ key, label }) => {
                const f = summary.by_field[key] || { green: 0, amber: 0, red: 0 };
                const totalThis = f.green + f.amber + f.red;
                const greenPct = totalThis > 0 ? Math.round((f.green / totalThis) * 100) : 0;
                return (
                  <div key={key} className="grid grid-cols-[140px_1fr_140px] items-center gap-3">
                    <p className="text-sm text-[var(--admin-ink)] font-medium">{label}</p>
                    <div className="h-2 bg-[rgba(243,238,227,0.06)] rounded-full overflow-hidden flex">
                      {f.green > 0 && (
                        <div
                          className="bg-[var(--admin-green)] h-full"
                          style={{ width: `${(f.green / Math.max(1, totalForBars)) * 100}%` }}
                        />
                      )}
                      {f.amber > 0 && (
                        <div
                          className="bg-[var(--admin-amber)] h-full"
                          style={{ width: `${(f.amber / Math.max(1, totalForBars)) * 100}%` }}
                        />
                      )}
                      {f.red > 0 && (
                        <div
                          className="bg-[var(--admin-red)]   h-full"
                          style={{ width: `${(f.red / Math.max(1, totalForBars)) * 100}%` }}
                        />
                      )}
                    </div>
                    <p
                      className="text-xs text-[var(--admin-ink-dim)] text-right tabular-nums"
                      style={{ fontFamily: "var(--admin-mono)" }}
                    >
                      {f.green}/{totalThis} <span className="text-[var(--admin-ink-faint)]">({greenPct}%)</span>
                    </p>
                  </div>
                );
              })}
            </div>
          </Panel>

          {/* ── Filter ────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-[var(--admin-ink-dim)] cursor-pointer">
              <input
                type="checkbox"
                checked={onlyFailing}
                onChange={(e) => setOnlyFailing(e.target.checked)}
                className="accent-[var(--admin-gold)]"
              />
              Only show failing certs (any field RED)
            </label>
            <span className="text-[var(--admin-ink-faint)] text-xs">
              · auto-refresh 60s · last fetched {fmtRelative(data?.generated_at || null)}
            </span>
          </div>

          {/* ── Per-cert table ────────────────────────────────────────────── */}
          {certs.length === 0 ? (
            <div className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-xl p-12 text-center text-[var(--admin-ink-faint)] text-sm">
              {onlyFailing ? "No failing certs in this window — all green." : "No approved certs in this window."}
            </div>
          ) : (
            <div className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--admin-panel2)] border-b border-[var(--admin-line)]">
                  <tr
                    className="text-[10px] uppercase tracking-widest text-[var(--admin-ink-faint)]"
                    style={{ fontFamily: "var(--admin-mono)" }}
                  >
                    <th className="text-left  px-3 py-2 w-8"></th>
                    <th className="text-left  px-3 py-2 w-20">Cert</th>
                    <th className="text-left  px-3 py-2">Card</th>
                    <th className="text-left  px-3 py-2 w-24">Approved</th>
                    {FIELDS.map((f) => (
                      <th key={f.key} className="text-center px-2 py-2 w-8" title={f.label}>
                        {f.col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {certs.map((cert) => {
                    const isOpen = expanded === cert.cert_id;
                    const rowCls = cert.any_red
                      ? "border-b border-[var(--admin-line)] hover:bg-[rgba(205,128,115,0.06)] cursor-pointer"
                      : cert.any_amber
                        ? "border-b border-[var(--admin-line)] hover:bg-[rgba(227,183,95,0.06)] cursor-pointer"
                        : "border-b border-[var(--admin-line)] hover:bg-[rgba(212,175,55,0.04)] cursor-pointer";
                    return (
                      <>
                        <tr
                          key={cert.cert_id}
                          className={rowCls}
                          onClick={() => setExpanded(isOpen ? null : cert.cert_id)}
                        >
                          <td className="px-3 py-2 text-[var(--admin-ink-faint)]">
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </td>
                          <td
                            className="px-3 py-2 text-[var(--admin-gold-hi)] text-xs"
                            style={{ fontFamily: "var(--admin-mono)" }}
                          >
                            {cert.cert_id}
                          </td>
                          <td className="px-3 py-2 text-[var(--admin-ink)] truncate max-w-[200px]">
                            {cert.card_name || <span className="text-[var(--admin-red)]">— missing —</span>}
                            {cert.grade_overall && (
                              <span className="text-[var(--admin-ink-faint)] ml-2 text-xs">
                                grade {cert.grade_overall}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-[var(--admin-ink-faint)] text-xs whitespace-nowrap">
                            {fmtRelative(cert.grade_approved_at)}
                          </td>
                          {FIELDS.map((f) => (
                            <td key={f.key} className="px-2 py-2 text-center">
                              <StatusIcon status={cert.checks[f.key].status} />
                            </td>
                          ))}
                        </tr>
                        {isOpen && (
                          <tr
                            key={cert.cert_id + "-detail"}
                            className="bg-[var(--admin-panel2)] border-b border-[var(--admin-line)]"
                          >
                            <td colSpan={4 + FIELDS.length} className="px-6 py-4">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {FIELDS.map((f) => {
                                  const c = cert.checks[f.key];
                                  return (
                                    <div key={f.key} className="flex items-start gap-2">
                                      <StatusIcon status={c.status} />
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-0.5">
                                          <span className="text-[var(--admin-ink)] font-bold text-xs">{f.label}</span>
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

      <p className="text-[var(--admin-ink-faint)] text-xs">
        Read-only dashboard — click any row to see which specific fields are missing. Auto-refreshes every 60 seconds.
      </p>
    </div>
  );
}
