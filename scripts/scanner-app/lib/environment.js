/**
 * THE SCANNER'S ENVIRONMENT AUTHORITY.
 *
 * WHY THIS EXISTS. The API target used to be derived, not declared:
 *
 *   API_BASE = process.env.MINTVAULT_API_BASE
 *           || env.MINTVAULT_API_BASE
 *           || baseFromLegacyIngestUrl(MINTVAULT_INGEST_URL)
 *           || "https://mintvaultuk.com";
 *
 * Every branch was a guess, and the LAST branch guessed PRODUCTION. On 2026-08-17 a staging
 * station was relaunched without `MINTVAULT_API_BASE` in its process environment; the chain fell
 * through to a legacy `~/.mintvault-scanner.env` written in June that named the production ingest
 * URL, and the Mac silently began authenticating against mintvaultuk.com. Its station identity and
 * operator account exist only on staging, so every request was refused — and the failure surfaced
 * to the operator as "sign-in failed", i.e. as a password problem. Forty-four rejected requests
 * reached production before anyone knew the target had moved.
 *
 * The bug was not the missing variable. The bug was that a MISSING ANSWER HAD A DEFAULT, and the
 * default was the one environment where being wrong costs real money and real customer data.
 *
 * THE RULE HERE: the environment is DECLARED, never derived, and the API base is a CONSEQUENCE of
 * the declaration rather than an independent input. Two things follow.
 *
 *   1. NO DEFAULT. An unconfigured station resolves to `unconfigured` and refuses to sign in or
 *      capture. "I do not know which MintVault this is" and "this is production" are different
 *      statements, and only the first one is true.
 *
 *   2. THE URL MUST AGREE. `MINTVAULT_API_BASE` is still honoured for local development, but it is
 *      now CHECKED against the declared environment instead of replacing it. A station declaring
 *      STAGING while pointed at mintvaultuk.com is refused in both directions — that combination
 *      is the incident above, and it should be impossible to hold.
 *
 * The declaration is persisted next to the station identity and survives restart, because a target
 * that depends on how the process happened to be launched is exactly what failed.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/*
 * The canonical deployments. The API base is derived from the environment, never the reverse, so
 * these two strings are the only places a hostname is decided.
 */
const ENVIRONMENTS = Object.freeze({
  staging: Object.freeze({
    id: "staging",
    label: "STAGING",
    apiBase: "https://mintvault-v2.fly.dev",
  }),
  production: Object.freeze({
    id: "production",
    label: "PRODUCTION",
    apiBase: "https://mintvaultuk.com",
  }),
});

// Same per-instance isolation as station-identity.js and state.js, so a test instance never
// clobbers the live station's declaration.
const SUPPORT = process.env.MINTVAULT_SCANS_DIR
  ? path.join(process.env.MINTVAULT_SCANS_DIR, "app-state")
  : path.join(os.homedir(), "Library", "Application Support", "MintVaultScanner");
const ENVIRONMENT_FILE = path.join(SUPPORT, "environment.json");

function normaliseId(value) {
  const raw = String(value == null ? "" : value).trim().toLowerCase();
  if (raw === "staging" || raw === "stage") return "staging";
  if (raw === "production" || raw === "prod") return "production";
  return null;
}

function hostOf(value) {
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The persisted declaration, or null when the station has never been told which MintVault it is. */
function readPersisted() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ENVIRONMENT_FILE, "utf8"));
    return normaliseId(parsed?.environment);
  } catch {
    return null;
  }
}

/**
 * Persist the declaration. Written atomically via a temp file and rename, so a crash mid-write
 * cannot leave a truncated file that reads back as "unconfigured" and strands the station.
 */
function persistEnvironment(value) {
  const id = normaliseId(value);
  if (!id) throw new Error(`Unknown MintVault environment: ${String(value)}`);
  fs.mkdirSync(SUPPORT, { recursive: true });
  const tmp = `${ENVIRONMENT_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ environment: id }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, ENVIRONMENT_FILE);
  return id;
}

/**
 * Resolve the environment. Declaration order — an explicit process variable wins so a developer can
 * run against a local server without rewriting the station's persisted identity, then the persisted
 * file, then nothing.
 *
 * Returns a descriptor that ALWAYS states its own validity. Callers must check `ok` — there is no
 * usable `apiBase` on a failed resolution, deliberately, so a caller that forgets cannot silently
 * fall back to a hostname.
 */
function resolveEnvironment(overrides = {}) {
  const env = overrides.env || process.env;
  const declared = normaliseId(env.MINTVAULT_ENV) || readPersisted();
  const rawOverride = env.MINTVAULT_API_BASE ? String(env.MINTVAULT_API_BASE).replace(/\/$/, "") : null;

  /*
   * AN EXPLICIT NON-CANONICAL URL IS ITSELF A DECLARATION.
   *
   * A developer pointing at http://127.0.0.1:5000 has said exactly where they mean, and no chain of
   * guesses is involved — which is the only thing this module exists to prevent. Refusing it would
   * be safety theatre: it cannot reach either real MintVault.
   *
   * A canonical host is different. `MINTVAULT_API_BASE=https://mintvaultuk.com` on a station with
   * no declared environment is precisely the ambiguity that caused the incident, so it still falls
   * through to the checks below and is refused without a matching declaration.
   */
  if (rawOverride && !declared) {
    const overrideHost = hostOf(rawOverride);
    const namesCanonical = Object.values(ENVIRONMENTS).some((e) => hostOf(e.apiBase) === overrideHost);
    if (!namesCanonical) {
      return {
        ok: true,
        code: "OK",
        environment: "development",
        label: "DEVELOPMENT",
        apiBase: rawOverride,
        overridden: true,
      };
    }
  }

  if (!declared) {
    return {
      ok: false,
      code: "ENVIRONMENT_UNCONFIGURED",
      environment: null,
      label: "UNCONFIGURED",
      apiBase: null,
      message:
        "This Scanner has not been told which MintVault it belongs to. Choose STAGING or PRODUCTION " +
        "in Service & Diagnostics before signing in. It will not guess.",
    };
  }

  const descriptor = ENVIRONMENTS[declared];
  const override = env.MINTVAULT_API_BASE ? String(env.MINTVAULT_API_BASE).replace(/\/$/, "") : null;

  if (override) {
    const overrideHost = hostOf(override);
    const canonicalHost = hostOf(descriptor.apiBase);
    const otherEnvironment = Object.values(ENVIRONMENTS).find((e) => hostOf(e.apiBase) === overrideHost);

    /*
     * A URL naming the OTHER canonical deployment is the incident this module exists to stop, and
     * it is refused whichever way round it points. An unrecognised host (localhost, a preview box)
     * is allowed through, because that is a developer pointing somewhere deliberate rather than a
     * station drifting between the two real MintVaults.
     */
    if (otherEnvironment && overrideHost !== canonicalHost) {
      return {
        ok: false,
        code: "ENVIRONMENT_URL_MISMATCH",
        environment: declared,
        label: descriptor.label,
        apiBase: null,
        message:
          `This Scanner is configured as ${descriptor.label} but MINTVAULT_API_BASE points at ` +
          `${overrideHost} (${otherEnvironment.label}). Refusing to sign in or capture until they agree — ` +
          `a ${descriptor.label} station must never talk to ${otherEnvironment.label}.`,
      };
    }

    return { ok: true, code: "OK", environment: declared, label: descriptor.label, apiBase: override, overridden: true };
  }

  return { ok: true, code: "OK", environment: declared, label: descriptor.label, apiBase: descriptor.apiBase, overridden: false };
}

/**
 * The API base, or a thrown error. For call sites that cannot express "unconfigured" and would
 * otherwise be tempted to substitute a hostname.
 */
function requireApiBase(overrides = {}) {
  const resolved = resolveEnvironment(overrides);
  if (!resolved.ok) {
    const error = new Error(resolved.message);
    error.code = resolved.code;
    throw error;
  }
  return resolved.apiBase;
}

module.exports = {
  ENVIRONMENTS,
  ENVIRONMENT_FILE,
  resolveEnvironment,
  requireApiBase,
  persistEnvironment,
  _private: { normaliseId, readPersisted, hostOf },
};
