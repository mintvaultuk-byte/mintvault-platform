import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Menu, X, ChevronDown, HelpCircle, LayoutDashboard } from "lucide-react";

interface DropdownItem {
  label: string;
  href: string;
}

interface NavItem {
  label: string;
  href?: string;
  dropdown?: DropdownItem[];
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "Grading",
    dropdown: [
      { label: "Pricing",            href: "/pricing" },
      { label: "Grading Scale",      href: "/grading-scale" },
      { label: "Grading Glossary",   href: "/grading-glossary" },
      { label: "Eligible Cards",     href: "/grading/eligible-cards" },
      { label: "How Grading Works",  href: "/technology" },
    ],
  },
  { label: "Vault Club", href: "/vault-club" },
  { label: "Verify",     href: "/verify" },
  { label: "Technology", href: "/technology" },
  { label: "Registry",   href: "/registry" },
  { label: "Journal",    href: "/journal" },
];

const UTILITY_LINKS = [
  { label: "Help", href: "/help/faq", icon: HelpCircle },
];

interface AuthMe {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

// ── Desktop dropdown trigger + panel ─────────────────────────────────────────
function DropdownNavItem({ item, location }: { item: NavItem; location: string }) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  // Close on route change
  useEffect(() => { setOpen(false); }, [location]);

  // Click outside + Escape + ArrowUp/Down navigation
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const current = document.activeElement as HTMLAnchorElement | null;
      const idx = itemRefs.current.findIndex(el => el === current);
      const len = itemRefs.current.length;
      let next = idx;
      if (e.key === "ArrowDown") next = idx < len - 1 ? idx + 1 : 0;
      else                       next = idx > 0      ? idx - 1 : len - 1;
      itemRefs.current[next]?.focus();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleEnter() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }
  function handleLeave() {
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  }

  const isActive = item.dropdown!.some(sub => sub.href === location);

  return (
    <div ref={containerRef} className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 font-body text-sm font-medium transition-colors"
        style={{ color: isActive ? "var(--v2-gold)" : "var(--v2-ink-soft)" }}
      >
        {item.label}
        <ChevronDown
          size={14}
          className="transition-transform duration-150"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>

      {/* Panel — always mounted for CSS fade; pointer-events gate interaction */}
      <div
        role="menu"
        className="absolute left-0 top-full mt-2 rounded-lg overflow-hidden"
        style={{
          width: 280,
          backgroundColor: "var(--v2-paper)",
          border: "1px solid var(--v2-line)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)",
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0)" : "translateY(-4px)",
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 150ms ease, transform 150ms ease",
        }}
      >
        {item.dropdown!.map((sub, i) => {
          const active = location === sub.href;
          return (
            <a
              key={sub.label}
              role="menuitem"
              ref={el => { itemRefs.current[i] = el; }}
              href={sub.href}
              tabIndex={open ? 0 : -1}
              onClick={(e) => {
                e.preventDefault();
                setOpen(false);
                navigate(sub.href);
              }}
              className="block px-5 py-3 font-body text-sm no-underline transition-colors"
              style={{ color: active ? "var(--v2-gold)" : "var(--v2-ink)" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "var(--v2-gold)"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = active ? "var(--v2-gold)" : "var(--v2-ink)"; }}
            >
              {sub.label}
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ── Mobile expandable nav item ───────────────────────────────────────────────
function MobileNavItem({
  item, location, onNavigate,
}: {
  item: NavItem; location: string; onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!item.dropdown) {
    return (
      <Link
        href={item.href!}
        onClick={onNavigate}
        className="font-display italic text-3xl py-4 no-underline border-b block"
        style={{
          color: location === item.href ? "var(--v2-gold)" : "var(--v2-ink)",
          borderColor: "var(--v2-line-soft)",
        }}
      >
        {item.label}
      </Link>
    );
  }

  const activeSub = item.dropdown.some(sub => sub.href === location);

  return (
    <div className="border-b" style={{ borderColor: "var(--v2-line-soft)" }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between py-4"
        style={{ color: activeSub ? "var(--v2-gold)" : "var(--v2-ink)" }}
      >
        <span className="font-display italic text-3xl">{item.label}</span>
        <ChevronDown
          size={20}
          className="transition-transform duration-150"
          style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      </button>
      {expanded && (
        <div className="pl-4 pb-3 flex flex-col gap-1">
          {item.dropdown.map(sub => (
            <Link
              key={sub.label}
              href={sub.href}
              onClick={onNavigate}
              className="font-body text-base py-2 no-underline"
              style={{ color: location === sub.href ? "var(--v2-gold)" : "var(--v2-ink-soft)" }}
            >
              {sub.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────
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
        style={{ backgroundColor: "var(--v2-paper)", borderColor: "var(--v2-line)" }}
      >
        <div className="mx-auto max-w-7xl flex items-center justify-between px-6 h-16">
          {/* Logo */}
          <Link href="/" className="flex items-baseline gap-0.5 no-underline">
            <span className="font-body text-lg font-bold tracking-tight" style={{ color: "var(--v2-ink)" }}>Mint</span>
            <span className="text-lg" style={{ color: "var(--v2-ink-mute)" }}>&middot;</span>
            <span className="font-display italic text-lg font-medium" style={{ color: "var(--v2-ink)" }}>Vault</span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-6">
            {NAV_ITEMS.map(item =>
              item.dropdown
                ? <DropdownNavItem key={item.label} item={item} location={location} />
                : (
                  <Link
                    key={item.label}
                    href={item.href!}
                    className="font-body text-sm font-medium no-underline transition-colors"
                    style={{ color: location === item.href ? "var(--v2-gold)" : "var(--v2-ink-soft)" }}
                  >
                    {item.label}
                  </Link>
                )
            )}
          </nav>

          {/* Utility row */}
          <div className="flex items-center gap-4">
            {UTILITY_LINKS.map(link => {
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

            <Link
              href="/submit"
              className="hidden md:inline-flex items-center gap-2 font-body text-sm font-semibold no-underline px-5 py-2 rounded-full transition-colors"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
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
        <div className="fixed inset-0 z-[100] md:hidden flex flex-col" style={{ backgroundColor: "var(--v2-paper)" }}>
          <div className="flex items-center justify-between px-6 h-16 border-b" style={{ borderColor: "var(--v2-line)" }}>
            <Link href="/" className="flex items-baseline gap-0.5 no-underline" onClick={() => setMobileOpen(false)}>
              <span className="font-body text-lg font-bold tracking-tight" style={{ color: "var(--v2-ink)" }}>Mint</span>
              <span className="text-lg" style={{ color: "var(--v2-ink-mute)" }}>&middot;</span>
              <span className="font-display italic text-lg font-medium" style={{ color: "var(--v2-ink)" }}>Vault</span>
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

          <nav className="flex-1 px-6 py-8 flex flex-col gap-0 overflow-y-auto">
            {NAV_ITEMS.map(item => (
              <MobileNavItem
                key={item.label}
                item={item}
                location={location}
                onNavigate={() => setMobileOpen(false)}
              />
            ))}

            <div className="mt-6 pt-4 border-t" style={{ borderColor: "var(--v2-line)" }}>
              {UTILITY_LINKS.map(link => {
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
              {isAuthed && (
                <Link
                  href="/dashboard"
                  onClick={() => setMobileOpen(false)}
                  className="flex items-center gap-3 py-3 font-body text-base no-underline"
                  style={{ color: "var(--v2-ink-soft)" }}
                >
                  <LayoutDashboard size={16} />
                  Dashboard
                </Link>
              )}
            </div>
          </nav>

          <div className="px-6 py-6 border-t flex flex-col gap-3" style={{ borderColor: "var(--v2-line)" }}>
            <Link
              href="/submit"
              onClick={() => setMobileOpen(false)}
              className="inline-flex items-center justify-center gap-2 font-body text-sm font-semibold no-underline px-5 py-3 rounded-full"
              style={{ backgroundColor: "var(--v2-gold)", color: "var(--v2-panel-dark)" }}
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
