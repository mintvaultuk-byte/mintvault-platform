import React, { useEffect, useState } from "react";
import { PokemonSetPicker } from "@/components/certificate-form";
import { VariantPicker, TcgCardSearch, type TcgCardPick } from "@/components/identity-tools";

/**
 * Guided, AI-first card-identity verification — the SAME presentation the /admin
 * Card stage uses (detected summary + Accept / Search again, with manual "Card
 * Fields" as a collapsed secondary path), reused role-safely for Staff, Grader
 * and Admin Review.
 *
 * PRESENTATION ONLY. It owns no cert state and calls no endpoint directly: every
 * value + mutation handler is passed in by the parent (GradingPanel), which
 * already threads the correct role-safe apiBase and /api/staff/* endpoints. So
 * this component never reaches an admin-only endpoint, and Admin certificate
 * editing / Super Admin correction are not exposed through it.
 *
 * - mode "edit"  (Staff / Grader): guided default + Accept / Search again +
 *   collapsible Card Fields (the existing editable fields + Auto-fill / TCGdex).
 * - mode "review" (Admin Review): read-only detected summary — the authorized
 *   "Edit card identity" path stays on the review page, unchanged.
 * - `locked` (approved / read-only): forces the read-only summary regardless of
 *   mode.
 *
 * The manual fields are collapsed by default (no long form dominating the open
 * state, no summary+editable shown at once) and reset closed whenever the card
 * changes (`resetKey`).
 */
export interface GradingIdentityVerificationProps {
  certId: number;
  certIdStr?: string;
  mode: "edit" | "review";
  locked?: boolean;
  game?: string | null;
  name: string;
  set: string;
  setCode: string;
  number: string;
  year: string;
  variant: string;
  onName: (v: string) => void;
  onSet: (name: string, id?: string) => void;
  onNumber: (v: string) => void;
  onYear: (v: string) => void;
  onVariant: (v: string) => void;
  onAutofill: () => void;
  autofilling?: boolean;
  autofillDisabled?: boolean;
  onSearchAgain: () => void;
  searchBusy?: boolean;
  onCardPick: (c: TcgCardPick) => void;
  onAccept?: () => void;
  /** e.g. "TCGdex confirmed" / "AI suggested" / "Not identified". */
  statusLabel?: string | null;
  statusTone?: "confirmed" | "suggested" | "none";
  /** Changing this (the cert id) resets the manual-open + accepted UI state. */
  resetKey?: string | number;
}

const inputCls =
  "w-full bg-[var(--admin-panel)] border border-[var(--admin-line)] text-[var(--admin-ink)] text-xs rounded px-2 py-1 outline-none focus:border-[var(--admin-gold)]/60 disabled:opacity-60 disabled:cursor-not-allowed";
const lbl = "text-[9px] uppercase tracking-wider text-[var(--admin-ink-dim)]";

function SummaryCell({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <div className={lbl}>{k}</div>
      <div className="truncate text-xs text-[var(--admin-ink)]" title={v}>
        {v || "—"}
      </div>
    </div>
  );
}

export function GradingIdentityVerification(props: GradingIdentityVerificationProps) {
  const { mode, locked, resetKey } = props;
  const readOnly = mode === "review" || !!locked;
  const [manualOpen, setManualOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);

  // Card switch: collapse manual fields + clear accepted so the next card opens
  // in the guided default state, never carrying the previous card's UI state.
  useEffect(() => {
    setManualOpen(false);
    setAccepted(false);
  }, [resetKey]);

  const toneClass =
    props.statusTone === "confirmed"
      ? "text-[var(--admin-green)] border-[var(--admin-green)]/40"
      : props.statusTone === "suggested"
        ? "text-[var(--admin-amber)] border-[var(--admin-amber)]/40"
        : "text-[var(--admin-ink-faint)] border-[var(--admin-line)]";

  return (
    <div
      className="rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel2)] px-3 py-2.5 space-y-2.5"
      data-canonical-section="identity-fields"
      data-testid="section-card-identity"
      data-editable={String(mode === "edit" && !locked)}
      data-identity-guided="true"
      data-manual-open={String(manualOpen)}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="font-mono text-xs text-[var(--admin-gold)]">{props.certIdStr || `#${props.certId}`}</span>
        <div className="flex items-center gap-2">
          {props.statusLabel && (
            <span
              className={`text-[9px] font-bold uppercase tracking-wider rounded border px-2 py-0.5 ${toneClass}`}
              data-testid="identity-status"
            >
              {props.statusLabel}
            </span>
          )}
          <span className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)]">
            Card identity{readOnly ? " · read-only" : accepted ? " · confirmed" : " · verify"}
          </span>
        </div>
      </div>

      {/* Detected summary — the default guided view (never the long form). */}
      <div className="grid grid-cols-3 gap-x-3 gap-y-2" data-testid="identity-summary">
        <SummaryCell k="Card" v={props.name} />
        <SummaryCell k="Set" v={props.set} />
        <SummaryCell k="Number" v={props.number} />
        <SummaryCell k="Year" v={props.year} />
        <SummaryCell k="Variant" v={props.variant} />
        <SummaryCell k="Game" v={props.game || ""} />
      </div>

      {/* Guided actions — Accept / Search again / Card Fields. Hidden when the
          card is read-only (approved) or in review-summary mode. */}
      {!readOnly && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setAccepted(true);
                setManualOpen(false);
                props.onAccept?.();
              }}
              data-testid="btn-identity-accept"
              className="flex-1 min-w-[120px] bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400] text-[11px] font-bold uppercase tracking-wider px-3 py-2 rounded hover:opacity-90"
            >
              {accepted ? "Identity confirmed" : "Accept identity"}
            </button>
            <button
              type="button"
              onClick={props.onSearchAgain}
              disabled={props.searchBusy}
              title="Re-run TCGdex identification on this card (identify only — never grades)"
              data-testid="button-rerun-identify"
              className="border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded hover:bg-[var(--admin-gold)]/10 disabled:opacity-40"
            >
              {props.searchBusy ? "Searching..." : "Search again"}
            </button>
            <button
              type="button"
              onClick={() => setManualOpen((v) => !v)}
              aria-expanded={manualOpen}
              data-testid="btn-identity-card-fields"
              className="border border-[var(--admin-line)] text-[var(--admin-ink-dim)] text-[10px] font-bold uppercase tracking-wider px-3 py-2 rounded hover:text-[var(--admin-ink)]"
            >
              {manualOpen ? "Hide fields" : "Card fields"}
            </button>
          </div>

          {/* Manual editing — collapsed by default; the SAME staff-authorized
              fields + Auto-fill / TCGdex search used before, just secondary. */}
          {manualOpen && (
            <div className="space-y-2 border-t border-[var(--admin-line)] pt-2.5" data-testid="identity-card-fields">
              <PokemonSetPicker
                value={props.set}
                onChange={(name, id) => props.onSet(name, id || "")}
                allowAddSet
                allowEditSet
                createEndpoint="/api/staff/custom-sets"
                prefill={{ setName: props.set, setCode: props.setCode }}
                testId="input-identity-set"
              />
              <div className="grid grid-cols-4 gap-2">
                <label className="flex flex-col gap-0.5 col-span-2">
                  <span className={lbl}>Card name</span>
                  <input
                    type="text"
                    value={props.name}
                    placeholder="Charizard"
                    onChange={(e) => props.onName(e.target.value)}
                    data-testid="input-identity-card-name"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-0.5 col-span-2">
                  <span className={lbl}>Number</span>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={props.number}
                      placeholder="4"
                      onChange={(e) => props.onNumber(e.target.value)}
                      data-testid="input-identity-number"
                      className={inputCls}
                    />
                    <button
                      type="button"
                      onClick={props.onAutofill}
                      disabled={props.autofillDisabled || props.autofilling}
                      title="Auto-fill name / year / variant from the card database (set + number)"
                      data-testid="button-identity-autofill"
                      className="shrink-0 border border-[var(--admin-gold)]/40 text-[var(--admin-gold)] text-[10px] font-bold uppercase px-2 rounded hover:bg-[var(--admin-gold)]/10 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      {props.autofilling ? "..." : "Auto-fill"}
                    </button>
                  </div>
                </label>
                <label className="flex flex-col gap-0.5 col-span-2">
                  <span className={lbl}>Year</span>
                  <input
                    type="text"
                    value={props.year}
                    placeholder="1999"
                    onChange={(e) => props.onYear(e.target.value)}
                    data-testid="input-identity-year"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-0.5 col-span-2">
                  <span className={lbl}>Variant</span>
                  <VariantPicker
                    value={props.variant}
                    onChange={props.onVariant}
                    testId="input-identity-variant"
                    inputClassName={inputCls}
                  />
                </label>
              </div>
              <TcgCardSearch onPick={props.onCardPick} initialQuery={props.name} testId="input-card-search" />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default GradingIdentityVerification;
