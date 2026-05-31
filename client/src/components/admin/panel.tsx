import type { ReactNode } from "react";

/** Titled container panel. Header (title + optional sub/actions) is optional. */
export default function Panel({
  title,
  sub,
  actions,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const hasHead = title || sub || actions;
  return (
    <section className={`admin-panel ${className}`.trim()}>
      {hasHead && (
        <div className="admin-panel__head">
          <div>
            {title && <div className="admin-panel__title">{title}</div>}
            {sub && <div className="admin-panel__sub">{sub}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
