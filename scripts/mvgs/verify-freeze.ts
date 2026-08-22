#!/usr/bin/env tsx
/**
 * MVGS v1.4 freeze verification. Run by CI on every pull request.
 *
 * Exits NON-ZERO if any protected byte has changed, if a protected file has
 * been deleted, or if the manifest and the protected-file list disagree.
 *
 * This tool CANNOT re-seal. It has no write path at all — no flag, no env var,
 * no hidden branch. Re-sealing lives in a separate script a human runs on
 * purpose (scripts/mvgs/reseal-freeze.ts). That separation is the whole point:
 * a verifier that can update its own expectations verifies nothing, and an
 * agent told to "make CI green" would find and pull that lever.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FROZEN_FILES, MANIFEST_PATH, computeHashes, readManifest } from "./freeze-manifest";

const ROOT = process.cwd();
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

function fail(lines: string[]): never {
  console.error(`\n${RED}${BOLD}✖ MVGS v1.4 FREEZE VIOLATION${OFF}\n`);
  for (const l of lines) console.error(`  ${l}`);
  console.error(
    `\n${BOLD}MVGS v1.4 is an immutable grading ruleset.${OFF}\n` +
      `  Create a new rules version rather than modifying v1.4.\n\n` +
      `  Roughly 700 certificates — and the physical slabs printed from them —\n` +
      `  were issued under these exact rules. Changing them re-grades cards that\n` +
      `  are already in customers' hands.\n\n` +
      `  To change how cards grade:  add shared/mvgs/v1_5/, register it in\n` +
      `  shared/mvgs/registry.ts, and stamp new grades "v1.5".\n\n` +
      `  If this change is genuinely a correction to v1.4 itself, it needs the\n` +
      `  owner's explicit approval and a deliberate re-seal:\n` +
      `      npx tsx scripts/mvgs/reseal-freeze.ts --i-am-changing-a-frozen-ruleset\n`
  );
  process.exit(1);
}

/** Anything under shared/mvgs/ is version-boundary code and must be listed. */
function walkVersionedTree(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walkVersionedTree(rel, acc);
    else if (rel.endsWith(".ts")) acc.push(rel);
  }
  return acc;
}

function main(): void {
  const problems: string[] = [];
  const manifest = readManifest(ROOT);

  // 1. The manifest must describe exactly the protected-file list — no more, no less.
  const listed = new Set(Object.keys(manifest.files));
  const expected = new Set(FROZEN_FILES);
  for (const f of expected) if (!listed.has(f)) problems.push(`protected file absent from the manifest: ${f}`);
  for (const f of listed)
    if (!expected.has(f)) problems.push(`manifest names a file that is no longer protected: ${f}`);

  // 2. A new file inside the versioned tree must be protected, or it is a hole.
  for (const f of walkVersionedTree("shared/mvgs")) {
    if (!expected.has(f)) {
      problems.push(
        `${f} lives in the versioned MVGS tree but is not protected — ` +
          `add it to FROZEN_FILES in scripts/mvgs/freeze-manifest.ts`
      );
    }
  }

  // 3. Every protected byte must match.
  let actual: Record<string, string>;
  try {
    actual = computeHashes(ROOT);
  } catch (err) {
    fail([(err as Error).message]);
  }
  for (const f of [...expected].sort()) {
    const want = manifest.files[f];
    const got = actual[f];
    if (want && got && want !== got) {
      problems.push(`${f}`);
      problems.push(`      expected sha256 ${want}`);
      problems.push(`      found    sha256 ${got}`);
    }
  }

  if (problems.length) fail(problems);

  console.log(
    `${GREEN}✔ MVGS ${manifest.rulesVersion} freeze intact${OFF} — ` +
      `${FROZEN_FILES.length} protected files match ${MANIFEST_PATH} ` +
      `(sealed ${manifest.sealedAt} at ${manifest.sealedAtCommit.slice(0, 8)}, proven on ${manifest.provenOnRelease}).`
  );
}

main();
