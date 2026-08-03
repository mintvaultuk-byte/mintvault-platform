/**
 * DEFECT 4 — N-CARD RECOVERY CARDINALITY, on real PostgreSQL through the real services.
 *
 * THE DEFECT
 * ----------
 * Partner grading credits are per CARD, so cancelling an N-card submission releases N
 * reservations. Recovery, however, did two things exactly once:
 *   - the cancellation path anchored ONE hold to `reservations[0]`, and
 *   - `recoverPartnerDestinationCreditHold` took `ORDER BY created_at DESC LIMIT 1` and created
 *     ONE replacement reservation.
 *
 * That is not merely "incomplete recovery" — it is permanently unsettleable. Recovery links each
 * hold to its replacement via `recovery_reservation_id`, and
 * `findReservationsForPartnerSubmission` requires EVERY released predecessor to carry such a link
 * before it will allow settlement. With one hold and one replacement:
 *   - N-1 predecessors were never authorised, so the set failed
 *     "settled credit reservation with no authorised replacement", and
 *   - even ignoring that, 1 live reservation against N card units fails the
 *     `reservation_count_mismatch` reconciliation gate.
 * A recovered multi-card submission could therefore never be graded again.
 *
 * Everything below drives the REAL service entry points against a real cluster. Nothing is mocked.
 *
 * MUTATION TARGET: RECOVERY1 (collapse the N replacement reservations into one) must turn this red.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let lifecycle: typeof import("../server/partner/partner-submission-credit-lifecycle");
let submissions: typeof import("../server/partner/submission-service");
let sequence = 0;

const adminActor = { actorUserId: null, actorEmail: "recovery-admin@example.test" };
const SUPER_ADMIN_ID = "00000000-0000-0000-0000-0000000000a1";

interface TenantFixture {
  tenantId: string;
  locationId: string;
  userId: string;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz, grading_status varchar(30),
    assigned_grader_id varchar, scan_status varchar(30), scan_assigned_to varchar,
    shipped_at timestamptz, delivered_at timestamptz, completed_at timestamptz,
    return_tracking text, return_carrier text, return_service text,
    return_postage_cost numeric, on_receipt_photo_urls jsonb,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query("CREATE TABLE certificates (id serial primary key, cert_id text, submission_id integer)");
  await admin.query("CREATE TABLE label_prints (id serial primary key, certificate_id integer)");
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
      [`Recovery ${label} ${ordinal}`]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
      [tenantId, `Recovery ${label} HQ`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref,tenant_id,partner_id,email,password_hash,status,mfa_required)
       VALUES ($1,$2,$2,$3,'x','ACTIVE',false) RETURNING id`,
      [`recovery-${ordinal}`, tenantId, `recovery-${ordinal}@example.test`]
    )
  ).rows[0].id;
  await wallet.ensureWallet(adminActor, tenantId);
  await wallet.appendFoundationCredit(adminActor, {
    tenantId,
    amount: 500,
    entryType: "purchase",
    source: "admin",
    reason: "recovery test credits",
    idempotencyKey: `recovery-fund-${ordinal}`,
    actorType: "admin",
  });
  return { tenantId, locationId, userId };
}

function principalFor(f: TenantFixture) {
  return {
    sessionId: `recovery-${f.tenantId}`,
    tenantId: f.tenantId,
    userId: f.userId,
    locationId: f.locationId,
    mfaPassed: true,
    permissions: new Set(["partner.orders.create", "partner.orders.cancel"]),
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: true,
  };
}

/** Create and SUBMIT an n-card submission through the real service, reserving n credits. */
async function submitNCardSubmission(f: TenantFixture, n: number): Promise<string> {
  const principal = principalFor(f);
  const draft = await submissions.createSubmissionDraft(principal, { locationId: f.locationId });
  const submissionId = draft.id as string;
  for (let i = 1; i <= n; i++) {
    await submissions.addCard(principal, submissionId, { cardName: `card-${i}`, quantity: 1 });
  }
  await submissions.submitSubmission(principal, submissionId, `submit-${submissionId}`);
  return submissionId;
}

/** Attach a completed connector import + a pre-arrival destination submission. */
async function mapDestination(f: TenantFixture, partnerSubmissionId: string): Promise<number> {
  const handoff = await admin.query<{ id: string }>(
    "SELECT id FROM partner_submission_handoffs WHERE submission_id=$1",
    [partnerSubmissionId]
  );
  const connector = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_records (tenant_id,partner_submission_id,handoff_id,state,attempt_count)
     VALUES ($1,$2,$3,'imported',1) RETURNING id`,
    [f.tenantId, partnerSubmissionId, handoff.rows[0].id]
  );
  const validation = await admin.query<{ id: string }>(
    `INSERT INTO partner_connector_validation_runs
       (connector_record_id,validation_attempt,source_submission_version,source_handoff_status,
        source_fingerprint,source_fingerprint_version,outcome,blocking_error_count,warning_count,completed_at)
     VALUES ($1,1,1,'pending',$2,1,'valid',0,0,now()) RETURNING id`,
    [connector.rows[0].id, "a".repeat(64)]
  );
  const destination = await admin.query<{ id: number }>(
    "INSERT INTO submissions (user_id,tracking_number,status) VALUES ('recovery-customer',$1,'draft') RETURNING id",
    [`MV-REC-${++sequence}`]
  );
  await admin.query(
    `INSERT INTO partner_connector_imports
       (connector_record_id,partner_organisation_id,partner_location_id,partner_submission_id,partner_handoff_id,
        validation_run_id,source_fingerprint,source_fingerprint_version,mapping_version,import_attempt,
        state,destination_submission_id,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1,'completed',$8,now())`,
    [
      connector.rows[0].id,
      f.tenantId,
      f.locationId,
      partnerSubmissionId,
      handoff.rows[0].id,
      validation.rows[0].id,
      "a".repeat(64),
      destination.rows[0].id,
    ]
  );
  return destination.rows[0].id;
}

async function reservations(f: TenantFixture, submissionId: string) {
  return (
    await admin.query<{ id: string; status: string; card_reference: string }>(
      `SELECT id, status, card_reference FROM partner_credit_reservations
        WHERE tenant_id=$1 AND source='portal' AND submission_reference=$2
        ORDER BY created_at, id`,
      [f.tenantId, submissionId]
    )
  ).rows;
}

async function holds(f: TenantFixture, submissionId: string) {
  return (
    await admin.query<{ id: string; reservation_id: string; released_at: string | null; recovery_reservation_id: string | null }>(
      `SELECT id, reservation_id, released_at, recovery_reservation_id
         FROM partner_submission_credit_holds
        WHERE tenant_id=$1 AND partner_submission_id=$2
        ORDER BY created_at, id`,
      [f.tenantId, submissionId]
    )
  ).rows;
}

/** Cancel through the real partner path, which releases every card's credit and holds the destination. */
async function cancelSubmission(f: TenantFixture, submissionId: string): Promise<void> {
  await submissions.cancelSubmission(principalFor(f), submissionId, "recovery cardinality test");
}

const CARDINALITIES = [1, 2, 20] as const;

describe("N-card recovery cardinality (real PostgreSQL, real services)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-recovery-cardinality");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, PARTNER_MIGRATIONS_WITH_PER_CARD);
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    process.env.PARTNER_CONNECTOR_DATABASE_URL = cluster.url;
    wallet = await import("../server/partner/partner-wallet-service");
    lifecycle = await import("../server/partner/partner-submission-credit-lifecycle");
    submissions = await import("../server/partner/submission-service");
    await admin.query(
      `INSERT INTO partner_feature_flags (flag,tenant_id,location_id,enabled)
       VALUES ('partner_connector_enabled',NULL,NULL,true),('partner_emergency_stop',NULL,NULL,false)`
    );
  }, 180_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  for (const n of CARDINALITIES) {
    describe(`${n}-card submission`, () => {
      it(`cancellation releases ${n} credits and leaves ${n} holds — one per card`, async () => {
        const f = await createTenantFixture(`hold${n}`);
        const s = await submitNCardSubmission(f, n);
        await mapDestination(f, s);
        expect(await reservations(f, s)).toHaveLength(n);

        await cancelSubmission(f, s);

        const after = await reservations(f, s);
        expect(after).toHaveLength(n);
        expect(after.every((r) => r.status === "released")).toBe(true);
        // THE CARDINALITY THAT WAS WRONG: one hold anchored to reservations[0].
        const h = await holds(f, s);
        expect(h).toHaveLength(n);
        expect(new Set(h.map((x) => x.reservation_id)).size).toBe(n);
        expect(new Set(h.map((x) => x.reservation_id))).toEqual(new Set(after.map((r) => r.id)));
      });

      it(`recovery creates exactly ${n} replacement reservations with deterministic per-card references`, async () => {
        const f = await createTenantFixture(`rec${n}`);
        const s = await submitNCardSubmission(f, n);
        await mapDestination(f, s);
        const original = await reservations(f, s);
        await cancelSubmission(f, s);

        const result = await lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: f.tenantId,
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: `rec-${n}-${f.tenantId}`,
          reason: "authorised recovery test",
        });

        expect(result.recoveredCount).toBe(n);
        expect(result.reservationIds).toHaveLength(n);
        expect(new Set(result.reservationIds).size).toBe(n);

        const all = await reservations(f, s);
        const live = all.filter((r) => r.status === "active");
        expect(live).toHaveLength(n);
        // DETERMINISTIC PER-CARD REFERENCES: each replacement inherits its predecessor's card
        // reference, so credits stay one-per-card and reconcile against partner_submission_cards.
        expect(live.map((r) => r.card_reference).sort()).toEqual(original.map((r) => r.card_reference).sort());

        // every hold released and linked to a DISTINCT replacement
        const h = await holds(f, s);
        expect(h).toHaveLength(n);
        expect(h.every((x) => x.released_at !== null)).toBe(true);
        expect(new Set(h.map((x) => x.recovery_reservation_id)).size).toBe(n);
      });

      it(`a recovered ${n}-card submission can settle all ${n} credits`, async () => {
        // The end-to-end consequence of the defect: before this repair, a recovered multi-card
        // submission failed `reservation_count_mismatch` forever and could never be graded.
        const f = await createTenantFixture(`settle${n}`);
        const s = await submitNCardSubmission(f, n);
        const destinationId = await mapDestination(f, s);
        await cancelSubmission(f, s);
        await lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: f.tenantId,
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: `settle-${n}-${f.tenantId}`,
          reason: "authorised recovery test",
        });

        const settled = await lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "completed");
        expect(settled).not.toBeNull();

        const all = await reservations(f, s);
        expect(all.filter((r) => r.status === "consumed")).toHaveLength(n);
        expect(all.filter((r) => r.status === "active")).toHaveLength(0);
      });

      it(`ledger and audit totals reconcile to ${n}`, async () => {
        const f = await createTenantFixture(`recon${n}`);
        const s = await submitNCardSubmission(f, n);
        const destinationId = await mapDestination(f, s);
        await cancelSubmission(f, s);
        await lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: f.tenantId,
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: `recon-${n}-${f.tenantId}`,
          reason: "authorised recovery test",
        });
        await lifecycle.settlePartnerCreditForDestinationStatus(destinationId, "completed");

        // N consume events, exactly one per card.
        const consumed = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM partner_credit_reservation_events e
             JOIN partner_credit_reservations r ON r.id = e.reservation_id
            WHERE r.tenant_id=$1 AND r.submission_reference=$2 AND e.event_type='consumed'`,
          [f.tenantId, s]
        );
        expect(Number(consumed.rows[0].n)).toBe(n);

        // N recovery audit rows. These previously shared one idempotency key and collapsed to a
        // single row under ON CONFLICT DO NOTHING, so the audit trail could never reconcile to N.
        const audit = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM partner_credit_accounting_exceptions
            WHERE tenant_id=$1 AND partner_submission_id=$2 AND event_type='destination_credit_recovery'`,
          [f.tenantId, s]
        );
        expect(Number(audit.rows[0].n)).toBe(n);

        // N hold-created audit rows, for the same reason.
        const holdAudit = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM partner_credit_accounting_exceptions
            WHERE tenant_id=$1 AND partner_submission_id=$2 AND event_type='destination_credit_hold'`,
          [f.tenantId, s]
        );
        expect(Number(holdAudit.rows[0].n)).toBe(n);

        // The wallet was debited exactly N for the grading, net of the released reservations.
        const consumedTotal = await admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM partner_credit_reservations
            WHERE tenant_id=$1 AND submission_reference=$2 AND status='consumed'`,
          [f.tenantId, s]
        );
        expect(Number(consumedTotal.rows[0].n)).toBe(n);
      });

      it("a retried recovery is idempotent and creates no duplicates", async () => {
        const f = await createTenantFixture(`retry${n}`);
        const s = await submitNCardSubmission(f, n);
        await mapDestination(f, s);
        await cancelSubmission(f, s);
        const key = `retry-${n}-${f.tenantId}`;

        const first = await lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: f.tenantId,
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: key,
          reason: "authorised recovery test",
        });
        const second = await lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: f.tenantId,
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: key,
          reason: "authorised recovery test",
        });

        expect(second.alreadyRecovered).toBe(true);
        expect(second.recoveredCount).toBe(n);
        expect(second.reservationIds.sort()).toEqual(first.reservationIds.sort());
        // no extra reservations, no extra holds
        const all = await reservations(f, s);
        expect(all.filter((r) => r.status === "active")).toHaveLength(n);
        expect(all).toHaveLength(2 * n); // n released predecessors + n active replacements
        expect(await holds(f, s)).toHaveLength(n);
      });
    });
  }

  // ------------------------------------------------------------------ refusals
  describe("recovery refuses unsafe requests", () => {
    it("cross-tenant recovery is refused and the victim's holds are untouched", async () => {
      const victim = await createTenantFixture("victim");
      const attacker = await createTenantFixture("attacker");
      const s = await submitNCardSubmission(victim, 3);
      await mapDestination(victim, s);
      await cancelSubmission(victim, s);

      await expect(
        lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: attacker.tenantId, // attacker's tenant, victim's submission
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: `cross-${attacker.tenantId}`,
          reason: "cross tenant attempt",
        })
      ).rejects.toThrow(/No Partner credit hold exists/i);

      const h = await holds(victim, s);
      expect(h).toHaveLength(3);
      expect(h.every((x) => x.released_at === null)).toBe(true);
      const all = await reservations(victim, s);
      expect(all.filter((r) => r.status === "active")).toHaveLength(0);
    });

    it("a submission with no hold at all is refused", async () => {
      const f = await createTenantFixture("nohold");
      const s = await submitNCardSubmission(f, 2);
      await expect(
        lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: f.tenantId,
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: `nohold-${f.tenantId}`,
          reason: "no hold",
        })
      ).rejects.toThrow(/No Partner credit hold exists/i);
    });

    it("partial recovery rolls back atomically — an inconsistent predecessor recovers nothing", async () => {
      const f = await createTenantFixture("atomic");
      const s = await submitNCardSubmission(f, 5);
      await mapDestination(f, s);
      await cancelSubmission(f, s);

      /**
       * Corrupt ONE predecessor of five. Reservation identity columns are immutable by trigger
       * (`partner_credit_reservations identity fields are immutable`), so the corruption is applied
       * to the HOLD: hold #3 is repointed at a reservation that is still ACTIVE and belongs to a
       * different submission. That fails the per-predecessor RELEASE_TERMINAL check.
       *
       * This is the shape that matters for atomicity: the inconsistency sits in the MIDDLE of the
       * set, so a naive card-by-card implementation would already have created two replacement
       * reservations and released two holds before reaching it.
       */
      const other = await submitNCardSubmission(f, 1);
      const otherReservation = (await reservations(f, other))[0];
      const held = await holds(f, s);
      await admin.query("UPDATE partner_submission_credit_holds SET reservation_id=$2 WHERE id=$1", [
        held[2].id,
        otherReservation.id,
      ]);

      await expect(
        lifecycle.recoverPartnerDestinationCreditHold({
          tenantId: f.tenantId,
          partnerSubmissionId: s,
          actorUserId: SUPER_ADMIN_ID,
          actorEmail: "superadmin@example.test",
          idempotencyKey: `atomic-${f.tenantId}`,
          reason: "atomic rollback test",
        })
      ).rejects.toThrow(/recovery linkage is inconsistent/i);

      // NOTHING was recovered: no hold released, no replacement reservation created.
      const after = await holds(f, s);
      expect(after).toHaveLength(5);
      expect(after.every((x) => x.released_at === null)).toBe(true);
      const all = await reservations(f, s);
      expect(all.filter((r) => r.status === "active")).toHaveLength(0);
      expect(all).toHaveLength(5);
    });
  });
});
