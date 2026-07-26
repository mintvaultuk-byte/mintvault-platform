/**
 * Permanent classification summary shown directly beneath the rarity picker
 * (Variant section of Card Details). Gives the grader an at-a-glance readout of the exact
 * language / rarity / finish / promo / subset they have selected, in the same
 * human-readable catalogue wording used on the Review summary and the public
 * certificate page.
 *
 * Pure presentation: derives its labels from the shared Pokémon rarity
 * catalogue (the single source of truth the picker itself uses). Holds no
 * state, mutates nothing, makes no network calls.
 */
import { RaritySymbol } from "@/components/rarity-picker/RaritySymbol";
import { rarityByValue, finishByValue, promoByValue, languageByValueOrLabel } from "@shared/pokemon-rarity-catalogue";
import { formatVariantLine, hasStructuredVariant, CONSOLIDATED_VARIANT_SCHEME } from "@shared/variant-line";

export interface VariantSummaryValues {
  language?: string;
  rarityCode?: string;
  finishVariant?: string;
  promoType?: string;
  subsetName?: string;
  /** Legacy columns folded into the printed line only to fill an empty slot. */
  variant?: string;
  rarity?: string;
  variantOther?: string;
  rarityOther?: string;
  /** The certificate's STORED scheme version. Once >= 2 the cert is consolidated
   *  and prints structured-only even with everything cleared, so the stored value
   *  must win over "is anything selected right now". */
  storedVersion?: number | null;
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1 text-right text-[12px] font-semibold text-[var(--admin-ink)]">
        {children}
      </span>
    </div>
  );
}

export function VariantSummary({ values }: { values: VariantSummaryValues }) {
  const rarity = rarityByValue(values.rarityCode ?? "");
  const finish = finishByValue(values.finishVariant ?? "");
  const promo = promoByValue(values.promoType ?? "");
  const subset = promoByValue(values.subsetName ?? "");
  const lang = languageByValueOrLabel(values.language ?? "");

  const anySet = rarity || finish || promo || subset;
  // Mirrors the server: validate/clean() trims, so a whitespace-only code is NOT
  // structured data. This is the predicate that decides the printed line's rule.
  const willBeConsolidated = hasStructuredVariant({
    rarityCode: values.rarityCode?.trim() || null,
    finishVariant: values.finishVariant?.trim() || null,
    promoType: values.promoType?.trim() || null,
    subsetName: values.subsetName?.trim() || null,
  });
  // The exact single line the front label will print — via the ONE shared formatter.
  const printedLine = formatVariantLine({
    rarityCode: values.rarityCode,
    finishVariant: values.finishVariant,
    promoType: values.promoType,
    subsetName: values.subsetName,
    variant: values.variant,
    rarity: values.rarity,
    variantOther: values.variantOther,
    rarityOther: values.rarityOther,
    // Show the line the label will print AFTER this save: saving any structured
    // value stamps the consolidated scheme, under which the line is derived ONLY
    // from the structured fields (no legacy fold). With nothing structured set,
    // the save leaves the cert pre-consolidation and the legacy wording stands.
    // Use the SERVER's post-clean() semantics (trim-then-truthy on the raw
    // codes) — NOT catalogue resolution. `anySet` above resolves against the
    // client's SEED catalogue, so a Catalogue-Manager-only code (or a
    // whitespace-only value) would disagree with what the save actually stamps
    // and this line would differ from the printed label.
    // Sticky: an already-consolidated cert stays consolidated even when every
    // field is cleared — otherwise this line would fold legacy wording back in
    // while the printed label (correctly) shows nothing.
    structuredVariantVersion:
      Number(values.storedVersion ?? 0) >= CONSOLIDATED_VARIANT_SCHEME || willBeConsolidated
        ? CONSOLIDATED_VARIANT_SCHEME
        : null,
  });

  return (
    <div
      className="mt-2 rounded-lg border border-[var(--admin-gold)]/15 bg-[var(--admin-gold)]/[0.02] p-2.5"
      data-testid="variant-summary"
    >
      <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--admin-gold)]/70">Selected classification</div>
      {/* The exact wording that prints on the front label (matches the live preview). */}
      <div className="mb-1.5 flex items-baseline justify-between gap-2 border-b border-[var(--admin-gold)]/10 pb-1.5">
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Prints as</span>
        <span className="min-w-0 text-right text-[12px] font-bold uppercase text-[var(--admin-gold)]" data-testid="variant-printed-line">
          {printedLine || <span className="font-normal normal-case text-[var(--admin-ink-faint)]">—</span>}
        </span>
      </div>
      <Line label="Language">{lang?.label ?? values.language ?? <span className="text-[var(--admin-ink-faint)]">—</span>}</Line>
      <Line label="Variant">
        {rarity ? (
          <>
            <RaritySymbol symbol={rarity.symbol} size={14} />
            <span className="truncate">{rarity.label}</span>
          </>
        ) : (
          <span className="text-[var(--admin-ink-faint)]">—</span>
        )}
      </Line>
      <Line label="Finish">{finish?.label ?? <span className="text-[var(--admin-ink-faint)]">—</span>}</Line>
      <Line label="Promo">{promo?.label ?? <span className="text-[var(--admin-ink-faint)]">—</span>}</Line>
      {subset && <Line label="Subset">{subset.label}</Line>}
      {!anySet && (
        <p className="pt-0.5 text-[10px] text-[var(--admin-ink-faint)]">
          No variant, finish or promo selected yet — all optional.
        </p>
      )}
    </div>
  );
}
