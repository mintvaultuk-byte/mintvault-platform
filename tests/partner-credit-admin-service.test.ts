/** G6C Super Admin credit adjustments on a self-owned PostgreSQL 17.10 cluster. */
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
let reservationService: typeof import("../server/partner/partner-credit-reservation-service");
let creditAdminService: typeof import("../server/partner/partner-credit-admin-service");
let counter = 0;

const superAdmin = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  actorEmail: "super-admin@example.test",
};
const otherAdmin = {
  actorUserId: "00000000-0000-4000-8000-000000000002",
  actorEmail: "other-admin@example.test",
};
const reservationActor = { actorUserId: null, actorEmail: "partner-user@example.test" };
const baseNow = new Date("2099-07-20T12:00:00.000Z");

function expectUtcIsoTimestamp(value: string): void {
  expect(typeof value).toBe("string");
  expect(value).not.toBeInstanceOf(Date);
  expect(new Date(value).toISOString()).toBe(value);
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

function expectOptionalUtcIsoTimestamp(value: string | null): void {
  if (value === null) {
    expect(value).toBeNull();
    return;
  }
  expectUtcIsoTimestamp(value);
}

function key(label: string): string {
  counter += 1;
  return `g6c-${label}-${counter}`;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query("CREATE TABLE submissions (id serial primary key, user_id varchar, tracking_number text unique)");
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
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
      [tenantId, `${name} location`]
    )
  ).rows[0].id;
  await walletService.ensureWallet(superAdmin, tenantId);
  return { tenantId, locationId };
}

async function seedCredits(tenantId: string, amount: number): Promise<void> {
  if (amount === 0) return;
  await walletService.appendFoundationCredit(superAdmin, {
    tenantId,
    amount,
    entryType: "purchase",
    source: "system",
    reason: "G6C realistic PostgreSQL test funding",
    idempotencyKey: key("seed"),
    actorType: "system",
  });
}

async function setWalletStatus(tenantId: string, status: "active" | "suspended" | "closed"): Promise<void> {
  await admin.query(
    `UPDATE partner_wallets
        SET status=$2,
            suspended_at=CASE WHEN $2='suspended' THEN now() ELSE NULL END,
            closed_at=CASE WHEN $2='closed' THEN now() ELSE NULL END,
            updated_at=now()
      WHERE tenant_id=$1`,
    [tenantId, status]
  );
}

function adjustmentInput(tenantId: string, quantity: number, label: string) {
  return {
    tenantId,
    quantity,
    reason: `G6C ${label} accounting reason`,
    idempotencyKey: key(label),
  };
}

function reserveInput(
  tenantId: string,
  locationId: string,
  label: string,
  expiresAt = new Date(baseNow.getTime() + 60 * 60 * 1000)
) {
  return {
    tenantId,
    locationId,
    cardReference: `CARD-${label}-${counter}`,
    submissionReference: `SUB-${label}-${counter}`,
    expiresAt,
    idempotencyKey: key(`reserve-${label}`),
    source: "portal" as const,
    reason: "Reserve one credit for G6C concurrency proof",
    actorType: "partner_user" as const,
    now: baseNow,
  };
}

async function ledgerCount(tenantId: string): Promise<number> {
  return Number(
    (
      await admin.query<{ count: string }>(
        `SELECT count(*)::bigint AS count
           FROM partner_credit_ledger l
           JOIN partner_wallets w ON w.id=l.wallet_id AND w.tenant_id=l.tenant_id
          WHERE w.tenant_id=$1`,
        [tenantId]
      )
    ).rows[0].count
  );
}

async function ledgerEntryCount(tenantId: string, source?: string): Promise<number> {
  const clause = source ? " AND l.source=$2" : "";
  const params = source ? [tenantId, source] : [tenantId];
  return Number(
    (
      await admin.query<{ count: string }>(
        `SELECT count(*)::bigint AS count
           FROM partner_credit_ledger l
           JOIN partner_wallets w ON w.id=l.wallet_id AND w.tenant_id=l.tenant_id
          WHERE w.tenant_id=$1${clause}`,
        params
      )
    ).rows[0].count
  );
}

async function reservationEventCount(tenantId: string, eventType: string): Promise<number> {
  return Number(
    (
      await admin.query<{ count: string }>(
        `SELECT count(*)::bigint AS count
           FROM partner_credit_reservation_events e
           JOIN partner_wallets w ON w.id=e.wallet_id AND w.tenant_id=e.tenant_id
          WHERE w.tenant_id=$1 AND e.event_type=$2`,
        [tenantId, eventType]
      )
    ).rows[0].count
  );
}

async function reservationStatus(reservationId: string): Promise<string> {
  return (
    await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [reservationId])
  ).rows[0].status;
}

function rejectedCode(result: PromiseSettledResult<unknown>): string | null {
  return result.status === "rejected" ? ((result.reason as { code?: string }).code ?? null) : null;
}

async function insertHistoryFixture(tenantId: string, createdAt: string, label: string): Promise<string> {
  const walletId = (await admin.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [tenantId]))
    .rows[0].id;
  return (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_credit_ledger
         (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, metadata, request_fingerprint, created_at)
       VALUES ($1,$2,1,'purchase',$3,'system','G6C pagination fixture','system','{}'::jsonb,$4,$5::timestamptz)
       RETURNING id`,
      [walletId, tenantId, key(`history-${label}`), "a".repeat(64), createdAt]
    )
  ).rows[0].id;
}

describe("Partner Network G6C Super Admin credit adjustments on PostgreSQL 17.10", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("credit-admin");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    const migrator = new Client({ connectionString: migratorUrlFrom(cluster.url) });
    await migrator.connect();
    try {
      // Keep the G6B admin-service fixture on its declared schema boundary;
      // G6D requires the separate owner-operated 0019 deployment path.
      await applyMigrations(
        migrator,
        listMigrationFiles().filter((file) => Number(file.number) < 19)
      );
    } finally {
      await migrator.end();
    }
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    walletService = await import("../server/partner/partner-wallet-service");
    reservationService = await import("../server/partner/partner-credit-reservation-service");
    creditAdminService = await import("../server/partner/partner-credit-admin-service");
  }, 90_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  it("adds credits on active and suspended wallets as immutable positive admin adjustments", async () => {
    const { tenantId } = await createTenant("G6C add status policy");
    const active = await creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 5, "active-add"));
    expect(active).toMatchObject({
      operation: "CREDIT_ADD",
      alreadyApplied: false,
      entry: { amount: 5, entryType: "admin_adjustment", source: "admin", actorUserId: superAdmin.actorUserId },
      summary: { status: "active", postedLedgerBalance: 5, activeReservedCredits: 0, availableCredits: 5 },
    });
    expect(
      (
        await admin.query<{ metadata: { adjustment_operation: string; adjustment_quantity: number } }>(
          "SELECT metadata FROM partner_credit_ledger WHERE id=$1",
          [active.entry.id]
        )
      ).rows[0].metadata
    ).toEqual({ adjustment_operation: "CREDIT_ADD", adjustment_quantity: 5 });

    await setWalletStatus(tenantId, "suspended");
    const suspended = await creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 2, "suspended-add"));
    expect(suspended.summary).toMatchObject({ status: "suspended", postedLedgerBalance: 7, availableCredits: 7 });
    expect(suspended.entry.amount).toBe(2);
  });

  it("normalizes wallet summary timestamps to UTC ISO strings without exposing Date instances", async () => {
    const { tenantId } = await createTenant("G6C summary timestamps");
    const active = await creditAdminService.getWalletSummary(tenantId);
    expectUtcIsoTimestamp(active.createdAt);
    expectUtcIsoTimestamp(active.updatedAt);
    expectOptionalUtcIsoTimestamp(active.suspendedAt);
    expectOptionalUtcIsoTimestamp(active.closedAt);
    expect(active).toMatchObject({ suspendedAt: null, closedAt: null });

    await setWalletStatus(tenantId, "suspended");
    const suspended = await creditAdminService.getWalletSummary(tenantId);
    expectUtcIsoTimestamp(suspended.createdAt);
    expectUtcIsoTimestamp(suspended.updatedAt);
    expectOptionalUtcIsoTimestamp(suspended.suspendedAt);
    expectOptionalUtcIsoTimestamp(suspended.closedAt);
    expect(suspended.suspendedAt).not.toBeNull();
    expect(suspended.closedAt).toBeNull();

    await setWalletStatus(tenantId, "closed");
    const closed = await creditAdminService.getWalletSummary(tenantId);
    expectUtcIsoTimestamp(closed.createdAt);
    expectUtcIsoTimestamp(closed.updatedAt);
    expectOptionalUtcIsoTimestamp(closed.suspendedAt);
    expectOptionalUtcIsoTimestamp(closed.closedAt);
    expect(closed.suspendedAt).toBeNull();
    expect(closed.closedAt).not.toBeNull();
  });

  it("removes only available credits on active and suspended wallets as negative admin adjustments", async () => {
    const { tenantId } = await createTenant("G6C remove status policy");
    await seedCredits(tenantId, 8);
    const active = await creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 3, "active-remove"));
    expect(active).toMatchObject({
      operation: "CREDIT_REMOVE",
      entry: { amount: -3, entryType: "admin_adjustment", source: "admin" },
      summary: { status: "active", postedLedgerBalance: 5, availableCredits: 5 },
    });

    await setWalletStatus(tenantId, "suspended");
    const suspended = await creditAdminService.removeCredits(
      superAdmin,
      adjustmentInput(tenantId, 2, "suspended-remove")
    );
    expect(suspended.summary).toMatchObject({ status: "suspended", postedLedgerBalance: 3, availableCredits: 3 });
    expect(suspended.entry.amount).toBe(-2);
  });

  it("blocks all closed-wallet adjustments without a ledger mutation", async () => {
    const { tenantId } = await createTenant("G6C closed policy");
    await seedCredits(tenantId, 5);
    await setWalletStatus(tenantId, "closed");
    const before = await ledgerCount(tenantId);
    await expect(
      creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 1, "closed-add"))
    ).rejects.toMatchObject({
      code: "WALLET_CLOSED",
      message: "Closed wallets cannot receive new credit adjustments.",
    });
    await expect(
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 1, "closed-remove"))
    ).rejects.toMatchObject({
      code: "WALLET_CLOSED",
    });
    expect(await ledgerCount(tenantId)).toBe(before);
  });

  it("rejects invalid quantities, reasons, actors, identifiers, and malformed tenant input", async () => {
    const { tenantId } = await createTenant("G6C validation");
    const base = adjustmentInput(tenantId, 1, "validation");
    await expect(creditAdminService.addCredits(superAdmin, { ...base, quantity: 0 })).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    await expect(creditAdminService.addCredits(superAdmin, { ...base, quantity: -1 })).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    for (const quantity of [1.5, Number.NaN, 1_000_000_001, Number.MAX_SAFE_INTEGER]) {
      await expect(creditAdminService.addCredits(superAdmin, { ...base, quantity })).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
      });
    }
    await expect(creditAdminService.addCredits(superAdmin, { ...base, reason: "   " })).rejects.toMatchObject({
      code: "INVALID_REASON",
    });
    await expect(creditAdminService.addCredits({ actorUserId: null }, base)).rejects.toMatchObject({
      code: "ACTOR_REQUIRED",
    });
    await expect(creditAdminService.addCredits(superAdmin, { ...base, idempotencyKey: "" })).rejects.toMatchObject({
      code: "INVALID_IDEMPOTENCY_KEY",
    });
    await expect(
      creditAdminService.addCredits(superAdmin, { ...base, reason: "x".repeat(2_001) })
    ).rejects.toMatchObject({
      code: "INVALID_REASON",
    });
    await expect(
      creditAdminService.addCredits(superAdmin, { ...base, idempotencyKey: "x".repeat(201) })
    ).rejects.toMatchObject({
      code: "INVALID_IDEMPOTENCY_KEY",
    });
    await expect(
      creditAdminService.addCredits(superAdmin, { ...base, tenantId: "not-a-tenant-uuid" })
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      creditAdminService.addCredits(superAdmin, { ...base, tenantId: "11111111-1111-4111-8111-111111111111" })
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
  });

  it("protects the posted and reserved portions of a wallet from unsafe removals", async () => {
    const { tenantId, locationId } = await createTenant("G6C available balance");
    await seedCredits(tenantId, 3);
    const beforeTooLarge = await ledgerCount(tenantId);
    await expect(
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 4, "over-posted"))
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_AVAILABLE_CREDITS",
    });
    expect(await ledgerCount(tenantId)).toBe(beforeTooLarge);

    const reservation = await reservationService.reserveCredit(
      reservationActor,
      reserveInput(tenantId, locationId, "reserved")
    );
    const beforeReserved = await ledgerCount(tenantId);
    await expect(
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 3, "over-available"))
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_AVAILABLE_CREDITS",
    });
    expect(await ledgerCount(tenantId)).toBe(beforeReserved);
    expect(
      (
        await admin.query<{ status: string }>("SELECT status FROM partner_credit_reservations WHERE id=$1", [
          reservation.reservation.id,
        ])
      ).rows[0].status
    ).toBe("active");
  });

  it("keeps historical ledger rows unchanged and never creates a G6B consumption event", async () => {
    const { tenantId } = await createTenant("G6C append only");
    await seedCredits(tenantId, 5);
    const historical = (
      await admin.query<Record<string, unknown>>(
        `SELECT l.id, l.wallet_id, l.tenant_id, l.amount, l.entry_type, l.idempotency_key, l.source, l.reason, l.actor_type,
                l.actor_user_id, l.actor_email, l.metadata, l.request_fingerprint, l.created_at
           FROM partner_credit_ledger l
           JOIN partner_wallets w ON w.id=l.wallet_id AND w.tenant_id=l.tenant_id
          WHERE w.tenant_id=$1`,
        [tenantId]
      )
    ).rows[0];
    const added = await creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 2, "append-add"));
    const removed = await creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 1, "append-remove"));
    expect(added.entry.amount).toBe(2);
    expect(removed.entry.amount).toBe(-1);
    expect(
      (
        await admin.query<Record<string, unknown>>(
          `SELECT id, wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type,
                  actor_user_id, actor_email, metadata, request_fingerprint, created_at
             FROM partner_credit_ledger WHERE id=$1`,
          [historical.id]
        )
      ).rows[0]
    ).toEqual(historical);
    expect(
      Number(
        (
          await admin.query<{ count: string }>(
            `SELECT count(*)::bigint AS count
               FROM partner_credit_reservation_events e
               JOIN partner_wallets w ON w.id=e.wallet_id AND w.tenant_id=e.tenant_id
              WHERE w.tenant_id=$1 AND e.event_type='consumed'`,
            [tenantId]
          )
        ).rows[0].count
      )
    ).toBe(0);
  });

  it("returns exact idempotent replays and rejects material key reuse across amount, reason, actor, wallet, and operation", async () => {
    const a = await createTenant("G6C idempotency A");
    const b = await createTenant("G6C idempotency B");
    const add = adjustmentInput(a.tenantId, 5, "idem-add");
    const first = await creditAdminService.addCredits(superAdmin, add);
    const replay = await creditAdminService.addCredits(superAdmin, add);
    expect(replay).toMatchObject({ alreadyApplied: true, entry: { id: first.entry.id, amount: 5 } });
    expect(await ledgerCount(a.tenantId)).toBe(1);
    await expect(creditAdminService.addCredits(superAdmin, { ...add, quantity: 4 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(
      creditAdminService.addCredits(superAdmin, { ...add, reason: "A different reason" })
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(creditAdminService.addCredits(otherAdmin, add)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(creditAdminService.addCredits(superAdmin, { ...add, tenantId: b.tenantId })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(creditAdminService.removeCredits(superAdmin, add)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });

    await seedCredits(b.tenantId, 4);
    const remove = adjustmentInput(b.tenantId, 2, "idem-remove");
    const firstRemove = await creditAdminService.removeCredits(superAdmin, remove);
    const replayRemove = await creditAdminService.removeCredits(superAdmin, remove);
    expect(replayRemove).toMatchObject({ alreadyApplied: true, entry: { id: firstRemove.entry.id, amount: -2 } });
    expect(await ledgerCount(b.tenantId)).toBe(2);
  });

  it("serialises duplicate additions and competing removals to one exact accounting result", async () => {
    const { tenantId } = await createTenant("G6C duplicate and removal concurrency");
    const add = adjustmentInput(tenantId, 4, "concurrent-add");
    const adds = await Promise.all(Array.from({ length: 8 }, () => creditAdminService.addCredits(superAdmin, add)));
    expect(adds.filter((result) => !result.alreadyApplied)).toHaveLength(1);
    expect(await ledgerCount(tenantId)).toBe(1);

    const removals = await Promise.allSettled([
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 3, "concurrent-remove-one")),
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 3, "concurrent-remove-two")),
    ]);
    expect(removals.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejectedCode(removals[0]) ?? rejectedCode(removals[1])).toBe("INSUFFICIENT_AVAILABLE_CREDITS");
    expect(await creditAdminService.getWalletSummary(tenantId)).toMatchObject({
      postedLedgerBalance: 1,
      activeReservedCredits: 0,
      availableCredits: 1,
    });
    expect(await ledgerEntryCount(tenantId, "admin")).toBe(2);
    expect(
      Number(
        (
          await admin.query<{ count: string }>(
            `SELECT count(*)::bigint AS count FROM partner_credit_ledger l
              JOIN partner_wallets w ON w.id=l.wallet_id AND w.tenant_id=l.tenant_id
             WHERE w.tenant_id=$1 AND l.source='admin' AND l.amount < 0`,
            [tenantId]
          )
        ).rows[0].count
      )
    ).toBe(1);
  });

  it("allows only the two serializable outcomes for concurrent add versus remove", async () => {
    const { tenantId } = await createTenant("G6C add remove race");
    await seedCredits(tenantId, 1);
    const results = await Promise.allSettled([
      creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 2, "race-add")),
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 2, "race-remove")),
    ]);
    const summary = await creditAdminService.getWalletSummary(tenantId);
    if (results[1].status === "fulfilled") {
      expect(results[0].status).toBe("fulfilled");
      expect(summary).toMatchObject({ postedLedgerBalance: 1, activeReservedCredits: 0, availableCredits: 1 });
      expect(await ledgerCount(tenantId)).toBe(3);
    } else {
      expect(results[0].status).toBe("fulfilled");
      expect(rejectedCode(results[1])).toBe("INSUFFICIENT_AVAILABLE_CREDITS");
      expect(summary).toMatchObject({ postedLedgerBalance: 3, activeReservedCredits: 0, availableCredits: 3 });
      expect(await ledgerCount(tenantId)).toBe(2);
    }
  });

  it("allows only reserve-or-remove outcomes and preserves the exact reservation position", async () => {
    const { tenantId, locationId } = await createTenant("G6C reserve remove race");
    await seedCredits(tenantId, 2);
    const results = await Promise.allSettled([
      reservationService.reserveCredit(reservationActor, reserveInput(tenantId, locationId, "reserve-race")),
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 2, "reserve-race-remove")),
    ]);
    const summary = await creditAdminService.getWalletSummary(tenantId);
    if (results[0].status === "fulfilled") {
      expect(results[1].status).toBe("rejected");
      expect(rejectedCode(results[1])).toBe("INSUFFICIENT_AVAILABLE_CREDITS");
      expect(summary).toMatchObject({ postedLedgerBalance: 2, activeReservedCredits: 1, availableCredits: 1 });
      expect(await ledgerCount(tenantId)).toBe(1);
      expect(await reservationEventCount(tenantId, "reserved")).toBe(1);
    } else {
      expect(results[1].status).toBe("fulfilled");
      expect(rejectedCode(results[0])).toBe("INSUFFICIENT_CREDITS");
      expect(summary).toMatchObject({ postedLedgerBalance: 0, activeReservedCredits: 0, availableCredits: 0 });
      expect(await ledgerCount(tenantId)).toBe(2);
      expect(await reservationEventCount(tenantId, "reserved")).toBe(0);
    }
  });

  it("serialises consume versus removal without confusing consumption and admin adjustment", async () => {
    const { tenantId, locationId } = await createTenant("G6C consume remove race");
    await seedCredits(tenantId, 1);
    const reservation = await reservationService.reserveCredit(
      reservationActor,
      reserveInput(tenantId, locationId, "consume-race")
    );
    const results = await Promise.allSettled([
      reservationService.consumeReservedCredit(reservationActor, {
        tenantId,
        reservationId: reservation.reservation.id,
        idempotencyKey: key("consume-race"),
        source: "portal",
        reason: "Consume in concurrent G6C proof",
        actorType: "partner_user",
        now: baseNow,
      }),
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 1, "consume-race-remove")),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(rejectedCode(results[1])).toBe("INSUFFICIENT_AVAILABLE_CREDITS");
    expect(await reservationStatus(reservation.reservation.id)).toBe("consumed");
    expect(await creditAdminService.getWalletSummary(tenantId)).toMatchObject({
      postedLedgerBalance: 0,
      activeReservedCredits: 0,
      availableCredits: 0,
    });
    expect(await reservationEventCount(tenantId, "consumed")).toBe(1);
    expect(await ledgerEntryCount(tenantId, "admin")).toBe(0);
    expect(
      Number(
        (
          await admin.query<{ count: string }>(
            `SELECT count(*)::bigint AS count FROM partner_credit_ledger
              WHERE correlation_id=$1 AND source='portal' AND amount=-1`,
            [reservation.reservation.id]
          )
        ).rows[0].count
      )
    ).toBe(1);
  });

  it("records exact release-or-removal outcomes without invalidating the reservation", async () => {
    const { tenantId, locationId } = await createTenant("G6C release remove race");
    await seedCredits(tenantId, 1);
    const reservation = await reservationService.reserveCredit(
      reservationActor,
      reserveInput(tenantId, locationId, "release-race")
    );
    const results = await Promise.allSettled([
      reservationService.releaseReservedCredit(reservationActor, {
        tenantId,
        reservationId: reservation.reservation.id,
        idempotencyKey: key("release-race"),
        source: "portal",
        reason: "Release in concurrent G6C proof",
        actorType: "partner_user",
        now: baseNow,
      }),
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 1, "release-race-remove")),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(await reservationStatus(reservation.reservation.id)).toBe("released");
    expect(await reservationEventCount(tenantId, "released")).toBe(1);
    const summary = await creditAdminService.getWalletSummary(tenantId);
    if (results[1].status === "fulfilled") {
      expect(summary).toMatchObject({ postedLedgerBalance: 0, activeReservedCredits: 0, availableCredits: 0 });
      expect(await ledgerEntryCount(tenantId, "admin")).toBe(1);
    } else {
      expect(rejectedCode(results[1])).toBe("INSUFFICIENT_AVAILABLE_CREDITS");
      expect(summary).toMatchObject({ postedLedgerBalance: 1, activeReservedCredits: 0, availableCredits: 1 });
      expect(await ledgerEntryCount(tenantId, "admin")).toBe(0);
    }
  });

  it("records exact expiry-or-removal outcomes and expires the reservation only once", async () => {
    const { tenantId, locationId } = await createTenant("G6C expiry remove race");
    await seedCredits(tenantId, 1);
    const expiresAt = new Date(baseNow.getTime() + 1_000);
    const reservation = await reservationService.reserveCredit(
      reservationActor,
      reserveInput(tenantId, locationId, "expiry-race", expiresAt)
    );
    const results = await Promise.allSettled([
      reservationService.expireReservedCredit(
        { actorUserId: null, actorEmail: "expiry@example.test" },
        {
          tenantId,
          reservationId: reservation.reservation.id,
          idempotencyKey: key("expiry-race"),
          source: "system",
          reason: "Expire in concurrent G6C proof",
          actorType: "system",
          now: new Date(expiresAt.getTime() + 1),
        }
      ),
      creditAdminService.removeCredits(superAdmin, adjustmentInput(tenantId, 1, "expiry-race-remove")),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(await reservationStatus(reservation.reservation.id)).toBe("expired");
    expect(await reservationEventCount(tenantId, "expired")).toBe(1);
    const summary = await creditAdminService.getWalletSummary(tenantId);
    if (results[1].status === "fulfilled") {
      expect(summary).toMatchObject({ postedLedgerBalance: 0, activeReservedCredits: 0, availableCredits: 0 });
      expect(await ledgerEntryCount(tenantId, "admin")).toBe(1);
    } else {
      expect(rejectedCode(results[1])).toBe("INSUFFICIENT_AVAILABLE_CREDITS");
      expect(summary).toMatchObject({ postedLedgerBalance: 1, activeReservedCredits: 0, availableCredits: 1 });
      expect(await ledgerEntryCount(tenantId, "admin")).toBe(0);
    }
  });

  it("serializes a direct wallet closure and an adjustment to only valid committed states", async () => {
    const { tenantId } = await createTenant("G6C status race");
    const results = await Promise.allSettled([
      creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 1, "status-race-add")),
      setWalletStatus(tenantId, "closed"),
    ]);
    expect(results[1].status).toBe("fulfilled");
    const summary = await creditAdminService.getWalletSummary(tenantId);
    expect(summary.status).toBe("closed");
    if (results[0].status === "fulfilled") {
      expect(await ledgerCount(tenantId)).toBe(1);
      expect(summary.postedLedgerBalance).toBe(1);
    } else {
      expect(rejectedCode(results[0])).toBe("WALLET_CLOSED");
      expect(await ledgerCount(tenantId)).toBe(0);
      expect(summary.postedLedgerBalance).toBe(0);
    }
  });

  it("resolves cross-tenant concurrent idempotency collisions without cross-tenant results", async () => {
    const a = await createTenant("G6C cross tenant A");
    const b = await createTenant("G6C cross tenant B");
    const sharedKey = key("cross-tenant-key");
    const results = await Promise.allSettled([
      creditAdminService.addCredits(superAdmin, {
        tenantId: a.tenantId,
        quantity: 1,
        reason: "Cross tenant concurrency proof",
        idempotencyKey: sharedKey,
      }),
      creditAdminService.addCredits(superAdmin, {
        tenantId: b.tenantId,
        quantity: 1,
        reason: "Cross tenant concurrency proof",
        idempotencyKey: sharedKey,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejectedCode(results[0]) ?? rejectedCode(results[1])).toBe("IDEMPOTENCY_CONFLICT");
    expect((await ledgerCount(a.tenantId)) + (await ledgerCount(b.tenantId))).toBe(1);
    expect(
      (await creditAdminService.getWalletSummary(a.tenantId)).postedLedgerBalance +
        (await creditAdminService.getWalletSummary(b.tenantId)).postedLedgerBalance
    ).toBe(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.reason).not.toHaveProperty("entry");
    expect(rejected?.reason).not.toHaveProperty("summary");
  });

  it("returns exact established replays after closure but blocks new and changed requests", async () => {
    const { tenantId } = await createTenant("G6C closed replay");
    const input = adjustmentInput(tenantId, 2, "closed-replay");
    const first = await creditAdminService.addCredits(superAdmin, input);
    await setWalletStatus(tenantId, "closed");
    const replay = await creditAdminService.addCredits(superAdmin, input);
    expect(replay).toMatchObject({ alreadyApplied: true, entry: { id: first.entry.id, amount: 2 } });
    expect(await ledgerCount(tenantId)).toBe(1);
    await expect(
      creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 1, "closed-new"))
    ).rejects.toMatchObject({
      code: "WALLET_CLOSED",
    });
    await expect(creditAdminService.addCredits(superAdmin, { ...input, quantity: 3 })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("normalizes actor email before fingerprinting and preserves response privacy", async () => {
    const { tenantId } = await createTenant("G6C email normalization");
    const input = adjustmentInput(tenantId, 2, "email-normalization");
    const upper = { ...superAdmin, actorEmail: "Admin@Example.com" };
    const lower = { ...superAdmin, actorEmail: "admin@example.com" };
    const first = await creditAdminService.addCredits(upper, input);
    const replay = await creditAdminService.addCredits(lower, input);
    expect(replay).toMatchObject({ alreadyApplied: true, entry: { id: first.entry.id } });
    expect(await ledgerCount(tenantId)).toBe(1);
    expect(
      (
        await admin.query<{ actor_email: string }>("SELECT actor_email FROM partner_credit_ledger WHERE id=$1", [
          first.entry.id,
        ])
      ).rows[0].actor_email
    ).toBe("admin@example.com");
    await expect(
      creditAdminService.addCredits({ ...superAdmin, actorEmail: "different@example.com" }, input)
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    for (const value of [first, first.entry, first.summary]) {
      for (const field of [
        "metadata",
        "request_fingerprint",
        "requestFingerprint",
        "where",
        "detail",
        "constraint",
        "stack",
      ]) {
        expect(value).not.toHaveProperty(field);
      }
    }
  });

  it("maps only the actual reservation-protection trigger fallback to insufficient available credits", async () => {
    const { tenantId, locationId } = await createTenant("G6C trigger fallback");
    await seedCredits(tenantId, 1);
    await reservationService.reserveCredit(reservationActor, reserveInput(tenantId, locationId, "trigger-fallback"));
    const walletId = (
      await admin.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [tenantId])
    ).rows[0].id;
    let triggerError: unknown;
    try {
      await admin.query(
        `INSERT INTO partner_credit_ledger
           (wallet_id, tenant_id, amount, entry_type, idempotency_key, source, reason, actor_type, request_fingerprint)
         VALUES ($1,$2,-1,'admin_adjustment',$3,'system','Trigger fallback test','system',$4)`,
        [walletId, tenantId, key("trigger-fallback"), "b".repeat(64)]
      );
    } catch (error) {
      triggerError = error;
    }
    expect(triggerError).toMatchObject({ code: "23514" });
    expect(triggerError).toHaveProperty("where");
    expect(creditAdminService.mapAdminCreditDatabaseError(triggerError)).toMatchObject({
      code: "INSUFFICIENT_AVAILABLE_CREDITS",
    });
    const unrelated = { code: "23514", where: "PL/pgSQL function unrelated() line 1 at RAISE" };
    expect(creditAdminService.mapAdminCreditDatabaseError(unrelated)).toBe(unrelated);
  });

  it("provides deterministic wallet-bound keyset pages without duplicates, gaps, counts, or internal fields", async () => {
    const { tenantId } = await createTenant("G6C keyset history");
    const timestamp = "2099-01-01T12:34:56.123456Z";
    const expectedIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      expectedIds.push(await insertHistoryFixture(tenantId, timestamp, `${index}`));
    }
    const expectedOrder = (
      await admin.query<{ id: string }>(
        `SELECT l.id FROM partner_credit_ledger l JOIN partner_wallets w ON w.id=l.wallet_id AND w.tenant_id=l.tenant_id
          WHERE w.tenant_id=$1 ORDER BY l.created_at DESC, l.id DESC`,
        [tenantId]
      )
    ).rows.map((row) => row.id);
    expect(new Set(expectedIds).size).toBe(5);
    const first = await creditAdminService.listLedgerEntries(tenantId, 2);
    const second = await creditAdminService.listLedgerEntries(tenantId, 2, first.nextCursor);
    const third = await creditAdminService.listLedgerEntries(tenantId, 2, second.nextCursor);
    expect(first).toMatchObject({ hasMore: true });
    expect(second).toMatchObject({ hasMore: true });
    expect(third).toMatchObject({ hasMore: false, nextCursor: null });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toEqual(expect.any(String));
    const combined = [...first.entries, ...second.entries, ...third.entries];
    expect(combined).toHaveLength(5);
    expect(new Set(combined.map((entry) => entry.id)).size).toBe(5);
    expect(combined.map((entry) => entry.id)).toEqual(expectedOrder);
    for (const entry of combined) {
      expect(entry).not.toHaveProperty("metadata");
      expect(entry).not.toHaveProperty("request_fingerprint");
      expect(entry).not.toHaveProperty("requestFingerprint");
    }
    const other = await createTenant("G6C keyset other wallet");
    await expect(creditAdminService.listLedgerEntries(other.tenantId, 2, first.nextCursor)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    const malformedWalletCursor = Buffer.from(
      JSON.stringify({
        version: 1,
        walletId: "not-a-wallet-uuid",
        createdAt: first.entries[0].createdAt,
        id: first.entries[0].id,
      })
    ).toString("base64url");
    await expect(creditAdminService.listLedgerEntries(tenantId, 2, malformedWalletCursor)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    const calendarInvalidCursor = Buffer.from(
      JSON.stringify({
        version: 1,
        walletId: (await admin.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [tenantId]))
          .rows[0].id,
        createdAt: "2099-02-30T12:34:56.123456Z",
        id: first.entries[0].id,
      })
    ).toString("base64url");
    await expect(creditAdminService.listLedgerEntries(tenantId, 2, calendarInvalidCursor)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    await expect(creditAdminService.listLedgerEntries(tenantId, 2, "not-a-valid-cursor")).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    await expect(creditAdminService.listLedgerEntries(tenantId, 0)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    await expect(creditAdminService.listLedgerEntries(tenantId, -1)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    await expect(creditAdminService.listLedgerEntries(tenantId, 1.5)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    const canonicalStringPage = await creditAdminService.listLedgerEntries(tenantId, "2");
    expect(canonicalStringPage.entries).toHaveLength(2);
    await expect(creditAdminService.listLedgerEntries(tenantId, "2.0")).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
    await expect(creditAdminService.listLedgerEntries(tenantId, 201)).rejects.toMatchObject({
      code: "INVALID_PAGINATION",
    });
  });

  it("proves direct PostgreSQL ledger immutability without relying on the service", async () => {
    const { tenantId } = await createTenant("G6C ledger immutability");
    const adjustment = await creditAdminService.addCredits(superAdmin, adjustmentInput(tenantId, 1, "immutable"));
    await expect(
      admin.query("UPDATE partner_credit_ledger SET reason='changed' WHERE id=$1", [adjustment.entry.id])
    ).rejects.toMatchObject({
      code: "23001",
    });
    await expect(
      admin.query("DELETE FROM partner_credit_ledger WHERE id=$1", [adjustment.entry.id])
    ).rejects.toMatchObject({
      code: "23001",
    });
    await expect(admin.query("TRUNCATE partner_credit_ledger CASCADE")).rejects.toMatchObject({ code: "23001" });
    expect(await ledgerCount(tenantId)).toBe(1);
  });

  it("keeps migration ordering extensible through 0018 and exposes no destructive ledger operation", () => {
    const migrations = listMigrationFiles().map((migration) => migration.filename);
    const numbered = migrations.filter((filename) => /^\d{4,}_/.test(filename));
    const numbers = numbered.map((filename) => Number(filename.match(/^(\d+)_/)![1]));
    expect(migrations).toEqual(
      expect.arrayContaining([
        "0016_partner_wallet_ledger.sql",
        "0017_partner_credit_reservations.sql",
        "0018_correction_audit_index.sql",
      ])
    );
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(migrations.some((filename) => /g6c/i.test(filename))).toBe(false);
    const source = readFileSync(join(process.cwd(), "server/partner/partner-credit-admin-service.ts"), "utf8");
    expect(source).not.toMatch(/UPDATE\s+partner_credit_ledger/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+partner_credit_ledger/i);
    expect(source).not.toMatch(/\bOFFSET\b/i);
    expect(source).not.toMatch(/COUNT\(\*\)\s+OVER/i);
    expect(source).not.toMatch(/router\.|express\(/i);
  });
});
