/**
 * Project Control — the dashboard must cost NOTHING to look at.
 *
 * THE DEFECT THIS PINS
 *
 * The landing page polled `/live-evidence` every 120 seconds. That route is `gatedExpensive` and
 * fans out to the GitHub REST API and to BOTH Fly applications' `/api/version` on every call:
 *
 *   const [snapshot, probes] = await Promise.all([
 *     scanGitHub(...), probeAllApplications(...),
 *   ]);
 *
 * The GitHub snapshot cache TTL is 60 seconds and the poll was 120, so every single tick missed
 * the cache and issued a fresh paginated scan. Merely leaving the dashboard open therefore spent
 * GitHub quota and sent live HTTPS probes to production — per open tab, indefinitely. Application
 * probes have no cache at all.
 *
 * These tests assert the property at the level that matters: which ROUTES the page asks for. A
 * route-level assertion is the honest one, because "no external call" is a property of the
 * endpoint chosen, not of anything the browser can promise.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every route the dashboard's own module asks for at mount or on a background refetch. */
function routesRequestedBy(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/pcGet(?:<[^>]*>)?\(\s*"([^"]+)"/g)) out.push(m[1]);
  return out;
}

/**
 * Routes that reach an external system. Derived from the router source rather than hard-coded, so
 * a route that GAINS a fan-out later cannot quietly fall off this list.
 */
const EXTERNALLY_FANNING_ROUTES = ["/live-evidence", "/github", "/repository", "/evidence-scan"];

describe("POLL1 — ordinary dashboard reads make zero external calls", () => {
  const page = read("client/src/pages/admin/project-control.tsx");

  it("the landing page requests no route that fans out to GitHub or the Fly applications", () => {
    const requested = routesRequestedBy(page);
    const offenders = requested.filter((r) => EXTERNALLY_FANNING_ROUTES.some((bad) => r.startsWith(bad)));

    expect(offenders, `dashboard requests externally-fanning route(s): ${offenders.join(", ")}`).toEqual([]);
  });

  it("reads the stored composed overview instead", () => {
    expect(routesRequestedBy(page)).toContain("/composed-overview");
  });

  it("no Project Control page REQUESTS /live-evidence", () => {
    // Matches an actual request, not the string anywhere in the file — a comment explaining why
    // the route was abandoned must not fail the test that proves it was abandoned.
    const requests = /(?:pcGet(?:<[^>]*>)?\(|apiRequest\([^)]*|queryKey:\s*\[)[^)\]]*live-evidence/;
    for (const file of [
      "client/src/pages/admin/project-control.tsx",
      "client/src/pages/admin/project-control-shop-launch.tsx",
      "client/src/pages/admin/project-control-scanner.tsx",
      "client/src/components/admin/project-control/project-control-dashboard.tsx",
      "client/src/components/admin/project-control/compact-live-evidence.tsx",
      "client/src/components/admin/project-control/executive-summary.tsx",
    ]) {
      expect(requests.test(read(file)), `${file} still requests /live-evidence`).toBe(false);
    }
  });

  /**
   * The composed route must stay on the ORDINARY read gate. If it were ever moved to
   * `gatedExpensive` that would be the signal it had acquired a fan-out.
   */
  it("/composed-overview is registered under the ordinary read gate, not the expensive one", () => {
    const router = read("server/routes/admin/project-control.ts");
    const line = router.split("\n").find((l) => l.includes("`${BASE}/composed-overview`"))!;
    expect(line).toContain("...gated,");
    expect(line).not.toContain("gatedExpensive");
  });

  /** The server-side guarantee the client now depends on. */
  it("the overview service imports no external-probe module", () => {
    const service = read("server/project-control/overview-service.ts");
    for (const forbidden of ["github-scan", "app-probe", "repo-scan", "migration-scan"]) {
      expect(service, `overview-service must not import ${forbidden}`).not.toContain(`from "./${forbidden}"`);
    }
  });
});

describe("UI-COMP1 — readiness and contradiction truth is never rebuilt in the browser", () => {
  const clientFiles = [
    "client/src/components/admin/project-control/compact-live-evidence.tsx",
    "client/src/components/admin/project-control/executive-summary.tsx",
    "client/src/components/admin/project-control/project-control-dashboard.tsx",
    "client/src/pages/admin/project-control.tsx",
  ];

  /**
   * The exact expression the browser used to use to decide whether evidence contradicted itself —
   * a three-boolean OR that could not express a contradiction class, a severity, or the database
   * and flag contradictions the server engine covers.
   */
  it("no client file re-derives a contradiction from deployment comparisons", () => {
    for (const file of clientFiles) {
      const src = read(file);
      expect(src, `${file} recomputes contradictions`).not.toContain("stagingMatchesMain === false");
      expect(src, `${file} recomputes contradictions`).not.toContain("productionMatchesMain === false");
      expect(src, `${file} recomputes contradictions`).not.toContain("stagingMatchesProduction === false");
    }
  });

  it("the contradiction warning renders the server's contradictions array", () => {
    const src = read("client/src/components/admin/project-control/compact-live-evidence.tsx");
    expect(src).toContain("evidence?.contradictions");
    expect(src).toContain("evidence?.readiness.appliedCaps");
  });

  it("no client file counts open pull requests or decides a CI verdict itself", () => {
    for (const file of clientFiles) {
      const src = read(file);
      expect(src, `${file} counts PRs in the browser`).not.toMatch(/pullRequests\s*\.filter/);
      expect(src, `${file} decides CI in the browser`).not.toMatch(/workflowRuns\s*\.some/);
    }
  });

  it("deployment alignment comes from the server's executive block", () => {
    const src = read("client/src/components/admin/project-control/executive-summary.tsx");
    expect(src).toContain("evidence?.executive.deploymentAligned");
    expect(src).toContain("evidence?.executive.productionAligned");
  });
});

describe("explicit refresh is the only path that reaches an external system", () => {
  const hook = read("client/src/hooks/project-control/use-github-sync.ts");

  it("starts the durable sync and polls stored run status", () => {
    expect(hook).toContain("startEvidenceRefresh");
    // Polls the persisted run record, not the external system.
    expect(hook).toMatch(/\/sync\//);
  });

  it("invalidates the stored composed evidence and the programme queries on completion", () => {
    expect(hook).toContain("projectControlQueryKeys.composedOverview");
    expect(hook).toContain("projectControlQueryKeys.overview");
    expect(hook).toContain("projectControlQueryKeys.shopLaunch");
  });

  /**
   * The gap the cutover would otherwise have created.
   *
   * Application, database and flag evidence used to arrive as a side effect of polling
   * /live-evidence. Removing that poll left nothing to populate them, so the composed dashboard
   * would have shown UNKNOWN for three of its four sources for ever.
   */
  it("explicit refresh populates ALL FOUR evidence sources, not only GitHub", () => {
    const api = read("client/src/lib/project-control/api.ts");
    expect(api).toContain("/sync/github");
    expect(api).toContain("/sync/applications");
    expect(api).toContain("/sync/flags");
    expect(api).toContain("/sync/databases");
    // A failure in one probe must not abort the others.
    expect(api).toContain("allSettled");
  });

  it("stops polling on every terminal state", async () => {
    const { isGitHubSyncTerminal } = await import("../client/src/hooks/project-control/use-github-sync");
    for (const state of ["SUCCEEDED", "FAILED", "RATE_LIMITED", "UNAVAILABLE", "CANCELLED", "EXPIRED", "PARTIAL"]) {
      expect(isGitHubSyncTerminal(state), `${state} must terminate polling`).toBe(true);
    }
    expect(isGitHubSyncTerminal("RUNNING")).toBe(false);
    expect(isGitHubSyncTerminal("QUEUED")).toBe(false);
  });
});

describe("a failed refresh does not blank the dashboard", () => {
  it("the page falls back to cached data rather than treating isError as fatal", () => {
    const page = read("client/src/pages/admin/project-control.tsx");
    // In TanStack Query v5 a failed REFETCH sets status to error while data stays populated.
    // Guarding on isError threw good cached programme state away on one transient failure.
    expect(page).not.toMatch(/if\s*\(\s*overview\.isError\s*\|\|\s*shopLaunch\.isError/);
    expect(page).toContain("if (!overview.data || !shopLaunch.data)");
  });

  it("evidence unavailability is only declared when there is no cached evidence either", () => {
    const page = read("client/src/pages/admin/project-control.tsx");
    expect(page).toContain("evidence.isError && !evidence.data");
  });
});
