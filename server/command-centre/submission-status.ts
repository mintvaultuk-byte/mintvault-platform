import { SUBMISSION_STATUSES, SUBMISSION_STATUS_LABELS } from "@shared/schema";

const KNOWN_SUBMISSION_STATUSES = new Set([
  ...SUBMISSION_STATUSES,
  ...Object.keys(SUBMISSION_STATUS_LABELS),
  // `cancelled` remains a terminal deployed legacy state even though it is no
  // longer a current workflow transition.
  "cancelled",
]);
const TERMINAL_SUBMISSION_STATUSES = new Set(["completed", "shipped", "cancelled"]);

export function summariseCommandCentreSubmissionStatuses(
  rows: ReadonlyArray<{ status: unknown; count: number }>,
): { unknownStatus: boolean; nonTerminal: number } {
  return {
    unknownStatus: rows.some((row) => !KNOWN_SUBMISSION_STATUSES.has(String(row.status))),
    nonTerminal: rows.reduce(
      (total, row) => TERMINAL_SUBMISSION_STATUSES.has(String(row.status)) ? total : total + row.count,
      0,
    ),
  };
}
