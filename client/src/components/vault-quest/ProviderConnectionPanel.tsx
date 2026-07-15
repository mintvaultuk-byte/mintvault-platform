import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock3, Loader2, RefreshCw } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ProviderConnection } from "./spend-control";
import type { VqAiProviderId, VqProviderDescriptor } from "@shared/vq-ai-provider";

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
  if (status === "connected") return { box: "border-emerald-700/60 bg-emerald-950/15", text: "text-emerald-300", icon: <CheckCircle2 className="h-4 w-4" /> };
  if (status === "token_expiring") return { box: "border-amber-700/70 bg-amber-950/20", text: "text-amber-300", icon: <Clock3 className="h-4 w-4" /> };
  if (status === "configured" || status === "unknown" || status === "checking") return { box: "border-slate-700 bg-slate-900/45", text: "text-slate-300", icon: <Clock3 className="h-4 w-4" /> };
  return { box: "border-red-800/70 bg-red-950/25", text: "text-red-300", icon: <AlertCircle className="h-4 w-4" /> };
}

export function ProviderConnectionPanel({ onStatusChange }: { onStatusChange?: (provider: ProviderConnection | null, loaded: boolean) => void }) {
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const status = useQuery<OpsStatus | null>({
    queryKey: ["/api/admin/vault-quest/ops/status"],
    retry: false,
  });
  const provider = status.data?.provider ?? null;
  const registry = status.data?.providerRegistry ?? null;
  const loaded = !status.isError && !!status.data && !!provider;
  const selectedProvider = registry?.currentProvider ?? "higgsfield";
  const effective: ProviderConnection = useMemo(() => provider ?? {
    status: status.isLoading ? "checking" : "unknown",
    generationAllowed: false,
    message: status.isLoading ? "Checking connection." : "Provider status could not be confirmed.",
    providerPathLabel: "Higgsfield OAuth / Legacy",
    remoteVerified: false,
  }, [provider, status.isLoading]);
  const tone = styleFor(effective.status);

  useEffect(() => {
    onStatusChange?.(loaded ? effective : null, loaded);
  }, [effective, loaded, onStatusChange]);

  async function testConnection() {
    setChecking(true);
    try {
      const res = await apiRequest("POST", "/api/admin/vault-quest/ops/provider/test-connection", {});
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/vault-quest/ops/status"] });
      toast({ title: "Connection status refreshed", description: data.message ?? "Credentials are configured, but a free remote connection test is not available." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection check failed";
      toast({ title: "Connection check failed", description: message, variant: "destructive" });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/vault-quest/ops/status"] });
    } finally {
      setChecking(false);
    }
  }

  async function selectProvider(providerId: VqAiProviderId) {
    const target = registry?.availableProviders.find((p) => p.id === providerId);
    if (!target?.available || providerId === selectedProvider) return;
    if (!window.confirm(`Switch Vault Quest AI Provider to ${target.label}?\n\nThis changes only the centrally stored provider selection. Generation remains gated by the existing locks, spend controls and provider verification.`)) return;
    try {
      await apiRequest("POST", "/api/admin/vault-quest/ops/providers/select", { provider: providerId });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/vault-quest/ops/status"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/vault-quest/artwork-cost"] });
      toast({ title: "AI provider selected", description: target.label });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Provider selection failed";
      toast({ title: "Provider selection failed", description: message, variant: "destructive" });
    }
  }

  return (
    <div className={`rounded-xl border p-3 ${tone.box}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className={`flex items-center gap-2 text-sm font-bold ${tone.text}`}>
          {tone.icon}
          <span>Higgsfield Provider</span>
        </div>
        <button type="button" onClick={() => void testConnection()} disabled={checking || status.isLoading} className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:border-amber-500 disabled:opacity-50">
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Test connection
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Provider</div><div className="font-semibold text-slate-200">{registry?.availableProviders.find((p) => p.id === selectedProvider)?.label ?? "Higgsfield"}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Status</div><div className={`font-semibold ${tone.text}`}>{LABELS[effective.status] ?? "Status unknown"}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Provider path</div><div className="font-semibold text-slate-200">{effective.providerPathLabel ?? "Higgsfield OAuth / Legacy"}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Credit balance</div><div className="font-semibold text-slate-200">Unavailable</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Last checked</div><div className="font-semibold text-slate-200">{fmt(effective.lastCheckedAt)}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Token expiry</div><div className="font-semibold text-slate-200">{fmt(effective.tokenExpiryAt)}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Last successful connection</div><div className="font-semibold text-slate-200">{fmt(effective.lastSuccessAt)}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Last authentication failure</div><div className="font-semibold text-slate-200">{fmt(effective.lastAuthFailureAt)}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Remote verified</div><div className="font-semibold text-slate-200">{effective.remoteVerified ? "Yes" : "No"}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-slate-500">Generation</div><div className={`font-semibold ${effective.generationAllowed && effective.remoteVerified ? "text-emerald-300" : "text-red-300"}`}>{effective.generationAllowed && effective.remoteVerified ? "Allowed" : "Reconnect provider first"}</div></div>
      </div>
      <div className="mt-2 rounded border border-slate-800 bg-slate-950/35 px-2 py-1.5 text-[11px] text-slate-300">
        {effective.message || "Provider status could not be confirmed."}
      </div>
      <div className="mt-2 rounded border border-slate-800 bg-slate-950/35 p-2">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">AI Provider</div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {(registry?.availableProviders ?? []).map((p) => {
            const selected = p.id === selectedProvider;
            return (
              <button
                key={p.id}
                type="button"
                disabled={!p.available || selected}
                onClick={() => void selectProvider(p.id)}
                className={`rounded border px-2 py-1.5 text-left text-[11px] disabled:cursor-not-allowed ${selected ? "border-amber-500 bg-amber-500/15 text-amber-100" : p.available ? "border-slate-600 text-slate-200 hover:border-amber-500" : "border-slate-800 text-slate-600"}`}
                title={p.expectedCreditSource}
              >
                <div className="font-semibold">{p.recommended ? "★ " : ""}{p.label}{p.comingSoon ? " (Coming Soon)" : ""}</div>
                <div className="mt-0.5 text-[10px] opacity-80">{p.expectedCreditSource}</div>
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-2 grid gap-1 text-[10px] text-slate-400 sm:grid-cols-2">
        <div>Refresh the Higgsfield server-side token, then press Test connection.</div>
        <div>Generation remains locked until the connection is healthy.</div>
        <div>First live test: keep global generation Locked, enable only Action references, generate exactly one image, confirm one provider job and expected credits.</div>
        <div>Automatic paid retry should remain Off; lock generation again if anything looks abnormal.</div>
      </div>
    </div>
  );
}
