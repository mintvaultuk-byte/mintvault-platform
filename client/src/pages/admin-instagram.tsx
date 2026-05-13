import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, RefreshCw, SkipForward, RotateCcw, Send, ImageIcon,
  CheckCircle2, AlertCircle, Clock, Ban, Upload, Wand2, Save, Calendar,
} from "lucide-react";
import { IG_POST_TYPES, type IgPostStatus, type IgPostType } from "@shared/schema";

// Match the existing admin-page convention — no AdminLayout wrapper, plain
// React component that renders its own header. Auth guard runs on the API
// side; client side relies on /api/admin/* returning 401 + a redirect to
// /admin/login (matches all other admin pages).

type IgQueueRow = {
  id: number;
  scheduledFor: string;
  postType: string;
  certId: number | null;
  imageR2Key: string | null;
  caption: string | null;
  hashtags: string | null;
  status: IgPostStatus;
  metaPostId: string | null;
  errorDetail: string | null;
  createdAt: string;
  postedAt: string | null;
  deletedAt: string | null;
};

type IgSettings = {
  postEnabled: boolean;
  envGate: boolean;          // process.env.IG_POST_ENABLED === "true"
  dryRunEnvVar: boolean;     // process.env.IG_DRY_RUN === "true"
  nextPost: IgQueueRow | null;
};

const STATUS_STYLES: Record<IgPostStatus, { label: string; cls: string; icon: any }> = {
  pending:    { label: "Pending",    cls: "bg-slate-200 text-slate-700",       icon: Clock },
  generating: { label: "Generating", cls: "bg-amber-100 text-amber-800",       icon: Loader2 },
  ready:      { label: "Ready",      cls: "bg-blue-100 text-blue-700",         icon: ImageIcon },
  posted:     { label: "Posted",     cls: "bg-emerald-100 text-emerald-700",   icon: CheckCircle2 },
  failed:     { label: "Failed",     cls: "bg-red-100 text-red-700",           icon: AlertCircle },
  skipped:    { label: "Skipped",    cls: "bg-zinc-100 text-zinc-500 italic",  icon: Ban },
};

function fmt(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}

// Convert an ISO UTC timestamp into the YYYY-MM-DDTHH:MM value that an
// <input type="datetime-local"> expects (browser's local timezone).
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Case-preserving dedupe by lowercase comparison.
function mergeHashtags(existing: string, additions: string): string {
  const seen = new Map<string, string>();
  for (const t of `${existing} ${additions}`.split(/\s+/).filter(Boolean)) {
    const lc = t.toLowerCase();
    if (!seen.has(lc)) seen.set(lc, t);
  }
  return Array.from(seen.values()).join(" ");
}

// ── Queued-post detail panel ────────────────────────────────────────────────
// Drives the four edit sub-sections: Image, Caption, Hashtags, Schedule.
// All state is local-draft (lets the admin edit without clobbering server
// state until they hit Save). Drafts re-sync from the row when it changes
// (e.g. after a regenerate fetches a fresh server response).
function QueuedPostPanel({ row }: { row: IgQueueRow }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [captionDraft, setCaptionDraft]     = useState(row.caption ?? "");
  const [hashtagsDraft, setHashtagsDraft]   = useState(row.hashtags ?? "");
  const [scheduledDraft, setScheduledDraft] = useState(toDatetimeLocal(row.scheduledFor));
  const [previewUrl, setPreviewUrl]         = useState<string | null>(null);
  const [previewToken, setPreviewToken]     = useState(0);          // forces preview reload
  const [presetMode, setPresetMode]         = useState<"replace" | "append">("append");
  const [presetChoice, setPresetChoice]     = useState<string>("");
  const [dragOver, setDragOver]             = useState(false);

  // Re-sync drafts when the queue row changes (after regen / save).
  useEffect(() => {
    setCaptionDraft(row.caption ?? "");
    setHashtagsDraft(row.hashtags ?? "");
    setScheduledDraft(toDatetimeLocal(row.scheduledFor));
  }, [row.id, row.caption, row.hashtags, row.scheduledFor]);

  // Auto-load image preview when row has an R2 key. Re-runs on previewToken
  // bumps (manual upload / regen swap the key and want fresh URL).
  useEffect(() => {
    let cancelled = false;
    if (!row.imageR2Key) { setPreviewUrl(null); return; }
    (async () => {
      try {
        const res = await apiRequest("GET", `/api/admin/ig/queue/${row.id}/image-url`);
        const data = await res.json();
        if (!cancelled) setPreviewUrl(data.url ?? null);
      } catch {
        if (!cancelled) setPreviewUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [row.id, row.imageR2Key, previewToken]);

  const presetsQ = useQuery<Record<string, string>>({
    queryKey: ["/api/admin/ig/hashtag-presets"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/ig/hashtag-presets");
      return res.json();
    },
  });

  function invalidateQueueQueries() {
    qc.invalidateQueries({ queryKey: ["/api/admin/ig/settings"] });
    qc.invalidateQueries({ queryKey: ["/api/admin/ig/queue"] });
  }

  const saveFieldsM = useMutation({
    mutationFn: async (body: Record<string, any>) => {
      const res = await apiRequest("PATCH", `/api/admin/ig/queue/${row.id}`, body);
      return res.json();
    },
    onSuccess: (data, body) => {
      const which = Object.keys(body).join(", ");
      toast({ title: `Saved (${which})` });
      invalidateQueueQueries();
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const regenCaptionM = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/ig/queue/${row.id}/regenerate-caption`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: data.fromFallback ? "Caption regenerated (fallback)" : "Caption regenerated" });
      invalidateQueueQueries();
    },
    onError: (err: any) => toast({ title: "Regenerate failed", description: err.message, variant: "destructive" }),
  });

  const regenImageM = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/ig/queue/${row.id}/regenerate-image`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Image regenerated" });
      setPreviewToken((n) => n + 1);
      invalidateQueueQueries();
    },
    onError: (err: any) => toast({ title: "Regenerate failed", description: err.message, variant: "destructive" }),
  });

  const replaceImageM = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("image", file);
      // Don't use apiRequest helper — it JSON-encodes the body. Hit fetch directly.
      const res = await fetch(`/api/admin/ig/queue/${row.id}/replace-image`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Image uploaded",
        description: data.squareWarning
          ? `Image is ${data.width}×${data.height} — non-square uploads may crop on IG`
          : `${data.width}×${data.height} accepted`,
      });
      setPreviewToken((n) => n + 1);
      invalidateQueueQueries();
    },
    onError: (err: any) => toast({ title: "Upload failed", description: err.message, variant: "destructive" }),
  });

  function applyPreset() {
    if (!presetChoice || !presetsQ.data) return;
    const bundle = presetsQ.data[presetChoice];
    if (!bundle) return;
    if (presetMode === "replace") {
      setHashtagsDraft(bundle);
    } else {
      setHashtagsDraft(mergeHashtags(hashtagsDraft, bundle));
    }
    toast({ title: `Preset ${presetChoice} applied (${presetMode})`, description: "Hashtags edited — hit Save to persist." });
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    replaceImageM.mutate(files[0]);
  }

  const SS = STATUS_STYLES[row.status];
  const captionOver = captionDraft.length > 2200;
  const hashtagCount = hashtagsDraft.split(/\s+/).filter(Boolean).length;
  const hashtagOver = hashtagCount > 30;

  return (
    <div className="space-y-6">
      {/* Header row — status / type / scheduled / cert */}
      <div className="flex items-center gap-3 flex-wrap">
        <Badge className={SS.cls}><SS.icon className="w-3 h-3 mr-1" /> {SS.label}</Badge>
        <span className="text-xs font-mono text-zinc-500">{row.postType}</span>
        <span className="text-xs text-zinc-500">scheduled {fmt(row.scheduledFor)}</span>
        {row.certId != null && <span className="text-xs text-zinc-400">cert PK #{row.certId}</span>}
        {row.errorDetail && (
          <span className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 truncate max-w-md">{row.errorDetail}</span>
        )}
      </div>

      {/* ── IMAGE ─────────────────────────────────────────────────────────── */}
      <section className="border border-zinc-200 rounded-lg p-4">
        <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-3">Image</h3>
        <div className="flex gap-4 items-start">
          <div className="w-40 h-40 border border-zinc-200 rounded bg-zinc-50 overflow-hidden shrink-0">
            {previewUrl ? (
              <img src={previewUrl} alt="preview" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-zinc-400">No image</div>
            )}
          </div>
          <div className="flex-1 space-y-2">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded p-4 text-center text-sm cursor-pointer transition-colors ${
                dragOver ? "border-amber-400 bg-amber-50" : "border-zinc-300 bg-zinc-50 hover:bg-zinc-100"
              }`}
            >
              {replaceImageM.isPending ? (
                <span className="text-zinc-600"><Loader2 className="w-4 h-4 inline-block mr-2 animate-spin" /> Uploading…</span>
              ) : (
                <span className="text-zinc-600"><Upload className="w-4 h-4 inline-block mr-2" /> Drag PNG/JPG or click to replace (≤ 8 MB)</span>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => regenImageM.mutate()}
              disabled={regenImageM.isPending}
            >
              {regenImageM.isPending
                ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                : <Wand2 className="w-3 h-3 mr-1" />}
              Regenerate image
            </Button>
          </div>
        </div>
      </section>

      {/* ── CAPTION ───────────────────────────────────────────────────────── */}
      <section className="border border-zinc-200 rounded-lg p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-500">Caption</h3>
          <span className={`text-xs ${captionOver ? "text-red-600 font-bold" : "text-zinc-500"}`}>
            {captionDraft.length} / 2200
          </span>
        </div>
        <textarea
          value={captionDraft}
          onChange={(e) => setCaptionDraft(e.target.value)}
          rows={4}
          className={`w-full text-sm border rounded p-2 font-sans resize-y ${captionOver ? "border-red-400" : "border-zinc-300"}`}
        />
        <div className="flex gap-2 mt-2">
          <Button
            size="sm"
            onClick={() => saveFieldsM.mutate({ caption: captionDraft })}
            disabled={captionOver || saveFieldsM.isPending || captionDraft === (row.caption ?? "")}
          >
            <Save className="w-3 h-3 mr-1" /> Save caption
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => regenCaptionM.mutate()}
            disabled={regenCaptionM.isPending}
          >
            {regenCaptionM.isPending
              ? <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              : <Wand2 className="w-3 h-3 mr-1" />}
            Regenerate caption
          </Button>
        </div>
      </section>

      {/* ── HASHTAGS ──────────────────────────────────────────────────────── */}
      <section className="border border-zinc-200 rounded-lg p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-500">Hashtags</h3>
          <span className={`text-xs ${hashtagOver ? "text-red-600 font-bold" : "text-zinc-500"}`}>
            {hashtagCount} / 30 tags
          </span>
        </div>
        <textarea
          value={hashtagsDraft}
          onChange={(e) => setHashtagsDraft(e.target.value)}
          rows={3}
          className={`w-full text-xs font-mono border rounded p-2 resize-y ${hashtagOver ? "border-red-400" : "border-zinc-300"}`}
        />
        <div className="flex flex-wrap gap-2 mt-2 items-center">
          <select
            value={presetChoice}
            onChange={(e) => setPresetChoice(e.target.value)}
            className="h-8 px-2 text-xs border border-zinc-300 rounded bg-white"
          >
            <option value="">Apply preset…</option>
            {presetsQ.data && Object.keys(presetsQ.data).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <select
            value={presetMode}
            onChange={(e) => setPresetMode(e.target.value as "replace" | "append")}
            className="h-8 px-2 text-xs border border-zinc-300 rounded bg-white"
          >
            <option value="append">Append + dedupe</option>
            <option value="replace">Replace</option>
          </select>
          <Button size="sm" variant="outline" onClick={applyPreset} disabled={!presetChoice}>
            Apply
          </Button>
          <div className="ml-auto" />
          <Button
            size="sm"
            onClick={() => saveFieldsM.mutate({ hashtags: hashtagsDraft })}
            disabled={hashtagOver || saveFieldsM.isPending || hashtagsDraft === (row.hashtags ?? "")}
          >
            <Save className="w-3 h-3 mr-1" /> Save hashtags
          </Button>
        </div>
      </section>

      {/* ── SCHEDULE ──────────────────────────────────────────────────────── */}
      <section className="border border-zinc-200 rounded-lg p-4">
        <h3 className="text-xs font-bold uppercase tracking-wide text-zinc-500 mb-3">Schedule</h3>
        <div className="flex flex-wrap gap-2 items-center">
          <Calendar className="w-4 h-4 text-zinc-400" />
          <input
            type="datetime-local"
            value={scheduledDraft}
            onChange={(e) => setScheduledDraft(e.target.value)}
            className="text-sm border border-zinc-300 rounded px-2 py-1"
          />
          <span className="text-xs text-zinc-500">Europe/London</span>
          <Button
            size="sm"
            onClick={() => {
              // datetime-local gives "YYYY-MM-DDTHH:MM" in browser-local time.
              // Convert to ISO so the server gets an unambiguous UTC instant.
              const local = new Date(scheduledDraft);
              if (isNaN(local.getTime())) {
                toast({ title: "Invalid date", variant: "destructive" });
                return;
              }
              saveFieldsM.mutate({ scheduled_for: local.toISOString() });
            }}
            disabled={saveFieldsM.isPending || scheduledDraft === toDatetimeLocal(row.scheduledFor)}
          >
            <Save className="w-3 h-3 mr-1" /> Save schedule
          </Button>
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          Note: rescheduling updates this row only. The daily cron at 10:00 (Europe/London) still creates a NEW row each day.
          Auto-publish at the scheduled time requires Meta review approval.
        </p>
      </section>
    </div>
  );
}

export default function AdminInstagramPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [imagePreview, setImagePreview] = useState<{ id: number; url: string } | null>(null);
  // "" = auto (today's rotation). Specific value pins to that post type.
  const [postTypeOverride, setPostTypeOverride] = useState<"" | IgPostType>("");

  // ── Settings + next post
  const settingsQ = useQuery<IgSettings>({
    queryKey: ["/api/admin/ig/settings"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/ig/settings");
      return res.json();
    },
  });

  // ── Queue paginated
  const queueQ = useQuery<{ rows: IgQueueRow[]; total: number; page: number; limit: number }>({
    queryKey: ["/api/admin/ig/queue", page],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/ig/queue?page=${page}&limit=20`);
      return res.json();
    },
  });

  // ── Toggle posting
  const toggleM = useMutation({
    mutationFn: async (postEnabled: boolean) => {
      const res = await apiRequest("PATCH", "/api/admin/ig/settings", { postEnabled });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/settings"] });
      toast({ title: "Setting updated" });
    },
    onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  // ── Post now (one-off). Sends post_type when an override is selected;
  // otherwise the server falls back to today's day-of-week rotation.
  const postNowM = useMutation({
    mutationFn: async () => {
      const body = postTypeOverride ? { post_type: postTypeOverride } : {};
      const res = await apiRequest("POST", "/api/admin/ig/post-now", body);
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/queue"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/settings"] });
      toast({ title: `Post-now: ${data.status} (${data.postType ?? "?"})`, description: data.metaPostId ?? data.reason ?? "" });
    },
    onError: (err: any) => toast({ title: "Post-now failed", description: err.message, variant: "destructive" }),
  });

  const skipM = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/admin/ig/queue/${id}/skip`, {});
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/queue"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/settings"] });
      toast({ title: "Queue row skipped" });
    },
    onError: (err: any) => toast({ title: "Skip failed", description: err.message, variant: "destructive" }),
  });

  const retryM = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/admin/ig/queue/${id}/retry`, {});
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/queue"] });
      toast({ title: "Reset to pending — will retry on next tick" });
    },
    onError: (err: any) => toast({ title: "Retry failed", description: err.message, variant: "destructive" }),
  });

  async function loadImagePreview(id: number) {
    try {
      const res = await apiRequest("GET", `/api/admin/ig/queue/${id}/image-url`);
      const data = await res.json();
      if (data.url) setImagePreview({ id, url: data.url });
    } catch (err: any) {
      toast({ title: "Failed to load preview", description: err.message, variant: "destructive" });
    }
  }

  const settings = settingsQ.data;
  const liveCapable = settings?.envGate && settings?.postEnabled && !settings?.dryRunEnvVar;
  const totalPages = queueQ.data ? Math.max(1, Math.ceil(queueQ.data.total / queueQ.data.limit)) : 1;

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold text-zinc-900">Instagram automation</h1>
          <p className="text-sm text-zinc-500">Daily auto-post pipeline. All posts queue here for review before publish.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { settingsQ.refetch(); queueQ.refetch(); }}
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* ── Section 1: Controls ──────────────────────────────────────── */}
      <div className="bg-white border border-zinc-200 rounded-lg p-6 mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-500 mb-4">Controls</h2>
        {settingsQ.isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
        ) : (
          <div className="flex flex-wrap gap-4 items-center">
            <Button
              variant={settings?.postEnabled ? "default" : "outline"}
              onClick={() => toggleM.mutate(!settings?.postEnabled)}
              disabled={toggleM.isPending}
              className={settings?.postEnabled ? "bg-emerald-600 hover:bg-emerald-700" : ""}
            >
              <span className={`inline-block w-2 h-2 rounded-full mr-2 ${settings?.postEnabled ? "bg-emerald-100" : "bg-zinc-400"}`} />
              {settings?.postEnabled ? "Posting LIVE" : "Posting PAUSED"}
            </Button>

            <div className="flex items-center gap-2">
              <select
                value={postTypeOverride}
                onChange={(e) => setPostTypeOverride(e.target.value as "" | IgPostType)}
                disabled={postNowM.isPending}
                className="h-9 px-2 py-1 text-sm border border-zinc-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                aria-label="Post type override for Post Now"
              >
                <option value="">Auto (today's rotation)</option>
                {IG_POST_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              <Button
                onClick={() => postNowM.mutate()}
                disabled={!settings?.postEnabled || postNowM.isPending}
                variant="outline"
              >
                {postNowM.isPending
                  ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  : <Send className="w-4 h-4 mr-2" />}
                Post Now
              </Button>
            </div>

            <div className="ml-auto text-xs text-zinc-500 space-x-3">
              <span>env IG_POST_ENABLED: <strong className={settings?.envGate ? "text-emerald-600" : "text-zinc-400"}>{settings?.envGate ? "true" : "false"}</strong></span>
              <span>env IG_DRY_RUN: <strong className={settings?.dryRunEnvVar ? "text-amber-600" : "text-zinc-400"}>{settings?.dryRunEnvVar ? "true" : "false"}</strong></span>
              <span>publish-capable: <strong className={liveCapable ? "text-emerald-600" : "text-zinc-400"}>{liveCapable ? "yes" : "no"}</strong></span>
            </div>
          </div>
        )}
        {settings && !settings.envGate && (
          <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            <strong>Heads-up:</strong> the IG_POST_ENABLED env flag is <code>false</code>. Even if you flip the live toggle on,
            no publish will happen until you also set <code>IG_POST_ENABLED=true</code> in Fly secrets and redeploy.
            This double-gate is intentional — see <code>server/ig/meta-poster.ts</code>.
          </p>
        )}
      </div>

      {/* ── Section 2: Most recent queued post (edit panel) ──────────── */}
      <div className="bg-white border border-zinc-200 rounded-lg p-6 mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-500 mb-4">Most recent queued post</h2>
        {settings?.nextPost ? (
          <QueuedPostPanel row={settings.nextPost} />
        ) : (
          <p className="text-sm text-zinc-500">No posts scheduled — click <strong>Post Now</strong> to generate one, or wait for the daily 10:00 (London) tick.</p>
        )}
      </div>

      {/* ── Section 3: Queue table ────────────────────────────────────── */}
      <div className="bg-white border border-zinc-200 rounded-lg p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-500 mb-4">Post queue</h2>
        {queueQ.isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
        ) : queueQ.data && queueQ.data.rows.length === 0 ? (
          <p className="text-sm text-zinc-500">Queue is empty.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 uppercase tracking-wide border-b border-zinc-200">
                    <th className="py-2 pr-4">Scheduled</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Cert</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Meta Post ID</th>
                    <th className="py-2 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {queueQ.data?.rows.map((row) => {
                    const SS = STATUS_STYLES[row.status];
                    return (
                      <tr key={row.id} className="border-b border-zinc-100 last:border-0">
                        <td className="py-2 pr-4 font-mono text-xs text-zinc-600">{fmt(row.scheduledFor)}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-zinc-700">{row.postType}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-zinc-600">{row.certId ?? "—"}</td>
                        <td className="py-2 pr-4">
                          <Badge className={SS.cls}>
                            <SS.icon className="w-3 h-3 mr-1" /> {SS.label}
                          </Badge>
                          {row.status === "failed" && row.errorDetail && (
                            <p className="text-xs text-red-700 mt-1 max-w-md truncate" title={row.errorDetail}>{row.errorDetail}</p>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs text-zinc-600 break-all">{row.metaPostId ?? "—"}</td>
                        <td className="py-2 pr-4 text-right space-x-1">
                          {row.imageR2Key && (
                            <Button size="sm" variant="ghost" onClick={() => loadImagePreview(row.id)}>
                              <ImageIcon className="w-3 h-3" />
                            </Button>
                          )}
                          {row.status === "failed" && (
                            <Button size="sm" variant="ghost" onClick={() => retryM.mutate(row.id)} disabled={retryM.isPending}>
                              <RotateCcw className="w-3 h-3" />
                            </Button>
                          )}
                          {row.status !== "posted" && (
                            <Button size="sm" variant="ghost" onClick={() => skipM.mutate(row.id)} disabled={skipM.isPending}>
                              <SkipForward className="w-3 h-3" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex justify-between items-center mt-4 text-sm">
                <span className="text-zinc-500">Page {page} of {totalPages} ({queueQ.data?.total} total)</span>
                <div className="space-x-2">
                  <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Image preview overlay */}
      {imagePreview && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 cursor-pointer"
          onClick={() => setImagePreview(null)}
        >
          <img
            src={imagePreview.url}
            alt={`IG preview ${imagePreview.id}`}
            className="max-w-[600px] max-h-[600px] border-4 border-amber-400 rounded shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
