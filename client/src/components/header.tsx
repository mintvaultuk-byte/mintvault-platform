// TODO: scheduled for deletion after v2 layout consolidation verified stable in prod (feat/site-layout-consolidation, 2026-04-21)
import React, { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X, ChevronDown, ChevronUp, ExternalLink, User, LogOut, Settings } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import MintVaultWordmark from "@/components/mintvault-wordmark";

// ── Nav structure ─────────────────────────────────────────────────────────────

interface DropdownItem {
  label: string;
  href: string;
  external?: boolean;
  soon?: boolean;
  dividerBefore?: boolean; // thin gold rule above this item
}

interface NavItem {
  label: string;
  href?: string;
  dropdown?: DropdownItem[];
}

const NAV_ITEMS: NavItem[] = [
  { label: "HOME", href: "/" },
  {
    label: "VAULT",
    dropdown: [
      { label: "Find a Vault",          href: "/cert" },
      { label: "Claim Your Ownership",  href: "/claim",     dividerBefore: true },
      { label: "Transfer Ownership",    href: "/transfer" },
      { label: "My Vault Dashboard",    href: "/dashboard" },
      { label: "About Vault Reports",  href: "/vault-reports/about", dividerBefore: true },
      { label: "Sample Vault",         href: "/vault/MV1" },
      { label: "How to Read a Vault",  href: "/vault-reports/how-to-read" },
    ],
  },
  {
    label: "GRADING",
    dropdown: [
      { label: "Pricing & Services",   href: "/pricing" },
      { label: "Submit Cards",         href: "/submit" },
      { label: "Grading Scale",        href: "/grading-scale" },
      { label: "Grading Glossary",     href: "/grading-glossary" },
      { label: "Eligible Cards",       href: "/grading/eligible-cards" },
    ],
  },
  { label: "POP REPORT", href: "/population" },
  { label: "VERIFY", href: "/cert" },
  {
    label: "TOOLS",
    dropdown: [
      { label: "AI Pre-Grade Checker", href: "/tools/estimate" },
    ],
  },
  {
    label: "ABOUT",
    dropdown: [
      { label: "Why MintVault",        href: "/why-mintvault" },
      { label: "How It Works",         href: "/how-it-works" },
      { label: "Our Story",            href: "/about/our-story" },
      { label: "The MintVault Slab",   href: "/about/the-mintvault-slab" },
    ],
  },
  {
    label: "COMMUNITY",
    dropdown: [
      { label: "Instagram",            href: "https://www.instagram.com/mint_vault/", external: true },
      { label: "Facebook Group",       href: "https://www.facebook.com/mintvaultuk", external: true },
      { label: "TikTok",               href: "https://www.tiktok.com/@mintvaultuk",  external: true },
    ],
  },
  {
    label: "HELP",
    dropdown: [
      { label: "Guides & Articles",    href: "/guides" },
      { label: "FAQ",                  href: "/help/faq" },
      { label: "Contact Us",           href: "/help/contact" },
      { label: "Track Submission",     href: "/track" },
    ],
  },
];

// Mobile menu uses a flat list of all items (plus sub-items expanded inline)
const MOBILE_QUICK_LINKS = [
  { label: "Home",                  href: "/" },
  { label: "Find a Vault",          href: "/cert" },
  { label: "Claim Your Ownership",  href: "/claim" },
  { label: "Transfer Ownership",    href: "/transfer" },
  { label: "My Vault Dashboard",    href: "/dashboard" },
  { label: "About Vault Reports",   href: "/vault-reports/about" },
  { label: "Sample Vault",          href: "/vault/MV1" },
  { label: "How to Read a Vault",   href: "/vault-reports/how-to-read" },
  { label: "Pricing",               href: "/pricing",              dividerBefore: true },
  { label: "Submit Cards",          href: "/submit" },
  { label: "Grading Scale",         href: "/grading-scale" },
  { label: "Grading Glossary",      href: "/grading-glossary" },
  { label: "Eligible Cards",        href: "/grading/eligible-cards" },
  { label: "Population Report",     href: "/population",           dividerBefore: true },
  { label: "Verify Certificate",    href: "/cert" },
  { label: "AI Pre-Grade Checker",  href: "/tools/estimate" },
  { label: "Why MintVault",         href: "/why-mintvault",        dividerBefore: true },
  { label: "How It Works",          href: "/how-it-works" },
  { label: "Our Story",             href: "/about/our-story" },
  { label: "The MintVault Slab",    href: "/about/the-mintvault-slab" },
  { label: "Stolen Card Protection", href: "/stolen-card-protection" },
  { label: "Guides & Articles",     href: "/guides",               dividerBefore: true },
  { label: "FAQ",                   href: "/help/faq" },
  { label: "Contact Us",            href: "/help/contact" },
  { label: "Track Submission",      href: "/track" },
  { label: "My Dashboard",          href: "/dashboard",            dividerBefore: true },
  { label: "Account Settings",      href: "/account/settings" },
  { label: "Log In",                href: "/login" },
];

// ── Desktop dropdown item ─────────────────────────────────────────────────────

function DesktopNavItem({
  item,
  isDark,
}: {
  item: NavItem;
  isDark: boolean;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function enter() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (item.dropdown) setOpen(true);
  }
  function leave() {
    closeTimer.current = setTimeout(() => setOpen(false), 90);
  }

  const labelClass = isDark
    ? "text-white/75 hover:text-[#D4AF37]"
    : "text-[#1A1A1A] hover:text-[#B8960C]";

  const inner = (
    <span className={`flex items-center gap-0.5 transition-colors ${labelClass} text-[11px] font-bold uppercase tracking-[0.14em] px-2.5 py-2 cursor-pointer select-none`}>
      {item.label}
      {item.dropdown && (
        <ChevronDown
          size={10}
          className="mt-0.5 transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        />
      )}
    </span>
  );

  return (
    <li className="relative" onMouseEnter={enter} onMouseLeave={leave}>
      {item.href ? (
        <Link href={item.href}>{inner}</Link>
      ) : (
        <div>{inner}</div>
      )}

      {/* Dropdown panel */}
      {item.dropdown && (
        <div
          className="absolute left-0 top-full z-50"
          style={{
            paddingTop: 6,
            minWidth: 220,
            opacity: open ? 1 : 0,
            transform: open ? "translateY(0)" : "translateY(-6px)",
            pointerEvents: open ? "auto" : "none",
            transition: "opacity 0.18s ease, transform 0.18s ease",
          }}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          <div
            style={{
              background: "#0F0F0F",
              borderRadius: 10,
              border: "1px solid rgba(212,175,55,0.18)",
              borderTop: "2px solid #D4AF37",
              boxShadow: "0 16px 48px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,0,0,0.2)",
              overflow: "visible",
            }}
          >
            {item.dropdown.map((sub) => {
              const divider = sub.dividerBefore
                ? (
                  <div style={{ padding: "8px 0" }}>
                    <div style={{
                      height: "1px",
                      backgroundColor: "#D4AF37",
                      opacity: 0.6,
                      margin: "0 16px",
                    }} />
                  </div>
                )
                : null;
              let node: React.ReactNode;
              if (sub.soon) {
                node = (
                  <span
                    className="flex items-center justify-between px-4 py-2.5 cursor-default"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                  >
                    <span className="text-[11px]" style={{ color: "#444" }}>{sub.label}</span>
                    <span className="text-[9px] italic ml-3" style={{ color: "#333" }}>soon</span>
                  </span>
                );
              } else if (sub.external) {
                node = (
                  <a
                    href={sub.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between px-4 py-2.5 group/sub transition-colors"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#999" }}
                    onMouseEnter={e => (e.currentTarget.style.color = "#D4AF37")}
                    onMouseLeave={e => (e.currentTarget.style.color = "#999")}
                  >
                    <span className="text-[11px] font-medium">{sub.label}</span>
                    <ExternalLink size={10} className="opacity-40" />
                  </a>
                );
              } else {
                node = (
                  <Link
                    href={sub.href}
                    className="block px-4 py-2.5 text-[11px] font-medium transition-colors"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#ccc" }}
                    onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
                    onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#ccc")}
                  >
                    {sub.label}
                  </Link>
                );
              }
              return (
                <React.Fragment key={sub.label}>
                  {divider}
                  {node}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </li>
  );
}

// ── User auth menu (utility bar, desktop only) ────────────────────────────────

interface AuthMe {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

function UserMenuButton() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);

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

  const logoutMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout", {}),
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/me"], null);
      navigate("/");
    },
  });

  function enter() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }
  function leave() {
    closeTimer.current = setTimeout(() => setOpen(false), 90);
  }

  if (!authMe) {
    return (
      <div className="flex items-center gap-2">
        <Link
          href="/login"
          className="text-[10px] font-bold uppercase tracking-widest transition-colors"
          style={{ color: "rgba(212,175,55,0.6)" }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(212,175,55,0.6)")}
        >
          Log In
        </Link>
        <Link href="/signup">
          <button
            className="text-[10px] font-bold uppercase tracking-widest text-[#1A1400] px-3 py-1 rounded-md transition-all active:scale-95"
            style={{ background: "#D4AF37" }}
          >
            Sign Up
          </button>
        </Link>
      </div>
    );
  }

  const label = authMe.display_name || authMe.email.split("@")[0];

  return (
    <div ref={ref} className="relative" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors"
        style={{ color: "rgba(212,175,55,0.6)" }}
        onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
        onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(212,175,55,0.6)")}
      >
        <User size={11} />
        {label}
        <ChevronDown size={9} className="mt-0.5" style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.18s ease" }} />
      </button>

      <div
        className="absolute right-0 top-full z-50"
        style={{
          paddingTop: 6,
          minWidth: 180,
          opacity: open ? 1 : 0,
          transform: open ? "translateY(0)" : "translateY(-6px)",
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.18s ease, transform 0.18s ease",
        }}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        <div style={{
          background: "#0F0F0F",
          borderRadius: 10,
          border: "1px solid rgba(212,175,55,0.18)",
          borderTop: "2px solid #D4AF37",
          boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
          overflow: "hidden",
        }}>
          <div className="px-4 py-2.5 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
            <p className="text-[11px] font-bold text-white truncate">{label}</p>
            <p className="text-[10px] text-[#555] truncate mt-0.5">{authMe.email}</p>
          </div>
          <Link href="/dashboard" onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2.5 text-[11px] font-medium transition-colors"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#ccc" }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#ccc")}
          >
            Dashboard
          </Link>
          <Link href="/account/settings" onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-4 py-2.5 text-[11px] font-medium transition-colors"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", color: "#ccc" }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#ccc")}
          >
            <Settings size={11} />
            Account Settings
          </Link>
          <button
            onClick={() => { setOpen(false); logoutMutation.mutate(); }}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-[11px] font-medium transition-colors"
            style={{ color: "#888" }}
            onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#ef4444")}
            onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#888")}
          >
            <LogOut size={11} />
            Log Out
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Utility bar ───────────────────────────────────────────────────────────────

// ── Mobile auth section (top of mobile menu) ─────────────────────────────────

function MobileAuthSection({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

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

  const logoutMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout", {}),
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/me"], null);
      onClose();
      navigate("/");
    },
  });

  if (!authMe) {
    return (
      <div className="px-4 pt-4 pb-3 border-b border-[#E8E4DC] flex items-center gap-3">
        <Link href="/login" onClick={onClose}
          className="flex-1 text-center py-2.5 rounded-xl border border-[#D4AF37]/40 text-[#B8960C] text-sm font-bold transition-colors hover:bg-[#D4AF37]/5"
        >
          Log In
        </Link>
        <Link href="/signup" onClick={onClose}
          className="flex-1 text-center py-2.5 rounded-xl text-sm font-bold text-[#1A1400] transition-all active:scale-95"
          style={{ background: "#D4AF37" }}
        >
          Sign Up
        </Link>
      </div>
    );
  }

  const label = authMe.display_name || authMe.email.split("@")[0];

  return (
    <div className="px-4 pt-4 pb-3 border-b border-[#E8E4DC]">
      <p className="text-xs text-[#999999] mb-2">Signed in as <strong className="text-[#1A1A1A]">{label}</strong></p>
      <div className="flex gap-2">
        <Link href="/dashboard" onClick={onClose}
          className="flex-1 text-center py-2 rounded-lg border border-[#E8E4DC] text-[#444444] text-sm font-semibold hover:bg-[#F5F2EB] transition-colors"
        >
          Dashboard
        </Link>
        <Link href="/account/settings" onClick={onClose}
          className="flex-1 text-center py-2 rounded-lg border border-[#E8E4DC] text-[#444444] text-sm font-semibold hover:bg-[#F5F2EB] transition-colors"
        >
          Settings
        </Link>
        <button
          onClick={() => logoutMutation.mutate()}
          className="px-3 py-2 rounded-lg border border-[#E8E4DC] text-[#999999] text-sm font-semibold hover:text-red-500 hover:border-red-200 transition-colors"
        >
          Log Out
        </button>
      </div>
    </div>
  );
}

function UtilityBar() {
  return (
    <div
      className="hidden md:flex items-center justify-between px-6 py-1.5"
      style={{ background: "#0A0A0A", borderBottom: "1px solid rgba(212,175,55,0.1)" }}
    >
      <div className="flex items-center gap-4">
        <a
          href="/submit"
          className="text-[10px] font-bold uppercase tracking-widest transition-colors"
          style={{ color: "rgba(212,175,55,0.6)" }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(212,175,55,0.6)")}
        >
          Submit for Grading
        </a>
        <span style={{ color: "rgba(212,175,55,0.2)" }}>·</span>
        <a
          href="https://mintvaultuk.com#newsletter"
          className="text-[10px] font-bold uppercase tracking-widest transition-colors"
          style={{ color: "rgba(212,175,55,0.6)" }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(212,175,55,0.6)")}
        >
          Get Email Updates
        </a>
      </div>
      <div className="flex items-center gap-3">
        {/* User auth */}
        <UserMenuButton />
        <span style={{ color: "rgba(212,175,55,0.2)" }}>·</span>
        {/* Instagram */}
        <a href="https://www.instagram.com/mint_vault/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"
          className="transition-colors" style={{ color: "rgba(212,175,55,0.4)" }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(212,175,55,0.4)")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
        </a>
        {/* TikTok */}
        <a href="https://www.tiktok.com/@mintvaultuk" target="_blank" rel="noopener noreferrer" aria-label="TikTok"
          className="transition-colors" style={{ color: "rgba(212,175,55,0.4)" }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(212,175,55,0.4)")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.78 1.52V6.76a4.85 4.85 0 0 1-1.01-.07z"/></svg>
        </a>
        {/* YouTube */}
        <a href="https://www.youtube.com/@mintvaultuk" target="_blank" rel="noopener noreferrer" aria-label="YouTube"
          className="transition-colors" style={{ color: "rgba(212,175,55,0.4)" }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#D4AF37")}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "rgba(212,175,55,0.4)")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
        </a>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function SiteHeader({ heroMode = false }: { heroMode?: boolean }) {
  const [menuOpen, setMenuOpen]     = useState(false);
  const [scrolled, setScrolled]     = useState(false);
  // Mobile accordion state
  const [mobileOpen, setMobileOpen] = useState<string | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isDark = heroMode && !scrolled && !menuOpen;

  // Nav bar background
  const navBg = isDark
    ? "bg-black/30 backdrop-blur-sm border-b border-white/10"
    : "bg-white/96 backdrop-blur-sm border-b border-[#E8E4DC] shadow-[0_1px_12px_rgba(0,0,0,0.06)]";

  return (
    <header className="sticky top-0 z-50">
      {/* Main nav bar */}
      <div className={`transition-all duration-300 ${navBg}`}>
        <div className="flex items-center px-3 md:px-6 py-2.5 max-w-screen-2xl mx-auto gap-2 md:gap-4">

          {/* ── Mobile hamburger (left on mobile) ─────────── */}
          <button
            data-testid="button-menu"
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden p-1 flex-shrink-0"
            style={{ color: isDark ? "rgba(255,255,255,0.8)" : "#B8960C" }}
            aria-label="Menu"
          >
            {menuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>

          {/* ── Logo ──────────────────────────────────────── */}
          <Link href="/" data-testid="link-home" onClick={() => setMenuOpen(false)} className="flex-shrink min-w-0">
            <span className="md:hidden"><MintVaultWordmark size="xs" /></span>
            <span className="hidden md:inline"><MintVaultWordmark size="sm" /></span>
          </Link>

          {/* ── Desktop nav links (center / fill) ─────────── */}
          <nav className="hidden md:flex flex-1 items-center justify-center">
            <ul className="flex items-center">
              {NAV_ITEMS.map((item) => (
                <DesktopNavItem key={item.label} item={item} isDark={isDark} />
              ))}
            </ul>
          </nav>

          {/* ── Desktop CTA: SUBMIT button ────────────────── */}
          <div className="hidden md:flex items-center flex-shrink-0">
            <Link href="/submit">
              <button className="gold-shimmer text-[#1A1400] px-5 py-2 rounded-lg font-black uppercase text-[11px] tracking-widest active:scale-95 transition-transform">
                Submit
              </button>
            </Link>
          </div>

          {/* ── Mobile: SUBMIT button (right side) ────────── */}
          <div className="md:hidden ml-auto flex-shrink-0">
            <Link href="/submit">
              <button className="gold-shimmer text-[#1A1400] px-3 py-1.5 rounded-lg font-bold uppercase text-[10px] tracking-wider active:scale-95 transition-transform">
                Submit
              </button>
            </Link>
          </div>
        </div>
      </div>

      {/* ── Mobile slide-down menu ──────────────────────── */}
      {menuOpen && (
        <nav
          className="md:hidden border-t border-[#E8E4DC] bg-white overflow-y-auto max-h-[80vh]"
          data-testid="nav-mobile-menu"
        >
          {/* Auth section — Log In / Sign Up or user info */}
          <MobileAuthSection onClose={() => setMenuOpen(false)} />

          {/* Quick flat links */}
          <div className="px-4 pt-3 pb-2">
            <p className="text-[9px] font-black uppercase tracking-[0.2em] mb-3" style={{ color: "#D4AF37" }}>
              Navigate
            </p>
            <ul className="space-y-0">
              {MOBILE_QUICK_LINKS.map((link) => (
                <li key={link.href + link.label}>
                  {(link as any).dividerBefore && (
                    <div style={{ padding: "8px 0" }}>
                      <div style={{
                        height: "1px",
                        backgroundColor: "#D4AF37",
                        opacity: 0.6,
                      }} />
                    </div>
                  )}
                  <Link
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    className="block text-[#1A1A1A] py-2.5 text-[15px] border-b border-[#F0EDE6] last:border-0 transition-colors hover:text-[#B8960C]"
                    data-testid={`link-mobile-${link.label.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* External community links */}
          <div className="px-4 pt-2 pb-4 border-t border-[#E8E4DC]">
            <p className="text-[9px] font-black uppercase tracking-[0.2em] mb-3 mt-3" style={{ color: "#D4AF37" }}>
              Community
            </p>
            <ul className="space-y-0">
              {[
                { label: "Instagram", href: "https://www.instagram.com/mint_vault/" },
                { label: "TikTok",    href: "https://www.tiktok.com/@mintvaultuk" },
                { label: "YouTube",   href: "https://www.youtube.com/@mintvaultuk" },
                { label: "Facebook",  href: "https://www.facebook.com/mintvaultuk" },
              ].map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between py-2.5 text-[15px] border-b border-[#F0EDE6] last:border-0 text-[#666666] hover:text-[#B8960C] transition-colors"
                  >
                    {link.label}
                    <ExternalLink size={12} className="opacity-40" />
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Submit CTA at bottom of mobile menu */}
          <div className="px-4 pb-6">
            <Link href="/submit" onClick={() => setMenuOpen(false)}>
              <button className="gold-shimmer w-full text-[#1A1400] py-4 rounded-xl font-black uppercase text-sm tracking-widest">
                Submit Cards
              </button>
            </Link>
          </div>
        </nav>
      )}
    </header>
  );
}
