import { describe, expect, it } from "vitest";
import { evidenceStateFrom } from "../client/src/components/admin/project-control/evidence-state";
import { isGitHubSyncTerminal } from "../client/src/hooks/project-control/use-github-sync";

describe("Project Control approved hybrid UI state vocabulary", () => {
  it("keeps unknown and unavailable distinct from a successful state", () => {
    expect(evidenceStateFrom(undefined)).toBe("unknown");
    expect(evidenceStateFrom("unavailable")).toBe("unavailable");
    expect(evidenceStateFrom("fresh")).toBe("current");
  });

  it("marks stale and contradictory evidence explicitly", () => {
    expect(evidenceStateFrom("stale")).toBe("stale");
    expect(evidenceStateFrom("contradictory")).toBe("contradictory");
  });

  it("stops durable polling for every terminal GitHub state", () => {
    for (const state of ["SUCCEEDED", "PARTIAL", "FAILED", "RATE_LIMITED", "UNAVAILABLE", "CANCELLED", "EXPIRED"] as const) expect(isGitHubSyncTerminal(state)).toBe(true);
    expect(isGitHubSyncTerminal("RUNNING")).toBe(false);
    expect(isGitHubSyncTerminal("QUEUED")).toBe(false);
  });
});
