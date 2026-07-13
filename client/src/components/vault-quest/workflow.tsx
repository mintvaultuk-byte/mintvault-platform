import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AdminButton } from "@/components/admin";
import {
  Play, Clock3, AlertTriangle, CheckCircle2, Lock, Search, ChevronDown, ChevronUp,
  SkipForward, RotateCcw, Pause, ArrowUp, ArrowDown, Sparkles, Coins, History,
  ExternalLink, X, Command,
} from "lucide-react";

/**
 * Phase 5 — production workflow polish components: Today's Task home, Next-Task
 * queue, credits dashboard, smart warnings, global search + Cmd/Ctrl-K palette,
 * bulk character operations, collapsible sections with remembered state.
 * All data derives from /sets/:setCode/workflow — no new tables.
 */

export const SET_CODE = "GNV";
const GOLD = "#D4AF37";

// ── shared types (mirror server/vault-quest/workflow-engine.ts) ──
export interface TaskTarget {
  setCode: string; familyId: string | null; characterId: string | null; cardId: string | null;
  section: string; step: string; referenceType: string | null; url: string;
}
export interface WorkflowTask {
  id: string; kind: string; label: string; section: string;
  characterId: string | null; characterName: string | null; familyId: string | null; stageNumber: number | null;
  cardId: string | null;
  status: "queued" | "waiting_for_review" | "approved" | "locked" | "completed";
  estMinutes: number; estCredits: number;
  reuse: { alreadyExists: boolean; note: string } | null;
  target: TaskTarget;
}
export interface SmartWarning { code: string; severity: "warn" | "block"; message: string; ref: string | null }
export interface WorkflowFeed {
  setCode: string; current: WorkflowTask | null; queue: WorkflowTask[]; queueTotal: number;
  estMinutesRemaining: number; warnings: SmartWarning[]; releaseBlocked: boolean;
  credits: { today: number; week: number; month: number; generationsToday: number; avgPerCard: number; avgPerFamily: number; estimatedRemaining: number; potentialSavings: number; perImage: number };
  recent: Record<"edited" | "generated" | "approved" | "locked", { ref: string; note: string | null; at: string }[]>;
  activity: { kind: string; label: string; at: string }[];
}

export function useWorkflow() {
  return useQuery<WorkflowFeed>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/workflow`], retry: false, refetchInterval: 60_000 });
}

// ── founder mode (persisted) ──
export function useFounderMode(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem("vq.founderMode") !== "0");
  return [on, (v) => { localStorage.setItem("vq.founderMode", v ? "1" : "0"); setOn(v); }];
}

/**
 * Advanced Mode (Phase 5.2). DEFAULT OFF — the Studio opens in the simple
 * founder workflow with plain language only. Turning this ON reveals the
 * technical surface: full navigation, AI provider/model names, credits detail,
 * identity scores, queue reordering, bulk operations, developer info.
 */
export function useAdvancedMode(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem("vq.advancedMode") === "1");
  return [on, (v) => { localStorage.setItem("vq.advancedMode", v ? "1" : "0"); setOn(v); }];
}

// ── collapsible section that remembers open state ──
export function Collapse({ id, title, defaultOpen = true, children, badge }: { id: string; title: string; defaultOpen?: boolean; children: React.ReactNode; badge?: React.ReactNode }) {
  const key = `vq.collapse.${id}`;
  const [open, setOpen] = useState(() => { const v = localStorage.getItem(key); return v == null ? defaultOpen : v === "1"; });
  const toggle = () => { localStorage.setItem(key, open ? "0" : "1"); setOpen(!open); };
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50">
      <button onClick={toggle} className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-200">{title}{badge}</span>
        {open ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
      </button>
      {open && <div className="border-t border-slate-800 p-4">{children}</div>}
    </section>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return <div className="space-y-2">{Array.from({ length: lines }, (_, i) => <div key={i} className="h-4 animate-pulse rounded bg-slate-800" style={{ width: `${85 - i * 15}%` }} />)}</div>;
}
export function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-slate-800 px-4 py-6 text-center text-xs text-slate-600">{text}</div>;
}

const fmtMins = (m: number) => (m >= 60 ? `~${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : `~${m}m`);
const timeAgo = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// ── queue local overrides (skip/pause/order) — client-side, persisted ──
type QueueOverrides = { skipped: string[]; paused: boolean; order: string[] };
function loadOverrides(): QueueOverrides {
  try { return { skipped: [], paused: false, order: [], ...JSON.parse(localStorage.getItem("vq.queue") ?? "{}") }; } catch { return { skipped: [], paused: false, order: [] }; }
}
function saveOverrides(o: QueueOverrides) { localStorage.setItem("vq.queue", JSON.stringify(o)); }

export function useOrderedQueue(feed: WorkflowFeed | undefined) {
  const [ov, setOv] = useState<QueueOverrides>(loadOverrides);
  const update = (next: QueueOverrides) => { saveOverrides(next); setOv(next); };
  const queue = useMemo(() => {
    if (!feed) return [];
    const skip = new Set(ov.skipped);
    const base = feed.queue.filter((t) => !skip.has(t.id));
    if (!ov.order.length) return base;
    const pos = new Map(ov.order.map((id, i) => [id, i]));
    return [...base].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  }, [feed, ov]);
  return {
    queue, paused: ov.paused, skipped: ov.skipped,
    skip: (id: string) => update({ ...ov, skipped: [...ov.skipped, id] }),
    retry: (id: string) => update({ ...ov, skipped: ov.skipped.filter((s) => s !== id) }),
    setPaused: (p: boolean) => update({ ...ov, paused: p }),
    move: (id: string, dir: -1 | 1) => {
      // Persist the order over the FULL feed queue (current override order applied),
      // not just the visible/filtered one — otherwise the first move snapshots only
      // unskipped ids, and skipped-then-retried or newly-arrived tasks all fall to
      // the bottom regardless of their real priority.
      const pos = new Map(ov.order.map((oid, i) => [oid, i]));
      const full = feed ? [...feed.queue].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)).map((t) => t.id) : queue.map((t) => t.id);
      // Swap with the adjacent VISIBLE item (what the founder sees), then persist full order.
      const visible = queue.map((t) => t.id);
      const vi = visible.indexOf(id);
      const vj = vi + dir;
      if (vi < 0 || vj < 0 || vj >= visible.length) return;
      const otherId = visible[vj];
      const fi = full.indexOf(id);
      const fj = full.indexOf(otherId);
      if (fi < 0 || fj < 0) return;
      [full[fi], full[fj]] = [full[fj], full[fi]];
      update({ ...ov, order: full });
    },
  };
}

// ── WARNINGS BANNER ──
export function WarningsPanel({ warnings }: { warnings: SmartWarning[] }) {
  if (!warnings.length) return <div className="flex items-center gap-2 rounded-lg border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300"><CheckCircle2 className="h-4 w-4" />No warnings — release path clear.</div>;
  return (
    <div className="space-y-1.5">
      {warnings.map((w, i) => (
        <div key={i} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${w.severity === "block" ? "border-red-900 bg-red-950/40 text-red-300" : "border-amber-800 bg-amber-950/30 text-amber-200"}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  );
}

// ── HOME: Today's Task + resume + recents + activity ──
export function HomeDashboard({ feed, loading, go }: { feed: WorkflowFeed | undefined; loading: boolean; go: (section: string) => void }) {
  const cur = feed?.current ?? null;
  return (
    <div>
      <div className="mb-5 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-[#0c0f15] p-6">
        <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: GOLD }}>Today's task</div>
        {loading ? <div className="mt-3"><Skeleton lines={3} /></div> : cur ? (
          <div className="mt-2 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-3xl font-black text-slate-100">{cur.label}</div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                <span>Set <b className="text-slate-200">{feed?.setCode}</b></span>
                {cur.familyId && <span>Family <b className="text-slate-200">{cur.familyId}</b></span>}
                {cur.characterName && <span>Character <b className="text-slate-200">{cur.characterName}</b></span>}
                {cur.stageNumber != null && <span>Stage <b className="text-slate-200">{cur.stageNumber}</b></span>}
                <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />Remaining <b className="text-slate-200">{fmtMins(feed?.estMinutesRemaining ?? 0)}</b> across {feed?.queueTotal} tasks</span>
              </div>
              {cur.reuse?.alreadyExists && <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-sky-800 bg-sky-950/40 px-2 py-1 text-[11px] text-sky-300"><Sparkles className="h-3 w-3" />{cur.reuse.note}</div>}
            </div>
            <div className="flex flex-col items-start gap-1 md:items-end">
              {cur.characterId || cur.cardId ? (
                <Link href={cur.target?.url ?? "/admin/vault-quest"} onClick={() => localStorage.setItem("vq.resume", JSON.stringify(cur.target ?? cur))}>
                  <span className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-8 py-3.5 text-sm font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}><Play className="h-4 w-4" />RESUME WORK</span>
                </Link>
              ) : (
                <button onClick={() => go(cur.section)} className="inline-flex items-center gap-2 rounded-xl px-8 py-3.5 text-sm font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}><Play className="h-4 w-4" />RESUME WORK</button>
              )}
              {cur.estCredits > 0 && <span className="text-[11px] text-slate-500">≈ {cur.estCredits} credits for this step</span>}
            </div>
          </div>
        ) : feed ? (
          <div className="mt-2 text-2xl font-black text-emerald-300">All production tasks complete 🎉</div>
        ) : (
          // No feed at all (expired session / fetch failure) is NOT completion.
          <div className="mt-2 text-sm text-slate-400">Couldn't load your tasks — check you're signed in as admin, then refresh.</div>
        )}
      </div>

      <div className="mb-4"><Collapse id="home-warnings" title="Smart warnings" badge={feed?.warnings.length ? <span className="rounded-full bg-red-950 px-2 py-0.5 text-[10px] font-bold text-red-300">{feed.warnings.length}</span> : undefined}>
        {loading ? <Skeleton /> : <WarningsPanel warnings={feed?.warnings ?? []} />}
      </Collapse></div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Collapse id="home-recent" title="Recent items">
          {loading ? <Skeleton lines={4} /> : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(["edited", "generated", "approved", "locked"] as const).map((k) => (
                <div key={k}>
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Recently {k}</div>
                  {(feed?.recent[k] ?? []).length === 0 ? <div className="text-xs text-slate-600">—</div> : (
                    <ul className="space-y-1">{feed!.recent[k].slice(0, 4).map((r, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 text-xs"><span className="truncate text-slate-300">{r.ref}{r.note ? <span className="text-slate-500"> · {r.note}</span> : null}</span><span className="shrink-0 text-slate-600">{r.at ? timeAgo(r.at) : ""}</span></li>
                    ))}</ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </Collapse>
        <Collapse id="home-activity" title="Activity log">
          {loading ? <Skeleton lines={5} /> : (feed?.activity.length ?? 0) === 0 ? <Empty text="No recorded activity yet." /> : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">{feed!.activity.map((a, i) => (
              <li key={i} className="flex items-center justify-between gap-3 rounded-md border border-slate-800/70 bg-slate-900/40 px-2.5 py-1.5 text-xs">
                <span className="flex items-center gap-2 truncate text-slate-300"><History className="h-3 w-3 shrink-0 text-slate-600" />{a.label}</span>
                <span className="shrink-0 text-slate-600">{timeAgo(a.at)}</span>
              </li>
            ))}</ul>
          )}
        </Collapse>
      </div>
    </div>
  );
}

// ── PRODUCTION QUEUE ──
const Q_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "text-slate-400 border-slate-700 bg-slate-800/60" },
  running: { label: "Running", cls: "text-sky-300 border-sky-800 bg-sky-950/50" },
  waiting_for_review: { label: "Waiting For Review", cls: "text-amber-300 border-amber-800 bg-amber-950/50" },
  approved: { label: "Approved", cls: "text-emerald-300 border-emerald-800 bg-emerald-950/50" },
  locked: { label: "Locked", cls: "text-violet-300 border-violet-800 bg-violet-950/50" },
  completed: { label: "Completed", cls: "text-emerald-200 border-emerald-700 bg-emerald-900/60" },
};
export function ProductionQueue({ feed, loading, founderMode, go }: { feed: WorkflowFeed | undefined; loading: boolean; founderMode: boolean; go: (s: string) => void }) {
  const { queue, paused, skipped, skip, retry, setPaused, move } = useOrderedQueue(feed);
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-xs text-slate-500">{queue.length} open task(s) · {fmtMins(queue.reduce((a, t) => a + t.estMinutes, 0))} estimated{paused && <span className="ml-2 rounded bg-amber-950 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">PAUSED</span>}</div>
        <AdminButton variant="ghost" onClick={() => setPaused(!paused)}>{paused ? <><Play className="mr-1 inline h-3.5 w-3.5" />Resume queue</> : <><Pause className="mr-1 inline h-3.5 w-3.5" />Pause queue</>}</AdminButton>
      </div>
      {loading ? <Skeleton lines={6} /> : queue.length === 0 ? <Empty text="Queue is empty — everything is complete or skipped." /> : (
        <div className={`space-y-1.5 ${paused ? "opacity-60" : ""}`}>
          {queue.map((t, i) => (
            <div key={t.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${i === 0 && !paused ? "border-slate-600 bg-slate-900" : "border-slate-800 bg-slate-900/50"}`}>
              <span className="w-6 shrink-0 text-center text-xs tabular-nums text-slate-600">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-200">{t.label}{t.characterName && <span className="text-slate-500"> — {t.characterName} ({t.characterId})</span>}</div>
                <div className="text-[10px] text-slate-600">{t.familyId ?? "set-level"} · {fmtMins(t.estMinutes)}{t.estCredits > 0 ? ` · ≈${t.estCredits}cr` : ""}{t.reuse?.alreadyExists ? " · reuse available" : ""}</div>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${Q_STATUS[t.status]?.cls ?? Q_STATUS.queued.cls}`}>{Q_STATUS[t.status]?.label ?? t.status}</span>
              <div className="flex shrink-0 items-center gap-0.5">
                {t.characterId || t.cardId ? (
                  <Link href={t.target?.url ?? "/admin/vault-quest"} title="Open exact target" className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><ExternalLink className="h-3.5 w-3.5" /></Link>
                ) : (
                  <button title="Open" onClick={() => go(t.section)} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><ExternalLink className="h-3.5 w-3.5" /></button>
                )}
                {founderMode && <>
                  <button title="Move up" onClick={() => move(t.id, -1)} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button title="Move down" onClick={() => move(t.id, 1)} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><ArrowDown className="h-3.5 w-3.5" /></button>
                </>}
                <button title="Skip" onClick={() => skip(t.id)} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><SkipForward className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {skipped.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Skipped ({skipped.length})</div>
          <div className="flex flex-wrap gap-1.5">{skipped.map((id) => (
            <button key={id} onClick={() => retry(id)} className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/50 px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200"><RotateCcw className="h-3 w-3" />{id}</button>
          ))}</div>
        </div>
      )}
    </div>
  );
}

// ── CREDITS DASHBOARD ──
export function CreditsDashboard({ feed, loading }: { feed: WorkflowFeed | undefined; loading: boolean }) {
  const c = feed?.credits;
  if (loading || !c) return <Skeleton lines={4} />;
  const Tile = ({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) => (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Today" value={c.today} sub={`${c.generationsToday} generation(s)`} />
        <Tile label="This week" value={c.week} />
        <Tile label="This month" value={c.month} />
        <Tile label="Per image" value={c.perImage} sub="current model" />
        <Tile label="Avg per card" value={c.avgPerCard} />
        <Tile label="Avg per family" value={c.avgPerFamily} />
        <Tile label="Est. remaining spend" value={c.estimatedRemaining} sub="to finish open queue" />
        <Tile label="Potential savings" value={c.potentialSavings} sub="by reusing approved refs" />
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500"><Coins className="h-3.5 w-3.5" />Credits are estimated from the AI generation audit trail (image generations × current per-image cost). Text generations are free-tier.</p>
    </div>
  );
}

// ── BULK CHARACTER OPERATIONS ──
export function BulkBar({ selected, clear, onDone }: { selected: string[]; clear: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (label: string, patch: Record<string, unknown>) => {
    if (!selected.length) return;
    if (!window.confirm(`${label} ${selected.length} character(s)?\n\n${selected.join(", ")}`)) return;
    setBusy(label);
    let ok = 0;
    const failed: string[] = [];
    for (const id of selected) {
      try {
        const r = await apiRequest("PATCH", `/api/admin/vault-quest/characters/${id}`, patch);
        if (r.ok) ok++; else failed.push(id);
      } catch { failed.push(id); }
    }
    setBusy(null);
    toast({ title: `${label}: ${ok} succeeded${failed.length ? `, ${failed.length} failed` : ""}`, description: failed.length ? failed.join(", ") : undefined, variant: failed.length ? "destructive" : undefined });
    clear();
    onDone();
  };
  if (!selected.length) return null;
  return (
    <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-[#12151d] p-3 shadow-xl">
      <span className="text-xs font-semibold text-slate-300">{selected.length} selected</span>
      <AdminButton variant="gold" disabled={!!busy} onClick={() => run("Approve", { approvalStatus: "approved" })}>Approve Selected</AdminButton>
      <AdminButton variant="ghost" disabled={!!busy} onClick={() => run("Reject (back to draft)", { approvalStatus: "draft" })}>Reject Selected</AdminButton>
      <AdminButton variant="ghost" disabled={!!busy} onClick={() => run("Lock", { locked: true })}><Lock className="mr-1 inline h-3.5 w-3.5" />Lock Selected</AdminButton>
      <AdminButton variant="ghost" disabled={!!busy} onClick={() => run("Unlock", { locked: false })}>Unlock Selected</AdminButton>
      <button onClick={clear} className="ml-auto rounded p-1 text-slate-500 hover:text-slate-200"><X className="h-4 w-4" /></button>
    </div>
  );
}

// ── GLOBAL SEARCH + COMMAND PALETTE (Cmd/Ctrl+K) ──
interface SearchResult { type: string; ref: string; label: string; sub: string; section: string }
export function CommandPalette({ open, close, go }: { open: boolean; close: () => void; go: (section: string) => void }) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useQuery<{ results: SearchResult[] }>({
    queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/search?q=${encodeURIComponent(q)}`],
    enabled: open && q.trim().length >= 2,
    retry: false,
  });
  useEffect(() => { if (open) { setQ(""); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);

  const COMMANDS: { label: string; section: string; hint?: string }[] = [
    { label: "Open Character Bible", section: "characters", hint: "characters" },
    { label: "Generate Description", section: "characters" },
    { label: "Generate References", section: "characters" },
    { label: "Generate Cards", section: "standard" },
    { label: "Jump to Family", section: "families" },
    { label: "Packaging", section: "packaging" },
    { label: "Print", section: "print" },
    { label: "Release", section: "release" },
    { label: "Search Asset", section: "assets" },
    { label: "Production Queue", section: "queue" },
    { label: "Credits", section: "credits" },
  ];
  const cmds = q.trim() ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())) : COMMANDS;
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]" onClick={close}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-700 bg-[#10131a] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <Search className="h-4 w-4 text-slate-500" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && close()} placeholder="Search characters, families, cards, packaging, assets…" className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-600" />
          <kbd className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-500">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {q.trim().length >= 2 && (
            <>
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Results</div>
              {search.isLoading ? <div className="p-2"><Skeleton lines={2} /></div>
                : (search.data?.results ?? []).length === 0 ? <div className="px-2 pb-2 text-xs text-slate-600">No matches.</div>
                : search.data!.results.map((r, i) => (
                  <button key={i} onClick={() => { go(r.section); close(); }} className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-slate-800">
                    <span className="text-sm text-slate-200">{r.label}<span className="ml-2 text-xs text-slate-500">{r.sub}</span></span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">{r.type}</span>
                  </button>
                ))}
              <div className="mt-1 border-t border-slate-800 pt-1" />
            </>
          )}
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Commands</div>
          {cmds.map((c) => (
            <button key={c.label} onClick={() => { go(c.section); close(); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-slate-300 hover:bg-slate-800">
              <Command className="h-3.5 w-3.5 text-slate-600" />{c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── APPROVED-ASSET REUSE PANEL (shown BEFORE any generation when reusable assets exist) ──
export interface ReusableAsset { label: string; r2Key: string; kind: string; approvalStatus: string; identityScore: number | null; from: string }
export interface ReuseCheck { assets: ReusableAsset[]; creditsSaved: number; perImage: number; referenceType: string | null }

export async function fetchReuseCheck(params: { characterId?: string; cardId?: string; referenceType?: string }): Promise<ReuseCheck | null> {
  const qs = new URLSearchParams();
  if (params.characterId) qs.set("characterId", params.characterId);
  if (params.cardId) qs.set("cardId", params.cardId);
  if (params.referenceType) qs.set("referenceType", params.referenceType);
  try {
    const r = await fetch(`/api/admin/vault-quest/sets/${SET_CODE}/reuse-check?${qs}`, { credentials: "include" });
    if (!r.ok) return null;
    return (await r.json()) as ReuseCheck;
  } catch {
    return null;
  }
}

export function ReusePanel({ check, providerLabel, onReuse, onGenerateWithRefs, onGenerateAnyway, onClose, busy }: {
  check: ReuseCheck;
  providerLabel: string;
  onReuse: (asset: ReusableAsset) => void;
  onGenerateWithRefs: () => void;
  onGenerateAnyway: () => void;
  onClose: () => void;
  busy: boolean;
}) {
  // NOTE: no window.confirm() here (on purpose). A native confirm() blocks the whole
  // page/render thread until answered, shows no progress feedback, and is redundant
  // with the credit-spend warning already visible as plain text below — the founder
  // has already made an explicit choice by opening this panel and picking a button.
  const [picked, setPicked] = useState<ReusableAsset | null>(check.assets[0] ?? null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700 bg-[#10131a] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-bold text-slate-100"><Sparkles className="h-4 w-4" style={{ color: GOLD }} />Approved assets found — reuse before generating?</span>
          <button onClick={onClose} className="rounded p-1 text-slate-500 hover:text-slate-200"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[45vh] space-y-1.5 overflow-y-auto p-4">
          {check.assets.map((a) => (
            <label key={a.r2Key} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${picked?.r2Key === a.r2Key ? "border-slate-500 bg-slate-800/70" : "border-slate-800 bg-slate-900/50"}`}>
              <input type="radio" name="reuse-asset" checked={picked?.r2Key === a.r2Key} onChange={() => setPicked(a)} className="accent-[#D4AF37]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-200">{a.label}</div>
                <div className="text-[10px] text-slate-500">{a.kind.replace(/_/g, " ")} · from {a.from} · <span className={a.approvalStatus === "approved" ? "text-emerald-400" : ""}>{a.approvalStatus}</span>{a.identityScore != null ? ` · identity ${a.identityScore}` : ""}</div>
              </div>
            </label>
          ))}
        </div>
        <div className="space-y-0.5 border-t border-slate-800 px-4 py-2.5 text-[11px] text-slate-400">
          <div>Images already exist: <b className="text-slate-200">{check.assets.length}</b></div>
          <div>Credits that can be saved: <b className="text-emerald-400">{check.creditsSaved}</b></div>
          <div>Recommended action: <b style={{ color: "#D4AF37" }}>Reuse existing assets</b> — generating new spends ≈{check.creditsSaved || check.perImage} on <span className="text-slate-300">{providerLabel}</span>.</div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-slate-800 p-4">
          <AdminButton variant="gold" disabled={busy || !picked} onClick={() => picked && onReuse(picked)}>Reuse Approved Asset (0 cr)</AdminButton>
          <AdminButton variant="ghost" disabled={busy} onClick={() => onGenerateWithRefs()}>Use as Reference &amp; Generate New</AdminButton>
          <AdminButton variant="ghost" disabled={busy} onClick={() => onGenerateAnyway()}>Generate New Anyway</AdminButton>
        </div>
      </div>
    </div>
  );
}

/** Global Cmd/Ctrl+K hook. */
export function usePalette(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  return [open, setOpen];
}
