import pg from "pg";
import { describe, expect, it } from "vitest";
import { postgresTransportSecurity, securePostgresPoolConnection } from "../server/lib/postgres-transport-security";

describe("PostgreSQL transport authority", () => {
  it.each([
    "postgres://user:password@127.0.0.1:5432/mintvault",
    "postgresql://user:password@localhost/mintvault?sslmode=require",
    "postgres://user:password@[::1]:5432/mintvault?sslmode=disable",
  ])("allows plaintext only for an exact loopback host: %s", (url) => {
    expect(postgresTransportSecurity(url, "TEST_DATABASE_URL")).toBe(false);
  });

  it.each([
    "postgres://user:password@ep-example-pooler.eu-west-2.aws.neon.tech/mintvault",
    "postgres://user:password@ep-example.eu-west-2.aws.neon.tech/mintvault?sslmode=require",
    "postgresql://user:password@db.example.test:5432/mintvault?sslmode=verify-full",
  ])("forces certificate verification for a remote database: %s", (url) => {
    const config = securePostgresPoolConnection(url, "TEST_DATABASE_URL");
    expect(config.ssl).toEqual({ rejectUnauthorized: true });

    const pool = new pg.Pool(config);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true });
    expect((pool as any).Client).toBeTruthy();
    void pool.end();

    const client = new pg.Client(config);
    expect(client.connectionParameters.host).toBe(new URL(url).hostname.replace(/^\[|\]$/g, ""));
    expect(client.connectionParameters.ssl).toEqual({ rejectUnauthorized: true });
  });

  it.each(["disable", "allow", "prefer", "no-verify", "verify-ca"])(
    "rejects the remote sslmode=%s downgrade before constructing a pool",
    (sslmode) => {
      expect(() =>
        securePostgresPoolConnection(
          `postgres://user:password@ep-example.neon.tech/mintvault?sslmode=${sslmode}`,
          "TEST_DATABASE_URL"
        )
      ).toThrow(/refuses remote PostgreSQL TLS downgrade/);
    }
  );

  it("rejects a remote ssl=false downgrade", () => {
    expect(() =>
      securePostgresPoolConnection(
        "postgres://user:password@ep-example.neon.tech/mintvault?ssl=false",
        "TEST_DATABASE_URL"
      )
    ).toThrow(/refuses remote PostgreSQL TLS disablement/);
  });

  it("removes libpq compatibility and SSL query controls before node-postgres reparses the URL", () => {
    const config = securePostgresPoolConnection(
      "postgres://user:password@ep-example.neon.tech/mintvault?uselibpqcompat=true&sslmode=require&sslnegotiation=direct&application_name=mintvault",
      "TEST_DATABASE_URL"
    );
    const sanitized = new URL(config.connectionString!);
    const client = new pg.Client(config);
    expect(client.connectionParameters.host).toBe("ep-example.neon.tech");
    expect(client.connectionParameters.ssl).toEqual({ rejectUnauthorized: true });
    expect(client.connectionParameters.sslnegotiation).not.toBe("direct");
    expect([...sanitized.searchParams.keys()].sort()).toEqual(["application_name"]);
  });

  it.each(["host", "hostaddr", "port", "database", "dbname", "user", "password"])(
    "rejects URL authority-shadow parameter %s",
    (name) => {
      expect(() =>
        securePostgresPoolConnection(
          `postgres://user:password@ep-example.neon.tech/mintvault?${name}=attacker.invalid`,
          "TEST_DATABASE_URL"
        )
      ).toThrow(/refuses PostgreSQL URL authority-shadow parameter/);
    }
  );

  it.each(["sslrootcert", "sslkey", "sslcert", "sslca", "sslcrl", "sslpassword"])(
    "rejects unsupported URL TLS material parameter %s without reading it",
    (name) => {
      expect(() =>
        securePostgresPoolConnection(
          `postgres://user:password@ep-example.neon.tech/mintvault?${name}=/definitely/not/a/file`,
          "TEST_DATABASE_URL"
        )
      ).toThrow(/refuses PostgreSQL URL TLS material parameter/);
    }
  );

  it("strips SSL query controls from loopback and keeps effective plaintext", () => {
    const config = securePostgresPoolConnection(
      "postgres://user:password@127.0.0.1:5432/mintvault?sslmode=require&uselibpqcompat=true&sslnegotiation=direct",
      "TEST_DATABASE_URL"
    );
    const client = new pg.Client(config);
    expect(client.connectionParameters.host).toBe("127.0.0.1");
    expect(client.connectionParameters.ssl).toBe(false);
    expect(client.connectionParameters.sslnegotiation).not.toBe("direct");
    expect(new URL(config.connectionString!).search).toBe("");
  });

  it.each([
    "not a URL",
    "https://db.example.test/mintvault",
    "postgres://user:password@/mintvault",
    "postgres://user:password@db.example.test/",
  ])("rejects malformed or non-PostgreSQL authority: %s", (url) => {
    expect(() => securePostgresPoolConnection(url, "TEST_DATABASE_URL")).toThrow(
      /TEST_DATABASE_URL must (be a valid PostgreSQL connection URL|identify a PostgreSQL host and database)/
    );
  });
});
