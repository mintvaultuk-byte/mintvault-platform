import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrationClientConfig } from "../scripts/db/migrate";
import { readOnlyClientConfig } from "../scripts/db/read-only-session";

const REMOTE =
  "postgres://operator:secret@ep-example-pooler.eu-west-2.aws.neon.tech/mintvault?sslmode=require&uselibpqcompat=true&sslnegotiation=direct";

describe("operational PostgreSQL script transport", () => {
  it.each([
    ["numbered migration", migrationClientConfig],
    ["read-only preflight", readOnlyClientConfig],
  ])("makes the actual %s pg client verify the remote server identity", (_name, configFor) => {
    const config = configFor(REMOTE);
    const client = new pg.Client(config);
    expect(client.connectionParameters.host).toBe("ep-example-pooler.eu-west-2.aws.neon.tech");
    expect(client.connectionParameters.ssl).toEqual({ rejectUnauthorized: true });
    expect(client.connectionParameters.sslnegotiation).not.toBe("direct");
    expect(new URL(config.connectionString!).search).toBe("");
  });

  it.each([migrationClientConfig, readOnlyClientConfig])(
    "keeps only exact loopback plaintext and rejects authority shadowing",
    (configFor) => {
      const local = new pg.Client(configFor("postgres://operator@127.0.0.1:55432/mintvault?sslmode=require"));
      expect(local.connectionParameters.host).toBe("127.0.0.1");
      expect(local.connectionParameters.ssl).toBe(false);

      expect(() =>
        configFor("postgres://operator@ep-example.neon.tech/mintvault?host=127.0.0.1&sslmode=disable")
      ).toThrow(/authority-shadow parameter/);
      expect(() => configFor("not-a-postgres-url")).toThrow(/valid PostgreSQL connection URL/);
    }
  );

  it("routes every live TypeScript database script through the central transport authority", () => {
    for (const filename of [
      "scripts/db/migrate.ts",
      "scripts/db/read-only-session.ts",
      "scripts/rarity-legacy-audit.ts",
      "scripts/_pr75-schema-diff.ts",
    ]) {
      const script = readFileSync(filename, "utf8");
      expect(script, filename).toContain("securePostgresPoolConnection");
      expect(script, filename).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    }

    const migration = readFileSync("scripts/db/migrate.ts", "utf8");
    expect(migration).toMatch(/await client\.connect\(\);[\s\S]+await assertDedicatedBackend\(endpoint\.url, pid\)/);

    const retiredMarketplace = readFileSync("scripts/run-marketplace-migration.ts", "utf8");
    expect(retiredMarketplace).toMatch(/RETIRED:[\s\S]+numbered migration 0115/);
    expect(retiredMarketplace).not.toMatch(/new pg\.(?:Pool|Client)|migrateMarketplaceSchema/);
  });

  it("keeps the legacy JavaScript seed incapable of reaching a remote database", () => {
    const seed = readFileSync("scripts/seed-vq-character-bible.mjs", "utf8");
    expect(seed).toContain('!["localhost", "127.0.0.1", "::1"].includes(DB_HOST)');
    expect(seed).toContain("ssl: false");
    expect(seed).toContain("if (parsed.search)");
    expect(seed).not.toMatch(/ALLOW_PROD|rejectUnauthorized\s*:\s*false/);
  });
});
