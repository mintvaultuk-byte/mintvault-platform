/**
 * Review-stage read-only confirmation summary.
 *
 * Pure presentation: every value is passed in from the certificate form's
 * EXISTING state — this component holds no certificate state of its own, makes
 * no network/provider calls, computes no grade, and never mutates. The small
 * "Edit" links only call back to switch the local workflow stage. The card
 * image is NOT rendered here — Review reuses the SAME preview aside as
 * Card Details (certificate-form.tsx renders it for the Review stage too), so this
 * summary only holds the review-details columns and never duplicates the image.
 */
import { RaritySymbol } from "@/components/rarity-picker/RaritySymbol";
import { rarityByValue, finishByValue, promoByValue, POKEMON_ERAS, languageByValueOrLabel } from "@shared/pokemon-rarity-catalogue";
import { formatVariantLine, hasStructuredVariant, CONSOLIDATED_VARIANT_SCHEME } from "@shared/variant-line";
import { getDesignationLabel } from "@/lib/designationOptions";
import { formatCollectorNumber } from "@shared/collector-number-format";

export interface ReviewSummaryValues {
  certificateId: number | null;
  frontFile?: File | null;
  backFile?: File | null;
  cardGame: string;
  cardName: string;
  setName: string;
  cardNumber: string;
  year: string;
  language: string;
  rarityCode: string;
  /** The certificate's STORED scheme version (see VariantSummary). */
  storedVersion?: number | null;
  finishVariant: string;
  promoType: string;
  subsetName: string;
  era: string;
  /** Legacy columns — folded into the printed line only to fill an empty slot. */
  variant?: string;
  rarity?: string;
  variantOther?: string;
  rarityOther?: string;
  designations: string[];
  gradeOverall: string;
  labelType: string;
  status: string;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">{label}</span>
      <span className="min-w-0 truncate text-right text-[12px] text-[var(--admin-ink)]">{value || <span className="text-[var(--admin-ink-faint)]">—</span>}</span>
    </div>
  );
}

function EditLink({ onClick, testId }: { onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/70 hover:text-[var(--admin-gold)]"
    >
      Edit
    </button>
  );
}

function Card({ title, edit, children }: { title: string; edit?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--admin-gold)]/15 bg-[var(--admin-gold)]/[0.02] p-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--admin-gold)]/70">{title}</span>
        {edit}
      </div>
      {children}
    </div>
  );
}

export function ReviewSummary({
  values,
  onEditCard,
  onEditRarity,
  onEditGrade,
}: {
  values: ReviewSummaryValues;
  onEditCard: () => void;
  onEditRarity: () => void;
  onEditGrade: () => void;
}) {
  const v = values;
  const rarity = rarityByValue(v.rarityCode);
  const finish = finishByValue(v.finishVariant);
  const promo = promoByValue(v.promoType);
  const subset = promoByValue(v.subsetName);
  const era = POKEMON_ERAS.find((e) => e.value === v.era);
  const lang = languageByValueOrLabel(v.language);
  const isBlackTen = v.gradeOverall === "10" && v.labelType === "black";
  // Exact single line the front label prints — via the ONE shared formatter.
  const printedVariantLine = formatVariantLine({
    rarityCode: v.rarityCode,
    finishVariant: v.finishVariant,
    promoType: v.promoType,
    subsetName: v.subsetName,
    variant: v.variant,
    rarity: v.rarity,
    variantOther: v.variantOther,
    rarityOther: v.rarityOther,
    // Same canonical rule as the printed label: once anything structured is set,
    // the save stamps the consolidated scheme and the line is structured-ONLY.
    // Same predicate as VariantSummary and the server's clean(): trim first, so
    // a whitespace-only code is not treated as structured data.
    structuredVariantVersion:
      Number((v as { storedVersion?: number | null }).storedVersion ?? 0) >= CONSOLIDATED_VARIANT_SCHEME ||
      hasStructuredVariant({
      rarityCode: v.rarityCode?.trim() || null,
      finishVariant: v.finishVariant?.trim() || null,
      promoType: v.promoType?.trim() || null,
      subsetName: v.subsetName?.trim() || null,
      })
        ? CONSOLIDATED_VARIANT_SCHEME
        : null,
  });

  return (
    <div className="space-y-2" data-testid="review-summary">
      <p className="text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Confirm before saving — nothing is saved until you use Save below.</p>

      {/* Top row: card details · classification. The card image itself is NOT
          rendered here — it lives in the shared preview aside beside this
          panel (the same aside Card Details uses), so it is never duplicated. */}
      <div className="grid gap-2 lg:grid-cols-2">
        <Card title="Card" edit={<EditLink onClick={onEditCard} testId="review-edit-card" />}>
          <div data-testid="review-card-details">
            <Row label="Name" value={v.cardName} />
            <Row label="Game" value={v.cardGame} />
            <Row label="Set" value={v.setName} />
            <Row label="Number" value={formatCollectorNumber(v.cardNumber)} />
            <Row label="Year" value={v.year} />
            <Row label="Language" value={lang?.label ?? v.language} />
          </div>
        </Card>

        <Card title="Classification" edit={<EditLink onClick={onEditRarity} testId="review-edit-rarity" />}>
          <div data-testid="review-classification">
            {/* The exact single line the front label prints (matches the live preview). */}
            <div className="mb-1 flex items-baseline justify-between gap-2 border-b border-[var(--admin-gold)]/10 pb-1">
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Prints as</span>
              <span className="min-w-0 truncate text-right text-[12px] font-bold uppercase text-[var(--admin-gold)]" data-testid="review-variant-printed-line">
                {printedVariantLine || <span className="font-normal normal-case text-[var(--admin-ink-faint)]">—</span>}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Variant</span>
              <span className="flex min-w-0 items-center justify-end gap-1 text-right text-[12px] text-[var(--admin-ink)]">
                {rarity ? (
                  <>
                    <RaritySymbol symbol={rarity.symbol} size={14} />
                    <span className="truncate">{rarity.label}</span>
                  </>
                ) : (
                  <span className="text-[var(--admin-ink-faint)]">—</span>
                )}
              </span>
            </div>
            <Row label="Finish" value={finish?.label} />
            <Row label="Promo" value={promo?.label} />
            <Row label="Subset" value={subset?.label} />
            <Row label="Era" value={era?.label} />
            <Row
              label="Designations"
              value={v.designations.length ? v.designations.map((c) => getDesignationLabel(c)).join(", ") : ""}
            />
          </div>
        </Card>
      </div>

      {/* Second row: grade · status/warnings */}
      <div className="grid gap-2 lg:grid-cols-2">
        <Card title="Grade" edit={<EditLink onClick={onEditGrade} testId="review-edit-grade" />}>
          <div data-testid="review-grade" className="flex items-center gap-2">
            <span className="text-lg font-bold text-[var(--admin-gold)]">
              {v.gradeOverall ? (isBlackTen ? "★ 10" : v.gradeOverall) : "—"}
            </span>
            <span className="text-[11px] text-[var(--admin-ink-dim)]">
              {v.gradeOverall ? (isBlackTen ? "Black Label (Gem Mint)" : "overall — set by MVGS grading") : "Not yet graded"}
            </span>
          </div>
        </Card>

        <Card title="Status">
          <div data-testid="review-status" className="space-y-1">
            <Row label="Status" value={v.status} />
            {!v.gradeOverall && (
              <p className="text-[11px] text-[var(--admin-amber)]" data-testid="review-warning-ungraded">
                No overall grade yet — grade the card in Stage 3 before completing.
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
