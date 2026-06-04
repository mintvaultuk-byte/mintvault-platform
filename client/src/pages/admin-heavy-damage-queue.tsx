/**
 * Heavy-damage review queue — admin list of approved certs where the
 * engine's computed grade is unreliably high because a single category's
 * RAW pre-clamp deduction blew past the -25 cap with margin
 * (HEAVY_DAMAGE_THRESHOLD in shared/mvgs-scoring.ts). The engine still
 * computes a high grade; the cap saturates and can't express the damage.
 *
 * Sourced from GET /api/admin/heavy-damage-queue (read-only — no grade
 * rewrites). Each row links into the existing admin cert page where the
 * grading panel's "Override grade" / "Reviewed — grade stands" controls
 * resolve the flag one card at a time. Human decision, never automated.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, ChevronRight } from "lucide-react";
import AdminShell from "@/components/admin/admin-shell";
import { apiRequest } from "@/lib/queryClient";

interface FlaggedCert {
  certId: string;
  certInternalId: number;
  cardName: string | null;
  setName: string | null;
  currentGrade: number | null;
  flaggedCategories: Array<{
    category: string;
    label: string;
    rawDeduction: number;
    threshold: number;
  }>;
  worstRaw: number;
}

interface QueueResponse {
  queue: FlaggedCert[];
  total: number;
}

export default function AdminHeavyDamageQueue() {
  const { data, isLoading, error } = useQuery<QueueResponse>({
    queryKey: ["/api/admin/heavy-damage-queue"],
    queryFn: () => apiRequest("GET", "/api/admin/heavy-damage-queue").then((r) => r.json()),
  });

  return (
    <AdminShell
      activeTab="grading"
      onTabChange={() => {}}
      onLogout={() => {}}
      title="Heavy-Damage Review Queue"
      crumb="MINTVAULT · INSIGHT"
    >
      <div className="p-6 space-y-4">
        <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-[var(--admin-red)] h-4 w-4" />
            <h1 className="text-base font-bold text-[var(--admin-gold-hi)]">Heavy-damage review queue</h1>
          </div>
          <p className="text-xs text-[var(--admin-ink-dim)] leading-relaxed">
            Approved certs where the engine's computed grade can't be trusted because a single category's raw pre-clamp
            deduction blows past the −25 cap by a wide margin. The cap saturates and the score reads higher than the
            card deserves. This list is READ-ONLY — click each cert to review and either override the grade or dismiss
            the flag one at a time. No automated re-grading.
          </p>
        </div>

        {isLoading && (
          <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] p-6 text-center text-sm text-[var(--admin-ink-dim)]">
            Loading queue…
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-[var(--admin-red)]/40 bg-[var(--admin-red)]/10 p-4 text-sm text-[var(--admin-red)]">
            Failed to load: {(error as Error).message}
          </div>
        )}
        {data && data.queue.length === 0 && (
          <div
            className="rounded-lg border border-[var(--admin-green)]/30 bg-[var(--admin-green)]/5 p-6 text-center text-sm text-[var(--admin-green)]"
            data-testid="queue-empty"
          >
            ✓ Queue is empty — no approved cert is currently flagged for heavy damage.
          </div>
        )}
        {data && data.queue.length > 0 && (
          <div className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] overflow-hidden">
            <div className="px-4 py-2 border-b border-[var(--admin-line)] flex items-center justify-between bg-[var(--admin-panel2)]">
              <span className="text-[10px] uppercase tracking-wider text-[var(--admin-ink-dim)]">
                {data.total} cert{data.total === 1 ? "" : "s"} flagged · sorted worst-first
              </span>
            </div>
            <ul data-testid="queue-list">
              {data.queue.map((c) => (
                <li
                  key={c.certInternalId}
                  className="border-b border-[var(--admin-line)] last:border-b-0 hover:bg-[var(--admin-panel2)]"
                >
                  <Link
                    href={`/admin/cert/${c.certInternalId}`}
                    className="flex items-center gap-4 px-4 py-3"
                    data-testid={`queue-row-${c.certId}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-[var(--admin-ink)]">{c.certId}</span>
                        {c.currentGrade != null && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--admin-gold)]/15 text-[var(--admin-gold-hi)] font-mono">
                            current grade {c.currentGrade}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--admin-ink-dim)] truncate">
                        {c.cardName || "—"}
                        {c.setName ? <span className="text-[var(--admin-ink-faint)]"> · {c.setName}</span> : null}
                      </div>
                      <div className="text-[10px] text-[var(--admin-red)] mt-1 flex flex-wrap gap-x-3">
                        {c.flaggedCategories.map((f) => (
                          <span key={f.category}>
                            {f.label} (raw {f.rawDeduction.toFixed(1)} vs cap −25)
                          </span>
                        ))}
                      </div>
                    </div>
                    <ChevronRight className="text-[var(--admin-ink-faint)] h-4 w-4 flex-shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
