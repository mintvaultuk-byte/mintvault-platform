/**
 * ONE printability rule for grades, shared by every render and batch path.
 *
 * WHY THIS EXISTS — production incident found 2026-07-25:
 * `POST /api/admin/print-batch` had no grade or approval gate, and the renderer coerced a
 * missing numeric grade to zero (`parseFloat(cert.gradeOverall || "0")`). Because
 * `mvgsTierName(0)` returns "Poor", 22 ungraded production certificates were rendered onto
 * a real 4-page label sheet whose gold grade panel read **0** and **POOR** — a grade no
 * grader ever awarded, on a physical product. `printed_at` is empty for all 22, so whether
 * those sheets were applied to slabs is unknown from the data.
 *
 * The rule, fail-closed:
 *   • a NUMERIC certificate is printable only with a real MVGS ladder grade;
 *   • an AUTHENTICATION-ONLY certificate is printable with no grade — that is its correct
 *     state, and it must never be forced to carry a numeric one;
 *   • a certificate whose kind and grade contradict each other is never printable.
 *
 * Pure: no I/O, no database, no scoring. It decides nothing about WHAT grade a card
 * deserves — only whether what is stored may be printed. MVGS calculation is untouched.
 */
import { isValidNumericGrade } from "./schema";

export type PrintableGradeFailure =
  | "missing_numeric_grade"
  | "malformed_numeric_grade"
  | "off_ladder_numeric_grade"
  | "kind_grade_contradiction";

export interface PrintableGradeVerdict {
  printable: boolean;
  reason?: PrintableGradeFailure;
  /** Operator-facing sentence. Never contains customer data. */
  message?: string;
}

/** The subset of a certificate this rule reads. */
export interface PrintableGradeInput {
  gradeType?: string | null;
  /** Stored overall grade. Drizzle returns `numeric` as a string. */
  gradeOverall?: string | number | null;
}

const NON_NUMERIC_TYPES = new Set(["NO", "AA", "not_original", "authentic_altered"]);

/**
 * Strict parse of a stored grade. Deliberately NOT parseFloat: that is a prefix parser, so
 * "7.5abc" would yield 7.5 and "" would yield NaN which then coerced to 0. Returns null for
 * anything that is not a plain decimal number.
 */
export function parseStoredGrade(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Decide whether this certificate's grade may be printed. */
export function checkPrintableGrade(cert: PrintableGradeInput): PrintableGradeVerdict {
  const gradeType = String(cert.gradeType ?? "numeric").trim() || "numeric";
  const isNonNumeric = NON_NUMERIC_TYPES.has(gradeType);
  const raw = cert.gradeOverall;
  const absent = raw == null || (typeof raw === "string" && raw.trim() === "");

  if (isNonNumeric) {
    // Authentication-only: no grade is the CORRECT state and prints fine (the renderer
    // draws no grade digit for this kind). A stored numeric grade alongside a
    // non-numeric kind is a contradiction — refuse rather than guess which is right.
    if (absent) return { printable: true };
    return {
      reason: "kind_grade_contradiction",
      printable: false,
      message:
        "This certificate is authentication-only but still carries a numeric grade. " +
        "Its grade type and grade contradict each other, so it cannot be printed until that is resolved.",
    };
  }

  // Numeric from here on.
  if (absent) {
    return {
      printable: false,
      reason: "missing_numeric_grade",
      message:
        "This certificate has no grade yet. A numeric certificate cannot be printed until it has been graded — " +
        "printing it would put an invented grade on a physical slab.",
    };
  }
  const n = parseStoredGrade(raw);
  if (n === null) {
    return {
      printable: false,
      reason: "malformed_numeric_grade",
      message: "This certificate's stored grade is not a readable number, so it cannot be printed.",
    };
  }
  if (!isValidNumericGrade(n)) {
    return {
      printable: false,
      reason: "off_ladder_numeric_grade",
      message:
        "This certificate's stored grade is not one of the permitted MVGS grades (1–10, half grades allowed), " +
        "so it cannot be printed.",
    };
  }
  return { printable: true };
}

/** Typed failure thrown by the renderer. Carries the certificate number so an operator
 *  can be told exactly which card blocked a sheet — and nothing about the customer. */
export class UnprintableGradeError extends Error {
  readonly certId: string;
  readonly reason: PrintableGradeFailure;
  constructor(certId: string, verdict: PrintableGradeVerdict) {
    super(`${certId}: ${verdict.message ?? "grade is not printable"}`);
    this.name = "UnprintableGradeError";
    this.certId = certId;
    this.reason = verdict.reason ?? "missing_numeric_grade";
  }
}

/** Throw unless this certificate's grade may be printed. */
export function assertPrintableGrade(cert: PrintableGradeInput & { certId?: string | null }): void {
  const verdict = checkPrintableGrade(cert);
  if (!verdict.printable) throw new UnprintableGradeError(String(cert.certId ?? "certificate"), verdict);
}
