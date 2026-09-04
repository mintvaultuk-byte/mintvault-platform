import { QueryClient, hashKey, type QueryFunction, type QueryKey } from "@tanstack/react-query";

const ADMIN_QUERY_HASH_PREFIX = "admin-principal:";
const ADMIN_CREDENTIAL_REJECTED_CODE = "admin_credential_rejected";

type AdminUnauthorizedPolicy = "revalidate-session" | "credential-rejection-aware";

export type AdminPrincipalScope = {
  email: string;
  isSuperAdmin: boolean;
};

let activeAdminPrincipal: AdminPrincipalScope | null = null;
let adminPrincipalTransitionSequence = 0;

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly requestUrl: string;

  constructor(message: string, status: number, body: unknown, requestUrl: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.requestUrl = requestUrl;
  }
}

type AdminUnauthorizedListener = (error: ApiError) => void;
const adminUnauthorizedListeners = new Set<AdminUnauthorizedListener>();

export function subscribeAdminUnauthorized(listener: AdminUnauthorizedListener): () => void {
  adminUnauthorizedListeners.add(listener);
  return () => adminUnauthorizedListeners.delete(listener);
}

function publishAdminUnauthorized(error: ApiError) {
  if (activeAdminPrincipal === null) return;
  for (const listener of adminUnauthorizedListeners) listener(error);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function isProtectedAdminLocation(pathname: string): boolean {
  if (pathname === "/admin/login" || pathname.startsWith("/admin/login/")) return false;
  if (/^\/admin\/cert\/[^/]+\/?$/.test(pathname)) return false;
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/**
 * Fetch authority for protected Admin callsites that need to handle their own
 * response bodies (uploads, downloads, or legacy domain-specific errors). It
 * preserves the native Response contract while making a 401 observable by the
 * session authority. The session endpoint itself deliberately uses native
 * fetch so verification cannot recursively trigger another verification.
 */
export type AdminFetchInit = RequestInit & {
  adminUnauthorizedPolicy?: AdminUnauthorizedPolicy;
};

export async function adminFetch(input: RequestInfo | URL, init?: AdminFetchInit): Promise<Response> {
  const { adminUnauthorizedPolicy = "revalidate-session", ...requestInit } = init ?? {};
  const response = await fetch(input, requestInit);
  if (
    response.status === 401 &&
    activeAdminPrincipal !== null &&
    typeof window !== "undefined" &&
    isProtectedAdminLocation(window.location.pathname)
  ) {
    const error = await apiErrorFromResponse(response.clone(), requestUrl(input));
    if (adminUnauthorizedPolicy === "credential-rejection-aware" && isAdminCredentialRejection(error)) {
      return response;
    }
    publishAdminUnauthorized(error);
    throw error;
  }
  return response;
}

function errorMessage(body: unknown, status: number, text: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object") {
      const nested = (error as { message?: unknown }).message;
      if (typeof nested === "string" && nested.trim()) return nested;
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return text.trim() || `${status}: Request failed`;
}

async function apiErrorFromResponse(res: Response, requestUrl: string): Promise<ApiError> {
  const text = (await res.text()) || res.statusText;
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON errors remain available through the typed message.
  }
  return new ApiError(errorMessage(body, res.status, text), res.status, body, requestUrl);
}

function isAdminCredentialRejection(error: ApiError): boolean {
  return (
    error.body !== null &&
    typeof error.body === "object" &&
    (error.body as { code?: unknown }).code === ADMIN_CREDENTIAL_REJECTED_CODE
  );
}

export async function throwIfResNotOk(
  res: Response,
  requestUrl = res.url || "unknown request",
  adminUnauthorizedPolicy: AdminUnauthorizedPolicy = "revalidate-session",
) {
  if (res.ok) return;

  const error = await apiErrorFromResponse(res, requestUrl);
  if (
    res.status === 401 &&
    !(adminUnauthorizedPolicy === "credential-rejection-aware" && isAdminCredentialRejection(error))
  ) {
    publishAdminUnauthorized(error);
  }
  throw error;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
  options?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    adminUnauthorizedPolicy?: AdminUnauthorizedPolicy;
  },
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: { ...(data !== undefined ? { "Content-Type": "application/json" } : {}), ...options?.headers },
    body: data !== undefined ? JSON.stringify(data) : undefined,
    credentials: "include",
    signal: options?.signal,
  });

  await throwIfResNotOk(res, url, options?.adminUnauthorizedPolicy);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";

/**
 * Public anonymous queries may deliberately model a 401 as `null`. Once the
 * server has established an Admin principal, the same response is always a
 * typed error and asks the Admin session authority to revalidate. Domain data
 * therefore never changes from an array/object into `null` on session expiry.
 */
export function getQueryFn<T>(options: { on401: UnauthorizedBehavior }): QueryFunction<T | null> {
  return async ({ queryKey, signal }) => {
    const requestUrl = queryKey.join("/");
    const res = await fetch(requestUrl, {
      credentials: "include",
      signal,
    });

    if (
      options.on401 === "returnNull" &&
      res.status === 401 &&
      (activeAdminPrincipal === null || !isAdminProtectedQueryKey(queryKey))
    ) {
      return null;
    }

    await throwIfResNotOk(res, requestUrl);
    return (await res.json()) as T;
  };
}

export function getActiveAdminPrincipal(): AdminPrincipalScope | null {
  return activeAdminPrincipal;
}

const PUBLIC_ADMIN_VIEW_QUERY_KEYS = new Set([
  "/api/capacity",
  "/api/catalogue/snapshot",
  "/api/config/public-flags",
  "/api/promotions/active",
  "/api/service-tiers",
]);

/**
 * Admin screens contain helper-generated and semantic keys as well as URL
 * keys. Treat keys as protected by default while an Admin principal is active;
 * only explicit public projections keep the ordinary shared hash.
 */
export function isAdminProtectedQueryKey(queryKey: QueryKey): boolean {
  const first = queryKey[0];
  if (first === "public") return false;
  if (typeof first === "string" && PUBLIC_ADMIN_VIEW_QUERY_KEYS.has(first)) return false;
  return true;
}

export function scopedQueryHash(queryKey: QueryKey): string {
  const queryHash = hashKey(queryKey);
  if (activeAdminPrincipal === null || !isAdminProtectedQueryKey(queryKey)) return queryHash;
  return `${ADMIN_QUERY_HASH_PREFIX}${hashKey([
    activeAdminPrincipal.email,
    activeAdminPrincipal.isSuperAdmin,
  ])}:${queryHash}`;
}

export function isAdminPrincipalQuery(query: { queryHash: string }): boolean {
  return query.queryHash.startsWith(ADMIN_QUERY_HASH_PREFIX);
}

/**
 * Principal changes are ordered: stop old work, remove every principal-owned
 * query and mutation record, and only then publish the next identity. Public
 * query records keep their ordinary hash and survive this transition.
 */
export async function transitionAdminPrincipal(
  client: QueryClient,
  nextPrincipal: AdminPrincipalScope | null,
): Promise<void> {
  const normalized = nextPrincipal
    ? { email: nextPrincipal.email.trim().toLowerCase(), isSuperAdmin: nextPrincipal.isSuperAdmin === true }
    : null;
  if (
    normalized?.email === activeAdminPrincipal?.email &&
    normalized?.isSuperAdmin === activeAdminPrincipal?.isSuperAdmin
  ) {
    return;
  }
  const sequence = ++adminPrincipalTransitionSequence;

  await client.cancelQueries({ predicate: isAdminPrincipalQuery });
  // A newer transition may finish while cancellation is in flight. A stale
  // request must never reset/remove records that belong to the newer scope.
  if (sequence !== adminPrincipalTransitionSequence) return;
  for (const query of client.getQueryCache().findAll({ predicate: isAdminPrincipalQuery })) {
    // Removing an active Query leaves its observer holding the last result.
    // Reset first so mounted consumers cannot retain principal A's payload
    // while the provider remounts them under principal B's hash.
    query.reset();
  }
  client.removeQueries({ predicate: isAdminPrincipalQuery });
  client.getMutationCache().clear();
  activeAdminPrincipal = normalized;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      queryKeyHashFn: scopedQueryHash,
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: (query) => (isAdminPrincipalQuery(query) ? 0 : Infinity),
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
