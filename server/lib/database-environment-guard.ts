import crypto from "node:crypto";

export type MintVaultRuntimeEnvironment = "production" | "staging" | "development" | "test";

const KNOWN_PRODUCTION_DATABASE_FINGERPRINTS = new Set([
  // 2026-08-21 staging/prod isolation incident: local/shared Neon identity reached by unsafe smoke.
  "17e145a9253b49e2",
  // 2026-08-21 live production Fly MINTVAULT_DATABASE_URL identity, read without exposing the URL.
  "5524f445d51c6a30",
]);

export function mintVaultDatabaseIdentity(raw: string, variable = "MINTVAULT_DATABASE_URL"): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a valid PostgreSQL connection URL.`);
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error(`${variable} must identify a PostgreSQL host and database.`);
  }
  const port = parsed.port || "5432";
  const hostname = normalizeDatabaseHostname(parsed.hostname);
  return `postgresql://${hostname}:${port}${parsed.pathname}`;
}

export function mintVaultDatabaseFingerprint(raw: string, variable = "MINTVAULT_DATABASE_URL"): string {
  return fingerprintIdentity(mintVaultDatabaseIdentity(raw, variable));
}

export function fingerprintIdentity(identity: string): string {
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

export function classifyMintVaultRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env
): MintVaultRuntimeEnvironment {
  const explicit = env.MINTVAULT_RUNTIME_ENV?.trim().toLowerCase();
  if (explicit === "production" || explicit === "staging" || explicit === "development" || explicit === "test") {
    return explicit;
  }
  if (env.NODE_ENV === "test" || env.VITEST === "true") return "test";
  const appName = env.FLY_APP_NAME ?? "";
  const vaultVersion = env.VAULT_VERSION ?? "";
  const appUrl = env.APP_URL ?? "";
  if (appName === "mintvault-v2" || vaultVersion === "v2" || appUrl.includes("mintvault-v2.fly.dev")) {
    return "staging";
  }
  if (env.NODE_ENV === "production") return "production";
  return "development";
}

export function assertMintVaultDatabaseEnvironmentSafety(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  variable = "MINTVAULT_DATABASE_URL"
): { runtime: MintVaultRuntimeEnvironment; fingerprint: string } {
  const runtime = classifyMintVaultRuntimeEnvironment(env);
  const fingerprint = mintVaultDatabaseFingerprint(databaseUrl, variable);
  const configuredProductionFingerprint = normalizeFingerprint(env.MINTVAULT_PRODUCTION_DATABASE_FINGERPRINT);
  const configuredStagingFingerprint = normalizeFingerprint(env.MINTVAULT_STAGING_DATABASE_FINGERPRINT);
  const productionFingerprints = new Set(KNOWN_PRODUCTION_DATABASE_FINGERPRINTS);
  if (configuredProductionFingerprint) productionFingerprints.add(configuredProductionFingerprint);

  if (runtime !== "production" && productionFingerprints.has(fingerprint)) {
    throw new Error(
      `[database-guard] Refusing ${runtime} startup: ${variable} fingerprint ${fingerprint} is a production database identity. Configure an isolated database before booting this runtime.`
    );
  }

  if (runtime === "staging" && configuredStagingFingerprint && fingerprint !== configuredStagingFingerprint) {
    throw new Error(
      `[database-guard] Refusing staging startup: ${variable} fingerprint ${fingerprint} does not match MINTVAULT_STAGING_DATABASE_FINGERPRINT.`
    );
  }

  if (
    runtime === "production" &&
    configuredProductionFingerprint &&
    fingerprint !== configuredProductionFingerprint
  ) {
    throw new Error(
      `[database-guard] Refusing production startup: ${variable} fingerprint ${fingerprint} does not match MINTVAULT_PRODUCTION_DATABASE_FINGERPRINT.`
    );
  }

  return { runtime, fingerprint };
}

function normalizeDatabaseHostname(hostname: string): string {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized.endsWith(".neon.tech")) return normalized;
  const labels = normalized.split(".");
  if (labels[0]?.endsWith("-pooler")) labels[0] = labels[0].slice(0, -"-pooler".length);
  return labels.join(".");
}

function normalizeFingerprint(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[0-9a-f]{16,64}$/.test(trimmed)) {
    throw new Error("[database-guard] Database fingerprint configuration is malformed.");
  }
  return trimmed.slice(0, 16);
}
