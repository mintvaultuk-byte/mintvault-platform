import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard,
  List,
  Package,
  ScanLine,
  DollarSign,
  Database,
  Printer,
  PrinterCheck,
  Film,
  BarChart3,
  Brain,
  Activity,
  TrendingUp,
  SlidersHorizontal,
  ArrowRightLeft,
  History,
  Search,
  LogOut,
  Check,
  Tag,
  Users,
  Sparkles,
  ShieldCheck,
  KeyRound,
  Library,
  PackageCheck,
  Share2,
  ChevronDown,
  TreePine,
} from "lucide-react";
import GrainOverlay from "./grain-overlay";
import InstallAppButton from "../install-app-button";

/** Canonical admin tab contract — owned by the shell, imported by the dashboard. */
export type AdminTab =
  | "dashboard"
  | "certs"
  | "submissions"
  | "intake"
  | "pricing"
  | "promotions"
  | "capacity"
  | "printing"
  | "print-queue"
  | "grading"
  | "learning"
  | "capture-health"
  | "divergence"
  | "transfers"
  | "scans"
  | "sets"
  | "growth"
  | "command-centre"
  | "claim-register";

interface DbInfo {
  env: string;
  neon_host: string;
  db_name: string;
  card_master_active_count: number;
  card_sets_active_count: number;
  certificates_count: number;
  command_centre_available?: boolean;
}

type NavLeaf = {
  key: AdminTab;
  label: string;
  icon: typeof LayoutDashboard;
  /** Optional hover tooltip — used for nav entries whose click behaviour
   *  isn't a simple "switch to this tab" (e.g. "grading" jumps straight into
   *  the canonical CertificateForm workstation instead of a persistent view). */
  title?: string;
};
type NavLink = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Links carrying operationally sensitive aggregate data remain hidden unless
   * the server has confirmed the current admin is a Super Admin. */
  superAdminOnly?: boolean;
};
type NavGroup = NavLink & {
  children: readonly NavLink[];
};
type NavItem = NavLeaf | NavLink | NavGroup;
type NavSection = { heading: string; items: NavItem[] };

// Nav order is the OWNER'S WORKFLOW order (set 2026-07-03) — the flattened
// sequence across sections is deliberate; don't re-sort alphabetically or
// regroup without asking. Sections only feed the heading + topbar crumb.
const NAV: NavSection[] = [
  {
    heading: "Operations",
    items: [
      { key: "dashboard", label: "Overview", icon: LayoutDashboard },
      { key: "certs", label: "Certificates", icon: List },
      { key: "printing", label: "Printing", icon: Printer },
      { key: "print-queue", label: "Print Queue", icon: PrinterCheck },
      { href: "/admin/staff", label: "Staff", icon: Users },
      { href: "/admin/claim-register", label: "Claim Register", icon: KeyRound },
      { href: "/admin/security", label: "Security", icon: ShieldCheck },
      { href: "/admin/partners", label: "Partner Network", icon: PackageCheck },
    ],
  },
  {
    heading: "Insight",
    items: [
      { href: "/admin/vault-quest", label: "Vault Quest", icon: Sparkles },
      { href: "/admin/vault-quest/card-factory", label: "Card Factory", icon: PackageCheck },
      { href: "/admin/growth", label: "Growth Command", icon: BarChart3, superAdminOnly: true },
      { key: "learning", label: "AI Learning", icon: Brain },
      { key: "divergence", label: "AI Divergence", icon: TrendingUp },
      {
        key: "grading",
        label: "Grading",
        icon: BarChart3,
        title: "Open the oldest ungraded certificate in the grading workstation",
      },
      { key: "capture-health", label: "Capture Health", icon: Activity },
    ],
  },
  {
    heading: "Records",
    items: [
      { key: "promotions", label: "Promotions", icon: Tag },
      { href: "/admin/mvgs-calibration", label: "MVGS Calibration", icon: SlidersHorizontal },
      { key: "transfers", label: "Transfers", icon: ArrowRightLeft },
      { key: "scans", label: "Scans", icon: History },
      { href: "/admin/sets", label: "Sets", icon: Library },
      { href: "/admin/social-studio", label: "Social Studio", icon: Share2 },
      { key: "capacity", label: "Capacity", icon: Database },
      { href: "/admin/weekly-reel", label: "Advanced Reel Pipeline", icon: Film },
      { key: "pricing", label: "Pricing", icon: DollarSign },
      { key: "intake", label: "Intake", icon: ScanLine },
      { key: "submissions", label: "Submissions", icon: Package },
    ],
  },
  {
    heading: "System",
    items: [{ href: "/admin/catalogue", label: "Catalogue Manager", icon: Library }],
  },
];

export function navigationForCommandCentre(commandCentreAvailable: boolean): NavSection[] {
  if (!commandCentreAvailable) {
    return NAV;
  }

  return NAV.map((section) => {
    if (section.heading !== "Insight") {
      return section;
    }

    return {
      ...section,
      items: [
        ...section.items,
        {
          href: "/admin/command",
          label: "Command Centre",
          icon: Activity,
          children: [
            { href: "/admin/command?view=overview", label: "Overview", icon: LayoutDashboard },
            { href: "/admin/command?view=attention", label: "Attention", icon: Activity },
            { href: "/admin/command?view=tree", label: "Work Tree", icon: TreePine },
            { href: "/admin/command?view=skills", label: "Skills", icon: Library },
          ],
        },
      ],
    };
  });
}

/**
 * The consolidated Partner Network is now the ONLY Partner Network.
 *
 * It used to be gated behind VITE_PARTNER_NETWORK_CONSOLIDATION, which shipped as `false` — so the
 * consolidated surfaces existed, were tested, and were unreachable, while six navigation links
 * collapsed onto two legacy pages. Overview and Partners pointed at the SAME url; Settings opened
 * the partner list. That flag was the direct cause of the duplication this navigation removes, so
 * it is gone rather than flipped: one surface cannot drift from another that no longer exists.
 */
const PARTNER_NETWORK_HOME = "/admin/partners";

/** The whole Partner Network, in four destinations. Exported so tests assert the real list. */
export const PARTNER_NAV = [
  { key: "overview", label: "Overview", href: "/admin/partners" },
  { key: "shops", label: "Shops", href: "/admin/partners/shops" },
  { key: "supplies", label: "Supplies", href: "/admin/partners/supplies" },
  { key: "settings", label: "Settings", href: "/admin/partners/settings" },
] as const;

// Topbar crumb path label per section the active tab belongs to.
function crumbForTab(tab: AdminTab): { title: string; path: string } {
  for (const section of NAV) {
    for (const item of section.items) {
      if ("key" in item && item.key === tab) {
        return { title: item.label, path: `MINTVAULT · ${section.heading.toUpperCase()}` };
      }
    }
  }
  return { title: "Admin", path: "MINTVAULT" };
}

function adminTabDestination(tab: AdminTab): string {
  return tab === "dashboard" ? "/admin" : "/admin?tab=" + encodeURIComponent(tab);
}

interface AdminShellProps {
  activeTab: AdminTab;
  onTabChange: (t: AdminTab) => void;
  onLogout: () => void;
  /** Controlled global cert search, surfaced in the topbar (same state the certs list uses). */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  /** Override the topbar title/crumb (defaults derive from the active tab). */
  title?: ReactNode;
  crumb?: ReactNode;
  /** Focus mode — hide the top header chrome and give the content area the full
      viewport height so a full-height child (e.g. the grading workstation) can
      fill it. Non-focus rendering is unchanged. */
  focus?: boolean;
  /** Command Centre is a snapshot surface: do not retain the shell's legacy
      environment polling while it is mounted. */
  disableEnvironmentPolling?: boolean;
  /** Command Centre must not fetch or render the shell's unrelated database
      metadata. Its own read-only endpoint is the only live domain payload. */
  commandCentreMode?: boolean;
  /** Set only after the protected Command Centre GET has returned successfully. */
  commandCentreAvailable?: boolean;
  children: ReactNode;
}

type AdminSession = { authenticated: boolean; isSuperAdmin?: boolean };

export default function AdminShell({
  activeTab,
  onTabChange,
  onLogout,
  search,
  title,
  crumb,
  focus,
  disableEnvironmentPolling = false,
  commandCentreMode = false,
  commandCentreAvailable = false,
  children,
}: AdminShellProps) {
  const [pathname] = useLocation();
  const [commandGroupOpen, setCommandGroupOpen] = useState(pathname === "/admin/command");
  const { data: dbInfo } = useQuery<DbInfo>({
    queryKey: ["/api/admin/db-info"],
    enabled: !commandCentreMode,
    refetchInterval: disableEnvironmentPolling ? false : 60000,
  });
  const { data: adminSession } = useQuery<AdminSession>({
    queryKey: ["/api/admin/session"],
    queryFn: async () => {
      const response = await fetch("/api/admin/session", { credentials: "include" });
      return response.ok ? ((await response.json()) as AdminSession) : { authenticated: false };
    },
    staleTime: 60_000,
  });

  const isStagingHost = typeof window !== "undefined" && window.location.hostname.includes("mintvault-v2");
  const envLabel = isStagingHost ? "STAGING" : dbInfo?.env === "production" ? "PRODUCTION" : "DEVELOPMENT";
  const envIsProd = !isStagingHost && dbInfo?.env === "production";
  const shortHost = dbInfo?.neon_host ? dbInfo.neon_host.split(".")[0].slice(0, 14) : "—";

  const derived = crumbForTab(activeTab);
  const topTitle = title ?? derived.title;
  const topCrumb = crumb ?? derived.path;
  const navigation = navigationForCommandCentre(
    commandCentreAvailable || (!commandCentreMode && dbInfo?.command_centre_available === true)
  );

  // Focus mode (e.g. the grading workstation) drops BOTH the top header chrome
  // and the left sidebar so the workstation gets the full viewport width — just
  // a compact header + the two-column workspace, no admin nav.
  if (focus) {
    return (
      <div className="admin-root">
        <GrainOverlay />
        {/* Grading workstation shell. Uses min-height (not a fixed height) and
            NO overflow:hidden so the browser page can always scroll as a
            fallback — the previous height:100vh + overflow:hidden clipped any
            content past the viewport and trapped scrolling. The workstation
            itself sets a bounded, viewport-relative height at desktop so its
            right column scrolls internally; below that it flows and the page
            scrolls normally. */}
        <div className="admin-focus" style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="admin-root">
      <GrainOverlay />
      <div className="admin-app">
        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <aside className="admin-side">
          <div className="admin-brand">
            <div className="admin-brand__mark">MintVault</div>
            <div className="admin-brand__sub">Admin Console</div>
          </div>

          {navigation.map((section) => (
            <nav className="admin-nav" key={section.heading}>
              <div className="admin-nav-h">{section.heading}</div>
              {section.items.map((item) => {
                const Icon = item.icon;
                if ("children" in item) {
                  const currentDestination =
                    typeof window === "undefined" ? pathname : `${pathname}${window.location.search}`;
                  return (
                    <div key={item.href} data-testid="nav-command-centre-group">
                      <div className="flex items-center">
                        <Link
                          href={item.href}
                          className={`admin-nav-i min-w-0 flex-1 ${pathname === item.href ? "is-on" : ""}`.trim()}
                          data-testid="nav-command-centre"
                        >
                          <Icon /> {item.label}
                        </Link>
                        <button
                          type="button"
                          className="admin-nav-i !w-auto !px-2"
                          data-testid="nav-command-centre-toggle"
                          aria-label={`${commandGroupOpen ? "Collapse" : "Expand"} Command Centre navigation`}
                          aria-expanded={commandGroupOpen}
                          aria-controls="command-centre-nav-children"
                          onClick={() => setCommandGroupOpen((open) => !open)}
                        >
                          <ChevronDown
                            className={`command-centre-nav-chevron transition-transform ${commandGroupOpen ? "rotate-180" : ""}`}
                          />
                        </button>
                      </div>
                      {commandGroupOpen && (
                        <div id="command-centre-nav-children" className="pl-4">
                          {item.children.map((child) => {
                            const ChildIcon = child.icon;
                            return (
                              <Link
                                key={child.href}
                                href={child.href}
                                className={`admin-nav-i ${currentDestination === child.href ? "is-on" : ""}`.trim()}
                                data-testid={`nav-command-centre-${child.label.toLowerCase().replace(/\s+/g, "-")}`}
                              >
                                <ChildIcon /> {child.label}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }
                if ("href" in item) {
                  if (item.superAdminOnly && adminSession?.isSuperAdmin !== true) return null;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`admin-nav-i ${pathname === item.href ? "is-on" : ""}`.trim()}
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <Icon /> {item.label}
                    </Link>
                  );
                }
                if (commandCentreMode) {
                  return (
                    <Link
                      key={item.key}
                      href={adminTabDestination(item.key)}
                      className="admin-nav-i"
                      data-testid={`nav-${item.key}`}
                      title={item.title}
                    >
                      <Icon /> {item.label}
                    </Link>
                  );
                }
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => onTabChange(item.key)}
                    className={`admin-nav-i ${activeTab === item.key ? "is-on" : ""}`.trim()}
                    data-testid={`nav-${item.key}`}
                    title={item.title}
                  >
                    <Icon /> {item.label}
                  </button>
                );
              })}
            </nav>
          ))}

          {!commandCentreMode && (
            <div className="admin-side-foot">
              <span className={`admin-env ${envIsProd ? "" : "is-staging"}`.trim()} data-testid="badge-env">
                <span className="admin-env__dot" />
                ENV · {envLabel}
              </span>
              {dbInfo && (
                <span className="admin-build" data-testid="text-db-counts">
                  {shortHost}/{dbInfo.db_name}
                  <br />
                  CM {dbInfo.card_master_active_count} · CS {dbInfo.card_sets_active_count} · Certs{" "}
                  {dbInfo.certificates_count}
                </span>
              )}
            </div>
          )}
        </aside>

        {/* ── Main column ─────────────────────────────────────────────── */}
        <div className="admin-main">
          {pathname.startsWith("/admin/partners") && (
            <nav
              className="flex flex-wrap items-center gap-3 border-b border-[var(--admin-line)] px-5 py-2 text-sm"
              aria-label="Partner Network"
            >
              <span className="font-semibold">Partner Network</span>
              {/*
               * FOUR destinations. Stations and Infrastructure were removed from everyday navigation
               * rather than deleted: network-wide station problems now surface on Overview's Needs
               * Attention with an Approve Scanner action, individual station work lives in the shop's
               * own workspace, and both full fleet/connector consoles remain reachable under
               * Settings → Advanced. No capability was removed; two everyday clicks were.
               */}
              {PARTNER_NAV.map((item) => (
                <Link key={item.href} href={item.href} className="underline" data-testid={`pn-nav-${item.key}`}>
                  {item.label}
                </Link>
              ))}
            </nav>
          )}
          <header className="admin-top">
            <div className="admin-crumb">
              <div className="admin-crumb__t">{topTitle}</div>
              <div className="admin-crumb__p">{topCrumb}</div>
            </div>

            {!commandCentreMode && (
              <div className="admin-pills" data-testid="env-banner">
                <span className="admin-pill">
                  <Check size={11} /> DB
                </span>
                {dbInfo && (
                  <>
                    <span className="admin-pill">
                      CM <b>{dbInfo.card_master_active_count}</b>
                    </span>
                    <span className="admin-pill">
                      CS <b>{dbInfo.card_sets_active_count}</b>
                    </span>
                    <span className="admin-pill">
                      Certs <b>{dbInfo.certificates_count}</b>
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="admin-topright">
              {search && (
                <label className="admin-search">
                  <Search />
                  <input
                    value={search.value}
                    onChange={(e) => {
                      search.onChange(e.target.value);
                      if (e.target.value && activeTab !== "certs") onTabChange("certs");
                    }}
                    placeholder={search.placeholder ?? "Search certificates…"}
                    data-testid="input-global-search"
                  />
                </label>
              )}
              <InstallAppButton className="admin-btn" label="Install app" />
              <button
                type="button"
                onClick={onLogout}
                className="admin-icon-btn admin-btn"
                title="Log out"
                data-testid="button-logout"
              >
                <LogOut />
              </button>
              <div className="admin-avatar" aria-hidden="true">
                C
              </div>
            </div>
          </header>

          <main className="admin-scroll">{children}</main>
        </div>
      </div>
    </div>
  );
}
