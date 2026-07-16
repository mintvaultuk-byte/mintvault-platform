/**
 * Structured visual Pokémon rarity + variant picker (grading admin).
 *
 * FOUR independent classifications — Printed Rarity, Finish/Variant, Promo/Subset
 * and Language/Region/Era — never one flat dropdown. Each rarity is a large
 * clickable chip showing the ACTUAL symbol + colour + count, a short label, a
 * plain-English explanation and an accessible label ("two gold stars"), so gold
 * vs silver and 1★/2★/3★ are unmistakable without relying on text colour.
 *
 * The founder's common choices show first; everything else is behind
 * "More variants". Set language/era filter the list (with a "Show all compatible
 * options" override so nothing is permanently hidden). Search understands aliases
 * ("2 gold", "SIR", "master ball"). Favourites + recently-used can be controlled
 * by the parent (server-persisted) or fall back to localStorage. A live preview
 * shows every field separately, clearly labelled "Preview only — final label
 * rendering unchanged".
 *
 * Standalone + additive: it emits a StructuredCardVariant via onChange and does
 * NOT modify the protected grading card tool or the certificate renderer.
 */
import { useEffect, useMemo, useState } from "react";
import {
  POKEMON_LANGUAGES,
  POKEMON_ERAS,
  POKEMON_FINISHES,
  POKEMON_PROMOS,
  POKEMON_RARITIES,
  filterRarities,
  searchCatalogue,
  rarityByValue,
  finishByValue,
  promoByValue,
  languageByValueOrLabel,
  describeSymbol,
  addRecent,
  toggleFavourite,
  buildStructuredVariant,
  type PokemonRarity,
  type PokemonEra,
  type StructuredCardVariant,
} from "@shared/pokemon-rarity-catalogue";
import { validateStructuredVariant } from "@shared/structured-variant-validate";
import { RaritySymbol } from "./RaritySymbol";

// ── Founder's common choices (Phase 4). Everything else is behind More Variants. ──
const QUICK_RARITIES = [
  "rare",
  "double_rare",
  "illustration_rare",
  "ultra_rare",
  "special_illustration_rare",
  "hyper_rare",
  "jp_art_rare", // AR
  "jp_special_art_rare", // SAR
  "jp_super_rare", // SR
  "jp_hyper_rare", // HR
  "jp_ultra_rare", // UR
];
const QUICK_FINISHES = ["non_holo", "holo", "reverse_holo", "masterball_reverse", "pokeball_reverse"];
const QUICK_PROMOS = ["black_star_promo", "trainer_gallery", "galarian_gallery"];

function usePersistentList(
  key: string,
  controlled: string[] | undefined,
  onControlledChange: ((next: string[]) => void) | undefined,
): [string[], (next: string[]) => void] {
  const [local, setLocal] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      return [];
    }
  });
  if (controlled !== undefined) {
    return [controlled, (next) => onControlledChange?.(next)];
  }
  const set = (next: string[]) => {
    setLocal(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
  };
  return [local, set];
}

export function RarityVariantPicker({
  value,
  onChange,
  legacyVariant,
  favourites: favouritesProp,
  recent: recentProp,
  onFavouritesChange,
  onRecentChange,
}: {
  value?: Partial<StructuredCardVariant> | null;
  onChange?: (v: StructuredCardVariant) => void;
  legacyVariant?: string | null;
  favourites?: string[];
  recent?: string[];
  onFavouritesChange?: (next: string[]) => void;
  onRecentChange?: (next: string[]) => void;
}) {
  const initialLang = languageByValueOrLabel(value?.language)?.value ?? "en";
  const [language, setLanguage] = useState<string>(initialLang);
  const [era, setEra] = useState<PokemonEra | "">((value?.era as PokemonEra) ?? "");
  const [rarity, setRarity] = useState<string | null>(value?.rarity ?? null);
  const [finish, setFinish] = useState<string | null>(value?.finish ?? null);
  const [promoOrSubset, setPromoOrSubset] = useState<string | null>(value?.promo ?? value?.subset ?? null);
  const [query, setQuery] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [showMoreFinish, setShowMoreFinish] = useState(false);
  const [showMorePromo, setShowMorePromo] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [favourites, setFavourites] = usePersistentList("mv.rarityFavourites", favouritesProp, onFavouritesChange);
  const [recent, setRecent] = usePersistentList("mv.rarityRecent", recentProp, onRecentChange);

  // Region/era-aware base set; "Show all compatible" drops the era filter so
  // incomplete set data never permanently hides an option (Phase 8).
  const base = useMemo(
    () => filterRarities({ language, era: showAll ? null : era || null }),
    [language, era, showAll],
  );
  const quickRarities = useMemo(
    () => QUICK_RARITIES.map(rarityByValue).filter((r): r is PokemonRarity => Boolean(r) && base.some((b) => b.value === r!.value)),
    [base],
  );
  const moreRarities = useMemo(() => {
    const quickSet = new Set(quickRarities.map((r) => r.value));
    const inRegion = base.filter((r) => !quickSet.has(r.value));
    // Everything else in the catalogue (all regions/eras) so nothing is ever
    // permanently hidden when set data is incomplete — region set shown first.
    const otherRegion = POKEMON_RARITIES.filter((r) => !quickSet.has(r.value) && !base.some((b) => b.value === r.value));
    return [...inRegion, ...otherRegion];
  }, [base, quickRarities]);

  const search = query.trim() ? searchCatalogue(query) : null;

  const structured = useMemo(
    () => buildStructuredVariant({ language, era: era || null, rarity, finish, promoOrSubset }),
    [language, era, rarity, finish, promoOrSubset],
  );
  useEffect(() => {
    onChange?.(structured);
  }, [structured, onChange]);

  const validation = useMemo(
    () =>
      validateStructuredVariant({
        rarityCode: structured.rarity,
        finishVariant: structured.finish,
        promoType: structured.promo,
        subsetName: structured.subset,
        language: structured.language,
        era: structured.era,
        legacyVariant: legacyVariant ?? null,
      }),
    [structured, legacyVariant],
  );

  const pickRarity = (v: string) => {
    setRarity(v);
    setRecent(addRecent(recent, v));
  };

  const chip = (rr: PokemonRarity) => {
    const selected = rarity === rr.value;
    const fav = favourites.includes(rr.value);
    const aria = `${rr.label} — ${describeSymbol(rr.symbol)}`;
    return (
      <button
        key={rr.value}
        type="button"
        aria-pressed={selected}
        aria-label={aria}
        onClick={() => pickRarity(rr.value)}
        title={rr.description}
        data-testid={`rarity-chip-${rr.value}`}
        className={`relative flex min-w-[140px] flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition ${
          selected ? "border-amber-500 bg-amber-500/10 ring-1 ring-amber-500" : "border-slate-700 bg-slate-900/60 hover:border-slate-500"
        }`}
      >
        <span
          role="button"
          tabIndex={-1}
          aria-label={fav ? `Remove ${rr.label} from favourites` : `Add ${rr.label} to favourites`}
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
      aria-pressed={active}
      onClick={onPick}
      title={item.description}
      data-testid={`pill-${item.value}`}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
        active ? "border-emerald-500 bg-emerald-500/15 text-emerald-200" : "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-slate-500"
      }`}
    >
      {item.label}
    </button>
  );

  const favouriteRarities = favourites.map(rarityByValue).filter(Boolean) as PokemonRarity[];
  const recentRarities = recent.map(rarityByValue).filter(Boolean) as PokemonRarity[];

  const quickFinishes = POKEMON_FINISHES.filter((f) => QUICK_FINISHES.includes(f.value));
  const moreFinishes = POKEMON_FINISHES.filter((f) => !QUICK_FINISHES.includes(f.value));
  const quickPromos = POKEMON_PROMOS.filter((p) => QUICK_PROMOS.includes(p.value));
  const morePromos = POKEMON_PROMOS.filter((p) => !QUICK_PROMOS.includes(p.value));

  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4" data-testid="rarity-picker">
      {/* Language / Region / Era + search */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Language / Region</span>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            data-testid="rarity-language"
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          >
            {POKEMON_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Set era</span>
          <select
            value={era}
            onChange={(e) => setEra(e.target.value as PokemonEra | "")}
            data-testid="rarity-era"
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          >
            <option value="">Any era</option>
            {POKEMON_ERAS.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Search (e.g. “2 gold”, “SIR”, “master ball”)
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rarities, finishes, promos…"
            data-testid="rarity-search"
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          />
        </label>
      </div>

      {search && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-2" data-testid="rarity-search-results">
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
              <div className="flex flex-wrap gap-2" data-testid="rarity-recent">
                {recentRarities.map(chip)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 1 · Printed Rarity — common choices first, rest behind More variants */}
      {!search && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Printed Rarity</span>
            <label className="flex items-center gap-1 text-[10px] text-slate-400">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="rarity-show-all" />
              Show all compatible options
            </label>
          </div>
          <div className="flex flex-wrap gap-2">{quickRarities.map(chip)}</div>
          {moreRarities.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowMore((s) => !s)}
                data-testid="rarity-more"
                className="mt-2 text-[11px] font-semibold text-slate-400 underline hover:text-slate-200"
              >
                {showMore ? "Hide" : "More variants"} ({moreRarities.length})
              </button>
              {showMore && <div className="mt-2 flex flex-wrap gap-2 opacity-90">{moreRarities.map(chip)}</div>}
            </>
          )}
        </div>
      )}

      {/* 2 · Finish / Variant */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Finish / Variant</div>
        <div className="flex flex-wrap gap-2">
          {quickFinishes.map((x) => pill(x, finish === x.value, () => setFinish(finish === x.value ? null : x.value)))}
        </div>
        <button
          type="button"
          onClick={() => setShowMoreFinish((s) => !s)}
          className="mt-2 text-[11px] font-semibold text-slate-400 underline hover:text-slate-200"
        >
          {showMoreFinish ? "Hide" : "More finishes"} ({moreFinishes.length})
        </button>
        {showMoreFinish && (
          <div className="mt-2 flex flex-wrap gap-2 opacity-90">
            {moreFinishes.map((x) => pill(x, finish === x.value, () => setFinish(finish === x.value ? null : x.value)))}
          </div>
        )}
      </div>

      {/* 3 · Promo / Subset */}
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Promo / Subset</div>
        <div className="flex flex-wrap gap-2">
          {quickPromos.map((x) => pill(x, promoOrSubset === x.value, () => setPromoOrSubset(promoOrSubset === x.value ? null : x.value)))}
        </div>
        <button
          type="button"
          onClick={() => setShowMorePromo((s) => !s)}
          className="mt-2 text-[11px] font-semibold text-slate-400 underline hover:text-slate-200"
        >
          {showMorePromo ? "Hide" : "More promos/subsets"} ({morePromos.length})
        </button>
        {showMorePromo && (
          <div className="mt-2 flex flex-wrap gap-2 opacity-90">
            {morePromos.map((x) => pill(x, promoOrSubset === x.value, () => setPromoOrSubset(promoOrSubset === x.value ? null : x.value)))}
          </div>
        )}
      </div>

      {/* Warnings (Phase 9) — soft, non-blocking */}
      {validation.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-2 text-[11px] text-amber-200" data-testid="rarity-warnings">
          {validation.warnings.map((w, i) => (
            <div key={i}>⚠️ {w}</div>
          ))}
        </div>
      )}

      {/* Live preview — each field separate, clearly disclaimed */}
      <div className="rounded-xl border border-amber-800/40 bg-amber-950/10 p-3" data-testid="rarity-preview">
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-300/80">
          Preview only — final label rendering unchanged
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-300 sm:grid-cols-3">
          <div>
            Language: <b className="text-slate-100">{languageByValueOrLabel(structured.language)?.label ?? "—"}</b>
          </div>
          <div>
            Region: <b className="text-slate-100">{structured.region}</b>
          </div>
          <div>
            Era: <b className="text-slate-100">{structured.era ? POKEMON_ERAS.find((e) => e.value === structured.era)?.label : "—"}</b>
          </div>
          <div className="flex items-center gap-1.5">
            Rarity:{" "}
            {rarity ? (
              <>
                <RaritySymbol symbol={rarityByValue(rarity)!.symbol} size={18} />
                <b className="text-slate-100">{rarityByValue(rarity)!.label}</b>
              </>
            ) : (
              <span className="text-slate-500">—</span>
            )}
          </div>
          <div>
            Symbol colour: <b className="text-slate-100">{structured.symbolColour}</b>
          </div>
          <div>
            Finish: <b className="text-slate-100">{structured.finish ? finishByValue(structured.finish)?.label : "—"}</b>
          </div>
          <div>
            Promo: <b className="text-slate-100">{structured.promo ? promoByValue(structured.promo)?.label : "—"}</b>
          </div>
          <div>
            Subset: <b className="text-slate-100">{structured.subset ? promoByValue(structured.subset)?.label : "—"}</b>
          </div>
        </div>
      </div>
    </div>
  );
}
