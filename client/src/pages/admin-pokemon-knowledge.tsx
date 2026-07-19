/**
 * Admin → Pokémon Knowledge — the founder/staff Knowledge Hub.
 *
 * Reads the ONE shared catalogue (rarities/finishes/promos/languages/eras) plus
 * the DB set directory via /api/admin/pokemon-knowledge/*. Staff get the same
 * page read-only (server enforces: reads allow staff, writes are admin-only).
 * Nothing here touches certificates, grading or labels.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel, AdminButton, Badge, type AdminBadgeVariant } from "@/components/admin";
import { AdminHeaderRow } from "@/components/admin/AdminHeaderRow";
import { RaritySymbol } from "@/components/rarity-picker/RaritySymbol";
import {
  POKEMON_RARITIES,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  POKEMON_LANGUAGES,
  POKEMON_ERAS,
  describeSymbol,
  filterRarities,
  type PokemonEra,
  type PokemonRarity,
} from "@shared/pokemon-rarity-catalogue";
import {
  provenanceFor,
  knowledgeNoteFor,
  ERA_TIMELINE,
  LANGUAGE_GUIDE,
  COMPARISON_PAIRS,
  KNOWLEDGE_CATALOGUE_VERSION,
} from "@shared/pokemon-knowledge";

const SECTIONS = [
  "Overview",
  "Sets",
  "Set Codes",
  "Rarities",
  "Finishes",
  "Promos & Subsets",
  "Languages",
  "Eras",
  "Compare",
  "Review Queue",
  "Handbook",
] as const;
type Section = (typeof SECTIONS)[number];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface SetRow {
  setKey: string;
  language: string;
  canonicalName: string;
  setCode: string | null;
  series: string | null;
  era: string | null;
  region: string | null;
  year: string | null;
  mainCount: number | null;
  secretCount: number | null;
  status: string;
  confidence: string;
  sourceType: string;
  collectorNumberFormat: string | null;
  notes: string | null;
  version: number;
}

// Shared admin Badge (token-styled) instead of a bespoke emerald/amber/red
// span — verified → act (green), provisional → wait (amber), else → red.
const statusBadge = (status: string) => {
  const variant: AdminBadgeVariant = status === "verified" ? "act" : status === "provisional" ? "wait" : "red";
  return <Badge variant={variant}>{status.replace(/_/g, " ")}</Badge>;
};

export default function AdminPokemonKnowledgePage() {
  const [section, setSection] = useState<Section>("Overview");
  const queryClient = useQueryClient();

  // ── shared queries ──────────────────────────────────────────────────────────
  const overview = useQuery({
    queryKey: ["/api/admin/pokemon-knowledge/overview"],
    queryFn: () => getJson<{ catalogue: Record<string, unknown>; sets: { total: number; verified: number; provisional: number; needsReview: number; recentlyUpdated: number }; pendingReview: number; latest: { setKey: string; canonicalName: string }[] }>("/api/admin/pokemon-knowledge/overview"),
  });

  const [setQuery, setSetQuery] = useState("");
  const [setLang, setSetLang] = useState("");
  const [setEra, setSetEra] = useState("");
  const [setPage, setSetPage] = useState(1);
  const sets = useQuery({
    queryKey: ["/api/admin/pokemon-knowledge/sets", setQuery, setLang, setEra, setPage],
    queryFn: () =>
      getJson<{ items: SetRow[]; total: number; page: number; pageSize: number }>(
        `/api/admin/pokemon-knowledge/sets?q=${encodeURIComponent(setQuery)}&language=${setLang}&era=${setEra}&page=${setPage}`,
      ),
    enabled: section === "Sets" || section === "Set Codes",
  });

  const [detailKey, setDetailKey] = useState<{ setKey: string; language: string } | null>(null);
  const detail = useQuery({
    queryKey: ["/api/admin/pokemon-knowledge/set-detail", detailKey?.setKey, detailKey?.language],
    queryFn: () => getJson<{ set: SetRow; aliases: { aliasType: string; aliasValue: string }[]; revisions: { revisionNumber: number; reason: string | null; editedBy: string | null; createdAt: string }[]; related: SetRow[]; prev: { setKey: string; language: string; name: string } | null; next: { setKey: string; language: string; name: string } | null }>(
      `/api/admin/pokemon-knowledge/sets/${detailKey!.setKey}?language=${detailKey!.language}`,
    ),
    enabled: Boolean(detailKey),
  });

  const reviewQueue = useQuery({
    queryKey: ["/api/admin/pokemon-knowledge/review-queue"],
    queryFn: () => getJson<{ id: number; kind: string; entityKey: string; details: Record<string, unknown>; status: string; importRunId: number | null }[]>("/api/admin/pokemon-knowledge/review-queue"),
    enabled: section === "Review Queue" || section === "Overview",
  });
  const imports = useQuery({
    queryKey: ["/api/admin/pokemon-knowledge/imports"],
    queryFn: () => getJson<{ id: number; source: string; status: string; recordsTotal: number; recordsAdded: number; recordsChanged: number; conflicts: unknown[]; createdAt: string }[]>("/api/admin/pokemon-knowledge/imports"),
    enabled: section === "Review Queue",
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/pokemon-knowledge/overview"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/pokemon-knowledge/sets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/pokemon-knowledge/review-queue"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/pokemon-knowledge/imports"] });
  };

  // ── Compare state ───────────────────────────────────────────────────────────
  const allCompareOptions = useMemo(
    () => [
      ...POKEMON_RARITIES.map((r) => ({ kind: "rarity" as const, value: r.value, label: `Rarity · ${r.label}` })),
      ...POKEMON_FINISHES.map((f) => ({ kind: "finish" as const, value: f.value, label: `Finish · ${f.label}` })),
      ...POKEMON_PROMOS.map((p) => ({ kind: "promo" as const, value: p.value, label: `${p.kind === "subset" ? "Subset" : "Promo"} · ${p.label}` })),
    ],
    [],
  );
  const [compareLeft, setCompareLeft] = useState("rarity:special_illustration_rare");
  const [compareRight, setCompareRight] = useState("rarity:ultra_rare");

  // ── Rarity directory filters ───────────────────────────────────────────────
  const [dirLang, setDirLang] = useState("en");
  const [dirEra, setDirEra] = useState<PokemonEra | "">("");
  const [selectedRarity, setSelectedRarity] = useState<PokemonRarity | null>(null);
  const dirRarities = useMemo(() => filterRarities({ language: dirLang, era: dirEra || null }), [dirLang, dirEra]);

  const compareCard = (key: string) => {
    const [kind, value] = key.split(":") as ["rarity" | "finish" | "promo", string];
    const rarity = kind === "rarity" ? POKEMON_RARITIES.find((r) => r.value === value) : undefined;
    const finish = kind === "finish" ? POKEMON_FINISHES.find((f) => f.value === value) : undefined;
    const promo = kind === "promo" ? POKEMON_PROMOS.find((p) => p.value === value) : undefined;
    const label = rarity?.label ?? finish?.label ?? promo?.label ?? value;
    const prov = provenanceFor(kind, value);
    const note = knowledgeNoteFor(kind, value);
    return (
      <div className="flex-1 rounded-xl border border-[var(--admin-line)] bg-[var(--admin-panel)]/60 p-4">
        <div className="flex h-12 items-center justify-center">
          {rarity ? <RaritySymbol symbol={rarity.symbol} size={36} /> : <span className="text-2xl text-[var(--admin-ink-faint)]">{finish ? "◈" : "★"}</span>}
        </div>
        <div className="mt-2 text-center text-sm font-bold text-[var(--admin-ink)]">{label}</div>
        {rarity && <div className="text-center text-[11px] text-[var(--admin-ink-faint)]">{describeSymbol(rarity.symbol)}</div>}
        <div className="mt-2 space-y-1 text-[11px] text-[var(--admin-ink-dim)]">
          <div>Type: <b>{kind === "promo" ? (promo?.kind ?? "promo") : kind}</b></div>
          {rarity && <div>Regions: <b>{rarity.regions === "all" ? "all" : rarity.regions.join(", ")}</b></div>}
          {rarity && <div>Eras: <b>{rarity.eras === "all" ? "all" : rarity.eras.join(", ")}</b></div>}
          <div>Status: {statusBadge(prov.status)} <span className="text-[var(--admin-ink-faint)]">({prov.confidence})</span></div>
          {(rarity?.description || finish?.description || promo?.description) && <div className="text-[var(--admin-ink-faint)]">{rarity?.description ?? finish?.description ?? promo?.description}</div>}
          {note?.commonMistakes[0] && <div className="text-[var(--admin-gold)]">Watch: {note.commonMistakes[0]}</div>}
        </div>
      </div>
    );
  };

  const setsTable = (compact: boolean) => (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input
          value={setQuery}
          onChange={(e) => { setSetQuery(e.target.value); setSetPage(1); }}
          placeholder="Search sets, codes, aliases (e.g. SV8, 151, evolving skies)…"
          data-testid="knowledge-set-search"
          className="w-72 rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1.5 text-xs text-[var(--admin-ink)]"
        />
        <select value={setLang} onChange={(e) => { setSetLang(e.target.value); setSetPage(1); }} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1.5 text-xs text-[var(--admin-ink)]">
          <option value="">All languages</option>
          {POKEMON_LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <select value={setEra} onChange={(e) => { setSetEra(e.target.value); setSetPage(1); }} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1.5 text-xs text-[var(--admin-ink)]">
          <option value="">All eras</option>
          {POKEMON_ERAS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      </div>
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-[var(--admin-line)] text-[10px] uppercase tracking-wide text-[var(--admin-ink-faint)]">
            <th className="py-1.5 pr-2">Code</th>
            <th className="py-1.5 pr-2">Set</th>
            <th className="py-1.5 pr-2">Year</th>
            <th className="py-1.5 pr-2">Lang / Region</th>
            <th className="py-1.5 pr-2">Era</th>
            {!compact && <th className="py-1.5 pr-2">Cards</th>}
            <th className="py-1.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {(sets.data?.items ?? []).map((s) => (
            <tr
              key={`${s.setKey}:${s.language}`}
              onClick={() => setDetailKey({ setKey: s.setKey, language: s.language })}
              className="cursor-pointer border-b border-[var(--admin-line)] text-[var(--admin-ink-dim)] hover:bg-[var(--admin-panel2)]/40"
              data-testid={`set-row-${s.setKey}-${s.language}`}
            >
              <td className="py-1.5 pr-2 font-bold text-[var(--admin-gold)]">{s.setCode ?? s.setKey}</td>
              <td className="py-1.5 pr-2">{s.canonicalName}</td>
              <td className="py-1.5 pr-2">{s.year ?? "—"}</td>
              <td className="py-1.5 pr-2">{s.language} / {s.region ?? "—"}</td>
              <td className="py-1.5 pr-2">{s.era ?? "—"}</td>
              {!compact && <td className="py-1.5 pr-2">{s.mainCount ?? "?"}{s.secretCount ? `+${s.secretCount}` : ""}</td>}
              <td className="py-1.5">{statusBadge(s.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sets.data && sets.data.total === 0 && (
        <div className="mt-4 text-xs text-[var(--admin-ink-faint)]">
          No sets yet — use <b>Review Queue → Load starter set data</b> to create a reviewable import draft.
        </div>
      )}
      {sets.data && sets.data.total > sets.data.pageSize && (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--admin-ink-dim)]">
          <AdminButton size="sm" type="button" disabled={setPage <= 1} onClick={() => setSetPage((p) => p - 1)}>Prev</AdminButton>
          Page {sets.data.page} / {Math.ceil(sets.data.total / sets.data.pageSize)}
          <AdminButton size="sm" type="button" disabled={setPage >= Math.ceil(sets.data.total / sets.data.pageSize)} onClick={() => setSetPage((p) => p + 1)}>Next</AdminButton>
        </div>
      )}

      {detailKey && detail.data && (
        <Panel className="mt-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-bold text-[var(--admin-ink)]">
                {detail.data.set.canonicalName} <span className="text-[var(--admin-gold)]">[{detail.data.set.setCode ?? detail.data.set.setKey}]</span> {statusBadge(detail.data.set.status)}
              </div>
              <div className="mt-1 text-[11px] text-[var(--admin-ink-faint)]">
                {detail.data.set.series ?? "—"} · {detail.data.set.era ?? "era ?"} · {detail.data.set.region ?? "region ?"} · {detail.data.set.language} · {detail.data.set.year ?? "year ?"} ·
                Cards: {detail.data.set.mainCount ?? "?"}{detail.data.set.secretCount ? ` (+${detail.data.set.secretCount} secret)` : ""} ·
                Numbers: {detail.data.set.collectorNumberFormat ?? "—"} · Source: {detail.data.set.sourceType} ({detail.data.set.confidence}) · v{detail.data.set.version}
              </div>
              {detail.data.set.notes && <div className="mt-1 text-[11px] text-[var(--admin-ink-dim)]">{detail.data.set.notes}</div>}
              {detail.data.aliases.length > 0 && (
                <div className="mt-1 text-[11px] text-[var(--admin-ink-faint)]">Aliases: {detail.data.aliases.map((a) => `${a.aliasValue} (${a.aliasType})`).join(", ")}</div>
              )}
              {detail.data.related.length > 0 && (
                <div className="mt-1 text-[11px] text-[var(--admin-ink-faint)]">
                  Regional editions / related: {detail.data.related.map((r) => (
                    <button key={`${r.setKey}:${r.language}`} type="button" className="mr-2 underline hover:text-[var(--admin-ink-dim)]" onClick={() => setDetailKey({ setKey: r.setKey, language: r.language })}>
                      {r.canonicalName} [{r.language}]
                    </button>
                  ))}
                </div>
              )}
              {detail.data.revisions.length > 0 && (
                <div className="mt-2 text-[11px] text-[var(--admin-ink-faint)]">
                  History: {detail.data.revisions.slice(0, 5).map((rv) => `v${rv.revisionNumber} (${rv.reason ?? "edit"} — ${rv.editedBy ?? "?"})`).join(" · ")}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              {detail.data.prev && <AdminButton size="sm" type="button" onClick={() => setDetailKey({ setKey: detail.data!.prev!.setKey, language: detail.data!.prev!.language })}>← Prev</AdminButton>}
              {detail.data.next && <AdminButton size="sm" type="button" onClick={() => setDetailKey({ setKey: detail.data!.next!.setKey, language: detail.data!.next!.language })}>Next →</AdminButton>}
              <AdminButton size="sm" type="button" onClick={() => setDetailKey(null)}>Close</AdminButton>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );

  return (
    // Shared admin shell: the .admin-root token scope + AdminHeaderRow header
    // (same design system as the Super Admin dashboard and the Group-1 admin
    // routes). Previously this page rendered its own standalone slate-950
    // theme with a bespoke header. All catalogue data, queries, imports and
    // review-decision POSTs below are unchanged.
    <div className="admin-root min-h-screen bg-[var(--admin-bg)] text-[var(--admin-ink)]">
      <header className="border-b border-[var(--admin-line)] px-4 py-2">
        <AdminHeaderRow
          testId="pokemon-knowledge-header"
          left={
            <div className="min-w-0">
              <h1 className="text-sm font-extrabold tracking-wide text-[var(--admin-gold)]">Pokémon Knowledge</h1>
              <div className="text-[11px] text-[var(--admin-ink-faint)]">
                One shared catalogue powering the grading picker, this Hub and the PDF handbook · v
                {KNOWLEDGE_CATALOGUE_VERSION}
              </div>
            </div>
          }
          right={
            <a
              href="/admin"
              className="rounded-lg border border-[var(--admin-gold)]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/90 hover:bg-[var(--admin-gold)]/10"
            >
              ← Admin
            </a>
          }
        />
      </header>
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-4 flex flex-wrap gap-1.5" data-testid="knowledge-nav">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSection(s)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                section === s ? "border-[var(--admin-gold)] bg-[var(--admin-gold)]/10 text-[var(--admin-gold)]" : "border-[var(--admin-line)] bg-[var(--admin-panel)]/60 text-[var(--admin-ink-dim)] hover:border-[var(--admin-line)]"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {section === "Overview" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Sets", overview.data?.sets?.total ?? "—"],
                ["Verified sets", overview.data?.sets?.verified ?? "—"],
                ["Provisional sets", overview.data?.sets?.provisional ?? "—"],
                ["Pending review", overview.data?.pendingReview ?? "—"],
                ["Rarities", POKEMON_RARITIES.length],
                ["Finishes", POKEMON_FINISHES.length],
                ["Promos", POKEMON_PROMOS.filter((p) => p.kind === "promo").length],
                ["Subsets", POKEMON_PROMOS.filter((p) => p.kind === "subset").length],
              ].map(([label, value]) => (
                <Panel key={String(label)}>
                  <div className="text-2xl font-extrabold text-[var(--admin-gold)]">{String(value)}</div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--admin-ink-faint)]">{String(label)}</div>
                </Panel>
              ))}
            </div>
            <Panel>
              <div className="mb-2 text-sm font-bold text-[var(--admin-ink)]">Quick actions</div>
              <div className="flex flex-wrap gap-2">
                <AdminButton size="sm" type="button" onClick={() => setSection("Sets")}>Search everything</AdminButton>
                <AdminButton size="sm" type="button" onClick={() => setSection("Review Queue")}>Review pending records</AdminButton>
                <a href="/api/admin/pokemon-knowledge/handbook.pdf" download className="inline-flex items-center rounded-lg border border-[var(--admin-gold)] bg-[var(--admin-gold)]/10 px-3 py-1.5 text-xs font-semibold text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/20">
                  Generate handbook (PDF)
                </a>
              </div>
              {(overview.data?.latest?.length ?? 0) > 0 && (
                <div className="mt-3 text-[11px] text-[var(--admin-ink-faint)]">Latest sets: {overview.data!.latest.map((l) => l.canonicalName).join(" · ")}</div>
              )}
            </Panel>
          </div>
        )}

        {section === "Sets" && <Panel>{setsTable(false)}</Panel>}
        {section === "Set Codes" && (
          <Panel>
            <div className="mb-2 text-[11px] text-[var(--admin-ink-faint)]">Code-first lookup — search by exact/partial code, name, alias, year or number pattern.</div>
            {setsTable(true)}
          </Panel>
        )}

        {section === "Rarities" && (
          <Panel>
            <div className="mb-3 flex flex-wrap gap-2">
              <select value={dirLang} onChange={(e) => setDirLang(e.target.value)} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1.5 text-xs">
                {POKEMON_LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
              <select value={dirEra} onChange={(e) => setDirEra(e.target.value as PokemonEra | "")} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1.5 text-xs">
                <option value="">Any era</option>
                {POKEMON_ERAS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="rarity-directory">
              {dirRarities.map((r) => {
                const prov = provenanceFor("rarity", r.value);
                return (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => setSelectedRarity(r)}
                    className="flex flex-col items-center gap-1.5 rounded-xl border border-[var(--admin-line)] bg-[var(--admin-panel)]/60 p-4 hover:border-[var(--admin-gold)]/60"
                    aria-label={`${r.label} — ${describeSymbol(r.symbol)}`}
                  >
                    <RaritySymbol symbol={r.symbol} size={42} />
                    <div className="text-xs font-bold text-[var(--admin-ink)]">{r.label} {r.codes[0] ? <span className="text-[var(--admin-gold)]">[{r.codes[0]}]</span> : null}</div>
                    <div className="text-[10px] text-[var(--admin-ink-faint)]">{describeSymbol(r.symbol)}</div>
                    {statusBadge(prov.status)}
                  </button>
                );
              })}
            </div>
            {selectedRarity && (
              <div className="mt-4 rounded-xl border border-[var(--admin-gold)]/30 bg-[var(--admin-gold)]/[0.06] p-4">
                <div className="flex items-center gap-3">
                  <RaritySymbol symbol={selectedRarity.symbol} size={34} />
                  <div className="text-sm font-bold">{selectedRarity.label}</div>
                  {statusBadge(provenanceFor("rarity", selectedRarity.value).status)}
                  <span className="ml-auto">
                    <AdminButton size="sm" type="button" onClick={() => setSelectedRarity(null)}>
                      Close
                    </AdminButton>
                  </span>
                </div>
                <div className="mt-2 grid gap-1 text-[11px] text-[var(--admin-ink-dim)] sm:grid-cols-2">
                  <div>{selectedRarity.description}</div>
                  <div>Codes: {selectedRarity.codes.join(", ") || "—"} · Aliases: {selectedRarity.aliases.slice(0, 5).join(", ")}</div>
                  <div>Regions: {selectedRarity.regions === "all" ? "all" : selectedRarity.regions.join(", ")} · Eras: {selectedRarity.eras === "all" ? "all" : selectedRarity.eras.join(", ")}</div>
                  <div>Source: {provenanceFor("rarity", selectedRarity.value).sources.map((s) => s.sourceType).join(", ")} · confidence {provenanceFor("rarity", selectedRarity.value).confidence}</div>
                  {knowledgeNoteFor("rarity", selectedRarity.value)?.commonMistakes[0] && (
                    <div className="text-[var(--admin-gold)] sm:col-span-2">Watch: {knowledgeNoteFor("rarity", selectedRarity.value)!.commonMistakes[0]}</div>
                  )}
                </div>
              </div>
            )}
          </Panel>
        )}

        {section === "Finishes" && (
          <Panel>
            <div className="space-y-2">
              {POKEMON_FINISHES.map((f) => {
                const note = knowledgeNoteFor("finish", f.value);
                return (
                  <div key={f.value} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]/50 p-3">
                    <div className="flex items-center gap-2 text-xs font-bold text-[var(--admin-ink)]">{f.label} {statusBadge(provenanceFor("finish", f.value).status)}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--admin-ink-faint)]">{f.description} {note?.identification}</div>
                    {note?.commonMistakes[0] && <div className="text-[11px] text-[var(--admin-gold)]">Watch: {note.commonMistakes[0]}</div>}
                    {note?.compatibility && <div className="text-[11px] text-[var(--admin-ink-faint)]">Where: {note.compatibility}</div>}
                  </div>
                );
              })}
            </div>
          </Panel>
        )}

        {section === "Promos & Subsets" && (
          <div className="grid gap-4 sm:grid-cols-2">
            {(["promo", "subset"] as const).map((kind) => (
              <Panel key={kind}>
                <div className="mb-2 text-sm font-bold text-[var(--admin-ink)]">{kind === "promo" ? "Promo programmes" : "Subsets"}</div>
                <div className="space-y-2">
                  {POKEMON_PROMOS.filter((p) => p.kind === kind).map((p) => {
                    const note = knowledgeNoteFor("promo", p.value);
                    return (
                      <div key={p.value} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]/50 p-2.5">
                        <div className="flex items-center gap-2 text-xs font-bold text-[var(--admin-ink)]">{p.label} {statusBadge(provenanceFor("promo", p.value).status)}</div>
                        <div className="text-[11px] text-[var(--admin-ink-faint)]">{p.description} {note?.identification} <i>Not a printed rarity.</i></div>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            ))}
          </div>
        )}

        {section === "Languages" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {LANGUAGE_GUIDE.map((l) => (
              <Panel key={l.key}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-[var(--admin-ink)]">{l.label}</div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--admin-ink-faint)]">{l.region}</div>
                </div>
                <div className="mt-1 rounded bg-[var(--admin-panel)]/70 px-2 py-1 text-xs text-[var(--admin-gold-hi)]">{l.sampleScript}</div>
                <div className="mt-2 space-y-0.5 text-[11px] text-[var(--admin-ink-faint)]">
                  <div>Set codes: {l.setCodeFormat}</div>
                  <div>Rarity format: {l.rarityFormat}</div>
                  {l.tips.map((t, i) => <div key={i}>• {t}</div>)}
                  {l.commonMistakes[0] && <div className="text-[var(--admin-gold)]">Watch: {l.commonMistakes[0]}</div>}
                </div>
              </Panel>
            ))}
          </div>
        )}

        {section === "Eras" && (
          <Panel>
            <div className="space-y-0">
              {ERA_TIMELINE.filter((e) => e.key !== "future").map((e, i, arr) => (
                <div key={e.key} className="relative flex gap-4 pb-6">
                  <div className="flex flex-col items-center">
                    <div className="h-3 w-3 rounded-full border border-[var(--admin-gold)] bg-[var(--admin-gold)]" />
                    {i < arr.length - 1 && <div className="w-px flex-1 bg-[var(--admin-panel3)]" />}
                  </div>
                  <div className="-mt-0.5">
                    <div className="text-sm font-bold text-[var(--admin-ink)]">{e.label} <span className="font-normal text-[var(--admin-ink-faint)]">· {e.yearsApprox}</span> <span className="rounded bg-[var(--admin-panel2)] px-1.5 py-0.5 text-[10px] text-[var(--admin-ink-dim)]">{e.catalogueEra}</span></div>
                    <div className="mt-1 grid gap-0.5 text-[11px] text-[var(--admin-ink-faint)] sm:grid-cols-2">
                      <div><b className="text-[var(--admin-ink-dim)]">Rarities:</b> {e.raritySystemNotes}</div>
                      <div><b className="text-[var(--admin-ink-dim)]">Codes:</b> {e.codeFormatNotes}</div>
                      <div><b className="text-[var(--admin-ink-dim)]">Finishes:</b> {e.finishNotes}</div>
                      <div><b className="text-[var(--admin-ink-dim)]">Promos:</b> {e.promoNotes}</div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="text-[11px] text-[var(--admin-ink-faint)]">Future eras are added as catalogue data — no code change needed.</div>
            </div>
          </Panel>
        )}

        {section === "Compare" && (
          <Panel>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {COMPARISON_PAIRS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => { setCompareLeft(`${c.left.kind}:${c.left.value}`); setCompareRight(`${c.right.kind}:${c.right.value}`); }}
                  className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]/60 px-2.5 py-1 text-[11px] text-[var(--admin-ink-dim)] hover:border-[var(--admin-gold)]/60"
                >
                  {c.title}
                </button>
              ))}
            </div>
            <div className="mb-3 flex flex-wrap gap-2">
              <select value={compareLeft} onChange={(e) => setCompareLeft(e.target.value)} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1.5 text-xs" data-testid="compare-left">
                {allCompareOptions.map((o) => <option key={`${o.kind}:${o.value}`} value={`${o.kind}:${o.value}`}>{o.label}</option>)}
              </select>
              <span className="self-center text-xs font-bold text-[var(--admin-ink-faint)]">VS</span>
              <select value={compareRight} onChange={(e) => setCompareRight(e.target.value)} className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)] px-2 py-1.5 text-xs" data-testid="compare-right">
                {allCompareOptions.map((o) => <option key={`${o.kind}:${o.value}`} value={`${o.kind}:${o.value}`}>{o.label}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">{compareCard(compareLeft)}{compareCard(compareRight)}</div>
            {(() => {
              const preset = COMPARISON_PAIRS.find(
                (c) => `${c.left.kind}:${c.left.value}` === compareLeft && `${c.right.kind}:${c.right.value}` === compareRight,
              );
              return preset ? (
                <div className="mt-3 rounded-lg border border-[var(--admin-gold)]/30 bg-[var(--admin-gold)]/[0.06] p-3 text-[11px] text-[var(--admin-ink-dim)]">
                  <b className="text-[var(--admin-gold)]">How to tell:</b> {preset.howToTell}
                  <div className="mt-1 text-[var(--admin-gold)]">Common mistake: {preset.commonMistake}</div>
                </div>
              ) : null;
            })()}
          </Panel>
        )}

        {section === "Review Queue" && (
          <div className="space-y-4">
            <Panel>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-bold text-[var(--admin-ink)]">Import drafts</div>
                <AdminButton
                  size="sm"
                  type="button"
                  onClick={async () => {
                    await postJson("/api/admin/pokemon-knowledge/imports/starter", {});
                    invalidate();
                  }}
                >
                  Load starter set data (draft)
                </AdminButton>
              </div>
              <div className="space-y-2">
                {(imports.data ?? []).map((run) => (
                  <div key={run.id} className="flex items-center justify-between rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]/50 p-2.5 text-xs">
                    <div>
                      <b>#{run.id} · {run.source}</b> — {run.recordsTotal} records ({run.recordsAdded} new, {run.recordsChanged} existing, {run.conflicts.length} conflicts) {statusBadge(run.status === "applied" ? "verified" : run.status === "draft" ? "provisional" : "needs_review")}
                    </div>
                    {run.status === "draft" && (
                      <div className="flex gap-2">
                        <AdminButton size="sm" type="button" variant="gold" onClick={async () => { await postJson(`/api/admin/pokemon-knowledge/imports/${run.id}/decision`, { decision: "approved" }); invalidate(); }}>Approve & apply</AdminButton>
                        <AdminButton size="sm" type="button" onClick={async () => { await postJson(`/api/admin/pokemon-knowledge/imports/${run.id}/decision`, { decision: "rejected" }); invalidate(); }}>Reject</AdminButton>
                      </div>
                    )}
                  </div>
                ))}
                {(imports.data ?? []).length === 0 && <div className="text-xs text-[var(--admin-ink-faint)]">No import drafts yet.</div>}
              </div>
            </Panel>
            <Panel>
              <div className="mb-2 text-sm font-bold text-[var(--admin-ink)]">Knowledge review queue</div>
              <div className="space-y-2">
                {(reviewQueue.data ?? []).map((item) => (
                  <div key={item.id} className="flex items-center justify-between rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]/50 p-2.5 text-xs">
                    <div>
                      <b className="text-[var(--admin-gold)]">{item.kind.replace(/_/g, " ")}</b> — {item.entityKey}
                      <span className="ml-2 text-[var(--admin-ink-faint)]">{JSON.stringify(item.details).slice(0, 120)}</span>
                    </div>
                    <div className="flex gap-2">
                      {(["approved", "rejected", "ignored"] as const).map((d) => (
                        <AdminButton key={d} size="sm" type="button" onClick={async () => { await postJson(`/api/admin/pokemon-knowledge/review-queue/${item.id}/decision`, { decision: d }); invalidate(); }}>
                          {d === "approved" ? "Approve" : d === "rejected" ? "Reject" : "Ignore"}
                        </AdminButton>
                      ))}
                    </div>
                  </div>
                ))}
                {(reviewQueue.data ?? []).length === 0 && <div className="text-xs text-[var(--admin-ink-faint)]">Nothing pending review.</div>}
              </div>
              <div className="mt-2 text-[10px] text-[var(--admin-ink-faint)]">Decisions record the knowledge rule only — no certificate is ever rewritten from here.</div>
            </Panel>
          </div>
        )}

        {section === "Handbook" && (
          <Panel>
            <div className="mb-2 text-sm font-bold text-[var(--admin-ink)]">Generated documents</div>
            <div className="mb-3 text-[11px] text-[var(--admin-ink-faint)]">
              Generated from this same catalogue (v{KNOWLEDGE_CATALOGUE_VERSION}). Provisional records are labelled inside the PDFs. No customer data is included.
            </div>
            <div className="flex flex-wrap gap-2">
              <a href="/api/admin/pokemon-knowledge/handbook.pdf" download className="rounded-lg border border-[var(--admin-gold)] bg-[var(--admin-gold)]/10 px-3 py-2 text-xs font-bold text-[var(--admin-gold)] hover:bg-[var(--admin-gold)]/20" data-testid="btn-handbook">
                Full Handbook (PDF)
              </a>
              {([
                ["rarities", "Rarity Symbols — Large"],
                ["finishes", "Finish Comparison"],
                ["promos", "Promo/Subset Quick Guide"],
                ["setcodes", "Set Code Quick Directory"],
                ["languages", "Language Identification"],
              ] as const).map(([kind, label]) => (
                <a key={kind} href={`/api/admin/pokemon-knowledge/desk-sheet/${kind}.pdf`} download className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel)]/60 px-3 py-2 text-xs font-semibold text-[var(--admin-ink-dim)] hover:border-[var(--admin-line)]">
                  {label}
                </a>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href="/api/admin/pokemon-knowledge/export.csv" download className="text-[11px] text-[var(--admin-ink-faint)] underline hover:text-[var(--admin-ink-dim)]">Export catalogue CSV</a>
              <a href="/api/admin/pokemon-knowledge/export.json" download className="text-[11px] text-[var(--admin-ink-faint)] underline hover:text-[var(--admin-ink-dim)]">Export catalogue JSON</a>
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
