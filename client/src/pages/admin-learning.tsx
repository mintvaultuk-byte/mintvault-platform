import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Brain, TrendingUp, AlertTriangle, CheckCircle2, BarChart3, Clock, ToggleLeft, Database } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Panel, Badge, AdminButton } from "@/components/admin";

// ── New /api/admin/ai-dashboard-stats response shape ───────────────────────
interface AiDashboardStats {
  total_graded: number;
  this_month: number;
  average_grade: number | null;
  avg_time_seconds: number | null;
  grade_distribution: { grade: string; count: number }[];
  pristine_10p_count: number;
  ai_accuracy: {
    prediction_count: number;
    approved_count: number;
    exact_agreement_pct: number | null;
    within_half_point_pct: number | null;
    mean_absolute_error: number | null;
  };
  last_30_days: { day: string; count: number }[];
}

// ── /api/admin/ai-feature-flags response shape ─────────────────────────────
interface AiFeatureFlag {
  name: string;
  enabled: boolean;
  envDefault: boolean;
  overrideSet: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string | null;
}

const FLAG_COPY: Record<string, { title: string; description: string }> = {
  AI_IDENTIFY_ENABLED: {
    title: "Card identification",
    description: "Claude Haiku identifies the card from front-image scans during ingest.",
  },
  AI_DEFECT_SUGGEST_ENABLED: {
    title: "AI defect suggestions",
    description: "Haiku suggests candidate defects on scan; admin reviews before approval.",
  },
  AI_HAIKU_QUICK_GRADE_ENABLED: {
    title: "Haiku quick-grade",
    description: "Pre-fills the grading form with subgrades from a fast Haiku pass.",
  },
  AI_FULL_GRADE_ENABLED: {
    title: "Full Opus grade",
    description: "Heavy Opus 4.7 grading run with adaptive thinking — slower, more thorough.",
  },
  AI_CENTERING_ENABLED: {
    title: "Centering measurement",
    description: "Standalone Sonnet pass that returns centering ratios and a subgrade.",
  },
  AI_STANDALONE_DETECT_ENABLED: {
    title: "Standalone defect detect",
    description: "On-demand Sonnet defect run, separate from the scan-time Haiku pass.",
  },
  AI_STANDALONE_GRADE_ENABLED: {
    title: "Standalone grade-card",
    description: "On-demand Sonnet grade-only run that uses prior step context.",
  },
  AI_DESCRIPTION_GEN_ENABLED: {
    title: "Grade description",
    description: "Generates the public-facing grade explanation after subgrades are set.",
  },
  AI_GPT_SECOND_OPINION_ENABLED: {
    title: "GPT-4o second opinion",
    description: "Optional OpenAI call run alongside Claude for identification reconciliation.",
  },
  AI_PUBLIC_ESTIMATE_ENABLED: {
    title: "Public Pre-Grade tool",
    description: "Powers /tools/estimate — public-facing free AI grading estimate.",
  },
};

interface LearningOverview {
  overview: {
    total_graded: number;
    this_month: number;
    avg_grade: number;
    avg_seconds: number;
    pristine_10p_count: number;
  };
  grade_distribution: { final_grade: number; count: number }[];
  game_distribution: { card_game: string; count: number }[];
  activity_last_30_days: { day: string; count: number }[];
}

interface AccuracyData {
  centering_accuracy: number | null;
  corners_accuracy: number | null;
  edges_accuracy: number | null;
  surface_accuracy: number | null;
  overall_accuracy: number | null;
  avg_centering_diff: number | null;
  avg_corners_diff: number | null;
  avg_edges_diff: number | null;
  avg_surface_diff: number | null;
  avg_overall_diff: number | null;
}

function formatSeconds(s: number): string {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

function tendency(diff: number | null): string {
  if (diff === null) return "No data";
  const abs = Math.abs(diff);
  if (abs <= 0.2) return "Accurate";
  const dir = diff > 0 ? "strict" : "generous";
  if (abs <= 0.5) return `Slightly ${dir}`;
  return `Too ${dir}`;
}

function tendencyColor(diff: number | null): string {
  if (diff === null) return "text-[var(--admin-ink-faint)]";
  const abs = Math.abs(diff);
  if (abs <= 0.2) return "text-[var(--admin-green)]";
  if (abs <= 0.5) return "text-[var(--admin-amber)]";
  return "text-[var(--admin-red)]";
}

function AccuracyBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[var(--admin-ink-faint)] text-xs">No data</span>;
  const color =
    value >= 80 ? "bg-[var(--admin-green)]" : value >= 65 ? "bg-[var(--admin-amber)]" : "bg-[var(--admin-red)]";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-[rgba(243,238,227,0.06)] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span
        className="text-sm font-bold text-[var(--admin-ink)] w-10 text-right"
        style={{ fontFamily: "var(--admin-mono)" }}
      >
        {value}%
      </span>
    </div>
  );
}

function generateSuggestions(accuracy: AccuracyData | undefined): string[] {
  if (!accuracy) return [];
  const suggestions: string[] = [];

  const checkDiff = (cat: string, diff: number | null, posLabel: string, negLabel: string) => {
    if (diff === null) return;
    if (diff > 0.3)
      suggestions.push(
        `${cat.toUpperCase()}: AI is too ${posLabel} by an average of ${Math.abs(diff).toFixed(1)} points. Consider adding stricter language to the ${cat} criteria in the grading prompt.`
      );
    else if (diff < -0.3)
      suggestions.push(
        `${cat.toUpperCase()}: AI is too ${negLabel} by an average of ${Math.abs(diff).toFixed(1)} points. Consider relaxing ${cat} criteria slightly.`
      );
  };

  checkDiff("centering", accuracy.avg_centering_diff, "strict", "generous");
  checkDiff("corners", accuracy.avg_corners_diff, "generous", "strict");
  checkDiff("edges", accuracy.avg_edges_diff, "generous", "strict");
  checkDiff("surface", accuracy.avg_surface_diff, "generous", "strict");

  if (suggestions.length === 0)
    suggestions.push("AI performance is within acceptable range. No prompt changes recommended at this time.");
  return suggestions;
}

export default function AdminLearningPage() {
  const { data: overview, isLoading: loadingOverview } = useQuery<LearningOverview>({
    queryKey: ["/api/admin/learning/overview"],
    queryFn: async () => {
      const res = await fetch("/api/admin/learning/overview", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  const { data: accuracy } = useQuery<AccuracyData>({
    queryKey: ["/api/admin/learning/accuracy"],
    queryFn: async () => {
      const res = await fetch("/api/admin/learning/accuracy", { credentials: "include" });
      if (!res.ok) return null as any;
      return res.json();
    },
  });

  const { data: stats } = useQuery<AiDashboardStats>({
    queryKey: ["/api/admin/ai-dashboard-stats"],
    queryFn: async () => {
      const res = await fetch("/api/admin/ai-dashboard-stats", { credentials: "include" });
      if (!res.ok) return null as any;
      return res.json();
    },
  });

  const { data: flagsData, refetch: refetchFlags } = useQuery<{ flags: AiFeatureFlag[] }>({
    queryKey: ["/api/admin/ai-feature-flags"],
    queryFn: async () => {
      const res = await fetch("/api/admin/ai-feature-flags", { credentials: "include" });
      if (!res.ok) return { flags: [] };
      return res.json();
    },
  });

  // RAG Phase 0 corpus status — passive panel until retrieval is built
  const { data: embedStatus } = useQuery<{
    embedded_count: number;
    total_approved: number;
    percentage: number;
    oldest_unembedded_cert_id: string | null;
    ready?: boolean;
    error?: string;
  }>({
    queryKey: ["/api/admin/embedding-status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/embedding-status", { credentials: "include" });
      if (!res.ok) return null as any;
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
  });

  const o = overview?.overview;
  const maxCount = overview?.grade_distribution.length
    ? Math.max(...overview.grade_distribution.map((d) => d.count))
    : 1;
  const maxActivity = overview?.activity_last_30_days.length
    ? Math.max(...overview.activity_last_30_days.map((d) => d.count))
    : 1;

  const suggestions = generateSuggestions(accuracy);
  const hasAiData = accuracy?.overall_accuracy !== null && accuracy?.overall_accuracy !== undefined;

  // Prefer the new ai-dashboard-stats avg_time_seconds (read from
  // certificates.grading_time_seconds) over the legacy grading_sessions
  // value — both are populated for new approvals, but the new one is the
  // canonical source going forward.
  const avgTimeSeconds = stats?.avg_time_seconds ?? o?.avg_seconds ?? 0;

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingFlag, setPendingFlag] = useState<{ flag: AiFeatureFlag; nextEnabled: boolean } | null>(null);
  const [submittingFlag, setSubmittingFlag] = useState<string | null>(null);
  const [forceEmbedding, setForceEmbedding] = useState(false);

  // Last-run timestamp for the Force embed button countdown. Polled on
  // mount and refetched after every click so the countdown stays in sync
  // with the server's closure variable (which is the source of truth for
  // the debounce). `tick` bumps on a 1s setInterval while a countdown is
  // active — it's the dependency that re-renders the button label.
  const { data: lastRunData, refetch: refetchLastRun } = useQuery<{ lastRunAtMs: number | null; windowMs: number }>({
    queryKey: ["/api/admin/embed-corpus/last-run"],
    queryFn: async () => {
      const res = await fetch("/api/admin/embed-corpus/last-run", { credentials: "include" });
      if (!res.ok) return { lastRunAtMs: null, windowMs: 60000 };
      return res.json();
    },
  });
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastRunData?.lastRunAtMs) return;
    const expireMs = lastRunData.lastRunAtMs + lastRunData.windowMs;
    if (expireMs <= Date.now()) return;
    const id = setInterval(() => {
      if (Date.now() >= expireMs) {
        clearInterval(id);
      }
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [lastRunData?.lastRunAtMs, lastRunData?.windowMs]);
  const secondsLeft = lastRunData?.lastRunAtMs
    ? Math.max(0, Math.ceil((lastRunData.lastRunAtMs + lastRunData.windowMs - Date.now()) / 1000))
    : 0;

  async function forceEmbedNow() {
    setForceEmbedding(true);
    try {
      const res = await fetch("/api/admin/embed-corpus/run", { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.skipped) {
        toast({
          title: `Debounced — try again in ${data.waitSec}s`,
          description: "Force-run is rate-limited to one per 60s.",
        });
      } else {
        toast({
          title: `Embedded ${data.embedded ?? 0} cert${data.embedded === 1 ? "" : "s"}`,
          description: `Picked ${data.picked}, skipped ${data.skippedCount}, failed ${data.failed}.`,
        });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/embedding-status"] });
      refetchLastRun();
    } catch (e: any) {
      toast({ title: "Force embed failed", description: e.message, variant: "destructive" });
    } finally {
      setForceEmbedding(false);
    }
  }

  async function applyFlagToggle(flag: AiFeatureFlag, nextEnabled: boolean) {
    setSubmittingFlag(flag.name);
    try {
      // Reverting to env default = DELETE the override, not POST a matching value.
      // This way the row vanishes and the flag follows env going forward.
      if (nextEnabled === flag.envDefault) {
        const res = await fetch(`/api/admin/ai-feature-flags/${flag.name}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      } else {
        const res = await fetch(`/api/admin/ai-feature-flags`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: flag.name, enabled: nextEnabled, reason: null }),
        });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      }
      toast({ title: `${FLAG_COPY[flag.name]?.title || flag.name} ${nextEnabled ? "enabled" : "disabled"}` });
      await refetchFlags();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ai-dashboard-stats"] });
    } catch (e: any) {
      toast({ title: "Toggle failed", description: e.message, variant: "destructive" });
    } finally {
      setSubmittingFlag(null);
      setPendingFlag(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Brain size={22} className="text-[var(--admin-gold-hi)]" />
        <div>
          <h1 className="text-xl font-bold text-[var(--admin-ink)]">AI Learning Dashboard</h1>
          <p className="text-[var(--admin-ink-dim)] text-sm">
            Track AI accuracy and improve grading consistency over time
          </p>
        </div>
      </div>

      {loadingOverview ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-[var(--admin-gold)] border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* Overview stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              {
                label: "Total Graded",
                value: o?.total_graded ?? 0,
                icon: <BarChart3 size={16} className="text-[var(--admin-gold-hi)]" />,
              },
              {
                label: "This Month",
                value: o?.this_month ?? 0,
                icon: <TrendingUp size={16} className="text-[var(--admin-gold-hi)]" />,
              },
              {
                label: "Average Grade",
                value: o?.avg_grade ? Number(o.avg_grade).toFixed(1) : "—",
                icon: <CheckCircle2 size={16} className="text-[var(--admin-gold-hi)]" />,
              },
              {
                label: "Avg Time/Card",
                value: formatSeconds(Number(avgTimeSeconds)),
                icon: <Clock size={16} className="text-[var(--admin-gold-hi)]" />,
              },
            ].map(({ label, value, icon }) => (
              <div
                key={label}
                className="bg-[var(--admin-panel)] border border-[var(--admin-line-soft)] rounded-xl p-4"
              >
                <div className="flex items-center gap-1.5 mb-2">
                  {icon}
                  <p className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-widest">{label}</p>
                </div>
                <p className="text-2xl font-black text-[var(--admin-ink)]" style={{ fontFamily: "var(--admin-mono)" }}>
                  {value}
                </p>
              </div>
            ))}
          </div>

          {o && o.pristine_10p_count > 0 && (
            <div className="flex items-center gap-2 bg-[rgba(212,175,55,0.1)] border border-[rgba(212,175,55,0.35)] rounded-xl px-4 py-3">
              <span className="text-[var(--admin-gold-hi)] text-lg">★</span>
              <p className="text-[var(--admin-gold-hi)] font-bold text-sm">
                {o.pristine_10p_count} Pristine 10P{o.pristine_10p_count !== 1 ? "s" : ""} awarded
              </p>
            </div>
          )}

          {/* Grade distribution */}
          {(overview?.grade_distribution?.length ?? 0) > 0 && (
            <Panel>
              <h2 className="text-[var(--admin-ink)] font-bold mb-4">Grade Distribution</h2>
              <div className="flex items-end gap-1 h-24">
                {overview!.grade_distribution.map(({ final_grade, count }) => (
                  <div key={final_grade} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full bg-[var(--admin-gold)] rounded-t-sm min-h-1"
                      style={{ height: `${(count / maxCount) * 80}px` }}
                    />
                    <span className="text-[8px] text-[var(--admin-ink-faint)] font-mono">{final_grade}</span>
                    <span className="text-[8px] text-[var(--admin-ink-dim)]">{count}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* AI Accuracy */}
          {hasAiData && (
            <Panel bodyClassName="space-y-5">
              <div className="flex items-center gap-2">
                <Brain size={16} className="text-[var(--admin-gold-hi)]" />
                <h2 className="text-[var(--admin-ink)] font-bold">AI Accuracy</h2>
              </div>
              <p className="text-[var(--admin-ink-dim)] text-sm">
                AI agrees with your final grade within 0.5 points:{" "}
                <strong className="text-[var(--admin-ink)]">{accuracy?.overall_accuracy}%</strong> of the time
              </p>
              <div className="space-y-3">
                {(
                  [
                    { label: "Centering", acc: accuracy?.centering_accuracy, diff: accuracy?.avg_centering_diff },
                    { label: "Corners", acc: accuracy?.corners_accuracy, diff: accuracy?.avg_corners_diff },
                    { label: "Edges", acc: accuracy?.edges_accuracy, diff: accuracy?.avg_edges_diff },
                    { label: "Surface", acc: accuracy?.surface_accuracy, diff: accuracy?.avg_surface_diff },
                  ] as const
                ).map(({ label, acc, diff }) => (
                  <div key={label} className="grid grid-cols-[100px_1fr_80px_120px] items-center gap-3">
                    <p className="text-sm font-medium text-[var(--admin-ink)]">{label}</p>
                    <AccuracyBar value={acc ?? null} />
                    <p
                      className="text-xs text-[var(--admin-ink-faint)] text-right"
                      style={{ fontFamily: "var(--admin-mono)" }}
                    >
                      {diff !== null && diff !== undefined ? (diff > 0 ? "+" : "") + Number(diff).toFixed(1) : "—"}
                    </p>
                    <p className={`text-xs font-medium ${tendencyColor(diff ?? null)}`}>{tendency(diff ?? null)}</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {!hasAiData && (
            <Panel className="text-center">
              <Brain size={24} className="text-[var(--admin-ink-faint)] mx-auto mb-2" />
              <p className="text-[var(--admin-ink-dim)] text-sm">
                AI accuracy data will appear here once you've graded cards using the AI assistant and approved final
                grades.
              </p>
            </Panel>
          )}

          {/* AI Predictions Accuracy — fed from ai_predictions table.
              Until 30 cards have been approved with a captured prediction,
              the panel shows an insufficient-data state with the count we
              still need before the numbers stabilise. */}
          {stats && (
            <Panel bodyClassName="space-y-4">
              <div className="flex items-center gap-2">
                <Brain size={16} className="text-[var(--admin-gold-hi)]" />
                <h2 className="text-[var(--admin-ink)] font-bold">AI Accuracy (Predictions)</h2>
              </div>
              {stats.ai_accuracy.approved_count >= 30 ? (
                <>
                  <p className="text-[var(--admin-ink-dim)] text-sm">
                    Based on <strong className="text-[var(--admin-ink)]">{stats.ai_accuracy.approved_count}</strong>{" "}
                    approved card{stats.ai_accuracy.approved_count === 1 ? "" : "s"} with captured AI predictions (out
                    of {stats.ai_accuracy.prediction_count} total predictions logged).
                  </p>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-widest mb-1">
                        Exact match
                      </p>
                      <p
                        className="text-2xl font-black text-[var(--admin-ink)]"
                        style={{ fontFamily: "var(--admin-mono)" }}
                      >
                        {stats.ai_accuracy.exact_agreement_pct ?? "—"}%
                      </p>
                    </div>
                    <div>
                      <p className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-widest mb-1">
                        Within ½ point
                      </p>
                      <p
                        className="text-2xl font-black text-[var(--admin-ink)]"
                        style={{ fontFamily: "var(--admin-mono)" }}
                      >
                        {stats.ai_accuracy.within_half_point_pct ?? "—"}%
                      </p>
                    </div>
                    <div>
                      <p className="text-[var(--admin-ink-faint)] text-xs uppercase tracking-widest mb-1">
                        Mean abs. error
                      </p>
                      <p
                        className="text-2xl font-black text-[var(--admin-ink)]"
                        style={{ fontFamily: "var(--admin-mono)" }}
                      >
                        {stats.ai_accuracy.mean_absolute_error ?? "—"}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-2">
                  <p className="text-[var(--admin-ink-dim)] text-sm">
                    Need{" "}
                    <strong className="text-[var(--admin-gold-hi)]">
                      {Math.max(0, 30 - stats.ai_accuracy.approved_count)}
                    </strong>{" "}
                    more graded card{30 - stats.ai_accuracy.approved_count === 1 ? "" : "s"} with captured AI
                    predictions before accuracy figures are statistically meaningful.
                  </p>
                  <p className="text-[var(--admin-ink-faint)] text-xs mt-2">
                    Currently {stats.ai_accuracy.approved_count} approved · {stats.ai_accuracy.prediction_count}{" "}
                    predictions logged.
                  </p>
                </div>
              )}
            </Panel>
          )}

          {/* Prompt suggestions */}
          <Panel bodyClassName="space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-[var(--admin-gold-hi)]" />
              <h2 className="text-[var(--admin-ink)] font-bold">Prompt Refinement Suggestions</h2>
            </div>
            {suggestions.map((s, i) => (
              <div
                key={i}
                className="border-l-4 border-[var(--admin-gold)] bg-[rgba(212,175,55,0.06)] rounded-r-xl pl-4 pr-4 py-3"
              >
                <p className="text-[var(--admin-ink-dim)] text-sm leading-relaxed">{s}</p>
              </div>
            ))}
          </Panel>

          {/* Activity chart */}
          {(overview?.activity_last_30_days?.length ?? 0) > 0 && (
            <Panel>
              <h2 className="text-[var(--admin-ink)] font-bold mb-4">Cards Graded — Last 30 Days</h2>
              <div className="flex items-end gap-0.5 h-16">
                {overview!.activity_last_30_days.map(({ day, count }) => (
                  <div key={day} className="flex-1 flex flex-col items-center" title={`${day}: ${count}`}>
                    <div
                      className="w-full bg-[rgba(212,175,55,0.6)] rounded-t-sm min-h-0.5"
                      style={{ height: `${(count / maxActivity) * 52}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[9px] text-[var(--admin-ink-faint)]">30 days ago</span>
                <span className="text-[9px] text-[var(--admin-ink-faint)]">Today</span>
              </div>
            </Panel>
          )}

          {/* Game distribution */}
          {(overview?.game_distribution?.length ?? 0) > 0 && (
            <Panel>
              <h2 className="text-[var(--admin-ink)] font-bold mb-4">By Card Game</h2>
              <div className="space-y-2">
                {overview!.game_distribution.map(({ card_game, count }) => {
                  const total = overview!.game_distribution.reduce((a, b) => a + b.count, 0);
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={card_game} className="flex items-center gap-3">
                      <span className="text-sm text-[var(--admin-ink)] w-24 capitalize">{card_game || "Other"}</span>
                      <div className="flex-1 h-2 bg-[rgba(243,238,227,0.06)] rounded-full overflow-hidden">
                        <div className="h-full bg-[var(--admin-gold)] rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span
                        className="text-xs text-[var(--admin-ink-faint)] w-12 text-right"
                        style={{ fontFamily: "var(--admin-mono)" }}
                      >
                        {count} ({pct}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          {/* AI Feature Toggles — DB-backed runtime overrides.
              Flipping any of these is immediate (no redeploy); the server
              writes to feature_overrides and invalidates its 30s cache so
              the very next AI call reflects the change. "Default" badge
              means the override row is absent and the env-var default is
              in effect; "Custom" means an override row is set. */}
          {flagsData?.flags && flagsData.flags.length > 0 && (
            <Panel bodyClassName="space-y-4">
              <div className="flex items-center gap-2">
                <ToggleLeft size={16} className="text-[var(--admin-gold-hi)]" />
                <h2 className="text-[var(--admin-ink)] font-bold">AI Feature Toggles</h2>
              </div>
              <p className="text-[var(--admin-ink-dim)] text-xs">
                Per-feature kill-switches. Disabling a flag stops that AI call within ~1 second — no redeploy. Reverting
                to "default" clears the override.
              </p>
              <div className="space-y-3">
                {flagsData.flags.map((f) => {
                  const copy = FLAG_COPY[f.name] || { title: f.name, description: "" };
                  const isSubmitting = submittingFlag === f.name;
                  return (
                    <div
                      key={f.name}
                      className="flex items-start justify-between gap-4 border-t border-[var(--admin-line)] pt-3 first:border-t-0 first:pt-0"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-bold text-[var(--admin-ink)]">{copy.title}</p>
                          <Badge variant={f.overrideSet ? "gold" : "neu"}>{f.overrideSet ? "Custom" : "Default"}</Badge>
                          <Badge variant={f.enabled ? "act" : "red"}>{f.enabled ? "Enabled" : "Disabled"}</Badge>
                        </div>
                        <p className="text-[var(--admin-ink-dim)] text-xs mt-1">{copy.description}</p>
                        {f.overrideSet && (
                          <p className="text-[var(--admin-ink-faint)] text-[10px] mt-1">
                            Last toggled by {f.updatedBy || "—"}{" "}
                            {f.updatedAt ? `on ${new Date(f.updatedAt).toLocaleString()}` : ""}
                            {f.reason ? ` · ${f.reason}` : ""}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => setPendingFlag({ flag: f, nextEnabled: !f.enabled })}
                        className={`flex-shrink-0 inline-flex h-6 w-11 items-center rounded-full border transition-colors ${
                          f.enabled
                            ? "bg-[var(--admin-gold)] border-[var(--admin-gold)]"
                            : "bg-[var(--admin-panel3)] border-[var(--admin-line-hard)]"
                        } ${isSubmitting ? "opacity-60" : ""}`}
                        title={`Toggle ${copy.title}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${f.enabled ? "translate-x-6" : "translate-x-1"}`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          {/* RAG Phase 0 — corpus status. Passive panel showing how many
              approved cards have been embedded into pgvector for the
              future retrieval system. Hourly background job populates
              the column; retrieval logic is deferred until ~200 cards. */}
          {embedStatus && (
            <Panel bodyClassName="space-y-3">
              <div className="flex items-center gap-2">
                <Database size={16} className="text-[var(--admin-gold-hi)]" />
                <h2 className="text-[var(--admin-ink)] font-bold">RAG Corpus</h2>
              </div>
              {embedStatus.ready === false ? (
                <p className="text-[var(--admin-ink-dim)] text-sm">
                  Pending migration — pgvector is not yet enabled on the database. Once the migration runs, the hourly
                  embed-corpus job will start populating this panel.
                </p>
              ) : (
                <>
                  <p className="text-[var(--admin-ink)] text-sm">
                    <strong>{embedStatus.embedded_count}</strong> / <strong>{embedStatus.total_approved}</strong> cards
                    embedded for future retrieval system ({embedStatus.percentage}%).
                  </p>
                  <div className="h-2 bg-[rgba(243,238,227,0.06)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--admin-gold)] rounded-full transition-all"
                      style={{ width: `${embedStatus.percentage}%` }}
                    />
                  </div>
                  {embedStatus.oldest_unembedded_cert_id && (
                    <p className="text-[var(--admin-ink-faint)] text-xs">
                      Next up:{" "}
                      <span className="font-mono text-[var(--admin-gold-hi)]">
                        {embedStatus.oldest_unembedded_cert_id}
                      </span>{" "}
                      · hourly job picks up to 50 per tick.
                    </p>
                  )}
                  {embedStatus.embedded_count === embedStatus.total_approved && embedStatus.total_approved > 0 && (
                    <p className="text-[var(--admin-green)] text-xs">All approved cards embedded ✓</p>
                  )}
                  {/* Dormant-retrieval banner — vectors are being written but
                      no grading pass consumes them yet. Wiring is a separate
                      task; this line keeps the operator aware of that. */}
                  <p className="text-[var(--admin-gold-hi)] text-xs bg-[rgba(212,175,55,0.06)] border border-[rgba(212,175,55,0.3)] rounded px-2 py-1.5">
                    ⓘ Embeddings are being generated but not yet consumed by any grading pass. Retrieval wiring is a
                    separate task.
                  </p>
                  {/* Force embed now — bypasses the hourly cadence and runs
                      the next batch immediately. 60s server-side debounce. */}
                  <AdminButton
                    type="button"
                    variant="gold"
                    size="sm"
                    onClick={forceEmbedNow}
                    disabled={forceEmbedding || secondsLeft > 0}
                    className="uppercase tracking-widest"
                    data-testid="button-force-embed-now"
                  >
                    {forceEmbedding
                      ? "Running…"
                      : secondsLeft > 0
                        ? `Force embed (${secondsLeft}s)`
                        : "Force embed now"}
                  </AdminButton>
                </>
              )}
            </Panel>
          )}

          {!o?.total_graded && (
            <div className="text-center py-12 text-[var(--admin-ink-faint)]">
              <Brain size={32} className="mx-auto mb-3 text-[var(--admin-ink-faint)]" />
              <p className="text-sm">No grading sessions recorded yet.</p>
              <p className="text-xs mt-1">Data appears here as you grade cards and approve grades.</p>
            </div>
          )}
        </>
      )}

      {/* Confirm dialog for flag toggle. Plain inline modal — no shadcn Dialog
          dependency to keep the patch self-contained on this page. */}
      {pendingFlag && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPendingFlag(null)}
        >
          <div
            className="bg-[var(--admin-panel)] rounded-xl border border-[var(--admin-line)] p-6 max-w-md w-full mx-4 space-y-4 shadow-[var(--admin-sh)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[var(--admin-ink)] font-bold">
              {pendingFlag.nextEnabled ? "Enable" : "Disable"}{" "}
              {FLAG_COPY[pendingFlag.flag.name]?.title || pendingFlag.flag.name}?
            </h3>
            <p className="text-[var(--admin-ink-dim)] text-sm">
              {pendingFlag.nextEnabled
                ? "This AI call will start running again on the next request."
                : "This AI call will stop running within ~1 second of confirming."}
              {pendingFlag.nextEnabled === pendingFlag.flag.envDefault
                ? " The override will be cleared so the flag follows its env default going forward."
                : " A custom override will be saved."}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <AdminButton type="button" size="sm" onClick={() => setPendingFlag(null)}>
                Cancel
              </AdminButton>
              <AdminButton
                type="button"
                variant="gold"
                size="sm"
                onClick={() => applyFlagToggle(pendingFlag.flag, pendingFlag.nextEnabled)}
                disabled={submittingFlag === pendingFlag.flag.name}
              >
                {submittingFlag === pendingFlag.flag.name ? "Applying…" : "Confirm"}
              </AdminButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
