/**
 * /admin/weekly-reel — operator view of the weekly grade-highlights pipeline.
 *
 * Sections:
 *   1. Pipeline Controls — manual trigger, key status, schedule (day/hour),
 *      Pause toggle.
 *   2. Selection Rules — min grade, max cards, sort order.
 *   3. Video Style — prompt, model, clip length, front/back.
 *   4. Output & Publishing — auto-post, caption template, resolution, watermark.
 *   5. Notifications — email + webhook + test webhook.
 *   6. Featured Cards — single table with Featured/Pinned columns. Pinned
 *      cards always go first in the reel.
 *   7. Blacklisted — collapsed at bottom.
 *   8. Reel History — last 10 runs, download + re-run.
 *   9. Analytics — running cost, table, bar chart.
 *
 * All settings persist via /api/admin/weekly-reel/settings. Defaults baked
 * in server-side (PIPELINE_DEFAULTS) so the page works with zero rows.
 *
 * Styling matches admin-dashboard.tsx — gold #D4AF37 accents on #FAFAF8 bg.
 */

import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Loader2, PlayCircle, KeyRound, Calendar, CheckCircle2, XCircle,
  AlertTriangle, ChevronDown, ChevronUp, Pin, Ban, Download, RotateCcw, Pause,
  Instagram, Facebook, Music, Image as ImageIcon, Send, RefreshCw, Check,
  Upload, Sparkles,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────────────

type SortOrder = "grade_desc" | "value_desc" | "newest_first";
type TiktokPrivacy = "PUBLIC_TO_EVERYONE" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
type TransitionStyle = "cut" | "dissolve" | "zoom";

interface PipelineSettings {
  schedule_day: number;
  schedule_hour_utc: number;
  pipeline_paused: boolean;
  smart_schedule: boolean;
  min_grade: number;
  max_cards: number;
  sort_order: SortOrder;
  video_prompt: string;
  video_model: string;
  clip_length_seconds: 4 | 6 | 8;
  include_back: boolean;
  auto_post_instagram: boolean;
  caption_template: string;
  output_resolution: 720 | 1080;
  watermark_enabled: boolean;
  auto_post_instagram_video: boolean;
  auto_post_facebook: boolean;
  instagram_draft_mode: boolean;
  post_delay_minutes: number;
  auto_post_tiktok: boolean;
  tiktok_privacy: TiktokPrivacy;
  tiktok_disable_duet: boolean;
  tiktok_disable_stitch: boolean;
  intro_video_r2_key: string;
  outro_video_r2_key: string;
  background_music_r2_key: string;
  text_overlay_enabled: boolean;
  text_overlay_format: string;
  transition_style: TransitionStyle;
  require_card_approval: boolean;
  auto_generate_thumbnail: boolean;
  notify_card_owners: boolean;
  notify_email: string;
  notify_webhook_url: string;
}

interface MetaStatus {
  valid: boolean;
  expiresAt: string | null;
  scopes: string[];
  igUserId: string | null;
  fbPageId: string | null;
}
interface TiktokStatus {
  valid: boolean;
  expiresAt: string | null;
  openId: string | null;
}
interface ApprovalCard {
  certNumber: string;
  approved: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

interface FeaturedCard {
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  cardSet: string | null;
  year: string | null;
  featured: boolean;
  featuredAt: string | null;
  pinned: boolean;
  blacklisted: boolean;
}

interface ManifestCard {
  certNumber: string;
  grade: number | null;
  cardName: string | null;
  videoUrl: string | null;
  backVideoUrl?: string | null;
  error?: string;
}

interface HistoryEntry {
  date: string;
  createdAt: string;
  status: "ok" | "partial" | "failed" | "unknown";
  cardCount: number;
  successCount: number;
  failCount: number;
  manifestKey: string;
  manifestPresent: boolean;
  cards: ManifestCard[];
  model?: string;
  clipLengthSeconds?: number;
}

interface KeyStatus { configured: boolean }
interface GenerateResult {
  status: "ok" | "skipped" | "failed";
  reason?: string;
  date?: string;
  cardCount?: number;
  successCount?: number;
  failCount?: number;
  manifestKey?: string;
}

interface AnalyticsRow {
  reelDate: string;
  cardCount: number;
  successCount: number;
  failCount: number;
  estimatedCostUsd: number;
  model: string | null;
  clipLengthSeconds: number | null;
  createdAt: string;
  instagramPostId: string | null;
  facebookPostId: string | null;
  tiktokPostId: string | null;
  instagramLikes: number | null;
  instagramViews: number | null;
  instagramReach: number | null;
  instagramComments: number | null;
  thumbnailR2Key: string | null;
}
interface AnalyticsResp { rows: AnalyticsRow[]; totalCostUsd: number }

// ── Helpers ────────────────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MODEL_OPTIONS: Array<{ slug: string; label: string }> = [
  { slug: "hfai-dop-lite", label: "Higgsfield dop-lite" },
  { slug: "seedance-1-5",  label: "Seedance 1.5" },
  { slug: "kling-2-6",     label: "Kling 2.6" },
  { slug: "wan-2-6",       label: "Wan 2.6" },
];

function fmtGrade(g: number | null): string {
  if (g == null) return "—";
  return g % 1 === 0 ? String(Math.trunc(g)) : String(g);
}
function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return s; }
}
function statusBadge(s: HistoryEntry["status"]): { label: string; cls: string } {
  switch (s) {
    case "ok":      return { label: "OK",      cls: "bg-emerald-50 text-emerald-700 border-emerald-200" };
    case "partial": return { label: "Partial", cls: "bg-amber-50    text-amber-700    border-amber-200" };
    case "failed":  return { label: "Failed",  cls: "bg-red-50      text-red-700      border-red-200" };
    default:        return { label: "Unknown", cls: "bg-[#F5F2EB]   text-[#666666]    border-[#E8E4DC]" };
  }
}

// ── Settings hook ──────────────────────────────────────────────────────────

function useSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ settings: PipelineSettings }>({
    queryKey: ["/api/admin/weekly-reel/settings"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/settings")).json(),
  });
  const mutation = useMutation({
    mutationFn: async ({ key, value }: { key: keyof PipelineSettings; value: any }) => {
      const r = await apiRequest("PATCH", "/api/admin/weekly-reel/settings", { key, value });
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/settings"] }),
  });
  return { settings: data?.settings, isLoading, update: mutation.mutate, updating: mutation.isPending };
}

// ── Section 1: Pipeline Controls + Schedule + Pause ────────────────────────

function PipelineControls({ paused }: { paused: boolean }) {
  const queryClient = useQueryClient();
  const [generateResult, setGenerateResult] = useState<GenerateResult | string | null>(null);

  const { data: keyStatus } = useQuery<KeyStatus>({
    queryKey: ["/api/admin/weekly-reel/key-status"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/key-status")).json(),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/weekly-reel/generate");
      return r.json();
    },
    onSuccess: (data: GenerateResult) => {
      setGenerateResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/analytics"] });
    },
    onError: (err: any) => {
      setGenerateResult(err?.message
        ? `Request error: ${err.message} — the job may still be running. Refresh history in a few minutes.`
        : "Request error — the job may still be running on the server.");
    },
  });

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Pipeline Controls</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 text-[#666666] text-xs uppercase tracking-wider mb-1">
            <PlayCircle size={14} className="text-[#D4AF37]" /> Manual trigger
          </div>
          <button
            type="button"
            onClick={() => { setGenerateResult(null); generateMutation.mutate(); }}
            disabled={generateMutation.isPending || paused}
            className="mt-2 w-full inline-flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-wider px-4 py-2 rounded-lg transition-all bg-gradient-to-r from-[#D4AF37] to-[#B8960C] text-[#1A1400] hover:opacity-90 disabled:opacity-50"
            data-testid="btn-generate-reel"
          >
            {generateMutation.isPending
              ? <><Loader2 size={12} className="animate-spin" /> Generating…</>
              : paused ? "Paused"
              : "Generate Reel Now"}
          </button>
          <p className="mt-2 text-[10px] text-[#888888]">
            Long-running — Segmind ~30-60 s per card. Connection may time out before completion.
          </p>
        </div>

        <ScheduleCard />

        <div className="border border-[#E8E4DC] rounded-xl p-4">
          <div className="flex items-center gap-2 text-[#666666] text-xs uppercase tracking-wider mb-1">
            <KeyRound size={14} className="text-[#D4AF37]" /> Segmind key
          </div>
          {keyStatus === undefined ? (
            <p className="mt-2 text-sm text-[#888888]"><Loader2 size={12} className="animate-spin inline" /> checking…</p>
          ) : keyStatus.configured ? (
            <p className="mt-2 text-sm font-semibold text-emerald-700 flex items-center gap-1">
              <CheckCircle2 size={14} /> Key configured
            </p>
          ) : (
            <p className="mt-2 text-sm font-semibold text-red-700 flex items-center gap-1">
              <XCircle size={14} /> Key missing
            </p>
          )}
          <p className="mt-1 text-[10px] text-[#888888]">Set via <code>fly secrets set SEGMIND_API_KEY=…</code></p>
        </div>
      </div>

      <PauseToggleRow />

      {generateResult !== null && (
        <div
          className={`mt-4 text-sm rounded-lg p-3 border ${
            typeof generateResult === "string"
              ? "bg-amber-50 text-amber-800 border-amber-200"
              : generateResult.status === "ok"
                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                : generateResult.status === "skipped"
                  ? "bg-[#F5F2EB] text-[#555] border-[#E8E4DC]"
                  : "bg-red-50 text-red-800 border-red-200"
          }`}
          data-testid="text-generate-result"
        >
          {typeof generateResult === "string" ? generateResult : (
            <>
              <strong>{generateResult.status.toUpperCase()}</strong>
              {generateResult.reason && <> — {generateResult.reason}</>}
              {generateResult.date && <> — {generateResult.date}</>}
              {typeof generateResult.successCount === "number" && (
                <> — {generateResult.successCount}/{generateResult.cardCount} ok, {generateResult.failCount} failed</>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ScheduleCard() {
  const { settings, update } = useSettings();
  const { data: meta } = useQuery<MetaStatus>({
    queryKey: ["/api/admin/weekly-reel/meta-status"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/meta-status")).json(),
  });
  // Peak-hour preview isn't exposed by a dedicated endpoint; we show a
  // hint once smart schedule is on so the operator knows what to expect.
  if (!settings) {
    return (
      <div className="border border-[#E8E4DC] rounded-xl p-4">
        <div className="flex items-center gap-2 text-[#666666] text-xs uppercase tracking-wider mb-1">
          <Calendar size={14} className="text-[#D4AF37]" /> Schedule (UTC)
        </div>
        <p className="mt-2 text-sm text-[#888888]"><Loader2 size={12} className="animate-spin inline" /> loading…</p>
      </div>
    );
  }
  return (
    <div className="border border-[#E8E4DC] rounded-xl p-4">
      <div className="flex items-center gap-2 text-[#666666] text-xs uppercase tracking-wider mb-1">
        <Calendar size={14} className="text-[#D4AF37]" /> Schedule (UTC)
      </div>
      <div className="mt-2 flex items-center gap-2">
        <select
          value={settings.schedule_day}
          onChange={(e) => update({ key: "schedule_day", value: Number(e.target.value) })}
          className="text-xs border border-[#E8E4DC] rounded px-2 py-1 bg-white"
          data-testid="select-schedule-day"
        >
          {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
        </select>
        <select
          value={settings.schedule_hour_utc}
          onChange={(e) => update({ key: "schedule_hour_utc", value: Number(e.target.value) })}
          disabled={settings.smart_schedule}
          className="text-xs border border-[#E8E4DC] rounded px-2 py-1 bg-white disabled:opacity-50"
          data-testid="select-schedule-hour"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
          ))}
        </select>
      </div>
      <label className="mt-2 inline-flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.smart_schedule}
          onChange={() => update({ key: "smart_schedule", value: !settings.smart_schedule })}
          className="accent-[#D4AF37] h-3 w-3"
          data-testid="check-smart-schedule"
        />
        <span className="text-[10px] text-[#666] inline-flex items-center gap-1">
          <Sparkles size={10} className="text-[#D4AF37]" /> Smart schedule (IG peak)
        </span>
      </label>
      {settings.smart_schedule && (
        <p className="mt-1 text-[10px] text-[#888]">
          {meta?.valid
            ? "Posts at the IG-insights peak hour of the day."
            : <span className="text-amber-700">Connect Meta to read peak hour.</span>}
        </p>
      )}
      <p className="mt-1 text-[10px] text-[#888888]">Skipped if fewer than 3 featured cards.</p>
    </div>
  );
}

function PauseToggleRow() {
  const { settings, update, updating } = useSettings();
  if (!settings) return null;
  const paused = settings.pipeline_paused;
  return (
    <div className={`mt-4 flex items-center justify-between rounded-xl p-3 border ${
      paused ? "bg-red-50 border-red-200" : "bg-[#FAFAF8] border-[#E8E4DC]"
    }`}>
      <div className="flex items-center gap-2 text-sm">
        <Pause size={14} className={paused ? "text-red-700" : "text-[#888]"} />
        <span className={paused ? "text-red-800 font-semibold" : "text-[#555]"}>
          {paused ? "Pipeline is PAUSED — scheduler will not run." : "Pipeline running on schedule."}
        </span>
      </div>
      <button
        type="button"
        onClick={() => update({ key: "pipeline_paused", value: !paused })}
        disabled={updating}
        className={`text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg transition-all ${
          paused
            ? "bg-emerald-600 text-white hover:bg-emerald-700"
            : "bg-red-600 text-white hover:bg-red-700"
        } disabled:opacity-50`}
        data-testid="btn-toggle-pause"
      >
        {paused ? "Resume" : "Pause Pipeline"}
      </button>
    </div>
  );
}

// ── Section 2: Selection Rules ─────────────────────────────────────────────

function SelectionRules() {
  const { settings, update } = useSettings();
  if (!settings) return null;
  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Selection Rules</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[#888]">
            Min grade — {settings.min_grade === 0 ? "Any grade" : settings.min_grade}
          </label>
          <input
            type="range" min={0} max={10} step={1}
            value={settings.min_grade}
            onChange={(e) => update({ key: "min_grade", value: Number(e.target.value) })}
            className="w-full mt-2 accent-[#D4AF37]"
            data-testid="slider-min-grade"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[#888]">
            Max cards — {settings.max_cards}
          </label>
          <input
            type="range" min={3} max={8} step={1}
            value={settings.max_cards}
            onChange={(e) => update({ key: "max_cards", value: Number(e.target.value) })}
            className="w-full mt-2 accent-[#D4AF37]"
            data-testid="slider-max-cards"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[#888]">Sort order</label>
          <select
            value={settings.sort_order}
            onChange={(e) => update({ key: "sort_order", value: e.target.value })}
            className="mt-2 w-full text-sm border border-[#E8E4DC] rounded px-2 py-1.5 bg-white"
            data-testid="select-sort-order"
          >
            <option value="grade_desc">Grade ↓</option>
            <option value="value_desc">Declared Value ↓</option>
            <option value="newest_first">Newest First</option>
          </select>
        </div>
      </div>
    </div>
  );
}

// ── Section 3: Video Style ─────────────────────────────────────────────────

function VideoStyle() {
  const { settings, update } = useSettings();
  const [draftPrompt, setDraftPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (settings && draftPrompt === null) setDraftPrompt(settings.video_prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.video_prompt]);

  if (!settings) return null;
  const dirty = draftPrompt !== null && draftPrompt !== settings.video_prompt;

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Video Style</h2>
      <div className="space-y-4">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[#888]">Prompt</label>
          <textarea
            rows={3}
            value={draftPrompt ?? ""}
            onChange={(e) => setDraftPrompt(e.target.value)}
            className="mt-2 w-full text-sm border border-[#E8E4DC] rounded p-2 bg-white font-mono"
            data-testid="textarea-prompt"
          />
          <button
            type="button"
            onClick={() => { if (draftPrompt !== null) update({ key: "video_prompt", value: draftPrompt }); }}
            disabled={!dirty}
            className="mt-2 text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg bg-[#D4AF37] text-[#1A1400] hover:opacity-90 disabled:opacity-50"
          >
            {dirty ? "Save Prompt" : "Saved"}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">Model</label>
            <select
              value={settings.video_model}
              onChange={(e) => update({ key: "video_model", value: e.target.value })}
              className="mt-2 w-full text-sm border border-[#E8E4DC] rounded px-2 py-1.5 bg-white"
              data-testid="select-model"
            >
              {MODEL_OPTIONS.map(m => <option key={m.slug} value={m.slug}>{m.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">Clip length</label>
            <div className="mt-2 flex gap-2">
              {[4, 6, 8].map(s => (
                <label key={s} className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="clip-length"
                    checked={settings.clip_length_seconds === s}
                    onChange={() => update({ key: "clip_length_seconds", value: s })}
                    className="accent-[#D4AF37]"
                    data-testid={`radio-clip-${s}`}
                  />
                  <span className="text-sm">{s}s</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">Include back</label>
            <label className="mt-2 inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.include_back}
                onChange={() => update({ key: "include_back", value: !settings.include_back })}
                className="accent-[#D4AF37] h-4 w-4"
                data-testid="check-include-back"
              />
              <span className="text-sm">{settings.include_back ? "Front + Back" : "Front only"}</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section 4: Output & Publishing ─────────────────────────────────────────

function OutputPublishing() {
  const { settings, update } = useSettings();
  const [draftCaption, setDraftCaption] = useState<string | null>(null);

  useEffect(() => {
    if (settings && draftCaption === null) setDraftCaption(settings.caption_template);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.caption_template]);

  if (!settings) return null;
  const dirty = draftCaption !== null && draftCaption !== settings.caption_template;

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Output &amp; Publishing</h2>
      <div className="space-y-4">
        <div className="flex items-center justify-between bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-3">
          <div>
            <p className="text-sm font-semibold text-[#1A1A1A]">Auto-post to Instagram</p>
            <p className="text-[10px] text-[#888]">After each successful reel run, fire <code>runIgDailyPost</code> with <code>force=true</code>.</p>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.auto_post_instagram}
              onChange={() => update({ key: "auto_post_instagram", value: !settings.auto_post_instagram })}
              className="accent-[#D4AF37] h-4 w-4"
              data-testid="check-auto-post"
            />
            <span className="text-xs text-[#666]">{settings.auto_post_instagram ? "on" : "off"}</span>
          </label>
        </div>

        <div>
          <label className="text-[10px] uppercase tracking-wider text-[#888]">Caption template</label>
          <textarea
            rows={3}
            value={draftCaption ?? ""}
            onChange={(e) => setDraftCaption(e.target.value)}
            className="mt-2 w-full text-sm border border-[#E8E4DC] rounded p-2 bg-white font-mono"
            data-testid="textarea-caption"
          />
          <p className="mt-1 text-[10px] text-[#888]">
            Variables: <code>{"{{topGrade}}"}</code>, <code>{"{{cardCount}}"}</code>, <code>{"{{date}}"}</code>, <code>{"{{topCard}}"}</code>
          </p>
          <button
            type="button"
            onClick={() => { if (draftCaption !== null) update({ key: "caption_template", value: draftCaption }); }}
            disabled={!dirty}
            className="mt-2 text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg bg-[#D4AF37] text-[#1A1400] hover:opacity-90 disabled:opacity-50"
          >
            {dirty ? "Save Caption" : "Saved"}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">Output resolution</label>
            <div className="mt-2 flex gap-3">
              {[720, 1080].map(r => (
                <label key={r} className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="output-resolution"
                    checked={settings.output_resolution === r}
                    onChange={() => update({ key: "output_resolution", value: r })}
                    className="accent-[#D4AF37]"
                    data-testid={`radio-res-${r}`}
                  />
                  <span className="text-sm">{r}p</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">Watermark</label>
            <label className="mt-2 inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.watermark_enabled}
                onChange={() => update({ key: "watermark_enabled", value: !settings.watermark_enabled })}
                className="accent-[#D4AF37] h-4 w-4"
                data-testid="check-watermark"
              />
              <span className="text-sm">{settings.watermark_enabled ? "on" : "off"}</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section 5: Notifications ───────────────────────────────────────────────

function Notifications() {
  const { settings, update } = useSettings();
  const [draftEmail, setDraftEmail] = useState<string | null>(null);
  const [draftWebhook, setDraftWebhook] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (settings && draftEmail === null) setDraftEmail(settings.notify_email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.notify_email]);
  useEffect(() => {
    if (settings && draftWebhook === null) setDraftWebhook(settings.notify_webhook_url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.notify_webhook_url]);

  const testMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/admin/weekly-reel/test-webhook");
      return r.json();
    },
    onSuccess: () => setTestResult("Webhook accepted (HTTP 2xx)."),
    onError: (err: any) => setTestResult(err?.message ?? "Webhook test failed"),
  });

  if (!settings) return null;
  const emailDirty = draftEmail !== null && draftEmail !== settings.notify_email;
  const hookDirty = draftWebhook !== null && draftWebhook !== settings.notify_webhook_url;

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Notifications</h2>
      <div className="space-y-4">
        <div className="flex items-center justify-between bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-3">
          <div>
            <p className="text-sm font-semibold text-[#1A1A1A]">Notify card owners when featured</p>
            <p className="text-[10px] text-[#888]">Emails each cert's owner only if they have <code>marketing_feature_consent</code>.</p>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.notify_card_owners}
              onChange={() => update({ key: "notify_card_owners", value: !settings.notify_card_owners })}
              className="accent-[#D4AF37] h-4 w-4"
              data-testid="check-notify-card-owners"
            />
            <span className="text-xs text-[#666]">{settings.notify_card_owners ? "on" : "off"}</span>
          </label>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[#888]">Email recipient</label>
          <div className="mt-2 flex gap-2">
            <input
              type="email"
              value={draftEmail ?? ""}
              onChange={(e) => setDraftEmail(e.target.value)}
              placeholder="ops@mintvaultuk.com"
              className="flex-1 text-sm border border-[#E8E4DC] rounded px-2 py-1.5 bg-white"
              data-testid="input-notify-email"
            />
            <button
              type="button"
              onClick={() => { if (draftEmail !== null) update({ key: "notify_email", value: draftEmail }); }}
              disabled={!emailDirty}
              className="text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg bg-[#D4AF37] text-[#1A1400] hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>
          <p className="mt-1 text-[10px] text-[#888]">Leave blank to disable.</p>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-[#888]">Webhook URL</label>
          <div className="mt-2 flex gap-2">
            <input
              type="url"
              value={draftWebhook ?? ""}
              onChange={(e) => setDraftWebhook(e.target.value)}
              placeholder="https://hooks.example.com/…"
              className="flex-1 text-sm border border-[#E8E4DC] rounded px-2 py-1.5 bg-white font-mono"
              data-testid="input-notify-webhook"
            />
            <button
              type="button"
              onClick={() => { if (draftWebhook !== null) update({ key: "notify_webhook_url", value: draftWebhook }); }}
              disabled={!hookDirty}
              className="text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg bg-[#D4AF37] text-[#1A1400] hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => { setTestResult(null); testMutation.mutate(); }}
              disabled={!settings.notify_webhook_url || testMutation.isPending}
              className="text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg bg-white border border-[#E8E4DC] text-[#555] hover:bg-[#FAFAF8] disabled:opacity-50"
            >
              {testMutation.isPending ? "Testing…" : "Test"}
            </button>
          </div>
          {testResult && (
            <p className={`mt-2 text-xs ${testResult.startsWith("Webhook accepted") ? "text-emerald-700" : "text-red-700"}`}>
              {testResult}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Social Publishing (Meta + TikTok) ──────────────────────────────────────

function SocialPublishing() {
  const { settings, update } = useSettings();
  const { data: meta } = useQuery<MetaStatus>({
    queryKey: ["/api/admin/weekly-reel/meta-status"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/meta-status")).json(),
  });
  const { data: tiktok } = useQuery<TiktokStatus>({
    queryKey: ["/api/admin/weekly-reel/tiktok-status"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/tiktok-status")).json(),
  });
  if (!settings) return null;

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Social Publishing</h2>

      {/* Meta */}
      <div className="border border-[#E8E4DC] rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Instagram size={14} className="text-[#D4AF37]" />
            <Facebook size={14} className="text-[#D4AF37]" />
            <span className="text-xs uppercase tracking-wider text-[#666]">Meta (Instagram + Facebook)</span>
          </div>
          <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border font-semibold ${
            meta?.valid ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
          }`}>
            {meta === undefined ? "…" : meta.valid ? "Connected" : "Not connected"}
          </span>
        </div>
        {meta && (
          <p className="text-[10px] text-[#888] mb-3 font-mono">
            IG user: {meta.igUserId ?? "—"} · FB page: {meta.fbPageId ?? "—"} · scopes: {meta.scopes.length}
          </p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ToggleRow label="Auto-post Instagram video" value={settings.auto_post_instagram_video}
            onChange={(v) => update({ key: "auto_post_instagram_video", value: v })} />
          <ToggleRow label="Auto-post Facebook" value={settings.auto_post_facebook}
            onChange={(v) => update({ key: "auto_post_facebook", value: v })} />
          <ToggleRow label="Draft mode (hold for manual)" value={settings.instagram_draft_mode}
            onChange={(v) => update({ key: "instagram_draft_mode", value: v })} />
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">
              Post delay — {settings.post_delay_minutes} min
            </label>
            <input
              type="range" min={0} max={120} step={5}
              value={settings.post_delay_minutes}
              onChange={(e) => update({ key: "post_delay_minutes", value: Number(e.target.value) })}
              className="w-full mt-2 accent-[#D4AF37]"
              data-testid="slider-post-delay"
            />
          </div>
        </div>
      </div>

      {/* TikTok */}
      <div className="border border-[#E8E4DC] rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Music size={14} className="text-[#D4AF37]" />
            <span className="text-xs uppercase tracking-wider text-[#666]">TikTok</span>
          </div>
          <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border font-semibold ${
            tiktok?.valid ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
          }`}>
            {tiktok === undefined ? "…" : tiktok.valid ? "Connected" : "Not connected"}
          </span>
        </div>
        {tiktok && (
          <p className="text-[10px] text-[#888] mb-3 font-mono">open_id: {tiktok.openId ?? "—"}</p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ToggleRow label="Auto-post TikTok" value={settings.auto_post_tiktok}
            onChange={(v) => update({ key: "auto_post_tiktok", value: v })} />
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">Privacy</label>
            <select
              value={settings.tiktok_privacy}
              onChange={(e) => update({ key: "tiktok_privacy", value: e.target.value })}
              className="mt-2 w-full text-sm border border-[#E8E4DC] rounded px-2 py-1.5 bg-white"
              data-testid="select-tiktok-privacy"
            >
              <option value="PUBLIC_TO_EVERYONE">Public</option>
              <option value="FOLLOWER_OF_CREATOR">Followers only</option>
              <option value="SELF_ONLY">Self only</option>
            </select>
          </div>
          <ToggleRow label="Disable duet" value={settings.tiktok_disable_duet}
            onChange={(v) => update({ key: "tiktok_disable_duet", value: v })} />
          <ToggleRow label="Disable stitch" value={settings.tiktok_disable_stitch}
            onChange={(v) => update({ key: "tiktok_disable_stitch", value: v })} />
        </div>
      </div>
    </div>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg px-3 py-2">
      <span className="text-sm text-[#1A1A1A]">{label}</span>
      <label className="inline-flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={value}
          onChange={() => onChange(!value)}
          className="accent-[#D4AF37] h-4 w-4"
        />
        <span className="text-xs text-[#666]">{value ? "on" : "off"}</span>
      </label>
    </div>
  );
}

// ── Content Enhancement (intro/outro/music/text overlay/transition) ───────

function ContentEnhancement() {
  const { settings, update } = useSettings();
  const queryClient = useQueryClient();
  const [draftFormat, setDraftFormat] = useState<string | null>(null);

  useEffect(() => {
    if (settings && draftFormat === null) setDraftFormat(settings.text_overlay_format);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.text_overlay_format]);

  async function upload(endpoint: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(endpoint, { method: "POST", body: fd, credentials: "include" });
    if (!r.ok) throw new Error(await r.text());
    queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/settings"] });
    return r.json();
  }

  if (!settings) return null;
  const formatDirty = draftFormat !== null && draftFormat !== settings.text_overlay_format;

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest mb-4">Content Enhancement</h2>
      <div className="space-y-4">
        <AssetUploadRow label="Intro clip" current={settings.intro_video_r2_key} accept="video/mp4"
          onPick={(f) => upload("/api/admin/weekly-reel/upload-intro", f)} />
        <AssetUploadRow label="Outro clip" current={settings.outro_video_r2_key} accept="video/mp4"
          onPick={(f) => upload("/api/admin/weekly-reel/upload-outro", f)} />
        <AssetUploadRow label="Background music" current={settings.background_music_r2_key} accept="audio/mpeg,audio/mp3"
          onPick={(f) => upload("/api/admin/weekly-reel/upload-music", f)} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div>
            <ToggleRow label="Text overlay" value={settings.text_overlay_enabled}
              onChange={(v) => update({ key: "text_overlay_enabled", value: v })} />
            <label className="mt-3 block text-[10px] uppercase tracking-wider text-[#888]">Format</label>
            <input
              type="text"
              value={draftFormat ?? ""}
              onChange={(e) => setDraftFormat(e.target.value)}
              className="mt-2 w-full text-sm border border-[#E8E4DC] rounded px-2 py-1.5 bg-white font-mono"
              data-testid="input-text-overlay-format"
            />
            <p className="mt-1 text-[10px] text-[#888]">
              Variables: <code>{"{{certNumber}}"}</code>, <code>{"{{grade}}"}</code>, <code>{"{{cardName}}"}</code>
            </p>
            <button
              type="button"
              onClick={() => { if (draftFormat !== null) update({ key: "text_overlay_format", value: draftFormat }); }}
              disabled={!formatDirty}
              className="mt-2 text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg bg-[#D4AF37] text-[#1A1400] hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-[#888]">Transition</label>
            <select
              value={settings.transition_style}
              onChange={(e) => update({ key: "transition_style", value: e.target.value })}
              className="mt-2 w-full text-sm border border-[#E8E4DC] rounded px-2 py-1.5 bg-white"
              data-testid="select-transition"
            >
              <option value="cut">Cut</option>
              <option value="dissolve">Dissolve</option>
              <option value="zoom">Zoom</option>
            </select>
          </div>
        </div>

        <div className="border-t border-[#F0EDE5] pt-3">
          <ToggleRow label="Auto-generate thumbnail" value={settings.auto_generate_thumbnail}
            onChange={(v) => update({ key: "auto_generate_thumbnail", value: v })} />
          <ToggleRow label="Require per-card approval before publish"
            value={settings.require_card_approval}
            onChange={(v) => update({ key: "require_card_approval", value: v })} />
        </div>
      </div>
    </div>
  );
}

function AssetUploadRow({ label, current, accept, onPick }: {
  label: string; current: string; accept: string; onPick: (f: File) => Promise<any>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex items-center justify-between gap-3 bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[#1A1A1A]">{label}</p>
        <p className="text-[10px] text-[#888] truncate font-mono">{current || "none"}</p>
        {err && <p className="text-[10px] text-red-700">{err}</p>}
      </div>
      <label className={`inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg cursor-pointer ${
        busy ? "bg-white text-[#888] border border-[#E8E4DC] opacity-50" : "bg-white text-[#555] border border-[#E8E4DC] hover:border-[#D4AF37]"
      }`}>
        <Upload size={12} /> {busy ? "Uploading…" : "Upload"}
        <input
          type="file"
          accept={accept}
          className="hidden"
          disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setBusy(true); setErr(null);
            try { await onPick(f); }
            catch (x: any) { setErr(x?.message ?? "Upload failed"); }
            finally { setBusy(false); e.target.value = ""; }
          }}
        />
      </label>
    </div>
  );
}

// ── Section 6 + 7: Featured Cards + Blacklist ─────────────────────────────

function FeaturedCardsTable() {
  const queryClient = useQueryClient();
  const [busyCert, setBusyCert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ cards: FeaturedCard[] }>({
    queryKey: ["/api/admin/weekly-reel/featured-cards"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/featured-cards")).json(),
  });

  const mutationOpts = {
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/featured-cards"] });
    },
    onError: (err: any) => setError(err?.message ?? "Toggle failed"),
    onSettled: () => setBusyCert(null),
  };
  const toggleFeatured = useMutation({
    mutationFn: async ({ certNumber, value }: { certNumber: string; value: boolean }) => {
      const r = await apiRequest("PATCH", `/api/admin/weekly-reel/card/${encodeURIComponent(certNumber)}/featured`, { featured: value });
      return r.json();
    },
    ...mutationOpts,
  });
  const togglePinned = useMutation({
    mutationFn: async ({ certNumber, value }: { certNumber: string; value: boolean }) => {
      const r = await apiRequest("PATCH", `/api/admin/weekly-reel/card/${encodeURIComponent(certNumber)}/pinned`, { pinned: value });
      return r.json();
    },
    ...mutationOpts,
  });
  const toggleBlacklisted = useMutation({
    mutationFn: async ({ certNumber, value }: { certNumber: string; value: boolean }) => {
      const r = await apiRequest("PATCH", `/api/admin/weekly-reel/card/${encodeURIComponent(certNumber)}/blacklisted`, { blacklisted: value });
      return r.json();
    },
    ...mutationOpts,
  });

  const allCards = data?.cards ?? [];
  const visible = allCards.filter(c => !c.blacklisted);
  const blacklisted = allCards.filter(c => c.blacklisted);
  const featuredCount = visible.filter(c => c.featured || c.pinned).length;

  return (
    <>
      <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Featured Cards</h2>
          <span className="text-xs text-[#888888]">
            {isLoading ? "…" : `${featuredCount} of ${visible.length} in pool`}
          </span>
        </div>
        <p className="text-xs text-[#666666] mb-4">
          Admin-curated pool. <strong>Pinned</strong> cards (📌) always appear first regardless of grade or sort
          order. <strong>Blacklisted</strong> cards (🚫) are excluded permanently. Toggles write
          <code className="mx-1">audit_log</code> rows.
        </p>
        {isLoading ? (
          <div className="py-12 flex justify-center"><Loader2 size={20} className="text-[#D4AF37] animate-spin" /></div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-[#888888] py-6 text-center">No graded cards yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-[#E8E4DC]">
                  <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Cert ID</th>
                  <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Card Name</th>
                  <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Set</th>
                  <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Grade</th>
                  <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888] text-center">Featured</th>
                  <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888] text-center">Pinned</th>
                  <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888] text-center">Blacklist</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const busy = busyCert === c.certNumber;
                  return (
                    <tr
                      key={c.certNumber}
                      className={`border-b border-[#F0EDE5] ${c.pinned ? "bg-[#FAF5E0]" : ""}`}
                      data-testid={`row-card-${c.certNumber}`}
                    >
                      <td className="py-2 px-3 font-mono text-[#1A1A1A]">
                        {c.pinned && <Pin size={12} className="inline mr-1 text-[#D4AF37]" />}
                        {c.certNumber}
                      </td>
                      <td className="py-2 px-3 text-[#1A1A1A]">{c.cardName ?? "—"}</td>
                      <td className="py-2 px-3 text-[#555]">{c.cardSet ?? "—"}{c.year ? ` (${c.year})` : ""}</td>
                      <td className="py-2 px-3 font-bold text-[#1A1A1A]">{fmtGrade(c.grade)}</td>
                      <td className="py-2 px-3 text-center">
                        <input
                          type="checkbox"
                          checked={c.featured}
                          disabled={busy}
                          onChange={() => { setBusyCert(c.certNumber); toggleFeatured.mutate({ certNumber: c.certNumber, value: !c.featured }); }}
                          className="accent-[#D4AF37] h-4 w-4"
                          data-testid={`toggle-featured-${c.certNumber}`}
                        />
                      </td>
                      <td className="py-2 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => { setBusyCert(c.certNumber); togglePinned.mutate({ certNumber: c.certNumber, value: !c.pinned }); }}
                          disabled={busy}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-full transition-colors ${
                            c.pinned ? "bg-[#D4AF37] text-[#1A1400]" : "bg-white border border-[#E8E4DC] text-[#888] hover:border-[#D4AF37]"
                          } disabled:opacity-50`}
                          aria-label={c.pinned ? "Unpin" : "Pin"}
                          title={c.pinned ? "Unpin" : "Pin"}
                          data-testid={`toggle-pinned-${c.certNumber}`}
                        >
                          <Pin size={14} />
                        </button>
                      </td>
                      <td className="py-2 px-3 text-center">
                        <button
                          type="button"
                          onClick={() => { setBusyCert(c.certNumber); toggleBlacklisted.mutate({ certNumber: c.certNumber, value: true }); }}
                          disabled={busy}
                          className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-white border border-[#E8E4DC] text-[#888] hover:border-red-400 hover:text-red-600 disabled:opacity-50"
                          aria-label="Blacklist"
                          title="Blacklist"
                          data-testid={`toggle-blacklist-${c.certNumber}`}
                        >
                          <Ban size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm" role="alert">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {blacklisted.length > 0 && <BlacklistSection cards={blacklisted} onRestore={(certNumber) => {
        setBusyCert(certNumber);
        toggleBlacklisted.mutate({ certNumber, value: false });
      }} busyCert={busyCert} />}
    </>
  );
}

function BlacklistSection({ cards, onRestore, busyCert }: { cards: FeaturedCard[]; onRestore: (c: string) => void; busyCert: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-[#FAFAF8] transition-colors"
      >
        <h2 className="text-sm font-bold text-[#888] uppercase tracking-widest">
          Blacklisted ({cards.length})
        </h2>
        {open ? <ChevronUp size={16} className="text-[#888]" /> : <ChevronDown size={16} className="text-[#888]" />}
      </button>
      {open && (
        <div className="border-t border-[#E8E4DC] px-6 py-4">
          <table className="w-full text-sm">
            <tbody>
              {cards.map(c => (
                <tr key={c.certNumber} className="border-b border-[#F0EDE5]">
                  <td className="py-2 px-3 font-mono text-[#1A1A1A]">{c.certNumber}</td>
                  <td className="py-2 px-3 text-[#555]">{c.cardName ?? "—"}</td>
                  <td className="py-2 px-3 font-bold text-[#1A1A1A]">{fmtGrade(c.grade)}</td>
                  <td className="py-2 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => onRestore(c.certNumber)}
                      disabled={busyCert === c.certNumber}
                      className="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-lg bg-white border border-[#E8E4DC] text-[#555] hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-50"
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Section 8: Reel History ────────────────────────────────────────────────

function HistoryEntryRow({ entry, onRerun }: { entry: HistoryEntry; onRerun: () => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [pubMsg, setPubMsg] = useState<string | null>(null);
  const badge = statusBadge(entry.status);
  const ageHours = useMemo(() => {
    try { return (Date.now() - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60); }
    catch { return 0; }
  }, [entry.createdAt]);
  const stale = ageHours > 24;

  const { data: approvalsData } = useQuery<{ cards: ApprovalCard[] }>({
    queryKey: ["/api/admin/weekly-reel/approvals/", entry.date],
    queryFn: async () => (await fetch(`/api/admin/weekly-reel/approvals/${entry.date}`)).json(),
    enabled: open,
  });
  const approvals: Record<string, ApprovalCard> = useMemo(() => {
    const m: Record<string, ApprovalCard> = {};
    (approvalsData?.cards ?? []).forEach(a => { m[a.certNumber] = a; });
    return m;
  }, [approvalsData]);
  const hasApprovals = (approvalsData?.cards.length ?? 0) > 0;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/admin/weekly-reel/thumbnail/${entry.date}`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setThumbUrl(j.url ?? null);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [open, entry.date]);

  function downloadAll() {
    const valid = entry.cards.filter(c => c.videoUrl).map(c => c.videoUrl as string);
    if (valid.length === 0) return;
    if (stale && !confirm("Segmind URLs may have expired (manifest > 24h old). Try anyway?")) return;
    valid.forEach((url, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = url;
        a.download = `${entry.date}-${i + 1}.mp4`;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 300);
    });
  }

  async function publish(channel: "instagram" | "facebook" | "tiktok") {
    setPubMsg(`Publishing to ${channel}…`);
    try {
      const r = await apiRequest("POST", `/api/admin/weekly-reel/publish-${channel}`, { date: entry.date });
      const j = await r.json();
      if (j.error === "token_not_configured") setPubMsg(`${channel}: token not configured`);
      else if (j.error === "approvals_pending") setPubMsg(`${channel}: pending approval — ${(j.pending ?? []).join(", ")}`);
      else if (j.error) setPubMsg(`${channel}: ${j.error}`);
      else { setPubMsg(`${channel}: published — ${j.postId}`); queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/analytics"] }); }
    } catch (err: any) {
      setPubMsg(`${channel}: ${err?.message ?? "publish failed"}`);
    }
  }

  async function refreshInsights() {
    setPubMsg("Refreshing IG insights…");
    try {
      const r = await apiRequest("POST", "/api/admin/weekly-reel/refresh-insights", { date: entry.date });
      const j = await r.json();
      if (j.error) setPubMsg(`insights: ${j.error}`);
      else { setPubMsg("insights: refreshed"); queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/analytics"] }); }
    } catch (err: any) { setPubMsg(`insights: ${err?.message ?? "failed"}`); }
  }

  async function toggleApproval(certNumber: string, approved: boolean) {
    await apiRequest("PATCH", `/api/admin/weekly-reel/approvals/${entry.date}/${encodeURIComponent(certNumber)}`, { approved });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/approvals/", entry.date] });
  }
  async function approveAll() {
    await apiRequest("POST", `/api/admin/weekly-reel/approvals/${entry.date}/approve-all`);
    queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/approvals/", entry.date] });
  }
  async function regenerate(certNumber: string) {
    setPubMsg(`Regenerating ${certNumber}…`);
    try {
      const r = await apiRequest("POST", "/api/admin/weekly-reel/regenerate-card", { date: entry.date, certNumber });
      const j = await r.json();
      setPubMsg(j.error ? `regen: ${j.error}` : `regen: ${certNumber} ${j.videoUrl ? "ok" : "failed"}`);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/status"] });
    } catch (err: any) { setPubMsg(`regen: ${err?.message ?? "failed"}`); }
  }

  return (
    <div className="border border-[#E8E4DC] rounded-xl overflow-hidden" data-testid={`history-${entry.date}`}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[#FAFAF8] transition-colors">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-3 min-w-0 flex-1 text-left"
        >
          {thumbUrl && open && (
            <img src={thumbUrl} alt="" className="w-[60px] h-[60px] object-cover rounded border border-[#E8E4DC]" />
          )}
          <span className="font-mono text-sm text-[#1A1A1A]">{entry.date}</span>
          <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border font-semibold ${badge.cls}`}>
            {badge.label}
          </span>
          <span className="text-xs text-[#666] truncate">
            {entry.successCount}/{entry.cardCount} ok
            {entry.failCount > 0 && <> · {entry.failCount} failed</>}
            {entry.model && <> · {entry.model} {entry.clipLengthSeconds ? `${entry.clipLengthSeconds}s` : ""}</>}
            {!entry.manifestPresent && <> · manifest missing</>}
          </span>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={() => publish("instagram")}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border border-[#E8E4DC] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37]"
            title="Publish to Instagram">
            <Instagram size={12} />
          </button>
          <button type="button" onClick={() => publish("facebook")}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border border-[#E8E4DC] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37]"
            title="Publish to Facebook">
            <Facebook size={12} />
          </button>
          <button type="button" onClick={() => publish("tiktok")}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border border-[#E8E4DC] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37]"
            title="Publish to TikTok">
            <Music size={12} />
          </button>
          <button type="button" onClick={refreshInsights}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border border-[#E8E4DC] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37]"
            title="Refresh IG insights">
            <RefreshCw size={12} />
          </button>
          <button type="button" onClick={downloadAll} disabled={entry.successCount === 0}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border border-[#E8E4DC] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37] disabled:opacity-40"
            title={stale ? "URLs may have expired" : "Download all videos"}>
            <Download size={12} /> {stale ? "Stale" : ""}
          </button>
          <button type="button" onClick={onRerun}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border border-[#E8E4DC] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37]"
            title="Re-run with force=true">
            <RotateCcw size={12} />
          </button>
          {open ? <ChevronUp size={16} className="text-[#888]" /> : <ChevronDown size={16} className="text-[#888]" />}
        </div>
      </div>
      {pubMsg && (
        <div className="px-4 py-2 text-[10px] bg-[#FAFAF8] border-t border-[#E8E4DC] text-[#555] font-mono">
          {pubMsg}
        </div>
      )}
      {open && (
        <div className="border-t border-[#E8E4DC] p-4 bg-[#FAFAF8]">
          <p className="text-[10px] text-[#888] mb-3">
            Generated {fmtDate(entry.createdAt)} · manifest <code>{entry.manifestKey}</code>
          </p>
          {hasApprovals && (
            <div className="mb-3 flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg p-2">
              <span className="text-xs text-amber-800">Per-card approval required before publishing.</span>
              <button type="button" onClick={approveAll}
                className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700">
                Approve All
              </button>
            </div>
          )}
          {entry.cards.length === 0 ? (
            <p className="text-sm text-[#888]">No per-card data — manifest is empty or unreadable.</p>
          ) : (
            <ul className="space-y-3">
              {entry.cards.map((c, i) => {
                const ap = approvals[c.certNumber];
                return (
                  <li key={`${entry.date}-${c.certNumber}-${i}`} className="bg-white border border-[#E8E4DC] rounded-lg p-3" data-testid={`history-card-${entry.date}-${c.certNumber}`}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="font-mono text-sm font-semibold text-[#1A1A1A]">{c.certNumber}</span>
                        <span className="text-xs text-[#666]">grade {fmtGrade(c.grade)}</span>
                        {c.cardName && <span className="text-xs text-[#888] truncate">· {c.cardName}</span>}
                        {ap && (
                          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border font-semibold ${
                            ap.approved ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
                          }`}>
                            {ap.approved ? "approved" : "pending"}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {ap && (ap.approved
                          ? <button type="button" onClick={() => toggleApproval(c.certNumber, false)}
                              className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-[#E8E4DC] text-[#555] hover:border-red-400 hover:text-red-700">Reject</button>
                          : <button type="button" onClick={() => toggleApproval(c.certNumber, true)}
                              className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-[#E8E4DC] text-[#555] hover:border-emerald-400 hover:text-emerald-700">
                              <Check size={10} className="inline" /> Approve
                            </button>
                        )}
                        <button type="button" onClick={() => regenerate(c.certNumber)}
                          className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-[#E8E4DC] text-[#555] hover:border-[#D4AF37] hover:text-[#D4AF37]">
                          <RotateCcw size={10} className="inline" /> Regen
                        </button>
                      </div>
                    </div>
                    {c.videoUrl ? (
                      <video src={c.videoUrl} controls preload="none" className="w-full max-w-sm rounded-lg border border-[#E8E4DC] bg-black" />
                    ) : c.error ? (
                      <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 font-mono break-words">{c.error}</p>
                    ) : (
                      <p className="text-xs text-[#888]">No video URL · no error recorded</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function HistorySection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<{ history: HistoryEntry[] }>({
    queryKey: ["/api/admin/weekly-reel/status"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/status")).json(),
  });
  const rerunMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/weekly-reel/rerun")).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/weekly-reel/analytics"] });
    },
  });

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Reel History</h2>
        <span className="text-xs text-[#888888]">Last 10 runs</span>
      </div>
      {isLoading ? (
        <div className="py-12 flex justify-center"><Loader2 size={20} className="text-[#D4AF37] animate-spin" /></div>
      ) : (data?.history.length ?? 0) === 0 ? (
        <p className="text-sm text-[#888] py-6 text-center">
          No reel runs yet. Audit-log only captures completed runs — pure skips won't appear.
        </p>
      ) : (
        <div className="space-y-3">
          {data?.history.map(e => (
            <HistoryEntryRow key={e.date} entry={e} onRerun={() => rerunMutation.mutate()} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Section 9: Analytics ───────────────────────────────────────────────────

function AnalyticsSection() {
  const { data, isLoading } = useQuery<AnalyticsResp>({
    queryKey: ["/api/admin/weekly-reel/analytics"],
    queryFn: async () => (await fetch("/api/admin/weekly-reel/analytics")).json(),
  });
  const rows = data?.rows ?? [];
  const chartData = useMemo(() => [...rows].reverse().map(r => ({
    date: r.reelDate,
    success: r.successCount ?? 0,
  })), [rows]);
  const totalUsd = data?.totalCostUsd ?? 0;

  // Best-performing: max instagram_likes (when any). Falls back to highest
  // successCount when no IG data yet.
  const best = useMemo(() => {
    if (rows.length === 0) return null;
    const withLikes = rows.filter(r => r.instagramLikes != null);
    if (withLikes.length > 0) {
      return withLikes.reduce((a, b) => ((a.instagramLikes ?? 0) >= (b.instagramLikes ?? 0) ? a : b));
    }
    return rows.reduce((a, b) => ((a.successCount ?? 0) >= (b.successCount ?? 0) ? a : b));
  }, [rows]);

  function engagementRate(r: AnalyticsRow): number | null {
    if (r.instagramLikes == null || !r.instagramReach) return null;
    return (r.instagramLikes / r.instagramReach) * 100;
  }
  function trendArrow(curr: AnalyticsRow, prev: AnalyticsRow | undefined): string {
    if (!prev || curr.instagramLikes == null || prev.instagramLikes == null) return "—";
    if (curr.instagramLikes > prev.instagramLikes) return "↑";
    if (curr.instagramLikes < prev.instagramLikes) return "↓";
    return "→";
  }

  return (
    <div className="bg-white rounded-2xl border border-[#E8E4DC] p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-bold text-[#D4AF37] uppercase tracking-widest">Analytics</h2>
        <span className="text-xs text-[#888888]">
          {isLoading ? "…" : `$${totalUsd.toFixed(2)} spent to date`}
        </span>
      </div>
      {best && (
        <div className="mb-4 inline-flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold px-3 py-1.5 rounded-full bg-[#FAF5E0] border border-[#D4AF37] text-[#1A1400]">
          ★ Best performing: {best.reelDate}
          {best.instagramLikes != null && <> · {best.instagramLikes.toLocaleString()} likes</>}
        </div>
      )}
      {chartData.length > 0 && (
        <div style={{ width: "100%", height: 160 }} className="mb-4">
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="date" stroke="#888" fontSize={10} />
              <YAxis stroke="#888" fontSize={10} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="success" fill="#D4AF37" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {isLoading ? (
        <div className="py-12 flex justify-center"><Loader2 size={20} className="text-[#D4AF37] animate-spin" /></div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[#888] py-6 text-center">No runs recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b border-[#E8E4DC]">
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Date</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Success</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Cost</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">IG Likes</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Views</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Reach</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Eng%</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">vs Prev</th>
                <th className="py-2 px-3 text-[10px] uppercase tracking-wider text-[#888888]">Posted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prev = rows[i + 1];
                const eng = engagementRate(r);
                return (
                  <tr key={`${r.reelDate}-${i}`} className="border-b border-[#F0EDE5]">
                    <td className="py-2 px-3 font-mono text-[#1A1A1A]">{r.reelDate}</td>
                    <td className="py-2 px-3 text-emerald-700">{r.successCount ?? 0}</td>
                    <td className="py-2 px-3 font-mono">${(r.estimatedCostUsd ?? 0).toFixed(2)}</td>
                    <td className="py-2 px-3 text-[#1A1A1A]">{r.instagramLikes ?? "—"}</td>
                    <td className="py-2 px-3 text-[#1A1A1A]">{r.instagramViews ?? "—"}</td>
                    <td className="py-2 px-3 text-[#1A1A1A]">{r.instagramReach ?? "—"}</td>
                    <td className="py-2 px-3 text-[#1A1A1A]">{eng == null ? "—" : `${eng.toFixed(1)}%`}</td>
                    <td className="py-2 px-3 text-[#555]">{trendArrow(r, prev)}</td>
                    <td className="py-2 px-3 text-[10px] text-[#555] space-x-1">
                      {r.instagramPostId && (
                        <a href={`https://www.instagram.com/p/${r.instagramPostId}`} target="_blank" rel="noopener"
                           className="inline-flex items-center hover:text-[#D4AF37]" title="View on Instagram">
                          <Instagram size={12} />
                        </a>
                      )}
                      {r.facebookPostId && <Facebook size={12} className="inline" />}
                      {r.tiktokPostId && <Music size={12} className="inline" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function AdminWeeklyReelPage() {
  const { settings } = useSettings();
  const paused = !!settings?.pipeline_paused;

  return (
    <div className="min-h-screen bg-[#FAFAF8] px-4 py-12">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-xl font-black text-[#1A1A1A]">Weekly Reel</h1>
              <p className="text-xs text-[#888]">Grade-highlight video pipeline · admin curated</p>
            </div>
            {paused && (
              <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full bg-red-100 text-red-700 border border-red-200">
                Paused
              </span>
            )}
          </div>
          <Link href="/admin" className="text-xs text-[#666] hover:text-[#D4AF37] transition-colors">
            ← Admin Dashboard
          </Link>
        </div>

        <div className="space-y-6">
          <PipelineControls paused={paused} />
          <SelectionRules />
          <VideoStyle />
          <ContentEnhancement />
          <OutputPublishing />
          <SocialPublishing />
          <Notifications />
          <FeaturedCardsTable />
          <HistorySection />
          <AnalyticsSection />
        </div>
      </div>
    </div>
  );
}
