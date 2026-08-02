/**
 * Project Control — the seed field-ownership contract.
 *
 * THE PROBLEM
 *
 * The original seed asserted delivery status as static data: `status: "built"`,
 * `deploymentState: "production"`, `declaredCompletion: 60`, `branch: "codex/…"`. Every one of
 * those is a fact about the world at the moment somebody typed it, and the world moved on the
 * same afternoon. The seed had exactly one commit in its history, tracked a branch that was later
 * declared dead, and claimed a portal was unmounted while it was mounted and running.
 *
 * A dashboard whose job is to say what is true cannot be founded on a snapshot nobody updates.
 *
 * THE CONTRACT
 *
 * Every field on a work package belongs to exactly ONE owner, and the owner determines who may
 * write it:
 *
 *   STRUCTURE   — the shape of the programme. Owner decisions: what exists, what it is called,
 *                 where it sits, what it depends on, what would prove it done. The seed owns
 *                 these and may reconcile them on upgrade.
 *
 *   OPERATOR    — what a human recorded while working. Notes, manual blockers, manual evidence,
 *                 audit history. Seed reconciliation must PRESERVE these exactly; overwriting an
 *                 operator's note with a compiled default silently destroys the only record of
 *                 why something was done.
 *
 *   MACHINE     — anything discoverable from git, GitHub, the migration ledger, a deployment
 *                 record or a probe. The seed must NEVER write these, because a static value
 *                 competes with live evidence and there is no principled way to decide which
 *                 wins. Absent from the seed, they take their column default — which is the
 *                 honest answer: "not started until evidence proves otherwise."
 *
 *   HISTORICAL  — superseded records and prior audit rows. Never deleted, only marked.
 *
 * This module is the single declaration of that split, and it is enforced by a test that fails if
 * a machine-owned key ever reappears in the compiled seed.
 *
 * Pure. No database, no network, no clock.
 */

export const FIELD_OWNERS = ["structure", "operator", "machine", "historical"] as const;
export type FieldOwner = (typeof FIELD_OWNERS)[number];

/**
 * Fields the seed OWNS and may reconcile on upgrade.
 *
 * These are owner decisions, not observations. Changing one of them is a deliberate change to the
 * programme's shape, which is exactly what a seed upgrade is for.
 */
export const STRUCTURE_FIELDS = [
  "key",
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
  "dependsOn",
  "sortOrder",
  "parentKey",
  "name",
  "description",
] as const;

/**
 * Fields a human owns. Seed reconciliation preserves these byte-for-byte.
 *
 * `remainingWork` is here rather than in STRUCTURE deliberately: the seed may supply an initial
 * value on FIRST insert, but once an operator has edited it, it is their note about their work and
 * a later seed upgrade must not silently replace it with a compiled string.
 */
export const OPERATOR_FIELDS = [
  "remainingWork",
  "categoryNotes",
  "categoryStates",
  "blockers",
  "evidence",
  "worktreePath",
] as const;

/**
 * Fields that are DISCOVERABLE and must never be seeded.
 *
 * Each of these has a live-evidence source: git refs and GitHub for branch/commit/PR/CI, the
 * schema_migrations ledger for migration state, recorded deployments for deployment state, probes
 * for application version and flag state, and the readiness engine for completion. Seeding any of
 * them creates a second, stale answer that competes with the real one.
 */
export const MACHINE_FIELDS = [
  "status",
  "declaredCompletion",
  "reviewState",
  "deploymentState",
  "productionVerification",
  "branch",
  "baseCommit",
  "latestCommit",
  "prUrl",
  "version",
] as const;

/** Records that must never be hard-deleted, only marked. */
export const HISTORICAL_FIELDS = ["supersededBy", "supersededAt", "supersededReason"] as const;

export type StructureField = (typeof STRUCTURE_FIELDS)[number];
export type OperatorField = (typeof OPERATOR_FIELDS)[number];
export type MachineField = (typeof MACHINE_FIELDS)[number];

export function ownerOf(field: string): FieldOwner | null {
  if ((STRUCTURE_FIELDS as readonly string[]).includes(field)) return "structure";
  if ((OPERATOR_FIELDS as readonly string[]).includes(field)) return "operator";
  if ((MACHINE_FIELDS as readonly string[]).includes(field)) return "machine";
  if ((HISTORICAL_FIELDS as readonly string[]).includes(field)) return "historical";
  return null;
}

/** May seed reconciliation write this field on an EXISTING row? */
export function seedMayReconcile(field: string): boolean {
  return ownerOf(field) === "structure";
}

/** May the compiled seed contain this field at all? */
export function seedMayDeclare(field: string): boolean {
  const owner = ownerOf(field);
  // `remainingWork` is the single operator field the seed may supply as an INITIAL value.
  if (field === "remainingWork") return true;
  return owner === "structure";
}

/* ------------------------------------------------------------------------------------------ */
/* Validation                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface SeedContractViolation {
  packageKey: string;
  field: string;
  owner: FieldOwner | null;
  reason: string;
}

/**
 * Reject any compiled seed record that declares a machine-owned field.
 *
 * This is the guard that stops the original defect returning. It runs over the compiled seed
 * itself rather than over a database, so it fails at test time — before anything is written
 * anywhere — which is the only moment at which this is cheap to fix.
 */
export function validateSeedRecord(record: Record<string, unknown>, packageKey: string): SeedContractViolation[] {
  const out: SeedContractViolation[] = [];
  for (const field of Object.keys(record)) {
    if (record[field] === undefined) continue;
    const owner = ownerOf(field);
    if (owner === "machine") {
      out.push({
        packageKey,
        field,
        owner,
        reason: `"${field}" is discoverable from live evidence (git/GitHub, the migration ledger, recorded deployments or a probe). Seeding it creates a second, stale answer that competes with the real one. Leave it unset so it takes the honest default until evidence proves otherwise.`,
      });
      continue;
    }
    if (owner === null) {
      out.push({
        packageKey,
        field,
        owner,
        reason: `"${field}" is not classified by the seed field-ownership contract. Classify it as structure, operator, machine or historical before seeding it — an unclassified field has no rule for who may overwrite it.`,
      });
    }
  }
  return out;
}

export function validateSeedRecords(records: { key: string; [k: string]: unknown }[]): SeedContractViolation[] {
  return records.flatMap((r) => validateSeedRecord(r, r.key));
}
