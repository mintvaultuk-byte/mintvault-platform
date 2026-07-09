// Vault Quest — page shell, panels, neon background (Phase 2 design system).
import type { ReactNode } from "react";
import { cx } from "./cx";

// Wrap any Vault Quest subtree that uses VQ components OUTSIDE a full VQPage
// (e.g. inside the admin studio) so the `.vq-theme` token scope is present.
// Without a `.vq-theme` ancestor, every --vq-* token is undefined and
// components render unstyled.
export function VQThemeRoot({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("vq-theme", className)}>{children}</div>;
}

export function VQNeonBackground() {
  return <div className="vq-neon-bg" aria-hidden="true" />;
}

export function VQPanel({
  variant,
  flush,
  title,
  subtitle,
  className,
  children,
}: {
  variant?: "navy";
  flush?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cx(
        "vq-panel",
        variant === "navy" && "vq-panel--navy",
        flush && "vq-panel--flush",
        className,
      )}
    >
      {title && <h2 className="vq-panel__title">{title}</h2>}
      {subtitle && <p className="vq-panel__sub">{subtitle}</p>}
      {children}
    </section>
  );
}

export function VQPlaytestBadge({ version = "v0.1" }: { version?: string }) {
  return <span className="vq-playtest-badge">Playtest {version} — rules will change</span>;
}

export type VQNavLink = { href: string; label: string; current?: boolean };

// VQ-branded header variant + "by MintVault" parent note + navy neon backdrop.
export function VQPage({
  nav,
  active,
  children,
}: {
  nav?: VQNavLink[];
  active?: string;
  children: ReactNode;
}) {
  return (
    <div className="vq-theme vq-page">
      <VQNeonBackground />
      <header className="vq-header">
        <div className="vq-header__brand">
          <span className="vq-header__wordmark">Vault Quest</span>
          <span className="vq-header__parent">by MintVault</span>
        </div>
        {nav && (
          <nav className="vq-header__nav">
            {nav.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="vq-header__link"
                aria-current={n.current || n.label === active ? "page" : undefined}
              >
                {n.label}
              </a>
            ))}
          </nav>
        )}
      </header>
      <main className="vq-page__body">{children}</main>
      <footer className="vq-footer">
        Vault Quest is an open playtest.{" "}
        <span className="vq-footer__parent">Published by MintVault.</span>
      </footer>
    </div>
  );
}
