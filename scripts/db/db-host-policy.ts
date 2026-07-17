/**
 * Phase 0.5 — Database host policy.
 *
 * Fail-closed classification of a database URL's host. `db:push` (destructive-capable
 * schema sync) is permitted ONLY against a local/disposable host. Any non-local host is
 * treated as a protected real database and blocked unless an explicit dangerous override
 * is set. No production hostname is hardcoded — the boundary is "local vs not local".
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export interface HostVerdict {
  host: string;
  isLocal: boolean;
  allowedForPush: boolean;
  reason: string;
}

export function classifyDbHost(databaseUrl: string | undefined): HostVerdict {
  if (!databaseUrl) {
    return { host: "(unset)", isLocal: false, allowedForPush: false, reason: "No database URL provided — fail closed." };
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return { host: "(unparseable)", isLocal: false, allowedForPush: false, reason: "Database URL did not parse — fail closed." };
  }
  const isLocal = LOCAL_HOSTS.has(host);
  return {
    host,
    isLocal,
    allowedForPush: isLocal,
    reason: isLocal
      ? "Local/disposable host — db:push permitted."
      : "Non-local host — treated as a real (staging/production) database. db:push is blocked.",
  };
}

/** Whether the dangerous override is explicitly and correctly set. */
export function dangerousOverrideEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_DANGEROUS_DB_PUSH === "i-understand-this-can-drop-live-tables";
}
