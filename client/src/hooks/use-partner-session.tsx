/**
 * Partner Portal — session context. A thin client-side cache over GET /api/partner/session, the
 * single source of truth for "am I signed in / did MFA / what can I do". Never duplicates the
 * server's auth decisions — every mutating action still re-checks server-side regardless of what
 * this hook believes, exactly per Phase 1's design ("Do not duplicate authentication logic in the
 * front end").
 */
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { partnerAuth, type PartnerSessionInfo } from "@/lib/partner-api";

interface PartnerSessionContextValue {
  session: PartnerSessionInfo | null | undefined;
  isLoading: boolean;
  /** True once the FIRST session check has completed (loading vs. genuinely signed-out). */
  ready: boolean;
  refresh: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const PartnerSessionContext = createContext<PartnerSessionContextValue | null>(null);

export function PartnerSessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const { data: session, isLoading } = useQuery({
    queryKey: ["/api/partner/session"],
    queryFn: async () => {
      try {
        return await partnerAuth.session();
      } catch {
        return null; // TanStack Query v5 rejects `undefined` from queryFn — signed-out is represented as null
      }
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!isLoading) setReady(true);
  }, [isLoading]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ["/api/partner/session"] });
  }, [qc]);

  const hasPermission = useCallback((perm: string) => !!session?.permissions?.includes(perm), [session]);

  return (
    <PartnerSessionContext.Provider value={{ session, isLoading, ready, refresh, hasPermission }}>
      {children}
    </PartnerSessionContext.Provider>
  );
}

export function usePartnerSession(): PartnerSessionContextValue {
  const ctx = useContext(PartnerSessionContext);
  if (!ctx) throw new Error("usePartnerSession must be used within PartnerSessionProvider");
  return ctx;
}
