/**
 * Make a pdfkit-generated PDF byte-deterministic so that re-rendering the same
 * card yields identical bytes (and therefore a stable export-pack checksum).
 *
 * pdfkit emits two non-deterministic things:
 *   • `/CreationDate` / `/ModDate` in the Info object — wall-clock timestamps.
 *   • the trailer `/ID` — two 32-char hex strings derived partly from the clock.
 * Everything else (including the embedded 600-DPI image stream) is already
 * deterministic. (An earlier byte-diff only caught `/ID` because both renders
 * happened inside the same clock second — the dates matched by luck.)
 *
 * The rewrite is LENGTH-PRESERVING everywhere (14 date digits → 14 fixed digits,
 * 32 hex → 32 hex), so it can never shift a byte offset or invalidate the xref
 * table. `/ID` is set to a value derived from the (date-normalised) document
 * content, so identical cards get identical IDs and distinct cards get distinct
 * ones. If nothing matches, or a rewrite would change the file length, the
 * original buffer is returned untouched. Lives OUTSIDE the locked render engine
 * (server/vault-quest/lib/*) — it never regenerates the PDF.
 */
import { createHash } from "crypto";

// pdfkit stores the date as an indirect object, so match the PDF date STRING
// literal itself — `(D:YYYYMMDDHHmmSS<tz>)` — wherever it lives, not the
// `/CreationDate` key (which is just `N 0 R`). Requiring the full date shape
// (14 digits + optional timezone + closing paren) keeps it from matching random
// bytes in the compressed image; and the rewrite is length-preserving regardless.
const DATE_RE = /\(D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?\)/g;
const ID_RE = /(\/ID \[<)[0-9a-fA-F]{32}(> <)[0-9a-fA-F]{32}(>\])/;
const FIXED_DATE = "20260101000000"; // 14 digits

export function normalizePdf(pdf: Buffer): Buffer {
  const original = pdf.toString("latin1");

  // 1) freeze creation/mod dates (replace only the 14 date digits, same length)
  let text = original.replace(DATE_RE, (full: string) => full.replace(/\d{14}/, FIXED_DATE));

  // 2) content-derived, stable /ID (same length)
  if (ID_RE.test(text)) {
    const blanked = text.replace(ID_RE, (_f, a: string, mid: string, end: string) => a + "0".repeat(32) + mid + "0".repeat(32) + end);
    const id = createHash("sha256").update(blanked, "latin1").digest("hex").slice(0, 32);
    text = text.replace(ID_RE, (_f, a: string, mid: string, end: string) => a + id + mid + id + end);
  }

  if (text === original) return pdf;
  const out = Buffer.from(text, "latin1");
  return out.length === pdf.length ? out : pdf; // never change the file length
}
