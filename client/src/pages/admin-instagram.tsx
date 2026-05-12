import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Loader2, RefreshCw, SkipForward, RotateCcw, Send, ImageIcon,
  CheckCircle2, AlertCircle, Clock, Ban,
} from "lucide-react";
import type { IgPostStatus } from "@shared/schema";

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

export default function AdminInstagramPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [imagePreview, setImagePreview] = useState<{ id: number; url: string } | null>(null);

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

  // ── Post now (one-off)
  const postNowM = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/ig/post-now", {});
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/queue"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/settings"] });
      toast({ title: `Post-now: ${data.status}`, description: data.metaPostId ?? data.reason ?? "" });
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

      {/* ── Section 2: Most recent queued post (preview) ─────────────── */}
      <div className="bg-white border border-zinc-200 rounded-lg p-6 mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-500 mb-4">Most recent queued post</h2>
        {settings?.nextPost ? (
          <div className="flex gap-6">
            <div className="w-48 h-48 border border-zinc-200 rounded flex items-center justify-center bg-zinc-50 shrink-0">
              {settings.nextPost.imageR2Key ? (
                <Button variant="ghost" size="sm" onClick={() => loadImagePreview(settings.nextPost!.id)}>
                  <ImageIcon className="w-4 h-4 mr-2" /> Load preview
                </Button>
              ) : (
                <span className="text-xs text-zinc-400">No image yet</span>
              )}
            </div>
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-3">
                <Badge className={STATUS_STYLES[settings.nextPost.status].cls}>
                  {STATUS_STYLES[settings.nextPost.status].label}
                </Badge>
                <span className="text-xs font-mono text-zinc-500">{settings.nextPost.postType}</span>
                <span className="text-xs text-zinc-500">scheduled {fmt(settings.nextPost.scheduledFor)}</span>
              </div>
              {settings.nextPost.caption && (
                <p className="text-sm text-zinc-700 whitespace-pre-wrap">{settings.nextPost.caption}</p>
              )}
              {settings.nextPost.hashtags && (
                <p className="text-xs text-blue-600 font-mono">{settings.nextPost.hashtags}</p>
              )}
              {settings.nextPost.errorDetail && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">{settings.nextPost.errorDetail}</p>
              )}
              <div className="flex gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={() => skipM.mutate(settings.nextPost!.id)}>
                  <SkipForward className="w-3 h-3 mr-1" /> Skip
                </Button>
                {settings.nextPost.status === "failed" && (
                  <Button size="sm" variant="outline" onClick={() => retryM.mutate(settings.nextPost!.id)}>
                    <RotateCcw className="w-3 h-3 mr-1" /> Retry
                  </Button>
                )}
              </div>
            </div>
          </div>
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
