// Vault Quest — loading / empty / error states (Phase 2 design system).
import type { ReactNode } from "react";
import { Inbox, AlertCircle } from "lucide-react";
import { cx } from "./cx";

export function VQLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="vq-state" role="status" aria-live="polite">
      <span className="vq-spinner" aria-hidden="true" />
      <p className="vq-state__msg">{label}…</p>
    </div>
  );
}

export function VQEmptyState({
  title = "Nothing here yet",
  message,
  icon,
  action,
}: {
  title?: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="vq-state">
      <span className="vq-state__icon">{icon ?? <Inbox size={28} aria-hidden="true" />}</span>
      <p className="vq-state__title">{title}</p>
      {message && <p className="vq-state__msg">{message}</p>}
      {action}
    </div>
  );
}

export function VQError({
  title = "Something went wrong",
  message,
  action,
}: {
  title?: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cx("vq-state", "vq-state--error")} role="alert">
      <span className="vq-state__icon">
        <AlertCircle size={28} aria-hidden="true" />
      </span>
      <p className="vq-state__title">{title}</p>
      {message && <p className="vq-state__msg">{message}</p>}
      {action}
    </div>
  );
}
