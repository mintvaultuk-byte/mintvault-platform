/**
 * scripts/ig-dry-run.ts
 *
 * Dry-run the Instagram pipeline end-to-end WITHOUT publishing.
 * - Fetches real data for the chosen post type
 * - Generates the image (PNG buffer → /tmp/ig-preview.png)
 * - Generates the caption (Anthropic; falls back to canned copy if no key)
 * - Prints caption + hashtags to stdout
 *
 * Does NOT write to ig_post_queue. Does NOT upload to R2. Does NOT touch
 * Meta. Pure read-only against the database + a /tmp PNG write.
 *
 * Usage:
 *   npx tsx scripts/ig-dry-run.ts                    # defaults to card_reveal
 *   npx tsx scripts/ig-dry-run.ts card_reveal
 *   npx tsx scripts/ig-dry-run.ts grade_breakdown
 *   npx tsx scripts/ig-dry-run.ts service_explainer  # uses standard tier; --tier=express to pick
 *   npx tsx scripts/ig-dry-run.ts vault_club
 *   npx tsx scripts/ig-dry-run.ts market_insight
 */
import fs from "fs";
import { fetchPostData } from "../server/ig/data-fetcher";
import { generateIgImage } from "../server/ig/image-generator";
import { generateCaption } from "../server/ig/caption-generator";
import { IG_POST_TYPES, type IgPostType } from "@shared/schema";

const VALID_POST_TYPES = IG_POST_TYPES as readonly string[];

async function main() {
  const args = process.argv.slice(2);
  const postType = (args.find((a) => !a.startsWith("--")) ?? "card_reveal") as IgPostType;
  const tierArg = args.find((a) => a.startsWith("--tier="))?.split("=")[1] ?? "standard";

  if (!VALID_POST_TYPES.includes(postType)) {
    console.error(`Unknown post type: ${postType}`);
    console.error(`Valid: ${VALID_POST_TYPES.join(", ")}`);
    process.exit(1);
  }

  console.log(`\n[DRY RUN] post type: ${postType}${postType === "service_explainer" ? ` (tier=${tierArg})` : ""}\n`);

  // 1. Data — may be null for market_insight when weekly count is below
  // MARKET_INSIGHT_MIN_COUNT. The cron falls through to vault_club in that
  // case; for a dry-run we report the skip and exit cleanly.
  const data = await fetchPostData(postType, { tierId: tierArg });
  if (data === null) {
    console.log(`\n[DRY RUN] ${postType} returned null — post type unavailable right now (e.g. market_insight weekly count below floor).`);
    console.log(`In the cron, this would fall through to the next post type. Exiting.`);
    process.exit(0);
  }
  console.log("--- POST DATA ---");
  console.log(JSON.stringify(
    Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("_"))),
    null,
    2,
  ));

  // 2. Image
  const imageBuffer = await generateIgImage(data);
  const outPath = `/tmp/ig-preview-${postType}.png`;
  fs.writeFileSync(outPath, imageBuffer);
  console.log(`\n--- IMAGE ---\nSaved to ${outPath} (${imageBuffer.length} bytes, 1080×1080 PNG)`);

  // 3. Caption
  const { caption, hashtags, fromFallback } = await generateCaption(data);
  console.log("\n--- CAPTION ---");
  console.log(`(source: ${fromFallback ? "FALLBACK (no ANTHROPIC_API_KEY or API error)" : "claude-sonnet-4-6"})`);
  console.log(caption);
  console.log("\n--- HASHTAGS ---");
  console.log(hashtags);

  console.log("\n✓ Dry run complete. No DB writes. No R2 upload. No publish.");
}

main().catch((err) => {
  console.error("\n[DRY RUN] failed:", err);
  process.exit(1);
});
