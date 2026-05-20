/**
 * Weekly grade-highlight reel job.
 *
 * Mirrors the ig-daily-post scheduler pattern (server/jobs/ig-daily-post.ts):
 *   - setInterval tick (hourly), London-time hour gate, day-key idempotency.
 *   - Boot-delayed start so route registration finishes first.
 *
 * What it does:
 *   1. Fetch top 8 consenting graded certs from the last 7 days
 *      (server/ig/weekly-reel-data.ts).
 *   2. If fewer than 3 cards qualify → log + exit (skip the reel this week).
 *   3. For each card: presign the front PNG R2 URL, call Segmind
 *      hfai-dop-lite (server/lib/segmind-client.ts), collect output URL.
 *   4. Per-card errors are NON-FATAL — log and continue with the rest.
 *   5. Persist a JSON manifest at
 *        videos/weekly-reels/draft-{YYYY-MM-DD}.json
 *      with { date, cards: [{ certNumber, grade, cardName, videoUrl }] }.
 *   6. Write one audit_log row: action='generated',
 *      details={ cardCount, successCount, failCount }.
 *
 * Stitching the per-card clips into a single weekly reel is OUT OF SCOPE for
 * this version (no FFmpeg yet — the manifest exists for manual stitch v1).
 *
 * SEGMIND_API_KEY must be present in env. If missing, the job logs a warning
 * and exits gracefully without firing API calls.
 *
 * Cron: Fridays at 18:00 UTC (registered by startWeeklyReelScheduler).
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { auditLog } from "@shared/schema";
import { getR2SignedUrl, uploadToR2 } from "../r2";
import { fetchWeeklyReelData, type WeeklyReelCard } from "../ig/weekly-reel-data";
import { imageToVideo } from "../lib/segmind-client";

const MIN_CARDS_TO_PUBLISH = 3;
const REEL_LIMIT = 8;
const SOURCE_URL_TTL_SECONDS = 60 * 60; // 1 hour — generous, Segmind only needs to fetch once
const VIDEO_PROMPT =
  "Cinematic slow reveal of a graded trading card slab, gold accents, dark vault background, premium quality";

// Cron config — Friday 18:00 UTC.
const REEL_CRON_WEEKDAY_UTC = 5;   // Friday (0=Sun, 5=Fri)
const REEL_CRON_HOUR_UTC = 18;
const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BOOT_DELAY_MS = 120 * 1000;        // 2 min after boot

export interface PerCardResult {
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  videoUrl: string | null;
  error?: string;
}

export interface WeeklyReelOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  date?: string;           // YYYY-MM-DD UTC
  manifestKey?: string;    // R2 key of the persisted JSON
  cardCount?: number;      // number of cards fed in (pre-segmind)
  successCount?: number;
  failCount?: number;
  results?: PerCardResult[];
}

function utcDateKey(date: Date = new Date()): string {
  // YYYY-MM-DD in UTC. Used in the manifest filename + audit_log entity_id.
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isFridayAtCronHourUtc(date: Date = new Date()): boolean {
  return date.getUTCDay() === REEL_CRON_WEEKDAY_UTC && date.getUTCHours() === REEL_CRON_HOUR_UTC;
}

/**
 * Has the reel already run for this UTC date? Checks audit_log for a
 * matching entity_id (the date string). Soft-fails open — if the query
 * itself errors, we assume not-yet-run (consistent with ig-daily-post's
 * "conservative for dev environments" stance).
 */
async function hasRunForDate(dateKey: string): Promise<boolean> {
  try {
    const rows = (await db.execute(sql`
      SELECT id FROM audit_log
      WHERE entity_type = 'weekly_reel'
        AND entity_id = ${dateKey}
        AND action = 'generated'
      LIMIT 1
    `)).rows;
    return rows.length > 0;
  } catch (err: any) {
    console.warn(`[weekly-reel] hasRunForDate lookup failed: ${err?.message ?? err}. Assuming false.`);
    return false;
  }
}

async function processOne(card: WeeklyReelCard): Promise<PerCardResult> {
  const base: PerCardResult = {
    certNumber: card.certNumber,
    grade: card.grade,
    cardName: card.cardName,
    videoUrl: null,
  };
  try {
    // Presigned GET URL of the live front display PNG. Segmind fetches
    // it once when the job is submitted; 1h TTL gives plenty of slack
    // even if their queue is backed up.
    const sourceUrl = await getR2SignedUrl(card.frontPngKey, SOURCE_URL_TTL_SECONDS);
    const videoUrl = await imageToVideo(sourceUrl, VIDEO_PROMPT);
    return { ...base, videoUrl };
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    console.warn(`[weekly-reel] ${card.certNumber}: segmind failed — ${detail}`);
    return { ...base, error: detail };
  }
}

export async function runWeeklyReel(opts: { force?: boolean } = {}): Promise<WeeklyReelOutput> {
  const dateKey = utcDateKey();

  if (!opts.force && await hasRunForDate(dateKey)) {
    console.log(`[weekly-reel] already-generated-today (${dateKey}) — skipping`);
    return { status: "skipped", reason: "already-generated-today", date: dateKey };
  }

  if (!process.env.SEGMIND_API_KEY) {
    console.warn("[weekly-reel] SEGMIND_API_KEY missing — exiting without API calls");
    return { status: "failed", reason: "segmind-key-missing", date: dateKey };
  }

  // 1. Fetch consenting top-N
  let data;
  try {
    data = await fetchWeeklyReelData(REEL_LIMIT);
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    console.error(`[weekly-reel] data fetch failed: ${detail}`);
    return { status: "failed", reason: `fetch-data: ${detail}`, date: dateKey };
  }

  console.log(`[weekly-reel] consenting graded certs (last ${data.windowDays}d): ${data.totalWithConsent}; picking top ${data.cards.length}`);

  // 2. Floor — need at least 3 cards to publish a reel
  if (data.cards.length < MIN_CARDS_TO_PUBLISH) {
    console.warn(`[weekly-reel] only ${data.cards.length} consenting card(s) — below floor of ${MIN_CARDS_TO_PUBLISH}, no reel this week`);
    return {
      status: "skipped",
      reason: `below-floor (${data.cards.length} < ${MIN_CARDS_TO_PUBLISH})`,
      date: dateKey,
      cardCount: data.cards.length,
    };
  }

  // 3. Per-card pipeline — sequential. Concurrency would be cheap network-
  // wise but Segmind's rate-limits are per-key, so sequential keeps us
  // well clear. ~8 cards × ~30-60s each = ~4-8 min total. Audit log
  // captures completion regardless of how long it took.
  const results: PerCardResult[] = [];
  for (const card of data.cards) {
    console.log(`[weekly-reel] ${card.certNumber}: grade=${card.grade} card=${card.cardName ?? "?"}`);
    const r = await processOne(card);
    results.push(r);
  }

  const successCount = results.filter(r => r.videoUrl !== null).length;
  const failCount = results.length - successCount;

  // 4. Persist manifest (always, even if all per-card calls failed — the
  // record itself is useful for debugging).
  const manifestKey = `videos/weekly-reels/draft-${dateKey}.json`;
  const manifest = {
    date: dateKey,
    generatedAt: new Date().toISOString(),
    prompt: VIDEO_PROMPT,
    cardCount: results.length,
    successCount,
    failCount,
    cards: results.map(r => ({
      certNumber: r.certNumber,
      grade: r.grade,
      cardName: r.cardName,
      videoUrl: r.videoUrl,
      error: r.error ?? undefined,
    })),
  };

  try {
    await uploadToR2(
      manifestKey,
      Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"),
      "application/json",
    );
  } catch (err: any) {
    console.error(`[weekly-reel] manifest upload failed: ${err?.message ?? err}`);
    // Continue — the audit log still goes through.
  }

  // 5. Audit log — one row per job run. entity_id is the date key so a
  // re-trigger on the same UTC day is recorded as a separate row but
  // the hasRunForDate idempotency check still catches it.
  try {
    await db.insert(auditLog).values({
      entityType: "weekly_reel",
      entityId: dateKey,
      action: "generated",
      adminUser: null,
      details: { cardCount: results.length, successCount, failCount },
    });
  } catch (err: any) {
    console.warn(`[weekly-reel] audit_log insert failed: ${err?.message ?? err}`);
  }

  console.log(`[weekly-reel] DONE date=${dateKey} cardCount=${results.length} ok=${successCount} fail=${failCount} manifest=${manifestKey}`);

  return {
    status: "ok",
    date: dateKey,
    manifestKey,
    cardCount: results.length,
    successCount,
    failCount,
    results,
  };
}

// ── Scheduler — Friday 18:00 UTC ────────────────────────────────────────────

let started = false;

export function startWeeklyReelScheduler(): void {
  if (started) {
    console.warn("[weekly-reel] Already started");
    return;
  }
  started = true;

  setTimeout(() => {
    const tick = async () => {
      if (!isFridayAtCronHourUtc()) return;
      try {
        const result = await runWeeklyReel();
        if (result.status === "skipped") {
          console.log(`[weekly-reel] Tick: skipped (${result.reason})`);
        } else if (result.status === "failed") {
          console.warn(`[weekly-reel] Tick: failed (${result.reason})`);
        } else {
          console.log(`[weekly-reel] Tick: ok (${result.successCount}/${result.cardCount} ok)`);
        }
      } catch (err: any) {
        console.error(`[weekly-reel] Tick crash: ${err?.message ?? err}`);
      }
    };
    void tick();
    setInterval(tick, TICK_INTERVAL_MS);
  }, BOOT_DELAY_MS);
}
