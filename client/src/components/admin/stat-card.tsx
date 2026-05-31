import type { ReactNode } from "react";

/**
 * Stat tile. Large display figure by default; `mono` switches to the IBM Plex
 * gold treatment used for technical values (e.g. last cert ID). Optional `icon`
 * sits on the label row (top-right). Optional click handler makes the card a
 * button (preserves the existing drill-down behaviour).
 */
export default function StatCard({
  label,
  value,
  mono = false,
  foot,
  icon,
  onClick,
  className = "",
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  foot?: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  className?: string;
  testId?: string;
}) {
  const clickable = typeof onClick === "function";
  return (
    <div
      className={`admin-stat ${clickable ? "is-clickable" : ""} ${className}`.trim()}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      data-testid={testId}
    >
      <div className="admin-stat__lab">
        <span className="admin-stat__k">{label}</span>
        {icon && <span className="admin-stat__icon">{icon}</span>}
      </div>
      <div className={mono ? "admin-stat__num admin-stat__num--mono" : "admin-stat__num"}>{value}</div>
      {foot && <div className="admin-stat__foot">{foot}</div>}
    </div>
  );
}
