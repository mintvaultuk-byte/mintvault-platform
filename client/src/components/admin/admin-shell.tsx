import type { ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard,
  List,
  Package,
  ScanLine,
  DollarSign,
  Database,
  Printer,
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
  | "grading"
  | "learning"
  | "capture-health"
  | "divergence"
  | "transfers"
  | "scans";

interface DbInfo {
  env: string;
  neon_host: string;
  db_name: string;
  card_master_active_count: number;
  card_sets_active_count: number;
  certificates_count: number;
}

type NavLeaf = {
  key: AdminTab;
  label: string;
  icon: typeof LayoutDashboard;
};
type NavLink = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
};
type NavItem = NavLeaf | NavLink;
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
      { href: "/admin/staff", label: "Staff", icon: Users },
    ],
  },
  {
    heading: "Insight",
    items: [
      { href: "/admin/vault-quest", label: "Vault Quest", icon: Sparkles },
      { key: "learning", label: "AI Learning", icon: Brain },
      { key: "divergence", label: "AI Divergence", icon: TrendingUp },
      { key: "grading", label: "Grading", icon: BarChart3 },
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
      { key: "capacity", label: "Capacity", icon: Database },
      { href: "/admin/weekly-reel", label: "Weekly Reel", icon: Film },
      { key: "pricing", label: "Pricing", icon: DollarSign },
      { key: "intake", label: "Intake", icon: ScanLine },
      { key: "submissions", label: "Submissions", icon: Package },
    ],
  },
];

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

interface AdminShellProps {
  activeTab: AdminTab;
  onTabChange: (t: AdminTab) => void;
  onLogout: () => void;
  /** Controlled global cert search, surfaced in the topbar (same state the certs list uses). */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
  /** Override the topbar title/crumb (defaults derive from the active tab). */
  title?: ReactNode;
  crumb?: ReactNode;
  children: ReactNode;
}

export default function AdminShell({
  activeTab,
  onTabChange,
  onLogout,
  search,
  title,
  crumb,
  children,
}: AdminShellProps) {
  const { data: dbInfo } = useQuery<DbInfo>({
    queryKey: ["/api/admin/db-info"],
    refetchInterval: 60000,
  });

  const isStagingHost = typeof window !== "undefined" && window.location.hostname.includes("mintvault-v2");
  const envLabel = isStagingHost ? "STAGING" : dbInfo?.env === "production" ? "PRODUCTION" : "DEVELOPMENT";
  const envIsProd = !isStagingHost && dbInfo?.env === "production";
  const shortHost = dbInfo?.neon_host ? dbInfo.neon_host.split(".")[0].slice(0, 14) : "—";

  const derived = crumbForTab(activeTab);
  const topTitle = title ?? derived.title;
  const topCrumb = crumb ?? derived.path;

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

          {NAV.map((section) => (
            <nav className="admin-nav" key={section.heading}>
              <div className="admin-nav-h">{section.heading}</div>
              {section.items.map((item) => {
                const Icon = item.icon;
                if ("href" in item) {
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="admin-nav-i"
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
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
                  >
                    <Icon /> {item.label}
                  </button>
                );
              })}
            </nav>
          ))}

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
        </aside>

        {/* ── Main column ─────────────────────────────────────────────── */}
        <div className="admin-main">
          <header className="admin-top">
            <div className="admin-crumb">
              <div className="admin-crumb__t">{topTitle}</div>
              <div className="admin-crumb__p">{topCrumb}</div>
            </div>

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
