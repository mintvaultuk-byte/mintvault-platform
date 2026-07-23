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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Menu,
  X,
  LayoutDashboard,
  ShieldCheck,
  LogOut,
  CreditCard,
  PackagePlus,
  ClipboardCheck,
  Award,
  LifeBuoy,
  GraduationCap,
} from "lucide-react";
import { useState } from "react";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Permission required to see this item; undefined = always visible to a signed-in user. */
  permission?: string;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/partner/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/partner/submissions/new", label: "New Submission", icon: PackagePlus, permission: "partner.orders.create" },
  { href: "/partner/submissions", label: "Submissions", icon: ClipboardCheck, permission: "partner.orders.view" },
  { href: "/partner/grading", label: "Grading", icon: GraduationCap, permission: "partner.grading.view" },
  { href: "/partner/certificates", label: "Certificates", icon: Award, permission: "partner.certificates.view" },
  { href: "/partner/corrections", label: "Corrections", icon: LifeBuoy, permission: "partner.corrections.view" },
  { href: "/partner/credits", label: "Credits", icon: CreditCard, permission: "partner.credits.view" },
  { href: "/partner/onboarding", label: "Onboarding", icon: ClipboardCheck, permission: "partner.onboarding.view" },
  { href: "/partner/security", label: "Security & Account", icon: ShieldCheck },
];

export function PartnerShell({ children }: { children: ReactNode }) {
  const { session, hasPermission } = usePartnerSession();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const qc = useQueryClient();
  const { data: locations } = useQuery({
    queryKey: ["/api/partner/locations"],
    queryFn: () => partnerLocations.list(),
    enabled: !!session?.mfaPassed,
  });

  async function handleSignOut() {
    try {
      await partnerAuth.logout();
    } finally {
      await qc.invalidateQueries({ queryKey: ["/api/partner/session"] });
      window.location.href = "/partner/login";
    }
  }

  async function handleLocationChange(locationId: string) {
    if (!locationId || locationId === session?.locationId) return;
    await partnerAuth.switchLocation(locationId);
    await qc.invalidateQueries({ queryKey: ["/api/partner/session"] });
    await qc.invalidateQueries({ queryKey: ["/api/partner/dashboard/launch"] });
  }

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <a
        href="#partner-main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-3 focus:bg-primary focus:text-primary-foreground"
      >
        Skip to main content
      </a>

      <header className="border-b bg-card sticky top-0 z-40">
        <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
          <div className="flex items-center gap-4 min-w-0">
            <span className="font-bold text-lg tracking-tight" data-testid="text-partner-brand">
              MintVault Partner
            </span>
            {session?.mfaPassed && (
              <span
                className="hidden lg:inline text-xs text-muted-foreground truncate"
                data-testid="text-active-location"
              >
                {locations?.find((location) => location.id === session.locationId)?.name ?? "No active location"}
              </span>
            )}
          </div>

          <div className="hidden md:flex items-center gap-2">
            {session?.mfaPassed && locations && locations.length > 1 && (
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={session.locationId ?? ""}
                aria-label="Select active location"
                data-testid="select-active-location"
                onChange={(event) => handleLocationChange(event.target.value)}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
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
            className="md:hidden p-2"
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
          <nav aria-label="Partner navigation (mobile)" className="md:hidden border-t bg-card">
            <ul className="flex flex-col p-2">
              {visibleItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    data-testid={`link-mobile-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                    className="flex items-center gap-3 px-3 py-3 rounded-md hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
          <nav aria-label="Partner navigation" className="hidden md:block w-56 shrink-0 border-r p-4">
            <ul className="space-y-1">
              {visibleItems.map((item) => {
                const active = location.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      data-testid={`link-nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                        active ? "bg-primary/10 text-primary font-medium" : "hover:bg-accent"
                      }`}
                    >
                      <item.icon className="h-4 w-4" aria-hidden="true" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <main id="partner-main" className="flex-1 p-4 md:p-8 min-w-0">
          {children}
        </main>
      </div>
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
