/**
 * Daily Instagram post cron.
 *
 * Matches the existing cron pattern (server/index.ts L393-411) — no pg-boss,
 * no new deps. Strategy: a 1-hour-interval setInterval tick that checks
 * whether we're inside the "post window" (10:00–11:00 Europe/London) and
 * whether we've already posted today. If both conditions hold, generate +
 * (optionally) publish.
 *
 * The "have we already posted today" check reads ig_post_queue and skips
 * if a row with status='posted' or 'failed' or 'skipped' exists for today.
 * This makes the cron idempotent: even if the interval fires multiple
 * times inside the post window we only ever post once per UK day.
 *
 * Wiring: server/index.ts should call `startIgDailyPostScheduler()` at
 * boot, after a delay (matches the embed-corpus pattern).
 *
 * Gating: this is a no-op if MINTVAULT_DATABASE_URL or R2 credentials are
 * absent (e.g. during local dev without a full env). It NEVER posts unless
 * IG_POST_ENABLED === "true" — see meta-poster.ts for the actual gate.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { igPostQueue, igSettings, IG_POST_TYPES, type IgPostType } from "@shared/schema";
import { fetchPostData, selectPostType } from "../ig/data-fetcher";
import { generateIgImage } from "../ig/image-generator";
import { generateCaption } from "../ig/caption-generator";
import { postToInstagram } from "../ig/meta-poster";
import { uploadToR2 } from "../r2";
import { storage } from "../storage";

// 1 hour. With the post window being a 1-hour band, this gives us at least
// one tick inside the window every day, plus idempotency from the
// "already posted today?" check.
const TICK_INTERVAL_MS = 60 * 60 * 1000;

// Boot delay so route registration finishes first. Matches embed-corpus.
const BOOT_DELAY_MS = 90 * 1000;

// Post window: 10:00–11:00 Europe/London.
const POST_WINDOW_HOUR_LONDON = 10;

function nowInLondonHour(date: Date = new Date()): number {
  // Intl.DateTimeFormat with Europe/London handles BST/GMT automatically.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    hour12: false,
    timeZone: "Europe/London",
  });
  const hourStr = fmt.format(date);     // "10" / "23" / "00"
  return parseInt(hourStr, 10);
}

function londonDateKey(date: Date = new Date()): string {
  // YYYY-MM-DD in London time. Used to check "have we posted today already".
  const fmt = new Intl.DateTimeFormat("en-GB", {
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
    timeZone: "Europe/London",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function hasPostedToday(londonDay: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: igPostQueue.id })
      .from(igPostQueue)
      .where(and(
        sql`to_char(${igPostQueue.scheduledFor} AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') = ${londonDay}`,
        sql`${igPostQueue.status} IN ('posted','failed','skipped','ready','generating')`,
        isNull(igPostQueue.deletedAt),
      ))
      .limit(1);
    return rows.length > 0;
  } catch (err: any) {
    // ig_post_queue missing on this branch — log and assume "not posted",
    // which is conservative for dev environments. Production will have the
    // table after the migration is applied.
    console.warn(`[ig-cron] hasPostedToday lookup failed: ${err?.message ?? err}. Assuming false.`);
    return false;
  }
}

async function isPostingEnabled(): Promise<boolean> {
  // Two gates, both must be true for live publish:
  //   1. IG_POST_ENABLED=true env var (controlled outside the app — fly secrets)
  //   2. ig_settings.post_enabled=true (admin-UI live toggle)
  // The env-var gate is also enforced inside meta-poster.ts so the bot stays
  // silent even if this DB lookup races.
  if (process.env.IG_POST_ENABLED !== "true") return false;
  try {
    const rows = await db.select().from(igSettings).orderBy(igSettings.id).limit(1);
    return !!rows[0]?.postEnabled;
  } catch {
    return false;
  }
}

export async function runIgDailyPost(
  opts: { force?: boolean; postTypeOverride?: IgPostType } = {},
): Promise<{ status: string; postType?: IgPostType; queueId?: number; metaPostId?: string; reason?: string }> {
  const londonDay = londonDateKey();

  if (!opts.force) {
    if (await hasPostedToday(londonDay)) {
      return { status: "skipped", reason: "already-posted-today" };
    }
  }

  // Admin-override path: caller (POST /api/admin/ig/post-now) can pin the
  // post type. Cron never passes postTypeOverride, so day-of-week rotation
  // is preserved for the scheduled tick.
  let postType: IgPostType;
  let tierId: string | undefined;
  if (opts.postTypeOverride && (IG_POST_TYPES as readonly string[]).includes(opts.postTypeOverride)) {
    postType = opts.postTypeOverride;
    // service_explainer still needs a tier; use this week's rotation pick
    // so admin overrides don't have to also pick a tier.
    if (postType === "service_explainer") {
      tierId = selectPostType().tierId;
    }
    console.log(`[ig-cron] Admin override → post type: ${postType}${tierId ? ` (tier=${tierId})` : ""}`);
  } else {
    const sel = selectPostType();
    postType = sel.postType;
    tierId = sel.tierId;
    console.log(`[ig-cron] Selected post type: ${postType}${tierId ? ` (tier=${tierId})` : ""}`);
  }

  // 1. Fetch data
  let data;
  try {
    data = await fetchPostData(postType, { tierId });
  } catch (err: any) {
    console.error(`[ig-cron] fetchPostData failed: ${err?.message ?? err}`);
    return { status: "failed", reason: `fetch-data: ${err?.message ?? err}` };
  }

  // 2. Generate image
  const imageBuffer = await generateIgImage(data);

  // 3. Upload to R2
  const r2Key = `ig/${postType}/${Date.now()}.png`;
  try {
    await uploadToR2(r2Key, imageBuffer, "image/png");
  } catch (err: any) {
    console.error(`[ig-cron] R2 upload failed: ${err?.message ?? err}`);
    return { status: "failed", reason: `r2-upload: ${err?.message ?? err}` };
  }

  // 4. Generate caption
  const { caption, hashtags, fromFallback } = await generateCaption(data);
  if (fromFallback) {
    console.warn("[ig-cron] Using fallback caption — Anthropic call failed or key missing.");
  }

  // 5. Insert queue row
  const certPk = (data as any)._certPk ?? null;
  let queuedId: number;
  try {
    const [queued] = await db.insert(igPostQueue).values({
      scheduledFor:  new Date(),
      postType,
      certId:        certPk,
      imageR2Key:    r2Key,
      caption,
      hashtags,
      status:        "ready",
    }).returning({ id: igPostQueue.id });
    queuedId = queued.id;
  } catch (err: any) {
    // Likely ig_post_queue missing — return a marker so the dry-run CLI
    // can still complete without DB writes.
    console.error(`[ig-cron] queue insert failed: ${err?.message ?? err}`);
    return { status: "failed", reason: `queue-insert: ${err?.message ?? err}` };
  }

  // Stable audit-log metadata for every status transition on this run.
  const overrideMeta = opts.postTypeOverride ? { override_type: opts.postTypeOverride } : {};

  try { await storage.writeAuditLog("ig_post", String(queuedId), "ready", null, { postType, certPk, r2Key, ...overrideMeta }); } catch {}

  // 6. Decide: live publish or dry-run?
  const enabled = await isPostingEnabled();
  if (!enabled) {
    await db.update(igPostQueue)
      .set({ status: "ready", errorDetail: "IG_POST_ENABLED gate closed or admin toggle off" })
      .where(eq(igPostQueue.id, queuedId));
    try { await storage.writeAuditLog("ig_post", String(queuedId), "dry-run", null, { postType, certPk, ...overrideMeta }); } catch {}
    console.log(`[ig-cron] Dry-run only — queue row ${queuedId} left in 'ready' state.`);
    return { status: "dry-run", postType, queueId: queuedId };
  }

  // 7. Publish
  try {
    const result = await postToInstagram({ imageBuffer, caption, hashtags, r2Key });
    const metaPostId = result.metaPostId;
    await db.update(igPostQueue)
      .set({ status: "posted", metaPostId, postedAt: new Date() })
      .where(eq(igPostQueue.id, queuedId));
    try { await storage.writeAuditLog("ig_post", String(queuedId), "posted", null, { postType, certPk, metaPostId, ...overrideMeta }); } catch {}
    console.log(`[ig-cron] Posted — queue=${queuedId} meta=${metaPostId}`);
    return { status: "posted", postType, queueId: queuedId, metaPostId };
  } catch (err: any) {
    const detail = String(err?.message ?? err);
    await db.update(igPostQueue)
      .set({ status: "failed", errorDetail: detail })
      .where(eq(igPostQueue.id, queuedId));
    try { await storage.writeAuditLog("ig_post", String(queuedId), "failed", null, { postType, certPk, error: detail, ...overrideMeta }); } catch {}
    console.error(`[ig-cron] Publish failed for queue=${queuedId}: ${detail}`);
    return { status: "failed", postType, queueId: queuedId, reason: detail };
  }
}

// ── Scheduler — call this once at boot ─────────────────────────────────────

let started = false;

export function startIgDailyPostScheduler(): void {
  if (started) {
    console.warn("[ig-cron] Already started");
    return;
  }
  started = true;

  setTimeout(() => {
    const tick = async () => {
      const hour = nowInLondonHour();
      if (hour !== POST_WINDOW_HOUR_LONDON) {
        // Outside window — silent.
        return;
      }
      try {
        const result = await runIgDailyPost();
        if (result.status === "skipped") {
          console.log("[ig-cron] Tick: already-posted-today (skipped)");
        } else if (result.status === "dry-run") {
          console.log("[ig-cron] Tick: dry-run completed");
        } else {
          console.log(`[ig-cron] Tick: ${result.status} (${result.postType})`);
        }
      } catch (err: any) {
        console.error(`[ig-cron] Tick failed: ${err?.message ?? err}`);
      }
    };

    // Run immediately on boot, then every TICK_INTERVAL_MS thereafter.
    void tick();
    setInterval(tick, TICK_INTERVAL_MS);
  }, BOOT_DELAY_MS);
}
