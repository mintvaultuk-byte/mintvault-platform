/**
 * THE ONBOARDING TEST CARD — the explicit marker, and the readiness it feeds.
 *
 * WHAT THIS SUITE IS DEFENDING. Before migration 0109 there was no canonical way to ask "has this
 * shop scanned its test card?", so every available answer was a guess: the newest Card Job, the
 * newest MV number, the newest submission, or whatever was created near setup time. Each of those
 * starts naming a real customer's card the moment a shop scans a live card during onboarding — and
 * an onboarding gate built on a mislabel either passes a shop that never tested or refuses one that
 * did. The marker replaces the guess with a declaration, and these are the properties that make the
 * declaration worth trusting:
 *
 *   * an ordinary NEW card is NORMAL, always, with no way to acquire the marker by accident;
 *   * ONLY an explicit declaration or MintVault's armed intent creates an ONBOARDING_TEST job;
 *   * `purpose` is immutable, so nothing can promote a customer's graded card into the gate;
 *   * a shop can have at most ONE open test card, so "the" test card is never ambiguous;
 *   * and the readiness verdict is derived server-side, failing closed on anything unestablished.
 *
 * The first five are PostgreSQL behaviours — a DEFAULT, a trigger, a partial unique index and a
 * transaction — so they are proven against a real database built by the real migration runner. The
 * sixth is a pure function and is proven exhaustively, including its UNKNOWN path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import {
  derivePartnerOperationalReadiness,
  testCardStateOf,
  type PartnerReadinessFacts,
} from "../server/partner/operational-readiness";

let cluster: DisposablePostgres17;
let admin: Client;
let wallet: typeof import("../server/partner/partner-wallet-service");
let authority: typeof import("../server/partner/card-job-authority");
let testCard: typeof import("../server/partner/test-card-authority");
let savedEnv: Record<string, string | undefined> = {};

const adminActor = { actorType: "admin" as const, actorUserId: null, actorEmail: "ops@mintvault.test" };

/** Per-card Card Job lineage plus the retention/marker/vocabulary migrations under test. */
const TEST_CARD_MIGRATIONS = [
  ...PARTNER_MIGRATIONS_WITH_PER_CARD,
  "0107_partner_management_audit_idempotency_scope",
  "0108_partner_setup_only_deletion_retention",
  "0109_partner_card_job_purpose",
  "0110_partner_permanent_deletion_audit_vocabulary",
] as const;

interface Fixture {
  tenantId: string;
  locationId: string;
  userId: string;
  stationId: string;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  await admin.query(`CREATE TABLE certificates (
    id serial primary key,
    certificate_number text not null unique,
    card_id integer,
    submission_item_id integer,
    status text not null default 'active',
    label_type text not null default 'Standard',
    grade_type text not null default 'numeric',
    source text,
    scan_status text,
    raw_uploaded boolean not null default false,
    created_by text,
    issued_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    origin_type text,
    origin_partner_id uuid,
    origin_partner_public_ref text,
    origin_partner_legal_name text,
    origin_partner_trading_name text,
    origin_location_id uuid,
    origin_location_public_ref text,
    origin_location_name text,
    origin_location_address text,
    origin_captured_at timestamptz,
    origin_snapshot_version integer
  )`);
  await admin.query(`CREATE TABLE cert_counter (
    id integer primary key, last_issued bigint not null default 0, updated_at timestamptz not null default now()
  )`);
  await admin.query("INSERT INTO cert_counter (id, last_issued) VALUES (1, 0)");
  for (const table of ["users", "submissions", "submission_items", "audit_log", "certificates", "cert_counter"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function makeTenant(label: string): Promise<Fixture> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}`, `${label} Ltd`]
    )
  ).rows[0].id;
  await admin.query(`INSERT INTO partner_profiles (tenant_id, trading_name) VALUES ($1,$2)`, [tenantId, label]);
  const locationId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, address, status)
       VALUES ($1,$2,$2,$3,'1 High Street','ACTIVE') RETURNING id`,
      [`loc-${label}`, tenantId, `${label} Shop`]
    )
  ).rows[0].id;
  const userId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
       VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
      [`usr-${label}`, tenantId, `${label}@shop.test`]
    )
  ).rows[0].id;
  const stationId = (await admin.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id;
  return { tenantId, locationId, userId, stationId };
}

async function addCredits(tenantId: string, amount: number, key: string): Promise<void> {
  await wallet.ensureWallet(adminActor, tenantId);
  await wallet.appendFoundationCredit(adminActor, {
    tenantId,
    amount,
    entryType: "purchase",
    source: "admin",
    reason: "onboarding test-card suite credits",
    idempotencyKey: key,
    actorType: "admin",
  });
}

function start(fixture: Fixture, opts: { clientOpId: string; purpose?: "NORMAL" | "ONBOARDING_TEST" }) {
  return authority.startNewCardJobAtStation({
    tenantId: fixture.tenantId,
    locationId: fixture.locationId,
    stationId: fixture.stationId,
    clientOpId: opts.clientOpId,
    actorUserId: fixture.userId,
    actorEmail: "operator@shop.test",
    cardName: null,
    purpose: opts.purpose ?? "NORMAL",
  });
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code ?? "UNKNOWN" };
  }
}

async function purposeOf(cardJobId: string): Promise<string> {
  const { rows } = await admin.query<{ purpose: string }>(`SELECT purpose FROM partner_card_jobs WHERE id=$1`, [
    cardJobId,
  ]);
  return rows[0].purpose;
}

/** Every operational dimension PASSing, so `onboarding.complete` turns purely on the test card. */
function operationallyReady(overrides: Partial<PartnerReadinessFacts> = {}): PartnerReadinessFacts {
  return {
    orgStatus: "ACTIVE",
    portalEnabled: true,
    loginFlagEnabled: true,
    emergencyStop: false,
    owner: {
      userStatus: "ACTIVE",
      passwordConfigured: true,
      invitationValid: true,
      mfaRequired: false,
      mfaConfigured: false,
    },
    locationEligible: true,
    deliveryAddressReady: true,
    operationsContactReady: true,
    station: {
      enrolledCount: 1,
      approvedActiveCount: 1,
      pendingApprovalCount: 0,
      active: {
        scannerConnected: true,
        lastSeenAt: new Date(1_700_000_000_000).toISOString(),
        calibrationStatus: "VALID",
        currentCalibrationId: "cal-1",
        currentProfileRevisionId: "rev-1",
        appVersion: "1.0.0",
        minimumSupportedVersion: null,
      },
    },
    staff: { scanCapableCount: 1, locationScopedWithoutLocation: 0 },
    credits: 5,
    testCard: { completedCount: 1, latest: { id: "job", mvNumber: "MV1", status: "COMPLETED", sidesAccepted: null } },
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("the onboarding test-card marker (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-onboarding-test-card");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, TEST_CARD_MIGRATIONS);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    wallet = await import("../server/partner/partner-wallet-service");
    authority = await import("../server/partner/card-job-authority");
    testCard = await import("../server/partner/test-card-authority");
    await admin.query(
      `INSERT INTO partner_feature_flags (flag,tenant_id,location_id,enabled)
       VALUES ('partner_emergency_stop',NULL,NULL,false)`
    );
  }, 300_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ---- THE MARKER ---------------------------------------------------------------------------
  it("makes an ordinary NEW card NORMAL, and reports the shop as never having started a test", async () => {
    const fixture = await makeTenant("normal");
    await addCredits(fixture.tenantId, 1, "normal");
    const job = await start(fixture, { clientOpId: "op-normal-aaaa" });

    expect(job.purpose).toBe("NORMAL");
    expect(await purposeOf(job.cardJobId)).toBe("NORMAL");

    const facts = await testCard.loadPartnerTestCardFacts(fixture.tenantId);
    expect(facts).toEqual({ completedCount: 0, latest: null });
    // The whole point: a real card exists, has an MV, is in flight — and is NOT the test card.
    expect(job.mvNumber).toMatch(/^MV\d+$/);
  });

  it("creates an ONBOARDING_TEST card only on an explicit declaration", async () => {
    const fixture = await makeTenant("explicit");
    await addCredits(fixture.tenantId, 2, "explicit");

    const declared = await start(fixture, { clientOpId: "op-explicit-aaa", purpose: "ONBOARDING_TEST" });
    expect(declared.purpose).toBe("ONBOARDING_TEST");
    expect(await purposeOf(declared.cardJobId)).toBe("ONBOARDING_TEST");

    const facts = await testCard.loadPartnerTestCardFacts(fixture.tenantId);
    expect(facts?.latest?.id).toBe(declared.cardJobId);
    expect(facts?.latest?.mvNumber).toBe(declared.mvNumber);
  });

  it("stamps the card the ARMED intent describes, and consumes the arm exactly once", async () => {
    const fixture = await makeTenant("armed");
    await addCredits(fixture.tenantId, 2, "armed");
    await admin.query(
      `UPDATE partner_profiles SET onboarding_test_card_armed_at = now(), onboarding_test_card_armed_by = $2
        WHERE tenant_id = $1`,
      [fixture.tenantId, fixture.userId]
    );

    // The station sends NOTHING about test cards — this is the ordinary NEW press.
    const first = await start(fixture, { clientOpId: "op-armed-first" });
    expect(first.purpose).toBe("ONBOARDING_TEST");
    expect(await testCard.loadOnboardingTestCardArmedAt(fixture.tenantId)).toBeNull();

    // The NEXT card is an ordinary one. An arm that survived would silently reclassify a customer's card.
    const second = await start(fixture, { clientOpId: "op-armed-second" });
    expect(second.purpose).toBe("NORMAL");
  });

  it("refuses to open a SECOND test card while one is still in flight", async () => {
    const fixture = await makeTenant("second");
    await addCredits(fixture.tenantId, 3, "second");
    await start(fixture, { clientOpId: "op-second-first", purpose: "ONBOARDING_TEST" });

    const refused = await settle(start(fixture, { clientOpId: "op-second-again", purpose: "ONBOARDING_TEST" }));
    expect(refused).toMatchObject({ ok: false, code: "TEST_CARD_ALREADY_OPEN" });

    /*
     * An ARMED intent behaves differently on purpose: the declaration is already satisfied by the
     * card in flight, so the arm is consumed and discarded and the shop gets an ordinary card. The
     * alternative — leaving it armed — would reclassify whichever card came next.
     */
    await admin.query(`UPDATE partner_profiles SET onboarding_test_card_armed_at = now() WHERE tenant_id = $1`, [
      fixture.tenantId,
    ]);
    const normal = await start(fixture, { clientOpId: "op-second-armed" });
    expect(normal.purpose).toBe("NORMAL");
    expect(await testCard.loadOnboardingTestCardArmedAt(fixture.tenantId)).toBeNull();

    // And exactly one open test card exists, which is what makes "the" test card unambiguous.
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) n FROM partner_card_jobs
        WHERE tenant_id=$1 AND purpose='ONBOARDING_TEST' AND status NOT IN ('COMPLETED','CANCELLED')`,
      [fixture.tenantId]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("makes the ambiguous two-open-test-cards state unreachable at the database", async () => {
    const fixture = await makeTenant("ambiguous");
    await addCredits(fixture.tenantId, 2, "ambiguous");
    const first = await start(fixture, { clientOpId: "op-ambiguous-one", purpose: "ONBOARDING_TEST" });

    // Bypassing the service entirely: the index, not the application, is what forbids this.
    const direct = await settle(
      admin.query(
        `INSERT INTO partner_card_jobs (tenant_id, submission_id, card_id, ordinal, card_reference, status, purpose)
         SELECT tenant_id, submission_id, card_id, 2, card_reference || ':2', 'NEEDS_SCAN', 'ONBOARDING_TEST'
           FROM partner_card_jobs WHERE id=$1`,
        [first.cardJobId]
      )
    );
    expect(direct.ok).toBe(false);
  });

  it("will not let any UPDATE promote or demote a card's purpose", async () => {
    const fixture = await makeTenant("immutable");
    await addCredits(fixture.tenantId, 2, "immutable");
    const normal = await start(fixture, { clientOpId: "op-immutable-one" });

    // The dangerous direction: relabelling a real customer's card as the shop's onboarding test.
    const promote = await settle(
      admin.query(`UPDATE partner_card_jobs SET purpose='ONBOARDING_TEST' WHERE id=$1`, [normal.cardJobId])
    );
    expect(promote.ok).toBe(false);

    const test = await start(fixture, { clientOpId: "op-immutable-two", purpose: "ONBOARDING_TEST" });
    const demote = await settle(
      admin.query(`UPDATE partner_card_jobs SET purpose='NORMAL' WHERE id=$1`, [test.cardJobId])
    );
    expect(demote.ok).toBe(false);
    expect(await purposeOf(normal.cardJobId)).toBe("NORMAL");
    expect(await purposeOf(test.cardJobId)).toBe("ONBOARDING_TEST");
  });

  it("never reports one shop's test card to another", async () => {
    const mine = await makeTenant("mine");
    const theirs = await makeTenant("theirs");
    await addCredits(mine.tenantId, 1, "mine");
    await start(mine, { clientOpId: "op-mine-test", purpose: "ONBOARDING_TEST" });

    expect((await testCard.loadPartnerTestCardFacts(mine.tenantId))?.latest).not.toBeNull();
    expect(await testCard.loadPartnerTestCardFacts(theirs.tenantId)).toEqual({ completedCount: 0, latest: null });
  });

  it("tracks the test card through the real capture lifecycle", async () => {
    const fixture = await makeTenant("lifecycle");
    await addCredits(fixture.tenantId, 1, "lifecycle");
    const job = await start(fixture, { clientOpId: "op-lifecycle-aaa", purpose: "ONBOARDING_TEST" });

    // NEEDS_SCAN — paid for, nothing photographed.
    expect((await testCard.loadPartnerTestCardFacts(fixture.tenantId))?.latest?.status).toBe("NEEDS_SCAN");
    expect(testCardStateOf("NEEDS_SCAN")).toBe("CAPTURING");

    await admin.query(`UPDATE partner_card_jobs SET status='CAPTURING' WHERE id=$1`, [job.cardJobId]);
    await admin.query(`UPDATE partner_card_jobs SET status='READY_TO_GRADE' WHERE id=$1`, [job.cardJobId]);
    const handedOver = await testCard.loadPartnerTestCardFacts(fixture.tenantId);
    expect(testCardStateOf(handedOver!.latest!.status)).toBe("READY_TO_GRADE");
    expect(handedOver!.completedCount).toBe(0);

    for (const status of ["GRADING", "SUBMITTED", "QA_REVIEW", "APPROVED"]) {
      await admin.query(`UPDATE partner_card_jobs SET status=$2 WHERE id=$1`, [job.cardJobId, status]);
    }
    const done = await testCard.loadPartnerTestCardFacts(fixture.tenantId);
    expect(testCardStateOf(done!.latest!.status)).toBe("COMPLETE");
    expect(done!.completedCount).toBe(1);
  });
});

/**
 * The readiness verdict itself. A pure function, so every state — including the ones a database
 * fixture cannot conveniently produce — is exercised directly rather than approximated.
 */
describe("onboarding test-card readiness", () => {
  const verdict = (facts: Partial<PartnerReadinessFacts>) =>
    derivePartnerOperationalReadiness(operationallyReady(facts));

  it("maps every Card Job status to exactly one onboarding state, and an unknown one to UNKNOWN", () => {
    expect(["CREDIT_RESERVED", "NEEDS_SCAN", "CAPTURING", "FIX_REQUIRED"].map(testCardStateOf)).toEqual([
      "CAPTURING",
      "CAPTURING",
      "CAPTURING",
      "CAPTURING",
    ]);
    expect(["READY_TO_GRADE", "GRADING", "SUBMITTED", "QA_REVIEW"].map(testCardStateOf)).toEqual([
      "READY_TO_GRADE",
      "READY_TO_GRADE",
      "READY_TO_GRADE",
      "READY_TO_GRADE",
    ]);
    expect(["APPROVED", "PRINTABLE", "COMPLETED"].map(testCardStateOf)).toEqual(["COMPLETE", "COMPLETE", "COMPLETE"]);
    expect(testCardStateOf("CANCELLED")).toBe("BLOCKED");
    // A lifecycle state added by a future migration must not complete somebody's onboarding.
    expect(testCardStateOf("SOME_FUTURE_STATE")).toBe("UNKNOWN");
  });

  it("says NOT_STARTED, in the operator's words, when no test card exists", () => {
    const result = verdict({ testCard: { completedCount: 0, latest: null } });
    expect(result.testCard.state).toBe("NOT_STARTED");
    expect(result.testCard.status).toBe("BLOCKED");
    expect(result.testCard.message).toBe("Scan one test card in MintVault Scanner.");
    expect(result.testCard.cardJob).toBeNull();
  });

  it("says CAPTURING while a side is still missing", () => {
    const result = verdict({
      testCard: {
        completedCount: 0,
        latest: { id: "j", mvNumber: "MV7", status: "CAPTURING", sidesAccepted: ["front"] },
      },
    });
    expect(result.testCard.state).toBe("CAPTURING");
    expect(result.testCard.message).toBe("Complete FRONT and BACK.");
    expect(result.testCard.cardJob).toEqual({
      id: "j",
      mvNumber: "MV7",
      status: "CAPTURING",
      sidesAccepted: ["front"],
    });
  });

  it("says READY_TO_GRADE once the card has reached Staff", () => {
    const result = verdict({
      testCard: {
        completedCount: 0,
        latest: { id: "j", mvNumber: "MV7", status: "READY_TO_GRADE", sidesAccepted: ["front", "back"] },
      },
    });
    expect(result.testCard.state).toBe("READY_TO_GRADE");
    expect(result.testCard.message).toBe("Test card has reached Staff review.");
    // Nothing for the shop to do, so it is offered no action it cannot act on.
    expect(result.testCard.actions.every((action) => action.audience === "SUPER_ADMIN")).toBe(true);
  });

  it("says BLOCKED with an authoritative reason when the test card was cancelled", () => {
    const result = verdict({
      testCard: { completedCount: 0, latest: { id: "j", mvNumber: "MV7", status: "CANCELLED", sidesAccepted: null } },
    });
    expect(result.testCard.state).toBe("BLOCKED");
    expect(result.testCard.message).toContain("cancelled");
  });

  it("FAILS CLOSED to UNKNOWN when the Card Job authority could not be consulted", () => {
    const result = verdict({ testCard: null });
    expect(result.testCard.state).toBe("UNKNOWN");
    expect(result.testCard.status).toBe("UNKNOWN");
    expect(result.testCard.message).toBe("Test card status unavailable.");
    // The property that matters: UNKNOWN is never a pass, in either verdict.
    expect(result.testCard.status).not.toBe("PASS");
    expect(result.onboarding.complete).toBe(false);
  });

  it("stays COMPLETE once a card has been proven, even while a re-test is in flight", () => {
    const result = verdict({
      testCard: {
        completedCount: 1,
        latest: { id: "second", mvNumber: "MV9", status: "NEEDS_SCAN", sidesAccepted: null },
      },
    });
    expect(result.testCard.state).toBe("COMPLETE");
    expect(result.onboarding.complete).toBe(true);
  });

  // ---- READY --------------------------------------------------------------------------------
  it("keeps Ready false until the test card is complete, without changing what `overall.ready` means", () => {
    for (const state of [
      { completedCount: 0, latest: null },
      { completedCount: 0, latest: { id: "j", mvNumber: "MV1", status: "CAPTURING", sidesAccepted: null } },
      { completedCount: 0, latest: { id: "j", mvNumber: "MV1", status: "READY_TO_GRADE", sidesAccepted: null } },
      { completedCount: 0, latest: { id: "j", mvNumber: "MV1", status: "CANCELLED", sidesAccepted: null } },
    ] as PartnerReadinessFacts["testCard"][]) {
      const result = verdict({ testCard: state });
      expect({ state: result.testCard.state, complete: result.onboarding.complete }).toEqual({
        state: result.testCard.state,
        complete: false,
      });
      /*
       * And `overall.ready` is UNTOUCHED. It answers "can this shop grade a card now?", which is
       * true before any test card exists — the Command Centre's blocked-partner rollup and the
       * Partner Portal both depend on that meaning, so the test card must not quietly change it.
       */
      expect(result.overall.ready).toBe(true);
      expect(Object.keys(result.dimensions)).not.toContain("testCard");
    }
  });

  it("completes onboarding only when the operational verdict AND the test card both pass", () => {
    expect(verdict({}).onboarding.complete).toBe(true);
    // A shop that has proven a card but has since run out of credits is not ready, so not complete.
    const broke = verdict({ credits: 0 });
    expect(broke.testCard.state).toBe("COMPLETE");
    expect(broke.overall.ready).toBe(false);
    expect(broke.onboarding.complete).toBe(false);
    expect(broke.onboarding.code).toBe("CREDITS_REQUIRED");
  });
});
