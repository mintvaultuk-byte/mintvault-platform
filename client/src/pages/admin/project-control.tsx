/** Executive-first Project Control landing page. Server remains authoritative for readiness. */
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminShell, Panel } from "@/components/admin";
import { ProjectControlDashboard } from "@/components/admin/project-control/project-control-dashboard";
import { pcGet, projectControlQueryKeys, type LiveEvidence, type ProjectControlOverview, type ShopLaunchView, type SyncStatus } from "@/lib/project-control/api";
import { useGitHubSync } from "@/hooks/project-control/use-github-sync";
import type { DriftReport } from "@shared/project-control";
import "@/styles/project-control.css";

export default function ProjectControlPage() {
  const [, navigate] = useLocation();
  const overview = useQuery<ProjectControlOverview>({ queryKey: projectControlQueryKeys.overview, queryFn: () => pcGet("/overview"), refetchInterval: 120_000 });
  const shopLaunch = useQuery<ShopLaunchView>({ queryKey: projectControlQueryKeys.shopLaunch, queryFn: () => pcGet("/views/shop-launch"), refetchInterval: 120_000 });
  const liveEvidence = useQuery<LiveEvidence>({ queryKey: projectControlQueryKeys.liveEvidence, queryFn: () => pcGet("/live-evidence"), refetchInterval: 120_000 });
  const latestSync = useQuery<SyncStatus | null>({ queryKey: projectControlQueryKeys.syncLatest, queryFn: async () => { try { return await pcGet<SyncStatus>("/sync/latest"); } catch { return null; } }, retry: false });
  const sync = useGitHubSync();

  if (overview.isLoading || shopLaunch.isLoading) return <div className="p-8" data-testid="pc-loading" role="status" aria-live="polite" style={{ color: "var(--admin-gold)" }}>Loading Project Control…</div>;
  if (overview.isError || shopLaunch.isError || !overview.data || !shopLaunch.data) return <div className="p-8" data-testid="pc-error" role="status" aria-live="polite"><Panel title="Project Control could not load" sub="The programme remains unavailable until its authorised service responds."><p>Try again shortly. This message does not diagnose a migration or expose a backend error.</p></Panel></div>;
  if (overview.data.counts.packagesTotal === 0) return <AdminShell activeTab="dashboard" onTabChange={() => navigate("/admin")} onLogout={() => navigate("/admin")} title="Project Control" crumb="Engineering programme"><Panel title="No programme data yet" sub="The authorised programme seed has not created any Project Control packages."><p>This is an empty programme state, not a zero readiness score.</p></Panel></AdminShell>;

  return <AdminShell activeTab="dashboard" onTabChange={() => navigate("/admin")} onLogout={() => navigate("/admin")} title="Project Control" crumb="Engineering programme"><main data-testid="pc-root"><DriftDisclosure drift={overview.data.drift} /><ProjectControlDashboard overview={overview.data} shopLaunch={shopLaunch.data} liveEvidence={liveEvidence.data} sync={sync.status ?? latestSync.data ?? null} onOpenPackage={(key) => navigate(`/admin/project-control/package/${key}`)} onRefresh={sync.refresh} refreshing={sync.isRefreshing} /></main></AdminShell>;
}

function DriftDisclosure({ drift }: { drift: DriftReport }) {
  if (drift.severity === "none") return <div className="pc-drift-none" data-testid="pc-drift-none">No recorded drift. This is not production verification.</div>;
  return <section className="pc-drift-disclosure" data-testid="pc-drift-disclosure"><strong>Deployment evidence needs attention.</strong><ul>{drift.findings.slice(0, 2).map((finding) => <li key={finding.code}>{finding.message}</li>)}</ul><small>{drift.disclosure[0]}</small></section>;
}
