/** Partner Network G6B credit reservation lifecycle on a self-owned PostgreSQL 17.10 cluster. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { migratorUrlFrom, provisionRealisticRoles } from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

let cluster: DisposablePostgres17;
let admin: Client;
let walletService: typeof import("../server/partner/partner-wallet-service");
let service: typeof import("../server/partner/partner-credit-reservation-service");
let tenantA: string;
let tenantB: string;
let locationA: string;
let counter = 0;

const actor = { actorUserId: null, actorEmail: "g6b-test@example.com" };
const baseNow = new Date("2099-07-20T12:00:00.000Z");
const future = () => new Date(baseNow.getTime() + 60 * 60 * 1000);
const fp = (seed: string) => seed.repeat(64).slice(0, 64);
const rollbackSql = readFileSync(join(process.cwd(), "migrations", "rollback-partner-credit-reservations.sql"), "utf8");

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  // The complete numbered inventory also includes the Correction Mode audit index migration.
  // audit_log is application-owned legacy schema, so provide its required shape in this isolated
  // Partner fixture before the migrator applies every numbered migration.
  await admin.query(`
    CREATE TABLE audit_log (
      id serial PRIMARY KEY,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      action text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  for (const table of ["users", "submissions", "submission_items", "audit_log"]) {
    await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
  }
}

async function createTenant(name: string): Promise<{ tenantId: string; locationId: string }> {
  const tenantId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name,status) VALUES ($1,'ACTIVE') RETURNING id",
      [name]
    )
  ).rows[0].id;
  const locationId = (
    await admin.query<{ id: string }>(
      "INSERT INTO partner_locations (tenant_id,partner_id,name,status) VALUES ($1,$1,$2,'ACTIVE') RETURNING id",
      [tenantId, `${name} shop`]
    )
  ).rows[0].id;
  return { tenantId, locationId };
}

async function seedCredits(tenantId: string, amount: number, key: string): Promise<void> {
  await walletService.ensureWallet(actor, tenantId);
  await walletService.appendFoundationCredit(actor, {
    tenantId,
    amount,
    entryType: "purchase",
    source: "admin",
    reason: "G6B test credit package",
    idempotencyKey: key,
    actorType: "admin",
  });
}

function reserveInput(tenantId: string, locationId: string | null, card: string, key: string) {
  return {
    tenantId,
    locationId,
    cardReference: card,
    submissionReference: `SUB-${card}`,
    expiresAt: future(),
    idempotencyKey: key,
    source: "portal" as const,
    reason: "reserve one grading credit",
    actorType: "partner_user" as const,
    now: baseNow,
  };
}

describe("Partner Network G6B credit reservations on PostgreSQL 17.10", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("credit-reservations");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      await applyMigrations(migrator, listMigrationFiles());
    } finally {
      await migrator.end();
    }
    const a = await createTenant("G6B Tenant A");
    const b = await createTenant("G6B Tenant B");
    tenantA = a.tenantId;
    tenantB = b.tenantId;
    locationA = a.locationId;
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    walletService = await import("../server/partner/partner-wallet-service");
    service = await import("../server/partner/partner-credit-reservation-service");
    await seedCredits(tenantA, 20, "tenant-a-seed");
    await seedCredits(tenantB, 3, "tenant-b-seed");
  }, 90_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("applies migration 0017 with append-only event evidence, RLS, and runtime read-only grants", async () => {
    expect((await admin.query("SHOW server_version")).rows[0].server_version).toMatch(/^17\.10(?:\s|$)/);
    const objects = await admin.query(
      "SELECT to_regclass('public.partner_credit_reservations') reservations, to_regclass('public.partner_credit_reservation_events') events, to_regclass('public.partner_credit_availability') availability"
    );
    expect(objects.rows[0]).toEqual({
      reservations: "partner_credit_reservations",
      events: "partner_credit_reservation_events",
      availability: "partner_credit_availability",
    });
    const triggers = (
      await admin.query(
        "SELECT tgname FROM pg_trigger WHERE tgrelid IN ('partner_credit_reservations'::regclass,'partner_credit_reservation_events'::regclass) AND NOT tgisinternal"
      )
    ).rows.map((row) => row.tgname);
    expect(triggers).toContain("trg_partner_credit_reservation_identity_no_mutate");
    expect(triggers).toContain("trg_partner_credit_reservation_events_no_row_mutate");
    expect(triggers).toContain("trg_partner_credit_reservation_events_no_truncate");
    const rls = await admin.query(
      "SELECT bool_and(relrowsecurity AND relforcerowsecurity) ok FROM pg_class WHERE relname IN ('partner_credit_reservations','partner_credit_reservation_events')"
    );
    expect(rls.rows[0].ok).toBe(true);
    for (const table of ["partner_credit_reservations", "partner_credit_reservation_events"]) {
      const grants = (
        await admin.query(
          "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee='partner_runtime' ORDER BY 1",
          [table]
        )
      ).rows.map((row) => row.privilege_type);
      expect(grants).toEqual(["SELECT"]);
    }
  });

  it("fails closed when the wallet does not exist", async () => {
    await expect(
      service.reserveCredit(actor, reserveInput("11111111-1111-4111-8111-111111111111", null, "NO-WALLET", "no-wallet"))
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  it("reserves and consumes exactly one credit, with idempotent retries and immutable ledger debit", async () => {
    counter++;
    const result = await service.reserveCredit(
      actor,
      reserveInput(tenantA, locationA, `CARD-CONSUME-${counter}`, `reserve-consume-${counter}`)
    );
    expect(result.alreadyApplied).toBe(false);
    expect(result.reservation.status).toBe("active");
    let position = await service.getCreditPosition(tenantA);
    expect(position.availableBalance).toBe(position.ledgerBalance - position.activeReserved);

    const consumed = await service.consumeReservedCredit(actor, {
      tenantId: tenantA,
      reservationId: result.reservation.id,
      idempotencyKey: `consume-${counter}`,
      source: "portal",
      reason: "card accepted for grading",
      actorType: "partner_user",
      now: baseNow,
    });
    const retry = await service.consumeReservedCredit(actor, {
      tenantId: tenantA,
      reservationId: result.reservation.id,
      idempotencyKey: `consume-${counter}`,
      source: "portal",
      reason: "card accepted for grading",
      actorType: "partner_user",
      now: baseNow,
    });
    expect(consumed.reservation.status).toBe("consumed");
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.event?.id).toBe(consumed.event?.id);
    position = await service.getCreditPosition(tenantA);
    expect(position.activeReserved).toBeGreaterThanOrEqual(0);
    const ledger = await admin.query<{ amount: string; n: string }>(
      "SELECT SUM(amount)::bigint amount, count(*)::bigint n FROM partner_credit_ledger WHERE correlation_id=$1",
      [result.reservation.id]
    );
    expect(ledger.rows[0]).toMatchObject({ amount: "-1", n: "1" });
    await expect(
      admin.query(
        "UPDATE partner_credit_reservations SET status='released', released_at=now(), consumed_at=NULL WHERE id=$1",
        [result.reservation.id]
      )
    ).rejects.toMatchObject({ code: "23001" });
    await expect(
      service.releaseReservedCredit(actor, {
        tenantId: tenantA,
        reservationId: result.reservation.id,
        idempotencyKey: `release-after-consume-${counter}`,
        source: "portal",
        reason: "too late",
        actorType: "partner_user",
        now: baseNow,
      })
    ).rejects.toMatchObject({ code: "RESERVATION_NOT_ACTIVE" });
  });

  it("allows suspended wallets to settle existing reservations while rejecting new activity", async () => {
    counter++;
    const { tenantId, locationId } = await createTenant(`G6B Suspended Wallet ${counter}`);
    await seedCredits(tenantId, 3, `suspended-wallet-seed-${counter}`);
    const before = await service.getCreditPosition(tenantId);
    const consumeTarget = await service.reserveCredit(
      actor,
      reserveInput(tenantId, locationId, `SUSPENDED-CONSUME-${counter}`, `suspended-consume-reserve-${counter}`)
    );
    const releaseTarget = await service.reserveCredit(
      actor,
      reserveInput(tenantId, locationId, `SUSPENDED-RELEASE-${counter}`, `suspended-release-reserve-${counter}`)
    );
    const expireNow = new Date("2099-07-20T14:00:00.000Z");
    const expireTarget = await service.reserveCredit(actor, {
      ...reserveInput(tenantId, locationId, `SUSPENDED-EXPIRE-${counter}`, `suspended-expire-reserve-${counter}`),
      expiresAt: new Date(expireNow.getTime() + 1000),
      now: expireNow,
    });
    expect((await service.getCreditPosition(tenantId)).availableBalance).toBe(before.availableBalance - 3);

    await admin.query(
      "UPDATE partner_wallets SET status='suspended', suspended_at=now(), updated_at=now() WHERE tenant_id=$1",
      [tenantId]
    );
    await expect(
      service.reserveCredit(
        actor,
        reserveInput(tenantId, locationId, `SUSPENDED-NEW-${counter}`, `suspended-new-${counter}`)
      )
    ).rejects.toMatchObject({ code: "WALLET_INACTIVE" });
    await expect(
      service.consumeReservedCredit(actor, {
        tenantId,
        reservationId: consumeTarget.reservation.id,
        idempotencyKey: `suspended-consume-${counter}`,
        source: "portal",
        reason: "suspended wallet",
        actorType: "partner_user",
        now: baseNow,
      })
    ).rejects.toMatchObject({ code: "WALLET_INACTIVE" });
    const released = await service.releaseReservedCredit(actor, {
      tenantId,
      reservationId: releaseTarget.reservation.id,
      idempotencyKey: `suspended-release-${counter}`,
      source: "portal",
      reason: "suspended wallet settlement",
      actorType: "partner_user",
      now: baseNow,
    });
    const expired = await service.expireReservedCredit(actor, {
      tenantId,
      reservationId: expireTarget.reservation.id,
      source: "system",
      reason: "suspended wallet expiry",
      actorType: "system",
      now: new Date(expireNow.getTime() + 2000),
    });
    expect(released.reservation.status).toBe("released");
    expect(expired.reservation.status).toBe("expired");
    expect(await service.getCreditPosition(tenantId)).toMatchObject({
      ledgerBalance: before.ledgerBalance,
      activeReserved: 1,
      availableBalance: before.availableBalance - 1,
      consumedReservations: before.consumedReservations,
    });
  });

  it("allows closed wallets to settle existing reservations while rejecting new activity", async () => {
    counter++;
    const { tenantId, locationId } = await createTenant(`G6B Closed Wallet ${counter}`);
    await seedCredits(tenantId, 3, `closed-wallet-seed-${counter}`);
    const before = await service.getCreditPosition(tenantId);
    const consumeTarget = await service.reserveCredit(
      actor,
      reserveInput(tenantId, locationId, `CLOSED-CONSUME-${counter}`, `closed-consume-reserve-${counter}`)
    );
    const releaseTarget = await service.reserveCredit(
      actor,
      reserveInput(tenantId, locationId, `CLOSED-RELEASE-${counter}`, `closed-release-reserve-${counter}`)
    );
    const expireNow = new Date("2099-07-20T14:00:00.000Z");
    const expireTarget = await service.reserveCredit(actor, {
      ...reserveInput(tenantId, locationId, `CLOSED-EXPIRE-${counter}`, `closed-expire-reserve-${counter}`),
      expiresAt: new Date(expireNow.getTime() + 1000),
      now: expireNow,
    });
    expect((await service.getCreditPosition(tenantId)).availableBalance).toBe(before.availableBalance - 3);

    await admin.query(
      "UPDATE partner_wallets SET status='closed', closed_at=now(), updated_at=now() WHERE tenant_id=$1",
      [tenantId]
    );
    await expect(
      service.reserveCredit(actor, reserveInput(tenantId, locationId, `CLOSED-NEW-${counter}`, `closed-new-${counter}`))
    ).rejects.toMatchObject({ code: "WALLET_INACTIVE" });
    await expect(
      service.consumeReservedCredit(actor, {
        tenantId,
        reservationId: consumeTarget.reservation.id,
        idempotencyKey: `closed-consume-${counter}`,
        source: "portal",
        reason: "closed wallet",
        actorType: "partner_user",
        now: baseNow,
      })
    ).rejects.toMatchObject({ code: "WALLET_INACTIVE" });
    const released = await service.releaseReservedCredit(actor, {
      tenantId,
      reservationId: releaseTarget.reservation.id,
      idempotencyKey: `closed-release-${counter}`,
      source: "portal",
      reason: "closed wallet settlement",
      actorType: "partner_user",
      now: baseNow,
    });
    const expired = await service.expireReservedCredit(actor, {
      tenantId,
      reservationId: expireTarget.reservation.id,
      source: "system",
      reason: "closed wallet expiry",
      actorType: "system",
      now: new Date(expireNow.getTime() + 2000),
    });
    expect(released.reservation.status).toBe("released");
    expect(expired.reservation.status).toBe("expired");
    expect(await service.getCreditPosition(tenantId)).toMatchObject({
      ledgerBalance: before.ledgerBalance,
      activeReserved: 1,
      availableBalance: before.availableBalance - 1,
      consumedReservations: before.consumedReservations,
    });
  });

  it("releases a reservation back to availability exactly once", async () => {
    counter++;
    const before = await service.getCreditPosition(tenantA);
    const reserved = await service.reserveCredit(
      actor,
      reserveInput(tenantA, locationA, `CARD-RELEASE-${counter}`, `reserve-release-${counter}`)
    );
    expect((await service.getCreditPosition(tenantA)).availableBalance).toBe(before.availableBalance - 1);
    const released = await service.releaseReservedCredit(actor, {
      tenantId: tenantA,
      reservationId: reserved.reservation.id,
      idempotencyKey: `release-${counter}`,
      source: "portal",
      reason: "customer cancelled",
      actorType: "partner_user",
      now: baseNow,
    });
    const retry = await service.releaseReservedCredit(actor, {
      tenantId: tenantA,
      reservationId: reserved.reservation.id,
      idempotencyKey: `release-${counter}`,
      source: "portal",
      reason: "customer cancelled",
      actorType: "partner_user",
      now: baseNow,
    });
    expect(released.reservation.status).toBe("released");
    expect(retry.alreadyApplied).toBe(true);
    expect((await service.getCreditPosition(tenantA)).availableBalance).toBe(before.availableBalance);
    const ledger = await admin.query<{ n: string }>(
      "SELECT count(*)::bigint n FROM partner_credit_ledger WHERE correlation_id=$1",
      [reserved.reservation.id]
    );
    expect(ledger.rows[0].n).toBe("0");
  });

  it("expires reservations deterministically and refuses consumption after expiry", async () => {
    counter++;
    const now = new Date("2099-07-20T12:00:00.000Z");
    const reserved = await service.reserveCredit(actor, {
      ...reserveInput(tenantA, locationA, `CARD-EXPIRE-${counter}`, `reserve-expire-${counter}`),
      expiresAt: new Date(now.getTime() + 1000),
      now,
    });
    await expect(
      service.consumeReservedCredit(actor, {
        tenantId: tenantA,
        reservationId: reserved.reservation.id,
        idempotencyKey: `consume-expired-${counter}`,
        source: "portal",
        reason: "too late",
        actorType: "partner_user",
        now: new Date(now.getTime() + 2000),
      })
    ).rejects.toMatchObject({ code: "RESERVATION_EXPIRED" });
    const expired = await service.expireExpiredReservations({
      now: new Date(now.getTime() + 2000),
      tenantId: tenantA,
      limit: 10,
    });
    expect(expired.expired).toContain(reserved.reservation.id);
    const repeat = await service.expireExpiredReservations({
      now: new Date(now.getTime() + 3000),
      tenantId: tenantA,
      limit: 10,
    });
    expect(repeat.expired).not.toContain(reserved.reservation.id);
  });

  it("expires suspended-wallet reservations in the sweep and restores their available credit", async () => {
    counter++;
    const suspendedTenant = await createTenant(`G6B Sweep Suspended ${counter}`);
    const activeTenant = await createTenant(`G6B Sweep Active ${counter}`);
    await seedCredits(suspendedTenant.tenantId, 1, `sweep-suspended-seed-${counter}`);
    await seedCredits(activeTenant.tenantId, 1, `sweep-active-seed-${counter}`);
    const now = new Date("2099-07-20T15:00:00.000Z");
    const suspendedReservation = await service.reserveCredit(actor, {
      ...reserveInput(
        suspendedTenant.tenantId,
        suspendedTenant.locationId,
        `SWEEP-SUSPENDED-${counter}`,
        `sweep-suspended-reserve-${counter}`
      ),
      expiresAt: new Date(now.getTime() + 1000),
      now,
    });
    const activeReservation = await service.reserveCredit(actor, {
      ...reserveInput(
        activeTenant.tenantId,
        activeTenant.locationId,
        `SWEEP-ACTIVE-${counter}`,
        `sweep-active-reserve-${counter}`
      ),
      expiresAt: new Date(now.getTime() + 2000),
      now,
    });
    await admin.query(
      "UPDATE partner_wallets SET status='suspended', suspended_at=now(), updated_at=now() WHERE tenant_id=$1",
      [suspendedTenant.tenantId]
    );

    const sweep = await service.expireExpiredReservations({ now: new Date(now.getTime() + 3000), limit: 10 });

    expect(sweep.expired).toContain(activeReservation.reservation.id);
    expect(sweep.expired).toContain(suspendedReservation.reservation.id);
    expect(
      (
        await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [
          suspendedReservation.reservation.id,
        ])
      ).rows[0].status
    ).toBe("expired");
    expect(
      (
        await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [
          activeReservation.reservation.id,
        ])
      ).rows[0].status
    ).toBe("expired");
    expect(await service.getCreditPosition(suspendedTenant.tenantId)).toMatchObject({
      ledgerBalance: 1,
      activeReserved: 0,
      availableBalance: 1,
    });
  });

  it("distinguishes exact idempotent retries from conflicting reuse, while allowing the same key in another tenant", async () => {
    counter++;
    const key = `reserve-idem-${counter}`;
    const first = await service.reserveCredit(actor, reserveInput(tenantA, locationA, `CARD-IDEM-${counter}`, key));
    const retry = await service.reserveCredit(actor, reserveInput(tenantA, locationA, `CARD-IDEM-${counter}`, key));
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.reservation.id).toBe(first.reservation.id);
    await expect(
      service.reserveCredit(actor, reserveInput(tenantA, locationA, `CARD-IDEM-DIFFERENT-${counter}`, key))
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    const otherTenant = await service.reserveCredit(actor, reserveInput(tenantB, null, `CARD-IDEM-${counter}`, key));
    expect(otherTenant.reservation.tenant_id).toBe(tenantB);
  });

  it("enforces one live or consumed reservation per grading-attempt card reference", async () => {
    counter++;
    const card = `CARD-UNIQUE-${counter}`;
    await service.reserveCredit(actor, reserveInput(tenantA, locationA, card, `card-unique-a-${counter}`));
    await expect(
      service.reserveCredit(actor, reserveInput(tenantA, locationA, card, `card-unique-b-${counter}`))
    ).rejects.toMatchObject({ code: "CARD_ALREADY_RESERVED" });
  });

  it("serializes two simultaneous reservations with only one available credit", async () => {
    counter++;
    const { tenantId, locationId } = await createTenant(`G6B One Credit ${counter}`);
    await seedCredits(tenantId, 1, `one-credit-seed-${counter}`);
    const settled = await Promise.allSettled([
      service.reserveCredit(actor, reserveInput(tenantId, locationId, `ONE-A-${counter}`, `one-a-${counter}`)),
      service.reserveCredit(actor, reserveInput(tenantId, locationId, `ONE-B-${counter}`, `one-b-${counter}`)),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((r) => r.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    expect(await service.getCreditPosition(tenantId)).toMatchObject({
      ledgerBalance: 1,
      activeReserved: 1,
      availableBalance: 0,
    });
  });

  it("blocks direct wallet-ledger debits that would underfund active reservations", async () => {
    counter++;
    const { tenantId, locationId } = await createTenant(`G6B Ledger Invariant ${counter}`);
    await seedCredits(tenantId, 2, `ledger-invariant-seed-${counter}`);
    const wallet = await walletService.getWallet(tenantId);
    await service.reserveCredit(
      actor,
      reserveInput(tenantId, locationId, `LEDGER-INVARIANT-${counter}`, `ledger-reserve-${counter}`)
    );
    await expect(
      admin.query(
        `INSERT INTO partner_credit_ledger
           (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint)
         VALUES ($1,$2,-2,'admin_adjustment',$3,'admin','would underfund active reservation','admin',$4)`,
        [wallet.id, tenantId, `ledger-underfund-${counter}`, fp("d")]
      )
    ).rejects.toMatchObject({ code: "23514" });

    await admin.query(
      `INSERT INTO partner_credit_ledger
         (wallet_id,tenant_id,amount,entry_type,idempotency_key,source,reason,actor_type,request_fingerprint)
       VALUES ($1,$2,-1,'admin_adjustment',$3,'admin','uses only unreserved credit','admin',$4)`,
      [wallet.id, tenantId, `ledger-unreserved-${counter}`, fp("e")]
    );
    expect(await service.getCreditPosition(tenantId)).toMatchObject({
      ledgerBalance: 1,
      activeReserved: 1,
      availableBalance: 0,
    });
  });

  it("coalesces simultaneous duplicate reservation, consume, and release requests", async () => {
    counter++;
    const duplicateReserve = reserveInput(tenantA, locationA, `DUP-RES-${counter}`, `dup-reserve-${counter}`);
    const reservedResults = await Promise.all(
      Array.from({ length: 8 }, () => service.reserveCredit(actor, duplicateReserve))
    );
    expect(new Set(reservedResults.map((r) => r.reservation.id)).size).toBe(1);
    expect(reservedResults.filter((r) => !r.alreadyApplied)).toHaveLength(1);

    const consumeReservation = await service.reserveCredit(
      actor,
      reserveInput(tenantA, locationA, `DUP-CONSUME-${counter}`, `dup-consume-reserve-${counter}`)
    );
    const consumeInput = {
      tenantId: tenantA,
      reservationId: consumeReservation.reservation.id,
      idempotencyKey: `dup-consume-${counter}`,
      source: "portal" as const,
      reason: "duplicate consume",
      actorType: "partner_user" as const,
      now: baseNow,
    };
    const consumeResults = await Promise.all(
      Array.from({ length: 8 }, () => service.consumeReservedCredit(actor, consumeInput))
    );
    expect(new Set(consumeResults.map((r) => r.event?.id)).size).toBe(1);
    expect(consumeResults.filter((r) => !r.alreadyApplied)).toHaveLength(1);

    const releaseReservation = await service.reserveCredit(
      actor,
      reserveInput(tenantA, locationA, `DUP-RELEASE-${counter}`, `dup-release-reserve-${counter}`)
    );
    const releaseInput = {
      tenantId: tenantA,
      reservationId: releaseReservation.reservation.id,
      idempotencyKey: `dup-release-${counter}`,
      source: "portal" as const,
      reason: "duplicate release",
      actorType: "partner_user" as const,
      now: baseNow,
    };
    const releaseResults = await Promise.all(
      Array.from({ length: 8 }, () => service.releaseReservedCredit(actor, releaseInput))
    );
    expect(new Set(releaseResults.map((r) => r.event?.id)).size).toBe(1);
    expect(releaseResults.filter((r) => !r.alreadyApplied)).toHaveLength(1);
  });

  it("allows only one terminal state in consume-versus-release and expiry-versus-consume races", async () => {
    counter++;
    const terminalRace = await service.reserveCredit(
      actor,
      reserveInput(tenantA, locationA, `RACE-TERM-${counter}`, `race-term-reserve-${counter}`)
    );
    const race = await Promise.allSettled([
      service.consumeReservedCredit(actor, {
        tenantId: tenantA,
        reservationId: terminalRace.reservation.id,
        idempotencyKey: `race-consume-${counter}`,
        source: "portal",
        reason: "consume race",
        actorType: "partner_user",
        now: baseNow,
      }),
      service.releaseReservedCredit(actor, {
        tenantId: tenantA,
        reservationId: terminalRace.reservation.id,
        idempotencyKey: `race-release-${counter}`,
        source: "portal",
        reason: "release race",
        actorType: "partner_user",
        now: baseNow,
      }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM partner_credit_reservation_events WHERE reservation_id=$1 AND event_type IN ('consumed','released','expired')",
          [terminalRace.reservation.id]
        )
      ).rows[0].n
    ).toBe(1);

    const now = new Date("2099-07-20T13:00:00.000Z");
    const expiryRace = await service.reserveCredit(actor, {
      ...reserveInput(tenantA, locationA, `RACE-EXP-${counter}`, `race-exp-reserve-${counter}`),
      expiresAt: new Date(now.getTime() + 1000),
      now,
    });
    const expiredNow = new Date(now.getTime() + 2000);
    const expireRace = await Promise.allSettled([
      service.consumeReservedCredit(actor, {
        tenantId: tenantA,
        reservationId: expiryRace.reservation.id,
        idempotencyKey: `race-exp-consume-${counter}`,
        source: "portal",
        reason: "consume after expiry",
        actorType: "partner_user",
        now: expiredNow,
      }),
      service.expireReservedCredit(actor, {
        tenantId: tenantA,
        reservationId: expiryRace.reservation.id,
        source: "system",
        reason: "expiry race",
        actorType: "system",
        now: expiredNow,
      }),
    ]);
    expect(expireRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(["RESERVATION_EXPIRED", "RESERVATION_NOT_ACTIVE"]).toContain(
      expireRace.find((r) => r.status === "rejected")?.reason.code
    );
  });

  it("rejects cross-tenant access to reservations", async () => {
    counter++;
    const reserved = await service.reserveCredit(
      actor,
      reserveInput(tenantA, locationA, `CROSS-${counter}`, `cross-reserve-${counter}`)
    );
    await expect(
      service.consumeReservedCredit(actor, {
        tenantId: tenantB,
        reservationId: reserved.reservation.id,
        idempotencyKey: `cross-consume-${counter}`,
        source: "portal",
        reason: "wrong tenant",
        actorType: "partner_user",
        now: baseNow,
      })
    ).rejects.toMatchObject({ code: "RESERVATION_NOT_FOUND" });
  });

  it("reports reconciliation discrepancies without repairing them", async () => {
    counter++;
    const wallet = await walletService.getWallet(tenantA);
    await admin.query(
      `INSERT INTO partner_credit_reservations
         (wallet_id, tenant_id, card_reference, reserved_credits, status, idempotency_key, request_fingerprint,
          source, reason, actor_type, metadata, expires_at, consumed_at)
       VALUES ($1,$2,$3,1,'consumed',$4,$5,'system','synthetic bad row','system','{}'::jsonb,$6,now())`,
      [
        wallet.id,
        tenantA,
        `BAD-RECON-${counter}`,
        `bad-recon-${counter}`,
        fp("c"),
        new Date("2100-01-01T00:00:00.000Z"),
      ]
    );
    const report = await service.reconcileCreditReservations();
    expect(report.issues.some((issue) => issue.code === "CONSUMED_EVIDENCE_MISSING")).toBe(true);
    expect(
      (
        await admin.query("SELECT count(*)::int n FROM partner_credit_reservations WHERE card_reference=$1", [
          `BAD-RECON-${counter}`,
        ])
      ).rows[0].n
    ).toBe(1);
  });

  it("refuses the G6B rollback script when a later migration or reservation evidence exists", async () => {
    await expect(admin.query(rollbackSql)).rejects.toThrow(/later migration \(0018\+\) is applied/);
    await admin.query("ROLLBACK").catch(() => {});
    // Reach the evidence guard exactly as a correct reverse-order rollback would: later migrations
    // (including the intentionally independent 0020 authentication and 0021 shop-launch migrations) are no longer
    // journalled, while G6B's immutable lifecycle evidence remains intact.
    await admin.query(
      "DELETE FROM schema_migrations WHERE filename IN ('0018_correction_audit_index.sql','0020_partner_auth_invitations_rbac.sql','0021_partner_shop_launch.sql')"
    );
    await expect(admin.query(rollbackSql)).rejects.toThrow(
      /partner_credit_reservation_events contains lifecycle evidence/
    );
    await admin.query("ROLLBACK").catch(() => {});
    expect((await admin.query("SELECT to_regclass('public.partner_credit_reservations') value")).rows[0].value).toBe(
      "partner_credit_reservations"
    );
  });
});
