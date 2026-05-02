/**
 * server/config/consents.ts
 *
 * The literal Vault Club sign-up consent text + a deterministic hash of
 * (TERMS_VERSION :: TEXT). The hash anchors the consent ledger to the
 * exact contractual artefact the user saw — if anyone changes either
 * TERMS_VERSION or the text below, the hash changes, and the next
 * /api/vault-club/checkout request from a stale browser tab will
 * reject with `consent_text_stale`.
 *
 * Why both placeholders are intentionally left unresolved (`{amount}`
 * and `{firstChargeDate}`):
 *   The contract template the user agrees to is the structural one —
 *   "I will be charged £{amount} on {firstChargeDate} after my 14-day
 *   free trial". The resolved values (£9.99 vs £99 depending on
 *   interval; first-charge-date depending on today) are facts derived
 *   from the template, not separate terms. Hashing the template means
 *   one hash works for both monthly and annual choices and doesn't
 *   need to be re-issued at midnight when the trial-end date shifts.
 *   The frontend is free to show a resolved version next to the
 *   checkbox for human readability — the binding artefact is the
 *   template.
 *
 * If the wording below changes for any reason, bump TERMS_VERSION in
 * server/config/legal.ts at the same time. They version together —
 * nobody else changes either value.
 */

import { createHash } from "crypto";
import { TERMS_VERSION } from "./legal";

export const VAULT_CLUB_CONSENT_TEXT = `
I have read and agree to the Vault Club Terms and Privacy Notice.
I understand my membership renews automatically until I cancel,
that I will be charged £{amount} on {firstChargeDate} after my
14-day free trial, and that unused credits remain valid until
the end of my paid period and expire at that point.
`.trim();

export const VAULT_CLUB_CONSENT_TEXT_HASH = createHash("sha256")
  .update(`${TERMS_VERSION}::${VAULT_CLUB_CONSENT_TEXT}`)
  .digest("hex");

/**
 * Public-facing summary used as the checkbox label on /vault-club —
 * the full consent text above is too long to fit next to a checkbox.
 * Renders alongside link tags for the Terms and Privacy Notice. The
 * frontend supplies its own JSX; this constant is the canonical
 * non-link plain-text version.
 */
export const VAULT_CLUB_CONSENT_LABEL =
  "I have read and agree to the Vault Club Terms and Privacy Notice. I understand my membership renews automatically until I cancel.";
