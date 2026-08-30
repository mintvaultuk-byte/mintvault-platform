import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = readFileSync("docs/runbooks/database-disaster-recovery.md", "utf8");
const normalizedRunbook = runbook.replace(/\s+/g, " ");

describe("database disaster-recovery truth boundary", () => {
  it("cannot represent the unverified provider state as release-green", () => {
    expect(runbook).toContain("Status: NOT PROVEN — EXTERNAL RELEASE GATE");
    expect(runbook).toContain("Database recovery point objective (RPO)");
    expect(runbook).toContain("Database recovery time objective (RTO)");
    expect(runbook).toMatch(/RPO[^\n]*\| UNSET/);
    expect(runbook).toMatch(/RTO[^\n]*\| UNSET/);
    expect(runbook).toContain("provider backup/PITR evidence: UNVERIFIED");
    expect(runbook).toContain("off-provider encrypted backup evidence: UNVERIFIED");
  });

  it("forbids the partial card-master CSV from becoming a false DR authority", () => {
    expect(runbook).toContain("backup-card-master");
    expect(runbook).toContain("not a disaster-recovery backup");
    expect(runbook).toContain("disposable, isolated database");
    expect(normalizedRunbook).toContain("Never overwrite a live database");
  });

  it("requires money, identity, tenant, audit, and object-integrity validation", () => {
    for (const boundary of [
      "certificate numbers and allocator state",
      "Stripe receipts",
      "credit balances",
      "tenant-isolated",
      "append-only audit",
      "byte lengths and hashes",
      "old sessions and credentials",
    ]) {
      expect(normalizedRunbook).toContain(boundary);
    }
  });
});
