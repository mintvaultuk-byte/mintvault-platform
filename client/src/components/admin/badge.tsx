import type { ReactNode } from "react";

export type AdminBadgeVariant = "act" | "neu" | "prog" | "wait" | "gold" | "red";

/** Status badge — mono uppercase pill. Variants map to the admin status palette. */
export default function Badge({
  variant = "neu",
  children,
  className = "",
  testId,
}: {
  variant?: AdminBadgeVariant;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span className={`admin-badge is-${variant} ${className}`.trim()} data-testid={testId}>
      {children}
    </span>
  );
}
