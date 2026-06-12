#!/usr/bin/env npx tsx
/**
 * upload-share-backgrounds-from-map.ts
 *
 * Reads a JSONL map of {variant,url} (one per line, built from the hf CLI in a
 * shell loop — see /tmp/hf-urls.jsonl) and uploads each background to R2 at
 * public/share-bg/{variant}.jpg, resized to exactly 1080² q85.
 *
 * Kept separate from the CLI-fetch step so this stage is pure fetch + sharp +
 * R2 (no execFile, no auth context) — robust against the EPIPE/Unauthorized
 * issues hit when shelling out to the CLI from inside Node.
 *
 * Usage:
 *   URL_MAP=/tmp/hf-urls.jsonl npx tsx --env-file=.env scripts/upload-share-backgrounds-from-map.ts
 */
import fs from "fs";
import sharp from "sharp";
import { headR2, uploadToR2 } from "../server/r2";

const MAP_PATH = process.env.URL_MAP || "/tmp/hf-urls.jsonl";

async function downloadAndResize(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  return sharp(raw).resize(1080, 1080, { fit: "cover", position: "centre" }).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  const lines = fs
    .readFileSync(MAP_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l) as { variant: string; url: string });

  console.log(`\nMintVault share background upload (from map)`);
  console.log(`${entries.length} backgrounds to process\n`);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const { variant, url } of entries) {
    const r2Key = `public/share-bg/${variant}.jpg`;
    try {
      const exists = await headR2(r2Key).catch(() => null);
      if (exists) {
        console.log(`  SKIP  ${variant}`);
        skipped++;
        continue;
      }
      const buf = await downloadAndResize(url);
      await uploadToR2(r2Key, buf, "image/jpeg");
      console.log(`  ✓     ${variant} (${Math.round(buf.length / 1024)}KB)`);
      done++;
    } catch (err: any) {
      console.error(`  ✗     ${variant}: ${err?.message || err}`);
      failed++;
    }
  }

  console.log(`\nDone: ${done} uploaded, ${skipped} skipped, ${failed} failed`);
}

// Never let a stray socket error crash the whole run mid-way.
process.on("uncaughtException", (e) => console.error("[uncaught]", (e as any)?.message || e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", (e as any)?.message || e));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
