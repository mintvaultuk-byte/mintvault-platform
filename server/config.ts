let logged = false;

const LOOPBACK_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Local PostgreSQL containers normally do not enable TLS. Keep that exception
 * exact so remote database connections retain certificate-tolerant TLS.
 */
export function databaseSslConfig(databaseUrl: string): false | { rejectUnauthorized: false } {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return LOOPBACK_DATABASE_HOSTS.has(hostname) ? false : { rejectUnauthorized: false };
  } catch {
    return { rejectUnauthorized: false };
  }
}

export function getDatabaseUrl(): string {
  const dbUrl = process.env.MINTVAULT_DATABASE_URL;

  if (!dbUrl) {
    throw new Error("MINTVAULT_DATABASE_URL is not set");
  }

  if (!logged) {
    try {
      const parsed = new URL(dbUrl);
      console.log(
        `[config] ENV=${process.env.NODE_ENV || "development"} DB_HOST=${parsed.hostname} DB_NAME=${parsed.pathname.slice(1)} (Using MINTVAULT_DATABASE_URL)`
      );
    } catch {
      console.log(
        `[config] ENV=${process.env.NODE_ENV || "development"} (Using MINTVAULT_DATABASE_URL, unable to parse host)`
      );
    }
    logged = true;
  }

  return dbUrl;
}

/**
 * Partner Portal environment coherence (WP-1).
 *
 * `PARTNER_DATABASE_URL` is what makes mounting the partner portal POSSIBLE — server/partner/db.ts
 * refuses to open a pool without it, so its absence is the documented "portal not configured"
 * state and every /api/partner route fails closed with 503. That is a clean, supported deployment
 * and must never crash the main server.
 *
 * What is NOT coherent is a HALF-configured portal: a runtime database URL present while
 * `PARTNER_MFA_ENC_KEY` is absent. server/partner/mfa.ts throws on every encrypt/decrypt without
 * that key, so the portal would come up looking live and then fail deep inside MFA enrolment and
 * verification — the two paths a partner cannot log in without. This reports that combination so
 * the mount can refuse to serve and log it once, rather than discovering it per request.
 */
export interface PartnerPortalEnvStatus {
  /** PARTNER_DATABASE_URL is present, i.e. mounting the portal is possible at all. */
  configured: boolean;
  /** The PARTNER_* set is internally consistent (always true when `configured` is false). */
  coherent: boolean;
  /** Operator-facing description of the incoherence. Never contains a secret VALUE, only names. */
  problem?: string;
}

export function partnerPortalEnvStatus(): PartnerPortalEnvStatus {
  if (!process.env.PARTNER_DATABASE_URL) {
    return { configured: false, coherent: true };
  }
  if (!process.env.PARTNER_MFA_ENC_KEY) {
    return {
      configured: true,
      coherent: false,
      problem:
        "PARTNER_DATABASE_URL is set but PARTNER_MFA_ENC_KEY is missing — partner MFA enrolment and verification cannot work. Set PARTNER_MFA_ENC_KEY (32 bytes, hex or base64) or unset PARTNER_DATABASE_URL to run without the partner portal.",
    };
  }
  return { configured: true, coherent: true };
}
