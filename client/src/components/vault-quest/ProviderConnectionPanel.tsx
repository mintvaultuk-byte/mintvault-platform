import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock3 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import type { ProviderConnection } from "./spend-control";
import {
  estimatedCreditsForGenerateWith,
  type VqAiProviderId,
  type VqProviderDescriptor,
} from "@shared/vq-ai-provider";

type OpsStatus = {
  provider?: ProviderConnection;
  providerRegistry?: {
    currentProvider: VqAiProviderId;
    defaultProvider: VqAiProviderId;
    availableProviders: VqProviderDescriptor[];
  };
};

const LABELS: Record<string, string> = {
  configured: "Configured — remote connection not verified",
  connected: "Connected",
  token_expiring: "Token expiring soon",
  token_expired: "Token expired",
  not_configured: "Not configured",
  disconnected: "Disconnected",
  unknown: "Status unknown",
  checking: "Checking connection",
};

function fmt(value?: string | null): string {
  if (!value) return "Not available";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "Not available";
  return d.toLocaleString();
}

function styleFor(status?: string): { box: string; text: string; icon: ReactNode } {
  if (status === "connected")
    return {
      box: "border-emerald-700/60 bg-emerald-950/15",
      text: "text-emerald-300",
      icon: <CheckCircle2 className="h-4 w-4" />,
    };
  if (status === "token_expiring")
    return { box: "border-amber-700/70 bg-amber-950/20", text: "text-amber-300", icon: <Clock3 className="h-4 w-4" /> };
  if (status === "configured" || status === "unknown" || status === "checking")
    return { box: "border-slate-700 bg-slate-900/45", text: "text-slate-300", icon: <Clock3 className="h-4 w-4" /> };
  return { box: "border-red-800/70 bg-red-950/25", text: "text-red-300", icon: <AlertCircle className="h-4 w-4" /> };
}

export function ProviderConnectionPanel({
  onStatusChange,
}: {
  onStatusChange?: (provider: ProviderConnection | null, loaded: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const status = useQuery<OpsStatus | null>({
    queryKey: ["/api/admin/vault-quest/ops/status"],
    retry: false,
  });
  const provider = status.data?.provider ?? null;
  const registry = status.data?.providerRegistry ?? null;
  const loaded = !status.isError && !!status.data && !!provider;
  const selectedProvider = registry?.currentProvider ?? "higgsfield";
  const visibleProvider =
    registry?.availableProviders.find((p) => p.id === selectedProvider && p.available) ??
    registry?.availableProviders.find((p) => p.id === "higgsfield") ??
    null;
  const estimatedNextCredits = estimatedCreditsForGenerateWith("auto", "master_portrait");
  const effective: ProviderConnection = useMemo(
    () =>
      provider ?? {
        status: status.isLoading ? "checking" : "unknown",
        generationAllowed: false,
        message: status.isLoading ? "Checking connection." : "Provider status could not be confirmed.",
        providerPathLabel: "Higgsfield OAuth / Legacy",
        remoteVerified: false,
      },
    [provider, status.isLoading]
  );
  const tone = styleFor(effective.status);
  const verify = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/vault-quest/ops/provider/test-connection", {});
      return (await res.json()) as { ok: boolean; message?: string };
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/vault-quest/ops/status"] });
      toast({
        title: data.ok ? "Provider connected" : "Provider verification failed",
        description: data.message,
        variant: data.ok ? undefined : "destructive",
      });
    },
    onError: (err) => {
      toast({
        title: "Provider verification failed",
        description: err instanceof Error ? err.message : "Try again in a moment.",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    onStatusChange?.(loaded ? effective : null, loaded);
  }, [effective, loaded, onStatusChange]);

  return (
    <div className={`rounded-xl border p-3 ${tone.box}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className={`flex items-center gap-2 text-sm font-bold ${tone.text}`}>
          {tone.icon}
          <span>AI Provider</span>
        </div>
        <button
          type="button"
          onClick={() => verify.mutate()}
          disabled={verify.isPending}
          className="rounded border border-slate-600 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:border-amber-500 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {verify.isPending ? "Verifying" : "Verify Connection"}
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Provider</div>
          <div className="font-semibold text-slate-200">
            {visibleProvider?.recommended ? "★ " : ""}
            {visibleProvider?.label ?? "Higgsfield"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Status</div>
          <div className={`font-semibold ${tone.text}`}>{LABELS[effective.status] ?? "Status unknown"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Model</div>
          <div className="font-semibold text-slate-200">Auto</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Credits</div>
          <div className="font-semibold text-slate-200">Unavailable</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Estimated next generation</div>
          <div className="font-semibold text-slate-200">≈{estimatedNextCredits} credits</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Remote verified</div>
          <div className="font-semibold text-slate-200">{effective.remoteVerified ? "Yes" : "No"}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Last successful connection</div>
          <div className="font-semibold text-slate-200">{fmt(effective.lastSuccessAt)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Last authentication failure</div>
          <div className="font-semibold text-slate-200">{fmt(effective.lastAuthFailureAt)}</div>
        </div>
      </div>
    </div>
  );
}
