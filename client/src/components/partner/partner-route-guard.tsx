/**
 * Partner Portal — route guard (Increment A). Wraps every authenticated /partner/* page: shows a
 * loading state while the session check is in flight, redirects to /partner/login if not
 * signed in or MFA-pending, and renders the PartnerShell + page once authenticated. This is the
 * ONLY place that decides "can this render" — individual pages never re-implement this check.
 */
import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { PartnerShell, PartnerLoadingState } from "./partner-shell";

export function PartnerRouteGuard({ children }: { children: ReactNode }) {
  const { session, ready, isLoading } = usePartnerSession();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (ready && !isLoading && (!session || !session.mfaPassed)) {
      navigate("/partner/login");
    }
  }, [ready, isLoading, session, navigate]);

  if (!ready || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <PartnerLoadingState label="Loading your account…" />
      </div>
    );
  }

  if (!session || !session.mfaPassed) {
    // Redirect effect above will fire; render nothing rather than a flash of protected content.
    return null;
  }

  return <PartnerShell>{children}</PartnerShell>;
}
