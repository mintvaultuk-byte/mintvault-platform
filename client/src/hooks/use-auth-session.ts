/**
 * client/src/hooks/use-auth-session.ts
 *
 * Single source of truth for who the SPA thinks is logged in. The
 * codebase ships THREE concurrent audience identities sharing one
 * session document (admin / account-holder / cert-owner), per the
 * design captured at server/routes.ts:5935-5937. This hook merges all
 * three into one observable shape and — critically — invalidates the
 * TanStack Query cache when the underlying identity fingerprint
 * changes.
 *
 * Why the cache invalidation: TanStack Query is configured with
 * staleTime: Infinity (client/src/lib/queryClient.ts). Without
 * explicit invalidation, cached responses from user A survive across
 * a session swap to user B and surface as mixed-state UI (see
 * docs/login-flow-bug-report.md for the bug that motivated this hook).
 *
 * Drop-in for components that previously called useQuery for
 * /api/auth/me and /api/customer/me directly. Migration is opt-in;
 * pages that don't use the hook keep their existing query patterns —
 * but they remain vulnerable to the cross-tab session-swap bug.
 *
 * Out of scope (deliberately):
 *   - Admin status — adminEmail / isAdmin live behind admin-only
 *     surfaces that don't share the dashboard's mixed-audience read
 *     pattern. If/when an admin page reads identity, extend this
 *     hook (the fingerprint is already shaped to accommodate it via
 *     a future `adminMe` field).
 *   - Logout — pages that call /api/customer/logout or /api/auth/logout
 *     should still trigger their own queryClient.clear() on success.
 *     Adding a transition-detector is belt-and-braces against
 *     externally-induced session changes (cross-tab cookie
 *     replacement, server-side admin force-logout, etc.).
 */

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface AuthMe {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
  created_at: string;
}

export interface CustomerMe {
  email: string;
}

export interface AuthSessionState {
  authMe: AuthMe | null;
  customerMe: CustomerMe | null;
  /** True iff EITHER identity slot is populated. Useful as a "is the user signed in to anything?" guard. */
  isAuthenticated: boolean;
  /** Stable identity-fingerprint string. Empty string when fully signed out. */
  fingerprint: string;
  isLoading: boolean;
}

function computeFingerprint(authMe: AuthMe | null, customerMe: CustomerMe | null): string {
  const auth = authMe?.id ?? "";
  const customer = customerMe?.email ?? "";
  return `${auth}|${customer}`;
}

export function useAuthSession(): AuthSessionState {
  const queryClient = useQueryClient();

  const authQuery = useQuery<AuthMe | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`auth/me ${res.status}`);
      return res.json();
    },
    retry: false,
  });

  const customerQuery = useQuery<CustomerMe | null>({
    queryKey: ["/api/customer/me"],
    queryFn: async () => {
      const res = await fetch("/api/customer/me", { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`customer/me ${res.status}`);
      return res.json();
    },
    retry: false,
  });

  const fingerprint = computeFingerprint(authQuery.data ?? null, customerQuery.data ?? null);
  const prevFingerprint = useRef<string | null>(null);

  useEffect(() => {
    // First render: just record. Don't clear the cache on initial
    // population — that would clear queries that are mid-flight or
    // freshly fetched as legitimate first reads.
    if (prevFingerprint.current === null) {
      prevFingerprint.current = fingerprint;
      return;
    }
    if (prevFingerprint.current === fingerprint) return;

    // Identity transitioned. Clear EVERY cached query so the next
    // render fetches fresh data scoped to the new session. This is
    // intentionally aggressive — clearing only known-identity-coupled
    // queries leaves a long tail of derived queries that may or may
    // not be tied to the user (e.g. `/api/customer/submissions` is,
    // `/api/v2/homepage-stats` isn't). Aggressive clear is the only
    // safe default.
    //
    // Side-effects: pages re-show their loading skeletons during the
    // refetch tick. Acceptable cost.
    queryClient.clear();
    prevFingerprint.current = fingerprint;
  }, [fingerprint, queryClient]);

  return {
    authMe: authQuery.data ?? null,
    customerMe: customerQuery.data ?? null,
    isAuthenticated: !!(authQuery.data || customerQuery.data),
    fingerprint,
    isLoading: authQuery.isLoading || customerQuery.isLoading,
  };
}
