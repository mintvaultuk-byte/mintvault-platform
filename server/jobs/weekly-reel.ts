/**
 * Weekly grade-highlight reel job.
 *
 * Mirrors the ig-daily-post scheduler pattern (server/jobs/ig-daily-post.ts):
 *   - setInterval tick (hourly), day + hour gate, day-key idempotency.
 *   - Boot-delayed start so route registration finishes first.
 *
 * Every dial (schedule, selection rules, video style, output, notifications)
 * is read from pipeline_settings (server/lib/pipeline-settings.ts) at run-
 * time so the admin UI can live-edit behaviour without a redeploy.
 *
 * What it does:
 *   1. Fetch admin-featured top-N cards (server/ig/weekly-reel-data.ts) —
 *      respects min_grade, max_cards, sort_order, pin/blacklist.
 *   2. If fewer than 3 cards qualify → log + exit (skip the reel).
 *   3. For each card: presign the front PNG R2 URL, call Segmind with the
 *      configured model + clip length, collect output URL. If include_back
 *      is set, also call for the back PNG.
 *   4. Per-card errors are NON-FATAL — log and continue.
 *   5. Persist a JSON manifest at videos/weekly-reels/draft-{YYYY-MM-DD}.json.
 *   6. Write one audit_log row + one reel_analytics row.
 *   7. If notify_email / notify_webhook_url set, fire summary.
 *   8. If auto_post_instagram is set, kick off runIgDailyPost (best-effort).
 *
 * SEGMIND_API_KEY must be present in env. Pipeline can be paused via
 * pipeline_settings.pipeline_paused.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { auditLog, reelAnalytics } from "@shared/schema";
import { getR2SignedUrl, uploadToR2 } from "../r2";
import { fetchWeeklyReelData, type WeeklyReelCard } from "../ig/weekly-reel-data";
import { imageToVideo } from "../lib/segmind-client";
import { getAllSettings, type PipelineSettings } from "../lib/pipeline-settings";
import { sendReelSummaryEmail, postReelWebhook } from "../lib/reel-notifications";

const MIN_CARDS_TO_PUBLISH = 3;
const TICK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BOOT_DELAY_MS = 120 * 1000;        // 2 min after boot
const SOURCE_URL_TTL_SECONDS = 60 * 60;  // 1h presign

/** Per-generation cost in USD. Segmind hfai-dop-lite list price = $0.40. */
export const COST_PER_GENERATION = 0.40;

export interface PerCardResult {
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  videoUrl: string | null;
  backVideoUrl?: string | null;
  error?: string;
}

export interface WeeklyReelOutput {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  date?: string;
  manifestKey?: string;
  cardCount?: number;
  successCount?: number;
  failCount?: number;
  results?: PerCardResult[];
}

function utcDateKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isScheduledMoment(settings: PipelineSettings, date: Date = new Date()): boolean {
  return date.getUTCDay() === settings.schedule_day
      && date.getUTCHours() === settings.schedule_hour_utc;
}

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

async function processOne(card: WeeklyReelCard, settings: PipelineSettings): Promise<PerCardResult> {
  const base: PerCardResult = {
    certNumber: card.certNumber,
    grade: card.grade,
    cardName: card.cardName,
    videoUrl: null,
  };
  try {
    const sourceUrl = await getR2SignedUrl(card.frontPngKey, SOURCE_URL_TTL_SECONDS);
    const videoUrl = await imageToVideo(sourceUrl, settings.video_prompt, {
      model: settings.video_model,
      clipLengthSeconds: settings.clip_length_seconds,
    });
    let backVideoUrl: string | null | undefined = undefined;
    if (settings.include_back) {
      try {
        const backSource = await getR2SignedUrl(card.backPngKey, SOURCE_URL_TTL_SECONDS);
        backVideoUrl = await imageToVideo(backSource, settings.video_prompt, {
          model: settings.video_model,
          clipLengthSeconds: settings.clip_length_seconds,
        });
      } catch (err: any) {
        console.warn(`[weekly-reel] ${card.certNumber}: back-image failed — ${err?.message ?? err}`);
        backVideoUrl = null;
      }
    }
    return { ...base, videoUrl, backVideoUrl };
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    console.warn(`[weekly-reel] ${card.certNumber}: segmind failed — ${detail}`);
    return { ...base, error: detail };
  }
}

/** Substitute caption-template variables. Mirrors what the spec lists:
 *  {{topGrade}}, {{cardCount}}, {{date}}, {{topCard}}. Unknown variables
 *  are left as-is so the operator can spot typos. */
export function applyCaptionTemplate(
  template: string,
  vars: { topGrade: string; cardCount: number; date: string; topCard: string },
): string {
  return template
    .replace(/\{\{\s*topGrade\s*\}\}/g, vars.topGrade)
    .replace(/\{\{\s*cardCount\s*\}\}/g, String(vars.cardCount))
    .replace(/\{\{\s*date\s*\}\}/g, vars.date)
    .replace(/\{\{\s*topCard\s*\}\}/g, vars.topCard);
}

export async function runWeeklyReel(opts: { force?: boolean } = {}): Promise<WeeklyReelOutput> {
  const dateKey = utcDateKey();
  const settings = await getAllSettings();

  if (settings.pipeline_paused && !opts.force) {
    console.log("[weekly-reel] pipeline paused — skipping");
    return { status: "skipped", reason: "pipeline-paused", date: dateKey };
  }

  if (!opts.force && await hasRunForDate(dateKey)) {
    console.log(`[weekly-reel] already-generated-today (${dateKey}) — skipping`);
    return { status: "skipped", reason: "already-generated-today", date: dateKey };
  }

  if (!process.env.SEGMIND_API_KEY) {
    console.warn("[weekly-reel] SEGMIND_API_KEY missing — exiting without API calls");
    return { status: "failed", reason: "segmind-key-missing", date: dateKey };
  }

  // 1. Fetch admin-featured top-N
  let data;
  try {
    data = await fetchWeeklyReelData();
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    console.error(`[weekly-reel] data fetch failed: ${detail}`);
    return { status: "failed", reason: `fetch-data: ${detail}`, date: dateKey };
  }

  console.log(`[weekly-reel] featured graded certs: ${data.totalFeatured}; picking ${data.cards.length}`);

  // 2. Floor
  if (data.cards.length < MIN_CARDS_TO_PUBLISH) {
    console.warn(`[weekly-reel] only ${data.cards.length} card(s) — below floor of ${MIN_CARDS_TO_PUBLISH}`);
    return {
      status: "skipped",
      reason: `below-floor (${data.cards.length} < ${MIN_CARDS_TO_PUBLISH})`,
      date: dateKey,
      cardCount: data.cards.length,
    };
  }

  // 3. Per-card pipeline
  const results: PerCardResult[] = [];
  for (const card of data.cards) {
    console.log(`[weekly-reel] ${card.certNumber}: grade=${card.grade} card=${card.cardName ?? "?"}${card.pinned ? " [PINNED]" : ""}`);
    const r = await processOne(card, settings);
    results.push(r);
  }

  const successCount = results.filter(r => r.videoUrl !== null).length;
  const failCount = results.length - successCount;

  // Caption (substituted) — stored in manifest for downstream consumers.
  const top = results.find(r => r.videoUrl != null) ?? results[0];
  const caption = applyCaptionTemplate(settings.caption_template, {
    topGrade: top?.grade != null ? String(top.grade) : "—",
    cardCount: results.length,
    date: dateKey,
    topCard: top?.cardName ?? top?.certNumber ?? "—",
  });

  // 4. Persist manifest
  const manifestKey = `videos/weekly-reels/draft-${dateKey}.json`;
  const manifest = {
    date: dateKey,
    generatedAt: new Date().toISOString(),
    prompt: settings.video_prompt,
    model: settings.video_model,
    clipLengthSeconds: settings.clip_length_seconds,
    includeBack: settings.include_back,
    outputResolution: settings.output_resolution,
    watermarkEnabled: settings.watermark_enabled,
    caption,
    cardCount: results.length,
    successCount,
    failCount,
    cards: results.map(r => ({
      certNumber: r.certNumber,
      grade: r.grade,
      cardName: r.cardName,
      videoUrl: r.videoUrl,
      backVideoUrl: r.backVideoUrl ?? null,
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
  }

  // 5. Audit log
  try {
    await db.insert(auditLog).values({
      entityType: "weekly_reel",
      entityId: dateKey,
      action: "generated",
      adminUser: null,
      details: {
        cardCount: results.length,
        successCount,
        failCount,
        model: settings.video_model,
        clipLengthSeconds: settings.clip_length_seconds,
      },
    });
  } catch (err: any) {
    console.warn(`[weekly-reel] audit_log insert failed: ${err?.message ?? err}`);
  }

  // 6. Analytics row — cost is per-generation × (cards + back clips)
  const totalGenerations = successCount + (settings.include_back
    ? results.filter(r => r.backVideoUrl != null).length
    : 0);
  const estimatedCost = totalGenerations * COST_PER_GENERATION;
  try {
    await db.insert(reelAnalytics).values({
      reelDate: dateKey,
      cardCount: results.length,
      successCount,
      failCount,
      estimatedCostUsd: estimatedCost.toFixed(4),
      model: settings.video_model,
      clipLengthSeconds: settings.clip_length_seconds,
    });
  } catch (err: any) {
    console.warn(`[weekly-reel] reel_analytics insert failed: ${err?.message ?? err}`);
  }

  // 7. Notifications — fire-and-forget; failures only warn.
  const summary = {
    date: dateKey,
    status: failCount > 0 && successCount === 0 ? "failed" as const
          : failCount > 0 ? "partial" as const
          : "ok" as const,
    cardCount: results.length,
    successCount,
    failCount,
    manifestKey,
  };
  if (settings.notify_email) {
    try { await sendReelSummaryEmail(settings.notify_email, summary); }
    catch (err: any) { console.warn(`[weekly-reel] notify_email failed: ${err?.message ?? err}`); }
  }
  if (settings.notify_webhook_url) {
    try { await postReelWebhook(settings.notify_webhook_url, summary); }
    catch (err: any) { console.warn(`[weekly-reel] notify_webhook failed: ${err?.message ?? err}`); }
  }

  // 8. Auto-post to Instagram (best-effort). Reel job and IG-daily-post are
  // separate pipelines; this just kicks the latter once the reel is in
  // hand. Failure here does not affect the reel result.
  if (settings.auto_post_instagram) {
    try {
      const { runIgDailyPost } = await import("./ig-daily-post");
      const r = await runIgDailyPost({ force: true });
      console.log(`[weekly-reel] auto_post_instagram → ig-daily-post status=${r.status}`);
    } catch (err: any) {
      console.warn(`[weekly-reel] auto-post failed: ${err?.message ?? err}`);
    }
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

// ── Scheduler ──────────────────────────────────────────────────────────────

let started = false;

export function startWeeklyReelScheduler(): void {
  if (started) {
    console.warn("[weekly-reel] Already started");
    return;
  }
  started = true;

  setTimeout(() => {
    const tick = async () => {
      const settings = await getAllSettings();
      if (settings.pipeline_paused) {
        // Silent on the tick — pause is expected admin state.
        return;
      }
      if (!isScheduledMoment(settings)) return;
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
