#!/usr/bin/env tsx
/**
 * DELIBERATELY re-seal the MVGS freeze manifest.
 *
 * This is NOT part of any test, lint, build or CI command, and must never be
 * wired into one. It exists so that a genuine, owner-approved change to a frozen
 * ruleset can be recorded — and so that recording it is an act someone has to
 * choose, type out in full, and justify in a pull request.
 *
 * Running it requires the literal flag:
 *     --i-am-changing-a-frozen-ruleset
 *
 * The flag is long and uncomfortable on purpose. If you are reaching for this
 * to make a red build go green, stop: the correct answer is almost always a new
 * rules version (shared/mvgs/v1_5/), because roughly 700 certificates and the
 * slabs printed from them were issued under v1.4's exact rules.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FROZEN_FILES, MANIFEST_PATH, computeHashes, type FreezeManifest } from "./freeze-manifest";

const CONFIRM = "--i-am-changing-a-frozen-ruleset";
const ROOT = process.cwd();

if (!process.argv.includes(CONFIRM)) {
  console.error(
    `\nRefusing to re-seal the MVGS freeze manifest.\n\n` +
      `  This rewrites the expected hashes for an IMMUTABLE grading ruleset.\n` +
      `  Certificates already issued under v1.4 depend on those rules not moving.\n\n` +
      `  If you are trying to change how cards grade, create a new version instead:\n` +
      `      shared/mvgs/v1_5/  +  register in shared/mvgs/registry.ts\n\n` +
      `  If the owner has explicitly approved changing v1.4 itself, re-run with:\n` +
      `      npx tsx scripts/mvgs/reseal-freeze.ts ${CONFIRM}\n`
  );
  process.exit(1);
}

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

const provenOnRelease = process.env.MVGS_PROVEN_ON_RELEASE ?? "UNVERIFIED — set MVGS_PROVEN_ON_RELEASE";
const manifest: FreezeManifest = {
  rulesVersion: "v1.4",
  sealedAtCommit: commit,
  sealedAt: new Date().toISOString(),
  provenOnRelease,
  files: computeHashes(ROOT),
};
writeFileSync(join(ROOT, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Re-sealed ${MANIFEST_PATH} at ${commit.slice(0, 8)} over ${FROZEN_FILES.length} files.`);
console.log(`Every hash change MUST be explained in the pull request description.`);
