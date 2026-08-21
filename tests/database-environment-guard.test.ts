import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertMintVaultDatabaseEnvironmentSafety,
  classifyMintVaultRuntimeEnvironment,
  mintVaultDatabaseFingerprint,
} from "../server/lib/database-environment-guard";

const ENV_KEYS = [
  "APP_URL",
  "FLY_APP_NAME",
  "MINTVAULT_DATABASE_URL",
  "MINTVAULT_PRODUCTION_DATABASE_FINGERPRINT",
  "MINTVAULT_RUNTIME_ENV",
  "MINTVAULT_STAGING_DATABASE_FINGERPRINT",
  "NODE_ENV",
  "VAULT_VERSION",
  "VITEST",
] as const;

const PROD_INCIDENT_URL =
  "postgresql://owner:super-secret@ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";

describe("MintVault database environment guard", () => {
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      previous.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
  });

  it("fingerprints a meaningful DB identity without credentials, query params, or Neon pooler routing", () => {
    const direct =
      "postgresql://app:secret@ep-green-brook-123.eu-west-2.aws.neon.tech/mintvault?sslmode=require";
    const pooled =
      "postgres://other:another-secret@ep-green-brook-123-pooler.eu-west-2.aws.neon.tech:5432/mintvault?application_name=x";

    expect(mintVaultDatabaseFingerprint(direct)).toBe(mintVaultDatabaseFingerprint(pooled));
  });

  it("allows production runtime to use the configured production database identity", () => {
    const fingerprint = mintVaultDatabaseFingerprint(PROD_INCIDENT_URL);
    const result = assertMintVaultDatabaseEnvironmentSafety(PROD_INCIDENT_URL, {
      MINTVAULT_RUNTIME_ENV: "production",
      MINTVAULT_PRODUCTION_DATABASE_FINGERPRINT: fingerprint,
    });

    expect(result).toEqual({ runtime: "production", fingerprint });
  });

  it("refuses staging when the DB identity is production, with no secret material in the error", () => {
    expect(() =>
      assertMintVaultDatabaseEnvironmentSafety(PROD_INCIDENT_URL, {
        FLY_APP_NAME: "mintvault-v2",
        NODE_ENV: "production",
        VAULT_VERSION: "v2",
      })
    ).toThrow(/Refusing staging startup/);

    try {
      assertMintVaultDatabaseEnvironmentSafety(PROD_INCIDENT_URL, {
        FLY_APP_NAME: "mintvault-v2",
        NODE_ENV: "production",
        VAULT_VERSION: "v2",
      });
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain("super-secret");
      expect(message).not.toContain("ep-purple-voice");
      expect(message).not.toContain("neondb");
      expect(message).not.toContain("sslmode");
    }
  });

  it("allows staging when the isolated staging fingerprint is pinned and distinct from production", () => {
    const stagingUrl =
      "postgresql://staging:secret@ep-staging-branch-123.eu-west-2.aws.neon.tech/mintvault_staging?sslmode=require";
    const stagingFingerprint = mintVaultDatabaseFingerprint(stagingUrl);

    expect(() =>
      assertMintVaultDatabaseEnvironmentSafety(stagingUrl, {
        FLY_APP_NAME: "mintvault-v2",
        NODE_ENV: "production",
        MINTVAULT_STAGING_DATABASE_FINGERPRINT: stagingFingerprint,
        MINTVAULT_PRODUCTION_DATABASE_FINGERPRINT: mintVaultDatabaseFingerprint(PROD_INCIDENT_URL),
      })
    ).not.toThrow();
  });

  it("refuses staging when the DB identity does not match the pinned staging fingerprint", () => {
    const stagingUrl =
      "postgresql://staging:secret@ep-staging-branch-123.eu-west-2.aws.neon.tech/mintvault_staging";
    const otherStagingUrl =
      "postgresql://staging:secret@ep-other-staging-456.eu-west-2.aws.neon.tech/mintvault_staging";

    expect(() =>
      assertMintVaultDatabaseEnvironmentSafety(stagingUrl, {
        FLY_APP_NAME: "mintvault-v2",
        NODE_ENV: "production",
        MINTVAULT_STAGING_DATABASE_FINGERPRINT: mintVaultDatabaseFingerprint(otherStagingUrl),
      })
    ).toThrow(/does not match MINTVAULT_STAGING_DATABASE_FINGERPRINT/);
  });

  it("refuses normal development and test startup when MINTVAULT_DATABASE_URL names production", async () => {
    process.env.MINTVAULT_DATABASE_URL = PROD_INCIDENT_URL;
    process.env.NODE_ENV = "development";

    const { getDatabaseUrl } = await import("../server/config");
    expect(getDatabaseUrl).toThrow(/Refusing development startup/);

    expect(() =>
      assertMintVaultDatabaseEnvironmentSafety(PROD_INCIDENT_URL, {
        NODE_ENV: "test",
        VITEST: "true",
      })
    ).toThrow(/Refusing test startup/);
  });

  it("names the offending variable so every partner pool is covered, not just MINTVAULT_DATABASE_URL", () => {
    // server/partner/db.ts and server/partner/connector-db.ts open their own pg.Pool straight from
    // process.env. If the guard only covered MINTVAULT_DATABASE_URL, staging could be repointed at
    // an isolated branch for the main pool while the partner pools still opened the shared/production
    // identity — isolation on 1 of 5 connections. Each caller passes its own variable name.
    for (const variable of [
      "PARTNER_DATABASE_URL",
      "PARTNER_ADMIN_DATABASE_URL",
      "PARTNER_CONNECTOR_DATABASE_URL",
    ]) {
      expect(() =>
        assertMintVaultDatabaseEnvironmentSafety(
          PROD_INCIDENT_URL,
          { FLY_APP_NAME: "mintvault-v2", NODE_ENV: "production" } as NodeJS.ProcessEnv,
          variable
        )
      ).toThrow(new RegExp(`Refusing staging startup: ${variable} fingerprint`));
    }
  });

  it("applies the pinned staging fingerprint to partner pools, so they cannot straddle two databases", () => {
    const stagingUrl =
      "postgresql://staging:secret@ep-staging-branch-123.eu-west-2.aws.neon.tech/neondb?sslmode=require";
    const otherUrl =
      "postgresql://staging:secret@ep-other-staging-456.eu-west-2.aws.neon.tech/neondb?sslmode=require";
    const env = {
      FLY_APP_NAME: "mintvault-v2",
      NODE_ENV: "production",
      MINTVAULT_STAGING_DATABASE_FINGERPRINT: mintVaultDatabaseFingerprint(stagingUrl),
    } as NodeJS.ProcessEnv;

    // The pooled and direct endpoints of the SAME branch fingerprint identically, so one pin
    // legitimately covers every URL — pooled main pool and direct connector pool alike.
    const pooled = stagingUrl.replace("ep-staging-branch-123", "ep-staging-branch-123-pooler");
    expect(() =>
      assertMintVaultDatabaseEnvironmentSafety(pooled, env, "PARTNER_DATABASE_URL")
    ).not.toThrow();

    // A partner pool left on a DIFFERENT branch is refused even though it is not production.
    expect(() =>
      assertMintVaultDatabaseEnvironmentSafety(otherUrl, env, "PARTNER_CONNECTOR_DATABASE_URL")
    ).toThrow(/PARTNER_CONNECTOR_DATABASE_URL fingerprint .* does not match/);
  });

  it("classifies mintvault-v2 as staging before generic NODE_ENV=production", () => {
    expect(
      classifyMintVaultRuntimeEnvironment({
        FLY_APP_NAME: "mintvault-v2",
        NODE_ENV: "production",
        VAULT_VERSION: "v2",
      })
    ).toBe("staging");
  });
});
