import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Project Control governance implementation", () => {
  it("mounts only GET routes under Super Admin and feature-flag guards", () => {
    const routes = readFileSync(join(root, "server/routes/project-control.ts"), "utf8");

    expect(routes).toContain("requireSuperAdmin");
    expect(routes).toContain("requireProjectControlFlag");
    expect(routes).toContain("/api/super-admin/project-control/summary");
    expect(routes).not.toMatch(/app\.(post|put|patch|delete)\(/);
    expect(routes).toContain("snapshotOrUnavailable");
    expect(routes).toContain("Project Control temporarily unavailable");
  });

  it("keeps scanner access fixed, bounded, and free of raw diagnostic payloads", () => {
    const scanner = readFileSync(join(root, "server/project-control/scanners.ts"), "utf8");

    expect(scanner).toContain('execFileAsync("git"');
    expect(scanner).toContain("timeout: 5000");
    expect(scanner).toContain("MAX_DEPLOYMENT_RESPONSE_BYTES");
    expect(scanner).toContain("safePayload");
    expect(scanner).toContain("safeLocator");
    expect(scanner).not.toMatch(/exec\s*\(/);
    expect(scanner).not.toContain("error?.message");
  });

  it("uses migration 0020 to avoid G6D 0019 migration collision", () => {
    const migrationNames = readdirSync(join(root, "migrations")).filter((file) => /^\d{4,}_.+\.sql$/.test(file));

    expect(migrationNames).toContain("0020_project_control_dashboard.sql");
    expect(migrationNames).not.toContain("0019_project_control_dashboard.sql");
  });

  it("documents the fail-closed feature flag in MEGS v1.1", () => {
    const platform = readFileSync(join(root, "docs/governance/02_MintVault_Platform_Governance.md"), "utf8");

    expect(platform).toContain("super_admin_project_control_enabled");
    expect(platform).toContain("absent, false, unreadable, or errored flag state denies access");
  });

  it("makes the governance tables append-only at the database boundary", () => {
    const migration = readFileSync(join(root, "migrations/0020_project_control_dashboard.sql"), "utf8");

    expect(migration).toContain("project_control_reject_mutation");
    for (const table of ["project_control_evidence", "project_control_status_history", "project_control_prompt_snapshots"]) {
      expect(migration).toMatch(new RegExp(`BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table}`));
    }
  });
});
