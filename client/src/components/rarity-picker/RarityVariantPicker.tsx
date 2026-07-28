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
import { useEffect, useMemo, useRef, useState } from "react";
import {
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
  type RaritySymbol as RaritySymbolMetaType,
} from "@shared/pokemon-rarity-catalogue";
import { validateStructuredVariant } from "@shared/structured-variant-validate";
import { useCatalogue } from "@/hooks/useCatalogue";
import { RaritySymbol } from "./RaritySymbol";

// ── Founder's common choices, REGION-AWARE so Japanese codes don't dominate a
// modern-English card (and vice versa). Everything else is behind More rarities. ──
const QUICK_RARITIES_WESTERN = [
  "common",
  "uncommon",
  "rare",
  "silver_star_rare",
  "double_rare",
  "illustration_rare",
  "ultra_rare",
  "special_illustration_rare",
  "hyper_rare",
  "ace_spec",
];
const QUICK_RARITIES_EASTERN = [
  "common",
  "uncommon",
  "rare",
  "jp_double_rare", // RR
  "jp_triple_rare", // RRR
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
  onControlledChange: ((next: string[]) => void) | undefined
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

// ── "Add missing rarity" — a controlled fallback for a genuine printed rarity
// that isn't in the catalogue yet. It NEVER mutates the shared catalogue or
// requires a schema change: every custom entry stores its stable canonical
// value as CUSTOM_RARITY_VALUE (a real, already-validated POKEMON_RARITIES
// member — see shared/pokemon-rarity-catalogue.ts) and carries its own
// free-text description, which the parent form writes into the certificate's
// EXISTING `rarityOther` metadata column via `onCustomRarityNote`. Distinct
// custom entries are distinguished LOCALLY (by `selectedCustomId`), never by
// the stored value, so several different custom rarities can each be added
// and re-selected without ever touching the database. ──────────────────────
const CUSTOM_RARITY_VALUE = "custom_unlisted";

// Dense, compact grid for rarity tiles — fits significantly more options on
// screen at once than the previous flex-wrap of oversized cards.
const RARITY_TILE_GRID = "grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1";

type CustomSymbolType = "black" | "silver" | "gold" | "text_only" | "no_symbol";
const CUSTOM_SYMBOL_TYPES: { value: CustomSymbolType; label: string }[] = [
  { value: "black", label: "Black" },
  { value: "silver", label: "Silver" },
  { value: "gold", label: "Gold" },
  { value: "text_only", label: "Text-only marker" },
  { value: "no_symbol", label: "No printed symbol" },
];
type CustomCategory = "international" | "japanese" | "promo" | "legacy" | "custom_other";
const CUSTOM_CATEGORIES: { value: CustomCategory; label: string }[] = [
  { value: "international", label: "International" },
  { value: "japanese", label: "Japanese" },
  { value: "promo", label: "Promo" },
  { value: "legacy", label: "Legacy" },
  { value: "custom_other", label: "Custom / Other" },
];

interface CustomRarityEntry {
  id: string;
  displayName: string;
  code: string;
  symbolDescription: string;
  symbolType: CustomSymbolType;
  starCount: number | null;
  category: CustomCategory;
  note: string;
  /** Normalised name+code+symbol key used to prevent duplicate entries. */
  dedupeKey: string;
  /** The exact text written into the certificate's `rarityOther` field on select. */
  composedNote: string;
}

const normCustom = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Map the compact "symbol colour/type" + star count into a real RaritySymbol
 *  for rendering (via the SAME contrast-safe RaritySymbol component). */
function buildCustomSymbol(type: CustomSymbolType, starCount: number | null): RaritySymbolMetaType {
  if (type === "no_symbol") return { shape: "none", colour: "none", glyph: "—" };
  if (type === "text_only") return { shape: "text", colour: "white", glyph: "?" };
  const n = starCount && starCount >= 1 ? Math.min(Math.round(starCount), 3) : 1;
  return { shape: n > 1 ? "stars" : "star", count: n, colour: type, glyph: "★".repeat(n) };
}

function composeCustomNote(entry: {
  displayName: string;
  code: string;
  symbolDescription: string;
  symbolType: CustomSymbolType;
  starCount: number | null;
  category: CustomCategory;
  note: string;
}): string {
  const symbolBit =
    entry.symbolDescription.trim() ||
    (entry.symbolType === "no_symbol"
      ? "no printed symbol"
      : entry.symbolType === "text_only"
        ? "text-only marker"
        : `${entry.starCount && entry.starCount > 1 ? `${entry.starCount} ` : ""}${entry.symbolType} ${entry.starCount === 1 || !entry.starCount ? "star" : "stars"}`);
  const categoryLabel = CUSTOM_CATEGORIES.find((c) => c.value === entry.category)?.label ?? "Custom / Other";
  const parts = [
    `Custom rarity: ${entry.displayName.trim()}${entry.code.trim() ? ` (${entry.code.trim().toUpperCase()})` : ""}`,
    symbolBit,
    `Category: ${categoryLabel}`,
  ];
  if (entry.note.trim()) parts.push(`Note: ${entry.note.trim()}`);
  return parts.join(" — ");
}

/** localStorage-backed list of admin-added custom rarities (this browser only —
 *  no schema change; see the module comment above). */
function useCustomRarities(): [CustomRarityEntry[], (next: CustomRarityEntry[]) => void] {
  const KEY = "mv.customRarities";
  const [list, setList] = useState<CustomRarityEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {
      return [];
    }
  });
  const set = (next: CustomRarityEntry[]) => {
    setList(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
  };
  return [list, set];
}

/**
 * Optional single-select decision for a printed-rarity-symbol click.
 * Clicking the currently-selected catalogue rarity clears it (returns null —
 * rules 3+4: zero selection is valid); any other click selects the clicked
 * value. `hasCustomSelected` short-circuits the toggle so that, when a custom
 * ("Add missing rarity") entry is active, clicking a normal catalogue chip
 * switches to it rather than being read as a same-value toggle. Pure + exported
 * so the single-select contract is unit-testable without a DOM.
 */
export function nextCatalogueRarity(
  current: string | null,
  clicked: string,
  hasCustomSelected: boolean
): string | null {
  return current === clicked && !hasCustomSelected ? null : clicked;
}

export function RarityVariantPicker({
  value,
  onChange,
  legacyVariant,
  favourites: favouritesProp,
  recent: recentProp,
  onFavouritesChange,
  onRecentChange,
  onCustomRarityNote,
}: {
  value?: Partial<StructuredCardVariant> | null;
  onChange?: (v: StructuredCardVariant) => void;
  legacyVariant?: string | null;
  favourites?: string[];
  recent?: string[];
  onFavouritesChange?: (next: string[]) => void;
  onRecentChange?: (next: string[]) => void;
  /** Called with the free-text description whenever a custom ("Add missing
   *  rarity") entry is selected, and with `null` when the grader switches away
   *  from a custom selection to a normal catalogue rarity. The parent writes
   *  this into the certificate's EXISTING `rarityOther` field — no schema
   *  change (see the CUSTOM_RARITY_VALUE comment above). */
  onCustomRarityNote?: (note: string | null) => void;
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
  const [customRarities, setCustomRarities] = useCustomRarities();
  const [selectedCustomId, setSelectedCustomId] = useState<string | null>(null);
  const [showAddRarity, setShowAddRarity] = useState(false);
  const [addForm, setAddForm] = useState({
    displayName: "",
    code: "",
    symbolDescription: "",
    symbolType: "black" as CustomSymbolType,
    starCount: "",
    category: "custom_other" as CustomCategory,
    note: "",
  });
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    setLanguage(languageByValueOrLabel(value?.language)?.value ?? "en");
    setEra((value?.era as PokemonEra) ?? "");
    setRarity(value?.rarity ?? null);
    setFinish(value?.finish ?? null);
    setPromoOrSubset(value?.promo ?? value?.subset ?? null);
    if (value?.rarity !== CUSTOM_RARITY_VALUE) setSelectedCustomId(null);
  }, [value?.language, value?.era, value?.rarity, value?.finish, value?.promo, value?.subset]);

  // Region/era-aware base set; "Show all compatible" drops the era filter so
  // incomplete set data never permanently hides an option (Phase 8).
  // CUSTOM_RARITY_VALUE is excluded from the generic list — it's reachable only
  // via a custom chip (below) or the "Add missing rarity" form, never as a bare
  // unlabelled catalogue entry mixed in with real printed rarities.
  // Live catalogue (DB-backed, seed fallback) — every list below reads from it.
  const cat = useCatalogue();
  const base = useMemo(
    () =>
      filterRarities({ language, era: showAll ? null : era || null }, cat).filter(
        (r) => r.value !== CUSTOM_RARITY_VALUE
      ),
    [language, era, showAll, cat]
  );
  const quickList =
    (languageByValueOrLabel(language, cat)?.region ?? "western") === "western"
      ? QUICK_RARITIES_WESTERN
      : QUICK_RARITIES_EASTERN;
  const quickRarities = useMemo(
    () =>
      quickList
        .map((v) => rarityByValue(v, cat))
        .filter((r): r is PokemonRarity => Boolean(r) && base.some((b) => b.value === r!.value)),
    // quickList derives from `language`, so language stands in for it here.
    [base, language, cat]
  );
  const moreRarities = useMemo(() => {
    const quickSet = new Set(quickRarities.map((r) => r.value));
    const inRegion = base.filter((r) => !quickSet.has(r.value));
    // Everything else in the catalogue (all regions/eras) so nothing is ever
    // permanently hidden when set data is incomplete — region set shown first.
    const otherRegion = cat.rarities.filter(
      (r) => r.value !== CUSTOM_RARITY_VALUE && !quickSet.has(r.value) && !base.some((b) => b.value === r.value)
    );
    return [...inRegion, ...otherRegion];
  }, [base, quickRarities, cat]);

  const search = query.trim() ? searchCatalogue(query, cat) : null;

  const structured = useMemo(
    () => buildStructuredVariant({ language, era: era || null, rarity, finish, promoOrSubset }, cat),
    [language, era, rarity, finish, promoOrSubset, cat]
  );
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const emitSelection = (next: {
    rarity?: string | null;
    finish?: string | null;
    promoOrSubset?: string | null;
    era?: PokemonEra | null;
    language?: string | null;
  }) => {
    onChangeRef.current?.(
      buildStructuredVariant(
        {
          language,
          era: era || null,
          rarity,
          finish,
          promoOrSubset,
          ...next,
        },
        cat,
      ),
    );
  };

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
      }, cat),
    [structured, legacyVariant, cat]
  );

  const pickRarity = (v: string) => {
    // Optional single-select: clicking the already-selected catalogue rarity
    // clears it (rules 3 + 4 — zero selection is valid). A custom selection
    // (rarity === CUSTOM_RARITY_VALUE, tracked by selectedCustomId) is never a
    // catalogue `v`, so this only toggles the same catalogue chip off.
    if (nextCatalogueRarity(rarity, v, !!selectedCustomId) === null) {
      setRarity(null);
      emitSelection({ rarity: null });
      return;
    }
    setRarity(v);
    setRecent(addRecent(recent, v));
    // Switching to a normal catalogue rarity leaves any previous custom note
    // behind — only clear it if THIS picker actually set one, so an unrelated
    // pre-existing rarityOther value (from a different flow) is never touched.
    if (v !== CUSTOM_RARITY_VALUE && selectedCustomId) {
      setSelectedCustomId(null);
      onCustomRarityNote?.(null);
    }
    emitSelection({ rarity: v });
  };

  const pickCustomRarity = (entry: CustomRarityEntry) => {
    // Clicking the already-selected custom rarity clears it (same toggle rule).
    if (rarity === CUSTOM_RARITY_VALUE && selectedCustomId === entry.id) {
      setRarity(null);
      setSelectedCustomId(null);
      onCustomRarityNote?.(null);
      emitSelection({ rarity: null });
      return;
    }
    setRarity(CUSTOM_RARITY_VALUE);
    setSelectedCustomId(entry.id);
    setRecent(addRecent(recent, CUSTOM_RARITY_VALUE));
    onCustomRarityNote?.(entry.composedNote);
    emitSelection({ rarity: CUSTOM_RARITY_VALUE });
  };

  // Explicit "No rarity" — deliberately deselects the rarity (rarity optional;
  // zero selection is valid). Finish + promo are independent and left untouched.
  const clearRarity = () => {
    setRarity(null);
    setSelectedCustomId(null);
    onCustomRarityNote?.(null);
    emitSelection({ rarity: null });
  };

  // Explicit "No finish" / "No promo" — the same deliberate, always-visible
  // affordance rarity already had. Toggling the selected pill still works, but
  // a selection living inside the collapsed "More finishes"/"More promos" list
  // was invisible AND unreachable, and a finish picked from search had no
  // toggle at all — so an operator could see "· Glitter Holo" in the summary
  // with no way to remove it. Each clear touches ONLY its own field: rarity,
  // finish and promo/subset are independent, and zero selection is valid for
  // all three (promo-only is a legitimate saved state).
  const clearFinish = () => {
    setFinish(null);
    emitSelection({ finish: null });
  };
  const clearPromo = () => {
    setPromoOrSubset(null);
    emitSelection({ promoOrSubset: null });
  };
  const pickFinish = (value: string | null) => {
    setFinish(value);
    emitSelection({ finish: value });
  };
  const pickPromoOrSubset = (value: string | null) => {
    setPromoOrSubset(value);
    emitSelection({ promoOrSubset: value });
  };
  const pickEra = (value: PokemonEra | "") => {
    setEra(value);
    emitSelection({ era: value || null });
  };

  function resetAddForm() {
    setAddForm({
      displayName: "",
      code: "",
      symbolDescription: "",
      symbolType: "black",
      starCount: "",
      category: "custom_other",
      note: "",
    });
    setAddError(null);
  }

  function submitAddRarity() {
    const displayName = addForm.displayName.trim();
    if (displayName.length < 2) {
      setAddError("Enter a display name (at least 2 characters).");
      return;
    }
    const code = addForm.code.trim().toUpperCase();
    const starCount = addForm.starCount.trim() ? Math.max(1, Math.min(5, parseInt(addForm.starCount, 10) || 1)) : null;
    const dedupeKey = [normCustom(displayName), normCustom(code), addForm.symbolType, String(starCount ?? "")].join(
      "|"
    );
    // Prevent accidental duplicates: same normalised name + code + symbol
    // combination re-selects the EXISTING entry instead of creating a new one.
    const existing = customRarities.find((c) => c.dedupeKey === dedupeKey);
    if (existing) {
      pickCustomRarity(existing);
      setShowAddRarity(false);
      resetAddForm();
      return;
    }
    const base = {
      displayName,
      code,
      symbolDescription: addForm.symbolDescription.trim(),
      symbolType: addForm.symbolType,
      starCount,
      category: addForm.category,
      note: addForm.note.trim(),
    };
    const entry: CustomRarityEntry = {
      id: `custom-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      dedupeKey,
      composedNote: composeCustomNote(base),
      ...base,
    };
    setCustomRarities([...customRarities, entry]);
    pickCustomRarity(entry);
    setShowAddRarity(false);
    resetAddForm();
  }

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
        title={`${rr.label} — ${rr.description}`}
        data-testid={`rarity-chip-${rr.value}`}
        className={`group relative flex min-h-[28px] min-w-0 items-center gap-1 rounded-md border px-1 py-0.5 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-amber-300 ${
          selected
            ? "border-amber-400 bg-amber-500/25 ring-2 ring-amber-400 shadow-[0_0_0_1px_rgba(251,191,36,0.35)]"
            : "border-slate-700 bg-slate-900/60 hover:border-amber-400/50 hover:bg-slate-800/70"
        }`}
      >
        <RaritySymbol symbol={rr.symbol} size={20} />
        {/* Code prominent, readable name beneath (beginner-friendly, matches the
            workstation reference: "IR" over "Illustration Rare"). */}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[11px] font-bold uppercase tracking-wide text-slate-100">
            {rr.codes[0] || rr.label}
          </span>
          <span className="truncate text-[9px] font-normal text-slate-400">{rr.label}</span>
        </span>
        <span
          role="button"
          tabIndex={-1}
          aria-label={fav ? `Remove ${rr.label} from favourites` : `Add ${rr.label} to favourites`}
          onClick={(e) => {
            e.stopPropagation();
            setFavourites(toggleFavourite(favourites, rr.value));
          }}
          className={`absolute right-1 top-0.5 text-[10px] ${fav ? "text-amber-400" : "text-slate-700 opacity-0 group-hover:opacity-100 hover:text-slate-400"}`}
        >
          {fav ? "★" : "☆"}
        </span>
      </button>
    );
  };

  /** Chip for an admin-added custom rarity. Same visual language as `chip()`,
   *  but selection is tracked by `selectedCustomId` (not the shared
   *  CUSTOM_RARITY_VALUE, which every custom entry stores) so distinct custom
   *  entries never appear selected together. */
  const customChip = (entry: CustomRarityEntry) => {
    const selected = rarity === CUSTOM_RARITY_VALUE && selectedCustomId === entry.id;
    const symbol = buildCustomSymbol(entry.symbolType, entry.starCount);
    const aria = `${entry.displayName} — custom rarity — ${describeSymbol(symbol)}`;
    return (
      <button
        key={entry.id}
        type="button"
        aria-pressed={selected}
        aria-label={aria}
        onClick={() => pickCustomRarity(entry)}
        title={entry.composedNote}
        data-testid={`rarity-chip-custom-${entry.id}`}
        className={`group relative flex min-h-[28px] min-w-0 items-center gap-1 rounded-md border px-1 py-0.5 text-left transition outline-none focus-visible:ring-2 focus-visible:ring-amber-300 ${
          selected
            ? "border-amber-400 bg-amber-500/25 ring-2 ring-amber-400 shadow-[0_0_0_1px_rgba(251,191,36,0.35)]"
            : "border-dashed border-slate-600 bg-slate-900/60 hover:border-amber-400/50 hover:bg-slate-800/70"
        }`}
      >
        <RaritySymbol symbol={symbol} size={20} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[11px] font-bold uppercase tracking-wide text-slate-100">
            {entry.code || entry.displayName}
          </span>
          <span className="truncate text-[9px] font-normal text-slate-400">{entry.displayName}</span>
        </span>
      </button>
    );
  };

  // Resolve against the live catalogue, falling back to the seed so a stored
  // rarity that a founder has since disabled/archived still resolves for display
  // (never a null-assertion crash — see the render blocks below).
  const selectedRarity = rarity ? rarityByValue(rarity, cat) ?? rarityByValue(rarity) : undefined;
  const selectedCustom = selectedCustomId ? customRarities.find((c) => c.id === selectedCustomId) : undefined;

  const pill = <T extends { value: string; label: string; description?: string }>(
    item: T,
    active: boolean,
    onPick: () => void
  ) => (
    <button
      key={item.value}
      type="button"
      aria-pressed={active}
      onClick={onPick}
      title={item.description}
      data-testid={`pill-${item.value}`}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ${
        active
          ? "border-emerald-400 bg-emerald-500/25 text-emerald-100 ring-1 ring-emerald-400/60"
          : "border-slate-700 bg-slate-900/60 text-slate-300 hover:border-emerald-400/50 hover:bg-slate-800/70"
      }`}
    >
      {item.label}
    </button>
  );

  const favouriteRarities = favourites.map((v) => rarityByValue(v, cat)).filter(Boolean) as PokemonRarity[];
  const recentRarities = recent.map((v) => rarityByValue(v, cat)).filter(Boolean) as PokemonRarity[];

  const quickFinishes = cat.finishes.filter((f) => QUICK_FINISHES.includes(f.value));
  const moreFinishes = cat.finishes.filter((f) => !QUICK_FINISHES.includes(f.value));
  const quickPromos = cat.promos.filter((p) => QUICK_PROMOS.includes(p.value));
  const morePromos = cat.promos.filter((p) => !QUICK_PROMOS.includes(p.value));

  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4" data-testid="rarity-picker">
      {/* Language is parent-owned; this picker consumes it only as a catalogue filter. */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Set era</span>
          <select
            value={era}
            onChange={(e) => pickEra(e.target.value as PokemonEra | "")}
            data-testid="rarity-era"
            className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          >
            <option value="">Any era</option>
            {cat.eras.map((x) => (
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

      {/* Rarity is optional — an explicit clear so an operator can deliberately
          set "no rarity" (persisted), independent of finish/promo. Clicking the
          selected rarity chip also toggles it off. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Rarity (optional)</span>
        <button
          type="button"
          onClick={clearRarity}
          disabled={!rarity}
          data-testid="rarity-clear"
          title="Clear the rarity selection (finish and promo are kept)"
          className="rounded-md border border-dashed border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-amber-400/60 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          No rarity — clear
        </button>
      </div>

      {search && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-2" data-testid="rarity-search-results">
          <div className="mb-1 text-[11px] font-semibold text-slate-400">Search results</div>
          <div className={RARITY_TILE_GRID}>{search.rarities.map(chip)}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {/* Toggle-to-clear here too — a finish/promo picked FROM SEARCH was
                previously unclearable from the search results (plain set, no
                toggle), which is how a selection could get stuck. */}
            {search.finishes.map((x) => pill(x, finish === x.value, () => pickFinish(finish === x.value ? null : x.value)))}
            {search.promos.map((x) =>
              pill(x, promoOrSubset === x.value, () => pickPromoOrSubset(promoOrSubset === x.value ? null : x.value))
            )}
          </div>
        </div>
      )}

      {(favouriteRarities.length > 0 || recentRarities.length > 0) && !search && (
        <div className="space-y-2">
          {favouriteRarities.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-amber-300/80">★ Favourites</div>
              <div className={RARITY_TILE_GRID}>{favouriteRarities.map(chip)}</div>
            </div>
          )}
          {recentRarities.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-slate-400">Recently used</div>
              <div className={RARITY_TILE_GRID} data-testid="rarity-recent">
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
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              Choose the symbol printed on the card
            </span>
            <label className="flex items-center gap-1 text-[10px] text-slate-400">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                data-testid="rarity-show-all"
              />
              Show all options
            </label>
          </div>
          <div className={RARITY_TILE_GRID}>{quickRarities.map(chip)}</div>
          {customRarities.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                Custom / added by you
              </div>
              <div className={RARITY_TILE_GRID} data-testid="rarity-custom-list">
                {customRarities.map(customChip)}
              </div>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {moreRarities.length > 0 && (
              <button
                type="button"
                onClick={() => setShowMore((s) => !s)}
                data-testid="rarity-more"
                className="text-[11px] font-semibold text-slate-400 underline hover:text-slate-200"
              >
                {showMore ? "Hide" : "More rarities"} ({moreRarities.length})
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                resetAddForm();
                setShowAddRarity(true);
              }}
              data-testid="button-add-missing-rarity"
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-300 outline-none transition hover:border-amber-400/60 hover:text-amber-200 focus-visible:ring-2 focus-visible:ring-amber-300"
            >
              + Add missing rarity
            </button>
          </div>
          {showMore && <div className={`mt-2 opacity-90 ${RARITY_TILE_GRID}`}>{moreRarities.map(chip)}</div>}
          {/* Selected-item info line — the description lives here, not on every
              tile, and is never truncated so long descriptions stay readable. */}
          {selectedRarity && selectedRarity.value === CUSTOM_RARITY_VALUE && selectedCustom ? (
            <div
              className="mt-2 flex items-start gap-2 rounded-lg border border-amber-800/40 bg-amber-950/10 px-2 py-1.5"
              data-testid="rarity-selected-info"
            >
              <RaritySymbol symbol={buildCustomSymbol(selectedCustom.symbolType, selectedCustom.starCount)} size={18} />
              <span className="text-[11px] leading-tight text-slate-300">
                <b className="text-slate-100">{selectedCustom.displayName}</b>
                {selectedCustom.code ? ` (${selectedCustom.code})` : ""} — {selectedCustom.composedNote}
              </span>
            </div>
          ) : (
            selectedRarity && (
              <div
                className="mt-2 flex items-start gap-2 rounded-lg border border-amber-800/40 bg-amber-950/10 px-2 py-1.5"
                data-testid="rarity-selected-info"
              >
                <RaritySymbol symbol={selectedRarity.symbol} size={18} />
                <span className="text-[11px] leading-tight text-slate-300">
                  <b className="text-slate-100">{selectedRarity.label}</b>
                  {selectedRarity.codes[0] ? ` (${selectedRarity.codes.join("/")})` : ""} — {selectedRarity.description}
                </span>
              </div>
            )
          )}
        </div>
      )}

      {/* 2 · Finish / Variant */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Choose the finish (optional)</span>
          <button
            type="button"
            onClick={clearFinish}
            disabled={!finish}
            data-testid="finish-clear"
            title="Clear the finish selection (rarity and promo are kept)"
            className="rounded-md border border-dashed border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-amber-400/60 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            No finish — clear
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {quickFinishes.map((x) => pill(x, finish === x.value, () => pickFinish(finish === x.value ? null : x.value)))}
        </div>
        {/* A finish chosen from search or the collapsed "more" list must never be
            invisible — surface it inline so the operator can always see (and
            toggle off) what is actually selected. */}
        {finish && !quickFinishes.some((f) => f.value === finish) && !showMoreFinish && (
          <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="finish-selected-outside-quick">
            {moreFinishes
              .filter((f) => f.value === finish)
              .map((x) => pill(x, true, () => pickFinish(null)))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowMoreFinish((s) => !s)}
          className="mt-2 text-[11px] font-semibold text-slate-400 underline hover:text-slate-200"
        >
          {showMoreFinish ? "Hide" : "More finishes"} ({moreFinishes.length})
        </button>
        {showMoreFinish && (
          <div className="mt-2 flex flex-wrap gap-2 opacity-90">
            {moreFinishes.map((x) => pill(x, finish === x.value, () => pickFinish(finish === x.value ? null : x.value)))}
          </div>
        )}
      </div>

      {/* 3 · Promo / Subset */}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Does the card have a promo or gallery mark? (optional)
          </span>
          <button
            type="button"
            onClick={clearPromo}
            disabled={!promoOrSubset}
            data-testid="promo-clear"
            title="Clear the promo/subset selection (rarity and finish are kept)"
            className="rounded-md border border-dashed border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-300 transition hover:border-amber-400/60 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            No promo — clear
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {quickPromos.map((x) =>
            pill(x, promoOrSubset === x.value, () => pickPromoOrSubset(promoOrSubset === x.value ? null : x.value))
          )}
        </div>
        {/* Same visibility guarantee as finish: a promo/subset selected from the
            collapsed list stays visible and toggleable. */}
        {promoOrSubset && !quickPromos.some((p) => p.value === promoOrSubset) && !showMorePromo && (
          <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="promo-selected-outside-quick">
            {morePromos
              .filter((p) => p.value === promoOrSubset)
              .map((x) => pill(x, true, () => pickPromoOrSubset(null)))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowMorePromo((s) => !s)}
          className="mt-2 text-[11px] font-semibold text-slate-400 underline hover:text-slate-200"
        >
          {showMorePromo ? "Hide" : "More promos/subsets"} ({morePromos.length})
        </button>
        {showMorePromo && (
          <div className="mt-2 flex flex-wrap gap-2 opacity-90">
            {morePromos.map((x) =>
              pill(x, promoOrSubset === x.value, () => pickPromoOrSubset(promoOrSubset === x.value ? null : x.value))
            )}
          </div>
        )}
      </div>

      {/* Warnings (Phase 9) — soft, non-blocking */}
      {validation.warnings.length > 0 && (
        <div
          className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-2 text-[11px] text-amber-200"
          data-testid="rarity-warnings"
        >
          {validation.warnings.map((w, i) => (
            <div key={i}>⚠️ {w}</div>
          ))}
        </div>
      )}

      {/* Compact one-line summary + expandable details, clearly disclaimed */}
      <div className="rounded-lg border border-amber-800/40 bg-amber-950/10 px-2.5 py-1.5" data-testid="rarity-preview">
        <div
          className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-200"
          data-testid="rarity-preview-line"
        >
          <span>{languageByValueOrLabel(structured.language, cat)?.label ?? "—"}</span>
          {structured.era && <span>· {cat.eras.find((e) => e.value === structured.era)?.label}</span>}
          {rarity && selectedRarity && (
            <span className="inline-flex items-center gap-1">
              · <RaritySymbol symbol={selectedRarity.symbol} size={14} /> {selectedRarity.label}
            </span>
          )}
          {rarity && !selectedRarity && <span>· {rarity}</span>}
          <span>· {structured.finish ? finishByValue(structured.finish, cat)?.label : "No finish"}</span>
          <span>
            ·{" "}
            {structured.promo
              ? promoByValue(structured.promo, cat)?.label
              : structured.subset
                ? promoByValue(structured.subset, cat)?.label
                : "No promo"}
          </span>
        </div>
        <div className="mt-0.5 text-[9px] uppercase tracking-wide text-amber-300/60">
          Preview only — printed label unchanged
        </div>
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] text-slate-400 hover:text-slate-200">View details</summary>
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-300 sm:grid-cols-3">
            <div>
              Language: <b className="text-slate-100">{languageByValueOrLabel(structured.language, cat)?.label ?? "—"}</b>
            </div>
            <div>
              Region: <b className="text-slate-100">{structured.region}</b>
            </div>
            <div>
              Era:{" "}
              <b className="text-slate-100">
                {structured.era ? cat.eras.find((e) => e.value === structured.era)?.label : "—"}
              </b>
            </div>
            <div className="flex items-center gap-1.5">
              Rarity:{" "}
              {rarity && selectedRarity ? (
                <>
                  <RaritySymbol symbol={selectedRarity.symbol} size={18} />
                  <b className="text-slate-100">{selectedRarity.label}</b>
                </>
              ) : rarity ? (
                <b className="text-slate-100">{rarity}</b>
              ) : (
                <span className="text-slate-500">—</span>
              )}
            </div>
            <div>
              Symbol colour: <b className="text-slate-100">{structured.symbolColour}</b>
            </div>
            <div>
              Finish:{" "}
              <b className="text-slate-100">{structured.finish ? finishByValue(structured.finish, cat)?.label : "—"}</b>
            </div>
            <div>
              Promo: <b className="text-slate-100">{structured.promo ? promoByValue(structured.promo, cat)?.label : "—"}</b>
            </div>
            <div>
              Subset:{" "}
              <b className="text-slate-100">{structured.subset ? promoByValue(structured.subset, cat)?.label : "—"}</b>
            </div>
          </div>
        </details>
      </div>

      {/* "Add missing rarity" — compact controlled form (spec: never uncontrolled
          free-text corruption of the standard taxonomy). Every field is a
          bounded input/select; the composed result is stored via the stable
          CUSTOM_RARITY_VALUE + a free-text note (see the module comment above). */}
      {showAddRarity && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowAddRarity(false)}
          data-testid="add-missing-rarity-modal"
        >
          <div
            className="w-full max-w-sm space-y-3 rounded-xl border border-slate-700 bg-slate-950 p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-100">Add missing rarity</p>
              <button
                type="button"
                onClick={() => setShowAddRarity(false)}
                className="text-slate-400 hover:text-slate-200"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="text-[10px] text-slate-400">
              For a genuine printed rarity that isn’t in the list yet. This does not change the standard taxonomy — it
              stores your description alongside the certificate.
            </p>

            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Display name *</span>
              <input
                type="text"
                value={addForm.displayName}
                onChange={(e) => setAddForm((f) => ({ ...f, displayName: e.target.value }))}
                placeholder="e.g. Full Art Secret Rare"
                data-testid="add-rarity-display-name"
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Short code</span>
                <input
                  type="text"
                  value={addForm.code}
                  onChange={(e) => setAddForm((f) => ({ ...f, code: e.target.value }))}
                  placeholder="e.g. FAS"
                  data-testid="add-rarity-code"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Stars (if any)</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={addForm.starCount}
                  onChange={(e) => setAddForm((f) => ({ ...f, starCount: e.target.value }))}
                  placeholder="e.g. 1"
                  data-testid="add-rarity-star-count"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
                />
              </label>
            </div>

            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Symbol description
              </span>
              <input
                type="text"
                value={addForm.symbolDescription}
                onChange={(e) => setAddForm((f) => ({ ...f, symbolDescription: e.target.value }))}
                placeholder="e.g. single silver star with a thin outline"
                data-testid="add-rarity-symbol-description"
                className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  Symbol colour/type
                </span>
                <select
                  value={addForm.symbolType}
                  onChange={(e) => setAddForm((f) => ({ ...f, symbolType: e.target.value as CustomSymbolType }))}
                  data-testid="add-rarity-symbol-type"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
                >
                  {CUSTOM_SYMBOL_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Category</span>
                <select
                  value={addForm.category}
                  onChange={(e) => setAddForm((f) => ({ ...f, category: e.target.value as CustomCategory }))}
                  data-testid="add-rarity-category"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
                >
                  {CUSTOM_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Internal note (optional)
              </span>
              <textarea
                value={addForm.note}
                onChange={(e) => setAddForm((f) => ({ ...f, note: e.target.value }))}
                rows={2}
                placeholder="Anything else worth recording for review"
                data-testid="add-rarity-note"
                className="mt-1 w-full resize-none rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-amber-400"
              />
            </label>

            {addError && (
              <p className="text-[11px] text-red-300" data-testid="add-rarity-error">
                {addError}
              </p>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowAddRarity(false)}
                className="rounded-md px-3 py-1.5 text-[11px] font-semibold text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitAddRarity}
                data-testid="add-rarity-submit"
                className="rounded-md border border-amber-400 bg-amber-500/25 px-3 py-1.5 text-[11px] font-bold text-amber-100 hover:bg-amber-500/35"
              >
                Add &amp; select
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
