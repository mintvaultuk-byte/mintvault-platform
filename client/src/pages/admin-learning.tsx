import { useQuery } from "@tanstack/react-query";
import { Brain, TrendingUp, AlertTriangle, CheckCircle2, BarChart3, Clock } from "lucide-react";

interface LearningOverview {
  overview: {
    total_graded: number;
    this_month: number;
    avg_grade: number;
    avg_seconds: number;
    black_label_count: number;
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
  if (diff === null) return "text-[#888888]";
  const abs = Math.abs(diff);
  if (abs <= 0.2) return "text-emerald-600";
  if (abs <= 0.5) return "text-amber-600";
  return "text-red-600";
}

function AccuracyBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[#888888] text-xs">No data</span>;
  const color = value >= 80 ? "bg-emerald-500" : value >= 65 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-[#E8E4DC] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-sm font-bold text-[#1A1A1A] w-10 text-right">{value}%</span>
    </div>
  );
}

function generateSuggestions(accuracy: AccuracyData | undefined): string[] {
  if (!accuracy) return [];
  const suggestions: string[] = [];

  const checkDiff = (cat: string, diff: number | null, posLabel: string, negLabel: string) => {
    if (diff === null) return;
    if (diff > 0.3) suggestions.push(`${cat.toUpperCase()}: AI is too ${posLabel} by an average of ${Math.abs(diff).toFixed(1)} points. Consider adding stricter language to the ${cat} criteria in the grading prompt.`);
    else if (diff < -0.3) suggestions.push(`${cat.toUpperCase()}: AI is too ${negLabel} by an average of ${Math.abs(diff).toFixed(1)} points. Consider relaxing ${cat} criteria slightly.`);
  };

  checkDiff("centering", accuracy.avg_centering_diff, "strict", "generous");
  checkDiff("corners",   accuracy.avg_corners_diff,   "generous", "strict");
  checkDiff("edges",     accuracy.avg_edges_diff,      "generous", "strict");
  checkDiff("surface",   accuracy.avg_surface_diff,    "generous", "strict");

  if (suggestions.length === 0) suggestions.push("AI performance is within acceptable range. No prompt changes recommended at this time.");
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

  const { data: accuracy, isLoading: loadingAccuracy } = useQuery<AccuracyData>({
    queryKey: ["/api/admin/learning/accuracy"],
    queryFn: async () => {
      const res = await fetch("/api/admin/learning/accuracy", { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  const o = overview?.overview;
  const maxCount = overview?.grade_distribution.length
    ? Math.max(...overview.grade_distribution.map(d => d.count))
    : 1;
  const maxActivity = overview?.activity_last_30_days.length
    ? Math.max(...overview.activity_last_30_days.map(d => d.count))
    : 1;

  const suggestions = generateSuggestions(accuracy);
  const hasAiData = accuracy?.overall_accuracy !== null && accuracy?.overall_accuracy !== undefined;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Brain size={22} className="text-[#D4AF37]" />
        <div>
          <h1 className="text-xl font-bold text-[#1A1A1A]">AI Learning Dashboard</h1>
          <p className="text-[#888888] text-sm">Track AI accuracy and improve grading consistency over time</p>
        </div>
      </div>

      {loadingOverview ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin w-8 h-8 border-2 border-[#D4AF37] border-t-transparent rounded-full" />
        </div>
      ) : (
        <>
          {/* Overview stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: "Total Graded",    value: o?.total_graded ?? 0,    icon: <BarChart3 size={16} className="text-[#D4AF37]" /> },
              { label: "This Month",      value: o?.this_month ?? 0,       icon: <TrendingUp size={16} className="text-[#D4AF37]" /> },
              { label: "Average Grade",   value: o?.avg_grade ? Number(o.avg_grade).toFixed(1) : "—", icon: <CheckCircle2 size={16} className="text-[#D4AF37]" /> },
              { label: "Avg Time/Card",   value: formatSeconds(Number(o?.avg_seconds ?? 0)), icon: <Clock size={16} className="text-[#D4AF37]" /> },
            ].map(({ label, value, icon }) => (
              <div key={label} className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-4">
                <div className="flex items-center gap-1.5 mb-2">{icon}<p className="text-[#888888] text-xs uppercase tracking-widest">{label}</p></div>
                <p className="text-2xl font-black text-[#1A1A1A]">{value}</p>
              </div>
            ))}
          </div>

          {o && o.black_label_count > 0 && (
            <div className="flex items-center gap-2 bg-[#D4AF37]/10 border border-[#D4AF37]/30 rounded-xl px-4 py-3">
              <span className="text-[#D4AF37] text-lg">★</span>
              <p className="text-[#D4AF37] font-bold text-sm">{o.black_label_count} Black Label{o.black_label_count !== 1 ? "s" : ""} awarded</p>
            </div>
          )}

          {/* Grade distribution */}
          {(overview?.grade_distribution?.length ?? 0) > 0 && (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6">
              <h2 className="text-[#1A1A1A] font-bold mb-4">Grade Distribution</h2>
              <div className="flex items-end gap-1 h-24">
                {overview!.grade_distribution.map(({ final_grade, count }) => (
                  <div key={final_grade} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full bg-[#D4AF37] rounded-t-sm min-h-1"
                      style={{ height: `${(count / maxCount) * 80}px` }}
                    />
                    <span className="text-[8px] text-[#888888] font-mono">{final_grade}</span>
                    <span className="text-[8px] text-[#555555]">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Accuracy */}
          {hasAiData && (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6 space-y-5">
              <div className="flex items-center gap-2">
                <Brain size={16} className="text-[#D4AF37]" />
                <h2 className="text-[#1A1A1A] font-bold">AI Accuracy</h2>
              </div>
              <p className="text-[#555555] text-sm">
                AI agrees with your final grade within 0.5 points:{" "}
                <strong className="text-[#1A1A1A]">{accuracy?.overall_accuracy}%</strong> of the time
              </p>
              <div className="space-y-3">
                {([
                  { label: "Centering", acc: accuracy?.centering_accuracy, diff: accuracy?.avg_centering_diff },
                  { label: "Corners",   acc: accuracy?.corners_accuracy,   diff: accuracy?.avg_corners_diff },
                  { label: "Edges",     acc: accuracy?.edges_accuracy,     diff: accuracy?.avg_edges_diff },
                  { label: "Surface",   acc: accuracy?.surface_accuracy,   diff: accuracy?.avg_surface_diff },
                ] as const).map(({ label, acc, diff }) => (
                  <div key={label} className="grid grid-cols-[100px_1fr_80px_120px] items-center gap-3">
                    <p className="text-sm font-medium text-[#1A1A1A]">{label}</p>
                    <AccuracyBar value={acc ?? null} />
                    <p className="text-xs text-[#888888] text-right">
                      {diff !== null && diff !== undefined ? (diff > 0 ? "+" : "") + Number(diff).toFixed(1) : "—"}
                    </p>
                    <p className={`text-xs font-medium ${tendencyColor(diff ?? null)}`}>{tendency(diff ?? null)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!hasAiData && (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6 text-center">
              <Brain size={24} className="text-[#CCCCCC] mx-auto mb-2" />
              <p className="text-[#888888] text-sm">AI accuracy data will appear here once you've graded cards using the AI assistant and approved final grades.</p>
            </div>
          )}

          {/* Prompt suggestions */}
          <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-[#D4AF37]" />
              <h2 className="text-[#1A1A1A] font-bold">Prompt Refinement Suggestions</h2>
            </div>
            {suggestions.map((s, i) => (
              <div key={i} className="border-l-4 border-[#D4AF37] bg-[#D4AF37]/5 rounded-r-xl pl-4 pr-4 py-3">
                <p className="text-[#555555] text-sm leading-relaxed">{s}</p>
              </div>
            ))}
          </div>

          {/* Activity chart */}
          {(overview?.activity_last_30_days?.length ?? 0) > 0 && (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6">
              <h2 className="text-[#1A1A1A] font-bold mb-4">Cards Graded — Last 30 Days</h2>
              <div className="flex items-end gap-0.5 h-16">
                {overview!.activity_last_30_days.map(({ day, count }) => (
                  <div key={day} className="flex-1 flex flex-col items-center" title={`${day}: ${count}`}>
                    <div
                      className="w-full bg-[#D4AF37]/60 rounded-t-sm min-h-0.5"
                      style={{ height: `${(count / maxActivity) * 52}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[9px] text-[#AAAAAA]">30 days ago</span>
                <span className="text-[9px] text-[#AAAAAA]">Today</span>
              </div>
            </div>
          )}

          {/* Game distribution */}
          {(overview?.game_distribution?.length ?? 0) > 0 && (
            <div className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-xl p-6">
              <h2 className="text-[#1A1A1A] font-bold mb-4">By Card Game</h2>
              <div className="space-y-2">
                {overview!.game_distribution.map(({ card_game, count }) => {
                  const total = overview!.game_distribution.reduce((a, b) => a + b.count, 0);
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div key={card_game} className="flex items-center gap-3">
                      <span className="text-sm text-[#1A1A1A] w-24 capitalize">{card_game || "Other"}</span>
                      <div className="flex-1 h-2 bg-[#E8E4DC] rounded-full overflow-hidden">
                        <div className="h-full bg-[#D4AF37] rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-[#888888] w-12 text-right">{count} ({pct}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!o?.total_graded && (
            <div className="text-center py-12 text-[#888888]">
              <Brain size={32} className="mx-auto mb-3 text-[#CCCCCC]" />
              <p className="text-sm">No grading sessions recorded yet.</p>
              <p className="text-xs mt-1">Data appears here as you grade cards and approve grades.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
