/**
 * Pure accept/reject logic for the Quick Identify panel — extracted so the
 * suggestion-only safety guarantees are unit-testable without a DOM.
 *
 * Rules (Phase 1 + 4 + 14):
 *   • only fields the provider actually resolved (value != null) are applicable
 *   • a field that would overwrite a non-empty current value needs confirmation
 *   • a conflict (KE-invalid symbol/region/era, or a value not in the catalogue)
 *     is NOT auto-applied and is EXCLUDED from Accept All
 *   • low-confidence + conflict + overwriting fields are NOT preselected
 *   • Accept All copies ONLY validated, non-conflicting, non-overwriting fields
 * Nothing here saves, grades, or submits — it only computes which draft-form
 * fields a click would populate.
 */
import { languageByValueOrLabel } from "./pokemon-rarity-catalogue";
import type { CardIdentificationSuggestionV1, SuggestedField } from "./card-identification";

/** suggestion key → draft-form key + how to render the value into the form. */
export const ACCEPT_FIELD_MAP: { key: keyof CardIdentificationSuggestionV1; formKey: string; toForm?: (v: unknown) => string }[] = [
  { key: "cardName", formKey: "cardName" },
  { key: "setName", formKey: "setName" },
  { key: "collectorNumber", formKey: "cardNumber" },
  { key: "year", formKey: "year" },
  { key: "language", formKey: "language", toForm: (v) => languageByValueOrLabel(String(v))?.label ?? String(v) },
  { key: "era", formKey: "era" },
  { key: "rarityCode", formKey: "rarityCode" },
  { key: "finishVariant", formKey: "finishVariant" },
  { key: "promoType", formKey: "promoType" },
  { key: "subsetName", formKey: "subsetName" },
];

export interface AcceptRow {
  formKey: string;
  suggestedForm: string;
  current: string;
  wouldOverwrite: boolean;
  isConflict: boolean;
  confidence: string;
  finishConfirmation?: string;
  evidence?: string;
  canonicalAlternative?: string;
}

export function buildAcceptRows(s: CardIdentificationSuggestionV1, currentValues: Record<string, string>): AcceptRow[] {
  const rows: AcceptRow[] = [];
  for (const m of ACCEPT_FIELD_MAP) {
    const f = s[m.key] as unknown as SuggestedField<unknown> & { finishConfirmation?: string };
    if (!f || f.value == null) continue; // unknown / not-seen fields stay unset
    const suggestedForm = m.toForm ? m.toForm(f.value) : String(f.value);
    const current = currentValues[m.formKey] ?? "";
    rows.push({
      formKey: m.formKey,
      suggestedForm,
      current,
      wouldOverwrite: current.trim() !== "" && current !== suggestedForm,
      isConflict: f.validationStatus === "conflict" || f.confidence === "conflict",
      confidence: f.confidence,
      finishConfirmation: f.finishConfirmation,
      evidence: f.evidence?.[0]?.summary,
      canonicalAlternative: f.canonicalAlternative != null ? String(f.canonicalAlternative) : undefined,
    });
  }
  return rows;
}

/** Fields Accept All will copy: validated, non-conflicting, non-overwriting. */
export function acceptAllKeys(rows: AcceptRow[]): string[] {
  return rows.filter((r) => !r.isConflict && !r.wouldOverwrite).map((r) => r.formKey);
}

/** Default preselection: skip conflict, low-confidence, and overwriting fields. */
export function defaultSelected(rows: AcceptRow[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.formKey] = !r.isConflict && r.confidence !== "low" && !r.wouldOverwrite;
  return out;
}

/** Values for the chosen form keys — what a click copies into the draft form. */
export function fieldsToApply(rows: AcceptRow[], keys: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const r of rows) if (keys.includes(r.formKey)) fields[r.formKey] = r.suggestedForm;
  return fields;
}
