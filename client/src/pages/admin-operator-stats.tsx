import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow";

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
  corrected: number;
  correctionPercentage: number;
  mostCorrectedField: string | null;
};

function fmtGrade(n: number | null): string {
  return n == null ? "—" : n.toFixed(2);
}

// operator-vs-final drift: positive = operator graded higher than the approved
// final (lenient); negative = stricter. Null when either side has no data.
function drift(op: number | null, final: number | null): { text: string; cls: string } {
  if (op == null || final == null) return { text: "—", cls: "text-[var(--admin-ink)]/40" };
  const d = op - final;
  if (Math.abs(d) < 0.05) return { text: "±0.00", cls: "text-[var(--admin-ink)]/60" };
  const sign = d > 0 ? "+" : "";
  return { text: `${sign}${d.toFixed(2)}`, cls: d > 0 ? "text-amber-400" : "text-sky-400" };
}

function GradeDist({ dist }: { dist: Record<string, number> }) {
  const entries = Object.entries(dist)
    .map(([g, n]) => [parseFloat(g), n] as [number, number])
    .filter(([g]) => Number.isFinite(g))
    .sort((a, b) => b[0] - a[0]);
  if (entries.length === 0) return <span className="text-[var(--admin-ink)]/40 text-xs">—</span>;
  const max = Math.max(...entries.map(([, n]) => n));
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([g, n]) => (
        <div key={g} className="flex flex-col items-center gap-0.5" title={`grade ${g}: ${n}`}>
          <div className="w-5 bg-[var(--admin-gold)]/15 rounded-sm flex items-end" style={{ height: 28 }}>
            <div
              className="w-full bg-[var(--admin-gold)] rounded-sm"
              style={{ height: `${Math.max(8, Math.round((n / max) * 28))}px` }}
            />
          </div>
          <span className="text-[9px] text-[var(--admin-ink)]/60">{g}</span>
          <span className="text-[9px] text-[var(--admin-ink)]/40">{n}</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-[var(--admin-ink)]/50">{label}</span>
      <span className="text-lg font-bold text-[var(--admin-ink)] leading-tight">{value}</span>
      {sub && <span className="text-[10px] text-[var(--admin-ink)]/40">{sub}</span>}
    </div>
  );
}

function labelField(field: string | null): string {
  if (!field) return "—";
  const labels: Record<string, string> = {
    cardName: "Card name",
    setName: "Set",
    year: "Year",
    cardNumber: "Card number",
    variant: "Variant",
    rarity: "Rarity",
    language: "Language",
    game: "Game",
    collection: "Collection",
    grade: "Grade",
    centering: "Centering",
    corners: "Corners",
    edges: "Edges",
    surface: "Surface",
    defects: "Defects",
    authStatus: "Auth status",
    authNotes: "Auth notes",
    gradeExplanation: "Notes",
    frontImage: "Front image",
    backImage: "Back image",
  };
  return labels[field] || field;
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
      <div className="admin-root flex min-h-screen items-center justify-center bg-[var(--admin-bg)]">
        <div className="h-8 w-32 animate-pulse rounded bg-[var(--admin-gold)]/10" />
      </div>
    );
  }

  const anyGraded = ops.some((o) => o.graded > 0);

  return (
    <div className="admin-root min-h-screen bg-[var(--admin-bg)] text-[var(--admin-ink)]">
      {/* Shared admin shell: same AdminHeaderRow header + design tokens as the
          Super Admin dashboard and the corrected Staff screens — this page
          previously ran its own standalone bg-black/var(--admin-ink) layout. */}
      <header className="border-b border-[var(--admin-line)] px-4 py-2">
        <AdminHeaderRow
          testId="operator-stats-header"
          left={<h1 className="text-sm font-extrabold tracking-wide text-[var(--admin-gold)]">Operator Stats</h1>}
          right={
            <>
              <button
                onClick={() => navigate("/admin/staff")}
                className="rounded-lg border border-[var(--admin-gold)]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/90 hover:bg-[var(--admin-gold)]/10"
              >
                Staff
              </button>
              <button
                onClick={() => navigate("/admin")}
                className="rounded-lg border border-[var(--admin-gold)]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/90 hover:bg-[var(--admin-gold)]/10"
              >
                ← Admin
              </button>
            </>
          }
        />
      </header>
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        {err && <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-400">{err}</div>}

        {/* Empty-state note — current reality: nearly everything is assigned, not
            graded-by-operator yet. Shown until at least one operator has grades. */}
        {!loading && !anyGraded && (
          <div className="text-[var(--admin-ink)]/70 text-xs bg-[var(--admin-gold)]/[0.06] border border-[var(--admin-gold)]/20 rounded px-3 py-2.5">
            No operator grades recorded yet — stats populate as cards are graded. Every operator is listed below with
            their live scan/queue counts; graded figures fill in once operators start submitting grades.
          </div>
        )}

        {loading ? (
          <div className="animate-pulse h-24 bg-[var(--admin-gold)]/5 rounded-lg" />
        ) : ops.length === 0 ? (
          <div className="text-[var(--admin-ink)]/50 text-sm border border-[var(--admin-gold)]/20 rounded-lg p-6 text-center">
            No graders configured yet. Add a staff account with the “grade” capability on the Staff page.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {ops.map((o) => {
              const dr = drift(o.avgOperatorGrade, o.avgFinalGrade);
              return (
                <section
                  key={o.id}
                  className="border border-[var(--admin-gold)]/20 rounded-lg p-4 space-y-3"
                  data-testid={`operator-card-${o.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-[var(--admin-gold)] truncate">{o.displayName || o.email}</div>
                      {o.displayName && (
                        <div className="text-[11px] text-[var(--admin-ink)]/50 truncate">{o.email}</div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-[10px] uppercase tracking-wider text-[var(--admin-ink)]/50">Review %</div>
                      <div className="text-sm font-bold text-[var(--admin-ink)]">{o.reviewRate}</div>
                    </div>
                  </div>

                  {o.graded === 0 ? (
                    <div className="text-[11px] text-[var(--admin-ink)]/45 italic border-t border-[var(--admin-gold)]/10 pt-2">
                      No grades yet — {o.pending} in queue, {o.scanned} scanned.
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-3 gap-2 border-t border-[var(--admin-gold)]/10 pt-3">
                        <Stat label="Graded" value={o.graded} />
                        <Stat label="Corrected" value={o.corrected || 0} />
                        <Stat label="Correction %" value={`${o.correctionPercentage || 0}%`} />
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
                        <Stat label="Common fix" value={labelField(o.mostCorrectedField)} />
                      </div>
                      <div className="flex items-end justify-between gap-3 border-t border-[var(--admin-gold)]/10 pt-3">
                        <div className="min-w-0">
                          <div className="text-[10px] uppercase tracking-wider text-[var(--admin-ink)]/50 mb-1">
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
                    <div className="grid grid-cols-3 gap-2 border-t border-[var(--admin-gold)]/10 pt-3">
                      <Stat label="Graded" value={0} />
                      <Stat label="Corrected" value={o.corrected || 0} />
                      <Stat label="Correction %" value={`${o.correctionPercentage || 0}%`} />
                      <Stat label="Scanned" value={o.scanned} />
                      <Stat label="In queue" value={o.pending} />
                      <Stat label="Common fix" value={labelField(o.mostCorrectedField)} />
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
