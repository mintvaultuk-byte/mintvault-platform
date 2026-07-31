/**
 * Partner Network RLS tenant-isolation integration test — THE tenant boundary proof.
 *
 * Runs ONLY when PARTNER_RLS_DB points at a DISPOSABLE local Postgres (host must be
 * 127.0.0.1/localhost — a guard refuses anything else). CI sets it (see .github/workflows/ci.yml)
 * and the "is not silently skipped in CI" guard below turns an unset variable into a RED build
 * rather than a silent skip. scripts/ci/assert-partner-rls-suite-executed.mjs additionally asserts
 * EXECUTION, so hard-skipping the gate cannot quietly delete the evidence either.
 *
 * WHY THIS SUITE IS LOAD-BEARING. On staging the partner RUNTIME role (partner_app_staging) has
 * rolbypassrls = FALSE while the ADMIN role (neondb_owner) has rolbypassrls = TRUE — verified
 * 2026-07-31. RLS therefore genuinely binds in production shape, and this file is the only place
 * the boundary is adversarially attacked rather than assumed. The suite mirrors that shape: every
 * attack runs as `partner_runtime`, which is NOLOGIN/NOSUPERUSER/NOBYPASSRLS, and the first test
 * asserts exactly that so the whole file can never degrade into a superuser no-op.
 *
 * SCOPE. It applies the partner migration chain that produces the tables the PILOT ACTUALLY USES —
 * 0001 (foundation), 0007 (customers/submissions/cards/events/handoffs), 0016 (wallets + credit
 * ledger) and 0017 (credit reservations) — then proves, as the restricted role, that tenant A
 * cannot read, update, delete, insert-as, or tenant-hop into tenant B on ANY of them; that the
 * money tables are not writable by the runtime at all; that the reporting VIEWS do not leak across
 * tenants; that missing/empty/malformed context fails closed; that the boundary survives generic
 * plan caching; that the role cannot read an existing MintVault table; and that the superuser
 * (super-admin) is unaffected.
 *
 * Reproduce locally:
 *   (create a throwaway PG 17, e.g. on 127.0.0.1:55433/mintvault_partner_rls)
 *   PARTNER_RLS_DB=postgres://postgres:postgres@127.0.0.1:55433/mintvault_partner_rls \
 *     npx vitest run tests/partner-rls-isolation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const URL = process.env.PARTNER_RLS_DB;
const isLocal = !!URL && /@(127\.0\.0\.1|localhost)[:/]/.test(URL);
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

/**
 * The partner migration chain that creates every table the partner pilot reads or writes.
 * 0001 alone (what this file used to apply) covers the ORG/USER/SESSION layer only — it does not
 * create partner_submissions, partner_submission_cards, partner_customers or any partner_credit_*
 * table, so before this list existed the pilot's actual data surface had ZERO tenant-isolation
 * coverage. Verified to apply cleanly, in this order, onto an empty database.
 */
const PARTNER_MIGRATIONS = [
  "0001_partner_foundation.sql",
  "0007_partner_submissions.sql",
  "0016_partner_wallet_ledger.sql",
  "0017_partner_credit_reservations.sql",
];

/** Deterministic per-tenant fixture ids, so every assertion can target an exact cross-tenant row. */
const ID = {
  locA: "aaaa0000-0000-0000-0000-0000000000a1",
  locB: "bbbb0000-0000-0000-0000-0000000000b1",
  userA: "aaaa0000-0000-0000-0000-0000000000a2",
  userB: "bbbb0000-0000-0000-0000-0000000000b2",
  custA: "aaaa0000-0000-0000-0000-0000000000a3",
  custB: "bbbb0000-0000-0000-0000-0000000000b3",
  subA: "aaaa0000-0000-0000-0000-0000000000a4",
  subB: "bbbb0000-0000-0000-0000-0000000000b4",
  cardA: "aaaa0000-0000-0000-0000-0000000000a5",
  cardB: "bbbb0000-0000-0000-0000-0000000000b5",
  walletA: "aaaa0000-0000-0000-0000-0000000000a6",
  walletB: "bbbb0000-0000-0000-0000-0000000000b6",
  resA: "aaaa0000-0000-0000-0000-0000000000a7",
  resB: "bbbb0000-0000-0000-0000-0000000000b7",
  /** A uuid that exists in NO tenant — the control arm of the FK existence-oracle probe. */
  absent: "deadbeef-0000-0000-0000-000000000000",
};

/** Every tenant-scoped table the pilot touches that partner_runtime can SELECT. */
const TENANT_TABLES = [
  "partner_locations",
  "partner_users",
  "partner_customers",
  "partner_submissions",
  "partner_submission_cards",
  "partner_submission_events",
  "partner_wallets",
  "partner_credit_ledger",
  "partner_credit_reservations",
  "partner_credit_reservation_events",
] as const;

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

/**
 * CI WIRING GUARD. Without this, an unset PARTNER_RLS_DB makes the entire file `describe.skip` and
 * the build stays GREEN with the single most important test in the partner stack never running —
 * exactly how ~250 connector tests reported green for months. Same pattern as
 * tests/partner-rbac-migration.test.ts and tests/partner-rbac-bootstrap.test.ts.
 */
describe("Partner RLS isolation coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_RLS_DB must be a disposable loopback PostgreSQL URL in CI").toBe(true);
    }
    if (!isLocal) console.warn("[partner-rls] skipped: PARTNER_RLS_DB not a loopback URL");
    expect(true).toBe(true);
  });
});

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
    // apply the authoritative migrations (idempotent), in dependency order
    for (const file of PARTNER_MIGRATIONS) {
      await client.query(readFileSync(join(process.cwd(), "migrations", file), "utf8"));
    }
    // Reset the whole partner estate to a known state, as superuser.
    //
    // TRUNCATE, not DELETE, and with triggers suppressed — because 0016/0017 defend the credit
    // tables with append-only ENFORCEMENT TRIGGERS that refuse both DELETE and TRUNCATE even for
    // the superuser ("partner_credit_ledger is append-only: TRUNCATE is not permitted"). That is a
    // good thing and is asserted as a control further down; it just means a test fixture has to
    // step around it deliberately. `session_replication_role = replica` suppresses origin-mode user
    // triggers (all of them are tgenabled='O') and FK triggers for the duration of the reset only.
    // TRUNCATE … CASCADE is also order-independent, so this stays correct as the migration chain
    // grows. The table list is discovered dynamically so a table added by a future partner
    // migration is reset too — a stale row from a previous run silently changing a count is exactly
    // the kind of flake that erodes trust in this suite.
    // Safe because PARTNER_RLS_DB is guarded to a DISPOSABLE loopback database.
    await client.query("SET session_replication_role = 'replica'");
    await client.query(`DO $$
      DECLARE list text;
      BEGIN
        SELECT string_agg(format('%I', c.relname), ', ') INTO list
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'partner\\_%';
        IF list IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE ' || list || ' RESTART IDENTITY CASCADE';
        END IF;
      END$$;`);
    await client.query("SET session_replication_role = 'origin'");
    await client.query(
      "INSERT INTO partner_organisations (id,public_ref,legal_name) VALUES ($1,'refA','A Ltd'),($2,'refB','B Ltd')",
      [A, B],
    );
    await client.query(
      "INSERT INTO partner_locations (id,public_ref,tenant_id,partner_id,name) VALUES ($1,'la',$3,$3,'Shop A'),($2,'lb',$4,$4,'Shop B')",
      [ID.locA, ID.locB, A, B],
    );
    await client.query(
      "INSERT INTO partner_users (id,public_ref,tenant_id,partner_id,email,status) VALUES ($1,'ua',$3,$3,'a@x.test','active'),($2,'ub',$4,$4,'b@x.test','active')",
      [ID.userA, ID.userB, A, B],
    );
    await client.query(
      "INSERT INTO partner_customers (id,tenant_id,full_name,email) VALUES ($1,$3,'Cust A','a-cust@x.test'),($2,$4,'Cust B','b-cust@x.test')",
      [ID.custA, ID.custB, A, B],
    );
    await client.query(
      `INSERT INTO partner_submissions (id,tenant_id,location_id,created_by,public_ref,customer_id,status,card_count)
       VALUES ($1,$3,$5,$7,'sa',$9,'draft',1),($2,$4,$6,$8,'sb',$10,'draft',1)`,
      [ID.subA, ID.subB, A, B, ID.locA, ID.locB, ID.userA, ID.userB, ID.custA, ID.custB],
    );
    await client.query(
      `INSERT INTO partner_submission_cards (id,tenant_id,submission_id,sequence_number,card_name,declared_value_pence)
       VALUES ($1,$3,$5,1,'Card A',100),($2,$4,$6,1,'Card B',999999)`,
      [ID.cardA, ID.cardB, A, B, ID.subA, ID.subB],
    );
    await client.query(
      `INSERT INTO partner_submission_events (tenant_id,submission_id,event_type) VALUES ($1,$3,'created'),($2,$4,'created')`,
      [A, B, ID.subA, ID.subB],
    );
    await client.query("INSERT INTO partner_wallets (id,tenant_id) VALUES ($1,$3),($2,$4)", [
      ID.walletA,
      ID.walletB,
      A,
      B,
    ]);
    await client.query(
      `INSERT INTO partner_credit_ledger (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint)
       VALUES ($1,$3,10,'purchase','seed-a','admin','seed','admin',$5),($2,$4,999,'purchase','seed-b','admin','seed','admin',$6)`,
      [ID.walletA, ID.walletB, A, B, FP_A, FP_B],
    );
    await client.query(
      `INSERT INTO partner_credit_reservations
         (id,wallet_id,tenant_id,location_id,card_reference,idempotency_key,request_fingerprint,source,reason,actor_type,expires_at)
       VALUES ($1,$3,$5,$7,'card-a','res-a',$9,'portal','seed','partner_user',now()+interval '1 day'),
              ($2,$4,$6,$8,'card-b','res-b',$10,'portal','seed','partner_user',now()+interval '1 day')`,
      [ID.resA, ID.resB, ID.walletA, ID.walletB, A, B, ID.locA, ID.locB, FP_A, FP_B],
    );
    await client.query(
      `INSERT INTO partner_credit_reservation_events
         (reservation_id,wallet_id,tenant_id,event_type,idempotency_key,request_fingerprint,source,reason,actor_type)
       VALUES ($1,$3,$5,'reserved','ev-a',$7,'portal','seed','partner_user'),
              ($2,$4,$6,'reserved','ev-b',$8,'portal','seed','partner_user')`,
      [ID.resA, ID.resB, ID.walletA, ID.walletB, A, B, FP_A, FP_B],
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

  // =========================================================================================
  // ROLE MODEL — the precondition that makes every assertion below mean anything.
  // =========================================================================================

  it("the attacking role is genuinely restricted (NOBYPASSRLS, non-superuser, RLS active)", async () => {
    await asPartner(A, async () => {
      const { rows } = await client.query(
        `SELECT current_user AS who,
                (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
                (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS super,
                current_setting('is_superuser')  AS is_superuser,
                current_setting('row_security')  AS row_security`,
      );
      // Mirrors staging exactly: the RUNTIME role partner_app_staging is rolbypassrls = FALSE,
      // while only the ADMIN role neondb_owner is TRUE. If this ever flips, every cross-tenant
      // assertion in this file would pass vacuously — so it fails here first, loudly.
      expect(rows[0].who).toBe("partner_runtime");
      expect(rows[0].bypass).toBe(false);
      expect(rows[0].super).toBe(false);
      expect(rows[0].is_superuser).toBe("off");
      expect(rows[0].row_security).toBe("on");
    });
  });

  it("every partner table carrying tenant_id has RLS ENABLED, FORCED and an isolation policy", async () => {
    // Coverage sweep, not shape-checking for its own sake: this is what catches a NEW tenant-scoped
    // table landing in a future migration with the RLS block forgotten. FORCE matters because
    // without it the table OWNER is exempt from its own policies.
    const { rows } = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'partner\\_%'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                         AND a.attnum > 0 AND NOT a.attisdropped)
        ORDER BY c.relname`,
    );
    const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies < 1);
    expect(unprotected.map((r) => r.relname)).toEqual([]);
    // Floor, so deleting tables from the chain cannot quietly shrink the sweep to nothing.
    expect(rows.length).toBeGreaterThanOrEqual(18);
  });

  // =========================================================================================
  // CROSS-TENANT READ — on the tables the pilot actually uses.
  // =========================================================================================

  for (const table of TENANT_TABLES) {
    it(`cross-tenant SELECT on ${table}: tenant A sees its own row and ZERO of tenant B's`, async () => {
      await asPartner(A, async () => {
        const { rows } = await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE tenant_id = $1)::int AS b_rows,
                  count(*) FILTER (WHERE tenant_id = $2)::int AS a_rows
             FROM ${table}`,
          [B, A],
        );
        expect(rows[0].b_rows).toBe(0);
        expect(rows[0].a_rows).toBeGreaterThanOrEqual(1);
        // Nothing outside A is visible at all — not even rows belonging to no tenant.
        expect(rows[0].total).toBe(rows[0].a_rows);
      });
    });
  }

  it("no existence oracle: selecting tenant B's exact primary keys returns 0 rows, not an error", async () => {
    await asPartner(A, async () => {
      for (const [table, id] of [
        ["partner_customers", ID.custB],
        ["partner_submissions", ID.subB],
        ["partner_submission_cards", ID.cardB],
        ["partner_wallets", ID.walletB],
        ["partner_credit_reservations", ID.resB],
      ] as const) {
        const { rows } = await client.query(`SELECT count(*)::int n FROM ${table} WHERE id = $1`, [id]);
        expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
      }
    });
  });

  it("the reporting VIEWS do not leak across tenants (security_invoker, not owner rights)", async () => {
    // A view owned by a BYPASSRLS role runs with the OWNER's rights unless security_invoker=true,
    // which would hand every tenant a full cross-tenant read of wallet balances and credit
    // availability. Assert the behaviour AND the option that produces it.
    const opts = await client.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT relname, reloptions FROM pg_class
        WHERE relkind = 'v' AND relname IN ('partner_wallet_balances','partner_credit_availability')`,
    );
    expect(opts.rows.length).toBe(2);
    for (const v of opts.rows) {
      expect({ v: v.relname, opts: v.reloptions ?? [] }).toEqual({
        v: v.relname,
        opts: expect.arrayContaining(["security_invoker=true"]),
      });
    }
    await asPartner(A, async () => {
      for (const view of ["partner_wallet_balances", "partner_credit_availability"] as const) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE tenant_id = $1)::int AS b_rows FROM ${view}`,
          [B],
        );
        expect({ view, ...rows[0] }).toEqual({ view, total: 1, b_rows: 0 });
      }
    });
  });

  // =========================================================================================
  // CROSS-TENANT WRITE — UPDATE / DELETE / INSERT / tenant-hop.
  // =========================================================================================

  it("cross-tenant UPDATE affects ZERO rows on submissions, cards and customers", async () => {
    await asPartner(A, async () => {
      const s = await client.query("UPDATE partner_submissions SET status='cancelled' WHERE tenant_id=$1", [B]);
      const c = await client.query("UPDATE partner_submission_cards SET card_name='hacked' WHERE tenant_id=$1", [B]);
      const k = await client.query("UPDATE partner_customers SET full_name='hacked', email='attacker@evil.test' WHERE tenant_id=$1", [B]);
      expect({ s: s.rowCount, c: c.rowCount, k: k.rowCount }).toEqual({ s: 0, c: 0, k: 0 });
      // Blind UPDATE with no WHERE at all must also spare B.
      const blind = await client.query("UPDATE partner_submissions SET intake_notes='blind'");
      expect(blind.rowCount).toBe(1); // only A's own row
    });
    // B's records are byte-for-byte intact, checked as superuser (which bypasses RLS).
    const { rows } = await client.query(
      `SELECT (SELECT status    FROM partner_submissions      WHERE id=$1) AS sub_status,
              (SELECT card_name FROM partner_submission_cards WHERE id=$2) AS card_name,
              (SELECT full_name FROM partner_customers        WHERE id=$3) AS cust_name,
              (SELECT intake_notes FROM partner_submissions   WHERE id=$1) AS sub_notes`,
      [ID.subB, ID.cardB, ID.custB],
    );
    expect(rows[0]).toEqual({ sub_status: "draft", card_name: "Card B", cust_name: "Cust B", sub_notes: null });
  });

  it("cross-tenant DELETE is refused outright where no DELETE grant exists, and hits 0 rows where it does", async () => {
    await asPartner(A, async () => {
      // No DELETE grant at all — submissions/cards/customers are soft-delete-only by design, so
      // the attack fails one layer EARLIER than RLS, at the privilege check.
      for (const table of ["partner_submissions", "partner_submission_cards", "partner_customers"] as const) {
        await expect(client.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [B])).rejects.toThrow(
          /permission denied/i,
        );
      }
      // partner_users DOES carry a DELETE grant, so here RLS itself is the only thing standing
      // between tenant A and deleting tenant B's staff accounts. It must report 0 rows.
      const d = await client.query("DELETE FROM partner_users WHERE tenant_id=$1", [B]);
      expect(d.rowCount).toBe(0);
      const blind = await client.query("DELETE FROM partner_users WHERE email='b@x.test'");
      expect(blind.rowCount).toBe(0);
    });
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_users WHERE tenant_id=$1", [B]);
    expect(rows[0].n).toBe(1);
  });

  it("cross-tenant INSERT (a row stamped with tenant B) is refused by WITH CHECK", async () => {
    await asPartner(A, async () => {
      await expect(
        client.query("INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,'planted')", [B]),
      ).rejects.toThrow(/row-level security/i);
      await expect(
        client.query(
          `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,status)
           VALUES ($1,$2,$3,'planted','draft')`,
          [B, ID.locB, ID.userB],
        ),
      ).rejects.toThrow(/row-level security/i);
      await expect(
        client.query(
          `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name)
           VALUES ($1,$2,99,'planted')`,
          [B, ID.subB],
        ),
      ).rejects.toThrow(/row-level security/i);
    });
    const { rows } = await client.query(
      "SELECT count(*)::int n FROM partner_submissions WHERE public_ref='planted'",
    );
    expect(rows[0].n).toBe(0);
  });

  it("tenant-hop is refused: A cannot re-stamp its OWN row with tenant B's id", async () => {
    // The subtlest escape: don't touch B's rows, push your own across the boundary instead. The
    // policy's WITH CHECK arm is what stops it — USING alone would let this through.
    await asPartner(A, async () => {
      await expect(
        client.query("UPDATE partner_submissions SET tenant_id=$1 WHERE tenant_id=$2", [B, A]),
      ).rejects.toThrow(/row-level security/i);
      await expect(
        client.query("UPDATE partner_customers SET tenant_id=$1 WHERE tenant_id=$2", [B, A]),
      ).rejects.toThrow(/row-level security/i);
    });
    const { rows } = await client.query("SELECT count(*)::int n FROM partner_submissions WHERE tenant_id=$1", [B]);
    expect(rows[0].n).toBe(1);
  });

  it("MONEY: the runtime role cannot mint, adjust or forge credit for itself or anyone else", async () => {
    // The credit tables are SELECT-only to partner_runtime by design — all mutation goes through
    // super-admin/definer paths. A partner that could INSERT a ledger row could grade for free.
    await asPartner(A, async () => {
      await expect(
        client.query(
          `INSERT INTO partner_credit_ledger
             (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint)
           VALUES ($1,$2,1000000,'purchase','self-topup','admin','free money','admin',$3)`,
          [ID.walletA, A, FP_A],
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(client.query("UPDATE partner_credit_ledger SET amount=amount+1000")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(client.query("DELETE FROM partner_credit_ledger")).rejects.toThrow(/permission denied/i);
      await expect(client.query("UPDATE partner_wallets SET status='active'")).rejects.toThrow(
        /permission denied/i,
      );
      // Reservations likewise: forging one would consume credit that was never bought, and
      // releasing tenant B's would free their reserved credit.
      await expect(
        client.query("UPDATE partner_credit_reservations SET status='released', released_at=now() WHERE tenant_id=$1", [B]),
      ).rejects.toThrow(/permission denied/i);
      await expect(client.query("DELETE FROM partner_credit_reservations")).rejects.toThrow(/permission denied/i);
    });
    const { rows } = await client.query(
      "SELECT balance::int FROM partner_wallet_balances WHERE tenant_id=$1",
      [B],
    );
    expect(rows[0].balance).toBe(999); // tenant B's balance untouched
  });

  it("MONEY: the credit ledger is immutable even to the table OWNER, by trigger", async () => {
    // Grants stop partner_runtime; these triggers stop everyone, including the migration owner and
    // any future code that reaches the ledger on an admin connection. They are the last line of
    // defence for balances, so assert they exist and are ENABLED — a disabled trigger (tgenabled
    // 'D') looks identical to a present one in a schema diff.
    const { rows } = await client.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgrelid IN ('partner_credit_ledger'::regclass, 'partner_credit_reservation_events'::regclass)
        ORDER BY tgname`,
    );
    const names = rows.map((r) => r.tgname);
    expect(names).toEqual(expect.arrayContaining(["trg_partner_credit_ledger_no_row_mutate"]));
    expect(names).toEqual(expect.arrayContaining(["trg_partner_credit_ledger_no_truncate"]));
    for (const r of rows) expect({ t: r.tgname, on: r.tgenabled }).toEqual({ t: r.tgname, on: "O" });
    // And behaviourally, as the superuser/owner — not merely present, actually enforcing.
    await expect(client.query("UPDATE partner_credit_ledger SET amount = amount + 1")).rejects.toThrow(
      /append-only/i,
    );
    await expect(client.query("DELETE FROM partner_credit_ledger")).rejects.toThrow(/append-only/i);
  });

  it("submission events are append-only for the runtime role (no history rewriting)", async () => {
    await asPartner(A, async () => {
      await client.query(
        "INSERT INTO partner_submission_events (tenant_id,submission_id,event_type) VALUES ($1,$2,'noted')",
        [A, ID.subA],
      );
      await expect(client.query("UPDATE partner_submission_events SET event_type='forged'")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(client.query("DELETE FROM partner_submission_events")).rejects.toThrow(/permission denied/i);
    });
  });

  // =========================================================================================
  // CONTEXT INTEGRITY — fail-closed, and no stale plan.
  // =========================================================================================

  for (const [label, ctx] of [
    ["missing", null],
    ["empty", ""],
    ["malformed", "not-a-uuid"],
  ] as const) {
    it(`${label} tenant context fails closed to 0 rows on every pilot table`, async () => {
      await asPartner(ctx, async () => {
        for (const table of TENANT_TABLES) {
          const { rows } = await client.query(`SELECT count(*)::int n FROM ${table}`);
          expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
        }
      });
    });
  }

  it("the RLS predicate is re-evaluated per execution — a cached generic plan cannot freeze a tenant in", async () => {
    // Real-world failure mode: PostgreSQL switches a server-side prepared statement from a custom
    // plan to a GENERIC plan after ~5 executions. If the tenant predicate were folded into that
    // generic plan, a long-lived pooled connection would keep serving the FIRST tenant's rows to
    // every subsequent tenant. Alternate A/B across the switchover on one named statement.
    await asPartner(A, async () => {
      const seen: string[] = [];
      for (let i = 0; i < 8; i++) {
        await client.query("SELECT set_config('app.tenant_id',$1,false)", [i % 2 === 0 ? A : B]);
        const { rows } = await client.query({
          name: "rls_plan_cache_probe",
          text: "SELECT coalesce(string_agg(public_ref, ',' ORDER BY public_ref), '') AS refs FROM partner_submissions",
        });
        seen.push(rows[0].refs);
      }
      expect(seen).toEqual(["sa", "sb", "sa", "sb", "sa", "sb", "sa", "sb"]);
    });
  });

  // =========================================================================================
  // KNOWN GAP — cross-tenant FK pivot. Characterised, not fixed: migrations/ is owned elsewhere.
  //
  // PostgreSQL evaluates referential-integrity checks with an internal snapshot that is NOT
  // subject to RLS. 0007's FKs are SINGLE-COLUMN (submission_id, customer_id, location_id), so the
  // restricted role CAN create its own row pointing at another tenant's parent. 0016/0017 avoided
  // this deliberately with tenant-composite FKs — FOREIGN KEY (wallet_id, tenant_id) REFERENCES
  // partner_wallets(id, tenant_id) — which make the pivot impossible because no such pair exists.
  //
  // These tests pin the CURRENT behaviour and, more importantly, pin the CONTAINMENT boundary that
  // still holds (no read amplification, invisible to the victim). They will FAIL the day 0007 is
  // hardened, which is the intended signal to update them. See the report for the proposed fix.
  // =========================================================================================

  it("KNOWN GAP: FK checks bypass RLS, so a cross-tenant FK pivot is currently possible", async () => {
    await asPartner(A, async () => {
      // A card owned by A, hung off tenant B's submission.
      await client.query(
        `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name)
         VALUES ($1,$2,900,'pivot-card')`,
        [A, ID.subB],
      );
      // A submission owned by A, referencing tenant B's customer and location.
      await client.query(
        `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,customer_id,status)
         VALUES ($1,$2,$3,'pivot-sub',$4,'draft')`,
        [A, ID.locB, ID.userA, ID.custB],
      );
    });
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM partner_submission_cards WHERE card_name='pivot-card') AS cards,
              (SELECT count(*)::int FROM partner_submissions      WHERE public_ref='pivot-sub')  AS subs`,
    );
    // Documenting the gap, NOT endorsing it. Flip both to 0 once 0007 uses composite FKs.
    expect(rows[0]).toEqual({ cards: 1, subs: 1 });
  });

  it("CONTAINMENT HOLDS: the pivot yields no cross-tenant READ and is invisible to the victim", async () => {
    // This is the assertion that actually matters for confidentiality, and it must never regress
    // even while the gap above is open.
    await asPartner(A, async () => {
      const joined = await client.query(
        `SELECT s.public_ref AS leaked
           FROM partner_submission_cards c
           LEFT JOIN partner_submissions s ON s.id = c.submission_id
          WHERE c.card_name = 'pivot-card'`,
      );
      expect(joined.rows[0].leaked).toBeNull(); // B's submission still unreadable through the FK
      const cust = await client.query(
        `SELECT k.full_name AS leaked
           FROM partner_submissions s
           LEFT JOIN partner_customers k ON k.id = s.customer_id
          WHERE s.public_ref = 'pivot-sub'`,
      );
      expect(cust.rows[0].leaked).toBeNull(); // B's customer PII still unreadable
      const loc = await client.query(
        `SELECT l.name AS leaked
           FROM partner_submissions s
           LEFT JOIN partner_locations l ON l.id = s.location_id
          WHERE s.public_ref = 'pivot-sub'`,
      );
      expect(loc.rows[0].leaked).toBeNull();
    });
    await asPartner(B, async () => {
      const { rows } = await client.query(
        `SELECT (SELECT count(*)::int FROM partner_submission_cards WHERE card_name='pivot-card') AS cards,
                (SELECT count(*)::int FROM partner_submission_cards) AS all_cards`,
      );
      expect(rows[0]).toEqual({ cards: 0, all_cards: 1 }); // B's own view is uncontaminated
    });
    // cleanup so later state stays deterministic
    await client.query("DELETE FROM partner_submission_cards WHERE card_name='pivot-card'");
    await client.query("DELETE FROM partner_submissions WHERE public_ref='pivot-sub'");
  });

  it("KNOWN GAP: the same FK path is an existence oracle for other tenants' uuids", async () => {
    await asPartner(A, async () => {
      // A uuid that exists in NO tenant is rejected by the FK...
      await expect(
        client.query(
          `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,customer_id,status)
           VALUES ($1,$2,$3,'oracle-miss',$4,'draft')`,
          [A, ID.locA, ID.userA, ID.absent],
        ),
      ).rejects.toThrow(/foreign key constraint/i);
      // ...while tenant B's real customer id is ACCEPTED. The difference is the oracle.
      await client.query(
        `INSERT INTO partner_submissions (tenant_id,location_id,created_by,public_ref,customer_id,status)
         VALUES ($1,$2,$3,'oracle-hit',$4,'draft')`,
        [A, ID.locA, ID.userA, ID.custB],
      );
    });
    await client.query("DELETE FROM partner_submissions WHERE public_ref='oracle-hit'");
  });

  it("the CREDIT layer is immune to the pivot: its FKs are tenant-composite", async () => {
    // Positive regression guard for the pattern that 0007 should adopt. If anyone "simplifies"
    // these back to single-column FKs, the credit tables inherit the gap above and this reddens.
    const { rows } = await client.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid IN ('partner_credit_ledger'::regclass,
                           'partner_credit_reservations'::regclass,
                           'partner_credit_reservation_events'::regclass)
        ORDER BY conname`,
    );
    const walletFks = rows.filter((r) => r.def.includes("REFERENCES partner_wallets"));
    expect(walletFks.length).toBeGreaterThanOrEqual(2);
    for (const fk of walletFks) {
      expect({ fk: fk.conname, composite: /FOREIGN KEY \(wallet_id, tenant_id\)/.test(fk.def) }).toEqual({
        fk: fk.conname,
        composite: true,
      });
    }
  });
});
