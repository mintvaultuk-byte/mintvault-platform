/** Executive-first Project Control landing page. Server remains authoritative for readiness. */
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminShell, Panel } from "@/components/admin";
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
import type { DriftReport } from "@shared/project-control";
import type { OverviewDto } from "@shared/project-control-overview";
import "@/styles/project-control.css";

export default function ProjectControlPage() {
  const [, navigate] = useLocation();
  const overview = useQuery<ProjectControlOverview>({
    queryKey: projectControlQueryKeys.overview,
    queryFn: () => pcGet("/overview"),
    refetchInterval: 120_000,
  });
  const shopLaunch = useQuery<ShopLaunchView>({
    queryKey: projectControlQueryKeys.shopLaunch,
    queryFn: () => pcGet("/views/shop-launch"),
    refetchInterval: 120_000,
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

  if (overview.isLoading || shopLaunch.isLoading)
    return (
      <div
        className="p-8"
        data-testid="pc-loading"
        role="status"
        aria-live="polite"
        style={{ color: "var(--admin-gold)" }}
      >
        Loading Project Control…
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
  if (!overview.data || !shopLaunch.data)
    return (
      <div className="p-8" data-testid="pc-error" role="status" aria-live="polite">
        <Panel
          title="Project Control could not load"
          sub="The programme remains unavailable until its authorised service responds."
        >
          <p>Try again shortly. This message does not diagnose a migration or expose a backend error.</p>
        </Panel>
      </div>
    );
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
