/**
 * Structured visual Pokémon rarity + variant picker (grading admin).
 *
 * FOUR independent classifications — Language/Region, Printed Rarity, Finish/Variant,
 * Promo/Subset — never one flat dropdown. Each rarity is a large clickable chip showing
 * the ACTUAL symbol + colour, a short label and a plain-English description, with a
 * selected-state highlight. Includes search (aliases), favourites, recently-used, a
 * More Variants panel (region/era-filtered-out rarities) and a live certificate preview.
 *
 * Standalone + additive: it does NOT modify the protected grading card tool or the
 * certificate renderer. It emits a StructuredCardVariant via onChange; wiring it into the
 * certificate form + storing each field in its own column is a separate, approval-gated step.
 */
import { useEffect, useMemo, useState } from "react";
import {
  POKEMON_LANGUAGES,
  POKEMON_ERAS,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  filterRarities,
  searchCatalogue,
  rarityByValue,
  finishByValue,
  promoByValue,
  languageByValue,
  addRecent,
  toggleFavourite,
  buildStructuredVariant,
  type PokemonRarity,
  type PokemonEra,
  type StructuredCardVariant,
} from "@shared/pokemon-rarity-catalogue";
import { RaritySymbol } from "./RaritySymbol";

function usePersistentList(key: string): [string[], (next: string[]) => void] {
  const [list, setList] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      return [];
    }
  });
  const set = (next: string[]) => {
    setList(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
  };
  return [list, set];
}

export function RarityVariantPicker({
  value,
  onChange,
}: {
  value?: Partial<StructuredCardVariant> | null;
  onChange?: (v: StructuredCardVariant) => void;
}) {
  const [language, setLanguage] = useState<string>(value?.language ?? "en");
  const [era, setEra] = useState<PokemonEra | "">((value?.era as PokemonEra) ?? "");
  const [rarity, setRarity] = useState<string | null>(value?.rarity ?? null);
  const [finish, setFinish] = useState<string | null>(value?.finish ?? null);
  const [promoOrSubset, setPromoOrSubset] = useState<string | null>(value?.promo ?? value?.subset ?? null);
  const [query, setQuery] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [favourites, setFavourites] = usePersistentList("mv.rarityFavourites");
  const [recent, setRecent] = usePersistentList("mv.rarityRecent");

  const available = useMemo(() => filterRarities({ language, era: era || null }), [language, era]);
  const allForRegionButFiltered = useMemo(
    () => filterRarities({ language }).filter((rr) => !available.some((a) => a.value === rr.value)),
    [language, available],
  );
  const search = query.trim() ? searchCatalogue(query) : null;

  const structured = useMemo(
    () => buildStructuredVariant({ language, era: era || null, rarity, finish, promoOrSubset }),
    [language, era, rarity, finish, promoOrSubset],
  );
  useEffect(() => {
    onChange?.(structured);
  }, [structured, onChange]);

  const pickRarity = (v: string) => {
    setRarity(v);
    setRecent(addRecent(recent, v));
  };

  const chip = (rr: PokemonRarity) => {
    const selected = rarity === rr.value;
    const fav = favourites.includes(rr.value);
    return (
      <button
        key={rr.value}
        type="button"
        onClick={() => pickRarity(rr.value)}
        title={rr.description}
        className={`relative flex min-w-[140px] flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition ${
          selected ? "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500" : "border-slate-700 bg-slate-900/60 hover:border-slate-500"
        }`}
      >
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            setFavourites(toggleFavourite(favourites, rr.value));
          }}
          className={`absolute right-1.5 top-1.5 text-xs ${fav ? "text-amber-400" : "text-slate-600 hover:text-slate-400"}`}
        >
          {fav ? "★" : "☆"}
        </span>
        <span className="flex h-9 items-center gap-2">
          <RaritySymbol symbol={rr.symbol} />
          {rr.codes[0] && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-slate-300">{rr.codes[0]}</span>}
        </span>
        <span className="text-xs font-bold text-slate-100">{rr.label}</span>
        <span className="text-[10px] leading-tight text-slate-400">{rr.description}</span>
      </button>
    );
  };

  const pill = <T extends { value: string; label: string; description?: string }>(
    item: T,
    active: boolean,
    onPick: () => void,
  ) => (
    <button
      key={item.value}
      type="button"
      onClick={onPick}
      title={item.description}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
        active ? "border-emerald-500 bg-emerald-500/15 text-emerald-200" : "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-500"
      }`}
    >
      {item.label}
    </button>
  );

  const favouriteRarities = favourites.map(rarityByValue).filter(Boolean) as PokemonRarity[];
  const recentRarities = recent.map(rarityByValue).filter(Boolean) as PokemonRarity[];

  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
      {/* 1 · Language / Region + era + search */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Language / Region</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100">
            {POKEMON_LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Set era</span>
          <select value={era} onChange={(e) => setEra(e.target.value as PokemonEra | "")} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100">
            <option value="">Any era</option>
            {POKEMON_ERAS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Search (e.g. “2 gold”, “SIR”, “master ball”)</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search rarities, finishes, promos…" className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100" />
        </label>
      </div>

      {search && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-2">
          <div className="mb-1 text-[11px] font-semibold text-slate-400">Search results</div>
          <div className="flex flex-wrap gap-2">{search.rarities.map(chip)}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {search.finishes.map((x) => pill(x, finish === x.value, () => setFinish(x.value)))}
            {search.promos.map((x) => pill(x, promoOrSubset === x.value, () => setPromoOrSubset(x.value)))}
          </div>
        </div>
      )}

      {(favouriteRarities.length > 0 || recentRarities.length > 0) && !search && (
        <div className="space-y-2">
          {favouriteRarities.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-amber-300/80">★ Favourites</div>
              <div className="flex flex-wrap gap-2">{favouriteRarities.map(chip)}</div>
            </div>
          )}
          {recentRarities.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-slate-400">Recently used</div>
              <div className="flex flex-wrap gap-2">{recentRarities.map(chip)}</div>
            </div>
          )}
        </div>
      )}

      {/* 2 · Printed Rarity */}
      {!search && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Printed Rarity</div>
          <div className="flex flex-wrap gap-2">{available.map(chip)}</div>
          {allForRegionButFiltered.length > 0 && (
            <>
              <button type="button" onClick={() => setShowMore((s) => !s)} className="mt-2 text-[11px] font-semibold text-slate-400 underline hover:text-slate-200">
                {showMore ? "Hide" : "More variants"} ({allForRegionButFiltered.length})
              </button>
              {showMore && <div className="mt-2 flex flex-wrap gap-2 opacity-90">{allForRegionButFiltered.map(chip)}</div>}
            </>
          )}
        </div>
      )}

      {/* 3 · Finish / Variant */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Finish / Variant</div>
        <div className="flex flex-wrap gap-2">{POKEMON_FINISHES.map((x) => pill(x, finish === x.value, () => setFinish(finish === x.value ? null : x.value)))}</div>
      </div>

      {/* 4 · Promo / Subset */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Promo / Subset</div>
        <div className="flex flex-wrap gap-2">{POKEMON_PROMOS.map((x) => pill(x, promoOrSubset === x.value, () => setPromoOrSubset(promoOrSubset === x.value ? null : x.value)))}</div>
      </div>

      {/* Live certificate preview — each field kept SEPARATE */}
      <div className="rounded-xl border border-amber-800/40 bg-amber-950/10 p-3">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300/80">Certificate preview</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-300 sm:grid-cols-3">
          <div>Language: <b className="text-slate-100">{languageByValue(structured.language)?.label}</b></div>
          <div>Region: <b className="text-slate-100">{structured.region}</b></div>
          <div>Era: <b className="text-slate-100">{structured.era ? POKEMON_ERAS.find((e) => e.value === structured.era)?.label : "—"}</b></div>
          <div className="flex items-center gap-1.5">Rarity: {rarity ? <><RaritySymbol symbol={rarityByValue(rarity)!.symbol} size={18} /><b className="text-slate-100">{rarityByValue(rarity)!.label}</b></> : <span className="text-slate-500">—</span>}</div>
          <div>Symbol colour: <b className="text-slate-100">{structured.symbolColour}</b></div>
          <div>Finish: <b className="text-slate-100">{structured.finish ? finishByValue(structured.finish)?.label : "—"}</b></div>
          <div>Promo: <b className="text-slate-100">{structured.promo ? promoByValue(structured.promo)?.label : "—"}</b></div>
          <div>Subset: <b className="text-slate-100">{structured.subset ? promoByValue(structured.subset)?.label : "—"}</b></div>
        </div>
      </div>
    </div>
  );
}
