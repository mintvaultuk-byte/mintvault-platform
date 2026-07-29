import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("grading optimistic-concurrency contract", () => {
  it("adds a non-null integer token with an additive migration and manual rollback guidance", () => {
    const schema = read("shared/schema.ts");
    const migration = read("migrations/0025_grading_optimistic_concurrency.sql");
    const rollback = read("migrations/rollback-grading-optimistic-concurrency.sql");

    expect(schema).toContain('gradingVersion: integer("grading_version").notNull().default(1)');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS grading_version INTEGER NOT NULL DEFAULT 1");
    expect(rollback).toContain("MANUAL");
    expect(rollback).toContain("DROP COLUMN IF EXISTS grading_version");
  });

  it("uses a single stable 409 conflict envelope and a conditional incrementing update", () => {
    const concurrency = read("server/grading-concurrency.ts");
    const routes = read("server/routes.ts");
    const grader = read("server/grader.ts");
    const correction = read("server/correction-mode.ts");

    expect(concurrency).toContain('GRADING_VERSION_CONFLICT = "GRADING_VERSION_CONFLICT"');
    expect(concurrency).toContain("expectedVersion");
    expect(concurrency).toContain("currentVersion");
    expect(concurrency).toContain("reload: true");
    for (const source of [routes, grader, correction]) {
      expect(source).toContain("grading_version = grading_version + 1");
    }
    expect(routes).toContain("grading_version = ${expectedVersion}");
    expect(grader).toContain("grading_version = ${expectedVersion}");
    expect(correction).toContain("grading_version = ${input.expectedVersion}");
  });

  it("covers normal admin, restricted grader, reviewer, correction, and direct card-tool writers", () => {
    const routes = read("server/routes.ts");
    const graderRoutes = read("server/routes/grader.ts");
    const correction = read("server/correction-mode.ts");

    expect(routes).toContain('app.put("/api/admin/certificates/:id/grade"');
    expect(routes).toContain('app.put("/api/admin/certificates/:id/approve"');
    expect(routes).toContain('app.post("/api/admin/certificates/:id/manual-centering"');
    expect(graderRoutes).toContain('app.put("/api/grader/certificates/:id/grade"');
    expect(graderRoutes).toContain('app.put("/api/admin/grade-review/certificates/:id/grade"');
    expect(graderRoutes).toContain("approve-grader-grade");
    expect(graderRoutes).toContain("reject-grade");
    expect(correction).toContain('"/api/admin/certificates/:id/correction"');
  });

  it("serializes autosaves and blocks retry after a version conflict", () => {
    const panel = read("client/src/components/grading/grading-panel.tsx");
    const cardTool = read("client/src/components/grading/manual-card-tool.tsx");

    expect(panel).toContain("gradingSaveChainRef");
    expect(panel).toContain("gradingConflictRef.current = true");
    expect(panel).toContain('data-testid="grading-version-conflict"');
    expect(panel).toContain("reloadAfterGradingConflict");
    expect(cardTool).toContain("getExpectedGradingVersion");
    expect(cardTool).toContain("onGradingVersionSaved");
  });

  it("documents automated-writer boundaries and cached-client rollout", () => {
    const docs = read("docs/grading-optimistic-concurrency.md");
    expect(docs).toContain("Scan-ingest centering bootstrap");
    expect(docs).toContain("AI suggestion-only operations");
    expect(docs).toContain("GRADING_CONCURRENCY_COMPATIBILITY_MODE=true");
  });
});
