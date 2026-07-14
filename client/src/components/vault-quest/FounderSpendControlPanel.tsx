import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Lock, Unlock } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  FOUNDER_GENERATION_CONTROLS,
  resolveFounderFeatureMap,
  type FounderFeatureKey,
  type FounderFeatureStatus,
} from "./spend-control";

type OpsStatus = { features: FounderFeatureStatus[] };

export function FounderSpendControlPanel({ onStatusChange }: { onStatusChange?: (flags: ReturnType<typeof resolveFounderFeatureMap>) => void }) {
  const { toast } = useToast();
  const [updating, setUpdating] = useState<FounderFeatureKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useQuery<OpsStatus | null>({
    queryKey: ["/api/admin/vault-quest/ops/status"],
    retry: false,
  });
  const flags = useMemo(
    () => resolveFounderFeatureMap(status.data?.features, !status.isError && !!status.data),
    [status.data?.features, status.isError, status.data],
  );

  useEffect(() => {
    onStatusChange?.(flags);
  }, [flags, onStatusChange]);

  async function toggle(feature: FounderFeatureKey, enabled: boolean) {
    const control = FOUNDER_GENERATION_CONTROLS.find((c) => c.feature === feature);
    setUpdating(feature);
    setError(null);
    try {
      await apiRequest("POST", `/api/admin/vault-quest/ops/feature-flags/${feature}`, {
        enabled,
        reason: `${control?.label ?? feature} set ${enabled ? "On" : "Off"} from Vault Quest founder spend-control panel`,
      });
      await status.refetch();
      toast({ title: `${control?.label ?? "Control"} ${enabled ? "On" : "Off"}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Feature update failed";
      setError(message);
      toast({ title: "Spend-control update failed", description: message, variant: "destructive" });
      await status.refetch();
    } finally {
      setUpdating(null);
    }
  }

  const loading = status.isLoading;
  const unavailable = status.isError || !status.data;
  const globalEnabled = flags.generation;

  return (
    <div className={`rounded-xl border p-3 ${globalEnabled ? "border-emerald-700/50 bg-emerald-950/10" : "border-red-800/60 bg-red-950/20"}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {globalEnabled ? <Unlock className="h-4 w-4 text-emerald-300" /> : <Lock className="h-4 w-4 text-red-300" />}
          <span className="text-[11px] font-bold uppercase tracking-widest text-slate-300">Founder spend controls</span>
        </div>
        {loading && <span className="inline-flex items-center gap-1 text-[10px] text-slate-400"><Loader2 className="h-3 w-3 animate-spin" />Loading safe state</span>}
        {unavailable && !loading && <span className="inline-flex items-center gap-1 text-[10px] text-red-300"><AlertCircle className="h-3 w-3" />Controls unavailable</span>}
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {FOUNDER_GENERATION_CONTROLS.map((control) => {
          const enabled = flags[control.feature];
          const disabled = loading || updating !== null || unavailable;
          const dominant = control.feature === "generation";
          return (
            <div key={control.feature} className={`rounded-lg border px-2.5 py-2 ${dominant ? (enabled ? "border-emerald-600 bg-emerald-950/25" : "border-red-700 bg-red-950/40") : "border-slate-800 bg-slate-950/45"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-semibold ${dominant ? (enabled ? "text-emerald-200" : "text-red-200") : "text-slate-200"}`}>{control.label}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-pressed={enabled}
                  aria-label={`${control.label}: ${enabled ? control.onLabel : control.offLabel}`}
                  onClick={() => void toggle(control.feature, !enabled)}
                  className={`min-w-20 rounded-md border px-2 py-1 text-[11px] font-bold disabled:opacity-50 ${enabled ? "border-emerald-500 bg-emerald-500/15 text-emerald-200" : "border-slate-600 bg-slate-900 text-slate-300"}`}
                >
                  {updating === control.feature ? "Saving..." : enabled ? control.onLabel : control.offLabel}
                </button>
              </div>
              {control.warning && <div className="mt-1 text-[10px] text-amber-300">{control.warning}</div>}
            </div>
          );
        })}
      </div>
      {error && <div className="mt-2 rounded border border-red-800 bg-red-950/40 px-2 py-1.5 text-[11px] text-red-200">{error}</div>}
      {!globalEnabled && <div className="mt-2 text-[11px] font-semibold text-red-200">AI Generation is Locked. Viewing stored assets, prompt editing and approvals remain available.</div>}
    </div>
  );
}
