import type { ButtonHTMLAttributes } from "react";

export type AdminButtonVariant = "ghost" | "gold";
export type AdminButtonSize = "md" | "sm";

/**
 * Build the admin button class string. Exposed so non-<button> elements
 * (e.g. wouter <Link>) can adopt the exact same styling without forking it.
 */
export function adminButtonClass(
  opts: { variant?: AdminButtonVariant; size?: AdminButtonSize; iconOnly?: boolean; className?: string } = {}
): string {
  const { variant = "ghost", size = "md", iconOnly = false, className = "" } = opts;
  return [
    "admin-btn",
    variant === "gold" ? "admin-btn--gold" : "",
    size === "sm" ? "admin-btn--sm" : "",
    iconOnly ? "admin-icon-btn" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

interface AdminButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: AdminButtonVariant;
  size?: AdminButtonSize;
  iconOnly?: boolean;
}

/** Canonical admin button: two variants (ghost / gold), two sizes, icon-only. */
export default function AdminButton({
  variant,
  size,
  iconOnly,
  className,
  type = "button",
  ...rest
}: AdminButtonProps) {
  return <button type={type} className={adminButtonClass({ variant, size, iconOnly, className })} {...rest} />;
}
