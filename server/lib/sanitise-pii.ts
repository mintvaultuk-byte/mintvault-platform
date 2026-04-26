/**
 * PII sanitisers for free-text fields surfaced on public endpoints.
 *
 * Defence-in-depth — most public-facing free-text values (defect descriptions,
 * grade explanations, notes) are AI-generated today and unlikely to contain
 * PII. But admins can edit them via auto-save, and an accidental paste of an
 * email or phone number would otherwise ship publicly. These helpers run on
 * the public endpoint side so admin-side reads still see the original text
 * for review.
 */

// RFC 5322 simplified — matches the common forms without false-positiving on
// "user@domain" without a TLD or on patterns like "@MintVault" handles.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Replace any email addresses in `text` with the literal `[redacted]`.
 * Returns "" for null/undefined/empty input. Idempotent.
 */
export function stripEmailsFromText(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(EMAIL_RE, "[redacted]");
}
