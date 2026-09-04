import { checkPrintableGrade } from "@shared/printable-grade";

/** Mutable facts that must remain true whenever a physical print artifact is
 * created, finalized, or downloaded. Durable command replay can return its
 * immutable result, but stale URLs must not bypass a later grading, deletion,
 * or certificate-validity decision. */
export interface CurrentPrintOutputState {
  gradeType: string | null | undefined;
  gradeOverall: string | number | null | undefined;
  gradeApprovedAt: Date | string | null | undefined;
  graderStatus: string | null | undefined;
  status: string | null | undefined;
  deletedAt: Date | string | null | undefined;
}

export interface PrintOutputBlock {
  certId: string;
  code: string;
  message: string;
}

export function currentPrintOutputBlock(
  certId: string,
  state: CurrentPrintOutputState
): PrintOutputBlock | null {
  if (state.deletedAt) {
    return { certId, code: "cert_deleted", message: `${certId}: certificate is deleted.` };
  }
  if (state.status !== "active") {
    return { certId, code: "cert_not_active", message: `${certId}: certificate is not active (voided).` };
  }
  if (state.graderStatus === "pending_review" || state.graderStatus === "assigned") {
    return {
      certId,
      code: "grade_review_incomplete",
      message:
        state.graderStatus === "pending_review"
          ? `${certId}: grading review is not complete (awaiting approval).`
          : `${certId}: this card is back with the grader for correction.`,
    };
  }
  if (!state.gradeApprovedAt) {
    return { certId, code: "not_approved", message: `${certId}: grade has not been approved.` };
  }
  const printable = checkPrintableGrade({ gradeType: state.gradeType ?? null, gradeOverall: state.gradeOverall ?? null });
  if (!printable.printable) {
    return {
      certId,
      code: printable.reason ?? "unprintable_grade",
      message: `${certId}: ${printable.message ?? "grade is not printable."}`,
    };
  }
  return null;
}
