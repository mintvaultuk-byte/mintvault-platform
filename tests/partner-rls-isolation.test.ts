/**
 * Phase 1 — Partner Network RLS tenant-isolation integration test.
 *
 * Runs ONLY when PARTNER_RLS_DB points at a DISPOSABLE local Postgres (host must be
 * 127.0.0.1/localhost — a guard refuses anything else). Skips otherwise, so the normal
 * `npm test` never needs a database. It applies migrations/0001_partner_foundation.sql, then
 * proves, as the restricted `partner_runtime` role, that tenant A cannot read/update/delete/insert
 * tenant B, that missing/empty context fails closed, that the role cannot read an existing
 * MintVault table, and that the superuser (super-admin) is unaffected.
 *
 * Reproduce locally:
 *   (create a throwaway PG, e.g. on 127.0.0.1:55492/dispo)
 *   PARTNER_RLS_DB=postgresql://postgres@127.0.0.1:55492/dispo npx vitest run tests/partner-rls-isolation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const URL = process.env.PARTNER_RLS_DB;
const isLocal = !!URL && /@(127\.0\.0\.1|localhost)[:/]/.test(URL);
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

(isLocal ? describe : describe.skip)("Partner RLS tenant isolation (disposable DB)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: URL });
    await client.connect();
    // fresh state
    await client.query("DROP OWNED BY partner_runtime").catch(() => {});
    await client.query(`DO $$ BEGIN
      PERFORM 1; END$$;`);
    // an existing MintVault-style table the restricted role must never read
    await client.query("CREATE TABLE IF NOT EXISTS certificates (id serial primary key, secret text)");
    await client.query("INSERT INTO certificates (secret) VALUES ('MV-DATA') ON CONFLICT DO NOTHING");
    // apply the authoritative migration (idempotent)
    const sql = readFileSync(join(process.cwd(), "migrations", "0001_partner_foundation.sql"), "utf8");
    await client.query(sql);
    // seed two tenants as superuser (bypasses RLS)
    await client.query("DELETE FROM partner_locations");
    await client.query("DELETE FROM partner_organisations");
    await client.query(
      "INSERT INTO partner_organisations (id,public_ref,legal_name) VALUES ($1,'refA','A Ltd'),($2,'refB','B Ltd')",
      [A, B],
    );
    await client.query(
      "INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name) VALUES ('la',$1,$1,'Shop A'),('lb',$2,$2,'Shop B')",
      [A, B],
    );
  });

  afterAll(async () => {
    await client?.query("RESET ROLE").catch(() => {});
    await client?.end().catch(() => {});
  });

  // helper: run fn as the restricted role with a given tenant context, then reset.
  async function asPartner(tenant: string | null, fn: () => Promise<void>) {
    await client.query("SET ROLE partner_runtime");
    if (tenant === null) await client.query("RESET app.tenant_id");
    else await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenant]);
    try {
      await fn();
    } finally {
      await client.query("RESET ROLE");
    }
  }

  it("superuser (super-admin) sees all tenants — unchanged", async () => {
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_organisations");
    expect(rows[0].n).toBe(2);
  });

  it("tenant A reads only its own rows", async () => {
    await asPartner(A, async () => {
      const own = await client.query("SELECT count(*)::int n FROM partner_locations");
      const bVisible = await client.query("SELECT count(*)::int n FROM partner_locations WHERE name='Shop B'");
      expect(own.rows[0].n).toBe(1);
      expect(bVisible.rows[0].n).toBe(0);
    });
  });

  it("tenant A cannot update or delete tenant B (0 rows affected)", async () => {
    await asPartner(A, async () => {
      const u = await client.query("UPDATE partner_locations SET address='hack' WHERE tenant_id=$1", [B]);
      const d = await client.query("DELETE FROM partner_locations WHERE tenant_id=$1", [B]);
      expect(u.rowCount).toBe(0);
      expect(d.rowCount).toBe(0);
    });
    // B intact (checked as superuser)
    const { rows } = await client.query(
      "SELECT count(*)::int n FROM partner_locations WHERE tenant_id=$1 AND address IS NULL",
      [B],
    );
    expect(rows[0].n).toBe(1);
  });

  it("tenant A cannot insert a row owned by tenant B (WITH CHECK)", async () => {
    await asPartner(A, async () => {
      await expect(
        client.query("INSERT INTO partner_locations (public_ref,tenant_id,partner_id,name) VALUES ('evil',$1,$1,'evil')", [B]),
      ).rejects.toThrow();
    });
  });

  it("missing tenant context fails closed (0 rows, no error)", async () => {
    await asPartner(null, async () => {
      const { rows } = await client.query("SELECT count(*)::int n FROM partner_locations");
      expect(rows[0].n).toBe(0);
    });
  });

  it("empty tenant context fails closed (0 rows, no error)", async () => {
    await asPartner("", async () => {
      const { rows } = await client.query("SELECT count(*)::int n FROM partner_locations");
      expect(rows[0].n).toBe(0);
    });
  });

  it("restricted role cannot read an existing MintVault table", async () => {
    await asPartner(A, async () => {
      await expect(client.query("SELECT 1 FROM certificates LIMIT 1")).rejects.toThrow(/permission denied/i);
    });
  });

  it("restricted role has no privilege on existing MintVault sequences", async () => {
    const { rows } = await client.query(
      "SELECT has_sequence_privilege('partner_runtime','certificates_id_seq','USAGE') AS g",
    );
    expect(rows[0].g).toBe(false);
  });

  it("audit table is append-only for the restricted role (insert ok, update denied)", async () => {
    await asPartner(A, async () => {
      await client.query("INSERT INTO partner_audit_events (tenant_id,action) VALUES ($1,'t')", [A]);
      await expect(client.query("UPDATE partner_audit_events SET action='x'")).rejects.toThrow(/permission denied/i);
    });
  });

  it("F1: restricted role cannot INSERT/UPDATE/DELETE its own organisation (super-admin lifecycle)", async () => {
    await asPartner(A, async () => {
      // DELETE: no grant -> permission denied (so the audit trail can never be cascade-wiped)
      await expect(client.query("DELETE FROM partner_organisations WHERE id=$1", [A])).rejects.toThrow(/permission denied/i);
      await expect(client.query("UPDATE partner_organisations SET status='REVOKED' WHERE id=$1", [A])).rejects.toThrow(/permission denied/i);
      await expect(
        client.query("INSERT INTO partner_organisations (public_ref,legal_name) VALUES ('x','X')"),
      ).rejects.toThrow(/permission denied/i);
    });
    // org + its audit trail intact
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_organisations WHERE id=$1", [A]);
    expect(rows[0].n).toBe(1);
  });

  it("F2: a global feature flag (tenant_id NULL) is readable by a tenant, but a tenant cannot write one", async () => {
    await client.query("DELETE FROM partner_feature_flags");
    await client.query("INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL, 'global', true)");
    await asPartner(A, async () => {
      const seen = await client.query("SELECT count(*)::int n FROM partner_feature_flags WHERE flag='global'");
      expect(seen.rows[0].n).toBe(1); // global visible
      await expect(
        client.query("INSERT INTO partner_feature_flags (tenant_id, flag) VALUES (NULL, 'evil-global')"),
      ).rejects.toThrow(); // cannot write a global flag
    });
  });

  it("F4: malformed (non-uuid) tenant context fails closed to 0 rows, not an error", async () => {
    await asPartner(A, async () => {
      await client.query("SELECT set_config('app.tenant_id','not-a-uuid',false)");
      const { rows } = await client.query("SELECT count(*)::int n FROM partner_locations");
      expect(rows[0].n).toBe(0);
    });
  });
});
