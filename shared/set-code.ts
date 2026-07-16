/**
 * ONE shared set-code normaliser for the Knowledge Engine.
 *
 * The same logic exists in six older server files (set-library, custom-set-editor,
 * tcgdex-sets-import, tcgdex-set-resolve, public.ts, grader.ts) — they are NOT
 * swapped here because routes/grader.ts sits in the protected grading surface;
 * consolidating those call sites is a logged recommendation. All NEW code must
 * import this copy so the Knowledge Engine can never diverge from itself.
 */
export function normalizeSetCode(code: string | null | undefined): string {
  return String(code ?? "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}
