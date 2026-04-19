import { Link, useLocation } from "wouter";
import { ArrowRight } from "lucide-react";

const NAV_LINKS = [
  { label: "Grading", href: "/grading" },
  { label: "Technology", href: "/technology" },
  { label: "Registry", href: "/population" },
  { label: "Vault Club", href: "/club" },
  { label: "Journal", href: "/journal" },
];

export default function HeaderV2() {
  const [location] = useLocation();

  return (
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

        {/* Nav */}
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
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="font-body text-sm font-medium no-underline transition-colors"
            style={{ color: "var(--v2-ink-soft)" }}
          >
            Sign in
          </Link>
          <Link
            href="/submit"
            className="inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-5 py-2 rounded-full transition-colors"
            style={{
              backgroundColor: "var(--v2-ink)",
              color: "var(--v2-paper)",
            }}
          >
            Submit a card
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </header>
  );
}
