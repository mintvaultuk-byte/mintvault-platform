import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Menu, X, Search, HelpCircle, LayoutDashboard } from "lucide-react";

const NAV_LINKS = [
  { label: "Grading",    href: "/pricing" },
  { label: "Technology", href: "/technology" },
  { label: "Registry",   href: "/registry" },
  { label: "Vault Club", href: "/vault-club" },
  { label: "Journal",    href: "/journal" },
];

const UTILITY_LINKS = [
  { label: "Verify", href: "/verify", icon: Search },
  { label: "Help",   href: "/help/faq", icon: HelpCircle },
];

interface AuthMe {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

export default function HeaderV2() {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: authMe } = useQuery<AuthMe | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me");
      if (res.status === 401) return null;
      return res.json();
    },
    retry: false,
    staleTime: 60_000,
  });
  const isAuthed = !!authMe;

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobileOpen]);

  return (
    <>
      <header
        className="sticky top-0 z-50 border-b"
        style={{
          backgroundColor: "var(--v2-paper)",
          borderColor: "var(--v2-line)",
        }}
      >
        <div className="mx-auto max-w-7xl flex items-center justify-between px-6 h-16">
          {/* Logo */}
          <Link href="/" className="flex items-baseline gap-0.5 no-underline">
            <span
              className="font-body text-lg font-bold tracking-tight"
              style={{ color: "var(--v2-ink)" }}
            >
              Mint
            </span>
            <span
              className="text-lg"
              style={{ color: "var(--v2-ink-mute)" }}
            >
              &middot;
            </span>
            <span
              className="font-display italic text-lg font-medium"
              style={{ color: "var(--v2-ink)" }}
            >
              Vault
            </span>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="font-body text-sm font-medium no-underline transition-colors"
                style={{
                  color: location === link.href ? "var(--v2-gold)" : "var(--v2-ink-soft)",
                }}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right side */}
          <div className="flex items-center gap-3 md:gap-4">
            {/* Utility links (Verify, Help) — desktop only */}
            {UTILITY_LINKS.map((link) => {
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="hidden md:inline-flex items-center gap-1.5 font-body text-sm font-medium no-underline transition-colors"
                  style={{ color: "var(--v2-ink-soft)" }}
                  aria-label={link.label}
                >
                  <Icon size={14} />
                  {link.label}
                </Link>
              );
            })}

            {/* Auth-aware: Dashboard if signed-in, Sign in otherwise */}
            {isAuthed ? (
              <Link
                href="/dashboard"
                className="hidden md:inline-flex items-center gap-1.5 font-body text-sm font-medium no-underline transition-colors"
                style={{ color: "var(--v2-ink-soft)" }}
              >
                <LayoutDashboard size={14} />
                Dashboard
              </Link>
            ) : (
              <Link
                href="/login"
                className="hidden md:inline-flex font-body text-sm font-medium no-underline transition-colors"
                style={{ color: "var(--v2-ink-soft)" }}
              >
                Sign in
              </Link>
            )}

            {/* Primary CTA */}
            <Link
              href="/submit"
              className="hidden md:inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-5 py-2 rounded-full transition-colors"
              style={{
                backgroundColor: "var(--v2-ink)",
                color: "var(--v2-paper)",
              }}
            >
              Submit a card
              <ArrowRight size={14} />
            </Link>

            {/* Mobile hamburger */}
            <button
              type="button"
              className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg"
              style={{ color: "var(--v2-ink)" }}
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
            >
              <Menu size={20} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-[100] md:hidden flex flex-col"
          style={{ backgroundColor: "var(--v2-paper)" }}
        >
          {/* Overlay header */}
          <div
            className="flex items-center justify-between px-6 h-16 border-b"
            style={{ borderColor: "var(--v2-line)" }}
          >
            <Link
              href="/"
              className="flex items-baseline gap-0.5 no-underline"
              onClick={() => setMobileOpen(false)}
            >
              <span
                className="font-body text-lg font-bold tracking-tight"
                style={{ color: "var(--v2-ink)" }}
              >
                Mint
              </span>
              <span
                className="text-lg"
                style={{ color: "var(--v2-ink-mute)" }}
              >
                &middot;
              </span>
              <span
                className="font-display italic text-lg font-medium"
                style={{ color: "var(--v2-ink)" }}
              >
                Vault
              </span>
            </Link>
            <button
              type="button"
              className="inline-flex items-center justify-center w-10 h-10 rounded-lg"
              style={{ color: "var(--v2-ink)" }}
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X size={20} />
            </button>
          </div>

          {/* Primary nav */}
          <nav className="flex-1 px-6 py-8 flex flex-col gap-1 overflow-y-auto">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="font-display italic text-3xl py-4 no-underline border-b"
                style={{
                  color: location === link.href ? "var(--v2-gold)" : "var(--v2-ink)",
                  borderColor: "var(--v2-line-soft)",
                }}
              >
                {link.label}
              </Link>
            ))}

            {/* Utility section — smaller, after primary nav */}
            <div className="mt-6 pt-4 border-t" style={{ borderColor: "var(--v2-line)" }}>
              {UTILITY_LINKS.map((link) => {
                const Icon = link.icon;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className="flex items-center gap-3 py-3 font-body text-base no-underline"
                    style={{ color: "var(--v2-ink-soft)" }}
                  >
                    <Icon size={16} />
                    {link.label}
                  </Link>
                );
              })}
              {isAuthed ? (
                <Link
                  href="/dashboard"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 py-3 font-body text-base no-underline"
                  style={{ color: "var(--v2-ink-soft)" }}
                >
                  <LayoutDashboard size={16} />
                  Dashboard
                </Link>
              ) : null}
            </div>
          </nav>

          {/* Bottom CTAs */}
          <div
            className="px-6 py-6 border-t flex flex-col gap-3"
            style={{ borderColor: "var(--v2-line)" }}
          >
            <Link
              href="/submit"
              onClick={() => setMobileOpen(false)}
              className="inline-flex items-center justify-center gap-2 font-body text-sm font-semibold no-underline px-5 py-3 rounded-full"
              style={{ backgroundColor: "var(--v2-ink)", color: "var(--v2-paper)" }}
            >
              Submit a card <ArrowRight size={14} />
            </Link>
            {!isAuthed && (
              <Link
                href="/login"
                onClick={() => setMobileOpen(false)}
                className="inline-flex items-center justify-center font-body text-sm font-medium no-underline px-5 py-3 rounded-full border"
                style={{ borderColor: "var(--v2-line)", color: "var(--v2-ink-soft)" }}
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      )}
    </>
  );
}
