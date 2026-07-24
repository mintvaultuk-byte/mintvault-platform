/**
 * Permanent classification summary shown directly beneath the rarity picker
 * (Rarity stage). Gives the grader an at-a-glance readout of the exact
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
import { formatVariantLine } from "@shared/variant-line";

export interface VariantSummaryValues {
  language?: string;
  rarityCode?: string;
  finishVariant?: string;
  promoType?: string;
  subsetName?: string;
  /** Legacy columns folded into the printed line only to fill an empty slot. */
  variant?: string;
  rarity?: string;
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
  // The exact single line the front label will print — via the ONE shared formatter.
  const printedLine = formatVariantLine({
    rarityCode: values.rarityCode,
    finishVariant: values.finishVariant,
    promoType: values.promoType,
    subsetName: values.subsetName,
    variant: values.variant,
    rarity: values.rarity,
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
        <span className="min-w-0 text-right text-[12px] font-bold text-[var(--admin-gold)]" data-testid="variant-printed-line">
          {printedLine || <span className="font-normal text-[var(--admin-ink-faint)]">—</span>}
        </span>
      </div>
      <Line label="Language">{lang?.label ?? values.language ?? <span className="text-[var(--admin-ink-faint)]">—</span>}</Line>
      <Line label="Rarity">
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
        <p className="pt-0.5 text-[10px] text-[var(--admin-ink-faint)]">No rarity, finish or promo selected yet.</p>
      )}
    </div>
  );
}
