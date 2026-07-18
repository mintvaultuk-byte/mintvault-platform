/**
 * Shared admin page header row — breadcrumb/title on the left, compact
 * utility actions on the right. One source of truth for the outer row
 * rhythm (gap, alignment, bottom margin) so every admin surface (Staff
 * dashboard, Super Admin dashboard, grading workstation) uses the SAME
 * header geometry even though their content/permissions differ.
 *
 * Pure presentation — no state, no data fetching, no role logic. Callers
 * supply their own left/right content (breadcrumb, nav, action buttons).
 */
import type { ReactNode } from "react";

export function AdminHeaderRow({
  left,
  right,
  testId = "admin-header-row",
}: {
  left: ReactNode;
  right?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="mb-2 flex shrink-0 items-center justify-between gap-2" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-2">{left}</div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}
