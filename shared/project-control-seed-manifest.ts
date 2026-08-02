/**
 * Project Control — seed manifest, digest and the pure reconciliation planner.
 *
 * WHY THE PLANNER IS PURE
 *
 * Deciding what a seed reconciliation WOULD do is the part that must never be wrong, and it is
 * also the part that is hardest to test against a live database. So the decision is made here,
 * over plain data, with no connection and no clock: `planReconciliation(current, manifest)` takes
 * a snapshot of what exists and the compiled desired structure, and returns the complete list of
 * actions plus every conflict. The database layer then either renders that plan (dry run) or
 * executes exactly it (apply).
 *
 * The consequence that matters: a dry run and an apply CANNOT disagree, because they consume the
 * same plan produced by the same function. A dry run implemented as "apply inside a transaction
 * we roll back" would issue modifying SQL, fire triggers, burn sequences and — on any code path
 * that commits early — write. This one issues no SQL at all.
 *
 * OWNERSHIP IS ENFORCED HERE, NOT BY CONVENTION
 *
 * Only STRUCTURE fields ever produce an UPDATE action. Operator fields produce an explicit
 * PRESERVE action so the report can state what was protected rather than silently omitting it,
 * and machine fields present in a manifest produce a REJECT — they are a bug in the compiled seed,
 * not an input to reconcile.
 *
 * Pure. No database, no network, no clock, no randomness.
 */
import { createHash } from "node:crypto";
import { MACHINE_FIELDS, ownerOf } from "./project-control-seed-contract";

/* ------------------------------------------------------------------------------------------ */
/* Manifest                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface ManifestNode {
  key: string;
  parentKey: string | null;
  name: string;
  description: string;
  sortOrder: number;
}

export interface ManifestPackage {
  key: string;
  nodeKey: string;
  title: string;
  summary: string;
  risk: string;
  classification: string;
  businessValue: number;
  engineeringRisk: number;
  remainingWork?: string;
  tags?: string[];
  acceptanceCriteria?: unknown[];
  requiredTests?: unknown[];
  dependsOn?: string[];
}

/**
 * A package that used to exist and no longer should.
 *
 * `replacedBy` is optional because not every retirement has a successor — some work is simply
 * dropped. When it IS set it must name a package present in the same manifest, which the planner
 * verifies rather than trusting.
 */
export interface ManifestSupersession {
  key: string;
  replacedBy: string | null;
  reason: string;
}

export interface SeedManifest {
  /** Monotonic. Bumped deliberately when the structure changes; never derived from a clock. */
  version: number;
  nodes: ManifestNode[];
  packages: ManifestPackage[];
  supersessions: ManifestSupersession[];
}

/**
 * A deterministic digest of the manifest's CONTENT.
 *
 * Key-sorted and length-prefixed so neither property order nor a value containing the separator
 * can change the result. Two structurally identical manifests always digest identically, and any
 * real change always alters it — which is what makes "has anything changed since we applied?"
 * answerable without diffing the whole database.
 *
 * The version is included: bumping the version IS a change, even if nothing else moved.
 */
export function manifestDigest(manifest: SeedManifest): string {
  const encode = (value: unknown): string => {
    if (value === null || value === undefined) return "n:";
    if (Array.isArray(value)) return `a${value.length}:[${value.map(encode).join("")}]`;
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `o${keys.length}:{${keys.map((k) => `${k.length}:${k}=${encode(obj[k])}`).join("")}}`;
    }
    const s = String(value);
    return `s${Buffer.byteLength(s, "utf8")}:${s}`;
  };

  const canonical = encode({
    version: manifest.version,
    nodes: [...manifest.nodes].sort((a, b) => a.key.localeCompare(b.key)),
    packages: [...manifest.packages].sort((a, b) => a.key.localeCompare(b.key)),
    supersessions: [...manifest.supersessions].sort((a, b) => a.key.localeCompare(b.key)),
  });

  return createHash("sha256").update(`pc-seed-manifest/v1${canonical}`, "utf8").digest("hex").slice(0, 48);
}

/* ------------------------------------------------------------------------------------------ */
/* Current database snapshot                                                                    */
/* ------------------------------------------------------------------------------------------ */

export interface CurrentNode {
  key: string;
  parentKey: string | null;
  name: string;
  description: string;
  sortOrder: number;
}

export interface CurrentPackage {
  key: string;
  nodeKey: string;
  title: string;
  summary: string;
  risk: string;
  classification: string;
  businessValue: number;
  engineeringRisk: number;
  /** Operator-owned. Present so the planner can report it preserved, never to overwrite it. */
  remainingWork: string;
  tags: string[];
  acceptanceCriteria: unknown[];
  requiredTests: unknown[];
  dependsOn: string[];
  supersededAt: string | null;
}

export interface CurrentState {
  seedVersion: number | null;
  manifestDigest: string | null;
  nodes: CurrentNode[];
  packages: CurrentPackage[];
}

export const EMPTY_STATE: CurrentState = {
  seedVersion: null,
  manifestDigest: null,
  nodes: [],
  packages: [],
};

/* ------------------------------------------------------------------------------------------ */
/* Actions and report                                                                           */
/* ------------------------------------------------------------------------------------------ */

export const RECONCILIATION_MODES = ["dry_run", "first_seed", "upgrade"] as const;
export type ReconciliationMode = (typeof RECONCILIATION_MODES)[number];

export const ACTION_KINDS = [
  "INSERT_NODE",
  "UPDATE_NODE_SYSTEM_FIELD",
  "INSERT_PACKAGE",
  "UPDATE_SYSTEM_FIELD",
  "ADD_DEPENDENCY",
  "REMOVE_DEPENDENCY",
  "SUPERSEDE",
  "PRESERVE_OPERATOR_FIELD",
  "NO_CHANGE",
  "CONFLICT",
  "REJECTED_MACHINE_FIELD",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ReconciliationAction {
  kind: ActionKind;
  targetKey: string;
  field?: string;
  from?: unknown;
  to?: unknown;
  reason?: string;
}

export interface ReconciliationConflict {
  targetKey: string;
  code: string;
  reason: string;
}

export interface ReconciliationPlan {
  mode: ReconciliationMode;
  seedVersionBefore: number | null;
  seedVersionAfter: number;
  manifestDigest: string;
  actions: ReconciliationAction[];
  conflicts: ReconciliationConflict[];
  warnings: string[];
  counts: {
    nodesInserted: number;
    nodesUpdated: number;
    packagesInserted: number;
    packagesUpdated: number;
    packagesSuperseded: number;
    dependenciesAdded: number;
    dependenciesRemoved: number;
    operatorFieldsPreserved: number;
  };
  expectedFinalCounts: { nodes: number; packages: number };
  /** Apply must refuse when false. Never true while a conflict exists. */
  applicable: boolean;
}

/** System-owned package fields the planner may propose updating. Nothing else is ever updated. */
const PACKAGE_STRUCTURE_FIELDS = [
  "nodeKey",
  "title",
  "summary",
  "risk",
  "classification",
  "businessValue",
  "engineeringRisk",
  "tags",
  "acceptanceCriteria",
  "requiredTests",
] as const;

const NODE_STRUCTURE_FIELDS = ["parentKey", "name", "description", "sortOrder"] as const;

/**
 * Structural comparison that survives a round trip through PostgreSQL.
 *
 * JSONB does not preserve object key order — it stores keys in its own order, so an acceptance
 * criterion declared `{id, text, met, evidenceRef}` comes back as `{id, met, text, evidenceRef}`.
 * A naive `JSON.stringify` comparison therefore reports a difference on every single read, which
 * meant every rerun proposed a phantom UPDATE on `acceptanceCriteria` and `requiredTests` for
 * every package, forever — and no reconciliation could ever be a no-op.
 *
 * Canonicalising by sorting keys before comparing fixes that. ARRAY order is still significant
 * and deliberately preserved: the order of acceptance criteria and required tests is meaningful
 * to a reader, so reordering them IS a real change the seed should reconcile.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
    return out;
  }
  return value;
}

function differs(a: unknown, b: unknown): boolean {
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b));
  }
  return a !== b;
}

/**
 * Decide everything, write nothing.
 *
 * FAILS CLOSED: any conflict sets `applicable: false`, and apply must honour that. The planner
 * never picks a winner when the manifest and the database disagree in a way it cannot safely
 * resolve — guessing is how an "upgrade" silently destroys an operator's decision.
 */
export function planReconciliation(current: CurrentState, manifest: SeedManifest): ReconciliationPlan {
  const actions: ReconciliationAction[] = [];
  const conflicts: ReconciliationConflict[] = [];
  const warnings: string[] = [];

  const digest = manifestDigest(manifest);
  const isFirstSeed = current.seedVersion === null && current.nodes.length === 0 && current.packages.length === 0;
  const mode: ReconciliationMode = isFirstSeed ? "first_seed" : "upgrade";

  // ---- manifest self-consistency, before anything is compared ------------------------------
  const manifestPackageKeys = new Set<string>();
  for (const p of manifest.packages) {
    if (manifestPackageKeys.has(p.key)) {
      conflicts.push({
        targetKey: p.key,
        code: "duplicate_stable_key",
        reason: `The manifest declares "${p.key}" more than once. A stable key must identify exactly one work package or reconciliation cannot tell them apart.`,
      });
    }
    manifestPackageKeys.add(p.key);
  }

  const manifestNodeKeys = new Set(manifest.nodes.map((n) => n.key));
  for (const n of manifest.nodes) {
    if (n.parentKey !== null && !manifestNodeKeys.has(n.parentKey)) {
      conflicts.push({
        targetKey: n.key,
        code: "missing_parent",
        reason: `Node "${n.key}" declares parent "${n.parentKey}", which the manifest does not contain. Inserting it would create an orphan or violate the self-referencing foreign key.`,
      });
    }
  }

  // Cycle detection over the node hierarchy.
  const parentOf = new Map(manifest.nodes.map((n) => [n.key, n.parentKey]));
  for (const n of manifest.nodes) {
    const seen = new Set<string>([n.key]);
    let cursor = parentOf.get(n.key) ?? null;
    while (cursor) {
      if (seen.has(cursor)) {
        conflicts.push({
          targetKey: n.key,
          code: "cycle",
          reason: `Node "${n.key}" is part of a parent cycle through "${cursor}". A cycle has no root, so the tree cannot be built.`,
        });
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  for (const p of manifest.packages) {
    if (!manifestNodeKeys.has(p.nodeKey)) {
      conflicts.push({
        targetKey: p.key,
        code: "missing_parent",
        reason: `Package "${p.key}" points at node "${p.nodeKey}", which the manifest does not contain.`,
      });
    }
    // Machine-owned fields must never reach a manifest. This is a bug in the compiled seed.
    for (const field of Object.keys(p)) {
      if (ownerOf(field) === "machine") {
        actions.push({
          kind: "REJECTED_MACHINE_FIELD",
          targetKey: p.key,
          field,
          reason: `"${field}" is discoverable from live evidence and must not be seeded.`,
        });
        conflicts.push({
          targetKey: p.key,
          code: "machine_field_in_manifest",
          reason: `Package "${p.key}" declares machine-owned field "${field}". Seeding it would create a stale value competing with live evidence.`,
        });
      }
    }
    for (const dep of p.dependsOn ?? []) {
      if (!manifestPackageKeys.has(dep)) {
        conflicts.push({
          targetKey: p.key,
          code: "missing_dependency",
          reason: `Package "${p.key}" depends on "${dep}", which the manifest does not contain.`,
        });
      }
    }
  }

  for (const s of manifest.supersessions) {
    if (s.replacedBy !== null && !manifestPackageKeys.has(s.replacedBy)) {
      conflicts.push({
        targetKey: s.key,
        code: "missing_replacement",
        reason: `Supersession of "${s.key}" names replacement "${s.replacedBy}", which the manifest does not contain. A dangling replacement link is worse than none.`,
      });
    }
    if (s.replacedBy === s.key) {
      conflicts.push({
        targetKey: s.key,
        code: "self_supersede",
        reason: `Package "${s.key}" cannot supersede itself.`,
      });
    }
  }

  // ---- version guard -----------------------------------------------------------------------
  if (current.seedVersion !== null && current.seedVersion > manifest.version) {
    conflicts.push({
      targetKey: "__seed__",
      code: "future_version_applied",
      reason: `This database holds seed version ${current.seedVersion}, which is NEWER than the manifest's ${manifest.version}. Applying would silently roll the structure backwards; a downgrade must be a deliberate, separate decision.`,
    });
  }

  // ---- nodes -------------------------------------------------------------------------------
  const currentNodes = new Map(current.nodes.map((n) => [n.key, n]));
  let nodesInserted = 0;
  let nodesUpdated = 0;
  for (const n of manifest.nodes) {
    const existing = currentNodes.get(n.key);
    if (!existing) {
      actions.push({ kind: "INSERT_NODE", targetKey: n.key });
      nodesInserted += 1;
      continue;
    }
    for (const field of NODE_STRUCTURE_FIELDS) {
      if (differs(existing[field], n[field])) {
        actions.push({
          kind: "UPDATE_NODE_SYSTEM_FIELD",
          targetKey: n.key,
          field,
          from: existing[field],
          to: n[field],
        });
        nodesUpdated += 1;
      }
    }
  }

  // ---- packages ----------------------------------------------------------------------------
  const currentPackages = new Map(current.packages.map((p) => [p.key, p]));
  const supersededKeys = new Set(manifest.supersessions.map((s) => s.key));
  let packagesInserted = 0;
  let packagesUpdated = 0;
  let operatorFieldsPreserved = 0;
  let dependenciesAdded = 0;
  let dependenciesRemoved = 0;

  for (const p of manifest.packages) {
    const existing = currentPackages.get(p.key);
    if (!existing) {
      actions.push({ kind: "INSERT_PACKAGE", targetKey: p.key });
      packagesInserted += 1;
      for (const dep of p.dependsOn ?? []) {
        actions.push({ kind: "ADD_DEPENDENCY", targetKey: p.key, to: dep });
        dependenciesAdded += 1;
      }
      continue;
    }

    for (const field of PACKAGE_STRUCTURE_FIELDS) {
      const desired = (p as unknown as Record<string, unknown>)[field];
      if (desired === undefined) continue;
      const actual = (existing as unknown as Record<string, unknown>)[field];
      if (differs(actual, desired)) {
        actions.push({ kind: "UPDATE_SYSTEM_FIELD", targetKey: p.key, field, from: actual, to: desired });
        packagesUpdated += 1;
      }
    }

    /**
     * Operator-owned fields are reported as PRESERVED rather than skipped silently.
     *
     * `remainingWork` is the case that matters: the manifest may carry an initial value, and on an
     * upgrade it is tempting to "refresh" it. Doing so would overwrite a human's note about their
     * own work with a compiled string. The action exists so the dry-run report can say out loud
     * what was protected.
     */
    if (existing.remainingWork && existing.remainingWork.length > 0) {
      actions.push({
        kind: "PRESERVE_OPERATOR_FIELD",
        targetKey: p.key,
        field: "remainingWork",
        reason: "Operator-owned. Reconciliation never overwrites it.",
      });
      operatorFieldsPreserved += 1;
    }

    const desiredDeps = new Set(p.dependsOn ?? []);
    const actualDeps = new Set(existing.dependsOn ?? []);
    for (const dep of desiredDeps) {
      if (!actualDeps.has(dep)) {
        actions.push({ kind: "ADD_DEPENDENCY", targetKey: p.key, to: dep });
        dependenciesAdded += 1;
      }
    }
    for (const dep of actualDeps) {
      if (!desiredDeps.has(dep)) {
        actions.push({ kind: "REMOVE_DEPENDENCY", targetKey: p.key, to: dep });
        dependenciesRemoved += 1;
      }
    }
  }

  // ---- supersessions -----------------------------------------------------------------------
  let packagesSuperseded = 0;
  for (const s of manifest.supersessions) {
    const existing = currentPackages.get(s.key);
    if (!existing) {
      // Nothing to retire. Not an error — a fresh database simply never had it.
      warnings.push(`Supersession of "${s.key}" has no effect here: no such package exists in this database.`);
      continue;
    }
    if (existing.supersededAt) {
      actions.push({ kind: "NO_CHANGE", targetKey: s.key, reason: "Already superseded." });
      continue;
    }
    actions.push({
      kind: "SUPERSEDE",
      targetKey: s.key,
      to: s.replacedBy,
      reason: s.reason,
    });
    packagesSuperseded += 1;
  }

  // A package present in the database, absent from the manifest, and NOT declared superseded is
  // ambiguous — it may be an operator's creation, or a manifest omission. Never auto-retire it.
  for (const p of current.packages) {
    if (!manifestPackageKeys.has(p.key) && !supersededKeys.has(p.key) && !p.supersededAt) {
      warnings.push(
        `Package "${p.key}" exists here but is absent from the manifest and is not declared superseded. It is left untouched — reconciliation never retires a package it was not told about, because it may have been created deliberately.`
      );
    }
  }

  if (actions.length === 0) actions.push({ kind: "NO_CHANGE", targetKey: "__manifest__", reason: "Already in sync." });

  return {
    mode,
    seedVersionBefore: current.seedVersion,
    seedVersionAfter: manifest.version,
    manifestDigest: digest,
    actions,
    conflicts,
    warnings,
    counts: {
      nodesInserted,
      nodesUpdated,
      packagesInserted,
      packagesUpdated,
      packagesSuperseded,
      dependenciesAdded,
      dependenciesRemoved,
      operatorFieldsPreserved,
    },
    expectedFinalCounts: {
      nodes: current.nodes.length + nodesInserted,
      packages: current.packages.length + packagesInserted,
    },
    applicable: conflicts.length === 0,
  };
}

/** True when the plan would change nothing. Used to prove a rerun is a genuine no-op. */
export function isNoOp(plan: ReconciliationPlan): boolean {
  return (
    plan.conflicts.length === 0 &&
    plan.actions.every((a) => a.kind === "NO_CHANGE" || a.kind === "PRESERVE_OPERATOR_FIELD")
  );
}

/** Bounded, redaction-safe one-line summary for the audit row. Never raw operator text. */
export function summarisePlan(plan: ReconciliationPlan, max = 4000): string {
  const c = plan.counts;
  const line =
    `mode=${plan.mode} v${plan.seedVersionBefore ?? "none"}->${plan.seedVersionAfter} digest=${plan.manifestDigest} ` +
    `nodes+${c.nodesInserted}/~${c.nodesUpdated} pkgs+${c.packagesInserted}/~${c.packagesUpdated} ` +
    `superseded=${c.packagesSuperseded} deps+${c.dependenciesAdded}/-${c.dependenciesRemoved} ` +
    `preserved=${c.operatorFieldsPreserved} conflicts=${plan.conflicts.length} warnings=${plan.warnings.length}`;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export { MACHINE_FIELDS };
