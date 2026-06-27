import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";

/**
 * Phase 5 — per-operator grading stats (admin, read-only). Every figure comes
 * from GET /api/admin/operator-stats; there are NO placeholder numbers. Built
 * for the empty state first: nearly nothing is graded-by-operator yet, so the
 * page lists every operator with real zeros and a header note, and fills in as
 * grades flow. Matches the admin dark/gold styling (admin-staff.tsx).
 */

type OperatorStat = {
  id: string;
  email: string;
  displayName: string | null;
  reviewRate: number;
  graded: number;
  scanned: number;
  pending: number;
  reviewFlagged: number;
  redos: number;
  avgOperatorGrade: number | null;
  avgFinalGrade: number | null;
  gradeDistribution: Record<string, number>;
};

function fmtGrade(n: number | null): string {
  return n == null ? "—" : n.toFixed(2);
}

// operator-vs-final drift: positive = operator graded higher than the approved
// final (lenient); negative = stricter. Null when either side has no data.
function drift(op: number | null, final: number | null): { text: string; cls: string } {
  if (op == null || final == null) return { text: "—", cls: "text-[#E8E4DC]/40" };
  const d = op - final;
  if (Math.abs(d) < 0.05) return { text: "±0.00", cls: "text-[#E8E4DC]/60" };
  const sign = d > 0 ? "+" : "";
  return { text: `${sign}${d.toFixed(2)}`, cls: d > 0 ? "text-amber-400" : "text-sky-400" };
}

function GradeDist({ dist }: { dist: Record<string, number> }) {
  const entries = Object.entries(dist)
    .map(([g, n]) => [parseFloat(g), n] as [number, number])
    .filter(([g]) => Number.isFinite(g))
    .sort((a, b) => b[0] - a[0]);
  if (entries.length === 0) return <span className="text-[#E8E4DC]/40 text-xs">—</span>;
  const max = Math.max(...entries.map(([, n]) => n));
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([g, n]) => (
        <div key={g} className="flex flex-col items-center gap-0.5" title={`grade ${g}: ${n}`}>
          <div className="w-5 bg-[#D4AF37]/15 rounded-sm flex items-end" style={{ height: 28 }}>
            <div
              className="w-full bg-[#D4AF37] rounded-sm"
              style={{ height: `${Math.max(8, Math.round((n / max) * 28))}px` }}
            />
          </div>
          <span className="text-[9px] text-[#E8E4DC]/60">{g}</span>
          <span className="text-[9px] text-[#E8E4DC]/40">{n}</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">{label}</span>
      <span className="text-lg font-bold text-[#E8E4DC] leading-tight">{value}</span>
      {sub && <span className="text-[10px] text-[#E8E4DC]/40">{sub}</span>}
    </div>
  );
}

export default function AdminOperatorStatsPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [ops, setOps] = useState<OperatorStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/session", { credentials: "include" });
        const d = await res.json();
        setAuthed(res.ok && d.authenticated === true);
      } catch {
        setAuthed(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/operator-stats", { replace: true });
  }, [authed, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/operator-stats", { credentials: "include" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error || "Failed to load operator stats");
        setOps([]);
      } else {
        setOps(Array.isArray(d.operators) ? d.operators : []);
      }
    } catch (e: any) {
      setErr(e.message || "Failed to load operator stats");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  if (authed !== true) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse h-8 w-32 bg-[#D4AF37]/10 rounded" />
      </div>
    );
  }

  const anyGraded = ops.some((o) => o.graded > 0);

  return (
    <div className="min-h-screen bg-black text-[#E8E4DC] px-4 py-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-[#D4AF37] text-xl font-extrabold">Operator Stats</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/admin/staff")}
              className="text-xs border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10"
            >
              Staff
            </button>
            <button
              onClick={() => navigate("/admin")}
              className="text-xs border border-[#D4AF37]/30 rounded px-3 py-1 hover:bg-[#D4AF37]/10"
            >
              ← Admin
            </button>
          </div>
        </div>

        {err && (
          <div className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-3 py-2">{err}</div>
        )}

        {/* Empty-state note — current reality: nearly everything is assigned, not
            graded-by-operator yet. Shown until at least one operator has grades. */}
        {!loading && !anyGraded && (
          <div className="text-[#E8E4DC]/70 text-xs bg-[#D4AF37]/[0.06] border border-[#D4AF37]/20 rounded px-3 py-2.5">
            No operator grades recorded yet — stats populate as cards are graded. Every operator is listed below
            with their live scan/queue counts; graded figures fill in once operators start submitting grades.
          </div>
        )}

        {loading ? (
          <div className="animate-pulse h-24 bg-[#D4AF37]/5 rounded-lg" />
        ) : ops.length === 0 ? (
          <div className="text-[#E8E4DC]/50 text-sm border border-[#D4AF37]/20 rounded-lg p-6 text-center">
            No graders configured yet. Add a staff account with the “grade” capability on the Staff page.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {ops.map((o) => {
              const dr = drift(o.avgOperatorGrade, o.avgFinalGrade);
              return (
                <section
                  key={o.id}
                  className="border border-[#D4AF37]/20 rounded-lg p-4 space-y-3"
                  data-testid={`operator-card-${o.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-[#D4AF37] truncate">{o.displayName || o.email}</div>
                      {o.displayName && <div className="text-[11px] text-[#E8E4DC]/50 truncate">{o.email}</div>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50">Review %</div>
                      <div className="text-sm font-bold text-[#E8E4DC]">{o.reviewRate}</div>
                    </div>
                  </div>

                  {o.graded === 0 ? (
                    <div className="text-[11px] text-[#E8E4DC]/45 italic border-t border-[#D4AF37]/10 pt-2">
                      No grades yet — {o.pending} in queue, {o.scanned} scanned.
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2 border-t border-[#D4AF37]/10 pt-3">
                        <Stat label="Graded" value={o.graded} />
                        <Stat label="Scanned" value={o.scanned} />
                        <Stat label="In queue" value={o.pending} />
                        <Stat
                          label="Op avg"
                          value={fmtGrade(o.avgOperatorGrade)}
                          sub={`vs final ${fmtGrade(o.avgFinalGrade)}`}
                        />
                        <Stat label="Drift" value={<span className={dr.cls}>{dr.text}</span>} sub="op − final" />
                        <Stat
                          label="Review-flag"
                          value={`${o.graded ? Math.round((o.reviewFlagged / o.graded) * 100) : 0}%`}
                          sub={`${o.reviewFlagged}/${o.graded}`}
                        />
                      </div>
                      <div className="flex items-end justify-between gap-3 border-t border-[#D4AF37]/10 pt-3">
                        <div className="min-w-0">
                          <div className="text-[10px] uppercase tracking-wider text-[#E8E4DC]/50 mb-1">
                            Grade spread
                          </div>
                          <GradeDist dist={o.gradeDistribution} />
                        </div>
                        <Stat label="Redos" value={o.redos} />
                      </div>
                    </>
                  )}

                  {/* Always-visible footer line so even a zero operator shows live
                      scan/queue figures, not a blank card. */}
                  {o.graded === 0 && (
                    <div className="grid grid-cols-3 gap-2 border-t border-[#D4AF37]/10 pt-3">
                      <Stat label="Graded" value={0} />
                      <Stat label="Scanned" value={o.scanned} />
                      <Stat label="In queue" value={o.pending} />
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
