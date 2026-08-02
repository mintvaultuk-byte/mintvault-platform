/**
 * Project Control — the pure seed reconciliation planner.
 *
 * WHY THIS SUITE CARRIES THE WEIGHT
 *
 * Every decision a seed reconciliation makes is taken here, over plain data, before any SQL is
 * issued. The database layer either renders this plan (dry run) or executes exactly it (apply) —
 * so a dry run and an apply cannot disagree, and testing the planner tests both.
 *
 * The properties being defended are all "the upgrade must not destroy something a human did":
 *
 *   - operator notes survive a structural upgrade;
 *   - an obsolete package is retired, never deleted;
 *   - a package the manifest does not mention is left alone rather than auto-retired;
 *   - ambiguity refuses instead of guessing a winner;
 *   - a rerun changes nothing.
 *
 * Pure. No database, no clock.
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_STATE,
  isNoOp,
  manifestDigest,
  planReconciliation,
  summarisePlan,
  type CurrentPackage,
  type CurrentState,
  type SeedManifest,
} from "@shared/project-control-seed-manifest";

function manifest(over: Partial<SeedManifest> = {}): SeedManifest {
  return {
    version: 1,
    nodes: [
      { key: "root", parentKey: null, name: "Root", description: "", sortOrder: 0 },
      { key: "area", parentKey: "root", name: "Area", description: "", sortOrder: 10 },
    ],
    packages: [
      {
        key: "pkg-a",
        nodeKey: "area",
        title: "Package A",
        summary: "s",
        risk: "low",
        classification: "A",
        businessValue: 3,
        engineeringRisk: 3,
      },
    ],
    supersessions: [],
    ...over,
  };
}

function currentPackage(over: Partial<CurrentPackage> = {}): CurrentPackage {
  return {
    key: "pkg-a",
    nodeKey: "area",
    title: "Package A",
    summary: "s",
    risk: "low",
    classification: "A",
    businessValue: 3,
    engineeringRisk: 3,
    remainingWork: "",
    tags: [],
    acceptanceCriteria: [],
    requiredTests: [],
    dependsOn: [],
    supersededAt: null,
    ...over,
  };
}

/** A database already holding exactly what the manifest describes. */
function inSyncState(m: SeedManifest = manifest()): CurrentState {
  return {
    seedVersion: m.version,
    manifestDigest: manifestDigest(m),
    nodes: m.nodes.map((n) => ({ ...n })),
    packages: m.packages.map((p) =>
      currentPackage({
        key: p.key,
        nodeKey: p.nodeKey,
        title: p.title,
        summary: p.summary,
        risk: p.risk,
        classification: p.classification,
        businessValue: p.businessValue,
        engineeringRisk: p.engineeringRisk,
        tags: p.tags ?? [],
        acceptanceCriteria: p.acceptanceCriteria ?? [],
        requiredTests: p.requiredTests ?? [],
        dependsOn: p.dependsOn ?? [],
      })
    ),
  };
}

describe("manifest digest identifies content, not time", () => {
  it("is stable across repeated calls", () => {
    expect(manifestDigest(manifest())).toBe(manifestDigest(manifest()));
  });

  it("is insensitive to declaration order", () => {
    const a = manifest();
    const b = manifest({ nodes: [...manifest().nodes].reverse() });
    expect(manifestDigest(a)).toBe(manifestDigest(b));
  });

  it("changes when any structural value changes", () => {
    const base = manifestDigest(manifest());
    expect(manifestDigest(manifest({ version: 2 }))).not.toBe(base);
    const retitled = manifest();
    retitled.packages[0].title = "Package A (renamed)";
    expect(manifestDigest(retitled)).not.toBe(base);
  });

  it("cannot be collided by a value containing the separator", () => {
    const a = manifest();
    a.packages[0].summary = "x=y";
    const b = manifest();
    b.packages[0].summary = "x";
    b.packages[0].title = "y";
    expect(manifestDigest(a)).not.toBe(manifestDigest(b));
  });
});

describe("first seed", () => {
  const plan = planReconciliation(EMPTY_STATE, manifest());

  it("is recognised as a first seed, not an upgrade", () => {
    expect(plan.mode).toBe("first_seed");
    expect(plan.seedVersionBefore).toBeNull();
  });

  it("inserts every node and package and nothing else", () => {
    expect(plan.counts.nodesInserted).toBe(2);
    expect(plan.counts.packagesInserted).toBe(1);
    expect(plan.counts.packagesUpdated).toBe(0);
    expect(plan.counts.packagesSuperseded).toBe(0);
  });

  it("is applicable and reports the expected final counts", () => {
    expect(plan.applicable).toBe(true);
    expect(plan.expectedFinalCounts).toEqual({ nodes: 2, packages: 1 });
  });
});

describe("rerun is a genuine no-op", () => {
  it("proposes no change when the database already matches", () => {
    const plan = planReconciliation(inSyncState(), manifest());
    expect(isNoOp(plan)).toBe(true);
    expect(plan.counts.nodesInserted).toBe(0);
    expect(plan.counts.packagesInserted).toBe(0);
    expect(plan.counts.packagesUpdated).toBe(0);
  });

  it("stays a no-op when JSONB has reordered object keys on the way back", () => {
    /**
     * REGRESSION. PostgreSQL JSONB does not preserve object key order: a criterion declared
     * {id, text, met, evidenceRef} is read back as {id, met, text, evidenceRef}. A key-order
     * sensitive comparison therefore reported a difference on EVERY read, so every rerun proposed
     * a phantom UPDATE on acceptanceCriteria and requiredTests for every package, forever, and no
     * reconciliation could ever be a no-op. Found by the route suite; pinned here at the cause.
     */
    const m = manifest();
    m.packages[0].acceptanceCriteria = [{ id: "a", text: "t", met: false, evidenceRef: null }];
    const state = inSyncState(m);
    // Exactly what the database hands back — same content, different key order.
    state.packages[0].acceptanceCriteria = [{ id: "a", met: false, text: "t", evidenceRef: null }];
    expect(isNoOp(planReconciliation(state, m))).toBe(true);
  });

  it("still treats a genuine ARRAY reorder as a real change", () => {
    // Order of criteria is meaningful to a reader, so reordering them IS a change to reconcile.
    const m = manifest();
    m.packages[0].acceptanceCriteria = [{ id: "a" }, { id: "b" }];
    const state = inSyncState(m);
    state.packages[0].acceptanceCriteria = [{ id: "b" }, { id: "a" }];
    expect(isNoOp(planReconciliation(state, m))).toBe(false);
  });

  it("stays a no-op when only operator-owned text differs", () => {
    // The operator wrote a note. That is THEIR field; it must not register as drift to fix.
    const state = inSyncState();
    state.packages[0].remainingWork = "Waiting on the founder to confirm pricing.";
    const plan = planReconciliation(state, manifest());
    expect(isNoOp(plan)).toBe(true);
    expect(plan.counts.packagesUpdated).toBe(0);
  });
});

describe("upgrade updates system structure only", () => {
  it("updates a renamed title", () => {
    const state = inSyncState();
    const m = manifest();
    m.version = 2;
    m.packages[0].title = "Package A (renamed)";
    const plan = planReconciliation(state, m);
    const update = plan.actions.find((a) => a.kind === "UPDATE_SYSTEM_FIELD" && a.field === "title");
    expect(update?.to).toBe("Package A (renamed)");
    expect(plan.counts.packagesUpdated).toBe(1);
  });

  it("updates changed acceptance criteria", () => {
    const state = inSyncState();
    const m = manifest();
    m.version = 2;
    m.packages[0].acceptanceCriteria = [{ id: "new", text: "A new thing must hold", met: false }];
    const plan = planReconciliation(state, m);
    expect(plan.actions.some((a) => a.kind === "UPDATE_SYSTEM_FIELD" && a.field === "acceptanceCriteria")).toBe(true);
  });

  it("PRESERVES an operator note and says so explicitly", () => {
    const state = inSyncState();
    state.packages[0].remainingWork = "Do not deploy until the founder signs off.";
    const m = manifest();
    m.version = 2;
    m.packages[0].title = "Retitled";
    m.packages[0].remainingWork = "A compiled default that must NOT win.";

    const plan = planReconciliation(state, m);

    // The title updates...
    expect(plan.actions.some((a) => a.kind === "UPDATE_SYSTEM_FIELD" && a.field === "title")).toBe(true);
    // ...and the note is explicitly protected, never updated.
    expect(plan.actions.some((a) => a.kind === "UPDATE_SYSTEM_FIELD" && a.field === "remainingWork")).toBe(false);
    const preserved = plan.actions.find((a) => a.kind === "PRESERVE_OPERATOR_FIELD" && a.field === "remainingWork");
    expect(preserved).toBeDefined();
    expect(plan.counts.operatorFieldsPreserved).toBe(1);
  });

  it("adds and removes dependencies", () => {
    const state = inSyncState();
    state.packages[0].dependsOn = ["pkg-old"];
    const m = manifest();
    m.version = 2;
    m.packages.push({
      key: "pkg-old",
      nodeKey: "area",
      title: "Old",
      summary: "",
      risk: "low",
      classification: "A",
      businessValue: 3,
      engineeringRisk: 3,
    });
    m.packages.push({
      key: "pkg-b",
      nodeKey: "area",
      title: "B",
      summary: "",
      risk: "low",
      classification: "A",
      businessValue: 3,
      engineeringRisk: 3,
    });
    m.packages[0].dependsOn = ["pkg-b"];

    const plan = planReconciliation(state, m);
    expect(plan.counts.dependenciesAdded).toBe(1);

    /**
     * DEP1 — this assertion used to read `dependenciesRemoved).toBe(1)`, pinning the defect.
     *
     * `pc_dependencies` carries no ownership column, so an edge absent from the manifest is
     * indistinguishable from one an operator recorded by hand. Reconciliation preserves it and
     * reports the preservation, rather than inferring intent from absence — the same rule it
     * already applied to packages.
     */
    expect(plan.counts.dependenciesRemoved).toBe(0);
    expect(plan.counts.dependenciesPreserved).toBe(1);
    expect(plan.actions.some((a) => a.kind === "PRESERVE_UNOWNED_DEPENDENCY")).toBe(true);
    expect(plan.actions.some((a) => a.kind === "REMOVE_DEPENDENCY")).toBe(false);
  });
});

describe("supersede, never delete", () => {
  const state: CurrentState = {
    ...inSyncState(),
    packages: [currentPackage(), currentPackage({ key: "pkg-dead", title: "Obsolete" })],
  };
  const m = manifest({
    version: 2,
    supersessions: [{ key: "pkg-dead", replacedBy: "pkg-a", reason: "Replaced by the consolidated package." }],
  });
  const plan = planReconciliation(state, m);

  it("emits SUPERSEDE, and never a delete", () => {
    const action = plan.actions.find((a) => a.kind === "SUPERSEDE" && a.targetKey === "pkg-dead");
    expect(action).toBeDefined();
    expect(action?.to).toBe("pkg-a");
    expect(action?.reason).toContain("Replaced by");
    expect(plan.counts.packagesSuperseded).toBe(1);
    // There is no delete action kind at all — retirement cannot be expressed as removal.
    expect(plan.actions.some((a) => String(a.kind).includes("DELETE"))).toBe(false);
  });

  it("is idempotent — an already-superseded package is not superseded twice", () => {
    const already: CurrentState = {
      ...state,
      packages: [currentPackage(), currentPackage({ key: "pkg-dead", supersededAt: "2026-08-01T00:00:00Z" })],
    };
    const p = planReconciliation(already, m);
    expect(p.counts.packagesSuperseded).toBe(0);
    expect(p.actions.some((a) => a.kind === "NO_CHANGE" && a.targetKey === "pkg-dead")).toBe(true);
  });

  it("warns rather than failing when the package to retire was never here", () => {
    const p = planReconciliation(EMPTY_STATE, m);
    expect(p.warnings.some((w) => w.includes("pkg-dead"))).toBe(true);
    expect(p.applicable).toBe(true);
  });
});

describe("a package the manifest does not mention is left alone", () => {
  it("warns instead of auto-retiring it", () => {
    // It may be an operator's deliberate creation. Auto-retiring would delete their intent.
    const state: CurrentState = {
      ...inSyncState(),
      packages: [currentPackage(), currentPackage({ key: "operator-created" })],
    };
    const plan = planReconciliation(state, manifest());
    expect(plan.warnings.some((w) => w.includes("operator-created"))).toBe(true);
    expect(plan.actions.some((a) => a.kind === "SUPERSEDE" && a.targetKey === "operator-created")).toBe(false);
    expect(plan.applicable).toBe(true);
  });
});

describe("conflicts refuse rather than guessing a winner", () => {
  const refuses = (m: SeedManifest, code: string, state: CurrentState = EMPTY_STATE) => {
    const plan = planReconciliation(state, m);
    expect(plan.applicable, `expected refusal for ${code}`).toBe(false);
    expect(
      plan.conflicts.some((c) => c.code === code),
      `missing conflict ${code}`
    ).toBe(true);
    return plan;
  };

  it("refuses a duplicate stable key", () => {
    const m = manifest();
    m.packages.push({ ...m.packages[0] });
    refuses(m, "duplicate_stable_key");
  });

  it("refuses a missing parent node", () => {
    const m = manifest();
    m.packages[0].nodeKey = "nowhere";
    refuses(m, "missing_parent");
  });

  it("refuses a node whose parent does not exist", () => {
    const m = manifest();
    m.nodes.push({ key: "orphan", parentKey: "ghost", name: "O", description: "", sortOrder: 99 });
    refuses(m, "missing_parent");
  });

  it("refuses a hierarchy cycle", () => {
    const m = manifest();
    m.nodes = [
      { key: "a", parentKey: "b", name: "A", description: "", sortOrder: 0 },
      { key: "b", parentKey: "a", name: "B", description: "", sortOrder: 1 },
    ];
    m.packages[0].nodeKey = "a";
    refuses(m, "cycle");
  });

  it("refuses a missing dependency target", () => {
    const m = manifest();
    m.packages[0].dependsOn = ["ghost"];
    refuses(m, "missing_dependency");
  });

  it("refuses a supersession whose replacement does not exist", () => {
    const m = manifest({ supersessions: [{ key: "pkg-a", replacedBy: "ghost", reason: "r" }] });
    refuses(m, "missing_replacement");
  });

  it("refuses a package superseding itself", () => {
    const m = manifest({ supersessions: [{ key: "pkg-a", replacedBy: "pkg-a", reason: "r" }] });
    refuses(m, "self_supersede");
  });

  it("refuses a manifest carrying a machine-owned field", () => {
    const m = manifest();
    (m.packages[0] as unknown as Record<string, unknown>).deploymentState = "production";
    const plan = refuses(m, "machine_field_in_manifest");
    expect(plan.actions.some((a) => a.kind === "REJECTED_MACHINE_FIELD" && a.field === "deploymentState")).toBe(true);
  });

  it("refuses to roll a NEWER applied version backwards", () => {
    const state: CurrentState = { ...inSyncState(), seedVersion: 9 };
    refuses(manifest({ version: 2 }), "future_version_applied", state);
  });

  it("never marks a plan applicable while any conflict exists", () => {
    const m = manifest();
    m.packages[0].nodeKey = "nowhere";
    const plan = planReconciliation(EMPTY_STATE, m);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.applicable).toBe(false);
  });
});

describe("the audit summary is bounded and leaks nothing", () => {
  it("stays within the column bound", () => {
    const plan = planReconciliation(EMPTY_STATE, manifest());
    expect(summarisePlan(plan).length).toBeLessThanOrEqual(4000);
  });

  it("truncates rather than overflowing", () => {
    const plan = planReconciliation(EMPTY_STATE, manifest());
    expect(summarisePlan(plan, 40).length).toBeLessThanOrEqual(40);
  });

  it("contains counts and digest, never operator text", () => {
    const state = inSyncState();
    state.packages[0].remainingWork = "SECRET-OPERATOR-NOTE-should-never-appear";
    const plan = planReconciliation(state, manifest({ version: 2 }));
    const summary = summarisePlan(plan);
    expect(summary).toContain("digest=");
    expect(summary).not.toContain("SECRET-OPERATOR-NOTE");
  });
});
