#!/usr/bin/env npx tsx
/**
 * MintVault — upload-share-backgrounds.ts
 * Downloads all 110 generated backgrounds from Higgsfield and uploads them
 * to R2 at public/share-bg/{variantId}.jpg. Zero Segmind cost.
 *
 * Usage (R2 creds come from .env):
 *   HIGGSFIELD_API_KEY=xxx npx tsx --env-file=.env scripts/upload-share-backgrounds.ts
 *
 * Dry-run (no Higgsfield/R2 calls):
 *   DRY_RUN=1 npx tsx scripts/upload-share-backgrounds.ts
 */
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import { headR2, uploadToR2 } from "../server/r2";

const execFileAsync = promisify(execFile);
// The `hf` CLI talks to the real Higgsfield API (fnf.higgsfield.ai) and uses
// its own stored device-login token — the public REST host api.higgsfield.ai
// the original script targeted is dead. Pass the binary path via HF_BIN.
const HF_BIN = process.env.HF_BIN || "hf";

// ── Job ID → Variant ID mapping (110 backgrounds) ─────────────
const JOBS: Record<string, string> = {
  // VAULT
  "4970896f-abd8-4159-9f61-8759a758f4a2": "vault-gold",
  "c81a7c22-f5af-4830-a9d3-0c8c39870206": "vault-emerald",
  "63c4a5ba-7b99-4eee-94f8-cc8490d50f06": "vault-steel",
  "7f762f04-15b4-4711-80c2-e28e45d66a94": "vault-crimson",
  // COSMIC
  "46599a9b-783d-45ff-87a6-10af67e2d6ba": "cosmic-gold",
  "9e7c80a8-2f79-45f4-9aab-80d6ef401922": "cosmic-green",
  "6c10dc73-a3b0-47c6-869f-c52f63f2c24a": "cosmic-blue",
  "a448ce75-193f-4ae6-8286-1ffa3391e7e5": "cosmic-purple",
  // STUDIO
  "e75df451-a765-4e37-a268-28ed95ea9409": "studio-warm",
  "5b356b7e-40f6-4072-8efa-e7d05789ea89": "studio-cool",
  "72330485-4e55-42c9-bac5-0b8ae83dd127": "studio-neon",
  "daf32114-579b-4101-8f03-3b77b1c4d887": "studio-smoke",
  // TEXTURE
  "dab5e2ed-3b62-4c43-8d33-939550e74fe8": "abstract-marble",
  "632a9f92-ac3f-4935-8f19-df0e6556b141": "abstract-carbon",
  "161fc2b9-f51e-481a-beac-96295a2d6c99": "abstract-metal",
  "f3c3cc81-b020-440c-a2ce-2838b9da50e2": "abstract-obsidian",
  "7e4bdffe-a47f-4f15-9c63-8c9e7e497fbd": "texture-crystal",
  "3d589e5a-1720-4257-bdbb-a249ab190576": "texture-volcanic",
  "b4894054-d33c-42c8-9198-603a9eca60e9": "texture-ice",
  "da845cdf-7da6-43a2-baa3-d064f692c46c": "texture-smoke",
  "f2b8b79b-6950-4216-b1fc-18bb28e53644": "texture-ink",
  "f3c8eafc-30c8-4762-b104-9a40c3aa5bc1": "texture-stardust",
  "d36206c9-8676-4bbf-9bcc-b46b1d8a5d94": "texture-sand",
  "a40aa905-f03b-45fa-96d2-31f5efba879f": "texture-plasma",
  // NATURE
  "0afd5afc-74a4-4991-bf05-73c46fc4c3b4": "nature-forest",
  "8e230e9c-0905-4cf9-b782-bb48022b9cb1": "nature-ocean",
  "5ada860e-0a56-41fe-8284-bad05e05d7f0": "nature-dusk",
  "9a324310-fc8b-4540-aeba-930f3e36ee85": "nature-arctic",
  "d5ca6926-3174-4695-a513-1e4cfac19d81": "nature-deep-ocean",
  "ff179eaa-0b83-400b-af6b-42afada1fc16": "nature-jungle",
  "ecd0d29f-c489-4ebf-8aad-883055a94c87": "nature-mountain",
  "dc059956-5726-48ac-b4bc-a2514fa0217f": "nature-lava",
  "001e763d-ca31-4da5-ab96-be5ed8ebce77": "nature-cave",
  "50af35dc-f930-4718-8a24-1a764673f20a": "nature-waterfall",
  // POKÉMON
  "5b6af230-c0de-404f-b628-0c5b19c5077e": "poke-fire",
  "ecf595f2-401f-4074-b71c-fb6f929a5a9c": "poke-water",
  "a3b34a8e-2fd3-4035-9f52-732e7ddee84d": "poke-electric",
  "2fd1b6ad-a8d6-4a4d-9f72-022ca32f9ee7": "poke-grass",
  "a4376414-488f-4c67-8e08-b61463b69087": "poke-psychic",
  "f401de8b-5d10-4ebb-a2b7-5498295d71c9": "poke-ghost",
  "27f9ebf7-6333-4bdf-881c-ba63a1b22fa9": "poke-dark",
  "db310e18-85fb-4ee2-b96a-fbb2372464b3": "poke-dragon",
  "0b293454-c128-4ee2-8f40-4b8468bfbe29": "poke-ice",
  "6cf97446-2c97-46cd-9ee6-56d50ec069d9": "poke-fighting",
  "701d763f-f118-413f-9442-7171caf22c93": "poke-poison",
  "a25fac70-d810-4284-84b1-19ed54e061d1": "poke-ground",
  "895bc6dd-dad0-4c21-8ebb-1de0b9d00be1": "poke-flying",
  "81445e33-4e3a-4830-be48-31f1567cd6ad": "poke-rock",
  "712a753a-71d7-476b-9ed3-bfc462a51984": "poke-bug",
  "48fdd620-322a-4007-af49-85be42253761": "poke-steel",
  "715cc887-06ec-4b15-a7e6-77470a733990": "poke-fairy",
  "512ad3e3-2492-411c-bec9-2d9eb2408ef9": "poke-normal",
  // WEATHER
  "5868e504-3d3e-416f-8b06-9c4bf49a7cb8": "weather-lightning",
  "98240c05-4fa6-41fc-bab1-a70af5fc43bb": "weather-aurora-green",
  "0c68ec61-d267-4c2f-af21-c7be4cd943b1": "weather-aurora-purple",
  "67f0fcb7-0ffb-4e70-a16e-17c1d53065c3": "weather-aurora-blue",
  "7c956ce0-ec27-46ea-a8ff-5997f957d407": "weather-storm",
  "a4b50aba-ab42-4539-88a4-57c4c2921934": "weather-fog",
  "86a67826-1ae4-47b5-96aa-fe0ee9ecc349": "weather-eclipse",
  "16998961-8dba-4c6b-bc33-aaf2263da948": "weather-clouds",
  "f2dfb5df-c03c-4cd9-9a5c-adf1d52bdca9": "weather-sunset",
  "5ebb7812-ffd4-45e6-a9c3-0d901cc7e8b8": "weather-blizzard",
  "dd37893e-325e-4a1a-8ee3-a93fbca1510c": "weather-volcano-sky",
  "bac8716d-a7e2-4cea-915b-4ad1b5619151": "weather-dawn",
  // COLOUR
  "a834476c-1398-4d68-8740-b8402a2b995f": "color-violet",
  "e452d9fa-5eef-4e90-a9ae-10a2a1ffc2a0": "color-indigo",
  "5d9f4c20-445d-4c23-a532-2b4c1f8aa4e2": "color-electric-blue",
  "04c7cd54-9926-447c-885a-d2cf9b49b6a7": "color-cobalt",
  "2bf01328-92f2-4f50-9cba-5b23d909ed89": "color-teal",
  "4da5df2f-47dd-4314-ba7d-aa6d32a3bae1": "color-emerald",
  "b3fd40ac-03fa-451c-8d69-f8fe46bf3e79": "color-lime",
  "f443a48c-09a2-4a5f-8831-ecc56799542c": "color-yellow",
  "97484615-f6ff-4fd0-ad37-e73d706b40c8": "color-amber",
  "bd763063-18f0-43b7-ad80-f5af0c2e727a": "color-orange",
  "56f91452-6b03-48b6-91ab-ab6b5cc42cff": "color-crimson",
  "6a2a4b9b-530b-4a73-b0d8-4f2934671634": "color-rose",
  "e0547e67-0842-4fe5-b6a9-676e43b57c06": "color-magenta",
  "ffc56c83-5cf9-4049-972b-3fd92f7a399c": "color-pink",
  "bf044be1-12ef-4d1d-9007-ee337399c1b3": "color-gold",
  "7844e56e-305d-4d09-b0ac-7e3b5d5dbfef": "color-silver",
  "e16f1c0f-d95b-4388-b991-fed342f77755": "color-white",
  "5a9f7d69-d4fa-48e1-bda9-a5f551715dec": "color-midnight",
  "06f6c7b0-8d58-40b6-83ff-69a4591cdd35": "color-void",
  "be06b43e-2b0e-43c6-be8c-c383b05ae498": "color-chrome",
  // ENERGY
  "71cf8135-c5b7-4219-9f06-d8846d151780": "energy-fire",
  "1be599d4-a1a8-4f1b-8b94-af26e06dfae5": "energy-water",
  "7c52beac-79c6-4986-a3a0-d3d621bb482a": "energy-lightning",
  "1182f98f-fd04-425e-8a76-0babc8e929e5": "energy-shadow",
  "9e9d2f8d-f169-4608-8ffb-0dab842063cb": "energy-plasma",
  "106e1948-7e8a-4d71-96a4-93ff8f6fe64b": "energy-crystal",
  // CARDS
  "1f8d42fc-44e0-4185-86b0-d5934ca7d195": "cards-casino-red",
  "8f365cec-80cc-4be1-9352-5fc867ba1376": "cards-casino-green",
  "e0666ede-caf9-41e5-b7b5-65d4595e593b": "cards-gold-chip",
  "4dcddaf6-34a7-4503-a123-29732fc7517c": "cards-spades",
  "3425b5fb-49ac-42d8-b3a5-dda0dc460cb7": "cards-royal",
  "1b687dff-812f-4af4-8bc0-55f79e70a724": "cards-ace",
  "c8dc1116-a708-4db5-881a-e54a4ffbd3da": "cards-poker-noir",
  "83efc931-e784-4dcd-8d06-796ed13f70dd": "cards-money-green",
  "6e132da8-747c-4c26-9153-ce25112e462c": "cards-platinum",
  "b301b258-0fc0-41b2-ace3-4b4fc05de11a": "cards-joker",
  "442c82ee-dec3-4bbe-8781-4ff2be94b665": "cards-iridescent",
  "f2153da7-e179-4637-968a-b20dc479349f": "cards-champagne",
  "23934587-8ed7-4043-9d2c-95bf3764fbb0": "cards-midnight",
  "2d8256c7-7c95-4e7f-9c6f-e8b8b0c2763f": "cards-velvet",
  "6265140f-5aa7-4338-9b00-ed19aefee907": "cards-jackpot",
  "b4dc4545-f6df-45ac-8ee4-8b0d4f973dd7": "cards-dealer",
  "8e74159a-2a98-405f-86ce-4fc103055215": "cards-hearts",
  "9b71ce34-11e8-4c82-80a1-8486074f63bc": "cards-diamonds",
  "4247347e-33d7-4294-8920-703600506f9b": "cards-clubs",
  "8dfb4c79-0f40-477a-b366-c87fe389c7f9": "cards-high-stakes",
};

const DRY_RUN = process.env.DRY_RUN === "1";

/** Recursively find the first image-like URL anywhere in a JSON value. */
function findImageUrl(node: any): string | null {
  if (typeof node === "string") {
    if (/^https?:\/\/\S+\.(jpe?g|png|webp)(\?\S*)?$/i.test(node)) return node;
    if (/^https?:\/\//.test(node) && /(cdn|media|storage|image|output|result)/i.test(node)) return node;
    return null;
  }
  if (Array.isArray(node)) {
    for (const v of node) {
      const u = findImageUrl(v);
      if (u) return u;
    }
    return null;
  }
  if (node && typeof node === "object") {
    // Prefer obvious result/output/url keys first
    for (const key of ["result_url", "image_url", "url", "output", "results", "result", "assets"]) {
      if (key in node) {
        const u = findImageUrl(node[key]);
        if (u) return u;
      }
    }
    for (const v of Object.values(node)) {
      const u = findImageUrl(v);
      if (u) return u;
    }
  }
  return null;
}

/** Fetch a finished job's image URL via the hf CLI (uses its stored token). */
async function getJobImageUrl(jobId: string): Promise<string> {
  const { stdout } = await execFileAsync(HF_BIN, ["generate", "get", jobId, "--json"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`hf get ${jobId}: non-JSON output: ${stdout.slice(0, 160)}`);
  }
  const url = findImageUrl(data);
  if (!url) throw new Error(`No image URL in hf output for job ${jobId}: ${JSON.stringify(data).slice(0, 200)}`);
  return url;
}

// Download + resize to exactly 1080×1080 JPEG (matches generateBackground).
async function downloadAndResize(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const raw = Buffer.from(await res.arrayBuffer());
  return sharp(raw).resize(1080, 1080, { fit: "cover", position: "centre" }).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  const jobs = Object.entries(JOBS);
  let done = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`\nMintVault share background upload`);
  console.log(`${jobs.length} backgrounds to process${DRY_RUN ? " (DRY RUN)" : ""}\n`);

  for (const [jobId, variantId] of jobs) {
    const r2Key = `public/share-bg/${variantId}.jpg`;
    try {
      if (DRY_RUN) {
        console.log(`  DRY   ${variantId} ← job ${jobId.slice(0, 8)}`);
        done++;
        continue;
      }

      // Skip if already cached in R2
      const exists = await headR2(r2Key).catch(() => null);
      if (exists) {
        console.log(`  SKIP  ${variantId}`);
        skipped++;
        continue;
      }

      const imageUrl = await getJobImageUrl(jobId);
      const buf = await downloadAndResize(imageUrl);
      await uploadToR2(r2Key, buf, "image/jpeg");

      console.log(`  ✓     ${variantId} (${Math.round(buf.length / 1024)}KB)`);
      done++;
    } catch (err: any) {
      console.error(`  ✗     ${variantId}: ${err.message}`);
      failed++;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\nDone: ${done} uploaded, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
