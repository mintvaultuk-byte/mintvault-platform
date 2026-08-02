/**
 * Project Control — the seed field-ownership contract, enforced against the real compiled seed.
 *
 * WHAT WENT WRONG, AND WHY THIS TEST IS THE FIX
 *
 * The original seed asserted delivery status as static data — `status: "built"`,
 * `deploymentState: "production"`, `declaredCompletion: 60`, `branch: "codex/…"`. Those are
 * observations, and observations go stale. The seed had ONE commit in its history: it named a
 * branch that was later declared dead, claimed a portal was unmounted while it was mounted and
 * serving, and asserted production deployment for work whose migration was not applied.
 *
 * Nothing failed when those became false. That is the actual defect — not the wrong values, but
 * that wrongness was undetectable. This suite makes it detectable at build time, before anything
 * reaches a database, which is the only point at which it is cheap.
 *
 * The rule: the seed says what EXISTS and what would prove it done. It never says how far along
 * something is, because that is discoverable and therefore owned by live evidence.
 */
import { describe, it, expect } from "vitest";
import {
  MACHINE_FIELDS,
  OPERATOR_FIELDS,
  STRUCTURE_FIELDS,
  ownerOf,
  seedMayDeclare,
  seedMayReconcile,
  validateSeedRecords,
} from "@shared/project-control-seed-contract";
import { NODES, PACKAGES } from "../server/project-control/seed-data";
import { LAUNCH_GATE_KEYS } from "@shared/project-control-launch";

describe("the ownership contract itself is coherent", () => {
  it("classifies every field into exactly one owner", () => {
    const all = [...STRUCTURE_FIELDS, ...OPERATOR_FIELDS, ...MACHINE_FIELDS];
    expect(new Set(all).size, "a field appears under two owners").toBe(all.length);
  });

  it("lets seed reconciliation write structure, and nothing else", () => {
    for (const f of STRUCTURE_FIELDS) expect(seedMayReconcile(f), `${f} should be reconcilable`).toBe(true);
    for (const f of MACHINE_FIELDS) expect(seedMayReconcile(f), `${f} must NOT be reconcilable`).toBe(false);
    for (const f of OPERATOR_FIELDS) expect(seedMayReconcile(f), `${f} must NOT be reconcilable`).toBe(false);
  });

  it("permits remainingWork as an initial value but never as a reconciled one", () => {
    // The seed may suggest a starting note; once an operator edits it, it is their record and an
    // upgrade must not replace it with a compiled string.
    expect(seedMayDeclare("remainingWork")).toBe(true);
    expect(seedMayReconcile("remainingWork")).toBe(false);
  });

  it("refuses to declare any machine-owned field", () => {
    for (const f of MACHINE_FIELDS) expect(seedMayDeclare(f), `${f} must not be declarable`).toBe(false);
  });

  it("treats an unclassified field as a violation rather than silently allowing it", () => {
    expect(ownerOf("somethingNobodyClassified")).toBeNull();
    const v = validateSeedRecords([{ key: "x", somethingNobodyClassified: 1 }]);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toContain("not classified");
  });
});

describe("THE COMPILED SEED CONTAINS NO MACHINE-DERIVED TRUTH", () => {
  it("declares no machine-owned field on any work package", () => {
    const violations = validateSeedRecords(PACKAGES as unknown as { key: string }[]);
    const detail = violations.map((v) => `${v.packageKey}.${v.field}: ${v.reason}`).join("\n");
    expect(violations, `seed declares machine-derived truth:\n${detail}`).toEqual([]);
  });

  it("declares no machine-owned field on any programme node", () => {
    const violations = validateSeedRecords(NODES as unknown as { key: string }[]);
    expect(violations).toEqual([]);
  });

  // Named individually so a failure says exactly which stale claim came back.
  for (const field of MACHINE_FIELDS) {
    it(`never seeds "${field}"`, () => {
      const offenders = (PACKAGES as unknown as Record<string, unknown>[])
        .filter((p) => p[field] !== undefined)
        .map((p) => p.key);
      expect(offenders, `${field} is seeded on: ${offenders.join(", ")}`).toEqual([]);
    });
  }

  it("carries no commit SHA anywhere in the seed", () => {
    const text = JSON.stringify(PACKAGES) + JSON.stringify(NODES);
    // 7+ hex chars bounded by non-hex — the shape of an abbreviated or full git SHA.
    expect(text).not.toMatch(/\b[0-9a-f]{7,40}\b/);
  });
});

describe("the specific false claims that shipped are gone", () => {
  const text = JSON.stringify(PACKAGES);

  it("no longer names the dead RBAC branch", () => {
    // codex/partner-auth-invitations-rbac was declared dead: its 0020 shape-conflicts with the
    // merged 0031. The seed tracked it as the live branch for Partner RBAC.
    expect(text).not.toContain("codex/partner-auth-invitations-rbac");
  });

  it("no longer claims the Partner Portal is unmounted", () => {
    expect(text).not.toContain("currently unmounted");
  });

  it("no longer gates Catalogue Manager on a migration that is already applied", () => {
    expect(text).not.toContain("Founder gate to apply the catalogue migration");
  });

  it("names no git branch at all — branches are discovered, not declared", () => {
    expect(text).not.toMatch(/\b(codex|psp|feature|fix|integration)\/[a-z0-9-]+/i);
  });
});

describe("what the seed DOES still carry is structure", () => {
  it("keeps every work package and node", () => {
    expect(PACKAGES.length).toBeGreaterThan(0);
    expect(NODES.length).toBeGreaterThan(0);
  });

  it("keeps stable keys, titles and hierarchy", () => {
    for (const p of PACKAGES) {
      expect(p.key, "every package needs a stable key").toBeTruthy();
      expect(p.title, `${p.key} needs a title`).toBeTruthy();
      expect(p.nodeKey, `${p.key} needs a parent node`).toBeTruthy();
    }
  });

  it("keeps acceptance criteria — what would PROVE a package done", () => {
    // This is the half of the seed that must survive: the requirements category is only
    // measurable if the criteria exist.
    const withCriteria = PACKAGES.filter((p) => (p.acceptanceCriteria?.length ?? 0) > 0);
    expect(withCriteria.length).toBeGreaterThan(0);
  });

  it("keeps every stable key unique", () => {
    const keys = PACKAGES.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    const nodeKeys = NODES.map((n) => n.key);
    expect(new Set(nodeKeys).size).toBe(nodeKeys.length);
  });

  it("keeps every package's parent node resolvable — no orphans", () => {
    const nodeKeys = new Set(NODES.map((n) => n.key));
    for (const p of PACKAGES) {
      expect(nodeKeys.has(p.nodeKey), `${p.key} points at missing node ${p.nodeKey}`).toBe(true);
    }
  });

  it("keeps the ten Partner launch gates as real nodes", () => {
    const nodeKeys = new Set(NODES.map((n) => n.key));
    for (const gate of LAUNCH_GATE_KEYS) expect(nodeKeys.has(gate), `${gate} missing`).toBe(true);
  });

  it("keeps the permanent backlog present and outside the launch sequence", () => {
    expect(NODES.some((n) => n.key === "pn-backlog")).toBe(true);
    expect(LAUNCH_GATE_KEYS as readonly string[]).not.toContain("pn-backlog");
  });
});
