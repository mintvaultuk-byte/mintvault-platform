/** Executive-first Project Control landing page. Server remains authoritative for readiness. */
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminShell, Panel, adminButtonClass } from "@/components/admin";
import { ProjectControlDashboard } from "@/components/admin/project-control/project-control-dashboard";
import {
  pcGet,
  projectControlQueryKeys,
  type LiveEvidence,
  type ProjectControlOverview,
  type ShopLaunchView,
  type SyncStatus,
} from "@/lib/project-control/api";
import { useGitHubSync } from "@/hooks/project-control/use-github-sync";
import { diagnoseLoadFailure } from "./project-control-helpers";
import type { DriftReport } from "@shared/project-control";
import type { OverviewDto } from "@shared/project-control-overview";
import "@/styles/project-control.css";

/**
 * ESSENTIAL-QUERY RETRY. Scoped to `/overview` and `/views/shop-launch` only — the two responses
 * without which there is no dashboard at all.
 *
 * WHY: the Query Client is globally `retry: false`, which is right for the rest of the admin. But
 * a Fly rolling restart takes the machine away for a few seconds, and a single failed first fetch
 * during that window left the operator on a dead failure card with no cached data and no automatic
 * recovery. Observed on staging immediately after a `fly secrets set`.
 *
 * The global default is deliberately NOT changed. Two retries, bounded backoff, and a hard stop on
 * every terminal status: a 401, 403 or 404 is an ANSWER, not an outage, and retrying it three
 * times only delays telling the operator the truth. That is what keeps this from becoming a loop.
 */
const TERMINAL_STATUSES = new Set([401, 403, 404]);
const ESSENTIAL_RETRY = {
  retry: (failureCount: number, error: unknown) => {
    const status = (error as { status?: number } | undefined)?.status;
    if (typeof status === "number" && TERMINAL_STATUSES.has(status)) return false;
    return failureCount < 2;
  },
  retryDelay: (attempt: number) => Math.min(500 * 2 ** attempt, 4_000),
} as const;

export default function ProjectControlPage() {
  const [, navigate] = useLocation();
  const overview = useQuery<ProjectControlOverview>({
    queryKey: projectControlQueryKeys.overview,
    queryFn: () => pcGet("/overview"),
    refetchInterval: 120_000,
    ...ESSENTIAL_RETRY,
  });
  const shopLaunch = useQuery<ShopLaunchView>({
    queryKey: projectControlQueryKeys.shopLaunch,
    queryFn: () => pcGet("/views/shop-launch"),
    refetchInterval: 120_000,
    ...ESSENTIAL_RETRY,
  });
  /**
   * FIX 5/6 — stored composed evidence, not the live fan-out.
   *
   * This was `/live-evidence`, which is `gatedExpensive` and calls the GitHub API AND both Fly
   * applications' /api/version on every request. At a 120-second poll — longer than the 60-second
   * GitHub snapshot cache — every single tick missed the cache, so merely leaving the dashboard
   * open spent GitHub quota and sent live probes to production, per open tab, indefinitely.
   *
   * `/composed-overview` reads persisted snapshots only and makes zero external calls. Fresh
   * evidence now arrives by explicit operator refresh, which is what the Refresh button is for.
   */
  const evidence = useQuery<OverviewDto>({
    queryKey: projectControlQueryKeys.composedOverview,
    queryFn: () => pcGet("/composed-overview"),
    refetchInterval: 120_000,
  });
  const latestSync = useQuery<SyncStatus | null>({
    queryKey: projectControlQueryKeys.syncLatest,
    queryFn: async () => {
      try {
        return await pcGet<SyncStatus>("/sync/latest");
      } catch {
        return null;
      }
    },
    retry: false,
  });
  const sync = useGitHubSync();

  /*
   * BOTH EARLY RETURNS RENDER INSIDE `.admin-root`.
   *
   * They did not, and that was the defect. `.admin-root` is applied only inside AdminShell
   * (admin-shell.tsx), and these two branches return BEFORE the shell mounts — so they landed
   * directly on `body`, which sets `background: #ffffff` and `color: #1a1a1a` (index.css).
   *
   *   - the loading line was `color: var(--admin-gold)` (#d4af37) on white  -> 2.10:1
   *   - the failure card rendered `.admin-panel` (a #16140f gradient) while its <p> inherited
   *     #1a1a1a from body                                                    -> 1.06:1
   *
   * `.admin-panel__title` and `__sub` declare their own colour, so the headline was readable and
   * the ONLY sentence explaining what to do about it was not. Both fail WCAG AA badly, and neither
   * could be caught by the existing tests: happy-dom computes no styles and vitest runs with
   * `css: false`, and the browser proof renders the fixture, which wraps everything in
   * `.admin-root` already. This is the same defect 7d7817f5 fixed in the fixture and never checked
   * in the product.
   *
   * Wrapping in `.admin-root` inherits `--admin-ink` (#e8e2d4 on the dark ground) for body copy,
   * and the loading text now uses `--admin-ink` rather than gold-on-white.
   */
  if (overview.isLoading || shopLaunch.isLoading)
    return (
      <div className="admin-root">
        <div className="p-8" data-testid="pc-loading" role="status" aria-live="polite">
          Loading Project Control…
        </div>
      </div>
    );
  /**
   * Fall back to CACHED data before declaring failure.
   *
   * This read `overview.isError || shopLaunch.isError || !data` — and in TanStack Query v5 a failed
   * REFETCH sets status to "error" while `data` stays populated from the last success. With
   * `retry: false` globally, one transient failure at a 120-second tick was enough to replace a
   * perfectly good dashboard with a total-failure screen and throw the cached programme away.
   *
   * Only a genuine absence of data is a failure now; a failed refresh over good cached data keeps
   * showing the last known good programme, which is the same discipline the evidence layer applies.
   */
  if (!overview.data || !shopLaunch.data) {
    /**
     * Say WHICH failure this is.
     *
     * This card used to be one generic sentence for every cause, so "your session expired",
     * "you are not a Super Admin", "the feature is off here" and "the server is restarting" were
     * indistinguishable — and three of those four are fixed by the operator in seconds, if only
     * they are told. `diagnoseLoadFailure` already branched on the HTTP status attached by
     * `throwIfResNotOk`; it simply was not reached from here.
     *
     * `error === null/undefined` is meaningful, not a fallback: the shared query function is
     * `on401: "returnNull"`, so an evicted session arrives as no-error-and-no-data. The helper
     * maps that to "your session has ended".
     */
    const diagnosis = diagnoseLoadFailure(overview.error ?? shopLaunch.error ?? null);
    const retrying = overview.isFetching || shopLaunch.isFetching;
    return (
      <div className="admin-root">
        <div className="p-8" data-testid={diagnosis.testId} role="status" aria-live="polite">
          <Panel title={diagnosis.headline} sub={diagnosis.detail}>
            <p>
              {retrying
                ? "Retrying automatically…"
                : "This message does not diagnose a migration and does not expose a backend error."}
            </p>
            {diagnosis.canRetry && (
              /* adminButtonClass, not a bare <button>: this carried no className at all, so it
                 rendered as a raw user-agent button on the dark panel. */
              <button
                type="button"
                className={adminButtonClass({ variant: "gold" })}
                data-testid="pc-retry"
                disabled={retrying}
                onClick={() => {
                  void overview.refetch();
                  void shopLaunch.refetch();
                }}
              >
                Try again
              </button>
            )}
          </Panel>
        </div>
      </div>
    );
  }
  if (overview.data.counts.packagesTotal === 0)
    return (
      <AdminShell
        activeTab="dashboard"
        onTabChange={() => navigate("/admin")}
        onLogout={() => navigate("/admin")}
        title="Project Control"
        crumb="Engineering programme"
      >
        <Panel
          title="No programme data yet"
          sub="The authorised programme seed has not created any Project Control packages."
        >
          <p>This is an empty programme state, not a zero readiness score.</p>
        </Panel>
      </AdminShell>
    );

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Project Control"
      crumb="Engineering programme"
    >
      <div data-testid="pc-root">
        <h1 className="sr-only">Project Control</h1>
        <DriftDisclosure drift={overview.data.drift} />
        <ProjectControlDashboard
          overview={overview.data}
          shopLaunch={shopLaunch.data}
          evidence={evidence.data}
          evidenceUnavailable={evidence.isError && !evidence.data}
          sync={sync.status ?? latestSync.data ?? null}
          onOpenPackage={(key) => navigate(`/admin/project-control/package/${key}`)}
          onRefresh={sync.refresh}
          refreshing={sync.isRefreshing}
        />
      </div>
    </AdminShell>
  );
}

function DriftDisclosure({ drift }: { drift: DriftReport }) {
  if (drift.severity === "none")
    return (
      <div className="pc-drift-none" data-testid="pc-drift-none">
        No recorded drift. This is not production verification.
      </div>
    );
  return (
    <section className="pc-drift-disclosure" data-testid="pc-drift-disclosure">
      <strong>Deployment evidence needs attention.</strong>
      <ul>
        {drift.findings.slice(0, 2).map((finding) => (
          <li key={finding.code}>{finding.message}</li>
        ))}
      </ul>
      <small>{drift.disclosure[0]}</small>
    </section>
  );
}
