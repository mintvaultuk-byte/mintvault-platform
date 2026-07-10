import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AdminButton } from "@/components/admin";
import {
  LayoutDashboard, Settings2, Users, Boxes, Layers, Sparkles, Package, Printer,
  ShieldCheck, Rocket, FolderArchive, Gauge, Lock, ChevronRight, ArrowUpRight,
  CheckCircle2, Circle, CircleDot, AlertTriangle, PlusCircle, ExternalLink,
  Home, ListOrdered, Coins, Search,
} from "lucide-react";
import {
  useWorkflow, useAdvancedMode, usePalette, CommandPalette, HomeDashboard,
  ProductionQueue, CreditsDashboard, WarningsPanel, BulkBar, Collapse,
  type WorkflowFeed,
} from "@/components/vault-quest/workflow";
import { GuidedHome, GuidedStep } from "@/components/vault-quest/guided";
import { characterHealth, type HealthCharacter } from "@/components/vault-quest/quality";

/**
 * Genesis Production Studio (Phase 4) — set-centric TCG production control tower.
 * Opens into a SET (Genesis Vault), not a card list. Every stage unlocks the next.
 * VQ-only; links out to the existing Card Studio / Character Bible editor.
 */

const SET_CODE = "GNV";
const GOLD = "#D4AF37";

type StageState = "not_started" | "in_progress" | "needs_review" | "approved" | "locked" | "completed";
interface StageView { key: string; title: string; stage: number; status: StageState; progress: number; locked: boolean; detail: string; }
interface ProductionStatus {
  setCode: string; setName: string; overallProgress: number;
  nextStep: { key: string; title: string; label: string } | null;
  stages: StageView[];
  counts: {
    charactersTotal: number; charactersApproved: number; familiesTotal: number; familiesComplete: number;
    standardTotal: number; standardDone: number; supportTotal: number; supportDone: number;
    variantTotal: number; variantDone: number; collectorTotal: number; collectorDone: number;
    packagingTotal: number; packagingApproved: number; printReady: number; qaTotal: number; qaPassed: number; assetsApproved: number;
  };
  release: { cardsComplete: boolean; packagingComplete: boolean; qaPassed: boolean; printReady: boolean; releaseReady: boolean; releaseDate: string | null };
  founder: {
    charactersRemaining: number; cardsRemaining: number; packagingRemaining: number; qaRemaining: number;
    aiGenerationsToday: number; aiGenerationsTotal: number; recentActivity: { cardId: string | null; kind: string; at: string }[];
  };
  migrationApplied: boolean;
}

type SectionKey =
  | "home" | "queue" | "credits"
  | "step1" | "step2" | "step3" | "step4"
  | "overview" | "settings" | "characters" | "families" | "standard" | "variant"
  | "packaging" | "print" | "qa" | "release" | "assets" | "founder";

const NAV: { key: SectionKey; label: string; icon: typeof LayoutDashboard; group?: string }[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "queue", label: "Production Queue", icon: ListOrdered },
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "settings", label: "Set Settings", icon: Settings2 },
  { key: "characters", label: "Characters", icon: Users },
  { key: "families", label: "Families", icon: Boxes },
  { key: "standard", label: "Standard Cards", icon: Layers },
  { key: "variant", label: "Variant Cards", icon: Sparkles },
  { key: "packaging", label: "Packaging Studio", icon: Package },
  { key: "print", label: "Print Studio", icon: Printer },
  { key: "qa", label: "QA", icon: ShieldCheck },
  { key: "release", label: "Release", icon: Rocket },
  { key: "assets", label: "Asset Library", icon: FolderArchive, group: "Library" },
  { key: "credits", label: "Credits", icon: Coins, group: "Library" },
  { key: "founder", label: "Founder Dashboard", icon: Gauge, group: "Library" },
];

const STAGE_TO_SECTION: Record<string, SectionKey> = {
  set_setup: "settings", characters: "characters", families: "families",
  standard_cards: "standard", support_cards: "standard", variant_cards: "variant",
  packaging: "packaging", print_files: "print", qa: "qa", release: "release",
};

// ── status styling ──
const STATE_META: Record<StageState, { label: string; cls: string; icon: typeof Circle }> = {
  not_started: { label: "Not Started", cls: "text-slate-400 bg-slate-800/60 border-slate-700", icon: Circle },
  in_progress: { label: "In Progress", cls: "text-sky-300 bg-sky-950/50 border-sky-800", icon: CircleDot },
  needs_review: { label: "Needs Review", cls: "text-amber-300 bg-amber-950/50 border-amber-800", icon: AlertTriangle },
  approved: { label: "Approved", cls: "text-emerald-300 bg-emerald-950/50 border-emerald-800", icon: CheckCircle2 },
  locked: { label: "Locked", cls: "text-slate-500 bg-slate-900 border-slate-800", icon: Lock },
  completed: { label: "Completed", cls: "text-emerald-200 bg-emerald-900/60 border-emerald-700", icon: CheckCircle2 },
};

// ── reusable primitives ──
function Bar({ pct, gold }: { pct: number; gold?: boolean }) {
  return (
    <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: gold ? GOLD : "#38bdf8" }} />
    </div>
  );
}
function Tile({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums" style={accent ? { color: GOLD } : undefined}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
function StatePill({ status }: { status: StageState }) {
  const m = STATE_META[status];
  const Icon = m.icon;
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${m.cls}`}><Icon className="h-3 w-3" />{m.label}</span>;
}
function SectionShell({ title, desc, children, actions }: { title: string; desc?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100">{title}</h1>
          {desc && <p className="mt-1 max-w-2xl text-sm text-slate-400">{desc}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
function Deferred({ label }: { label: string }) {
  return <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800/50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">{label}</span>;
}

// ═══════════════════════════════════════════════════════════════════════════
const SECTION_KEYS: SectionKey[] = ["home", "queue", "credits", "step1", "step2", "step3", "step4", "overview", "settings", "characters", "families", "standard", "variant", "packaging", "print", "qa", "release", "assets", "founder"];

/** Simple founder navigation — the whole studio as 4 large production stages. */
const SIMPLE_NAV: { key: SectionKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "step1", label: "1 · Create Characters", icon: Users },
  { key: "step2", label: "2 · Create Cards", icon: Layers },
  { key: "step3", label: "3 · Create Rare Cards", icon: Sparkles },
  { key: "step4", label: "4 · Packaging & Print", icon: Package },
];

export default function VaultQuestStudioPage() {
  // Section is mirrored into ?section= so deep-links + browser refresh land on the exact view.
  const [section, setSectionState] = useState<SectionKey>(() => {
    const s = new URLSearchParams(window.location.search).get("section") as SectionKey | null;
    return s && SECTION_KEYS.includes(s) ? s : "home";
  });
  const setSection = (s: SectionKey) => {
    setSectionState(s);
    const u = new URL(window.location.href);
    u.searchParams.set("section", s);
    window.history.replaceState({}, "", u.toString());
  };
  const prod = useQuery<ProductionStatus>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/production`], retry: false });
  const status = prod.data;
  const workflow = useWorkflow();
  const [advanced, setAdvanced] = useAdvancedMode();
  const [paletteOpen, setPaletteOpen] = usePalette();
  const goSection = (s: string) => setSection(s as SectionKey);
  const openStep = (n: 1 | 2 | 3 | 4) => setSection(`step${n}` as SectionKey);

  return (
    <div className="min-h-screen bg-[#0a0c11] text-slate-200">
      <CommandPalette open={paletteOpen} close={() => setPaletteOpen(false)} go={goSection} />
      <div className="flex">
        {/* ── Sidebar ── */}
        <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-slate-800 bg-[#0c0f15] p-4">
          <Link href="/admin/vault-quest" className="mb-4 flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-300">
            <ChevronRight className="h-3 w-3 rotate-180" /> Vault Quest
          </Link>
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
            <span className="text-[10px]" style={{ color: GOLD }}>▼</span>
            <div>
              <div className="text-sm font-bold text-slate-100">Genesis Vault</div>
              <div className="text-[10px] text-slate-500">GNV · {status ? `${status.overallProgress}% complete` : "…"}</div>
            </div>
          </div>
          <button onClick={() => setPaletteOpen(true)} className="mb-3 flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-1.5 text-xs text-slate-500 hover:border-slate-700 hover:text-slate-300">
            <Search className="h-3.5 w-3.5" />Search everything…<kbd className="ml-auto rounded border border-slate-800 px-1 text-[9px]">⌘K</kbd>
          </button>
          <nav className="space-y-0.5">
            {(advanced ? NAV : SIMPLE_NAV).map((n, i, list) => {
              const prev = list[i - 1] as (typeof NAV)[number] | undefined;
              const group = (n as (typeof NAV)[number]).group;
              const showGroup = group && prev?.group !== group;
              const Icon = n.icon;
              const active = section === n.key;
              return (
                <div key={n.key}>
                  {showGroup && <div className="mb-1 mt-3 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-600">{group}</div>}
                  <button
                    onClick={() => setSection(n.key)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${active ? "bg-slate-800 font-semibold text-slate-100" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}
                    style={active ? { boxShadow: `inset 2px 0 0 ${GOLD}` } : undefined}
                  >
                    <Icon className="h-4 w-4 shrink-0" style={active ? { color: GOLD } : undefined} />
                    {n.label}
                  </button>
                </div>
              );
            })}
          </nav>
          <label className="mt-auto flex cursor-pointer items-center justify-between rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2" title="Shows technical controls: AI provider & model names, credits detail, identity scores, queue and batch settings.">
            <span className="text-xs font-semibold text-slate-400">Advanced Mode</span>
            <button
              role="switch"
              aria-checked={advanced}
              onClick={() => {
                const next = !advanced;
                setAdvanced(next);
                // leaving Advanced while on a technical section → land back on the simple home
                if (!next && !["home", "step1", "step2", "step3", "step4"].includes(section)) setSection("home");
              }}
              className={`relative h-5 w-9 rounded-full transition ${advanced ? "" : "bg-slate-700"}`}
              style={advanced ? { background: GOLD } : undefined}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${advanced ? "left-[18px]" : "left-0.5"}`} />
            </button>
          </label>
        </aside>

        {/* ── Main ── */}
        <main className="min-w-0 flex-1 p-8">
          {prod.isLoading && <div className="text-sm text-slate-500">Loading production status…</div>}
          {prod.isError && <div className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">Failed to load — are you signed in as admin?</div>}
          {section === "home" && !advanced && (
            <SectionShell title="Genesis Vault" desc="Work from top to bottom — the studio always knows your next step.">
              <GuidedHome feed={workflow.data} counts={status?.counts} loading={workflow.isLoading} openStep={openStep} />
            </SectionShell>
          )}
          {(section === "step1" || section === "step2" || section === "step3" || section === "step4") && (
            <GuidedStep n={Number(section.slice(4)) as 1 | 2 | 3 | 4} feed={workflow.data} counts={status?.counts} back={() => setSection("home")} />
          )}
          {section === "home" && advanced && (
            <SectionShell title="Home" desc="The system always knows the next production task — pick up exactly where you left off.">
              <HomeDashboard feed={workflow.data} loading={workflow.isLoading} go={goSection} />
            </SectionShell>
          )}
          {section === "queue" && (
            <SectionShell title="Production Queue" desc="Every open task in canonical order: description → references → approval → lock → cards → QA → packaging → release.">
              <ProductionQueue feed={workflow.data} loading={workflow.isLoading} founderMode={advanced} go={goSection} />
            </SectionShell>
          )}
          {section === "credits" && (
            <SectionShell title="Credits" desc="AI spend, derived from the generation audit trail.">
              <CreditsDashboard feed={workflow.data} loading={workflow.isLoading} />
            </SectionShell>
          )}
          {status && (
            <>
              {!status.migrationApplied && section !== "home" && section !== "queue" && section !== "credits" && (
                <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Production tables aren’t applied on this database yet — Packaging, Print, QA, Release &amp; Asset Library are read-only until <code className="rounded bg-black/30 px-1">migrations-vq/0007</code> is applied. Character, family &amp; card progress is fully live.</span>
                </div>
              )}
              {section === "overview" && <Overview status={status} go={setSection} />}
              {section === "settings" && <SetSettings />}
              {section === "characters" && <CharactersView status={status} founderMode={advanced} />}
              {section === "families" && <FamiliesView status={status} />}
              {section === "standard" && <CardsView status={status} kind="standard" />}
              {section === "variant" && <CardsView status={status} kind="variant" />}
              {section === "packaging" && <PackagingStudio />}
              {section === "print" && <PrintStudio />}
              {section === "qa" && <QaStudio />}
              {section === "release" && <ReleaseManager status={status} feed={workflow.data} />}
              {section === "assets" && <AssetLibrary />}
              {section === "founder" && <FounderDashboard status={status} go={setSection} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ── OVERVIEW: dashboard + pipeline + continue ──
function Overview({ status, go }: { status: ProductionStatus; go: (s: SectionKey) => void }) {
  const c = status.counts;
  const goNext = () => status.nextStep && go(STAGE_TO_SECTION[status.nextStep.key] ?? "overview");
  return (
    <SectionShell title={status.setName} desc={`Set ${status.setCode} · production control centre`}>
      {/* headline + continue */}
      <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-[#0c0f15] p-6 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Overall progress</div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-4xl font-black tabular-nums" style={{ color: GOLD }}>{status.overallProgress}%</span>
            <span className="text-sm text-slate-400">{status.release.releaseReady ? "Release ready" : status.nextStep ? `Next: ${status.nextStep.title}` : "—"}</span>
          </div>
          <div className="mt-3 w-72 max-w-full"><Bar pct={status.overallProgress} gold /></div>
        </div>
        {status.nextStep && (
          <button onClick={goNext} className="group flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold text-black transition hover:brightness-110" style={{ background: GOLD }}>
            {status.nextStep.label}
            <ArrowUpRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </button>
        )}
      </div>

      {/* metric tiles */}
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Characters" value={`${c.charactersApproved}/${c.charactersTotal}`} sub="approved" />
        <Tile label="Families" value={`${c.familiesComplete}/${c.familiesTotal}`} sub="complete" />
        <Tile label="Cards" value={`${c.standardDone + c.supportDone + c.collectorDone}/${c.standardTotal + c.supportTotal + c.collectorTotal}`} sub="base done" />
        <Tile label="Variants" value={`${c.variantDone}/${c.variantTotal}`} sub="done" />
        <Tile label="Packaging" value={`${c.packagingApproved}/${c.packagingTotal || 0}`} sub="approved" />
        <Tile label="QA" value={`${c.qaPassed}/${c.qaTotal}`} sub="passed" />
        <Tile label="Print ready" value={c.printReady} sub="exports" />
        <Tile label="Release" value={status.release.releaseReady ? "Ready" : "Pending"} accent={status.release.releaseReady} />
      </div>

      {/* pipeline */}
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Production pipeline</h2>
      <div className="space-y-2">
        {status.stages.map((s) => (
          <button
            key={s.key}
            disabled={s.locked}
            onClick={() => go(STAGE_TO_SECTION[s.key] ?? "overview")}
            className={`flex w-full items-center gap-4 rounded-xl border p-3 text-left transition ${s.locked ? "cursor-not-allowed border-slate-800 bg-slate-900/30 opacity-60" : "border-slate-800 bg-slate-900/60 hover:border-slate-700"}`}
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-sm font-bold tabular-nums text-slate-300">{s.stage}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-200">{s.title}</span>
                {s.locked && <Lock className="h-3 w-3 text-slate-600" />}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1.5 w-40 max-w-[40%] overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full" style={{ width: `${s.progress}%`, background: s.status === "completed" ? "#34d399" : "#38bdf8" }} /></div>
                <span className="text-[11px] text-slate-500">{s.detail}</span>
              </div>
            </div>
            <StatePill status={s.status} />
          </button>
        ))}
      </div>
    </SectionShell>
  );
}

// ── SET SETTINGS ──
function SetSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<Record<string, unknown>>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/settings`], retry: false });
  const s = (q.data ?? {}) as Record<string, string | number | boolean | null>;
  const [form, setForm] = useState<Record<string, string>>({});
  const val = (k: string) => form[k] ?? (s[k] != null ? String(s[k]) : "");
  const locked = !!s.locked;

  const save = async (extra: Record<string, unknown> = {}) => {
    try {
      const payload: Record<string, unknown> = { ...form, ...extra };
      ["releaseYear", "cardCount", "boosterSize", "cardsPerPack"].forEach((k) => { if (payload[k] != null && payload[k] !== "") payload[k] = Number(payload[k]); });
      const r = await apiRequest("PUT", `/api/admin/vault-quest/sets/${SET_CODE}/settings`, payload);
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || "save failed"); }
      toast({ title: "Set settings saved" });
      qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/settings`] });
      qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/production`] });
    } catch (e) { toast({ title: "Could not save", description: (e as Error).message, variant: "destructive" }); }
  };

  const FIELDS: { k: string; label: string; type?: string; ph?: string }[] = [
    { k: "name", label: "Set Name", ph: "Genesis Vault" },
    { k: "code", label: "Set Code", ph: "GNV" },
    { k: "releaseYear", label: "Release Year", type: "number", ph: "2026" },
    { k: "cardCount", label: "Card Count", type: "number", ph: "156" },
    { k: "boosterSize", label: "Booster Size", type: "number", ph: "24" },
    { k: "cardsPerPack", label: "Cards Per Pack", type: "number", ph: "11" },
  ];

  return (
    <SectionShell
      title="Set Settings"
      desc="Foundational set configuration. Locks after approval so downstream production can rely on it."
      actions={<div className="flex gap-2">
        {!locked ? <>
          <AdminButton variant="ghost" onClick={() => save()}>Save</AdminButton>
          <AdminButton variant="gold" onClick={() => save({ locked: true })}>Approve &amp; Lock</AdminButton>
        </> : <AdminButton variant="ghost" onClick={() => save({ locked: false, __unlock: true })}>Unlock</AdminButton>}
      </div>}
    >
      {locked && <div className="mb-4 inline-flex items-center gap-2 rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-1.5 text-xs text-emerald-300"><Lock className="h-3 w-3" /> Settings locked — unlock to edit.</div>}
      <div className="grid max-w-3xl grid-cols-1 gap-4 md:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.k} className="block">
            <span className="mb-1 block text-xs font-semibold text-slate-400">{f.label}</span>
            <input type={f.type ?? "text"} disabled={locked} placeholder={f.ph} value={val(f.k)} onChange={(e) => setForm((p) => ({ ...p, [f.k]: e.target.value }))}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 disabled:opacity-60" />
          </label>
        ))}
        <label className="block md:col-span-2">
          <span className="mb-1 block text-xs font-semibold text-slate-400">Set Description</span>
          <textarea rows={3} disabled={locked} value={val("description")} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500 disabled:opacity-60" />
        </label>
      </div>
      <p className="mt-4 max-w-2xl text-xs text-slate-500">Elements, rarity structure, fonts, colour palette &amp; set logo are stored on this record (jsonb) — richer editors for those can be layered on without a schema change.</p>
    </SectionShell>
  );
}

// ── CHARACTERS (summary + list with bulk operations + deep link) ──
type CharacterListRow = { characterId: string; characterName: string; familyId: string; stageNumber: number; descriptionStatus?: string; approvalStatus: string; locked?: boolean };
function CharactersView({ status, founderMode }: { status: ProductionStatus; founderMode: boolean }) {
  const qc = useQueryClient();
  const c = status.counts;
  const familyPct = c.familiesTotal ? Math.round((c.familiesComplete / c.familiesTotal) * 100) : 0;
  const stage = status.stages.find((s) => s.key === "characters");
  const q = useQuery<{ characters?: CharacterListRow[] } | null>({ queryKey: ["/api/admin/vault-quest/characters"], retry: false });
  const chars = q.data?.characters ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["/api/admin/vault-quest/characters"] });
    qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/production`] });
    qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/workflow`] });
  };
  return (
    <SectionShell title="Character Studio" desc="The Character Bible — canonical identity, descriptions &amp; reference artwork. Full editor opens in Card Studio."
      actions={<Link href="/admin/vault-quest"><AdminButton variant="gold">Open Character Bible <ExternalLink className="ml-1 inline h-3 w-3" /></AdminButton></Link>}>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Canonical count" value={c.charactersTotal} accent />
        <Tile label="Approved" value={c.charactersApproved} sub={`${c.charactersTotal - c.charactersApproved} remaining`} />
        <Tile label="Family completion" value={`${familyPct}%`} sub={`${c.familiesComplete}/${c.familiesTotal}`} />
        <Tile label="Workflow stage" value={stage ? STATE_META[stage.status].label : "—"} />
      </div>
      <div className="mb-5 max-w-xl"><div className="mb-1 text-xs text-slate-400">Character approval progress</div><Bar pct={stage?.progress ?? 0} gold /></div>

      <Collapse id="characters-list" title={`Characters (${chars.length})`} badge={founderMode && selected.length ? <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{selected.length} selected</span> : undefined}>
        {chars.length === 0 ? <p className="text-xs text-slate-600">No characters loaded.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead><tr className="text-[10px] uppercase tracking-wider text-slate-600">
                {founderMode && <th className="w-8 pb-2" />}
                <th className="pb-2">Character</th><th className="pb-2">Family</th><th className="pb-2">Stage</th><th className="pb-2">Description</th><th className="pb-2">Approval</th><th className="pb-2">Lock</th>
              </tr></thead>
              <tbody>
                {chars.map((ch) => (
                  <tr key={ch.characterId} className="border-t border-slate-800/70">
                    {founderMode && <td className="py-1.5"><input type="checkbox" checked={selected.includes(ch.characterId)} onChange={() => toggle(ch.characterId)} className="accent-[#D4AF37]" /></td>}
                    <td className="py-1.5 font-medium text-slate-200">{ch.characterName}<span className="ml-1.5 text-slate-600">{ch.characterId}</span></td>
                    <td className="py-1.5 text-slate-400">{ch.familyId}</td>
                    <td className="py-1.5 tabular-nums text-slate-400">{ch.stageNumber}</td>
                    <td className="py-1.5">{ch.descriptionStatus === "approved" ? <span className="text-emerald-400">approved</span> : <span className="text-slate-500">{ch.descriptionStatus ?? "draft"}</span>}</td>
                    <td className="py-1.5">{ch.approvalStatus === "approved" ? <span className="text-emerald-400">approved</span> : <span className="text-slate-500">{ch.approvalStatus}</span>}</td>
                    <td className="py-1.5">{ch.locked ? <Lock className="h-3 w-3 text-violet-400" /> : <span className="text-slate-700">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {founderMode && <BulkBar selected={selected} clear={() => setSelected([])} onDone={refresh} />}
        {!founderMode && <p className="mt-3 text-[11px] text-slate-600">Enable Advanced Mode (sidebar) for bulk approve / lock operations.</p>}
      </Collapse>
    </SectionShell>
  );
}

// ── FAMILIES (each family a mini project) ──
function FamiliesView({ status }: { status: ProductionStatus }) {
  const q = useQuery<{ characters?: { familyId: string; familyName?: string | null; approvalStatus: string; locked?: boolean }[] } | null>({ queryKey: ["/api/admin/vault-quest/characters"], retry: false });
  const chars = q.data?.characters ?? [];
  const byFamily = useMemo(() => {
    const m = new Map<string, { name: string; total: number; approved: number; locked: number }>();
    for (const ch of chars) {
      const e = m.get(ch.familyId) ?? { name: ch.familyName || ch.familyId, total: 0, approved: 0, locked: 0 };
      e.total++; if (ch.approvalStatus === "approved") e.approved++; if (ch.locked) e.locked++;
      m.set(ch.familyId, e);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [chars]);

  return (
    <SectionShell title="Family Studio" desc="Each evolution family is its own project — three stages, artwork &amp; variants roll up here."
      actions={<Link href="/admin/vault-quest"><AdminButton variant="ghost">Open editor <ExternalLink className="ml-1 inline h-3 w-3" /></AdminButton></Link>}>
      {byFamily.length === 0 && <p className="text-sm text-slate-500">No characters loaded.</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {byFamily.map(([id, f]) => {
          const pct = f.total ? Math.round((f.approved / f.total) * 100) : 0;
          const complete = f.total > 0 && f.approved === f.total;
          return (
            <div key={id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex items-center justify-between">
                <div><div className="text-sm font-bold text-slate-100">{f.name}</div><div className="text-[10px] text-slate-500">{id}</div></div>
                <StatePill status={complete ? "completed" : f.approved > 0 ? "in_progress" : "not_started"} />
              </div>
              <div className="mt-3"><Bar pct={pct} gold={complete} /></div>
              <div className="mt-2 flex justify-between text-[11px] text-slate-500"><span>{f.approved}/{f.total} approved</span>{f.locked > 0 && <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" />{f.locked} locked</span>}</div>
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}

// ── CARDS (standard / variant) ──
function CardsView({ status, kind }: { status: ProductionStatus; kind: "standard" | "variant" }) {
  const c = status.counts;
  const isStd = kind === "standard";
  return (
    <SectionShell
      title={isStd ? "Standard Cards" : "Variant Cards"}
      desc={isStd ? "Base creatures + support cards. Full editing in Card Studio." : "Alternate-art & premium variants derived from approved base cards."}
      actions={<Link href="/admin/vault-quest"><AdminButton variant="gold">Open Card Studio <ExternalLink className="ml-1 inline h-3 w-3" /></AdminButton></Link>}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {isStd ? <>
          <Tile label="Standard (Creatures)" value={`${c.standardDone}/${c.standardTotal}`} sub="done" accent />
          <Tile label="Support cards" value={`${c.supportDone}/${c.supportTotal}`} sub="Tactic/Relic/Vault/Place" />
          <Tile label="Collector" value={`${c.collectorDone}/${c.collectorTotal}`} sub="done" />
          <Tile label="Total base" value={c.standardTotal + c.supportTotal + c.collectorTotal} />
        </> : <>
          <Tile label="Variant cards" value={`${c.variantDone}/${c.variantTotal}`} sub="done" accent />
          <Tile label="Awaiting" value={c.variantTotal - c.variantDone} sub="not yet done" />
        </>}
      </div>
      <p className="mt-4 max-w-2xl text-xs text-slate-500">Card categories (Standard · Support · Variant · Collector · Promotional) are tracked separately in the production pipeline instead of one giant list.</p>
    </SectionShell>
  );
}

// ── PACKAGING STUDIO ──
const PACKAGING_TYPES = [
  { type: "booster_wrapper", label: "Booster Wrapper" },
  { type: "booster_box", label: "Booster Box" },
  { type: "starter_deck", label: "Starter Deck" },
  { type: "elite_box", label: "Elite Box" },
  { type: "promo_pack", label: "Promo Pack" },
  { type: "shipping_carton", label: "Shipping Carton" },
];
const WRAPPER_STEPS = ["Generate Artwork", "3 Variants", "Review", "Approve", "Print Dieline", "3D Mock-up", "Manufacturer PDF", "Export"];

interface PackagingItem { id: number; type: string; name: string; status: string; approvalStatus: string; locked: boolean; revision: number; artworkR2Key: string | null; }
function PackagingStudio() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<PackagingItem[]>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/packaging`], retry: false });
  const items = q.data ?? [];
  const refresh = () => { qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/packaging`] }); qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/production`] }); };

  const add = async (type: string, label: string) => {
    try {
      const r = await apiRequest("POST", `/api/admin/vault-quest/sets/${SET_CODE}/packaging`, { type, name: label, status: "in_progress" });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || "failed"); }
      toast({ title: `${label} created` }); refresh();
    } catch (e) { toast({ title: "Could not create", description: (e as Error).message, variant: "destructive" }); }
  };
  const patch = async (id: number, body: Record<string, unknown>, msg: string) => {
    try {
      const r = await apiRequest("PATCH", `/api/admin/vault-quest/sets/${SET_CODE}/packaging/${id}`, body);
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || "failed"); }
      toast({ title: msg }); refresh();
    } catch (e) { toast({ title: "Could not update", description: (e as Error).message, variant: "destructive" }); }
  };

  return (
    <SectionShell title="Packaging Studio" desc="Physical packaging — wrappers, boxes, decks & cartons. Wrapper artwork uses ONLY approved canonical characters; never unfinished art.">
      <div className="space-y-4">
        {PACKAGING_TYPES.map(({ type, label }) => {
          const item = items.find((i) => i.type === type);
          return (
            <div key={type} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4" style={new URLSearchParams(window.location.search).get("item") === type ? { outline: `2px solid ${GOLD}`, outlineOffset: 2 } : undefined}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Package className="h-4 w-4 text-slate-500" />
                  <div>
                    <div className="text-sm font-bold text-slate-100">{label}</div>
                    <div className="text-[10px] text-slate-500">{item ? `Revision ${item.revision} · ${item.approvalStatus}` : "Not started"}</div>
                  </div>
                </div>
                {item ? <StatePill status={item.locked ? "locked" : (item.approvalStatus === "approved" ? "approved" : item.status as StageState) || "in_progress"} />
                  : <AdminButton variant="ghost" onClick={() => add(type, label)}><PlusCircle className="mr-1 inline h-3.5 w-3.5" />Start</AdminButton>}
              </div>

              {item && (
                <>
                  {type === "booster_wrapper" && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {WRAPPER_STEPS.map((step, idx) => (
                        <span key={step} className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800/60 px-2 py-1 text-[10px] text-slate-400">
                          <span className="tabular-nums text-slate-600">{idx + 1}</span>{step}
                          {["Generate Artwork", "3 Variants", "Print Dieline", "3D Mock-up", "Manufacturer PDF"].includes(step) && <Deferred label="pipeline" />}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!item.locked && item.approvalStatus !== "approved" && <AdminButton variant="ghost" onClick={() => patch(item.id, { approvalStatus: "needs_review", status: "needs_review" }, "Sent for review")}>Mark for Review</AdminButton>}
                    {!item.locked && <AdminButton variant="gold" onClick={() => patch(item.id, { approvalStatus: "approved", status: "completed" }, "Approved")}>Approve</AdminButton>}
                    {!item.locked ? <AdminButton variant="ghost" onClick={() => patch(item.id, { locked: true }, "Locked")}><Lock className="mr-1 inline h-3.5 w-3.5" />Lock</AdminButton>
                      : <AdminButton variant="ghost" onClick={() => patch(item.id, { locked: false }, "Unlocked")}>Unlock</AdminButton>}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}

// ── generic list studio (Print / QA / Assets) ──
function PrintStudio() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<{ id: number; type: string; status: string }[]>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/print`], retry: false });
  const rows = q.data ?? [];
  const TYPES = ["cards", "wrappers", "boxes", "rule_books", "tokens", "stickers", "posters"];
  const refresh = () => qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/print`] });
  const add = async (type: string) => { try { const r = await apiRequest("POST", `/api/admin/vault-quest/sets/${SET_CODE}/print`, { type, status: "draft" }); if (!r.ok) throw new Error((await r.json()).error); toast({ title: `${type} export added` }); refresh(); } catch (e) { toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); } };
  const setStatus = async (id: number, status: string) => { try { const r = await apiRequest("PATCH", `/api/admin/vault-quest/sets/${SET_CODE}/print/${id}`, { status }); if (!r.ok) throw new Error((await r.json()).error); refresh(); qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/production`] }); } catch (e) { toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); } };
  const STAGES = ["draft", "approved", "print_ready", "exported"];
  return (
    <SectionShell title="Print Studio" desc="Production print files. Each export advances Draft → Approved → Print Ready → Exported.">
      <div className="mb-4 flex flex-wrap gap-2">{TYPES.map((t) => <AdminButton key={t} variant="ghost" onClick={() => add(t)}><PlusCircle className="mr-1 inline h-3.5 w-3.5" />{t.replace("_", " ")}</AdminButton>)}</div>
      {rows.length === 0 ? <p className="text-sm text-slate-500">No print exports yet — add one above.</p> : (
        <div className="space-y-2">{rows.map((r) => (
          <div key={r.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-2.5">
            <span className="text-sm font-medium text-slate-200 capitalize">{r.type.replace("_", " ")}</span>
            <div className="flex items-center gap-2">
              {STAGES.map((st) => <button key={st} onClick={() => setStatus(r.id, st)} className={`rounded px-2 py-0.5 text-[10px] font-semibold capitalize ${r.status === st ? "text-black" : "border border-slate-700 text-slate-400 hover:text-slate-200"}`} style={r.status === st ? { background: GOLD } : undefined}>{st.replace("_", " ")}</button>)}
            </div>
          </div>
        ))}</div>
      )}
    </SectionShell>
  );
}

const QA_ITEMS = ["dimensions", "bleed", "resolution", "colour_profile", "fonts", "grammar", "card_numbers", "artwork", "packaging", "barcode", "legal"];
function QaStudio() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<{ id: number; assetType: string; assetRef: string; status: string; checklist: Record<string, boolean> | null }[]>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/qa`], retry: false });
  const rows = q.data ?? [];
  const [ref, setRef] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/qa`] }); qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/production`] }); };
  const add = async () => { if (!ref.trim()) return; try { const r = await apiRequest("POST", `/api/admin/vault-quest/sets/${SET_CODE}/qa`, { assetType: "card", assetRef: ref.trim(), status: "in_progress", checklist: {} }); if (!r.ok) throw new Error((await r.json()).error); setRef(""); toast({ title: "QA check created" }); refresh(); } catch (e) { toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); } };
  const toggle = async (row: { id: number; checklist: Record<string, boolean> | null }, item: string) => {
    const next = { ...(row.checklist ?? {}), [item]: !row.checklist?.[item] };
    const allPass = QA_ITEMS.every((i) => next[i]);
    try { const r = await apiRequest("PATCH", `/api/admin/vault-quest/sets/${SET_CODE}/qa/${row.id}`, { checklist: next, status: allPass ? "approved" : "in_progress" }); if (!r.ok) throw new Error((await r.json()).error); refresh(); } catch (e) { toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); }
  };
  return (
    <SectionShell title="QA Studio" desc="Every asset passes an 11-point checklist. Only assets that pass all checks become exportable.">
      <div className="mb-4 flex gap-2">
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Asset ref (e.g. GNV-001)" className="w-64 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500" />
        <AdminButton variant="gold" onClick={add}>Add QA Check</AdminButton>
      </div>
      {rows.length === 0 ? <p className="text-sm text-slate-500">No QA checks yet.</p> : (
        <div className="space-y-3">{rows.map((row) => (
          <div key={row.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4" style={new URLSearchParams(window.location.search).get("ref") === row.assetRef ? { outline: `2px solid ${GOLD}`, outlineOffset: 2 } : undefined}>
            <div className="mb-3 flex items-center justify-between"><span className="text-sm font-bold text-slate-100">{row.assetRef} <span className="text-slate-500">· {row.assetType}</span></span><StatePill status={row.status as StageState} /></div>
            <div className="flex flex-wrap gap-1.5">{QA_ITEMS.map((item) => { const on = !!row.checklist?.[item]; return (
              <button key={item} onClick={() => toggle(row, item)} className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium capitalize transition ${on ? "border-emerald-700 bg-emerald-950/50 text-emerald-300" : "border-slate-700 bg-slate-800/40 text-slate-400 hover:text-slate-200"}`}>
                {on ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}{item.replace("_", " ")}
              </button>); })}</div>
          </div>
        ))}</div>
      )}
    </SectionShell>
  );
}

// ── RELEASE MANAGER ──
function ReleaseManager({ status, feed }: { status: ProductionStatus; feed: WorkflowFeed | undefined }) {
  const warningCount = feed?.warnings.length ?? 0;
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery<Record<string, unknown>>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/release`], retry: false });
  const r = (q.data ?? {}) as Record<string, string | number | boolean | null>;
  const [form, setForm] = useState<Record<string, string>>({});
  const rel = status.release;
  const gates: { label: string; ok: boolean }[] = [
    { label: "Cards Complete", ok: rel.cardsComplete }, { label: "Packaging Complete", ok: rel.packagingComplete },
    { label: "QA Passed", ok: rel.qaPassed }, { label: "Print Ready", ok: rel.printReady },
  ];
  const save = async (extra: Record<string, unknown> = {}) => {
    try {
      const payload: Record<string, unknown> = { ...form, ...extra };
      if (payload.printQuantity) payload.printQuantity = Number(payload.printQuantity);
      const res = await apiRequest("PUT", `/api/admin/vault-quest/sets/${SET_CODE}/release`, payload);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "failed");
      toast({ title: "Release updated" }); qc.invalidateQueries({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/release`] });
    } catch (e) { toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); }
  };
  return (
    <SectionShell title="Release Manager" desc="Final production stage. All gates must pass before a set can be released.">
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {gates.map((g) => <div key={g.label} className={`rounded-xl border p-4 ${g.ok ? "border-emerald-800 bg-emerald-950/30" : "border-slate-800 bg-slate-900/60"}`}>
          <div className="flex items-center gap-2">{g.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Circle className="h-4 w-4 text-slate-600" />}<span className="text-sm font-semibold text-slate-200">{g.label}</span></div>
        </div>)}
      </div>
      <div className={`mb-5 rounded-xl border p-4 ${rel.releaseReady && warningCount === 0 ? "border-emerald-700 bg-emerald-900/40" : "border-amber-800 bg-amber-950/20"}`}>
        <span className="text-sm font-bold" style={{ color: rel.releaseReady && warningCount === 0 ? "#6ee7b7" : "#fcd34d" }}>
          {rel.releaseReady && warningCount === 0 ? "✓ Release ready — all gates passed, no warnings" : warningCount > 0 ? `Release blocked — ${warningCount} smart warning(s) must be resolved` : "Awaiting upstream stages before release"}
        </span>
      </div>
      {warningCount > 0 && <div className="mb-5"><WarningsPanel warnings={feed!.warnings} /></div>}
      <div className="grid max-w-2xl grid-cols-1 gap-4 md:grid-cols-2">
        <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-400">Release Date</span><input type="date" value={form.releaseDate ?? (r.releaseDate ? String(r.releaseDate) : "")} onChange={(e) => setForm((p) => ({ ...p, releaseDate: e.target.value }))} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500" /></label>
        <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-400">Print Quantity</span><input type="number" value={form.printQuantity ?? (r.printQuantity != null ? String(r.printQuantity) : "")} onChange={(e) => setForm((p) => ({ ...p, printQuantity: e.target.value }))} className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-slate-500" /></label>
        <div className="text-xs text-slate-500 md:col-span-2">Revision {(r.revisionNumber as number) ?? 1}</div>
      </div>
      <div className="mt-4 flex gap-2">
        <AdminButton variant="ghost" onClick={() => save()}>Save</AdminButton>
        <AdminButton variant="gold" onClick={() => save({ archived: true })} disabled={!rel.releaseReady || warningCount > 0}>Archive Final Release</AdminButton>
      </div>
    </SectionShell>
  );
}

// ── ASSET LIBRARY ──
const ASSET_CATEGORIES = ["characters", "backgrounds", "logos", "effects", "textures", "fonts", "icons", "pack_art", "templates", "print_files"];
function AssetLibrary() {
  const q = useQuery<{ id: number; category: string; name: string; approved: boolean }[]>({ queryKey: [`/api/admin/vault-quest/sets/${SET_CODE}/assets`], retry: false });
  const rows = q.data ?? [];
  const byCat = (cat: string) => rows.filter((r) => r.category === cat);
  return (
    <SectionShell title="Asset Library" desc="Catalogue of approved, reusable assets. Approved assets should be reused — never regenerated — by future AI generations.">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ASSET_CATEGORIES.map((cat) => {
          const list = byCat(cat);
          return (
            <div key={cat} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="mb-2 flex items-center justify-between"><span className="text-sm font-bold capitalize text-slate-100">{cat.replace("_", " ")}</span><span className="text-[11px] text-slate-500">{list.filter((a) => a.approved).length} approved</span></div>
              {list.length === 0 ? <p className="text-xs text-slate-600">No assets catalogued.</p> : (
                <ul className="space-y-1">{list.slice(0, 6).map((a) => <li key={a.id} className="flex items-center gap-1.5 text-xs text-slate-400">{a.approved ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <Circle className="h-3 w-3 text-slate-600" />}{a.name}</li>)}</ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-4 max-w-2xl text-xs text-slate-500">Approved Character Bible references &amp; packaging artwork are auto-catalogued here once wired to the approval hooks. Reuse-first generation is a Phase-4 follow-on.</p>
    </SectionShell>
  );
}

// ── FOUNDER DASHBOARD ──
function FounderDashboard({ status, go }: { status: ProductionStatus; go: (s: SectionKey) => void }) {
  const f = status.founder;
  const chars = useQuery<{ characters?: HealthCharacter[] } | null>({ queryKey: ["/api/admin/vault-quest/characters"], retry: false });
  const buckets = useMemo(() => {
    const b = { ready: 0, needs_master: 0, needs_action: 0, needs_review: 0, failed_identity: 0, needs_description: 0 } as Record<string, number>;
    const firstOf: Record<string, string | undefined> = {};
    for (const ch of chars.data?.characters ?? []) {
      const h = characterHealth(ch);
      b[h.bucket] = (b[h.bucket] ?? 0) + 1;
      if (!firstOf[h.bucket]) firstOf[h.bucket] = ch.characterId;
    }
    return { b, firstOf };
  }, [chars.data]);
  // Clickable total → open the exact first matching character in the Character Bible.
  const openBucket = (bucket: string) => { const id = buckets.firstOf[bucket]; if (id) window.location.href = `/admin/vault-quest?bible=${encodeURIComponent(id)}`; };
  const QUALITY: { key: string; label: string }[] = [
    { key: "ready", label: "Ready for Cards" },
    { key: "needs_description", label: "Needing Description" },
    { key: "needs_master", label: "Needing Master" },
    { key: "needs_action", label: "Needing Action" },
    { key: "needs_review", label: "Needing Review" },
    { key: "failed_identity", label: "Failed Identity" },
  ];
  return (
    <SectionShell title="Founder Dashboard" desc="Your production cockpit — today's task, what's left, and credit usage at a glance.">
      <div className="mb-5 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-[#0c0f15] p-6">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Today's task</div>
        <div className="mt-1 flex items-center justify-between gap-4">
          <div className="text-2xl font-bold text-slate-100">{status.nextStep?.title ?? "All stages complete"}</div>
          {status.nextStep && <button onClick={() => go(STAGE_TO_SECTION[status.nextStep!.key] ?? "overview")} className="rounded-lg px-4 py-2 text-sm font-bold text-black" style={{ background: GOLD }}>{status.nextStep.label}</button>}
        </div>
        <div className="mt-2 text-xs text-slate-500">Current stage · {status.overallProgress}% overall</div>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Character quality</h2>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {QUALITY.map((q) => (
          <button key={q.key} onClick={() => openBucket(q.key)} disabled={!buckets.firstOf[q.key]} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-left transition enabled:hover:border-slate-600 disabled:cursor-default">
            <div className="text-2xl font-bold tabular-nums" style={q.key === "ready" ? { color: GOLD } : q.key === "failed_identity" && (buckets.b[q.key] ?? 0) > 0 ? { color: "#f87171" } : undefined}>{buckets.b[q.key] ?? 0}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">{q.label}</div>
          </button>
        ))}
        <Tile label="Families complete" value={`${status.counts.familiesComplete}/${status.counts.familiesTotal}`} />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Characters remaining" value={f.charactersRemaining} accent={f.charactersRemaining === 0} />
        <Tile label="Cards remaining" value={f.cardsRemaining} />
        <Tile label="Packaging remaining" value={f.packagingRemaining} />
        <Tile label="QA remaining" value={f.qaRemaining} />
        <Tile label="AI generations today" value={f.aiGenerationsToday} sub={`${f.aiGenerationsTotal} all-time`} />
        <Tile label="Credits used today" value={f.aiGenerationsToday} sub="≈ 1 credit / generation" />
        <Tile label="Queue" value="Idle" sub="no active batch" />
        <Tile label="Release" value={status.release.releaseReady ? "Ready" : "Pending"} accent={status.release.releaseReady} />
      </div>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">Recent activity</h2>
      {f.recentActivity.length === 0 ? <p className="text-sm text-slate-500">No recent AI activity.</p> : (
        <ul className="space-y-1.5">{f.recentActivity.map((a, i) => (
          <li key={i} className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs">
            <span className="text-slate-300">{a.cardId ?? "—"} <span className="text-slate-500">· {a.kind}</span></span>
            <span className="text-slate-600">{a.at ? new Date(a.at).toLocaleString() : ""}</span>
          </li>
        ))}</ul>
      )}
    </SectionShell>
  );
}
