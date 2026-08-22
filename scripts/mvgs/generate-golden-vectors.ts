#!/usr/bin/env tsx
/**
 * Generate the MVGS v1.4 golden corpus by running the REAL frozen engine.
 *
 * Like the re-seal tool, this is a deliberate human action and is never wired
 * into test/lint/build/CI. Regenerating expectations to match changed behaviour
 * is precisely how a golden corpus becomes worthless, so it demands the same
 * uncomfortable flag.
 *
 * The corpus is generated, never hand-written: hand-written expectations encode
 * what someone BELIEVED the engine does. These record what it actually did on
 * the release the rules were proven on.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  scoreMvgsV1_4,
  gradeForScoreV1_4,
  tierNameV1_4,
  isPristineV1_4,
  MVGS_V1_4_VERSION,
} from "../../shared/mvgs/v1_4";
import { centeringAxisGrade, centeringSubgrade } from "../../shared/centering";
import { remainingToGrade } from "../../shared/mvgs-scoring";
import { buildVectorInputs, type GoldenCase } from "./golden-inputs";

const CONFIRM = "--i-am-regenerating-golden-expectations";
if (!process.argv.includes(CONFIRM)) {
  console.error(
    `\nRefusing to regenerate the MVGS v1.4 golden corpus.\n\n` +
      `  These fixtures are what proves the frozen engine still behaves exactly as it\n` +
      `  did when v1.4 was sealed. Regenerating them to match a change makes the whole\n` +
      `  corpus meaningless — the test would then assert only "the engine equals itself".\n\n` +
      `  If a golden vector is failing, the engine changed. Fix the engine, or ship v1.5.\n\n` +
      `  If the owner has explicitly approved this, re-run with:\n      ${CONFIRM}\n`
  );
  process.exit(1);
}

const cases = buildVectorInputs();
const vectors = cases.map((c: GoldenCase) => {
  const r = scoreMvgsV1_4(c.input);
  const overall = gradeForScoreV1_4(r.score);
  const subgrades = {
    centering: centeringSubgrade(
      c.input.centeringFrontLr,
      c.input.centeringFrontTb,
      c.input.centeringBackLr,
      c.input.centeringBackTb
    ).subgrade,
    corners: remainingToGrade(25 - Math.abs(r.deductions.corners ?? 0)),
    edges: remainingToGrade(25 - Math.abs(r.deductions.edges ?? 0)),
    surface: remainingToGrade(25 - Math.abs(r.deductions.surface ?? 0)),
  };
  return {
    id: c.id,
    description: c.description,
    expected: {
      score: r.score,
      overall,
      tier: tierNameV1_4(overall),
      label: r.grade,
      subgrades,
      deductions: r.deductions,
      ceiling: r.ceiling,
      edgesSubgradeFromWhitening: r.edgesSubgradeFromWhitening,
      tearForceNotGraded: r.tearForceNotGraded,
      pristine: isPristineV1_4(subgrades, overall, r.deductions),
    },
  };
});

const centeringAxes: Record<string, { front: number; back: number }> = {};
for (let bigger = 50; bigger <= 99; bigger++) {
  const ratio = `${bigger}/${100 - bigger}`;
  centeringAxes[ratio] = { front: centeringAxisGrade(ratio, "front"), back: centeringAxisGrade(ratio, "back") };
}

const corpus = {
  rulesVersion: MVGS_V1_4_VERSION,
  corpusVersion: 1,
  generatedFrom: "shared/mvgs/v1_4 — the frozen authority, invoked directly",
  vectors,
  centeringAxes,
};
const out = join(process.cwd(), "tests/fixtures/mvgs-v1_4-golden.json");
writeFileSync(out, JSON.stringify(corpus, null, 2) + "\n");
console.log(
  `Wrote ${vectors.length} grade vectors + ${Object.keys(centeringAxes).length} centering axis rows to ${out}`
);
