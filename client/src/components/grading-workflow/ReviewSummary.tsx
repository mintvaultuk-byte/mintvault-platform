/**
 * Stage 4 read-only confirmation summary.
 *
 * Pure presentation: every value is passed in from the certificate form's
 * EXISTING state — this component holds no certificate state of its own, makes
 * no network/provider calls, computes no grade, and never mutates. The small
 * "Edit" links only call back to switch the local workflow stage. It reuses the
 * same read-only CardPreviewPanel used in Card/Rarity for the thumbnails.
 */
import { CardPreviewPanel } from "@/components/grading-workflow/CardPreviewPanel";
import { RaritySymbol } from "@/components/rarity-picker/RaritySymbol";
import { rarityByValue, finishByValue, promoByValue, POKEMON_ERAS, languageByValueOrLabel } from "@shared/pokemon-rarity-catalogue";
import { getDesignationLabel } from "@/lib/designationOptions";

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
  finishVariant: string;
  promoType: string;
  subsetName: string;
  era: string;
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

  return (
    <div className="space-y-2" data-testid="review-summary">
      <p className="text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Confirm before saving — nothing is saved until you use Save below.</p>

      {/* Top row: thumbnails · card details · classification */}
      <div className="grid gap-2 lg:grid-cols-[minmax(150px,26%)_minmax(0,1fr)_minmax(0,1fr)]">
        <Card title="Card image">
          <CardPreviewPanel certificateId={v.certificateId} frontFile={v.frontFile} backFile={v.backFile} />
        </Card>

        <Card title="Card" edit={<EditLink onClick={onEditCard} testId="review-edit-card" />}>
          <div data-testid="review-card-details">
            <Row label="Name" value={v.cardName} />
            <Row label="Game" value={v.cardGame} />
            <Row label="Set" value={v.setName} />
            <Row label="Number" value={v.cardNumber} />
            <Row label="Year" value={v.year} />
            <Row label="Language" value={lang?.label ?? v.language} />
          </div>
        </Card>

        <Card title="Classification" edit={<EditLink onClick={onEditRarity} testId="review-edit-rarity" />}>
          <div data-testid="review-classification">
            <div className="flex items-baseline justify-between gap-2 py-0.5">
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--admin-ink-faint)]">Rarity</span>
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
