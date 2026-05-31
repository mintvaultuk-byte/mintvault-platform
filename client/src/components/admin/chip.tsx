import type { ReactNode } from "react";

/** Filter chip with an optional mono count, per the reference filter rows. */
export default function Chip({
  active = false,
  count,
  onClick,
  children,
  className = "",
  title,
  testId,
}: {
  active?: boolean;
  count?: number | string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={`admin-chip ${active ? "is-on" : ""} ${className}`.trim()}
    >
      {children}
      {count !== undefined && count !== null && <span className="admin-chip__c">{count}</span>}
    </button>
  );
}
