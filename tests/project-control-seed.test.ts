/**
 * Project Control — seed and canonical-data suite.
 *
 * The seed is the founder-facing definition of the programme. These tests exist so the approved
 * Shop Launch sequence, the G7–G20 backlog, and the seed's honesty rules cannot drift silently.
 *
 * Pure: it imports the seed's exported data, never its database function.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVED_SHOP_LAUNCH_SEQUENCE,
  SEED_NODES,
  SEED_PACKAGES,
  orderNodesParentFirst,
} from "../server/project-control/seed-data";
import { MANDATORY_CATEGORIES, WORK_STATUSES } from "@shared/project-control";

describe("approved Shop Launch sequence", () => {
  it("is preserved exactly, in order, 1 to 10", () => {
    const launchNodes = SEED_NODES.filter((n) => n.parentKey === "partner-network" && n.key !== "pn-backlog").sort(
      (a, b) => a.sortOrder - b.sortOrder
    );
    expect(launchNodes.map((n) => n.key)).toEqual([...APPROVED_SHOP_LAUNCH_SEQUENCE]);
  });

  it("names each phase the way the founder approved it", () => {
    const byKey = new Map(SEED_NODES.map((n) => [n.key, n.name]));
    expect(byKey.get("pn-g5")).toContain("Partner Management");
    expect(byKey.get("pn-g6a")).toContain("Wallet and immutable ledger");
    expect(byKey.get("pn-g6b")).toContain("Reserve, consume and release credits");
    expect(byKey.get("pn-g6c")).toContain("Super Admin credit management");
    expect(byKey.get("pn-g6d")).toContain("Submission and grading integration");
    expect(byKey.get("pn-auth")).toContain("authentication, invitations and RBAC");
    expect(byKey.get("pn-portal")).toContain("Basic Partner Portal");
    expect(byKey.get("pn-stripe-credits")).toContain("Stripe credit packages and idempotent fulfilment");
    expect(byKey.get("pn-pilot")).toContain("Pilot with one or two shops");
    expect(byKey.get("pn-launch")).toContain("Pilot fixes and wider opening");
  });

  it("gives every launch phase a strictly increasing sort order", () => {
    const orders = APPROVED_SHOP_LAUNCH_SEQUENCE.map((key) => SEED_NODES.find((n) => n.key === key)!.sortOrder);
    for (let i = 1; i < orders.length; i++) expect(orders[i]).toBeGreaterThan(orders[i - 1]);
  });
});

describe("G7–G20 backlog", () => {
  const backlog = SEED_PACKAGES.filter((p) => p.nodeKey === "pn-backlog");

  it("carries all fourteen remaining gates as future work", () => {
    expect(backlog).toHaveLength(14);
    for (let g = 7; g <= 20; g++) {
      expect(
        backlog.some((p) => p.title.startsWith(`G${g} —`)),
        `G${g} missing`
      ).toBe(true);
    }
  });

  it("marks none of them complete, deployed or cancelled", () => {
    for (const p of backlog) {
      expect(p.status).toBe("not_started");
      expect(p.declaredCompletion).toBe(0);
      expect(p.deploymentState).toBe("not_deployed");
      expect(p.productionVerification).toBe("not_verified");
      // "superseded" would read as cancelled — the backlog is deferred, not dropped.
      expect(p.status).not.toBe("superseded");
    }
  });

  it("sits after the pilot in the tree so it cannot be mistaken for launch-blocking work", () => {
    const backlogNode = SEED_NODES.find((n) => n.key === "pn-backlog")!;
    const launchNode = SEED_NODES.find((n) => n.key === "pn-launch")!;
    expect(backlogNode.sortOrder).toBeGreaterThan(launchNode.sortOrder);
  });
});

describe("seed honesty", () => {
  it("claims no production verification anywhere", () => {
    for (const p of SEED_PACKAGES) {
      expect(p.productionVerification, p.key).not.toBe("verified");
    }
  });

  it("never declares a mandatory category non-applicable", () => {
    const source = readFileSync(join(__dirname, "..", "server/project-control/seed-data.ts"), "utf8");
    for (const category of MANDATORY_CATEGORIES) {
      expect(source).not.toContain(`${category}: "not_applicable"`);
    }
  });

  it("records seeded status only as an owner statement", () => {
    const source =
      readFileSync(join(__dirname, "..", "server/project-control/seed.ts"), "utf8") +
      readFileSync(join(__dirname, "..", "server/project-control/seed-data.ts"), "utf8");
    expect(source).toContain('kind: "owner_statement"');
    expect(source).not.toContain("automatically_verified");
    expect(source).not.toContain("verified_by_review");
  });

  it("is idempotent and never overwrites or deletes", () => {
    const source = readFileSync(join(__dirname, "..", "server/project-control/seed.ts"), "utf8");
    expect(source).toMatch(/onConflictDoNothing/);
    expect(source).not.toMatch(/onConflictDoUpdate/);
    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toMatch(/\.delete\(/);
  });

  it("uses only valid statuses and unique keys", () => {
    const keys = new Set<string>();
    for (const p of SEED_PACKAGES) {
      expect(WORK_STATUSES, p.key).toContain(p.status);
      expect(keys.has(p.key), `duplicate package key ${p.key}`).toBe(false);
      keys.add(p.key);
    }
    const nodeKeys = new Set<string>();
    for (const n of SEED_NODES) {
      expect(nodeKeys.has(n.key), `duplicate node key ${n.key}`).toBe(false);
      nodeKeys.add(n.key);
    }
  });

  it("gives every work package a node that exists", () => {
    const nodeKeys = new Set(SEED_NODES.map((n) => n.key));
    for (const p of SEED_PACKAGES) {
      expect(nodeKeys.has(p.nodeKey), `${p.key} points at missing node ${p.nodeKey}`).toBe(true);
    }
  });

  it("gives every node a parent that exists", () => {
    const nodeKeys = new Set(SEED_NODES.map((n) => n.key));
    for (const n of SEED_NODES) {
      if (n.parentKey) expect(nodeKeys.has(n.parentKey), `${n.key} points at missing parent`).toBe(true);
    }
  });

  it("orders nodes parent-first so the foreign key is always satisfiable on insert", () => {
    const ordered = orderNodesParentFirst(SEED_NODES);
    expect(ordered).toHaveLength(SEED_NODES.length);
    const seen = new Set<string>();
    for (const node of ordered) {
      if (node.parentKey) expect(seen.has(node.parentKey), `${node.key} inserted before its parent`).toBe(true);
      seen.add(node.key);
    }
  });

  it("records acceptance criteria on the highest-risk money and security work", () => {
    for (const key of ["partner-submission-credits-g6d", "partner-auth-rbac", "partner-stripe-credits"]) {
      const p = SEED_PACKAGES.find((x) => x.key === key)!;
      expect((p.acceptanceCriteria ?? []).length, key).toBeGreaterThan(0);
      for (const c of p.acceptanceCriteria ?? []) {
        // Nothing is seeded as already met — a criterion needs evidence, which a seed cannot give.
        expect(c.met, `${key}/${c.id}`).toBe(false);
        expect(c.evidenceRef ?? null).toBeNull();
      }
    }
  });
});
