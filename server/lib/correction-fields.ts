/**
 * Shared field-classification for Super Admin Correction Mode.
 *
 * Lives in its own dependency-free module so that the audit WRITE path
 * (server/correction-mode.ts) and every display READ path
 * (server/routes/grader.ts corrections GET, server/grader.ts operator stats)
 * consume one identical list. A previous revision kept three separate copies,
 * which had already drifted: the read filter excluded `privateNotes` (a field
 * that is not correctable and can never appear) while letting `notes` — admin
 * free-text that may reference the customer — through to graders.
 */

/**
 * Fields recorded in the audit row as a bounded SHAPE SUMMARY rather than verbatim,
 * because they hold AI-generated JSON blobs that can be arbitrarily large.
 *
 * They are STILL listed in `changed_fields`. Summarizing is a size control; it must
 * never be used to omit a field the live record actually changed.
 */
export const SUMMARIZED_AUDIT_FIELDS = new Set(["aiDefectCandidates", "labelType"]);

/**
 * Fields that must NEVER be surfaced to a grader/operator in the correction feedback UI,
 * even though they are truthfully recorded in the audit row.
 *
 *  - `notes`             — admin free-text that may reference the customer. Deliberately
 *                          absent from buildCertGradingPayload, so it must not leak here.
 *  - `aiDefectCandidates`/`labelType` — internal AI/label plumbing, stored as a shape
 *                          summary only; meaningless and confusing to an operator.
 *  - `privateNotes`      — not currently correctable; kept as defence-in-depth so that
 *                          adding it to FIELD_TO_COLUMN later cannot silently expose it.
 */
export const CORRECTION_DISPLAY_EXCLUDED_FIELDS = new Set(["notes", "privateNotes", "aiDefectCandidates", "labelType"]);
