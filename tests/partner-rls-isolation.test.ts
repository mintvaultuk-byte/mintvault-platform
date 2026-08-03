/**
 * DEFECT 3 — GENUINE Partner Network RLS tenant-isolation proof, on real PostgreSQL.
 *
 * WHAT WAS WRONG WITH THE PREVIOUS VERSION
 * ----------------------------------------
 * It applied only migration 0001, so it proved isolation for partner_locations,
 * partner_organisations, partner_feature_flags and partner_audit_events — and NOTHING in the
 * money path. Wallets, the credit ledger, reservations, reservation events, partner submissions
 * and credit holds were entirely unproven. It also made its isolation claims without ever
 * asserting the conditions those claims depend on:
 *
 *   - it connected as the SUPERUSER and relied on `SET ROLE partner_runtime`. That does work, but
 *     nothing checked it. Drop the SET ROLE (or run as a BYPASSRLS role) and every assertion below
 *     still "passes" while proving nothing at all, because a superuser sees all rows.
 *   - it set the tenant GUC with `set_config(..., false)` — SESSION-local. A leaked session GUC
 *     silently carries a tenant identity across tests. Production sets it transaction-locally.
 *   - "tenant A cannot see B" was asserted by counting rows, which is indistinguishable from a
 *     query that simply matched nothing.
 *
 * A manual `WHERE tenant_id = ...` filter is NOT an RLS proof. Every read query below is
 * deliberately written WITHOUT a tenant predicate: if RLS is doing the work, the row is invisible;
 * if RLS is not doing the work, the row appears and the test fails.
 *
 * HARNESS INTEGRITY (fail-loud): before any isolation claim, assertRlsHarness() proves the acting
 * role is NOT a superuser, does NOT hold BYPASSRLS, that FORCE ROW LEVEL SECURITY is active on the
 * table in question, and that a tenant context is actually set. RLS2 (running the proof as a
 * superuser) must produce an explicit harness failure, not a green run.
 *
 * MUTATION TARGETS: RLS1 (drop a tenant policy) and RLS2 (run as superuser) must both turn this red.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client; // superuser — provisioning ONLY, never used for an isolation claim
let runtime: Client; // the restricted partner runtime login — every claim is made through this

const RUNTIME_LOGIN = "partner_rls_runtime";
const RUNTIME_PASSWORD = "synthetic"; // disposable cluster only

interface Tenant {
  id: string;
  locationId: string;
  userId: string;
  walletId: string;
  submissionId: string;
  reservationId: string;
}

let A: Tenant;
let B: Tenant;

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz, grading_status varchar(30),
    assigned_grader_id varchar, scan_status varchar(30), scan_assigned_to varchar,
    shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
    return_tracking text, return_carrier text, return_service text,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  // The MintVault table the restricted role must never be able to read.
  await admin.query(
    "CREATE TABLE certificates (id serial primary key, cert_id text, submission_id integer, secret text)"
  );
  await admin.query("INSERT INTO certificates (cert_id, secret) VALUES ('MV1','MV-DATA')");
  await admin.query("CREATE TABLE label_prints (id serial primary key, certificate_id integer)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

/** Provision one fully-populated tenant: org, location, user, wallet, ledger, submission, reservation. */
async function seedTenant(label: string): Promise<Tenant> {
  const id = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name,status) VALUES ($1,'ACTIVE') RETURNING id",
      [`RLS ${label}`]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
      [id, `Shop ${label}`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref,tenant_id,partner_id,email,password_hash,status,mfa_required)
       VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
      [`rls-${label}`, id, `rls-${label}@example.test`]
    )
  ).rows[0].id;
  const walletId = (
    await admin.query<{ id: string }>("INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id", [id])
  ).rows[0].id;
  const fund = `rls-fund-${label}`;
  await admin.query(
    `INSERT INTO partner_credit_ledger
       (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
     VALUES ($1,$2,100,'purchase',$3,'admin',$4,'admin',md5($3)||md5($3||':f'))`,
    [walletId, id, fund, `RLS ${label} funding`]
  );
  const submissionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
       VALUES ($1,$2,$3,1,'draft') RETURNING id`,
      [id, locationId, userId]
    )
  ).rows[0].id;
  const key = `rls-res-${label}`;
  const reservationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_credit_reservations
         (wallet_id, tenant_id, location_id, card_reference, submission_reference, reserved_credits,
          status, idempotency_key, request_fingerprint, source, reason, actor_type, expires_at)
       VALUES ($1,$2,$3,'card-1',$4,1,'active',$5,md5($5)||md5($5||':f'),'portal','rls fixture','admin',
               now() + interval '365 days')
       RETURNING id`,
      [walletId, id, locationId, submissionId, key]
    )
  ).rows[0].id;
  return { id, locationId, userId, walletId, submissionId, reservationId };
}

/**
 * FAIL-LOUD HARNESS ASSERTIONS. Every isolation claim in this file is only meaningful if all of
 * these hold. They are checked inside the same transaction the claim is made in.
 */
async function assertRlsHarness(client: Client, table: string, expectTenant: string): Promise<void> {
  const r = await client.query<{
    rolname: string;
    is_super: boolean;
    bypassrls: boolean;
    forced: boolean;
    rls_enabled: boolean;
    tenant: string | null;
    policies: number;
  }>(
    `SELECT current_user AS rolname,
            (SELECT rolsuper      FROM pg_roles WHERE rolname = current_user) AS is_super,
            (SELECT rolbypassrls  FROM pg_roles WHERE rolname = current_user) AS bypassrls,
            c.relforcerowsecurity AS forced,
            c.relrowsecurity      AS rls_enabled,
            NULLIF(current_setting('app.tenant_id', true), '') AS tenant,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = 'public'`,
    [table]
  );
  expect(r.rowCount, `table ${table} must exist`).toBe(1);
  const h = r.rows[0];
  // RLS2: running this proof as a superuser must fail HERE, explicitly, not pass silently.
  expect(
    h.is_super,
    `RLS proof is running as SUPERUSER '${h.rolname}' — every isolation claim would be vacuous`
  ).toBe(false);
  expect(h.bypassrls, `RLS proof role '${h.rolname}' holds BYPASSRLS — every isolation claim would be vacuous`).toBe(
    false
  );
  expect(h.rls_enabled, `${table} must have ROW LEVEL SECURITY enabled`).toBe(true);
  // FORCE matters independently: without it the table OWNER is exempt from its own policies.
  expect(h.forced, `${table} must have FORCE ROW LEVEL SECURITY`).toBe(true);
  expect(h.policies, `${table} must carry at least one policy`).toBeGreaterThan(0);
  expect(h.tenant, "tenant context must be set for this claim").toBe(expectTenant);
}

/**
 * Attempt a cross-tenant write and report HOW it was refused.
 *
 * Two mechanisms defend the money path and both are legitimate; conflating them would overstate
 * what RLS alone proves, so this reports which one fired:
 *   "denied"  — partner_runtime holds no such grant on the table (privilege absence).
 *   "no_rows" — the grant exists and RLS made the target row invisible to the statement.
 * The security property under test is that the write is refused AND the victim row is unchanged;
 * the mechanism is recorded so the assertion stays honest about which layer did the work.
 *
 * Each attempt runs inside its own SAVEPOINT: a failed statement aborts the enclosing transaction,
 * so without this the first expected failure would poison every later assertion in the same block.
 */
async function attemptWrite(
  sql: string,
  params: unknown[]
): Promise<{ refusal: "denied" | "no_rows" | "APPLIED"; rowCount: number }> {
  await runtime.query("SAVEPOINT attempt");
  try {
    const r = await runtime.query(sql, params);
    await runtime.query("RELEASE SAVEPOINT attempt");
    return { refusal: (r.rowCount ?? 0) === 0 ? "no_rows" : "APPLIED", rowCount: r.rowCount ?? 0 };
  } catch {
    await runtime.query("ROLLBACK TO SAVEPOINT attempt");
    await runtime.query("RELEASE SAVEPOINT attempt");
    return { refusal: "denied", rowCount: 0 };
  }
}

/**
 * Run `fn` as partner_runtime with a TRANSACTION-LOCAL tenant context, exactly as production does.
 * The transaction is always rolled back, so no test can leak state or a GUC into another.
 */
async function asTenant(tenant: string | null, fn: () => Promise<void>): Promise<void> {
  await runtime.query("BEGIN");
  try {
    await runtime.query("SET ROLE partner_runtime");
    // `true` = transaction-local. The previous suite used `false` (session-local), which lets a
    // tenant identity survive past the test that set it.
    if (tenant !== null) await runtime.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    await fn();
  } finally {
    await runtime.query("ROLLBACK").catch(() => {});
    await runtime.query("RESET ROLE").catch(() => {});
  }
}

describe("Partner RLS tenant isolation (real PostgreSQL, restricted runtime role)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-rls-isolation");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);

    await admin.query(`DO $$ BEGIN
        CREATE ROLE ${RUNTIME_LOGIN} LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query(`GRANT partner_runtime TO ${RUNTIME_LOGIN}`);

    A = await seedTenant("A");
    B = await seedTenant("B");

    const url = new URL(cluster.url);
    url.username = RUNTIME_LOGIN;
    url.password = RUNTIME_PASSWORD;
    runtime = new Client({ connectionString: url.toString() });
    await runtime.connect();
  }, 120_000);

  afterAll(async () => {
    await runtime?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // ------------------------------------------------------------------ harness integrity
  describe("harness integrity", () => {
    it("the acting role is partner_runtime, NOSUPERUSER and NOBYPASSRLS", async () => {
      await asTenant(A.id, async () => {
        const r = await runtime.query<{ rolname: string; s: boolean; b: boolean }>(
          `SELECT current_user AS rolname,
                  (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS s,
                  (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b`
        );
        expect(
          r.rows[0].s,
          `RLS proof is running as SUPERUSER '${r.rows[0].rolname}' — every isolation claim would be vacuous`
        ).toBe(false);
        expect(r.rows[0].rolname).toBe("partner_runtime");
        expect(r.rows[0].b).toBe(false);
      });
    });

    it("the tenant context is TRANSACTION-local and does not survive the transaction", async () => {
      await asTenant(A.id, async () => {
        expect((await runtime.query("SELECT current_setting('app.tenant_id', true) AS t")).rows[0].t).toBe(A.id);
      });
      // outside any transaction the GUC must be gone, or a later test inherits this identity
      const after = await runtime.query<{ t: string | null }>(
        "SELECT NULLIF(current_setting('app.tenant_id', true),'') AS t"
      );
      expect(after.rows[0].t).toBeNull();
    });

    it("every money-path table has RLS enabled, FORCED, and at least one policy", async () => {
      await asTenant(A.id, async () => {
        for (const t of [
          "partner_wallets",
          "partner_credit_ledger",
          "partner_credit_reservations",
          "partner_credit_reservation_events",
          "partner_submissions",
          "partner_submission_cards",
          // 0041 created this table with NO row-level security at all, while enabling it on its
          // sibling partner_credit_accounting_exceptions in the same migration. 0043 closes that.
          "partner_submission_credit_holds",
          "partner_locations",
        ]) {
          await assertRlsHarness(runtime, t, A.id);
        }
      });
    });
  });

  // ------------------------------------------------------------------ read isolation, money path
  describe("tenant A cannot READ tenant B", () => {
    /**
     * Deliberately NO tenant predicate in any of these queries. If RLS is enforcing, B's row is
     * invisible; if it is not, B's row is returned and the assertion fails. A `WHERE tenant_id=A`
     * filter would pass either way and would prove nothing.
     */
    const cases: Array<{ table: string; bId: (t: Tenant) => string }> = [
      { table: "partner_wallets", bId: (t) => t.walletId },
      { table: "partner_submissions", bId: (t) => t.submissionId },
      { table: "partner_credit_reservations", bId: (t) => t.reservationId },
    ];

    for (const c of cases) {
      it(`${c.table}: B's row is invisible and only A's rows are returned`, async () => {
        await asTenant(A.id, async () => {
          await assertRlsHarness(runtime, c.table, A.id);
          const seen = await runtime.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM ${c.table}`);
          expect(seen.rows.length).toBeGreaterThan(0); // A must genuinely see its own data
          expect(seen.rows.every((r) => r.tenant_id === A.id)).toBe(true);
          expect(seen.rows.some((r) => r.id === c.bId(B))).toBe(false);
        });
      });
    }

    it("partner_credit_ledger: A sees only its own entries and never B's balance", async () => {
      await asTenant(A.id, async () => {
        await assertRlsHarness(runtime, "partner_credit_ledger", A.id);
        const rows = await runtime.query<{ tenant_id: string }>("SELECT tenant_id FROM partner_credit_ledger");
        expect(rows.rows.length).toBeGreaterThan(0);
        expect(rows.rows.every((r) => r.tenant_id === A.id)).toBe(true);
      });
    });

    it("an explicit lookup of B's primary key by id returns nothing", async () => {
      await asTenant(A.id, async () => {
        const r = await runtime.query("SELECT id FROM partner_credit_reservations WHERE id=$1", [B.reservationId]);
        expect(r.rowCount).toBe(0);
      });
    });

    it("aggregates cannot leak B — count() over the whole table equals A's own count", async () => {
      const total = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_credit_reservations");
      await asTenant(A.id, async () => {
        const seen = await runtime.query<{ n: string }>("SELECT count(*)::text AS n FROM partner_credit_reservations");
        expect(Number(seen.rows[0].n)).toBe(1);
        expect(Number(seen.rows[0].n)).toBeLessThan(Number(total.rows[0].n));
      });
    });
  });

  // ------------------------------------------------------------------ write isolation
  describe("tenant A cannot WRITE tenant B", () => {
    it("UPDATE against B's reservation is refused and leaves it untouched", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite("UPDATE partner_credit_reservations SET reason='hijacked' WHERE id=$1", [
          B.reservationId,
        ]);
        expect(r.refusal).not.toBe("APPLIED");
      });
      const after = await admin.query<{ reason: string }>(
        "SELECT reason FROM partner_credit_reservations WHERE id=$1",
        [B.reservationId]
      );
      expect(after.rows[0].reason).not.toBe("hijacked");
    });

    it("an unqualified UPDATE (no WHERE at all) still cannot touch B", async () => {
      // The strongest form: if RLS is absent this rewrites every tenant's rows.
      await asTenant(A.id, async () => {
        await attemptWrite("UPDATE partner_credit_reservations SET reason='sweep'", []);
      });
      const b = await admin.query<{ reason: string }>("SELECT reason FROM partner_credit_reservations WHERE id=$1", [
        B.reservationId,
      ]);
      expect(b.rows[0].reason).not.toBe("sweep");
    });

    it("DELETE against B's submission is refused and B survives", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite("DELETE FROM partner_submissions WHERE id=$1", [B.submissionId]);
        expect(r.refusal).not.toBe("APPLIED");
      });
      const alive = await admin.query("SELECT 1 FROM partner_submissions WHERE id=$1", [B.submissionId]);
      expect(alive.rowCount).toBe(1);
    });

    it("INSERT of a row owned by B is refused", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite(
          `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
           VALUES ($1,$2,$3,1,'draft')`,
          [B.id, B.locationId, B.userId]
        );
        expect(r.refusal).toBe("denied");
      });
      const count = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM partner_submissions WHERE tenant_id=$1",
        [B.id]
      );
      expect(Number(count.rows[0].n)).toBe(1);
    });

    it("A cannot CONSUME B's credit — the settlement-shaped write is refused", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite(
          `UPDATE partner_credit_reservations
              SET status='consumed', consumed_at=now()
            WHERE id=$1 AND status='active'`,
          [B.reservationId]
        );
        expect(r.refusal).not.toBe("APPLIED");
      });
      const b = await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [
        B.reservationId,
      ]);
      expect(b.rows[0].status).toBe("active");
    });

    it("A cannot RELEASE B's credit — the release-shaped write is refused", async () => {
      await asTenant(A.id, async () => {
        const r = await attemptWrite(
          `UPDATE partner_credit_reservations
              SET status='released', released_at=now()
            WHERE id=$1 AND status='active'`,
          [B.reservationId]
        );
        expect(r.refusal).not.toBe("APPLIED");
      });
      const b = await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [
        B.reservationId,
      ]);
      expect(b.rows[0].status).toBe("active");
    });

    it("A cannot append a reservation EVENT against B's reservation", async () => {
      await asTenant(A.id, async () => {
        const key = "rls-evil-event";
        const r = await attemptWrite(
          `INSERT INTO partner_credit_reservation_events
             (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
              request_fingerprint, source, reason, actor_type)
           VALUES ($1,$2,$3,'released',1,$4,md5($4)||md5($4||':f'),'system','cross tenant','system')`,
          [B.reservationId, B.walletId, B.id, key]
        );
        expect(r.refusal).toBe("denied");
      });
    });

    it("A cannot mint ledger credit for B", async () => {
      await asTenant(A.id, async () => {
        const key = "rls-evil-ledger";
        const r = await attemptWrite(
          `INSERT INTO partner_credit_ledger
             (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason,
              actor_type, request_fingerprint)
           VALUES ($1,$2,999,'purchase',$3,'admin','cross tenant','admin',md5($3)||md5($3||':f'))`,
          [B.walletId, B.id, key]
        );
        expect(r.refusal).toBe("denied");
      });
    });
  });

  // ------------------------------------------------------------------ context failure modes
  describe("missing or malformed tenant context fails closed", () => {
    for (const [name, value] of [
      ["missing", null],
      ["empty", ""],
      ["non-uuid", "not-a-uuid"],
      ["another tenant's id", "00000000-0000-0000-0000-0000000000ff"],
    ] as Array<[string, string | null]>) {
      it(`${name} context yields 0 rows across the money path`, async () => {
        await asTenant(value, async () => {
          for (const t of ["partner_wallets", "partner_credit_reservations", "partner_submissions"]) {
            const r = await runtime.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
            expect(Number(r.rows[0].n), `${t} must be empty without a valid tenant context`).toBe(0);
          }
        });
      });
    }
  });

  // ------------------------------------------------------------------ preserved 0001-era coverage
  describe("restricted-role privilege boundaries", () => {
    it("cannot read an existing MintVault table", async () => {
      await asTenant(A.id, async () => {
        await expect(runtime.query("SELECT 1 FROM certificates LIMIT 1")).rejects.toThrow(/permission denied/i);
      });
    });

    it("has no privilege on existing MintVault sequences", async () => {
      const r = await admin.query<{ g: boolean }>(
        "SELECT has_sequence_privilege('partner_runtime','certificates_id_seq','USAGE') AS g"
      );
      expect(r.rows[0].g).toBe(false);
    });

    it("audit events are append-only for the restricted role", async () => {
      await asTenant(A.id, async () => {
        await runtime.query("INSERT INTO partner_audit_events (tenant_id,action) VALUES ($1,'t')", [A.id]);
        const r = await attemptWrite("UPDATE partner_audit_events SET action='x'", []);
        expect(r.refusal).toBe("denied");
      });
    });

    it("F1: cannot INSERT/UPDATE/DELETE its own organisation", async () => {
      await asTenant(A.id, async () => {
        expect((await attemptWrite("DELETE FROM partner_organisations WHERE id=$1", [A.id])).refusal).toBe("denied");
        expect(
          (await attemptWrite("UPDATE partner_organisations SET status='REVOKED' WHERE id=$1", [A.id])).refusal
        ).toBe("denied");
      });
      const alive = await admin.query("SELECT 1 FROM partner_organisations WHERE id=$1", [A.id]);
      expect(alive.rowCount).toBe(1);
    });

    it("F2: a global feature flag is readable by a tenant but cannot be written by one", async () => {
      await admin.query("INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'global',true)");
      await asTenant(A.id, async () => {
        const seen = await runtime.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM partner_feature_flags WHERE flag='global'"
        );
        expect(Number(seen.rows[0].n)).toBe(1);
        const r = await attemptWrite(
          "INSERT INTO partner_feature_flags (tenant_id, flag) VALUES (NULL,'evil-global')",
          []
        );
        expect(r.refusal).not.toBe("APPLIED");
      });
    });
  });
});
