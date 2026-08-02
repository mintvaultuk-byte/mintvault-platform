// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "../client/src/lib/project-control/api";
import { useGitHubSync } from "../client/src/hooks/project-control/use-github-sync";

const mocks = vi.hoisted(() => ({
  pcGet: vi.fn(),
  startGitHubSync: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@/lib/project-control/api", () => ({
  pcGet: (...args: unknown[]) => mocks.pcGet(...args),
  startGitHubSync: () => mocks.startGitHubSync(),
  // The hook now starts ALL FOUR evidence sources; GitHub is still the only durable run it polls.
  startEvidenceRefresh: () => mocks.startGitHubSync(),
  projectControlQueryKeys: {
    overview: ["/api/admin/project-control", "overview"],
    shopLaunch: ["/api/admin/project-control", "shop-launch"],
    // Mirrors the real key set, so invalidateQueries is never called with an undefined key —
    // which in TanStack Query invalidates the ENTIRE cache and would make these tests lie.
    composedOverview: ["/api/admin/project-control", "composed-overview"],
    syncLatest: ["/api/admin/project-control", "sync", "latest"],
    github: ["/api/admin/project-control", "github"],
    sync: (id: string) => ["/api/admin/project-control", "sync", id],
  },
}));

vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: mocks.invalidateQueries },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

declare global {
  // Test-only hook handle for exercising refresh races that a disabled button cannot trigger.
  // eslint-disable-next-line no-var
  var __projectControlRefresh: (() => void) | undefined;
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const terminalStates: SyncStatus["state"][] = [
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "CANCELLED",
  "EXPIRED",
];

function status(state: SyncStatus["state"], syncId = "sync-a"): SyncStatus {
  return {
    syncId,
    state,
    requestedAt: "2026-08-02T09:00:00.000Z",
    startedAt: "2026-08-02T09:00:01.000Z",
    completedAt: terminalStates.includes(state) ? "2026-08-02T09:00:05.000Z" : null,
    errorCode: state === "FAILED" ? "SYNC_STATUS_UNAVAILABLE" : null,
    activeSyncId: null,
    anotherRunActive: false,
  };
}

function Harness({ autoStart = true }: { autoStart?: boolean }) {
  const sync = useGitHubSync();
  globalThis.__projectControlRefresh = sync.refresh;
  useEffect(() => {
    if (autoStart) sync.refresh();
  }, [autoStart]);
  return createElement(
    "button",
    {
      type: "button",
      disabled: sync.isRefreshing,
      onClick: sync.refresh,
      "data-state": sync.status?.state ?? "idle",
      "data-error": sync.status?.errorCode ?? "",
    },
    sync.status?.state ?? "idle"
  );
}

async function mount(autoStart = true) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Harness, { autoStart })));
  });
}

const stateText = () => container.querySelector("button")?.textContent ?? "";
const button = () => container.querySelector("button")!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T09:00:00.000Z"));
  vi.resetModules();
  mocks.pcGet.mockReset();
  mocks.startGitHubSync.mockReset();
  mocks.invalidateQueries.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.__projectControlRefresh = undefined;
});

describe("Project Control GitHub sync lifecycle", () => {
  it.each(terminalStates)("polling stops on terminal %s", async (state) => {
    mocks.startGitHubSync.mockResolvedValue({ syncId: "sync-a", state: "RUNNING" });
    mocks.pcGet.mockResolvedValue(status(state));

    await mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(stateText()).toBe(state);
    const callsAtTerminal = mocks.pcGet.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });

    expect(mocks.pcGet).toHaveBeenCalledTimes(callsAtTerminal);
    if (state === "SUCCEEDED" || state === "PARTIAL") {
      expect(mocks.invalidateQueries).toHaveBeenCalled();
    }
  });

  it("polls every five seconds while non-terminal and keeps the refresh button disabled", async () => {
    mocks.startGitHubSync.mockResolvedValue({ syncId: "sync-a", state: "RUNNING" });
    mocks.pcGet.mockResolvedValueOnce(status("RUNNING")).mockResolvedValueOnce(status("SUCCEEDED"));

    await mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(button().disabled).toBe(true);
    expect(mocks.pcGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(mocks.pcGet).toHaveBeenCalledTimes(2);
    expect(stateText()).toBe("SUCCEEDED");
    expect(button().disabled).toBe(false);
  });

  it("expires after ninety seconds and clears the poller", async () => {
    mocks.startGitHubSync.mockResolvedValue({ syncId: "sync-a", state: "RUNNING" });
    mocks.pcGet.mockResolvedValue(status("RUNNING"));

    await mount();
    await act(async () => {
      await Promise.resolve();
    });
    vi.setSystemTime(new Date("2026-08-02T09:01:31.000Z"));

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(stateText()).toBe("EXPIRED");
    expect(button().dataset.error).toBe("CLIENT_TIMEOUT");
    const callsAtExpiry = mocks.pcGet.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(mocks.pcGet).toHaveBeenCalledTimes(callsAtExpiry);
  });

  it("does not set state after unmount", async () => {
    mocks.startGitHubSync.mockResolvedValue({ syncId: "sync-a", state: "RUNNING" });
    mocks.pcGet.mockResolvedValue(status("RUNNING"));

    await mount();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => root.unmount());

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });

    expect(mocks.pcGet).toHaveBeenCalledTimes(1);
  });

  it("a stale response cannot overwrite a newer refresh generation", async () => {
    let resolveOld: (value: SyncStatus) => void = () => undefined;
    mocks.startGitHubSync
      .mockResolvedValueOnce({ syncId: "sync-old", state: "RUNNING" })
      .mockResolvedValueOnce({ syncId: "sync-new", state: "RUNNING" });
    mocks.pcGet
      .mockReturnValueOnce(
        new Promise<SyncStatus>((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce(status("SUCCEEDED", "sync-new"));

    await mount();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => globalThis.__projectControlRefresh?.());
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => resolveOld(status("FAILED", "sync-old")));

    expect(stateText()).toBe("SUCCEEDED");
  });

  it("failed refresh request keeps retry available and hides raw backend errors", async () => {
    mocks.startGitHubSync.mockRejectedValue(new Error("postgres_password leaked detail"));

    await mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(stateText()).toBe("FAILED");
    expect(button().disabled).toBe(false);
    expect(container.textContent).not.toContain("postgres_password");
    expect(button().dataset.error).toBe("REFRESH_REQUEST_FAILED");
  });
});
