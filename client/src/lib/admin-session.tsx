import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  apiRequest,
  getActiveAdminPrincipal,
  isProtectedAdminLocation,
  subscribeAdminUnauthorized,
  transitionAdminPrincipal,
  type AdminPrincipalScope,
} from "./queryClient";

export { isProtectedAdminLocation } from "./queryClient";

export type AdminPrincipal = AdminPrincipalScope;

export type AdminUnauthenticatedReason =
  | "not_authenticated"
  | "session_expired"
  | "invalid_session"
  | "wrong_portal";

export type AdminSessionResult =
  | { kind: "authenticated"; principal: AdminPrincipal }
  | { kind: "unauthenticated"; reason: AdminUnauthenticatedReason }
  | { kind: "unavailable"; status: number };

type AdminSessionState =
  | { status: "inactive"; principal: null }
  | { status: "checking"; principal: AdminPrincipal | null }
  | { status: "authenticated"; principal: AdminPrincipal }
  | { status: "unavailable"; principal: AdminPrincipal | null };

type AdminSessionContextValue = AdminSessionState & {
  logout: () => Promise<void>;
  logoutPending: boolean;
  logoutError: string | null;
  retry: () => void;
};

const AdminSessionContext = createContext<AdminSessionContextValue | null>(null);
const ADMIN_SESSION_TRANSITION_KEY = "mintvault.admin-session.transition";

const unauthenticatedReasons = new Set<AdminUnauthenticatedReason>([
  "not_authenticated",
  "session_expired",
  "invalid_session",
  "wrong_portal",
]);

function objectBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export async function adminSessionResultFromResponse(response: Response): Promise<AdminSessionResult> {
  let body: Record<string, unknown> | null = null;
  try {
    body = objectBody(await response.json());
  } catch {
    body = null;
  }

  if (response.ok && body?.authenticated === true) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return { kind: "unavailable", status: response.status };
    return {
      kind: "authenticated",
      principal: { email, isSuperAdmin: body.isSuperAdmin === true },
    };
  }

  const suppliedReason = typeof body?.reason === "string" ? body.reason : "";
  if (response.status === 401 || response.status === 403 || (response.ok && body?.authenticated === false)) {
    const fallback: AdminUnauthenticatedReason =
      response.status === 401 ? "session_expired" : response.status === 403 ? "wrong_portal" : "invalid_session";
    const reason = unauthenticatedReasons.has(suppliedReason as AdminUnauthenticatedReason)
      ? (suppliedReason as AdminUnauthenticatedReason)
      : fallback;
    return { kind: "unauthenticated", reason };
  }

  return { kind: "unavailable", status: response.status };
}

async function fetchAdminSession(signal?: AbortSignal): Promise<AdminSessionResult> {
  try {
    const response = await fetch("/api/admin/session", {
      credentials: "include",
      cache: "no-store",
      signal,
    });
    return await adminSessionResultFromResponse(response);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { kind: "unavailable", status: 0 };
  }
}

function fullAdminReturnPath(pathname: string): string {
  if (typeof window === "undefined") return pathname || "/admin";
  return `${pathname || "/admin"}${window.location.search}${window.location.hash}`;
}

function loginDestination(pathname: string, reason: AdminUnauthenticatedReason): string {
  const next = encodeURIComponent(fullAdminReturnPath(pathname));
  return `/admin/login?next=${next}&reason=${encodeURIComponent(reason)}`;
}

function publishSessionTransition() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ADMIN_SESSION_TRANSITION_KEY, `${Date.now()}:${crypto.randomUUID()}`);
  } catch {
    // Storage can be unavailable; the current tab is already purged and the
    // server cookie remains the cross-tab source of truth on the next request.
  }
}

export function createAdminLogoutCommand(client: QueryClient): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    const flight = (async () => {
      await apiRequest("POST", "/api/admin/logout");
      await transitionAdminPrincipal(client, null);
      publishSessionTransition();
    })();
    pending = flight;
    void flight.then(
      () => {
        if (pending === flight) pending = null;
      },
      () => {
        if (pending === flight) pending = null;
      }
    );
    return flight;
  };
}

function LoadingBoundary() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center" data-testid="admin-session-checking">
      <div className="animate-pulse">
        <div className="h-8 bg-[#D4AF37]/10 rounded w-32 mx-auto" />
      </div>
    </div>
  );
}

function UnavailableBoundary({ retry }: { retry: () => void }) {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-6" data-testid="admin-session-unavailable">
      <div className="max-w-md text-center text-white">
        <h1 className="text-xl font-semibold">Admin session could not be verified</h1>
        <p className="mt-3 text-sm text-white/70">
          Protected tools remain locked until the session authority responds. No logout or cache transition was claimed.
        </p>
        <button type="button" className="admin-btn mt-5" onClick={retry} data-testid="button-admin-session-retry">
          Retry verification
        </button>
      </div>
    </div>
  );
}

export function AdminSessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [pathname, navigate] = useLocation();
  const protectedLocation = isProtectedAdminLocation(pathname);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const [state, setState] = useState<AdminSessionState>(() =>
    protectedLocation ? { status: "checking", principal: null } : { status: "inactive", principal: null }
  );
  const [retryVersion, setRetryVersion] = useState(0);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const logoutInFlightRef = useRef(false);
  const verificationRef = useRef<Promise<void> | null>(null);
  const verificationSequenceRef = useRef(0);
  const verificationQueuedRef = useRef(false);
  const lastProtectedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyUnauthenticated = useCallback(
    async (reason: AdminUnauthenticatedReason, sequence: number) => {
      await transitionAdminPrincipal(queryClient, null);
      if (
        sequence !== verificationSequenceRef.current ||
        !mountedRef.current ||
        !isProtectedAdminLocation(pathnameRef.current)
      ) {
        return;
      }
      publishSessionTransition();
      setState({ status: "checking", principal: null });
      const currentPath = pathnameRef.current;
      if (isProtectedAdminLocation(currentPath)) {
        navigate(loginDestination(currentPath, reason), { replace: true });
      }
    },
    [navigate, queryClient]
  );

  const performVerification = useCallback(
    async (sequence: number) => {
      const result = await fetchAdminSession();
      if (
        sequence !== verificationSequenceRef.current ||
        !mountedRef.current ||
        !isProtectedAdminLocation(pathnameRef.current)
      ) {
        return;
      }
      if (result.kind === "authenticated") {
        await transitionAdminPrincipal(queryClient, result.principal);
        if (
          sequence === verificationSequenceRef.current &&
          mountedRef.current &&
          isProtectedAdminLocation(pathnameRef.current)
        ) {
          setState({ status: "authenticated", principal: result.principal });
        }
        return;
      }
      if (result.kind === "unauthenticated") {
        await applyUnauthenticated(result.reason, sequence);
        return;
      }
      if (sequence === verificationSequenceRef.current) {
        setState((current) => ({ status: "unavailable", principal: current.principal }));
      }
    },
    [applyUnauthenticated, queryClient]
  );

  const verify = useCallback(
    (blocking: boolean, supersede = false) => {
      if (logoutInFlightRef.current) return verificationRef.current ?? Promise.resolve();
      if (blocking && mountedRef.current) {
        setState((current) => ({ status: "checking", principal: current.principal }));
      }

      const current = verificationRef.current;
      if (current && !supersede) return current;
      if (current && verificationQueuedRef.current) return current;

      const sequence = ++verificationSequenceRef.current;
      const flight = current
        ? current.catch(() => undefined).then(() => {
            verificationQueuedRef.current = false;
            return performVerification(sequence);
          })
        : performVerification(sequence);
      if (current) verificationQueuedRef.current = true;
      verificationRef.current = flight;
      void flight.then(
        () => {
          if (verificationRef.current === flight) verificationRef.current = null;
        },
        () => {
          if (verificationRef.current === flight) verificationRef.current = null;
        }
      );
      return flight;
    },
    [performVerification]
  );

  useEffect(() => {
    if (!protectedLocation) {
      lastProtectedRef.current = false;
      logoutInFlightRef.current = false;
      setState({ status: "inactive", principal: null });
      if (getActiveAdminPrincipal() !== null) void transitionAdminPrincipal(queryClient, null);
      return;
    }

    const enteringProtectedArea = !lastProtectedRef.current || getActiveAdminPrincipal() === null;
    lastProtectedRef.current = true;
    if (enteringProtectedArea || retryVersion > 0) void verify(true);
  }, [protectedLocation, queryClient, retryVersion, verify]);

  useEffect(() => subscribeAdminUnauthorized(() => void verify(true, true)), [verify]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ADMIN_SESSION_TRANSITION_KEY || !isProtectedAdminLocation(pathnameRef.current)) return;
      verificationSequenceRef.current += 1;
      setState((current) => ({ status: "checking", principal: current.principal }));
      void transitionAdminPrincipal(queryClient, null).then(() => verify(true, true));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [queryClient, verify]);

  useEffect(() => {
    if (!protectedLocation) return;
    const onFocus = () => void verify(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [protectedLocation, verify]);

  const logoutCommand = useMemo(() => createAdminLogoutCommand(queryClient), [queryClient]);
  const logout = useCallback(() => {
    if (logoutInFlightRef.current) return logoutCommand();
    logoutInFlightRef.current = true;
    verificationSequenceRef.current += 1;
    setLogoutPending(true);
    setLogoutError(null);
    const flight = logoutCommand();
    void flight.then(
      () => {
        if (!mountedRef.current) return;
        setLogoutPending(false);
        setState({ status: "inactive", principal: null });
        navigate("/admin/login", { replace: true });
      },
      (error: unknown) => {
        if (!mountedRef.current) return;
        logoutInFlightRef.current = false;
        setLogoutPending(false);
        setLogoutError(error instanceof Error ? error.message : "Logout failed");
      }
    );
    return flight;
  }, [logoutCommand, navigate]);

  const value = useMemo<AdminSessionContextValue>(
    () => ({
      ...state,
      logout,
      logoutPending,
      logoutError,
      retry: () => setRetryVersion((version) => version + 1),
    }),
    [logout, logoutError, logoutPending, state]
  );

  if (protectedLocation && (state.status === "inactive" || state.status === "checking")) {
    return <LoadingBoundary />;
  }
  if (protectedLocation && state.status === "unavailable") {
    return <UnavailableBoundary retry={value.retry} />;
  }

  const principalRenderKey =
    state.status === "authenticated"
      ? `${state.principal.email}:${state.principal.isSuperAdmin ? "super-admin" : "admin"}`
      : state.status;
  return (
    <AdminSessionContext.Provider key={principalRenderKey} value={value}>
      {children}
    </AdminSessionContext.Provider>
  );
}

export function useAdminSession(): AdminSessionContextValue {
  const value = useContext(AdminSessionContext);
  if (!value) throw new Error("useAdminSession must be used within AdminSessionProvider");
  return value;
}
