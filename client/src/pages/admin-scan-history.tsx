import { adminFetch } from "@/lib/queryClient";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScanLine, Clock, CheckCircle, Loader2, ChevronLeft, ChevronRight } from "lucide-react";

interface ScanRow {
  id: number;
  certId: string;
  cardName: string | null;
  cardGame: string | null;
  grade: number | null;
  gradeType: string;
  labelType: string;
  centering: number | null;
  corners: number | null;
  edges: number | null;
  surface: number | null;
  aiDraftGrade: number | null;
  strengthScore: number | null;
  grader: string | null;
  frontImagePath: string | null;
  createdAt: string;
}

interface ScanHistoryResponse {
  scans: ScanRow[];
  total: number;
  page: number;
  totalPages: number;
}

function gradeColor(g: number | null): string {
  if (g == null) return "text-[var(--admin-ink-faint)]";
  if (g >= 10) return "text-[var(--admin-gold-hi)]";
  if (g >= 8) return "text-[var(--admin-green)]";
  if (g >= 6) return "text-[var(--admin-amber)]";
  return "text-[var(--admin-red)]";
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AdminScanHistory() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading } = useQuery<ScanHistoryResponse>({
    queryKey: ["/api/admin/scan-history", page, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await adminFetch(`/api/admin/scan-history?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    refetchInterval: 15000,
  });

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ScanLine className="w-5 h-5 text-[var(--admin-gold)]" />
          <h2 className="text-lg font-bold text-[var(--admin-ink)] tracking-tight">Scan History</h2>
          {data && <span className="text-xs text-[var(--admin-ink-faint)]">{data.total} scans</span>}
        </div>
        <div className="flex items-center gap-2">
          {["all", "graded", "pending"].map((s) => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
              className={`text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded transition-colors ${
                statusFilter === s
                  ? "bg-[color-mix(in_srgb,var(--admin-gold)_18%,transparent)] text-[var(--admin-gold-hi)] border border-[var(--admin-line)]"
                  : "text-[var(--admin-ink-faint)] border border-[var(--admin-line-soft)] hover:border-[color-mix(in_srgb,var(--admin-gold)_30%,transparent)]"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-[var(--admin-gold)] animate-spin" />
        </div>
      )}

      {data && (
        <>
          <div className="bg-[var(--admin-panel)] border border-[var(--admin-line)] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--admin-panel2)] text-left text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">
                  <th className="px-4 py-2 w-16">Image</th>
                  <th className="px-4 py-2">Cert</th>
                  <th className="px-4 py-2">Card</th>
                  <th className="px-4 py-2 text-center">Grade</th>
                  <th className="px-4 py-2 text-center">Subgrades</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.scans.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-8 text-[var(--admin-ink-faint)] text-xs">
                      No scans found
                    </td>
                  </tr>
                )}
                {data.scans.map((s) => (
                  <tr
                    key={s.id}
                    className="border-t border-[var(--admin-line)] hover:bg-[var(--admin-panel2)] transition-colors cursor-pointer"
                    onClick={() => {
                      window.location.hash = `grading-${s.id}`;
                    }}
                  >
                    <td className="px-4 py-2">
                      {s.frontImagePath ? (
                        <div className="w-10 h-14 bg-[var(--admin-panel2)] rounded overflow-hidden">
                          <img
                            src={`/api/admin/certificates/${s.id}/label/front?format=png&preview=1`}
                            alt=""
                            className="w-full h-full object-contain"
                          />
                        </div>
                      ) : (
                        <div className="w-10 h-14 bg-[var(--admin-panel2)] rounded flex items-center justify-center">
                          <ScanLine size={14} className="text-[var(--admin-ink-faint)]" />
                        </div>
                      )}
                    </td>
                    <td
                      className="px-4 py-2 font-mono text-xs text-[var(--admin-gold-hi)]"
                      style={{ fontFamily: "var(--admin-mono)" }}
                    >
                      {s.certId}
                    </td>
                    <td className="px-4 py-2">
                      <p className="text-[var(--admin-ink)] text-xs font-medium truncate max-w-[200px]">
                        {s.cardName || "Pending identification"}
                      </p>
                      {s.cardGame && <p className="text-[10px] text-[var(--admin-ink-faint)]">{s.cardGame}</p>}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {s.grade != null ? (
                        <span className={`text-xl font-black ${gradeColor(s.grade)}`}>{s.grade}</span>
                      ) : s.aiDraftGrade != null ? (
                        <span className="text-sm font-bold text-[var(--admin-ink-faint)]">
                          {s.aiDraftGrade} <span className="text-[9px]">(AI)</span>
                        </span>
                      ) : (
                        <Clock size={14} className="text-[var(--admin-ink-faint)] mx-auto" />
                      )}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {s.centering != null ? (
                        <div className="flex items-center justify-center gap-1 text-[10px] text-[var(--admin-ink-dim)]">
                          <span>C{s.centering}</span>
                          <span>Co{s.corners}</span>
                          <span>E{s.edges}</span>
                          <span>S{s.surface}</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-[var(--admin-ink-faint)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {s.grader ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-[var(--admin-green)]">
                          <CheckCircle size={10} /> Graded
                        </span>
                      ) : s.aiDraftGrade != null ? (
                        <span className="text-[10px] text-[var(--admin-amber)]">AI draft</span>
                      ) : (
                        <span className="text-[10px] text-[var(--admin-ink-faint)]">Processing</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-[var(--admin-ink-faint)]">{formatDate(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-[var(--admin-ink-faint)]">
                Page {data.page} of {data.totalPages}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="p-1.5 rounded border border-[var(--admin-line)] text-[var(--admin-ink-faint)] hover:border-[var(--admin-gold)] disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                  disabled={page >= data.totalPages}
                  className="p-1.5 rounded border border-[var(--admin-line)] text-[var(--admin-ink-faint)] hover:border-[var(--admin-gold)] disabled:opacity-30 transition-colors"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
