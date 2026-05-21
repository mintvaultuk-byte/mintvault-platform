/**
 * pipeline_settings — generic key/value JSON store backing the weekly-reel
 * admin page. Every toggle/dropdown on /admin/weekly-reel reads + writes
 * through here.
 *
 * Defaults are baked into PIPELINE_DEFAULTS below so the page works
 * out-of-the-box with zero rows in the table. setSetting() is upsert.
 *
 * Type model: callers know the shape of each key. We store as jsonb and
 * cast at the boundary. No schema validation here — the route layer
 * sanitises before calling setSetting.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";

export type SortOrder = "grade_desc" | "value_desc" | "newest_first";

export interface PipelineSettings {
  // Schedule
  schedule_day: number;            // 0=Sun … 6=Sat — default 5 (Fri)
  schedule_hour_utc: number;       // 0–23 — default 18
  pipeline_paused: boolean;        // default false
  // Card selection
  min_grade: number;               // 0–10, 0 = any — default 0
  max_cards: number;               // 3–8 — default 8
  sort_order: SortOrder;           // default "grade_desc"
  // Video style
  video_prompt: string;
  video_model: string;             // segmind slug — default "hfai-dop-lite"
  clip_length_seconds: 4 | 6 | 8;  // default 6
  include_back: boolean;           // default false
  // Output & publishing
  auto_post_instagram: boolean;    // default false
  caption_template: string;
  output_resolution: 720 | 1080;   // default 1080
  watermark_enabled: boolean;      // default false
  // Notifications
  notify_email: string;            // empty string = disabled
  notify_webhook_url: string;      // empty string = disabled
}

export const PIPELINE_DEFAULTS: PipelineSettings = {
  schedule_day: 5,
  schedule_hour_utc: 18,
  pipeline_paused: false,
  min_grade: 0,
  max_cards: 8,
  sort_order: "grade_desc",
  video_prompt:
    "Cinematic slow reveal of a graded trading card slab, gold accents, dark vault background, premium quality",
  video_model: "hfai-dop-lite",
  clip_length_seconds: 6,
  include_back: false,
  auto_post_instagram: false,
  caption_template:
    "This week's top grades: {{topCard}} earned a {{topGrade}}. {{cardCount}} cards featured — {{date}}.",
  output_resolution: 1080,
  watermark_enabled: false,
  notify_email: "",
  notify_webhook_url: "",
};

export type SettingKey = keyof PipelineSettings;

/** Fetch a single setting. Returns `defaultValue` if the row is absent or
 *  the table itself is missing (defensive — the migration may not have
 *  run yet in a dev environment). */
export async function getSetting<K extends SettingKey>(
  key: K,
  defaultValue: PipelineSettings[K],
): Promise<PipelineSettings[K]> {
  try {
    const r = await db.execute(sql`
      SELECT value FROM pipeline_settings WHERE key = ${key} LIMIT 1
    `);
    const row = r.rows[0] as { value: unknown } | undefined;
    if (!row) return defaultValue;
    return row.value as PipelineSettings[K];
  } catch {
    return defaultValue;
  }
}

/** Fetch every known setting as a merged record. Missing keys fall back to
 *  PIPELINE_DEFAULTS, so the result is always fully-populated. */
export async function getAllSettings(): Promise<PipelineSettings> {
  let rows: Array<{ key: string; value: unknown }> = [];
  try {
    const r = await db.execute(sql`SELECT key, value FROM pipeline_settings`);
    rows = r.rows as Array<{ key: string; value: unknown }>;
  } catch {
    return { ...PIPELINE_DEFAULTS };
  }
  const out: PipelineSettings = { ...PIPELINE_DEFAULTS };
  for (const row of rows) {
    if (row.key in PIPELINE_DEFAULTS) {
      (out as any)[row.key] = row.value;
    }
  }
  return out;
}

/** Upsert a setting. updatedBy is opaque (we store whatever the caller
 *  passes — admin email is typical). */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: PipelineSettings[K],
  updatedBy?: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO pipeline_settings (key, value, updated_at, updated_by)
    VALUES (${key}, ${JSON.stringify(value)}::jsonb, NOW(), ${updatedBy ?? null})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
  `);
}
