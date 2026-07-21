import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPartnerAccountingDatabaseTopology, partnerAccountingTopologyReadiness } from "../server/partner/db";

const DATABASE_ENV = [
  "MINTVAULT_DATABASE_URL",
  "PARTNER_ADMIN_DATABASE_URL",
  "PARTNER_DATABASE_URL",
  "PARTNER_CONNECTOR_DATABASE_URL",
] as const;

const previous = new Map<string, string | undefined>();

describe("Partner credit settlement database topology", () => {
  beforeEach(() => {
    for (const variable of DATABASE_ENV) {
      previous.set(variable, process.env[variable]);
      delete process.env[variable];
    }
  });

  afterEach(() => {
    for (const variable of DATABASE_ENV) {
      const value = previous.get(variable);
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    }
    previous.clear();
  });

  it("treats postgres and postgresql URL schemes as the same database identity", () => {
    process.env.MINTVAULT_DATABASE_URL = "postgres://mintvault:secret@db.example.test/mintvault";
    process.env.PARTNER_ADMIN_DATABASE_URL = "postgresql://partner_admin:secret@db.example.test:5432/mintvault";
    process.env.PARTNER_DATABASE_URL = "postgresql://partner_runtime:secret@db.example.test/mintvault";
    process.env.PARTNER_CONNECTOR_DATABASE_URL = "postgresql://connector:secret@db.example.test/mintvault";

    expect(assertPartnerAccountingDatabaseTopology).not.toThrow();
  });

  it("normalizes Neon direct and pooled endpoints for the same database", () => {
    process.env.MINTVAULT_DATABASE_URL =
      "postgresql://mintvault:secret@ep-green-brook-123456.eu-west-2.aws.neon.tech/mintvault";
    process.env.PARTNER_ADMIN_DATABASE_URL =
      "postgresql://partner_admin:secret@ep-green-brook-123456-pooler.eu-west-2.aws.neon.tech:5432/mintvault";

    expect(assertPartnerAccountingDatabaseTopology).not.toThrow();
    expect(partnerAccountingTopologyReadiness()).toEqual({ ready: true });
  });

  it("ignores encoded credentials and query parameters, but preserves host, port and database identity", () => {
    process.env.MINTVAULT_DATABASE_URL =
      "postgresql://mint%40vault:pa%24%24word@ep-orange-fog-123.us-east-2.aws.neon.tech/mintvault?sslmode=require";
    process.env.PARTNER_CONNECTOR_DATABASE_URL =
      "postgres://connector:another%3Asecret@ep-orange-fog-123-pooler.us-east-2.aws.neon.tech:5432/mintvault?application_name=connector";
    expect(assertPartnerAccountingDatabaseTopology).not.toThrow();

    process.env.PARTNER_CONNECTOR_DATABASE_URL =
      "postgres://connector:another%3Asecret@ep-orange-fog-123-pooler.us-east-2.aws.neon.tech:5433/mintvault";
    let message = "";
    try {
      assertPartnerAccountingDatabaseTopology();
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("PARTNER_CONNECTOR_DATABASE_URL");
    expect(message).not.toContain("pa%24%24word");
    expect(message).not.toContain("another%3Asecret");
  });

  it("accepts absent optional Partner URLs and rejects a different Neon project", () => {
    process.env.MINTVAULT_DATABASE_URL =
      "postgresql://mintvault:secret@ep-blue-sky-123.eu-west-2.aws.neon.tech/mintvault";
    expect(assertPartnerAccountingDatabaseTopology).not.toThrow();
    process.env.PARTNER_ADMIN_DATABASE_URL =
      "postgresql://partner:secret@ep-other-sky-456.eu-west-2.aws.neon.tech/mintvault";
    expect(partnerAccountingTopologyReadiness()).toEqual({
      ready: false,
      code: "partner_credit_topology_unavailable",
    });
  });

  it("fails startup when the connector targets a different database name", () => {
    process.env.MINTVAULT_DATABASE_URL = "postgres://mintvault:secret@db.example.test/mintvault";
    process.env.PARTNER_CONNECTOR_DATABASE_URL = "postgres://connector:secret@db.example.test/partner_shadow";

    expect(assertPartnerAccountingDatabaseTopology).toThrow(
      "PARTNER_CONNECTOR_DATABASE_URL must target the same PostgreSQL database"
    );
    // Startup records this capability state; G6D calls enforce it later without
    // preventing unrelated MintVault routes from registering.
    expect(partnerAccountingTopologyReadiness()).toEqual({
      ready: false,
      code: "partner_credit_topology_unavailable",
    });
  });

  it("fails startup when the Partner admin URL targets a different host or port", () => {
    process.env.MINTVAULT_DATABASE_URL = "postgresql://mintvault:secret@db.example.test:5432/mintvault";
    process.env.PARTNER_ADMIN_DATABASE_URL = "postgresql://partner_admin:secret@other-db.example.test:5433/mintvault";

    expect(assertPartnerAccountingDatabaseTopology).toThrow(
      "PARTNER_ADMIN_DATABASE_URL must target the same PostgreSQL database"
    );
  });

  it("fails startup when the Partner runtime URL targets a different database", () => {
    process.env.MINTVAULT_DATABASE_URL = "postgresql://mintvault:secret@db.example.test/mintvault";
    process.env.PARTNER_DATABASE_URL = "postgresql://partner_runtime:secret@db.example.test/runtime_shadow";

    expect(assertPartnerAccountingDatabaseTopology).toThrow(
      "PARTNER_DATABASE_URL must target the same PostgreSQL database"
    );
  });

  it("fails startup for a malformed configured PostgreSQL URL", () => {
    process.env.MINTVAULT_DATABASE_URL = "postgres://mintvault:secret@db.example.test/mintvault";
    process.env.PARTNER_DATABASE_URL = "mysql://partner_runtime:secret@db.example.test/mintvault";

    expect(assertPartnerAccountingDatabaseTopology).toThrow(
      "PARTNER_DATABASE_URL must identify a PostgreSQL host and database"
    );
  });
});
