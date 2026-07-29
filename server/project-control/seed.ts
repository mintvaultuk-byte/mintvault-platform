/**
 * Project Control — programme tree seed.
 *
 * IDEMPOTENT and NON-DESTRUCTIVE: every insert is `onConflictDoNothing` keyed on the stable
 * `key`, so running it twice changes nothing and it never overwrites a status the founder has
 * since edited, nor any audit history.
 *
 * HONESTY RULE: seeded statuses are recorded as `owner_statement` evidence, which the confidence
 * engine treats as "Reported" — the weakest positive level. Nothing seeded here claims to be
 * automatically verified, and nothing is seeded as production verified, because the seed has no
 * production evidence to offer.
 *
 * Remediated in this pass:
 *  - the approved Shop Launch sequence (1–10) is preserved exactly and asserted by test;
 *  - the full G7–G20 backlog is present as FUTURE work, so programme readiness is measured
 *    against the real denominator instead of an optimistically short one;
 *  - acceptance criteria and required tests are seeded, so the requirements category is
 *    measurable rather than permanently unprovable;
 *  - no seeded package declares a category not-applicable.
 */
import { db } from "../db";
import { pcEvidence, pcNodes, pcStatusEvents, pcWorkPackages } from "@shared/schema";
import { NODES, PACKAGES, orderNodesParentFirst } from "./seed-data";

export { APPROVED_SHOP_LAUNCH_SEQUENCE, SEED_NODES, SEED_PACKAGES, orderNodesParentFirst } from "./seed-data";

export interface SeedResult {
  nodesInserted: number;
  packagesInserted: number;
}

/** Idempotent. Existing rows are never modified. */
export async function seedProgrammeTree(actor = "seed"): Promise<SeedResult> {
  // Nodes are inserted parent-first so the self-referencing foreign key is always satisfiable.
  const ordered = orderNodesParentFirst(NODES);

  let nodesInserted = 0;
  for (const node of ordered) {
    const inserted = await db
      .insert(pcNodes)
      .values(node)
      .onConflictDoNothing({ target: pcNodes.key })
      .returning({ key: pcNodes.key });
    nodesInserted += inserted.length;
  }

  const insertedPackages = await db
    .insert(pcWorkPackages)
    .values(
      PACKAGES.map((p: (typeof PACKAGES)[number]) => ({
        ...p,
        tags: p.tags ?? [],
        branch: p.branch ?? null,
        acceptanceCriteria: p.acceptanceCriteria ?? [],
        requiredTests: p.requiredTests ?? [],
        categoryStates: {},
        categoryNotes: {},
        createdBy: actor,
        updatedBy: actor,
      }))
    )
    .onConflictDoNothing({ target: pcWorkPackages.key })
    .returning({ key: pcWorkPackages.key });

  // Seeded status is recorded as an owner statement = "Reported" confidence, never higher.
  if (insertedPackages.length > 0) {
    await db.insert(pcEvidence).values(
      insertedPackages.map((p) => ({
        packageKey: p.key,
        kind: "owner_statement",
        supports: true,
        summary: "Initial status recorded when the programme tree was seeded. Not independently verified.",
        capturedBy: actor,
      }))
    );

    /**
     * DECISION: seeding IS audited.
     *
     * The seed creates work packages, and the ledger's purpose is to answer "where did this row
     * come from?". A package that appeared with no history would be indistinguishable from one
     * an operator created and forgot. Events are marked `source: "seed"` so they are never
     * mistaken for a human edit.
     */
    await db.insert(pcStatusEvents).values(
      insertedPackages.map((p) => ({
        subjectType: "work_package",
        subjectKey: p.key,
        field: "created",
        oldValue: null,
        newValue: "seeded",
        reason: "Created by the programme-tree seed.",
        actor,
        source: "seed",
      }))
    );
  }

  return { nodesInserted, packagesInserted: insertedPackages.length };
}
