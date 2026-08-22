/**
 * Partner Portal — session context. A thin client-side cache over GET /api/partner/session, the
 * single source of truth for "am I signed in / did MFA / what can I do". Never duplicates the
 * server's auth decisions — every mutating action still re-checks server-side regardless of what
 * this hook believes, exactly per Phase 1's design ("Do not duplicate authentication logic in the
 * front end").
 */
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { partnerAuth, PartnerApiError, type PartnerSessionInfo } from "@/lib/partner-api";

/**
 * The three genuinely different answers the session endpoint can give. Collapsing them all to
 * `null` (as this hook previously did) made "the Portal is switched off" look exactly like "you
 * are signed out", so a 503 silently bounced the user to a sign-in page that could never work.
 */
type SessionResult =
  | { kind: "session"; session: PartnerSessionInfo }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

interface PartnerSessionContextValue {
  session: PartnerSessionInfo | null | undefined;
  isLoading: boolean;
  /** True once the FIRST session check has completed (loading vs. genuinely signed-out). */
  ready: boolean;
  /** The whole Partner Portal is switched off or frozen (503) — not a sign-in problem. */
  unavailable: boolean;
  /** We WERE signed in during this visit and are not any more (mid-session 401). */
  expired: boolean;
  refresh: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const PartnerSessionContext = createContext<PartnerSessionContextValue | null>(null);

/**
 * The ONE place that turns a call to GET /api/partner/session into a SessionResult.
 *
 * Shared by the query and by refresh() on purpose. refresh() used to be `invalidateQueries` alone,
 * which only marks the query stale and starts a refetch — the caller could reach the route guard
 * before the new value was observable, so the guard evaluated the PRE-MFA session and bounced a
 * just-authenticated owner back to /partner/login. refresh() now performs this same canonical fetch
 * and writes the result into the cache synchronously, so when it resolves the cache already holds
 * the authoritative answer and no stale value can be read in between.
 *
 * "Unavailable" covers every way of NOT getting an answer from the Portal: 503 (feature flag off,
 * emergency stop, backend not provisioned), 502/504 (edge up, backend restarting) and status 0,
 * which is what req() reports when fetch itself fails — an offline client or a dropped connection.
 * None of those mean the user was signed out, and treating them as such wrongly claims "your
 * session has ended" mid-session, or bounces a first load to a sign-in page that cannot work
 * either. Only a real answer from the server (401) is signed-out.
 */
async function fetchSessionResult(): Promise<SessionResult> {
  try {
    return { kind: "session", session: await partnerAuth.session() };
  } catch (err) {
    if (err instanceof PartnerApiError && (err.status === 0 || err.status >= 502)) {
      return { kind: "unavailable" };
    }
    return { kind: "signed-out" };
  }
}

export function PartnerSessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const { data: result, isLoading } = useQuery<SessionResult>({
    queryKey: ["/api/partner/session"],
    queryFn: fetchSessionResult,
    staleTime: 30_000,
  });

  const session = result === undefined ? undefined : result.kind === "session" ? result.session : null;
  const unavailable = result?.kind === "unavailable";

  // "Expired" is only honest if we actually saw an authenticated session earlier in this visit —
  // a first-load 401 is a plain signed-out visitor, not an expiry.
  const wasAuthenticated = useRef(false);
  if (session?.mfaPassed) wasAuthenticated.current = true;
  const expired = wasAuthenticated.current && !unavailable && result?.kind === "signed-out";

  useEffect(() => {
    if (!isLoading) setReady(true);
  }, [isLoading]);

  const refresh = useCallback(async () => {
    // Write-through, not invalidate-and-hope. See fetchSessionResult above: the post-MFA
    // navigation must never be able to observe the pre-MFA session.
    qc.setQueryData<SessionResult>(["/api/partner/session"], await fetchSessionResult());
  }, [qc]);

  const hasPermission = useCallback((perm: string) => !!session?.permissions?.includes(perm), [session]);

  return (
    <PartnerSessionContext.Provider value={{ session, isLoading, ready, unavailable, expired, refresh, hasPermission }}>
      {children}
    </PartnerSessionContext.Provider>
  );
}

export function usePartnerSession(): PartnerSessionContextValue {
  const ctx = useContext(PartnerSessionContext);
  if (!ctx) throw new Error("usePartnerSession must be used within PartnerSessionProvider");
  return ctx;
}
