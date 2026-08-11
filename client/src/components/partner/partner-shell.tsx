/**
 * Partner Portal — application shell (Increment A). One layout for every /partner/* page:
 * MintVault Partner identity, current organisation/location, user + role, primary navigation
 * (permission-gated), mobile menu, and the four required non-happy-path states (loading,
 * session-expired, emergency-stop / feature-disabled, error) — described in plain language, never
 * with internal terms like "tenant", "RLS", "feature key", or "credential version".
 */
import { type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerAuth, partnerLocations } from "@/lib/partner-api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Menu,
  X,
  LayoutDashboard,
  FileText,
  Users,
  MapPin,
  CreditCard,
  ClipboardCheck,
  Contact,
  HelpCircle,
  ShieldCheck,
  LogOut,
  PlusCircle,
  Bell,
  PackageCheck,
  ShoppingCart,
  Printer,
  Store,
} from "lucide-react";
import { useState } from "react";
import "@/styles/partner-portal.css";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Permission required to see this item; undefined = always visible to a signed-in user. */
  permission?: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/partner/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/partner/submissions", label: "Submissions", icon: FileText, permission: "partner.orders.view" },
  { href: "/partner/submissions/new", label: "New Submission", icon: PlusCircle, permission: "partner.orders.view" },
  { href: "/partner/customers", label: "Customers", icon: Contact, permission: "partner.orders.view" },
  { href: "/partner/grading", label: "Grading", icon: ClipboardCheck, permission: "partner.cards.assess" },
  {
    href: "/partner/certificates",
    label: "Certificates / Completed",
    icon: PackageCheck,
    permission: "partner.orders.view",
  },
  { href: "/partner/users", label: "Users", icon: Users, permission: "partner.users.view" },
  { href: "/partner/locations", label: "Locations", icon: MapPin, permission: "partner.location.view" },
  { href: "/partner/billing", label: "Credits & Billing", icon: CreditCard, permission: "partner.credits.view" },
  { href: "/partner/supplies", label: "Supplies", icon: ShoppingCart },
  { href: "/partner/orders", label: "Orders", icon: Printer, permission: "partner.orders.view" },
  { href: "/partner/public-profile", label: "Public Profile", icon: Store, permission: "partner.location.view" },
  { href: "/partner/help", label: "Help", icon: HelpCircle },
  { href: "/partner/security", label: "Security & Account", icon: ShieldCheck },
];

export function PartnerShell({ children }: { children: ReactNode }) {
  const { session, hasPermission } = usePartnerSession();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const qc = useQueryClient();

  async function handleSignOut() {
    try {
      await partnerAuth.logout();
    } finally {
      await qc.invalidateQueries({ queryKey: ["/api/partner/session"] });
      window.location.href = "/partner/login";
    }
  }

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <div className="partner-portal min-h-screen bg-background text-foreground flex flex-col">
      <a
        href="#partner-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-3 focus:bg-primary focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <header className="partner-portal__header border-b bg-card sticky top-0 z-40">
        <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            <img className="partner-portal__logo" src="/brand/logo.png" alt="" aria-hidden="true" />
            <div className="min-w-0 leading-tight">
              <span className="partner-portal__brand block text-lg" data-testid="text-partner-brand">
                MintVault Partner
              </span>
              <span className="partner-portal__eyebrow block truncate" data-testid="text-partner-shop-header">
                {session?.tradingName || session?.organisationName || "Partner Portal"}
              </span>
            </div>
            {session?.mfaPassed && <LocationSwitcher wrapperClassName="hidden md:flex" />}
          </div>

          <div className="hidden md:flex items-center gap-2">
            {session?.mfaPassed && (
              <Button variant="ghost" size="icon" aria-label="Notifications: no new alerts" title="No new alerts">
                <Bell className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
            {session?.mfaPassed && (
              <Link href="/partner/submissions/new">
                <Button size="sm" data-testid="button-new-submission-header">
                  <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
                  New Submission
                </Button>
              </Link>
            )}
            {session?.mfaPassed && (
              <Button variant="ghost" size="sm" onClick={handleSignOut} data-testid="button-sign-out">
                <LogOut className="h-4 w-4 mr-1.5" aria-hidden="true" />
                Sign out
              </Button>
            )}
          </div>

          <button
            type="button"
            className="md:hidden p-3 min-h-11 min-w-11"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            data-testid="button-mobile-menu-toggle"
            onClick={() => setMobileOpen((o) => !o)}
          >
            {mobileOpen ? (
              <X className="h-6 w-6" aria-hidden="true" />
            ) : (
              <Menu className="h-6 w-6" aria-hidden="true" />
            )}
          </button>
        </div>

        {mobileOpen && (
          <nav
            aria-label="Partner navigation (mobile)"
            className="partner-portal__mobile-nav md:hidden border-t bg-card"
          >
            {session?.mfaPassed && (
              <div className="px-3 pt-3">
                <span className="text-xs font-medium text-muted-foreground" id="mobile-location-label">
                  Location
                </span>
                <div aria-labelledby="mobile-location-label">
                  <LocationSwitcher wrapperClassName="flex w-full mt-1" />
                </div>
              </div>
            )}
            <ul className="flex flex-col p-2">
              {visibleItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    data-testid={`link-mobile-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                    className="partner-portal__nav-link flex items-center gap-3 px-3 py-3"
                  >
                    <item.icon className="h-5 w-5" aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              ))}
              {session?.mfaPassed && (
                <li>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    data-testid="link-mobile-sign-out"
                    className="flex items-center gap-3 px-3 py-3 rounded-md hover:bg-accent w-full text-left"
                  >
                    <LogOut className="h-5 w-5" aria-hidden="true" />
                    Sign out
                  </button>
                </li>
              )}
            </ul>
          </nav>
        )}
      </header>

      <div className="flex flex-1 max-w-7xl mx-auto w-full">
        {session?.mfaPassed && (
          <nav
            aria-label="Partner navigation"
            className="partner-portal__sidebar hidden md:block w-60 shrink-0 border-r"
          >
            <div className="partner-portal__identity p-4">
              <p className="text-sm font-semibold truncate">{session.tradingName || session.organisationName}</p>
              <p className="text-xs text-muted-foreground truncate">{session.displayName}</p>
              <p className="text-xs text-primary mt-1">{session.role || "Partner user"}</p>
            </div>
            <div className="p-4">
              <ul className="space-y-1">
                {visibleItems.map((item) => {
                  const active = location.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                        aria-current={active ? "page" : undefined}
                        className="partner-portal__nav-link flex items-center gap-3 px-3 py-2 text-sm"
                      >
                        <item.icon className="h-4 w-4" aria-hidden="true" />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </nav>
        )}

        <main id="partner-main" className="partner-portal__main flex-1 p-4 md:p-8 min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}

/** Clear location switcher (shell requirement) — lists only locations this user may operate at
 *  (server-derived: org-wide roles see every active location, others see only their assigned
 *  ones) and switches via the existing Phase 1 POST /session/location, which itself re-verifies
 *  the assignment server-side — the client list is a convenience, never the authority. */
/**
 * `wrapperClassName` lets the caller control visibility per breakpoint (header vs. mobile-menu
 * placements need opposite hidden/visible rules) without duplicating the fetch/switch logic —
 * this component is rendered TWICE (desktop header, mobile menu panel) so the switcher is always
 * reachable, never only on wide screens (a mobile user with no location selected still needs a
 * way to pick one; the wizard's own "select a location" state points here).
 */
function LocationSwitcher({ wrapperClassName }: { wrapperClassName: string }) {
  const { session, refresh } = usePartnerSession();
  const qc = useQueryClient();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const { data: locations } = useQuery({
    queryKey: ["/api/partner/locations"],
    queryFn: () => partnerLocations.list(),
    enabled: !!session?.mfaPassed,
  });

  async function handleChange(locationId: string) {
    setSwitchError(null);
    try {
      await partnerAuth.switchLocation(locationId);
      await refresh();
      await qc.invalidateQueries();
    } catch {
      // Session state (and therefore the Select's value) is untouched, so the control reverts to
      // the still-current location on its own — we only need to surface why the switch was refused
      // (e.g. an org-wide viewer picking a location they can see but aren't assigned to work from).
      setSwitchError("Couldn't switch to that location. You may not be assigned there.");
    }
  }

  if (!locations || locations.length === 0) return null;

  // A single-location user needs no picker ONCE THE SESSION IS ACTUALLY BOUND to that location —
  // then the name is just status, and a dropdown of one would be noise.
  //
  // It is NOT safe to render plain text purely because the set size is 1. When location_id is still
  // null this branch used to be an unrecoverable dead end: the submission wizard refuses to start
  // without a location and tells the operator to "use the location switcher at the top of the
  // page", while this component rendered a non-interactive <span> — a switcher that by construction
  // could not switch. The server now auto-selects a sole eligible location
  // (resolvePartnerSession → findSoleEligibleLocation), so this should be transient; falling
  // through to the real Select keeps a working escape hatch if it is ever not.
  if (locations.length === 1 && session?.locationId === locations[0].id) {
    return (
      <span className={`${wrapperClassName} text-sm text-muted-foreground`} data-testid="text-single-location">
        {locations[0].name}
      </span>
    );
  }

  return (
    <div className={`${wrapperClassName} flex-col gap-1`}>
      <Select value={session?.locationId ?? undefined} onValueChange={handleChange}>
        <SelectTrigger
          className="h-8 w-full sm:w-[180px]"
          data-testid="select-location-switcher"
          aria-label="Current location"
        >
          <SelectValue placeholder="Select a location" />
        </SelectTrigger>
        <SelectContent>
          {locations.map((loc) => (
            <SelectItem key={loc.id} value={loc.id} data-testid={`option-location-${loc.id}`}>
              {loc.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {switchError && (
        <span role="alert" className="text-xs text-destructive" data-testid="text-location-switch-error">
          {switchError}
        </span>
      )}
    </div>
  );
}

/** Shown when the Partner Portal is switched off (feature flag) or the whole organisation/location is frozen (emergency stop). Both surface identically to the client — the server never tells a signed-out visitor WHY, only that the Portal is unavailable. */
export function PartnerUnavailableState() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-3">
        <h1 className="text-2xl font-bold">Partner Portal unavailable</h1>
        <p className="text-muted-foreground">
          The Partner Portal is temporarily unavailable. Please try again shortly, or contact MintVault if this
          continues.
        </p>
      </div>
    </div>
  );
}

/** Shown when a request comes back 401 mid-session — the account was signed out elsewhere (revoked, password reset, suspension, idle timeout). */
export function PartnerSessionExpiredState() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-4">
        <h1 className="text-2xl font-bold">Your session has ended</h1>
        <p className="text-muted-foreground">
          For your security, you've been signed out. Please sign in again to continue.
        </p>
        <Button asChild data-testid="button-session-expired-signin">
          <Link href="/partner/login">Sign in</Link>
        </Button>
      </div>
    </div>
  );
}

export function PartnerErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center space-y-3" role="alert">
      <p className="font-medium text-destructive">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} data-testid="button-error-retry">
          Try again
        </Button>
      )}
    </div>
  );
}

export function PartnerLoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center p-12 text-muted-foreground" role="status" aria-live="polite">
      {label}
    </div>
  );
}
