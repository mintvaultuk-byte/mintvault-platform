import type pg from "pg";

export type PostgresTransportSecurity = false | { rejectUnauthorized: true };

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DOWNGRADE_SSL_MODES = new Set(["disable", "allow", "prefer", "no-verify", "verify-ca"]);
const AUTHORITY_SHADOW_PARAMETERS = new Set(["host", "hostaddr", "port", "database", "dbname", "user", "password"]);
const UNSUPPORTED_SSL_MATERIAL_PARAMETERS = new Set([
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslca",
  "sslcrl",
  "sslpassword",
]);

type ParsedPostgresTransport = {
  connectionString: string;
  ssl: PostgresTransportSecurity;
};

/**
 * One transport authority for every application PostgreSQL pool.
 *
 * Exact loopback hosts are the only plaintext exception used by disposable
 * tests/local development. Remote URLs always receive an explicit verified TLS
 * object, overriding node-postgres's weaker `sslmode=require` interpretation.
 * Explicit downgrade modes are rejected so a secret/config change cannot look
 * intentional while silently removing server identity verification.
 */
function parsePostgresTransport(rawUrl: string, variable: string): ParsedPostgresTransport {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL connection URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error(`${variable} must identify a PostgreSQL host and database.`);
  }

  for (const [rawName] of parsed.searchParams) {
    const name = rawName.toLowerCase();
    if (AUTHORITY_SHADOW_PARAMETERS.has(name)) {
      throw new Error(`${variable} refuses PostgreSQL URL authority-shadow parameter '${name}'.`);
    }
    if (UNSUPPORTED_SSL_MATERIAL_PARAMETERS.has(name)) {
      throw new Error(`${variable} refuses PostgreSQL URL TLS material parameter '${name}'.`);
    }
  }

  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const local = LOCAL_DATABASE_HOSTS.has(hostname);

  const sslMode = parsed.searchParams.get("sslmode")?.trim().toLowerCase();
  if (!local && sslMode && DOWNGRADE_SSL_MODES.has(sslMode)) {
    throw new Error(`${variable} refuses remote PostgreSQL TLS downgrade mode '${sslMode}'.`);
  }
  const sslFlag = parsed.searchParams.get("ssl")?.trim().toLowerCase();
  if (!local && (sslFlag === "false" || sslFlag === "0")) {
    throw new Error(`${variable} refuses remote PostgreSQL TLS disablement.`);
  }

  // node-postgres reparses connectionString after merging the explicit config,
  // so URL query parameters otherwise win over `ssl` and even URL authority.
  // Strip every SSL parser knob; the explicit object below is the sole authority.
  for (const name of [...parsed.searchParams.keys()]) {
    const normalized = name.toLowerCase();
    if (normalized.startsWith("ssl") || normalized === "uselibpqcompat") {
      parsed.searchParams.delete(name);
    }
  }

  return {
    connectionString: parsed.toString(),
    ssl: local ? false : { rejectUnauthorized: true },
  };
}

export function postgresTransportSecurity(rawUrl: string, variable: string): PostgresTransportSecurity {
  return parsePostgresTransport(rawUrl, variable).ssl;
}

export function securePostgresPoolConnection(
  rawUrl: string,
  variable: string
): Pick<pg.PoolConfig, "connectionString" | "ssl"> {
  return parsePostgresTransport(rawUrl, variable);
}
