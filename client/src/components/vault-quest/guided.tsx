import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { STATUS_META, type VqStatus } from "@shared/vq-workflow";
import {
  Users, Layers, Sparkles, Package, Play, CheckCircle2, Clock3, Wand2, ChevronRight, Coins,
} from "lucide-react";
import { type WorkflowFeed, type WorkflowTask, Skeleton } from "./workflow";

/**
 * Phase 5.2 — the SIMPLE founder workflow. Four large production stages, worked
 * top to bottom, plain language only. All data derives from the existing
 * workflow feed + dashboard; nothing here generates anything by itself.
 */

const GOLD = "#D4AF37";
const cardDone = (status: string) => STATUS_META[status as VqStatus]?.tone === "success";

// Which engine task kinds belong to each of the four big steps.
const STEP1_KINDS = new Set(["description", "approve_description", "master_reference", "action_pose", "approve_references", "lock_character"]);
const STEP4_KINDS = new Set(["qa", "packaging", "release"]);

type DashCard = { cardId: string; cardType: string; stageNumber: number | null; variantTier: string | null; baseCardId: string | null; status: string };

export interface GuidedCounts {
  charactersTotal: number;
  charactersApproved: number;
  familiesTotal: number;
  familiesComplete: number;
}

const fmtMins = (m: number) => (m >= 60 ? `~${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ""}`.trim() : m > 0 ? `~${m}m` : "done");

/**
 * Section for a studio-INTERNAL target URL, else null. Guided components render
 * inside the studio; a wouter <Link> to the same route only rewrites the address
 * bar (the section lives in component state), so these targets must switch the
 * section via callback instead of navigating.
 */
const STUDIO_PATH = "/admin/vault-quest/studio";
export function studioSectionOf(url: string | null): string | null {
  if (!url || !url.startsWith(STUDIO_PATH)) return null;
  return new URLSearchParams(url.split("?")[1] ?? "").get("section");
}

function stepTasks(feed: WorkflowFeed | undefined, kinds: Set<string>): WorkflowTask[] {
  if (!feed) return [];
  return feed.queue.filter((t) => kinds.has(t.kind));
}

/** One friendly checklist row inside a step. */
function Row({ label, done, total, active }: { label: string; done: number; total: number; active?: boolean }) {
  const complete = total > 0 && done >= total;
  return (
    <div className="flex items-center gap-3 py-1.5">
      {complete ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${active ? "border-amber-400" : "border-slate-700"}`} />}
      <span className={`flex-1 text-sm ${complete ? "text-slate-400" : "text-slate-200"}`}>{label}</span>
      <span className="text-xs tabular-nums text-slate-500">{total > 0 ? `${Math.min(done, total)} / ${total}` : "—"}</span>
    </div>
  );
}

function BigBar({ pct, state }: { pct: number; state: "done" | "current" | "future" }) {
  const colour = state === "done" ? "#34d399" : state === "current" ? "#f59e0b" : "#475569";
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(state === "done" ? 100 : 0, pct))}%`, background: colour }} />
    </div>
  );
}

interface StepModel {
  n: 1 | 2 | 3 | 4;
  title: string;
  icon: typeof Users;
  pct: number;
  state: "done" | "current" | "future";
  estMinutes: number;
  estCredits: number;
  rows: { label: string; done: number; total: number }[];
  continueUrl: string | null; // exact deep-link for the next open task in this step
  continueLabel: string;
}

/** Build the four big steps from live data. */
export function useGuidedSteps(feed: WorkflowFeed | undefined, counts: GuidedCounts | undefined) {
  // Refetch on the same cadence as the workflow feed — with the app-wide
  // staleTime:Infinity default and no invalidator, this data was otherwise frozen
  // for the whole SPA session and Steps 2/3 never moved.
  const dash = useQuery<{ cards: DashCard[] }>({ queryKey: ["/api/admin/vault-quest/dashboard"], retry: false, refetchInterval: 60_000 });
  return useMemo<StepModel[]>(() => {
    const cards = dash.data?.cards ?? [];
    const base = cards.filter((c) => !c.baseCardId);
    const variants = cards.filter((c) => !!c.baseCardId);
    const creatures = base.filter((c) => c.cardType === "Creature");
    const support = base.filter((c) => ["Tactic", "Relic", "Vault", "Place"].includes(c.cardType));
    const collectors = base.filter((c) => c.cardType === "Collector");
    const byStage = (n: number) => creatures.filter((c) => c.stageNumber === n);
    const tier = (t: string) => variants.filter((c) => c.variantTier === t);
    const doneOf = (list: DashCard[]) => list.filter((c) => cardDone(c.status)).length;

    const t1 = stepTasks(feed, STEP1_KINDS);
    const t4 = stepTasks(feed, STEP4_KINDS);
    const q = feed?.queue ?? [];
    const firstUrl = (tasks: WorkflowTask[]) => tasks[0]?.target?.url ?? null;

    const charTotal = counts?.charactersTotal ?? 0;
    const charApproved = counts?.charactersApproved ?? 0;
    // Sub-step completion inferred from remaining task kinds.
    const remaining = (kind: string) => q.filter((t) => t.kind === kind).length;
    const step1Rows = [
      { label: "Character Descriptions", done: charTotal - remaining("description"), total: charTotal },
      { label: "Character Approval", done: charTotal - remaining("description") - remaining("approve_description"), total: charTotal },
      { label: "Master References", done: charTotal - remaining("description") - remaining("approve_description") - remaining("master_reference"), total: charTotal },
      { label: "Action References", done: charTotal - remaining("description") - remaining("approve_description") - remaining("master_reference") - remaining("action_pose"), total: charTotal },
      { label: "Lock Characters", done: charTotal - t1.length, total: charTotal },
    ];
    const step1Pct = charTotal ? Math.round(((charTotal - t1.length) / charTotal) * 100) : 0;

    const step2Rows = [
      { label: "Stage 1 Cards", done: doneOf(byStage(1)), total: byStage(1).length },
      { label: "Stage 2 Cards", done: doneOf(byStage(2)), total: byStage(2).length },
      { label: "Stage 3 Cards", done: doneOf(byStage(3)), total: byStage(3).length },
      { label: "Support Cards", done: doneOf(support), total: support.length },
    ];
    const step2Total = creatures.length + support.length;
    const step2Done = doneOf(creatures) + doneOf(support);
    const step2Pct = step2Total ? Math.round((step2Done / step2Total) * 100) : 0;

    const RARE: [string, string][] = [["CHR", "Character Rare"], ["SRA", "Super Rare"], ["UR", "Ultra Rare"], ["CR", "Secret Rare"], ["FSR", "Full Art"]];
    const step3Rows = [
      ...RARE.map(([t, label]) => ({ label, done: doneOf(tier(t)), total: tier(t).length })),
      { label: "Collector Cards", done: doneOf(collectors), total: collectors.length },
    ].filter((r) => r.total > 0 || ["Character Rare", "Super Rare", "Ultra Rare"].includes(r.label));
    const step3Total = variants.length + collectors.length;
    const step3Done = doneOf(variants) + doneOf(collectors);
    const step3Pct = step3Total ? Math.round((step3Done / step3Total) * 100) : 0;

    // Step 4 completion derived from the live feed: the engine drops each set-level
    // task (qa / packaging / release) from the queue once complete, so absence =
    // done. Rows were previously hardcoded 0 and Step 4 could never finish.
    const t4Open = (kind: string) => t4.some((t) => t.kind === kind);
    const step4Rows = [
      { label: "Packaging", done: t4Open("packaging") ? 0 : 1, total: 1 },
      { label: "Quality Check", done: t4Open("qa") ? 0 : 1, total: 1 },
      { label: "Release", done: t4Open("release") ? 0 : 1, total: 1 },
    ];
    const step4Pct = Math.round((step4Rows.filter((r) => r.done >= r.total).length / step4Rows.length) * 100);

    // Step 2 targets BASE cards only. The engine's generate_cards tasks bundle
    // base + variant work per character, so using them here double-counted every
    // open variant with Step 3 and could deep-link "Continue Cards" to a variant.
    const step2Open = step2Total - step2Done;
    const firstBaseOpen = [...creatures, ...support].find((c) => !cardDone(c.status));
    const step2Url = firstBaseOpen ? `/admin/vault-quest?card=${encodeURIComponent(firstBaseOpen.cardId)}&step=generate_cards` : null;

    // Step 3 continue target covers variants AND collector cards (both counted in its rows).
    const firstRareOpen = [...variants, ...collectors].find((c) => !cardDone(c.status));
    const step3Url = firstRareOpen ? `/admin/vault-quest?card=${encodeURIComponent(firstRareOpen.cardId)}&step=generate_cards` : null;

    const models: StepModel[] = [
      { n: 1, title: "Create Characters", icon: Users, pct: step1Pct, state: "future", estMinutes: t1.reduce((a, t) => a + t.estMinutes, 0), estCredits: t1.reduce((a, t) => a + t.estCredits, 0), rows: step1Rows, continueUrl: firstUrl(t1), continueLabel: "Continue Characters" },
      { n: 2, title: "Create Cards", icon: Layers, pct: step2Pct, state: "future", estMinutes: step2Open * 4, estCredits: step2Open, rows: step2Rows, continueUrl: step2Url, continueLabel: "Continue Cards" },
      { n: 3, title: "Create Rare Cards", icon: Sparkles, pct: step3Pct, state: "future", estMinutes: (step3Total - step3Done) * 4, estCredits: step3Total - step3Done, rows: step3Rows, continueUrl: step3Url, continueLabel: "Continue Rare Cards" },
      { n: 4, title: "Packaging & Print", icon: Package, pct: step4Pct, state: "future", estMinutes: t4.reduce((a, t) => a + t.estMinutes, 0), estCredits: 0, rows: step4Rows, continueUrl: "/admin/vault-quest/studio?section=packaging", continueLabel: "Continue Packaging" },
    ];
    // done/current/future colouring: first incomplete step is CURRENT; earlier are DONE.
    let currentSeen = false;
    for (const m of models) {
      const complete = m.pct >= 100;
      if (complete) m.state = "done";
      else if (!currentSeen) { m.state = "current"; currentSeen = true; }
      else m.state = "future";
    }
    return models;
  }, [feed, counts, dash.data]);
}

// ── the guided home: 4 large steps + AUTO BUILD + save-credits strip ──
export function GuidedHome({ feed, counts, loading, openStep, goSection }: {
  feed: WorkflowFeed | undefined;
  counts: GuidedCounts | undefined;
  goSection: (section: string) => void;
  loading: boolean;
  openStep: (n: 1 | 2 | 3 | 4) => void;
}) {
  const steps = useGuidedSteps(feed, counts);
  const current = steps.find((s) => s.state === "current");
  if (loading) return <Skeleton lines={6} />;
  return (
    <div>
      {/* what do I do next? */}
      <div className="mb-6 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-[#0c0f15] p-6">
        <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: GOLD }}>What do I do next?</div>
        <div className="mt-1 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-2xl font-black text-slate-100">{feed?.current?.label ?? current?.title ?? "All finished 🎉"}</div>
            {feed?.current?.characterName && <div className="mt-0.5 text-sm text-slate-400">{feed.current.characterName}</div>}
          </div>
          {studioSectionOf(feed?.current?.target?.url ?? null) ? (
            // Set-level task (qa/packaging/release): the target is THIS studio page —
            // a Link would only change the address bar; switch the section instead.
            <button onClick={() => goSection(studioSectionOf(feed!.current!.target.url)!)} className="inline-flex items-center gap-2 rounded-xl px-8 py-3.5 text-base font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}><Play className="h-5 w-5" />Continue</button>
          ) : feed?.current?.target?.url ? (
            <Link href={feed.current.target.url}>
              <span className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-8 py-3.5 text-base font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}><Play className="h-5 w-5" />Continue</span>
            </Link>
          ) : current ? (
            <button onClick={() => openStep(current.n)} className="inline-flex items-center gap-2 rounded-xl px-8 py-3.5 text-base font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}><Play className="h-5 w-5" />Continue</button>
          ) : null}
        </div>
      </div>

      {/* save credits strip */}
      {feed && feed.credits.potentialSavings > 0 && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-emerald-800 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300">
          <Coins className="h-4 w-4 shrink-0" />
          <span><b>{feed.credits.potentialSavings}</b> credits can be saved by reusing artwork you've already approved — you'll always be asked before anything is regenerated.</span>
        </div>
      )}

      {/* the four big steps */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {steps.map((s) => {
          const Icon = s.icon;
          const border = s.state === "done" ? "border-emerald-800" : s.state === "current" ? "border-amber-700" : "border-slate-800";
          return (
            <button key={s.n} onClick={() => openStep(s.n)} className={`rounded-2xl border ${border} bg-slate-900/60 p-5 text-left transition hover:bg-slate-900`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${s.state === "done" ? "bg-emerald-950 text-emerald-400" : s.state === "current" ? "bg-amber-950 text-amber-400" : "bg-slate-800 text-slate-500"}`}><Icon className="h-6 w-6" /></div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Step {s.n}</div>
                    <div className="text-lg font-bold text-slate-100">{s.title}</div>
                  </div>
                </div>
                {s.state === "done" ? <CheckCircle2 className="h-6 w-6 text-emerald-400" /> : <ChevronRight className="h-5 w-5 text-slate-600" />}
              </div>
              <div className="mt-4"><BigBar pct={s.pct} state={s.state} /></div>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                <span className="font-semibold tabular-nums" style={{ color: s.state === "current" ? "#f59e0b" : undefined }}>{s.pct}% complete</span>
                {s.state !== "done" && <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{fmtMins(s.estMinutes)}</span>}
              </div>
            </button>
          );
        })}
      </div>

      <AutoBuildCard steps={steps} openStep={openStep} />
    </div>
  );
}

// ── one step, opened: friendly checklist + ONE primary Continue button ──
export function GuidedStep({ n, feed, counts, back, goSection }: { n: 1 | 2 | 3 | 4; feed: WorkflowFeed | undefined; counts: GuidedCounts | undefined; back: () => void; goSection: (section: string) => void }) {
  const steps = useGuidedSteps(feed, counts);
  const s = steps.find((x) => x.n === n);
  if (!s) return null;
  const activeIdx = s.rows.findIndex((r) => r.total > 0 && r.done < r.total);
  return (
    <div className="mx-auto max-w-2xl">
      <button onClick={back} className="mb-4 text-xs font-medium text-slate-500 hover:text-slate-300">← All steps</button>
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Step {s.n} of 4</div>
        <h1 className="text-2xl font-black text-slate-100">{s.title}</h1>
        {n === 1 && counts && (
          <div className="mt-2 flex gap-4 text-sm text-slate-400">
            <span><b className="text-slate-200">{counts.charactersTotal}</b> Characters</span>
            <span><b className="text-slate-200">{counts.familiesTotal}</b> Families</span>
          </div>
        )}
        <div className="my-4"><BigBar pct={s.pct} state={s.state} /></div>
        <div className="mb-4 flex items-center justify-between text-xs text-slate-500">
          <span className="tabular-nums">{s.pct}% complete</span>
          <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />Estimated time remaining: {fmtMins(s.estMinutes)}</span>
        </div>
        <div className="divide-y divide-slate-800/70 rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-1">
          {s.rows.map((r, i) => <Row key={r.label} label={r.label} done={r.done} total={r.total} active={i === activeIdx} />)}
        </div>
        <div className="mt-5 flex justify-end">
          {!feed ? (
            <span className="text-xs text-slate-600">Loading your progress…</span>
          ) : studioSectionOf(s.continueUrl) ? (
            // Studio-internal target (Step 4): a Link to the same route is a no-op —
            // switch the studio section via callback instead.
            <button onClick={() => goSection(studioSectionOf(s.continueUrl)!)} className="inline-flex items-center gap-2 rounded-xl px-8 py-3.5 text-base font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}><Play className="h-5 w-5" />{s.continueLabel}</button>
          ) : s.continueUrl ? (
            <Link href={s.continueUrl}>
              <span className="inline-flex cursor-pointer items-center gap-2 rounded-xl px-8 py-3.5 text-base font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}><Play className="h-5 w-5" />{s.continueLabel}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-xl border border-emerald-800 bg-emerald-950/40 px-6 py-3 text-sm font-bold text-emerald-300"><CheckCircle2 className="h-4 w-4" />Step complete</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── AUTO BUILD: a guided plan with approval gates — nothing runs without confirmation ──
const AUTO_STAGES: { key: string; label: string; stepN: 1 | 2 | 3 | 4; kinds: string[] }[] = [
  { key: "descriptions", label: "Generate Descriptions", stepN: 1, kinds: ["description", "approve_description"] },
  { key: "master", label: "Generate Master References", stepN: 1, kinds: ["master_reference"] },
  { key: "action", label: "Generate Action References", stepN: 1, kinds: ["action_pose"] },
  { key: "lock", label: "Lock Approved Characters", stepN: 1, kinds: ["approve_references", "lock_character"] },
  { key: "standard", label: "Generate Standard Cards", stepN: 2, kinds: ["generate_cards"] },
  { key: "rare", label: "Generate Rare Cards", stepN: 3, kinds: [] },
  { key: "packaging", label: "Generate Packaging", stepN: 4, kinds: ["packaging"] },
];

function AutoBuildCard({ steps, openStep }: { steps: StepModel[]; openStep: (n: 1 | 2 | 3 | 4) => void }) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("vq.autobuild") ?? "[]") as string[]); } catch { return new Set(); }
  });
  const toggle = (k: string) => setChecked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); localStorage.setItem("vq.autobuild", JSON.stringify([...n])); return n; });
  const estFor = (stage: (typeof AUTO_STAGES)[number]) => {
    const step = steps.find((s) => s.n === stage.stepN);
    return step ? { minutes: Math.round(step.estMinutes / Math.max(step.rows.length, 1)), credits: Math.round(step.estCredits / Math.max(step.rows.length, 1)) } : { minutes: 0, credits: 0 };
  };
  const start = () => {
    const first = AUTO_STAGES.find((s) => checked.has(s.key));
    if (!first) return;
    if (!window.confirm(`Start the guided build?\n\nIt will take you through each ticked stage in order. Every stage PAUSES when finished and waits for your approval — nothing generates or spends credits without you confirming it on screen.`)) return;
    openStep(first.stepN);
  };
  return (
    <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left">
        <span className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-800 text-slate-300"><Wand2 className="h-6 w-6" /></div>
          <span>
            <span className="block text-lg font-bold text-slate-100">Auto Build</span>
            <span className="block text-xs text-slate-500">A guided plan through every stage — pauses for your approval at each one</span>
          </span>
        </span>
        <ChevronRight className={`h-5 w-5 text-slate-600 transition ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <>
          <div className="mt-4 space-y-1">
            {AUTO_STAGES.map((stage) => {
              const est = estFor(stage);
              return (
                <label key={stage.key} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                  <input type="checkbox" checked={checked.has(stage.key)} onChange={() => toggle(stage.key)} className="accent-[#D4AF37]" />
                  <span className="flex-1 text-sm text-slate-200">{stage.label}</span>
                  <span className="text-[10px] text-slate-500">{est.credits > 0 ? `≈${est.credits} credits · ` : ""}{fmtMins(est.minutes)}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] text-slate-500">Every stage pauses when complete · your approval is always required · nothing runs by itself</span>
            <button onClick={start} disabled={checked.size === 0} className="rounded-lg px-5 py-2 text-sm font-bold text-black transition enabled:hover:brightness-110 disabled:opacity-40" style={{ background: GOLD }}>Start Guided Build</button>
          </div>
        </>
      )}
    </div>
  );
}
