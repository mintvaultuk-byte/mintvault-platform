/**
 * scripts/_pr91-visual-gen.ts
 *
 * Renders the four visual artefacts requested for PR #91 review:
 *   /tmp/pr91-slab-white.png   ─ front of a white label (NM-MT 8)
 *   /tmp/pr91-slab-black.png   ─ front of a Black Label (GEM MT 10)
 *   /tmp/pr91-insert.png       ─ claim insert (cert MV999 + code TEST-1234-ABCD)
 *   /tmp/pr91-sheet.svg        ─ A4 cut layer, 4 rows × 2 cells = 8 cut rects
 *
 * Run: npx tsx scripts/_pr91-visual-gen.ts
 */

import { writeFileSync } from "fs";
import { generateLabelPNG } from "../server/labels";
import { generateClaimInsertPNG } from "../server/claim-insert";
import { generatePrintBatchCutSVG } from "../server/print-batch";
import type { CertificateRecord } from "@shared/schema";

const whiteLabelCert = {
  id: 42,
  certId: "MV42",
  cardName: "Misty's Poliwag",
  setName: "Gym Heroes",
  variant: "",
  year: "2000",
  cardNumber: "87",
  rarity: "Common",
  language: "EN",
  gradeType: "numeric",
  gradeOverall: "8",
  gradeCentering: "8",
  gradeCorners: "9",
  gradeEdges: "8",
  gradeSurface: "9",
  frontImageUrl: null,
} as unknown as CertificateRecord;

const blackLabelCert = {
  id: 1,
  certId: "MV1",
  cardName: "Charizard",
  setName: "Base Set",
  variant: "",
  year: "1999",
  cardNumber: "4",
  rarity: "Holo Rare",
  language: "EN",
  gradeType: "numeric",
  gradeOverall: "10",
  gradeCentering: "10",
  gradeCorners: "10",
  gradeEdges: "10",
  gradeSurface: "10",
  frontImageUrl: null,
} as unknown as CertificateRecord;

async function main(): Promise<void> {
  console.log("PR #91 visual artefacts\n");

  const slabWhite = await generateLabelPNG(whiteLabelCert, "front");
  writeFileSync("/tmp/pr91-slab-white.png", slabWhite);
  console.log(`  /tmp/pr91-slab-white.png   ${slabWhite.length} bytes  (Misty's Poliwag · Gym Heroes · NM-MT 8 · MV42)`);

  const slabBlack = await generateLabelPNG(blackLabelCert, "front");
  writeFileSync("/tmp/pr91-slab-black.png", slabBlack);
  console.log(`  /tmp/pr91-slab-black.png   ${slabBlack.length} bytes  (Charizard · Base Set · GEM MT 10 · MV1)`);

  const slabWhiteBack = await generateLabelPNG(whiteLabelCert, "back");
  writeFileSync("/tmp/pr91-slab-white-back.png", slabWhiteBack);
  console.log(`  /tmp/pr91-slab-white-back.png   ${slabWhiteBack.length} bytes  (white-label back)`);

  const slabBlackBack = await generateLabelPNG(blackLabelCert, "back");
  writeFileSync("/tmp/pr91-slab-black-back.png", slabBlackBack);
  console.log(`  /tmp/pr91-slab-black-back.png   ${slabBlackBack.length} bytes  (black-label back)`);

  const insert = await generateClaimInsertPNG("MV999", "TEST1234ABCD");
  writeFileSync("/tmp/pr91-insert.png", insert);
  console.log(`  /tmp/pr91-insert.png       ${insert.length} bytes  (claim insert)`);

  const sheetSvg = generatePrintBatchCutSVG(4);
  writeFileSync("/tmp/pr91-sheet.svg", sheetSvg);
  console.log(`  /tmp/pr91-sheet.svg        ${sheetSvg.length} bytes  (A4 cut layer)`);

  console.log("\nReady. scp these to your laptop and inspect.");
}

main().catch((e) => { console.error(e); process.exit(1); });
