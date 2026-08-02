/**
 * Project Control — the compiled, server-owned seed manifest.
 *
 * This is the glue between `seed-data.ts` (the founder-facing programme definition) and the
 * reconciliation engine (which consumes a `SeedManifest`). It composes; it decides nothing.
 *
 * WHY THE MANIFEST IS COMPILED AND NEVER SUPPLIED BY A CALLER
 *
 * The desired programme structure is an owner decision that lives in source, is reviewed in a
 * pull request, and is versioned. If a route accepted a manifest from a request body, a Super
 * Admin session — or anything that reached one — could rewrite the entire programme structure in
 * a single call, with no review and no diff. The execution routes therefore take no manifest at
 * all: they call `currentSeedManifest()` and reconcile against that.
 *
 * SEED VERSION
 *
 * Bumped deliberately, by hand, when the structure changes. It is NOT derived from a timestamp or
 * a digest: those change on every edit, including cosmetic ones, and a version that changes by
 * itself cannot express "this is a deliberate structural revision". The digest answers "is this
 * the same content?"; the version answers "was this a considered change?".
 *
 * Raising it is what permits a reconciliation to update system-owned fields on rows that already
 * exist, and lowering it below the applied version is refused by the planner.
 */
import { NODES, PACKAGES } from "./seed-data";
import type { ManifestPackage, ManifestSupersession, SeedManifest } from "@shared/project-control-seed-manifest";
import { manifestDigest } from "@shared/project-control-seed-manifest";

/**
 * The current structural revision.
 *
 * v1 — first compiled manifest. Carries the programme structure only: every machine-derivable
 *      field was removed from the seed in an earlier pass and is now supplied by live evidence.
 */
export const SEED_VERSION = 1;

/**
 * Packages that existed in an earlier structure and should now be retired.
 *
 * EMPTY, DELIBERATELY, AND THAT IS THE CORRECT VALUE TODAY. No environment has ever been seeded —
 * staging's Project Control tables are empty — so there is nothing anywhere to retire. Declaring
 * a supersession for a package that never existed would produce a warning on every reconciliation
 * forever, for no benefit.
 *
 * The mechanism is built, tested and ready for the first genuine retirement. When one arrives it
 * belongs here, with a replacement key and a reason, and the planner will verify the replacement
 * actually exists before allowing the apply.
 */
export const SEED_SUPERSESSIONS: ManifestSupersession[] = [];

/**
 * Map the founder-facing seed record onto the manifest shape.
 *
 * Only fields the ownership contract classifies as STRUCTURE are carried across, plus
 * `remainingWork`, which the seed may supply as an INITIAL value and which reconciliation then
 * treats as operator-owned and never overwrites. Machine-owned fields are not carried because
 * they are no longer present in `seed-data.ts` at all — this mapping cannot reintroduce them.
 */
function toManifestPackage(p: (typeof PACKAGES)[number]): ManifestPackage {
  return {
    key: p.key,
    nodeKey: p.nodeKey,
    title: p.title,
    summary: p.summary,
    risk: p.risk,
    classification: p.classification,
    businessValue: p.businessValue,
    engineeringRisk: p.engineeringRisk,
    remainingWork: p.remainingWork,
    tags: p.tags ?? [],
    acceptanceCriteria: p.acceptanceCriteria ?? [],
    requiredTests: p.requiredTests ?? [],
  };
}

/** The one manifest the execution surface will ever reconcile against. */
export function currentSeedManifest(): SeedManifest {
  return {
    version: SEED_VERSION,
    nodes: NODES.map((n) => ({
      key: n.key,
      parentKey: n.parentKey,
      name: n.name,
      description: n.description,
      sortOrder: n.sortOrder,
    })),
    packages: PACKAGES.map(toManifestPackage),
    supersessions: SEED_SUPERSESSIONS,
  };
}

/** Digest of the compiled manifest. Deterministic for a given source tree. */
export function currentSeedManifestDigest(): string {
  return manifestDigest(currentSeedManifest());
}
