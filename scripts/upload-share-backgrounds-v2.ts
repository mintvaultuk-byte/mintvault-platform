#!/usr/bin/env npx tsx
/**
 * MintVault — upload-share-backgrounds-v2.ts
 * 1. Deletes ALL old Seedream backgrounds from R2 (public/share-bg/*)
 * 2. Uploads 56 new Nano Banana Pro backgrounds to R2
 *
 * Usage:
 *   HIGGSFIELD_API_KEY=<token> npx tsx --env-file=.env scripts/upload-share-backgrounds-v2.ts
 *
 * Dry-run:
 *   DRY_RUN=1 npx tsx scripts/upload-share-backgrounds-v2.ts
 */

import sharp from "sharp";
import { headR2, uploadToR2 } from "../server/r2";

// ── 56 new Nano Banana Pro job IDs ────────────────────────────
const JOBS: Record<string, string> = {
  // VAULT (10)
  "vault-gold": "1c57c1b2-9612-410a-b7a7-926d8a296edd",
  "vault-emerald": "2dca8e1b-1f13-4284-9038-86d6d8a83365",
  "vault-steel": "8e4c0be8-57bf-4ed7-a2f3-00293c7c9996",
  "vault-crimson": "1f600517-8416-4c2d-bf09-fd2cbbda4179",
  "vault-midnight": "32758fd4-4f92-471a-a55d-219702d9e7f5",
  "vault-obsidian": "d8bd1ae7-4ee4-490b-ac92-0ef744110654",
  "vault-copper": "21ae10c3-c409-4e6c-ae78-735e772e11b0",
  "vault-platinum": "df75c139-0a77-411a-91c7-023b064f4d1c",
  "vault-onyx": "db87b149-b9da-4703-85c2-a63aecc2471b",
  "vault-rose": "7bf432f0-d380-47c2-87fa-f749c80f2d46",
  // COSMIC (10)
  "cosmic-nebula": "dc66d370-8580-4731-b84e-7dccd4488451",
  "cosmic-aurora": "12bb5f39-ed6d-4386-993b-123724e6f02b",
  "cosmic-supernova": "fd9037e1-c4cf-4952-b6bc-e1efc9cd692e",
  "cosmic-void": "1a75bfd2-136a-4b2b-b2d9-91d2c52da1bb",
  "cosmic-pulsar": "d90b5c21-03b8-490a-80fe-c4ad957e59b3",
  "cosmic-galaxy": "a1d37ccb-9f00-4b38-bfe1-e20cb2a7110e",
  "cosmic-stardust": "880dd2ae-03bc-43b8-8350-569681211b13",
  "cosmic-magnetar": "f8dc28bb-d332-4d85-b687-0da2776f148f",
  "cosmic-infrared": "11af29b1-c142-4577-ac38-64a215cd3580",
  "cosmic-plasma": "5ae168f6-564d-48e1-8a67-c42189ffb33d",
  // POKÉMON TYPES (18)
  "poke-fire": "96f1fdae-1b18-4691-9632-5d62c972afc6",
  "poke-water": "fefa9bff-4708-4bc0-b67e-fc7a18be1fba",
  "poke-grass": "63839e60-afe6-423d-bf08-117f781953c5",
  "poke-electric": "db62ef6c-5d9f-4fd0-ac06-1b4d6b37d279",
  "poke-psychic": "6f8f1831-b1a6-4957-8362-4e847f387ff8",
  "poke-ice": "937337da-d63b-46e1-864d-52641b594930",
  "poke-dragon": "1a3cda17-4724-4b1d-948f-c62e01f5598d",
  "poke-dark": "94f0f753-0bc3-4bdf-9228-8cff041ed8b5",
  "poke-steel": "b3db6945-49eb-4564-b8bd-ebadb4482dc1",
  "poke-fairy": "ea392655-39b6-469a-bbb4-8466fbd04e4e",
  "poke-fighting": "c69891b0-d883-4fdc-9b49-4fe542b307ec",
  "poke-poison": "bc651ebc-b6e4-4c34-a5fd-eda26aa76990",
  "poke-ground": "0cb3ced2-cd37-4a66-aebf-bd7a9f05b448",
  "poke-flying": "f345c17a-6bc9-4cee-bf74-d7db94dabca8",
  "poke-rock": "8d88c77b-383d-4e17-83b7-c52ab2a17256",
  "poke-ghost": "d883cae7-01d0-4666-b880-ab64d6e81d1a",
  "poke-bug": "a414e5f7-5f5c-4b4d-972e-b1558fc219e6",
  "poke-normal": "6f4a88f1-5ff1-4f95-b377-0cb698bd430a",
  // WEATHER (10)
  "weather-storm": "1e4b70ff-fb1b-4f2c-8636-bfcf882b7e9c",
  "weather-lightning": "d86f4eff-dbca-4cf7-89d0-b6f85fd27f82",
  "weather-fog": "be5653d6-02cb-4e1f-a8cb-1f2545f9bdc5",
  "weather-aurora": "87449b91-35a2-4fd1-a9af-168746101985",
  "weather-sunset": "8573bb3d-ab9e-4f3c-b19b-c952741ba2e5",
  "weather-midnight": "b9d92ab6-ef9c-4b2e-9211-c63006f996fd",
  "weather-rain": "1258a0ce-b010-4f22-97f9-6656ede5c7fe",
  "weather-snow": "9ccbdc01-3f6b-430c-a138-180b5b03e5c8",
  "weather-heat": "616b850b-e13d-4df2-af52-986f3a4e8510",
  "weather-wind": "c4418b27-e24e-41de-9695-53fff58482e3",
  // NATURE (8)
  "nature-deep-ocean": "68b19372-ebcc-4897-a57b-fb1c4a9fd1cc",
  "nature-forest": "fad5e4a4-a3cb-47e5-b8a9-70597fb6c905",
  "nature-volcano": "19a1ff08-0fd6-459c-ad1d-81cafcfc3209",
  "nature-arctic": "7856182e-2485-4e96-b981-76175c1bb6bb",
  "nature-desert": "635d7d3d-a0cc-429e-a636-b12eb3ff846e",
  "nature-jungle": "e1a1424d-2d53-4468-8d4c-e16de1373982",
  "nature-cave": "effa93c7-0f49-4d5e-9d93-bd493418a7b1",
  "nature-sky": "35b275ad-2042-448c-ba91-aa3a49aacbc5",
};

const HIGGSFIELD_API = "https://api.higgsfield.ai";
const API_KEY = process.env.HIGGSFIELD_API_KEY;
const DRY_RUN = process.env.DRY_RUN === "1";

if (!API_KEY && !DRY_RUN) {
  console.error("Set HIGGSFIELD_API_KEY. Get token: hf auth token");
  process.exit(1);
}

async function getJobImageUrl(jobId: string): Promise<string> {
  const res = await fetch(`${HIGGSFIELD_API}/v1/generations/${jobId}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`Higgsfield ${res.status} for ${jobId}`);
  const data = (await res.json()) as any;
  const url = data.result_url ?? data.results?.[0]?.url ?? data.output?.[0];
  if (!url) throw new Error(`No URL for job ${jobId}`);
  return url;
}

async function downloadAndResize(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());
  return sharp(raw).resize(1080, 1080, { fit: "cover", position: "centre" }).jpeg({ quality: 85 }).toBuffer();
}

async function deleteOldBackgrounds() {
  // Import the R2 S3 client to list + delete old keys
  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: "auto",
    endpoint: process.env.CLOUDFLARE_R2_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    },
  });
  const bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME!;

  // List all objects under public/share-bg/
  const list = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "public/share-bg/",
    })
  );

  if (!list.Contents?.length) {
    console.log("  No old backgrounds found in R2");
    return;
  }

  console.log(`  Deleting ${list.Contents.length} old backgrounds from R2...`);

  if (!DRY_RUN) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: list.Contents.map((o) => ({ Key: o.Key! })),
        },
      })
    );
  }

  console.log(`  ${DRY_RUN ? "DRY" : "✓"} Deleted ${list.Contents.length} old backgrounds`);
}

async function main() {
  console.log("\nMintVault share backgrounds — replace with Nano Banana Pro");
  console.log(`${DRY_RUN ? "(DRY RUN) " : ""}56 new backgrounds\n`);

  // Step 1: delete old
  console.log("Step 1: Deleting old Seedream backgrounds from R2...");
  await deleteOldBackgrounds();

  // Step 2: upload new
  console.log("\nStep 2: Uploading 56 new Nano Banana Pro backgrounds...");
  let done = 0,
    failed = 0;

  for (const [variantId, jobId] of Object.entries(JOBS)) {
    const r2Key = `public/share-bg/${variantId}.jpg`;
    try {
      if (DRY_RUN) {
        console.log(`  DRY   ${variantId}`);
        done++;
        continue;
      }
      const url = await getJobImageUrl(jobId);
      const buf = await downloadAndResize(url);
      await uploadToR2(r2Key, buf, "image/jpeg");
      console.log(`  ✓     ${variantId} (${Math.round(buf.length / 1024)}KB)`);
      done++;
    } catch (err: any) {
      console.error(`  ✗     ${variantId}: ${err.message}`);
      failed++;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`\nDone: ${done} uploaded, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
