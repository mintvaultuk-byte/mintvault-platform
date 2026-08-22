/**
 * MVGS v1.4 freeze — the protected-file set, and the hashing rules.
 *
 * Shared by the verifier (scripts/mvgs/verify-freeze.ts, run by CI) and the
 * deliberate re-seal tool (scripts/mvgs/reseal-freeze.ts, run by a human).
 * Keeping the file LIST here rather than inside the manifest JSON means a
 * protected file cannot be quietly dropped from protection by editing data —
 * removing one is a source change that shows up in review.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_PATH = "mvgs-v1_4-freeze.manifest.json";
export const FROZEN_RULES_VERSION = "v1.4";

/**
 * Every file whose bytes can change a v1.4 grade.
 *
 * Derived from the authority dependency closure, not from intuition: walk the
 * static imports from resolveDraftGradeAuthority and the engine entrypoints and
 * you reach exactly these. `tests/mvgs-v14-freeze.test.ts` recomputes that
 * closure and fails if a NEW behaviour-affecting module appears that is not
 * listed here — which is what stops "leave the frozen file alone, change its
 * dependency instead".
 */
export const FROZEN_FILES: readonly string[] = [
  // ── the scoring engine and its tables ──────────────────────────────────
  "shared/mvgs-scoring.ts", // deductions, brackets, ceilings, the floor rule
  "shared/centering.ts", // front/back band tables, worst-of-four
  "shared/pristine.ts", // Pristine 10P / Black Label gate
  "shared/mvgs-input-builder.ts", // observation -> engine input normalisation
  "shared/grade-presentation.ts", // grade ladder, tier names, grade validation
  // ── the versioned boundary ─────────────────────────────────────────────
  "shared/mvgs/v1_4/calibration.ts", // the frozen thresholds
  "shared/mvgs/v1_4/index.ts", // the only supported way to invoke v1.4
  "shared/mvgs/registry.ts", // version routing; fails closed on unknown
  // ── the server authority ───────────────────────────────────────────────
  "server/lib/draft-grade-authority.ts", // the one grade producer
  "server/lib/grade-kind.ts", // numeric / NO / AA resolution
] as const;

export interface FreezeManifest {
  rulesVersion: string;
  /** Commit the freeze was sealed at. Informational — hashes are the authority. */
  sealedAtCommit: string;
  sealedAt: string;
  /** Production release this ruleset was proven on. */
  provenOnRelease: string;
  files: Record<string, string>;
}

/**
 * SHA-256 of a protected file, over its EXACT bytes.
 *
 * Deliberately not normalised — no trimming, no line-ending fixes, no comment
 * stripping. A comment edit changes the hash and fails the gate. That is the
 * intended behaviour and not an inconvenience to engineer around: the cheapest
 * way to smuggle a behavioural change past a reviewer is inside a "tidy up the
 * comments" diff, and re-sealing must always be a conscious, separate act.
 */
export function hashFile(root: string, relPath: string): string {
  const abs = join(root, relPath);
  if (!existsSync(abs)) throw new Error(`protected file is missing: ${relPath}`);
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

export function computeHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [...FROZEN_FILES].sort()) out[f] = hashFile(root, f);
  return out;
}

export function readManifest(root: string): FreezeManifest {
  const p = join(root, MANIFEST_PATH);
  if (!existsSync(p)) throw new Error(`freeze manifest not found at ${MANIFEST_PATH}`);
  return JSON.parse(readFileSync(p, "utf8")) as FreezeManifest;
}
