/**
 * /admin/weekly-reel — operator view of the weekly grade-highlights pipeline.
 *
 * Three sections:
 *   1. Pipeline controls — manual trigger, schedule, Segmind key status
 *   2. Featured cards — single table, admin checkbox flips the
 *      marketing_featured flag on each cert. Reel job picks from this pool.
 *   3. Reel history — last 10 runs (from audit_log) with per-card video
 *      previews + error messages
 *
 * Styling mirrors admin-dashboard.tsx — gold #D4AF37 accents, white cards
 * on the #FAFAF8 page bg, same border tone.
 *
 * Auth: page is only reachable from /admin (admin nav link); every endpoint
 * it calls is gated by requireAdmin server-side.
 */

import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Loader2, PlayCircle, KeyRound, Calendar, CheckCircle2, XCircle,
  AlertTriangle, ChevronDown, ChevronUp,
} from "lucide-react";

// ── Types — mirror the backend response shapes ─────────────────────────────

interface FeaturedCard {
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  cardSet: string | null;
  year: string | null;
  featured: boolean;
  featuredAt: string | null;
}

interface ManifestCard {
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  videoUrl: string | null;
  error?: string;
}

interface HistoryEntry {
  date: string;
  createdAt: string;
  status: "ok" | "partial" | "failed" | "unknown";
  cardCount: number;
  successCount: number;
  failCount: number;
  manifestKey: string;
  manifestPresent: boolean;
  cards: ManifestCard[];
}

interface KeyStatus { configured: boolean }
interface GenerateResult {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  date?: string;
  cardCount?: number;
  successCount?: number;
  failCount?: number;
  manifestKey?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtGrade(g: number | null): string {
  if (g == null) return "—";
  return g % 1 === 0 ? String(Math.trunc(g)) : String(g);
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return s; }
}
function statusBadge(s: HistoryEntry["status"]): { label: string; cls: string } {
  switch (s) {
    case "ok":      return { label: "OK",      cls: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "partial": return { label: "Partial", cls: "bg-amber-50    text-amber-700    border-amber-200" };
    case "failed":  return { label: "Failed",  cls: "bg-red-50      text-red-700      border-red-200" };
    default:        return { label: "Unknown", cls: "bg-[#F5F2EB]   text-[#666666]    border-[#E8E4DC]" };
  }
}

// ── Section 1: Pipeline controls ───────────────────────────────────────────

function PipelineControls() {
  const queryClient = useQueryClient();
  const [generateResult, setGenerateResult] = useState<GenerateResult | string | null>(null);

  const { data: keyStatus } = useQuery<KeyStatus>({
    queryKey: ["/api/admin/weekly-reel/key-status"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/key-status")).json(),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/weekly-reel/generate");
      return r.json();
    },
    onSuccess: (data: GenerateResult) => {
      setGenerateResult(data);
      // Refresh history after a successful run.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/status"] });
    },
    onError: (err: any) => {
      // Long-running endpoint: the Fly proxy will likely time out the
      // client connection before the job finishes. Tell the operator the
      // server is probably still running.
      setGenerateResult(
        err?.message
          ? `Request error: ${err.message} — the job may still be running on the server. Refresh history in a few minutes.`
          : "Request error — the job may still be running on the server.",
      );
    },
  });

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Pipeline Controls</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 text-[#666666] text-xs uppercase tracking-wider mb-1">
            <PlayCircle size={14} className="text-[#D4AF37]" /> Manual trigger
          </div>
          <button
            type="button"
            onClick={() => { setGenerateResult(null); generateMutation.mutate(); }}
            disabled={generateMutation.isPending}
            className="mt-2 w-full inline-flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-all bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] hover:opacity-90 disabled:opacity-50"
            data-testid="btn-generate-reel"
          >
            {generateMutation.isPending ? <><Loader2 size={12} className="animate-spin" /> Generating…</> : "Generate Reel Now"}
          </button>
          <p className="mt-2 text-[10px] text-[#888888]">
            Long-running — Segmind ~30-60 s per card × 8 cards. Client connection may time out before completion.
          </p>
        </div>

        <div className="border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 text-[#666666] text-xs uppercase tracking-wider mb-1">
            <Calendar size={14} className="text-[#D4AF37]" /> Next scheduled run
          </div>
          <p className="mt-2 text-sm font-semibold text-[#1A1A1A]">Friday 18:00 UTC</p>
          <p className="mt-1 text-[10px] text-[#888888]">Runs weekly. Skipped automatically if fewer than 3 featured cards.</p>
        </div>

        <div className="border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 text-[#666666] text-xs uppercase tracking-wider mb-1">
            <KeyRound size={14} className="text-[#D4AF37]" /> Segmind key
          </div>
          {keyStatus === undefined ? (
            <p className="mt-2 text-sm text-[#888888]"><Loader2 size={12} className="animate-spin inline" /> checking…</p>
          ) : keyStatus.configured ? (
            <p className="mt-2 text-sm font-semibold text-emerald-700 flex items-center gap-1">
              <CheckCircle2 size={14} /> Key configured
            </p>
          ) : (
            <p className="mt-2 text-sm font-semibold text-red-700 flex items-center gap-1">
              <XCircle size={14} /> Key missing
            </p>
          )}
          <p className="mt-1 text-[10px] text-[#888888]">Set via <code>fly secrets set SEGMIND_API_KEY=…</code></p>
        </div>
      </div>

      {generateResult !== null && (
        <div
          className={`mt-4 text-sm rounded-lg p-3 border ${
            typeof generateResult === "string"
              ? "bg-amber-50 text-amber-800 border-amber-200"
              : generateResult.status === "ok"
                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                : generateResult.status === "skipped"
                  ? "bg-[#F5F2EB] text-[#555] border-[#E8E4DC]"
                  : "bg-red-50 text-red-800 border-red-200"
          }`}
          data-testid="text-generate-result"
        >
          {typeof generateResult === "string"
            ? generateResult
            : (
              <>
                <strong>{generateResult.status.toUpperCase()}</strong>
                {generateResult.reason && <> — {generateResult.reason}</>}
                {generateResult.date && <> — {generateResult.date}</>}
                {typeof generateResult.successCount === "number" && (
                  <> — {generateResult.successCount}/{generateResult.cardCount} ok, {generateResult.failCount} failed</>
                )}
              </>
            )}
        </div>
      )}
    </div>
  );
}

// ── Section 2: Featured cards ──────────────────────────────────────────────

function FeaturedCardsTable() {
  const queryClient = useQueryClient();
  const [busyCert, setBusyCert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ cards: FeaturedCard[] }>({
    queryKey: ["/api/admin/weekly-reel/featured-cards"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/featured-cards")).json(),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ certNumber, featured }: { certNumber: string; featured: boolean }) => {
      const r = await apiRequest(
        "PATCH",
        `/api/admin/weekly-reel/card/${encodeURIComponent(certNumber)}/featured`,
        { featured },
      );
      return r.json();
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/featured-cards"] });
    },
    onError: (err: any) => setError(err?.message ?? "Toggle failed"),
    onSettled: () => setBusyCert(null),
  });

  const cards = data?.cards ?? [];
  const featuredCount = cards.filter(c => c.featured).length;

  function onToggle(certNumber: string, nextFeatured: boolean) {
    setBusyCert(certNumber);
    toggleMutation.mutate({ certNumber, featured: nextFeatured });
  }

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Featured Cards</h2>
        <span className="text-xs text-[#888888]">
          {isLoading ? "…" : `${featuredCount} of ${cards.length} featured`}
        </span>
      </div>
      <p className="text-xs text-[#666666] mb-4">
        Admin-curated pool for the weekly reel. Toggling flips
        <code className="mx-1">certificates.marketing_featured</code> and writes an audit_log row.
        Independent of the user's <code>marketing_feature_consent</code> — the admin flag is the
        only thing the reel job reads.
      </p>
      {isLoading ? (
        <div className="py-12 flex justify-center"><Loader2 size={20} className="text-[#D4AF37] animate-spin" /></div>
      ) : cards.length === 0 ? (
        <p className="text-sm text-[#888888] py-6 text-center">No graded cards yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-[#E8E4DC]">
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Cert ID</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Card Name</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Set</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Grade</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Featured At</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888] text-right">Featured</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((c) => {
                const busy = busyCert === c.certNumber;
                const next = !c.featured;
                return (
                  <tr key={c.certNumber} className="border-b border-[#F0EDE5]" data-testid={`row-card-${c.certNumber}`}>
                    <td className="py-2 px-3 font-mono text-[#1A1A1A]">{c.certNumber}</td>
                    <td className="py-2 px-3 text-[#1A1A1A]">{c.cardName ?? "—"}</td>
                    <td className="py-2 px-3 text-[#555]">{c.cardSet ?? "—"}{c.year ? ` (${c.year})` : ""}</td>
                    <td className="py-2 px-3 font-bold text-[#1A1A1A]">{fmtGrade(c.grade)}</td>
                    <td className="py-2 px-3 text-[#888]">{c.featured ? fmtDate(c.featuredAt) : "—"}</td>
                    <td className="py-2 px-3 text-right">
                      <label className="inline-flex items-center gap-2 cursor-pointer">
                        <span className="text-xs text-[#666]">{busy ? "…" : (c.featured ? "on" : "off")}</span>
                        <input
                          type="checkbox"
                          checked={c.featured}
                          disabled={busy}
                          onChange={() => onToggle(c.certNumber, next)}
                          className="accent-[#D4AF37] h-4 w-4"
                          data-testid={`toggle-${c.certNumber}`}
                        />
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm" role="alert">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// ── Section 3: Reel history ────────────────────────────────────────────────

function HistoryEntryRow({ entry }: { entry: HistoryEntry }) {
  const [open, setOpen] = useState(false);
  const badge = statusBadge(entry.status);
  return (
    <div className="border border-[#E8E4DC] rounded-xl overflow-hidden" data-testid={`history-${entry.date}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[#FAFAF8] transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-mono text-sm text-[#1A1A1A]">{entry.date}</span>
          <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border font-semibold ${badge.cls}`}>
            {badge.label}
          </span>
          <span className="text-xs text-[#666] truncate">
            {entry.successCount}/{entry.cardCount} ok
            {entry.failCount > 0 && <> · {entry.failCount} failed</>}
            {!entry.manifestPresent && <> · manifest missing</>}
          </span>
        </div>
        {open ? <ChevronUp size={16} className="shrink-0 text-[#888]" /> : <ChevronDown size={16} className="shrink-0 text-[#888]" />}
      </button>
      {open && (
        <div className="border-t border-[#E8E4DC] p-4 bg-[#FAFAF8]">
          <p className="text-[10px] text-[#888] mb-3">
            Generated {fmtDate(entry.createdAt)} · manifest <code>{entry.manifestKey}</code>
          </p>
          {entry.cards.length === 0 ? (
            <p className="text-sm text-[#888]">No per-card data — manifest is empty or unreadable.</p>
          ) : (
            <ul className="space-y-3">
              {entry.cards.map((c, i) => (
                <li key={`${entry.date}-${c.certNumber}-${i}`} className="bg-white border border-[#E8E4DC] rounded-lg p-3" data-testid={`history-card-${entry.date}-${c.certNumber}`}>
                  <div className="flex items-baseline gap-2 mb-2">
                    <span className="font-mono text-sm font-semibold text-[#1A1A1A]">{c.certNumber}</span>
                    <span className="text-xs text-[#666]">grade {fmtGrade(c.grade)}</span>
                    {c.cardName && <span className="text-xs text-[#888] truncate">· {c.cardName}</span>}
                  </div>
                  {c.videoUrl ? (
                    <video
                      src={c.videoUrl}
                      controls
                      preload="none"
                      className="w-full max-w-sm rounded-lg border border-[#E8E4DC] bg-black"
                      data-testid={`video-${entry.date}-${c.certNumber}`}
                    />
                  ) : c.error ? (
                    <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 font-mono break-words">{c.error}</p>
                  ) : (
                    <p className="text-xs text-[#888]">No video URL · no error recorded</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function HistorySection() {
  const { data, isLoading } = useQuery<{ history: HistoryEntry[] }>({
    queryKey: ["/api/admin/weekly-reel/status"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/status")).json(),
  });

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Reel History</h2>
        <span className="text-xs text-[#888888]">Last 10 runs</span>
      </div>
      {isLoading ? (
        <div className="py-12 flex justify-center"><Loader2 size={20} className="text-[#D4AF37] animate-spin" /></div>
      ) : (data?.history.length ?? 0) === 0 ? (
        <p className="text-sm text-[#888] py-6 text-center">
          No reel runs yet. Audit-log only captures completed runs — pure skips (below-floor, missing key) won't appear here.
        </p>
      ) : (
        <div className="space-y-3">
          {data?.history.map(e => <HistoryEntryRow key={e.date} entry={e} />)}
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function AdminWeeklyReelPage() {
  return (
    <div className="min-h-screen bg-[#FAFAF8] px-4 py-12">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-black text-[#1A1A1A]">Weekly Reel</h1>
            <p className="text-xs text-[#888]">Grade-highlight video pipeline · Segmind Higgsfield dop-lite</p>
          </div>
          <Link
            href="/admin"
            className="text-xs text-[#666] hover:text-[#D4AF37] transition-colors"
          >
            ← Admin Dashboard
          </Link>
        </div>

        <div className="space-y-6">
          <PipelineControls />
          <FeaturedCardsTable />
          <HistorySection />
        </div>
      </div>
    </div>
  );
}
