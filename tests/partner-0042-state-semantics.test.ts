/**
 * DEFECT 1 — migration 0042 credit-lifecycle STATE SEMANTICS, on real PostgreSQL.
 *
 * 0042 selected its "live" reservation set with
 *     status IN ('active', 'consumed', 'released', 'expired')
 * which is the ENTIRE domain permitted by 0017's CHECK constraint. A filter naming every legal
 * value is not a filter, so `v_live_count` was simply "how many reservations exist" and the
 * function had no way to distinguish the three states that actually matter:
 *
 *     ACTIVE            active              outstanding
 *     CONSUMED          consumed            settled BY GRADING    — partner was charged
 *     RELEASE_TERMINAL  released | expired  settled BY CANCELLATION — credit returned
 *
 * The concrete failure: a {consumed, released} submission has v_active_count = 0, so it fell into
 * the "fully settled already" branch. That branch asserts each reservation carries exactly one
 * terminal event matching its own status — true of BOTH statuses — so it returned 'already_settled'
 * and a connector cancellation completed against a submission whose cards had already been graded
 * and paid for.
 *
 * Every state below is constructed with direct SQL on purpose: the service layer refuses to create
 * mixed sets, so driving this through the services could not reach the cases under test.
 *
 * Cardinalities 1, 2 and 20 are exercised because the single-card path must stay byte-compatible
 * with 0041 while the N-card path is new.
 *
 * MUTATION TARGET: DB42 state/replay mutations must turn this file red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  RESERVATION_STATUS_ACTIVE,
  RESERVATION_STATUS_CONSUMED,
  RESERVATION_STATUS_DOMAIN,
  RESERVATION_STATUS_RELEASE_TERMINAL,
} from "@shared/partner-credit-reservation-states";

let cluster: DisposablePostgres17;
let admin: Client;
let sequence = 0;

const RUNTIME_LOGIN = "partner_0042_state_test";
const RUNTIME_PASSWORD = "synthetic"; // disposable cluster only

interface TenantFixture {
  tenantId: string;
  locationId: string;
  userId: string;
  walletId: string;
}

/** One reservation's desired terminal state, as the test wants to construct it. */
type DesiredStatus = "active" | "consumed" | "released" | "expired";

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    grading_status varchar(30), assigned_grader_id varchar, scan_status varchar(30),
    scan_assigned_to varchar, shipped_at timestamptz, delivered_at timestamptz,
    completed_at timestamptz, return_tracking text, return_carrier text, return_service text,
    return_postage_cost numeric, on_receipt_photo_urls jsonb,
    status_history jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  // 0041 attaches a credit-hold guard trigger to certificates and label_prints as well as
  // submissions. Omitting them would silently reduce requirement 10 to a one-trigger assertion.
  await admin.query(
    "CREATE TABLE certificates (id serial primary key, cert_id text, secret text)"
  );
  await admin.query(
    "CREATE TABLE label_prints (id serial primary key, certificate_id integer, created_at timestamptz not null default now())"
  );
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "label_prints"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function createTenantFixture(label: string): Promise<TenantFixture> {
  const ordinal = ++sequence;
  const tenantId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name,status) VALUES ($1,'ACTIVE') RETURNING id",
      [`State ${label} ${ordinal}`]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
      [tenantId, `State ${label} HQ`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref,tenant_id,partner_id,email,password_hash,status,mfa_required)
       VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
      [`state-${ordinal}`, tenantId, `state-${ordinal}@example.test`]
    )
  ).rows[0].id;
  const walletId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_wallets (tenant_id) VALUES ($1) RETURNING id",
      [tenantId]
    )
  ).rows[0].id;
  // Fund the wallet before any fixture debit. The ledger refuses a debit that would underfund the
  // outstanding active reservations, which is correct behaviour and must not be worked around.
  await admin.query(
    `INSERT INTO partner_credit_ledger
       (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason,
        actor_type, request_fingerprint)
     VALUES ($1,$2,1000,'purchase',$3,'admin','state fixture funding','admin',md5($3)||md5($3||':f'))`,
    [walletId, tenantId, `fund-${tenantId}`]
  );
  return { tenantId, locationId, userId, walletId };
}

/** A partner submission with `n` single-quantity cards. */
async function makeSubmission(f: TenantFixture, n: number): Promise<string> {
  const id = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id,location_id,created_by,card_count,status)
       VALUES ($1,$2,$3,$4,'draft') RETURNING id`,
      [f.tenantId, f.locationId, f.userId, n]
    )
  ).rows[0].id;
  for (let i = 1; i <= n; i++) {
    await admin.query(
      `INSERT INTO partner_submission_cards (tenant_id,submission_id,sequence_number,card_name,quantity)
       VALUES ($1,$2,$3,$4,1)`,
      [f.tenantId, id, i, `card-${i}`]
    );
  }
  return id;
}

/**
 * Create one reservation per requested status, each with a DISTINCT card_reference and, for any
 * non-active status, exactly one matching terminal event — i.e. the shape a healthy settlement
 * leaves behind. That matters: it means every refusal proved below is caused by the STATE MIXTURE
 * alone, not by missing or malformed evidence.
 */
async function seedReservations(
  f: TenantFixture,
  submissionId: string,
  statuses: DesiredStatus[],
  options: { skipEvidenceForIndex?: number } = {}
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, status] of statuses.entries()) {
    const key = `state-${submissionId}-${index}`;
    // chk_..._expiry requires expires_at > created_at, so an EXPIRED row must be backdated rather
    // than given a past expiry against a now() creation.
    const created = status === "expired" ? "now() - interval '2 days'" : "now()";
    const expiresAt = status === "expired" ? "now() - interval '1 day'" : "now() + interval '365 days'";
    const row = await admin.query<{ id: string }>(
      `INSERT INTO partner_credit_reservations
         (wallet_id, tenant_id, location_id, card_reference, submission_reference, reserved_credits,
          status, idempotency_key, request_fingerprint, source, reason, actor_type,
          created_at, expires_at, consumed_at, released_at, expired_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,md5($7)||md5($7||':f'),'portal','state fixture','admin',
               ${created}, ${expiresAt},
               CASE WHEN $6='consumed' THEN now() END,
               CASE WHEN $6='released' THEN now() END,
               CASE WHEN $6='expired'  THEN now() END)
       RETURNING id`,
      [f.walletId, f.tenantId, f.locationId, `card-${index + 1}`, submissionId, status, key]
    );
    ids.push(row.rows[0].id);
    if (status !== "active" && index !== options.skipEvidenceForIndex) {
      /**
       * chk_..._ledger_link makes a 'consumed' event REQUIRE a ledger entry and forbids one on any
       * other event type. Honouring that is what makes these fixtures the same shape a real
       * settlement produces — a consumed credit is a real debit against the wallet.
       */
      let ledgerId: string | null = null;
      if (status === "consumed") {
        const ledger = await admin.query<{ id: string }>(
          `INSERT INTO partner_credit_ledger
             (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason,
              actor_type, request_fingerprint)
           VALUES ($1,$2,-1,'admin_adjustment',$3,'system','state fixture','system',md5($3)||md5($3||':f'))
           RETURNING id`,
          [f.walletId, f.tenantId, `led-${key}`]
        );
        ledgerId = ledger.rows[0].id;
      }
      await admin.query(
        `INSERT INTO partner_credit_reservation_events
           (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
            request_fingerprint, source, reason, actor_type, ledger_entry_id)
         VALUES ($1,$2,$3,$4,1,$5,md5($5)||md5($5||':f'),'system','state fixture','system',$6::uuid)`,
        [row.rows[0].id, f.walletId, f.tenantId, status, `evt-${key}`, ledgerId]
      );
    }
  }
  return ids;
}

/**
 * Attach a completed connector import and a pre-arrival destination.
 *
 * WITHOUT THIS the hold assertions in the mixed-state cases are UNFALSIFIABLE. 0042 only creates
 * holds when `v_destination_count = 1`, so with no partner_connector_imports row the hold branch
 * is dead code for the whole file and `expect(holds).toBe(0)` is the only possible result for any
 * implementation, correct or broken. Hoisting the hold INSERT above the mixed-state gate would
 * have gone undetected.
 */
async function mapDestination(f: TenantFixture, submissionId: string, connectorId: string): Promise<number> {
  const validation = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_validation_runs
       (connector_record_id,validation_attempt,source_submission_version,source_handoff_status,
        source_fingerprint,source_fingerprint_version,outcome,blocking_error_count,warning_count,completed_at)
     VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
    [connectorId, "a".repeat(64)]
  );
  const destination = await admin.query<{ id: number }>(
    "INSERT INTO submissions (user_id,tracking_number,status) VALUES ('state-customer',$1,'draft') RETURNING id",
    [`MV-ST-${++sequence}`]
  );
  const handoff = await admin.query<{ id: string }>(
    "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
    [submissionId]
  );
  await admin.query(
    `INSERT INTO partner_connector_imports
       (connector_record_id,partner_organisation_id,partner_location_id,partner_submission_id,partner_handoff_id,
        validation_run_id,source_fingerprint,source_fingerprint_version,mapping_version,import_attempt,
        state,destination_submission_id,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'completed',$8,now())`,
    [connectorId, f.tenantId, f.locationId, submissionId, handoff.rows[0].id, validation.rows[0].id,
     "a".repeat(64), destination.rows[0].id]
  );
  return destination.rows[0].id;
}

async function makeConnector(f: TenantFixture, submissionId: string, state = "ready_for_import"): Promise<string> {
  const handoff = await admin.query<{ id: string }>(
    `INSERT INTO partner_submission_handoffs (tenant_id,submission_id,status,snapshot)
     VALUES ($1,$2,'pending','{}'::jsonb) RETURNING id`,
    [f.tenantId, submissionId]
  );
  const connector = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state,attempt_count)
     VALUES ($1,$2,$3,$4,1) RETURNING id`,
    [f.tenantId, submissionId, handoff.rows[0].id, state]
  );
  return connector.rows[0].id;
}

/** Invoke the release function as the restricted connector runtime, exactly as production does. */
async function callRelease(f: TenantFixture, connectorId: string, submissionId: string) {
  const url = new URL(cluster.url);
  url.username = RUNTIME_LOGIN;
  url.password = RUNTIME_PASSWORD;
  const runtime = new Client({ connectionString: url.toString() });
  await runtime.connect();
  try {
    await runtime.query("SELECT set_config('app.tenant_id', $1, false)", [f.tenantId]);
    const result = await runtime.query<{ outcome: string; reservation_id: string | null }>(
      `SELECT outcome, reservation_id
         FROM partner_connector_release_submission_credit($1::uuid,$2::uuid,$3::uuid,$4::text)`,
      [connectorId, f.tenantId, submissionId, "connector_cancelled"]
    );
    return result.rows[0];
  } finally {
    await runtime.end();
  }
}

async function statusesFor(f: TenantFixture, submissionId: string): Promise<string[]> {
  const r = await admin.query<{ status: string }>(
    `SELECT status FROM partner_credit_reservations
      WHERE tenant_id=$1 AND source='portal' AND submission_reference=$2
      ORDER BY created_at, id`,
    [f.tenantId, submissionId]
  );
  return r.rows.map((x) => x.status);
}

async function terminalEventCount(f: TenantFixture, submissionId: string): Promise<number> {
  const r = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM partner_credit_reservation_events e
       JOIN partner_credit_reservations r ON r.id = e.reservation_id
      WHERE r.tenant_id=$1 AND r.source='portal' AND r.submission_reference=$2
        AND e.event_type IN ('consumed','released','expired')`,
    [f.tenantId, submissionId]
  );
  return Number(r.rows[0].n);
}

const CARDINALITIES = [1, 2, 20] as const;

describe("0042 credit lifecycle state semantics (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-0042-state-semantics");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);
    await admin.query(`DO $$ BEGIN
        CREATE ROLE ${RUNTIME_LOGIN} LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END$$;`);
    await admin.query(`GRANT partner_connector_runtime TO ${RUNTIME_LOGIN}`);
  }, 120_000);

  afterAll(async () => {
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  // ------------------------------------------------------------------ requirement 8
  describe("SQL and TypeScript state definitions match", () => {
    const sql = readFileSync(
      join(process.cwd(), "migrations", "0042_partner_per_card_credit_settlement.sql"),
      "utf8"
    );

    it("0042 no longer filters on the entire status domain", () => {
      // The exact defect: a predicate naming all four legal values selects everything.
      expect(sql).not.toMatch(/status IN \('active', 'consumed', 'released', 'expired'\)/);
    });

    it("0042 partitions the domain into the same three states as the shared module", () => {
      expect(sql).toContain("status = 'active'");
      expect(sql).toContain("status = 'consumed'");
      expect(sql).toContain("status IN ('released', 'expired')");
      expect([...RESERVATION_STATUS_ACTIVE]).toEqual(["active"]);
      expect([...RESERVATION_STATUS_CONSUMED]).toEqual(["consumed"]);
      expect([...RESERVATION_STATUS_RELEASE_TERMINAL]).toEqual(["released", "expired"]);
    });

    it("the partition is total and disjoint against 0017's CHECK constraint", async () => {
      const check = readFileSync(
        join(process.cwd(), "migrations", "0017_partner_credit_reservations.sql"),
        "utf8"
      );
      const match = check.match(/CHECK \(status IN \(([^)]*)\)\)/);
      expect(match).not.toBeNull();
      const declared = match![1].split(",").map((s) => s.trim().replace(/'/g, ""));
      expect([...declared].sort()).toEqual([...RESERVATION_STATUS_DOMAIN].sort());
      // disjoint
      const all = [
        ...RESERVATION_STATUS_ACTIVE,
        ...RESERVATION_STATUS_CONSUMED,
        ...RESERVATION_STATUS_RELEASE_TERMINAL,
      ];
      expect(new Set(all).size).toBe(all.length);
    });
  });

  // ------------------------------------------------------------------ requirements 3, 4, 5, 6, 7, 9
  for (const n of CARDINALITIES) {
    describe(`${n}-card submission`, () => {
      it("all active + release → releases every card (requirement 3)", async () => {
        const f = await createTenantFixture(`rel${n}`);
        const s = await makeSubmission(f, n);
        await seedReservations(f, s, Array(n).fill("active"));
        const connector = await makeConnector(f, s);

        const result = await callRelease(f, connector, s);
        expect(result.outcome).toBe("released");
        expect(await statusesFor(f, s)).toEqual(Array(n).fill("released"));
        // exactly one terminal event per card — no duplicates, no misses
        expect(await terminalEventCount(f, s)).toBe(n);
      });

      it("all released + release replay → already_settled, no new events (requirement 4)", async () => {
        const f = await createTenantFixture(`replay${n}`);
        const s = await makeSubmission(f, n);
        await seedReservations(f, s, Array(n).fill("released"));
        const connector = await makeConnector(f, s);

        const before = await terminalEventCount(f, s);
        const result = await callRelease(f, connector, s);
        expect(result.outcome).toBe("already_settled");
        expect(await terminalEventCount(f, s)).toBe(before);
      });

      it("all expired + release replay → already_settled (requirement 4)", async () => {
        const f = await createTenantFixture(`exp${n}`);
        const s = await makeSubmission(f, n);
        await seedReservations(f, s, Array(n).fill("expired"));
        const connector = await makeConnector(f, s);

        expect((await callRelease(f, connector, s)).outcome).toBe("already_settled");
      });

      it("all consumed + release → already_settled and stays consumed (requirement 9 compatibility)", async () => {
        // 0041's single-reservation function returned 'already_settled' for a consumed reservation.
        // The per-card function must not change that, and must never downgrade a consumed row.
        const f = await createTenantFixture(`cons${n}`);
        const s = await makeSubmission(f, n);
        await seedReservations(f, s, Array(n).fill("consumed"));
        const connector = await makeConnector(f, s);

        expect((await callRelease(f, connector, s)).outcome).toBe("already_settled");
        expect(await statusesFor(f, s)).toEqual(Array(n).fill("consumed"));
      });
    });
  }

  // ------------------------------------------------------------------ mixed states (5, 6, 7)
  describe("mixed lifecycle states fail closed and write nothing", () => {
    /**
     * Each case is checked for BOTH the returned outcome AND the absence of any side effect. A
     * function that refuses but has already written a hold or an event is not failing closed.
     */
    const cases: Array<{ name: string; requirement: number; statuses: DesiredStatus[] }> = [
      { name: "active + consumed", requirement: 5, statuses: ["active", "consumed"] },
      { name: "active + released", requirement: 6, statuses: ["active", "released"] },
      { name: "active + expired", requirement: 6, statuses: ["active", "expired"] },
      { name: "consumed + released", requirement: 7, statuses: ["consumed", "released"] },
      { name: "consumed + expired", requirement: 7, statuses: ["consumed", "expired"] },
      // The 20-card shapes that a partial settlement would actually leave behind.
      {
        name: "19 consumed + 1 released (partial settlement)",
        requirement: 7,
        statuses: [...Array(19).fill("consumed" as const), "released"],
      },
      {
        name: "10 active + 10 consumed (interrupted consume)",
        requirement: 5,
        statuses: [...Array(10).fill("active" as const), ...Array(10).fill("consumed" as const)],
      },
    ];

    for (const c of cases) {
      it(`${c.name} → corrupt_linkage (requirement ${c.requirement})`, async () => {
        const f = await createTenantFixture(c.name.replace(/\W+/g, ""));
        const s = await makeSubmission(f, c.statuses.length);
        await seedReservations(f, s, c.statuses);
        const connector = await makeConnector(f, s);
        // A real destination mapping, so v_destination_count = 1 and the hold branch is LIVE.
        // Without it the "no hold was written" assertion below cannot fail for any implementation.
        await mapDestination(f, s, connector);

        const eventsBefore = await terminalEventCount(f, s);
        const statusesBefore = await statusesFor(f, s);

        const result = await callRelease(f, connector, s);
        expect(result.outcome).toBe("corrupt_linkage");

        // NOTHING changed: no status transitioned, no terminal event was appended, no hold created.
        expect(await statusesFor(f, s)).toEqual(statusesBefore);
        expect(await terminalEventCount(f, s)).toBe(eventsBefore);
        const holds = await admin.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM partner_submission_credit_holds WHERE partner_submission_id=$1",
          [s]
        );
        expect(Number(holds.rows[0].n)).toBe(0);
      });
    }

    it("the consumed+released case is the exact regression 0042 previously waved through", async () => {
      // Pinned separately and explicitly: before the repair this returned 'already_settled',
      // letting a connector cancellation complete for cards that had already been graded.
      const f = await createTenantFixture("regression");
      const s = await makeSubmission(f, 2);
      await seedReservations(f, s, ["consumed", "released"]);
      const connector = await makeConnector(f, s);

      const result = await callRelease(f, connector, s);
      expect(result.outcome).not.toBe("already_settled");
      expect(result.outcome).toBe("corrupt_linkage");
    });
  });

  /**
   * A uniformly-settled set is only a legitimate replay if its EVIDENCE is intact: every
   * reservation must carry exactly one terminal event, and that event's type must match the
   * reservation's own status. Without these cases the "already_settled" branch could be gutted
   * entirely and every other test here would still pass — mutation DB42-B demonstrated exactly
   * that, which is why they exist.
   */
  describe("replay evidence is verified, not assumed", () => {
    async function reservationIds(f: TenantFixture, submissionId: string): Promise<string[]> {
      const r = await admin.query<{ id: string }>(
        `SELECT id FROM partner_credit_reservations
          WHERE tenant_id=$1 AND source='portal' AND submission_reference=$2 ORDER BY created_at, id`,
        [f.tenantId, submissionId]
      );
      return r.rows.map((x) => x.id);
    }

    it("a settled reservation with NO terminal event → corrupt_linkage", async () => {
      // The one evidence corruption that IS reachable: a status transition written without its
      // matching event. This is what the "already_settled" branch's per-reservation check catches.
      const f = await createTenantFixture("evidence-missing");
      const s = await makeSubmission(f, 3);
      await seedReservations(f, s, ["released", "released", "released"], { skipEvidenceForIndex: 1 });
      const connector = await makeConnector(f, s);

      expect((await callRelease(f, connector, s)).outcome).toBe("corrupt_linkage");
    });

    /**
     * The other two corruptions the branch defends against are UNREACHABLE by construction, and
     * that is worth pinning explicitly rather than leaving as an untested assumption. Mutation
     * DB42-B (gutting the evidence comparison entirely) does not turn this file red for those two
     * cases — not because coverage is missing, but because the schema makes the states impossible.
     * These tests prove that claim instead of asserting it.
     */
    it("a SECOND terminal event for one reservation is refused by the database", async () => {
      const f = await createTenantFixture("evidence-duplicate");
      const s = await makeSubmission(f, 1);
      await seedReservations(f, s, ["released"]);
      const ids = await reservationIds(f, s);
      const dup = `dup-${s}`;
      await expect(
        admin.query(
          `INSERT INTO partner_credit_reservation_events
             (reservation_id, wallet_id, tenant_id, event_type, amount, idempotency_key,
              request_fingerprint, source, reason, actor_type)
           VALUES ($1,$2,$3,'released',1,$4,md5($4)||md5($4||':f'),'system','duplicate evidence','system')`,
          [ids[0], f.walletId, f.tenantId, dup]
        )
      ).rejects.toThrow(/uq_partner_credit_reservation_events_terminal/);
    });

    it("reservation events are append-only: UPDATE and DELETE are both refused", async () => {
      const f = await createTenantFixture("evidence-immutable");
      const s = await makeSubmission(f, 1);
      await seedReservations(f, s, ["released"]);
      const ids = await reservationIds(f, s);
      await expect(
        admin.query("UPDATE partner_credit_reservation_events SET event_type='expired' WHERE reservation_id=$1", [
          ids[0],
        ])
      ).rejects.toThrow(/append-only/i);
      await expect(
        admin.query("DELETE FROM partner_credit_reservation_events WHERE reservation_id=$1", [ids[0]])
      ).rejects.toThrow(/append-only/i);
    });
  });

  // ------------------------------------------------------------------ requirement 10
  describe("non-partner paths are unaffected", () => {
    it("0042 creates and drops no trigger and names no certificate or label object", () => {
      const sql = readFileSync(
        join(process.cwd(), "migrations", "0042_partner_per_card_credit_settlement.sql"),
        "utf8"
      );
      expect(sql).not.toMatch(/CREATE\s+TRIGGER/i);
      expect(sql).not.toMatch(/DROP\s+TRIGGER/i);
      expect(sql).not.toMatch(/\bALTER TABLE\s+(certificates|label_prints|submissions)\b/i);
    });

    it("the three hold-guard triggers 0041 installed are still attached and unchanged", async () => {
      const triggers = await admin.query<{ tgname: string; tgrelid: string }>(
        `SELECT t.tgname, c.relname AS tgrelid
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_partner_%credit_hold_guard'
          ORDER BY t.tgname`
      );
      expect(triggers.rows.map((r) => r.tgrelid).sort()).toEqual(["certificates", "label_prints", "submissions"]);
    });

    it("a non-partner submission can still transition status with no credit rows at all", async () => {
      const dest = await admin.query<{ id: number }>(
        "INSERT INTO submissions (user_id,tracking_number,status) VALUES ('plain-customer',$1,'draft') RETURNING id",
        [`MV-PLAIN-${++sequence}`]
      );
      await admin.query("UPDATE submissions SET status='completed', completed_at=now() WHERE id=$1", [
        dest.rows[0].id,
      ]);
      const after = await admin.query<{ status: string }>("SELECT status FROM submissions WHERE id=$1", [
        dest.rows[0].id,
      ]);
      expect(after.rows[0].status).toBe("completed");
    });
  });
});
