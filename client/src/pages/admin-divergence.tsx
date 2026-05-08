import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { TrendingUp, RefreshCw, AlertTriangle, ExternalLink } from "lucide-react";

// ── /api/admin/ai-divergence response shape ────────────────────────────────
type Zone = "overall" | "centering" | "corners" | "edges" | "surface";
const ZONES: Zone[] = ["overall", "centering", "corners", "edges", "surface"];
const ZONE_LABEL: Record<Zone, string> = {
  overall:   "Overall",
  centering: "Centering",
  corners:   "Corners",
  edges:     "Edges",
  surface:   "Surface",
};
const ZONE_SHORT: Record<Zone, string> = {
  overall:   "Overall",
  centering: "C",
  corners:   "Cn",
  edges:     "E",
  surface:   "S",
};

interface ZoneStats {
  n: number;
  mean_divergence:     number | null;
  median_divergence:   number | null;
  stddev:              number | null;
  ai_too_generous_pct: number | null;
  ai_too_harsh_pct:    number | null;
  exact_match_pct:     number | null;
}

interface CertRow {
  cert_id:        string;
  card_name:      string | null;
  approved_at:    string | null;
  model:          string;
  call_type:      string;
  prediction_at:  string | null;
  grades:         Record<Zone, { ai: number | null; human: number | null; divergence: number | null }>;
  max_zone_divergence: number;
  any_field_missing:   boolean;
}

interface Resp {
  generated_at: string;
  sample_size:  number;
  summary: {
    by_zone:       Record<Zone, ZoneStats>;
    by_grade_band: Record<string, { n: number; mean_overall_divergence: number | null }>;
    by_model:      Record<string, { n: number; mean_overall_divergence: number | null }>;
  };
  certs: CertRow[];
}

// ── Visual helpers ─────────────────────────────────────────────────────────
function fmtSigned(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "0";
  return (n > 0 ? "+" : "") + n.toFixed(1).replace(/\.0$/, "");
}

function divCellClass(d: number | null): string {
  // Green near zero, amber at ±0.5, red at ±1.0+. Sign drives hue tone too:
  // generous (positive) leans amber, harsh (negative) leans blue, but at
  // |d|≥1 both go red — at that magnitude the bias direction matters less
  // than "we missed by a full grade point".
  if (d == null) return "bg-[#F0EDE5] text-[#888]";
  const a = Math.abs(d);
  if (a === 0)   return "bg-green-100  text-green-800";
  if (a <  0.5)  return "bg-green-50   text-green-700";
  if (a <  1.0)  return d > 0 ? "bg-amber-100 text-amber-800" : "bg-blue-100 text-blue-800";
  return "bg-red-100 text-red-800 font-bold";
}

function biasRowClass(mean: number | null): string {
  if (mean == null) return "text-[#888]";
  const a = Math.abs(mean);
  if (a < 0.1)  return "text-green-700";
  if (mean > 0) return "text-amber-700";
  return "text-blue-700";
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)        return "just now";
  if (ms < 3_600_000)     return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function modelLabel(m: string): string {
  if (m.startsWith("claude-haiku"))  return "Haiku 4.5";
  if (m.startsWith("claude-opus"))   return "Opus 4.7";
  if (m.startsWith("claude-sonnet")) return "Sonnet";
  if (m.startsWith("gpt"))           return m.toUpperCase();
  return m || "—";
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function AdminDivergencePage() {
  const [sinceDays, setSinceDays] = useState<number | null>(30);
  const [callType,  setCallType]  = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState<string | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery<Resp>({
    queryKey: ["/api/admin/ai-divergence", { sinceDays, callType }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sinceDays != null) params.set("sinceDays", String(sinceDays));
      if (callType)          params.set("callType",  callType);
      const res = await fetch(`/api/admin/ai-divergence?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
  });

  const summary = data?.summary;
  // Apply model filter on the client so we don't re-roundtrip the API for it.
  const certs = useMemo(() => {
    if (!data) return [];
    return modelFilter ? data.certs.filter(c => c.model === modelFilter) : data.certs;
  }, [data, modelFilter]);

  // Auto-populate model dropdown from data.
  const modelOptions = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.summary.by_model);
  }, [data]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <TrendingUp size={22} className="text-[#D4AF37]" />
          <div>
            <h1 className="text-xl font-bold text-[#1A1A1A]">AI Divergence</h1>
            <p className="text-[#888888] text-sm">
              Where the AI grader and the human approver disagree. Step one toward training a custom model.
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
            <option value="90">Last 90 days</option>
            <option value="3650">All</option>
          </select>
          <select
            value={callType ?? ""}
            onChange={e => setCallType(e.target.value === "" ? null : e.target.value)}
            className="text-xs px-3 py-1.5 rounded border border-[#D4D0C8] text-[#333] bg-white"
          >
            <option value="">All call types</option>
            <option value="full_grade">Full grade (Opus)</option>
            <option value="quick_grade">Haiku quick-grade</option>
          </select>
          <select
            value={modelFilter ?? ""}
            onChange={e => setModelFilter(e.target.value === "" ? null : e.target.value)}
            className="text-xs px-3 py-1.5 rounded border border-[#D4D0C8] text-[#333] bg-white"
          >
            <option value="">All models</option>
            {modelOptions.map(m => <option key={m} value={m}>{modelLabel(m)}</option>)}
          </select>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-[#D4D0C8] text-[#333] hover:border-[#D4AF37] hover:text-[#D4AF37] disabled:opacity-60"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full" />
        </div>
      )}

      {!isLoading && data && (
        <>
          {/* ── Sample size warning ───────────────────────────────────────── */}
          {data.sample_size < 5 && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-amber-900 text-sm font-bold">Not enough paired data yet</p>
                <p className="text-amber-800 text-xs mt-1">
                  Divergence statistics need at least 5 certs with both AI prediction and human grade to be meaningful.
                  Currently have <strong>{data.sample_size}</strong>. Numbers below are real but directional only.
                </p>
              </div>
            </div>
          )}

          <p className="text-[#888] text-sm">
            Sample: <strong>{data.sample_size}</strong> cert{data.sample_size === 1 ? "" : "s"} with paired prediction + human grade
            {sinceDays != null && sinceDays < 365 ? ` (last ${sinceDays} days)` : ""}
            {" · "} Generated {fmtRelative(data.generated_at)}
          </p>

          {data.sample_size > 0 && summary && (
            <>
              {/* ── Bias by zone ─────────────────────────────────────────── */}
              <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6">
                <h2 className="text-[#1A1A1A] font-bold mb-4">Bias by zone</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-widest text-[#888] border-b border-[#E8E4DC]">
                      <th className="text-left px-2 py-2">Zone</th>
                      <th className="text-right px-2 py-2">n</th>
                      <th className="text-right px-2 py-2">Mean</th>
                      <th className="text-right px-2 py-2">Median</th>
                      <th className="text-right px-2 py-2">Stddev</th>
                      <th className="text-right px-2 py-2">AI generous</th>
                      <th className="text-right px-2 py-2">AI harsh</th>
                      <th className="text-right px-2 py-2">Exact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ZONES.map(z => {
                      const s = summary.by_zone[z];
                      return (
                        <tr key={z} className="border-b border-[#E8E4DC] last:border-0">
                          <td className="px-2 py-2 font-medium text-[#1A1A1A]">{ZONE_LABEL[z]}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{s.n}</td>
                          <td className={`px-2 py-2 text-right tabular-nums font-bold ${biasRowClass(s.mean_divergence)}`}>{fmtSigned(s.mean_divergence)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[#555]">{fmtSigned(s.median_divergence)}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-[#555]">{s.stddev != null ? s.stddev.toFixed(2) : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-amber-700">{s.ai_too_generous_pct != null ? `${s.ai_too_generous_pct}%` : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-blue-700">{s.ai_too_harsh_pct != null ? `${s.ai_too_harsh_pct}%` : "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums text-green-700">{s.exact_match_pct != null ? `${s.exact_match_pct}%` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="text-[10px] text-[#888] mt-3">
                  Positive mean = AI gave a higher grade than the human (too generous). Negative = AI was harsher than human.
                </p>
              </div>

              {/* ── By grade band + by model ─────────────────────────────── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6">
                  <h3 className="text-[#1A1A1A] font-bold mb-3">By grade band</h3>
                  <div className="space-y-2 text-sm">
                    {Object.entries(summary.by_grade_band).map(([band, s]) => (
                      <div key={band} className="grid grid-cols-[80px_60px_1fr] items-center gap-2">
                        <span className="text-[#1A1A1A] font-medium">Grade {band}</span>
                        <span className="text-[#888] text-xs">n={s.n}</span>
                        <span className={`text-right tabular-nums font-bold ${biasRowClass(s.mean_overall_divergence)}`}>
                          {s.n > 0 ? `mean overall ${fmtSigned(s.mean_overall_divergence)}` : "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6">
                  <h3 className="text-[#1A1A1A] font-bold mb-3">By model</h3>
                  <div className="space-y-2 text-sm">
                    {Object.entries(summary.by_model).map(([m, s]) => (
                      <div key={m} className="grid grid-cols-[1fr_60px_120px] items-center gap-2">
                        <span className="text-[#1A1A1A] font-medium truncate" title={m}>{modelLabel(m)}</span>
                        <span className="text-[#888] text-xs">n={s.n}</span>
                        <span className={`text-right tabular-nums font-bold ${biasRowClass(s.mean_overall_divergence)}`}>
                          {s.n > 0 ? fmtSigned(s.mean_overall_divergence) : "—"}
                        </span>
                      </div>
                    ))}
                    {Object.keys(summary.by_model).length === 0 && <p className="text-[#888] text-xs">No predictions yet.</p>}
                  </div>
                </div>
              </div>

              {/* ── Per-cert table ─────────────────────────────────────────── */}
              <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-6 py-3 border-b border-[#E8E4DC]">
                  <h3 className="text-[#1A1A1A] font-bold">Per-cert divergence</h3>
                  <span className="text-[10px] text-[#888]">sorted by biggest disagreement first · click row to inspect cert</span>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-[#F0EDE5]">
                    <tr className="text-[10px] uppercase tracking-widest text-[#888]">
                      <th className="text-left  px-3 py-2 w-20">Cert</th>
                      <th className="text-left  px-3 py-2">Card</th>
                      <th className="text-left  px-3 py-2 w-24">Model</th>
                      <th className="text-left  px-3 py-2 w-24">Approved</th>
                      {ZONES.map(z => (
                        <th key={z} className="text-center px-2 py-2 w-16" title={ZONE_LABEL[z]}>{ZONE_SHORT[z]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {certs.map(cert => (
                      <tr
                        key={cert.cert_id}
                        className="border-b border-[#E8E4DC] last:border-0 hover:bg-white cursor-pointer"
                        onClick={() => window.open(`/cert/${cert.cert_id}`, "_blank")}
                        title={`Open ${cert.cert_id} in new tab`}
                      >
                        <td className="px-3 py-2 font-mono text-xs text-[#1A1A1A]">
                          <span className="inline-flex items-center gap-1">
                            {cert.cert_id} <ExternalLink size={10} className="text-[#888]" />
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[#333] truncate max-w-[200px]">{cert.card_name || <span className="text-[#888]">—</span>}</td>
                        <td className="px-3 py-2 text-[#555] text-xs">{modelLabel(cert.model)}</td>
                        <td className="px-3 py-2 text-[#888] text-xs whitespace-nowrap">{fmtRelative(cert.approved_at)}</td>
                        {ZONES.map(z => {
                          const cell = cert.grades[z];
                          return (
                            <td key={z} className="px-1 py-1 text-center">
                              <span
                                className={`inline-block w-12 py-1 rounded text-xs tabular-nums ${divCellClass(cell.divergence)}`}
                                title={cell.ai != null && cell.human != null ? `AI ${cell.ai} vs human ${cell.human}` : "no AI prediction"}
                              >
                                {fmtSigned(cell.divergence)}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {certs.length === 0 && (
                  <div className="p-12 text-center text-[#888] text-sm">
                    No certs match the current filters.
                  </div>
                )}
              </div>
            </>
          )}

          {data.sample_size === 0 && (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-12 text-center">
              <TrendingUp size={32} className="text-[#CCCCCC] mx-auto mb-3" />
              <p className="text-[#1A1A1A] text-sm font-bold mb-1">No paired data in this window</p>
              <p className="text-[#888] text-xs">
                Either no certs were approved + AI-graded in the selected window, or the call_type filter excluded them.
              </p>
            </div>
          )}
        </>
      )}

      <p className="text-[#888] text-xs">
        Read-only dashboard — auto-refetches every 5 minutes. Click any cert row to open it in a new tab.
      </p>
    </div>
  );
}
