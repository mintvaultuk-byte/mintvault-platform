import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { pcGet, projectControlQueryKeys, startGitHubSync, type SyncStatus } from "@/lib/project-control/api";

const TERMINAL = new Set<SyncStatus["state"]>(["SUCCEEDED", "PARTIAL", "FAILED", "RATE_LIMITED", "UNAVAILABLE", "CANCELLED", "EXPIRED"]);
const POLL_MS = 5_000;
const TIMEOUT_MS = 90_000;

/** Durable GitHub refresh; errors intentionally reduce to stable operator copy. */
export function useGitHubSync() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(0);
  const generation = useRef(0);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => stop, []);

  const invalidateEvidence = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectControlQueryKeys.overview }),
      queryClient.invalidateQueries({ queryKey: projectControlQueryKeys.shopLaunch }),
      queryClient.invalidateQueries({ queryKey: projectControlQueryKeys.liveEvidence }),
      queryClient.invalidateQueries({ queryKey: projectControlQueryKeys.github }),
    ]);
  };

  const poll = async (syncId: string, token: number) => {
    if (token !== generation.current) return;
    if (Date.now() - started.current >= TIMEOUT_MS) {
      setStatus((previous) => previous ? { ...previous, state: "EXPIRED", errorCode: "CLIENT_TIMEOUT" } : previous);
      stop();
      return;
    }
    try {
      const next = await pcGet<SyncStatus>(`/sync/${syncId}`);
      if (token !== generation.current) return;
      setStatus(next);
      if (TERMINAL.has(next.state)) {
        stop();
        if (next.state === "SUCCEEDED" || next.state === "PARTIAL") await invalidateEvidence();
        return;
      }
      timer.current = setTimeout(() => void poll(syncId, token), POLL_MS);
    } catch {
      if (token !== generation.current) return;
      setStatus((previous) => previous ? { ...previous, state: "FAILED", errorCode: "SYNC_STATUS_UNAVAILABLE" } : previous);
      stop();
    }
  };

  const refresh = useMutation({
    mutationFn: startGitHubSync,
    onSuccess: (accepted) => {
      stop();
      const token = ++generation.current;
      started.current = Date.now();
      setStatus({ syncId: accepted.syncId, state: accepted.state, requestedAt: new Date().toISOString(), startedAt: null, completedAt: null, errorCode: null, activeSyncId: null, anotherRunActive: false });
      void poll(accepted.syncId, token);
    },
    onError: () => setStatus((previous) => previous ? { ...previous, state: "FAILED", errorCode: "REFRESH_REQUEST_FAILED" } : null),
  });

  return { refresh: () => refresh.mutate(), isRefreshing: refresh.isPending || Boolean(status && !TERMINAL.has(status.state)), status };
}

export function isGitHubSyncTerminal(state: SyncStatus["state"]): boolean {
  return TERMINAL.has(state);
}
