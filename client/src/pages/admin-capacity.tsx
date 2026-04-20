import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw, AlertTriangle, Play, Pause, List, Save, X,
  ShieldAlert, ShieldCheck, Clock, Users, ToggleLeft, ToggleRight,
} from "lucide-react";

interface CapacityRow {
  id: number;
  tier_id: string;
  tier_slug: string;
  status: string;
  max_concurrent: number;
  max_active: number;
  force_open: boolean;
  paused_until: string | null;
  paused_message: string | null;
  paused_at: string | null;
  paused_by: string | null;
  current_queue_count: string;
}

const TIER_DISPLAY: Record<string, string> = {
  standard: "Vault Queue",
  priority: "Standard",
  express: "Express",
  gold: "Black Label Review",
  reholder: "Reholder",
  crossover: "Crossover",
  authentication: "Authentication",
};

const TIER_ORDER = ["standard", "priority", "express", "gold", "reholder", "crossover", "authentication"];

function statusBadge(row: CapacityRow) {
  const active = parseInt(row.current_queue_count || "0", 10);
  const max = row.max_concurrent || 0;

  if (row.status === "paused") {
    return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest bg-red-600/20 text-red-400 border border-red-600/40">Paused</span>;
  }
  if (row.status === "waitlist") {
    return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest bg-blue-600/20 text-blue-400 border border-blue-600/40">Waitlist</span>;
  }
  if (active >= max && !row.force_open && max > 0) {
    return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest bg-amber-600/20 text-amber-400 border border-amber-600/40">Full</span>;
  }
  return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest bg-green-600/20 text-green-400 border border-green-600/40">Open</span>;
}

export default function AdminCapacity() {
  const { toast } = useToast();
  const [editingTier, setEditingTier] = useState<string | null>(null);
  const [editMax, setEditMax] = useState("");
  const [pauseModal, setPauseModal] = useState<string | null>(null);
  const [pauseUntil, setPauseUntil] = useState("");
  const [pauseMessage, setPauseMessage] = useState("");
  const [confirmPauseAll, setConfirmPauseAll] = useState(false);

  const { data: rows = [], isLoading, refetch } = useQuery<CapacityRow[]>({
    queryKey: ["/api/admin/capacity"],
    refetchInterval: 30000,
  });

  const sorted = [...rows]
    .filter(r => r.tier_id !== "gold-elite")
    .sort((a, b) => {
      const ai = TIER_ORDER.indexOf(a.tier_id);
      const bi = TIER_ORDER.indexOf(b.tier_id);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  const updateMutation = useMutation({
    mutationFn: async ({ tierId, data }: { tierId: string; data: Record<string, unknown> }) => {
      await apiRequest("PUT", `/api/admin/capacity/${tierId}`, data);
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/capacity"] });
      toast({ title: `Capacity updated for ${TIER_DISPLAY[vars.tierId] || vars.tierId}` });
      setEditingTier(null);
      setPauseModal(null);
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const pauseAllMutation = useMutation({
    mutationFn: async (message: string) => {
      await apiRequest("POST", "/api/admin/capacity/pause-all", { message });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/capacity"] });
      toast({ title: "All tiers paused" });
      setConfirmPauseAll(false);
    },
    onError: (err: any) => {
      toast({ title: "Pause all failed", description: err.message, variant: "destructive" });
    },
  });

  const resumeAllMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/admin/capacity/resume-all", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/capacity"] });
      toast({ title: "All tiers resumed" });
    },
    onError: (err: any) => {
      toast({ title: "Resume all failed", description: err.message, variant: "destructive" });
    },
  });

  function startEdit(row: CapacityRow) {
    setEditingTier(row.tier_id);
    setEditMax(String(row.max_concurrent || 0));
  }

  function saveMax(tierId: string) {
    const val = parseInt(editMax, 10);
    if (isNaN(val) || val < 0) return;
    updateMutation.mutate({ tierId, data: { max_concurrent: val } });
  }

  function openPauseModal(tierId: string) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    setPauseUntil(tomorrow.toISOString().slice(0, 16));
    setPauseMessage("Temporarily paused for capacity management.");
    setPauseModal(tierId);
  }

  function confirmPause() {
    if (!pauseModal) return;
    updateMutation.mutate({
      tierId: pauseModal,
      data: { status: "paused", paused_until: pauseUntil || null, paused_message: pauseMessage || null },
    });
  }

  function resumeTier(tierId: string) {
    updateMutation.mutate({
      tierId,
      data: { status: "open", paused_until: null, paused_message: null },
    });
  }

  function toggleForceOpen(row: CapacityRow) {
    updateMutation.mutate({
      tierId: row.tier_id,
      data: { status: row.status, max_concurrent: row.max_concurrent },
    });
  }

  function setWaitlist(tierId: string) {
    updateMutation.mutate({
      tierId,
      data: { status: "waitlist", paused_message: "This tier is currently on a waitlist." },
    });
  }

  const anyPaused = sorted.some(r => r.status === "paused");

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#D4AF37] tracking-widest">CAPACITY MANAGEMENT</h1>
          <p className="text-[#999999] text-sm">Control submission capacity, pause tiers, and manage queue limits</p>
        </div>
        <button
          onClick={() => refetch()}
          className="text-[#D4AF37]/50 hover:text-[#D4AF37] transition-colors flex items-center gap-1.5 text-xs"
        >
          <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Emergency controls */}
      <div className="flex gap-3 mb-6">
        {!confirmPauseAll ? (
          <button
            onClick={() => setConfirmPauseAll(true)}
            className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest bg-red-600/20 text-red-400 border border-red-600/40 hover:bg-red-600/30 transition-colors flex items-center gap-1.5"
          >
            <ShieldAlert size={14} /> Pause All Tiers
          </button>
        ) : (
          <div className="flex items-center gap-2 bg-red-600/10 border border-red-600/30 rounded-lg px-4 py-2">
            <span className="text-red-400 text-xs font-bold">Pause ALL tiers?</span>
            <button
              onClick={() => pauseAllMutation.mutate("All submissions temporarily paused.")}
              className="px-3 py-1 rounded text-xs font-bold bg-red-600 text-white hover:bg-red-700 transition-colors"
              disabled={pauseAllMutation.isPending}
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmPauseAll(false)}
              className="px-3 py-1 rounded text-xs text-[#999999] hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {anyPaused && (
          <button
            onClick={() => resumeAllMutation.mutate()}
            className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-widest bg-green-600/20 text-green-400 border border-green-600/40 hover:bg-green-600/30 transition-colors flex items-center gap-1.5"
            disabled={resumeAllMutation.isPending}
          >
            <ShieldCheck size={14} /> Resume All Tiers
          </button>
        )}
      </div>

      {/* Capacity table */}
      {isLoading ? (
        <div className="text-center py-12 text-[#999999] text-sm">Loading capacity data...</div>
      ) : (
        <div className="border border-[#E8E4DC] rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#F7F7F5] border-b border-[#E8E4DC]">
                <th className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[#888888]">Tier</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[#888888]">Active</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[#888888]">Max</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[#888888]">Status</th>
                <th className="text-center px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[#888888]">Force Open</th>
                <th className="text-right px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-[#888888]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const active = parseInt(row.current_queue_count || "0", 10);
                const isEditing = editingTier === row.tier_id;
                const utilPct = row.max_concurrent > 0 ? Math.round((active / row.max_concurrent) * 100) : 0;

                return (
                  <tr key={row.tier_id} className="border-b border-[#E8E4DC] last:border-0 hover:bg-[#FAFAF8] transition-colors">
                    {/* Tier name */}
                    <td className="px-4 py-3">
                      <div className="font-semibold text-[#1A1A1A]">{TIER_DISPLAY[row.tier_id] || row.tier_id}</div>
                      {row.status === "paused" && row.paused_message && (
                        <div className="text-[10px] text-red-400 mt-0.5 max-w-[200px] truncate">{row.paused_message}</div>
                      )}
                      {row.status === "paused" && row.paused_until && (
                        <div className="text-[10px] text-[#999999] mt-0.5 flex items-center gap-1">
                          <Clock size={9} /> Until {new Date(row.paused_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        </div>
                      )}
                    </td>

                    {/* Active count */}
                    <td className="px-4 py-3 text-center">
                      <div className="flex flex-col items-center">
                        <span className={`font-bold text-base ${active > 0 ? "text-[#1A1A1A]" : "text-[#CCCCCC]"}`}>{active}</span>
                        {row.max_concurrent > 0 && (
                          <div className="w-16 h-1 bg-[#E8E4DC] rounded-full mt-1 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                utilPct >= 90 ? "bg-red-500" : utilPct >= 70 ? "bg-amber-500" : "bg-green-500"
                              }`}
                              style={{ width: `${Math.min(100, utilPct)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Max capacity — editable */}
                    <td className="px-4 py-3 text-center">
                      {isEditing ? (
                        <div className="flex items-center justify-center gap-1">
                          <input
                            type="number"
                            value={editMax}
                            onChange={e => setEditMax(e.target.value)}
                            className="w-16 border border-[#D4AF37]/40 rounded px-2 py-1 text-sm text-center bg-white focus:outline-none focus:border-[#D4AF37]"
                            min={0}
                            autoFocus
                          />
                          <button
                            onClick={() => saveMax(row.tier_id)}
                            className="text-green-500 hover:text-green-400 transition-colors"
                            disabled={updateMutation.isPending}
                          >
                            <Save size={14} />
                          </button>
                          <button
                            onClick={() => setEditingTier(null)}
                            className="text-[#999999] hover:text-[#666666] transition-colors"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(row)}
                          className="text-[#1A1A1A] font-semibold hover:text-[#D4AF37] transition-colors cursor-pointer"
                          title="Click to edit"
                        >
                          {row.max_concurrent}
                        </button>
                      )}
                    </td>

                    {/* Status badge */}
                    <td className="px-4 py-3 text-center">{statusBadge(row)}</td>

                    {/* Force open toggle */}
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => {
                          updateMutation.mutate({
                            tierId: row.tier_id,
                            data: { status: row.status },
                          });
                        }}
                        className="text-[#999999] hover:text-[#D4AF37] transition-colors inline-flex items-center gap-1"
                        title={row.force_open ? "Force open is ON — click to disable" : "Force open is OFF — click to enable"}
                      >
                        {row.force_open ? (
                          <ToggleRight size={20} className="text-[#D4AF37]" />
                        ) : (
                          <ToggleLeft size={20} />
                        )}
                      </button>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {row.status === "open" && (
                          <>
                            <button
                              onClick={() => openPauseModal(row.tier_id)}
                              className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-widest text-red-400 border border-red-600/30 hover:bg-red-600/10 transition-colors"
                            >
                              Pause
                            </button>
                            <button
                              onClick={() => setWaitlist(row.tier_id)}
                              className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-widest text-blue-400 border border-blue-600/30 hover:bg-blue-600/10 transition-colors"
                            >
                              Waitlist
                            </button>
                          </>
                        )}
                        {(row.status === "paused" || row.status === "waitlist") && (
                          <button
                            onClick={() => resumeTier(row.tier_id)}
                            className="px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-widest text-green-400 border border-green-600/30 hover:bg-green-600/10 transition-colors"
                            disabled={updateMutation.isPending}
                          >
                            Resume
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pause modal */}
      {pauseModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setPauseModal(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-[#1A1A1A] mb-1">
              Pause {TIER_DISPLAY[pauseModal] || pauseModal}
            </h3>
            <p className="text-[#999999] text-xs mb-5">New submissions for this tier will be blocked until resumed.</p>

            <div className="space-y-4">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#888888] mb-1 block">Resume at</label>
                <input
                  type="datetime-local"
                  value={pauseUntil}
                  onChange={e => setPauseUntil(e.target.value)}
                  className="w-full border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#888888] mb-1 block">Customer message</label>
                <textarea
                  value={pauseMessage}
                  onChange={e => setPauseMessage(e.target.value)}
                  rows={3}
                  className="w-full border border-[#E8E4DC] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#D4AF37] resize-none"
                  placeholder="e.g. Temporarily paused for capacity management. Resumes Monday."
                />
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={confirmPause}
                  className="flex-1 py-2.5 rounded-lg text-sm font-bold uppercase tracking-widest bg-red-600 text-white hover:bg-red-700 transition-colors"
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? "Pausing..." : "Pause Tier"}
                </button>
                <button
                  onClick={() => setPauseModal(null)}
                  className="px-6 py-2.5 rounded-lg text-sm font-bold uppercase tracking-widest text-[#999999] hover:text-[#666666] border border-[#E8E4DC] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
