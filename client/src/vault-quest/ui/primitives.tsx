// Vault Quest — form + control primitives (Phase 2 design system).
// Token-driven; must render inside a `.vq-theme` root (VQPage provides it).
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from "react";
import { Search } from "lucide-react";
import { cx } from "./cx";

type BtnVariant = "primary" | "secondary" | "ghost" | "premium";

export function VQButton({
  variant = "secondary",
  type = "button",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant }) {
  return <button type={type} className={cx("vq-btn", `vq-btn--${variant}`, className)} {...props} />;
}

export function VQField({
  label,
  htmlFor,
  children,
}: {
  label?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="vq-field">
      {label && (
        <label className="vq-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

export function VQInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("vq-input", className)} {...props} />;
}

export function VQSelect({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("vq-select", className)} {...props}>
      {children}
    </select>
  );
}

export function VQTextarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("vq-textarea", className)} {...props} />;
}

export function VQBadge({
  tone,
  dot,
  className,
  children,
}: {
  tone?: string;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("vq-badge", tone && `vq-badge--${tone}`, className)}>
      {dot && <span className="vq-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export const VQ_ELEMENTS = [
  "Flame",
  "Water",
  "Nature",
  "Storm",
  "Stone",
  "Shadow",
  "Neutral",
] as const;
export type VQElement = (typeof VQ_ELEMENTS)[number];

export function VQElementBadge({ element }: { element: VQElement }) {
  return (
    <VQBadge tone={element.toLowerCase()} dot>
      {element}
    </VQBadge>
  );
}

export function VQRarityBadge({ rarity }: { rarity: string }) {
  return <VQBadge tone={`rarity-${rarity.toLowerCase()}`}>{rarity}</VQBadge>;
}

export type VQCardStatus = "draft" | "approved" | "published";
export function VQStatusBadge({ status }: { status: VQCardStatus }) {
  return <VQBadge tone={status}>{status}</VQBadge>;
}

export function VQTabs({
  tabs,
  value,
  onChange,
  onNavy,
}: {
  tabs: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  onNavy?: boolean;
}) {
  return (
    <div className={cx("vq-tabs", onNavy && "vq-tabs--on-navy")} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          className={cx("vq-tab", t.id === value && "vq-tab--active")}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function VQSearchBar({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="vq-search">
      <span className="vq-search__icon">
        <Search size={16} aria-hidden="true" />
      </span>
      <VQInput
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Search cards"}
        aria-label="Search"
      />
    </div>
  );
}
