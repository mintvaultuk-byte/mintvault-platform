/**
 * Phase 0.5 — Database host policy.
 *
 * Fail-closed classification of a database URL's host. `db:push` (destructive-capable
 * schema sync) is permitted ONLY against a local/disposable host. Any non-local host is a
 * protected real database and is BLOCKED with NO override — production/staging schema
 * change goes exclusively through the numbered migration runner (npm run db:migrate).
 *
 * There is deliberately no bypass env var: a single environment variable (or any variable)
 * must never authorise a non-local db:push. No production hostname is hardcoded — the
 * boundary is purely "local vs not local".
 *
 * URL handling covers postgres:// and postgresql://, percent-encoded credentials, bracketed
 * IPv6 literals, and empty-host unix-socket URLs (host in the `host=` query param).
 */

/** Loopback / disposable hosts. IPv6 loopback appears as "[::1]" -> hostname "::1". */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);

export interface HostVerdict {
  host: string;
  isLocal: boolean;
  allowedForPush: boolean;
  reason: string;
}

function normaliseHost(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // unwrap bracketed IPv6
  return h;
}

/** Extract the effective host, including the unix-socket `host=` query form (empty URL host). */
function extractHost(u: URL): string {
  if (u.hostname && u.hostname.length > 0) return normaliseHost(u.hostname);
  // Unix-domain socket form: postgresql:///db?host=/var/run/postgresql
  const qHost = u.searchParams.get("host");
  if (qHost) return normaliseHost(qHost);
  return "";
}

function isUnixSocketPath(host: string): boolean {
  // A filesystem path (starts with "/") is a local unix socket directory.
  return host.startsWith("/");
}

export function classifyDbHost(databaseUrl: string | undefined): HostVerdict {
  if (!databaseUrl || databaseUrl.trim() === "") {
    return { host: "(unset)", isLocal: false, allowedForPush: false, reason: "No database URL provided — fail closed." };
  }
  let u: URL;
  try {
    u = new URL(databaseUrl);
  } catch {
    return { host: "(unparseable)", isLocal: false, allowedForPush: false, reason: "Database URL did not parse — fail closed." };
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    return { host: u.protocol, isLocal: false, allowedForPush: false, reason: `Unexpected protocol "${u.protocol}" — fail closed.` };
  }
  const host = extractHost(u);
  if (host === "") {
    return { host: "(ambiguous)", isLocal: false, allowedForPush: false, reason: "Could not determine host — fail closed." };
  }
  const isLocal = LOCAL_HOSTS.has(host) || isUnixSocketPath(host);
  return {
    host,
    isLocal,
    allowedForPush: isLocal,
    reason: isLocal
      ? "Local/disposable host — db:push permitted."
      : "Non-local host — a real (staging/production) database. db:push is blocked; use db:migrate.",
  };
}
