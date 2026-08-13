/**
 * P9 — THE GRADING EDIT LEASE, proven against real PostgreSQL.
 *
 * THE DEFECT. Nothing prevented two graders opening the same Card Job and both saving. The second
 * save won, silently, and the first grader's assessment vanished without either being told — on a
 * record that becomes a permanent published grade with a certificate behind it.
 *
 * WHY EVERY CASE HERE NEEDS A REAL DATABASE. The guarantees are a partial UNIQUE index, an advisory
 * lock, `FOR UPDATE`, RLS and a `now()` comparison. A mock reproduces none of them, and the races
 * below are exactly where a hand-rolled check falls apart: a SELECT-then-INSERT "is it free" test
 * passes in every sequential test ever written and fails the first time two graders click at once.
 *
 * THE RACES ARE GENUINELY PARALLEL — Promise.all over SEPARATE POOL CONNECTIONS. Run sequentially
 * they would pass with the locking removed entirely, which is worse than having no test.
 *
 * Mutation targets: LEASE1 (one winner), LEASE2 (second cannot write), LEASE3 (heartbeat/expiry),
 * LEASE4 (audited takeover), LEASE5 (stale write refused), LEASE6 (tenant/location/role denial).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import type { PartnerPrincipal } from "../server/partner/session";

let cluster: DisposablePostgres17;
let admin: Client;
let leases: typeof import("../server/partner/grading-lease-service");
let savedEnv: Record<string, string | undefined> = {};

interface Fixture {
  tenantId: string;
  locationA: string;
  locationB: string;
  graderOne: string;
  graderTwo: string;
  owner: string;
}

async function seedMintVaultTables(): Promise<void> {
  await admin.query("CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)");
  await admin.query(`CREATE TABLE submissions (
    id serial primary key, user_id varchar, status varchar(30) not null default 'draft',
    tracking_number text not null unique, deleted_at timestamptz,
    status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
  )`);
  await admin.query("CREATE TABLE submission_items (id serial primary key, submission_id integer not null)");
  await admin.query(`CREATE TABLE audit_log (
    id serial primary key, entity_type text not null, entity_id text not null, action text not null,
    admin_user text, details jsonb, created_at timestamptz not null default now()
  )`);
  await admin.query(`CREATE TABLE certificates (
    id serial primary key, certificate_number text not null unique,
    card_id integer, submission_item_id integer, deleted_at timestamptz
  )`);
  for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates"]) {
    await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
  }
}

async function makeUser(tenantId: string, label: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO partner_users (public_ref, tenant_id, partner_id, email, status)
     VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
    [`usr-${label}`, tenantId, `${label}@shop.test`]
  );
  return rows[0].id;
}

async function makeTenant(label: string): Promise<Fixture> {
  const tenantId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_organisations (public_ref, legal_name, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`ref-${label}`, `${label} Ltd`]
    )
  ).rows[0].id;
  const mk = async (ref: string, name: string): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO partner_locations (public_ref, tenant_id, partner_id, name, status)
         VALUES ($1,$2,$2,$3,'ACTIVE') RETURNING id`,
        [ref, tenantId, name]
      )
    ).rows[0].id;
  return {
    tenantId,
    locationA: await mk(`loc-${label}-a`, "Rochester"),
    locationB: await mk(`loc-${label}-b`, "Bluewater"),
    graderOne: await makeUser(tenantId, `${label}-g1`),
    graderTwo: await makeUser(tenantId, `${label}-g2`),
    owner: await makeUser(tenantId, `${label}-owner`),
  };
}

/**
 * A Card Job in a chosen state — READY_TO_GRADE by default, which is what a grader opens.
 *
 * The state is set AT INSERT rather than transitioned into, because 0080's trigger enforces the
 * legal transition graph and most shortcuts between states are (correctly) illegal. Fighting a real
 * constraint to build a fixture would mean testing against a database that does not exist.
 */
async function makeGradableJob(
  f: Fixture,
  locationId: string,
  tag: string,
  status = "READY_TO_GRADE"
): Promise<string> {
  const submissionId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submissions (tenant_id, location_id, created_by, card_count, status)
       VALUES ($1,$2,$3,1,'draft') RETURNING id`,
      [f.tenantId, locationId, f.graderOne]
    )
  ).rows[0].id;
  const cardId = (
    await admin.query<{ id: string }>(
      `INSERT INTO partner_submission_cards (tenant_id, submission_id, sequence_number, card_name, quantity)
       VALUES ($1,$2,1,$3,1) RETURNING id`,
      [f.tenantId, submissionId, `Card ${tag}`]
    )
  ).rows[0].id;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO partner_card_jobs
       (tenant_id, submission_id, card_id, ordinal, card_reference, location_id, created_by, status)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7) RETURNING id`,
    [f.tenantId, submissionId, cardId, `partner-submission-card:${cardId}:1`, locationId, f.graderOne, status]
  );
  return rows[0].id;
}

function principal(
  f: Fixture,
  userId: string,
  opts: { orgWide?: boolean; locationId?: string | null; canGrade?: boolean } = {}
): PartnerPrincipal {
  const permissions = new Set<string>(["partner.dashboard.view", "partner.cards.view"]);
  if (opts.canGrade !== false) permissions.add("partner.cards.assess");
  return {
    sessionId: "00000000-0000-0000-0000-0000000000ff",
    tenantId: f.tenantId,
    userId,
    locationId: opts.locationId ?? f.locationA,
    mfaPassed: true,
    permissions,
    viewOnly: false,
    sensitiveDisabled: false,
    orgWide: opts.orgWide ?? false,
  };
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, code: (err as { code?: string })?.code ?? "UNKNOWN" };
  }
}

describe("P9 grading edit lease (real PostgreSQL)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("partner-grading-lease");
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    await seedMintVaultTables();
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      "0087_partner_grading_edit_lease",
    ]);
    savedEnv = {
      MINTVAULT_DATABASE_URL: process.env.MINTVAULT_DATABASE_URL,
      PARTNER_ADMIN_DATABASE_URL: process.env.PARTNER_ADMIN_DATABASE_URL,
      PARTNER_DATABASE_URL: process.env.PARTNER_DATABASE_URL,
    };
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    delete process.env.PARTNER_ADMIN_DATABASE_URL;
    delete process.env.PARTNER_DATABASE_URL;
    leases = await import("../server/partner/grading-lease-service");
  }, 180_000);

  afterAll(async () => {
    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ---- 1 & 2: LEASE1 — exactly one winner, genuinely in parallel -----------------------------
  it("1-2: two graders opening the SAME card simultaneously — exactly one gets edit authority", async () => {
    const f = await makeTenant("lease1");
    const job = await makeGradableJob(f, f.locationA, "a");

    // Separate pool connections, genuinely concurrent. Sequential calls would pass with the
    // advisory lock and the unique index both removed.
    const [a, b] = await Promise.all([
      settle(leases.acquireLease(principal(f, f.graderOne), job, "Chloe")),
      settle(leases.acquireLease(principal(f, f.graderTwo), job, "James")),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { code: string }).code).toBe("LEASE_HELD_BY_ANOTHER");

    // And the database holds exactly ONE live lease, not two.
    const live = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_grading_leases WHERE card_job_id=$1 AND released_at IS NULL`,
      [job]
    );
    expect(live.rows[0].n).toBe("1");
  });

  it("3: the grader who did NOT get the lease cannot mutate", async () => {
    const f = await makeTenant("lease3");
    const job = await makeGradableJob(f, f.locationA, "b");
    const held = await leases.acquireLease(principal(f, f.graderOne), job, "Chloe");

    const blocked = await settle(leases.acquireLease(principal(f, f.graderTwo), job, "James"));
    expect(blocked.ok).toBe(false);

    // The decisive check: the loser cannot WRITE, not merely cannot acquire.
    const write = await settle(
      (async () => {
        const db = await import("../server/partner/db");
        return db.withPartnerAdminTenantTransaction({ tenantId: f.tenantId, locationId: f.locationA }, (client) =>
          leases.assertMayWrite(client, principal(f, f.graderTwo), job, held.lease.revision)
        );
      })()
    );
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.code).toBe("NOT_LEASE_HOLDER");
  });

  it("2b: the occupied answer names the holder for a banner, and leaks no PII", async () => {
    const f = await makeTenant("lease2b");
    const job = await makeGradableJob(f, f.locationA, "c");
    await leases.acquireLease(principal(f, f.graderOne), job, "Chloe");

    try {
      await leases.acquireLease(principal(f, f.graderTwo), job, "James");
      throw new Error("expected LEASE_HELD_BY_ANOTHER");
    } catch (err) {
      const e = err as { code: string; detail?: { holderDisplay?: string | null } };
      expect(e.code).toBe("LEASE_HELD_BY_ANOTHER");
      expect(e.detail?.holderDisplay).toBe("Chloe");
      // No email, no user id in the operator-facing detail.
      expect(JSON.stringify(e.detail)).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  // ---- 4 & 5: LEASE3 — heartbeat and expiry --------------------------------------------------
  it("4: the heartbeat keeps the lease alive", async () => {
    const f = await makeTenant("lease4");
    const job = await makeGradableJob(f, f.locationA, "d");
    const first = await leases.acquireLease(principal(f, f.graderOne), job);

    const beat = await leases.heartbeatLease(principal(f, f.graderOne), job);
    expect(new Date(beat.expiresAt).getTime()).toBeGreaterThanOrEqual(new Date(first.lease.expiresAt).getTime());
    expect(beat.heldByYou).toBe(true);
  });

  it("5: an EXPIRED lease is reacquirable — an abandoned card does not lock forever", async () => {
    /*
     * Expiry is retired inside the next acquire's own transaction, so this works with no sweeper
     * having run. That is the design: correctness must not wait on a background job.
     */
    const f = await makeTenant("lease5");
    const job = await makeGradableJob(f, f.locationA, "e");
    await leases.acquireLease(principal(f, f.graderOne), job, "Chloe");
    /*
     * Age BOTH timestamps. chk_partner_grading_leases_expiry requires expires_at > acquired_at, so
     * moving only the expiry backwards violates the constraint — and an actually-abandoned lease
     * has both in the past anyway, so this is the faithful simulation rather than a workaround.
     */
    await admin.query(
      `UPDATE partner_grading_leases
          SET acquired_at = now() - interval '10 minutes',
              heartbeat_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 minute'
        WHERE card_job_id=$1 AND released_at IS NULL`,
      [job]
    );

    const second = await leases.acquireLease(principal(f, f.graderTwo), job, "James");
    expect(second.lease.heldByYou).toBe(true);
    expect(second.reacquired).toBe(true);

    // The original holder's lease was released, not deleted — it is evidence of who held what when.
    const history = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_grading_leases WHERE card_job_id=$1`,
      [job]
    );
    expect(Number(history.rows[0].n)).toBe(2);
  });

  it("5b: the holder of an EXPIRED lease cannot simply heartbeat it back to life", async () => {
    // Somebody else may already be part-way through the card; they must go via acquire and be told.
    const f = await makeTenant("lease5b");
    const job = await makeGradableJob(f, f.locationA, "f");
    await leases.acquireLease(principal(f, f.graderOne), job);
    await admin.query(
      `UPDATE partner_grading_leases
          SET acquired_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 minute'
        WHERE card_job_id=$1`,
      [job]
    );

    const beat = await settle(leases.heartbeatLease(principal(f, f.graderOne), job));
    expect(beat.ok).toBe(false);
    if (!beat.ok) expect(beat.code).toBe("LEASE_EXPIRED");
  });

  // ---- 6, 7 & 8: LEASE4 + LEASE5 — takeover, audit, stale write ------------------------------
  it("6-7: an authorised takeover succeeds and is AUDITED with a reason", async () => {
    const f = await makeTenant("lease6");
    const job = await makeGradableJob(f, f.locationA, "g");
    await leases.acquireLease(principal(f, f.graderOne), job, "Chloe");

    const taken = await leases.takeoverLease(
      principal(f, f.owner, { orgWide: true }),
      job,
      "Chloe went home mid-card",
      "Sam"
    );
    expect(taken.heldByYou).toBe(true);

    const audit = await admin.query<{
      action: string;
      actor_user_id: string;
      reason: string;
      before_value: Record<string, unknown>;
    }>(
      `SELECT action, actor_user_id, reason, before_value FROM partner_audit_events
        WHERE tenant_id=$1 AND action='partner_grading_lease_taken_over'`,
      [f.tenantId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_user_id).toBe(f.owner);
    expect(audit.rows[0].reason).toBe("Chloe went home mid-card");
    expect(audit.rows[0].before_value).toMatchObject({ holderUserId: f.graderOne });

    // The displaced lease is marked as taken over, not merely released — the trail distinguishes a
    // grader who finished from one whose card was removed.
    const displaced = await admin.query<{ taken_over_by: string | null }>(
      `SELECT taken_over_by FROM partner_grading_leases
        WHERE card_job_id=$1 AND holder_user_id=$2`,
      [job, f.graderOne]
    );
    expect(displaced.rows[0].taken_over_by).toBe(f.owner);
  });

  it("8: the DISPLACED grader cannot save afterwards — no silent overwrite", async () => {
    const f = await makeTenant("lease8");
    const job = await makeGradableJob(f, f.locationA, "h");
    const original = await leases.acquireLease(principal(f, f.graderOne), job, "Chloe");
    await leases.takeoverLease(principal(f, f.owner, { orgWide: true }), job, "handover", "Sam");

    const db = await import("../server/partner/db");
    const stale = await settle(
      db.withPartnerAdminTenantTransaction({ tenantId: f.tenantId, locationId: f.locationA }, (client) =>
        leases.assertMayWrite(client, principal(f, f.graderOne), job, original.lease.revision)
      )
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("NOT_LEASE_HOLDER");
  });

  it("8b: a STALE revision is refused even from the rightful holder", async () => {
    /*
     * The second, independent guard. Holding the lease is not enough — a form loaded before an
     * earlier save would silently overwrite it, which is the corruption this whole mechanism exists
     * to prevent.
     */
    const f = await makeTenant("lease8b");
    const job = await makeGradableJob(f, f.locationA, "i");
    const held = await leases.acquireLease(principal(f, f.graderOne), job);
    const db = await import("../server/partner/db");

    const next = await db.withPartnerAdminTenantTransaction(
      { tenantId: f.tenantId, locationId: f.locationA },
      (client) => leases.assertMayWrite(client, principal(f, f.graderOne), job, held.lease.revision)
    );
    expect(next).toBe(held.lease.revision + 1);

    // Re-submitting the ORIGINAL form is refused.
    const replay = await settle(
      db.withPartnerAdminTenantTransaction({ tenantId: f.tenantId, locationId: f.locationA }, (client) =>
        leases.assertMayWrite(client, principal(f, f.graderOne), job, held.lease.revision)
      )
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("STALE_REVISION");
  });

  it("7b: the takeover CARRIES the revision forward rather than restarting it", async () => {
    // Restarting at 1 would make the displaced grader's stale form look current again.
    const f = await makeTenant("lease7b");
    const job = await makeGradableJob(f, f.locationA, "j");
    const first = await leases.acquireLease(principal(f, f.graderOne), job);
    const taken = await leases.takeoverLease(principal(f, f.owner, { orgWide: true }), job, "handover");
    expect(taken.revision).toBeGreaterThan(first.lease.revision);
  });

  it("6b: a location-scoped grader cannot seize a colleague's card", async () => {
    const f = await makeTenant("lease6b");
    const job = await makeGradableJob(f, f.locationA, "k");
    await leases.acquireLease(principal(f, f.graderOne), job, "Chloe");

    const refused = await settle(leases.takeoverLease(principal(f, f.graderTwo, { orgWide: false }), job, "I want it"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");
  });

  it("6c: a takeover without a reason is refused", async () => {
    const f = await makeTenant("lease6c");
    const job = await makeGradableJob(f, f.locationA, "l");
    await leases.acquireLease(principal(f, f.graderOne), job);
    const refused = await settle(leases.takeoverLease(principal(f, f.owner, { orgWide: true }), job, "   "));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");
  });

  // ---- 9, 10, 11, 12: LEASE6 — tenant, location, role and status denial ----------------------
  it("9: Partner A cannot lease Partner B's Card Job, even with its real id", async () => {
    const a = await makeTenant("lease9a");
    const b = await makeTenant("lease9b");
    const bJob = await makeGradableJob(b, b.locationA, "m");

    const crossed = await settle(leases.acquireLease(principal(a, a.graderOne), bJob));
    expect(crossed.ok).toBe(false);
    // Same answer an absent id gets — a distinct FORBIDDEN would confirm the id is real.
    if (!crossed.ok) expect(crossed.code).toBe("CARD_JOB_NOT_FOUND");

    const live = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_grading_leases WHERE card_job_id=$1`,
      [bJob]
    );
    expect(live.rows[0].n).toBe("0");
  });

  it("10: a grader scoped to Location A cannot lease Location B's work", async () => {
    const f = await makeTenant("lease10");
    const jobAtB = await makeGradableJob(f, f.locationB, "n");

    const refused = await settle(
      leases.acquireLease(principal(f, f.graderOne, { orgWide: false, locationId: f.locationA }), jobAtB)
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("CARD_JOB_NOT_FOUND");

    // The org-wide owner of the same shop CAN, which is what makes this scoping and not a bug.
    const allowed = await leases.acquireLease(principal(f, f.owner, { orgWide: true }), jobAtB);
    expect(allowed.lease.heldByYou).toBe(true);
  });

  it("11: SCANNER_OPERATOR cannot acquire a grading lease", async () => {
    /*
     * AG-2's whole point: operating a station and grading are different authorities.
     * SCANNER_OPERATOR holds cards.scan and cards.view but never cards.assess.
     */
    const f = await makeTenant("lease11");
    const job = await makeGradableJob(f, f.locationA, "o");
    const operator = principal(f, f.graderTwo, { canGrade: false });
    expect(operator.permissions.has("partner.cards.assess")).toBe(false);

    for (const attempt of [
      () => leases.acquireLease(operator, job),
      () => leases.heartbeatLease(operator, job),
      () => leases.takeoverLease(operator, job, "no"),
    ]) {
      const refused = await settle(attempt());
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("FORBIDDEN");
    }
  });

  it("12: a card that is not open for grading cannot be leased", async () => {
    const f = await makeTenant("lease12");
    /*
     * Created directly in NEEDS_SCAN rather than transitioned into it: 0080's trigger enforces the
     * legal transition graph and READY_TO_GRADE -> NEEDS_SCAN is not in it. Fighting the real
     * constraint to build a fixture would mean testing against a database that does not exist.
     */
    const job = await makeGradableJob(f, f.locationA, "p", "NEEDS_SCAN");

    const refused = await settle(leases.acquireLease(principal(f, f.graderOne), job));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("NOT_GRADABLE");
  });

  // ---- 13: LEASE authority survives a process restart ----------------------------------------
  it("13: the lease survives a PROCESS RESTART — authority is in PostgreSQL, not memory", async () => {
    /*
     * INVARIANT I19. A lease in module memory would be lost on every rolling deploy and invisible to
     * the other Fly Machine, so two graders routed to different machines would BOTH believe they
     * held it. Re-importing the module with a cleared registry is the closest available proxy for a
     * restart, and the lease must still be there.
     */
    const f = await makeTenant("lease13");
    const job = await makeGradableJob(f, f.locationA, "q");
    await leases.acquireLease(principal(f, f.graderOne), job, "Chloe");

    const db = await import("../server/partner/db");
    await db.closePartnerPools().catch(() => {});
    // A genuinely fresh module instance — no in-process state carried over.
    const reloaded = await import(`../server/partner/grading-lease-service?restart=${Date.now()}`);

    const stillHeld = await settle(reloaded.acquireLease(principal(f, f.graderTwo), job, "James"));
    expect(stillHeld.ok).toBe(false);
    if (!stillHeld.ok) expect(stillHeld.code).toBe("LEASE_HELD_BY_ANOTHER");

    // And the row is visible to a completely independent connection.
    const row = await admin.query<{ holder_user_id: string }>(
      `SELECT holder_user_id FROM partner_grading_leases WHERE card_job_id=$1 AND released_at IS NULL`,
      [job]
    );
    expect(row.rows[0].holder_user_id).toBe(f.graderOne);
  });

  it("a refresh by the SAME grader extends rather than locking them out of their own card", async () => {
    const f = await makeTenant("leaserefresh");
    const job = await makeGradableJob(f, f.locationA, "r");
    const first = await leases.acquireLease(principal(f, f.graderOne), job);
    const again = await leases.acquireLease(principal(f, f.graderOne), job);
    expect(again.lease.heldByYou).toBe(true);
    expect(again.lease.revision).toBe(first.lease.revision);
  });
});

describe("P9 integration surfaces", () => {
  const service = readFileSync("server/partner/grading-lease-service.ts", "utf8");
  const migration = readFileSync("migrations/0087_partner_grading_edit_lease.sql", "utf8");

  it("the one-editor invariant is enforced by the DATABASE, not application logic", () => {
    // A SELECT-then-INSERT check is not enforcement: two concurrent acquires interleave.
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_grading_leases_one_active");
    expect(migration).toContain("WHERE released_at IS NULL");
    expect(service).toContain("pg_advisory_xact_lock");
  });

  it("lease state is shared, never process-local (I19)", () => {
    /*
     * The blunt version of this matched GRADABLE_STATUSES — a frozen lookup set, which is not
     * state. What matters is that no MUTABLE in-memory registry holds who owns which lease: a Map
     * would be lost on every rolling deploy and invisible to the other Fly Machine, so two graders
     * would both believe they held the card.
     */
    expect(service).not.toMatch(/new Map\(/);
    expect(service).not.toMatch(/\.set\(|\.delete\(/);
    // Every read and write goes through the shared database.
    expect(service).toContain("withPartnerAdminTenantTransaction");
    expect(service).toContain("partner_grading_leases");
  });

  it("a lease is released, never deleted — it is evidence of who edited what", () => {
    expect(service).not.toMatch(/DELETE FROM partner_grading_leases/);
    expect(migration).toContain("No DELETE");
  });

  it("takeover is permissioned, reasoned and audited", () => {
    const fn = service.slice(service.indexOf("export async function takeoverLease"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("principal.orgWide");
    expect(body).toContain("A reason is required");
    expect(body).toContain("partner_grading_lease_taken_over");
  });

  it("grading writes require BOTH the lease and the current revision", () => {
    const fn = service.slice(service.indexOf("export async function assertMayWrite"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("NOT_LEASE_HOLDER");
    expect(body).toContain("LEASE_EXPIRED");
    expect(body).toContain("STALE_REVISION");
    expect(body).toContain("FOR UPDATE");
  });

  it("all five lease routes require the grading permission — SCANNER_OPERATOR cannot reach them", () => {
    const routes = readFileSync("server/partner/grading-routes.ts", "utf8");
    for (const path of [
      '"/grading/card-jobs/:cardJobId/lease"',
      '"/grading/card-jobs/:cardJobId/lease/heartbeat"',
      '"/grading/card-jobs/:cardJobId/lease/release"',
      '"/grading/card-jobs/:cardJobId/lease/takeover"',
    ]) {
      let from = 0;
      let seen = 0;
      for (;;) {
        const idx = routes.indexOf(path, from);
        if (idx === -1) break;
        seen += 1;
        const segment = routes.slice(idx, routes.indexOf("async (req, res)", idx));
        expect(segment, `${path} is not permission-gated`).toContain(
          'requirePartnerCapability("partner.cards.assess")'
        );
        from = idx + path.length;
      }
      expect(seen, `${path} not registered`).toBeGreaterThan(0);
    }
  });

  it("takeover is a SEPARATE route, not a flag on acquire", () => {
    // A flag would let a UI take a colleague's card off them by accident.
    const routes = readFileSync("server/partner/grading-routes.ts", "utf8");
    expect(routes).toContain('"/grading/card-jobs/:cardJobId/lease/takeover"');
    const acquire = routes.slice(routes.indexOf('r.post(\n    "/grading/card-jobs/:cardJobId/lease",'));
    expect(acquire.slice(0, 600)).not.toContain("takeover");
  });

  it("the partner grading adapter is still an adapter — no second grading engine", () => {
    const routes = readFileSync("server/partner/grading-routes.ts", "utf8");
    // It reuses ../grader rather than scoring anything itself.
    expect(routes).toContain('from "../grader"');
    expect(routes).not.toMatch(/function computeGrade|function scoreCard|new MvgsEngine/);
  });

  it("MVGS scoring maths is untouched by this phase", () => {
    // P9 adds concurrency control, not grading logic. The protected maths must not appear here.
    expect(service).not.toMatch(/mvgs|centering|subgrade|pristine|blackLabel/i);
  });
});
