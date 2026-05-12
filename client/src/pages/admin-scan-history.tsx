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
  if (g == null) return "text-[#888888]";
  if (g >= 10) return "text-[#D4AF37]";
  if (g >= 8) return "text-[#16A34A]";
  if (g >= 6) return "text-[#CA8A04]";
  return "text-[#DC2626]";
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AdminScanHistory() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data, isLoading } = useQuery<ScanHistoryResponse>({
    queryKey: ["/api/admin/scan-history", page, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page) });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/admin/scan-history?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    refetchInterval: 15000,
  });

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ScanLine className="w-5 h-5 text-[#D4AF37]" />
          <h2 className="text-lg font-bold text-[#1A1A1A] tracking-tight">Scan History</h2>
          {data && <span className="text-xs text-[#888888]">{data.total} scans</span>}
        </div>
        <div className="flex items-center gap-2">
          {["all", "graded", "pending"].map(s => (
            <button key={s} onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded transition-colors ${
                statusFilter === s ? "bg-[#D4AF37]/10 text-[#D4AF37] border border-[#D4AF37]/30" : "text-[#888888] border border-[#E8E4DC] hover:border-[#D4AF37]/30"
              }`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 text-[#D4AF37] animate-spin" />
        </div>
      )}

      {data && (
        <>
          <div className="bg-white border border-[#E8E4DC] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#F7F7F5] text-left text-[10px] uppercase tracking-wider text-[#888888]">
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
                  <tr><td colSpan={7} className="text-center py-8 text-[#888888] text-xs">No scans found</td></tr>
                )}
                {data.scans.map(s => (
                  <tr key={s.id} className="border-t border-[#E8E4DC] hover:bg-[#FAFAF8] transition-colors cursor-pointer"
                    onClick={() => { window.location.hash = `grading-${s.id}`; }}>
                    <td className="px-4 py-2">
                      {s.frontImagePath ? (
                        <div className="w-10 h-14 bg-[#F7F7F5] rounded overflow-hidden">
                          <img src={`/api/admin/certificates/${s.id}/label/front?format=png&preview=1`} alt="" className="w-full h-full object-contain" />
                        </div>
                      ) : (
                        <div className="w-10 h-14 bg-[#F7F7F5] rounded flex items-center justify-center">
                          <ScanLine size={14} className="text-[#E8E4DC]" />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-[#D4AF37]">{s.certId}</td>
                    <td className="px-4 py-2">
                      <p className="text-[#1A1A1A] text-xs font-medium truncate max-w-[200px]">{s.cardName || "Pending identification"}</p>
                      {s.cardGame && <p className="text-[10px] text-[#888888]">{s.cardGame}</p>}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {s.grade != null ? (
                        <span className={`text-xl font-black ${gradeColor(s.grade)}`}>{s.grade}</span>
                      ) : s.aiDraftGrade != null ? (
                        <span className="text-sm font-bold text-[#888888]">{s.aiDraftGrade} <span className="text-[9px]">(AI)</span></span>
                      ) : (
                        <Clock size={14} className="text-[#E8E4DC] mx-auto" />
                      )}
                    </td>
                    <td className="px-4 py-2 text-center">
                      {s.centering != null ? (
                        <div className="flex items-center justify-center gap-1 text-[10px] text-[#555555]">
                          <span>C{s.centering}</span>
                          <span>Co{s.corners}</span>
                          <span>E{s.edges}</span>
                          <span>S{s.surface}</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-[#E8E4DC]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {s.grader ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-green-600">
                          <CheckCircle size={10} /> Graded
                        </span>
                      ) : s.aiDraftGrade != null ? (
                        <span className="text-[10px] text-amber-600">AI draft</span>
                      ) : (
                        <span className="text-[10px] text-[#888888]">Processing</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-[#888888]">{formatDate(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-[#888888]">Page {data.page} of {data.totalPages}</p>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                  className="p-1.5 rounded border border-[#E8E4DC] text-[#888888] hover:border-[#D4AF37] disabled:opacity-30 transition-colors">
                  <ChevronLeft size={14} />
                </button>
                <button onClick={() => setPage(p => Math.min(data.totalPages, p + 1))} disabled={page >= data.totalPages}
                  className="p-1.5 rounded border border-[#E8E4DC] text-[#888888] hover:border-[#D4AF37] disabled:opacity-30 transition-colors">
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
