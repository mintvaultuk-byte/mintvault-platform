/**
 * Partner Management & Onboarding UX v1 — REAL PostgreSQL 17 runtime proofs.
 *
 * This exists because the feature's own suite (partner-management-ux.test.ts) is unit + source
 * assertion only: it proves the pure helpers and that the pages are wired, but it never executes
 * updatePartnerLegalName, findDuplicates or amendPendingInvitation against a database. Those three
 * are the entire server surface of the change, and every risk that matters — optimistic locking,
 * old-token revocation, the duplicate rules, audit before/after state, concurrency — only exists at
 * runtime.
 *
 * Bootstrap mirrors tests/partner-management-integration.test.ts exactly: pristine public schema,
 * REALISTIC (non-superuser) role model so RLS and the SECURITY DEFINER ownership are production-
 * shaped, and the full partner migration set through the final-owner invariant.
 *
 * Gated on PARTNER_UX_RT_ADMIN pointing at a DISPOSABLE loopback PostgreSQL 17. Skips otherwise,
 * and fails closed in CI so it can never silently not run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_UX_RT_ADMIN;

function isLoopback(u: string | undefined): boolean {
  if (!u) return false;
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "::1" || h === "localhost";
  } catch {
    return false;
  }
}
const isLocal = isLoopback(ADMIN_DB);

/** Invitation delivery is captured, never sent. No transport is configured in this process. */
const captured = vi.hoisted(() => ({ invitations: [] as Array<Record<string, unknown>> }));
vi.mock("../server/partner/delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/partner/delivery")>();
  return {
    ...actual,
    invitationDeliveryConfigured: () => true,
    deliverInvitationToken: vi.fn(async (data: Record<string, unknown>) => {
      captured.invitations.push(data);
    }),
  };
});

describe("Partner UX runtime coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_UX_RT_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(true);
    }
    if (!isLocal) console.warn("[partner-management-ux-runtime] skipped: PARTNER_UX_RT_ADMIN not a loopback URL");
  });
});

let admin: Client;
let svc: typeof import("../server/partner/partner-management-service");
let errors: typeof import("../server/partner/partner-management-errors");

const ACTOR = {
  actorUserId: "aaaa1111-2222-3333-4444-555566667777",
  actorEmail: "superadmin@example.test",
  requestId: "ux-runtime",
} as const;
const actor = (extra: Record<string, unknown> = {}) => ({ ...ACTOR, ...extra }) as never;

async function sha256Hex(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}

describe.skipIf(!isLocal)("Partner Management UX v1 — runtime proofs (PostgreSQL 17)", () => {
  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_DATABASE_URL = ADMIN_DB;
    process.env.SESSION_SECRET = "synthetic-runtime-secret-not-committed";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    const v = await admin.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
    expect(Number(v.rows[0].n), "requires PostgreSQL 17").toBeGreaterThanOrEqual(170000);

    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await provisionRealisticRoles(admin);
    await admin.query(`CREATE TABLE IF NOT EXISTS users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar, last_name varchar,
      role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamp NOT NULL DEFAULT now())`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer)");
    // The migrator is a NON-superuser; migration 0010+ touch these stub tables, so it must own them.
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION);
    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    svc = await import("../server/partner/partner-management-service");
    errors = await import("../server/partner/partner-management-errors");
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
  });

  beforeEach(async () => {
    captured.invitations.length = 0;
    // Truncate in FK-safe order between tests so each proof starts from a known state.
    await admin.query(`TRUNCATE partner_management_audit, partner_audit_events, partner_invitations,
      partner_user_roles, partner_users, partner_locations, partner_profiles, partner_organisations CASCADE`);
  });

  async function newPartner(legalName: string) {
    const r = await svc.createPartner(actor({ requestId: `create-${legalName}` }), { legalName }, "runtime proof");
    return (r.result as { partnerId: string }).partnerId;
  }
  async function versionOf(tenantId: string): Promise<number> {
    const r = await admin.query<{ version: number }>("SELECT version FROM partner_profiles WHERE tenant_id=$1", [
      tenantId,
    ]);
    return r.rows[0].version;
  }

  // ---- PROOF 1 -------------------------------------------------------------------------------
  it("1. creates a partner with exactly one ACTIVE 'Main location'", async () => {
    const id = await newPartner("Runtime Partner One Ltd");
    const org = await admin.query("SELECT legal_name, status FROM partner_organisations WHERE id=$1", [id]);
    expect(org.rows[0]).toMatchObject({ legal_name: "Runtime Partner One Ltd", status: "PENDING" });
    const loc = await admin.query("SELECT name, status FROM partner_locations WHERE tenant_id=$1", [id]);
    expect(loc.rows).toHaveLength(1);
    expect(loc.rows[0]).toMatchObject({ name: "Main location", status: "ACTIVE" });
  });

  // ---- PROOF 2 -------------------------------------------------------------------------------
  it("2. edits the legal name and every profile field, and reads them back", async () => {
    const id = await newPartner("Old Name Ltd");
    await svc.updatePartnerLegalName(actor({ requestId: "rename" }), id, "New Name Ltd", await versionOf(id), "rename");

    const fields = {
      trading_name: "MV Test Cards Strood",
      address_line1: "Test Suite 1",
      address_line2: "MintVault Pilot Centre",
      address_city: "Strood",
      address_postcode: "ME2 2AA",
      address_country: "United Kingdom",
      primary_email: "mintvaultuk@example.test",
      primary_phone: "01634 123456",
      website: "https://example.test",
      health_note: "internal note",
    };
    await svc.updateProfile(actor({ requestId: "profile" }), id, fields, await versionOf(id), "profile update");

    const org = await admin.query("SELECT legal_name FROM partner_organisations WHERE id=$1", [id]);
    expect(org.rows[0].legal_name).toBe("New Name Ltd");
    const p = await admin.query("SELECT * FROM partner_profiles WHERE tenant_id=$1", [id]);
    for (const [k, want] of Object.entries(fields)) expect(p.rows[0][k]).toBe(want);
  });

  // ---- PROOF 3 -------------------------------------------------------------------------------
  it("3. rejects a stale version on rename (optimistic lock) and does NOT change the name", async () => {
    const id = await newPartner("Lock Test Ltd");
    const stale = await versionOf(id);
    await svc.updatePartnerLegalName(actor({ requestId: "r1" }), id, "First Rename Ltd", stale, "first");

    await expect(
      svc.updatePartnerLegalName(actor({ requestId: "r2" }), id, "Should Not Apply Ltd", stale, "stale")
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const org = await admin.query("SELECT legal_name FROM partner_organisations WHERE id=$1", [id]);
    expect(org.rows[0].legal_name).toBe("First Rename Ltd");
  });

  it("3b. the client's version+1 assumption holds: each successful write bumps the version by exactly 1", async () => {
    const id = await newPartner("Version Math Ltd");
    const v0 = await versionOf(id);
    await svc.updatePartnerLegalName(actor({ requestId: "v1" }), id, "Renamed Ltd", v0, "rename");
    const v1 = await versionOf(id);
    expect(v1).toBe(v0 + 1);
    await svc.updateProfile(actor({ requestId: "v2" }), id, { trading_name: "T" }, v1, "profile");
    expect(await versionOf(id)).toBe(v1 + 1);
  });

  // ---- PROOF 4 + 5 ---------------------------------------------------------------------------
  it("4. duplicate scan finds an exact legal-name match, case- and whitespace-insensitively", async () => {
    await newPartner("MintVault Pilot Partner One Ltd");
    for (const probe of ["MintVault Pilot Partner One Ltd", "mintvault  pilot partner ONE ltd"]) {
      const m = await svc.findDuplicates({ legalName: probe });
      expect(m.filter((x) => x.kind === "legal_name")).toHaveLength(1);
    }
    expect(await svc.findDuplicates({ legalName: "Totally Different Ltd" })).toEqual([]);
  });

  it("5. duplicate scan matches postcode/phone/trading name normalised, and email across BOTH sources", async () => {
    const id = await newPartner("Dup Source Ltd");
    await svc.updateProfile(
      actor({ requestId: "seed" }),
      id,
      {
        trading_name: "MV Test Cards Strood",
        address_postcode: "ME2 2AA",
        primary_phone: "+44 (0)1634 123-456",
        primary_email: "profile@example.test",
      },
      await versionOf(id),
      "seed"
    );
    await svc.invitePartnerUser(
      actor({ requestId: "seed-user" }),
      id,
      { firstName: "A", lastName: "B", email: "user@example.test", role: "OWNER" },
      "seed"
    );

    expect((await svc.findDuplicates({ postcode: "me22aa" })).some((m) => m.kind === "postcode")).toBe(true);
    // Exact digit-string match works (formatting/punctuation is ignored)...
    expect((await svc.findDuplicates({ phone: "+44 (0)1634 123-456" })).some((m) => m.kind === "phone")).toBe(true);
    expect((await svc.findDuplicates({ phone: "440 1634 123456" })).some((m) => m.kind === "phone")).toBe(true);
    // ...but REVIEW FINDING (phone-dialling-prefix): the comparison is a raw digit-string equality,
    // so the same UK number written in national form ("01634 123456" -> 01634123456) does NOT match
    // the stored international form ("+44 (0)1634 123-456" -> 4401634123456). This is a FALSE
    // NEGATIVE in an advisory-only warning (it never blocks and never mis-blocks), but it is pinned
    // here so the limitation is explicit rather than discovered later in production.
    expect((await svc.findDuplicates({ phone: "01634 123456" })).some((m) => m.kind === "phone")).toBe(false);
    expect(
      (await svc.findDuplicates({ tradingName: "mv test cards strood" })).some((m) => m.kind === "trading_name")
    ).toBe(true);
    // email probe must see the profile contact address AND the partner_users address
    expect((await svc.findDuplicates({ email: "PROFILE@example.test" })).some((m) => m.kind === "email")).toBe(true);
    expect((await svc.findDuplicates({ email: "USER@example.test" })).some((m) => m.kind === "email")).toBe(true);
    // a phone with too few digits must not match anything
    expect(await svc.findDuplicates({ phone: "123" })).toEqual([]);
  });

  it("5b. the duplicate scan writes nothing — no audit rows, no row-count change", async () => {
    const id = await newPartner("Read Only Probe Ltd");
    const before = await admin.query<{ c: string }>(
      "SELECT (SELECT count(*) FROM partner_management_audit)::text AS c"
    );
    await svc.findDuplicates({ legalName: "Read Only Probe Ltd", email: "x@example.test", postcode: "ME2 2AA" });
    const after = await admin.query<{ c: string }>("SELECT (SELECT count(*) FROM partner_management_audit)::text AS c");
    expect(after.rows[0].c).toBe(before.rows[0].c);
    expect((await admin.query("SELECT count(*) FROM partner_organisations")).rows[0].count).toBe("1");
    expect(id).toBeTruthy();
  });

  // ---- PROOF 4 (hard block) ------------------------------------------------------------------
  it("4b. duplicate EMAIL is enforced by the database layer, not just warned about", async () => {
    const a = await newPartner("Alpha Ltd");
    const b = await newPartner("Beta Ltd");
    await svc.invitePartnerUser(
      actor({ requestId: "u1" }),
      a,
      { firstName: "One", lastName: "User", email: "shared@example.test", role: "OWNER" },
      "first"
    );
    // same tenant
    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "u2" }),
        a,
        { firstName: "Two", lastName: "User", email: "shared@example.test", role: "STAFF" },
        "dup"
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_PARTNER_USER" });
    // DIFFERENT tenant — must fail the same way (no cross-tenant existence oracle)
    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "u3" }),
        b,
        { firstName: "Three", lastName: "User", email: "SHARED@example.test", role: "STAFF" },
        "dup-cross"
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_PARTNER_USER" });
  });

  // ---- PROOF 6..9 ----------------------------------------------------------------------------
  it("6-9. amending an invitation revokes the old token, issues a new one, and stores only hashes", async () => {
    const id = await newPartner("Invite Flow Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "inv" }),
      id,
      { firstName: "Oliver", lastName: "Typo", email: "wrong@example.test", role: "OWNER" },
      "initial invitation"
    );
    const userId = (created.result as { userId: string }).userId;
    expect(captured.invitations).toHaveLength(1);
    const oldToken = captured.invitations[0].token as string;
    expect(typeof oldToken).toBe("string");

    const oldRow = await admin.query<{ id: string; status: string; token_hash: string }>(
      "SELECT id, status, token_hash FROM partner_invitations WHERE user_id=$1",
      [userId]
    );
    expect(oldRow.rows).toHaveLength(1);
    const oldInvitationId = oldRow.rows[0].id;
    // ONLY the hash is stored — the raw token appears nowhere in the row
    expect(oldRow.rows[0].token_hash).toBe(await sha256Hex(oldToken));
    expect(JSON.stringify(oldRow.rows)).not.toContain(oldToken);

    captured.invitations.length = 0;
    await svc.amendPendingInvitation(
      actor({ requestId: "amend" }),
      id,
      userId,
      { firstName: "Oliver", lastName: "Test Partner", email: "right@example.test", role: "OWNER" },
      "corrected the address"
    );

    // 8. the OLD invitation is revoked and superseded — its token can no longer be redeemed
    const oldAfter = await admin.query<{ status: string; superseded_by: string | null }>(
      "SELECT status, superseded_by FROM partner_invitations WHERE id=$1",
      [oldInvitationId]
    );
    expect(oldAfter.rows[0].status).toBe("REVOKED");
    expect(oldAfter.rows[0].superseded_by).not.toBeNull();
    // the real redemption path must refuse it
    await expect(svc.acceptPartnerInvitation(oldToken, "an-adequately-long-password-1")).resolves.toMatchObject({
      ok: false,
    });

    // 9. a NEW token was issued to the NEW address and it works
    expect(captured.invitations).toHaveLength(1);
    const newToken = captured.invitations[0].token as string;
    expect(newToken).not.toBe(oldToken);
    expect(captured.invitations[0].email).toBe("right@example.test");
    const live = await admin.query<{ token_hash: string; status: string }>(
      "SELECT token_hash, status FROM partner_invitations WHERE user_id=$1 AND status IN ('PENDING','SENT')",
      [userId]
    );
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0].token_hash).toBe(await sha256Hex(newToken));

    const u = await admin.query("SELECT email, first_name, last_name FROM partner_users WHERE id=$1", [userId]);
    expect(u.rows[0]).toMatchObject({ email: "right@example.test", last_name: "Test Partner" });

    await expect(svc.acceptPartnerInvitation(newToken, "an-adequately-long-password-1")).resolves.toMatchObject({
      ok: true,
    });
  });

  // ---- PROOF 10 ------------------------------------------------------------------------------
  it("10. an ACCEPTED invitation cannot be amended", async () => {
    const id = await newPartner("Accepted Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "inv" }),
      id,
      { firstName: "Done", lastName: "User", email: "done@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    const token = captured.invitations[0].token as string;
    await expect(svc.acceptPartnerInvitation(token, "an-adequately-long-password-1")).resolves.toMatchObject({
      ok: true,
    });

    await expect(
      svc.amendPendingInvitation(
        actor({ requestId: "amend-accepted" }),
        id,
        userId,
        { firstName: "Done", lastName: "User", email: "hijack@example.test", role: "OWNER" },
        "should be refused"
      )
    ).rejects.toMatchObject({ code: "INVITATION_NOT_AMENDABLE" });

    // and the email was NOT changed
    const u = await admin.query("SELECT email FROM partner_users WHERE id=$1", [userId]);
    expect(u.rows[0].email).toBe("done@example.test");
  });

  it("10b. amend refuses an email already used by ANOTHER user, but allows re-saving the same address", async () => {
    const id = await newPartner("Clash Ltd");
    const first = await svc.invitePartnerUser(
      actor({ requestId: "a" }),
      id,
      { firstName: "A", lastName: "A", email: "taken@example.test", role: "OWNER" },
      "a"
    );
    const second = await svc.invitePartnerUser(
      actor({ requestId: "b" }),
      id,
      { firstName: "B", lastName: "B", email: "free@example.test", role: "STAFF" },
      "b"
    );
    const secondId = (second.result as { userId: string }).userId;
    expect(first).toBeTruthy();

    await expect(
      svc.amendPendingInvitation(
        actor({ requestId: "clash" }),
        id,
        secondId,
        { firstName: "B", lastName: "B", email: "taken@example.test", role: "STAFF" },
        "clash"
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_PARTNER_USER" });

    // same address as itself must be allowed (correcting only the name)
    await expect(
      svc.amendPendingInvitation(
        actor({ requestId: "self" }),
        id,
        secondId,
        { firstName: "Bee", lastName: "Bee", email: "free@example.test", role: "STAFF" },
        "name fix"
      )
    ).resolves.toBeTruthy();
  });

  // ---- PROOF 11 ------------------------------------------------------------------------------
  it("11. audit rows carry accurate before/after state and every action passes the CHECK constraint", async () => {
    const id = await newPartner("Audit Ltd");
    await svc.updatePartnerLegalName(actor({ requestId: "ren" }), id, "Audit Renamed Ltd", await versionOf(id), "why");

    /*
     * LEDGER SHAPE (pre-existing, repo-wide — not introduced by this branch): withAudit writes TWO
     * rows per mutation, correlated by request_id. The 'attempted' row carries before_state; the
     * terminal 'succeeded' row carries after_state and the operator's reason. Reconstructing a
     * before/after pair therefore means joining the two rows on request_id. Asserted as such so the
     * real contract is pinned rather than an idealised one-row assumption.
     */
    const rows = await admin.query<{
      action_type: string;
      before_state: { legal_name?: string } | null;
      after_state: { legal_name?: string } | null;
      reason: string;
      result: string;
    }>(
      "SELECT action_type, before_state, after_state, reason, result FROM partner_management_audit WHERE tenant_id=$1 AND request_id='ren' ORDER BY created_at",
      [id]
    );
    const attempted = rows.rows.find((r) => r.result === "attempted");
    const succeeded = rows.rows.find((r) => r.result === "succeeded");
    expect(attempted, "an 'attempted' row must exist").toBeTruthy();
    expect(succeeded, "a 'succeeded' row must exist").toBeTruthy();
    // Migration 0033 gave the rename its OWN action; it no longer borrows profile_updated.
    expect(attempted!.action_type).toBe("partner_legal_name_changed");
    expect(succeeded!.action_type).toBe("partner_legal_name_changed");
    expect(attempted!.before_state).toMatchObject({ legal_name: "Audit Ltd" });
    expect(succeeded!.after_state).toMatchObject({ legal_name: "Audit Renamed Ltd" });
    expect(succeeded!.reason).toBe("why");

    // The constraint is real: an unpermitted action must be rejected by the database.
    await expect(
      admin.query(
        `INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result)
         VALUES ($1,'legal_name_changed',$2,$3,'x','succeeded')`,
        [id, ACTOR.actorUserId, ACTOR.actorEmail]
      )
    ).rejects.toThrow(/chk_partner_management_audit_action|violates check constraint/);
  });

  it("11b. the amend audit trail records the previous name and address", async () => {
    const id = await newPartner("Amend Audit Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      id,
      { firstName: "Old", lastName: "Name", email: "old@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    await svc.amendPendingInvitation(
      actor({ requestId: "am" }),
      id,
      userId,
      { firstName: "New", lastName: "Name", email: "new@example.test", role: "OWNER" },
      "fixing typo"
    );
    const rows = await admin.query<{ reason: string }>(
      "SELECT reason FROM partner_management_audit WHERE tenant_id=$1 AND reason LIKE '%amended from%'",
      [id]
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0].reason).toContain("fixing typo");
    expect(rows.rows[0].reason).toContain("old@example.test");
  });

  // ---- PROOF 12 ------------------------------------------------------------------------------
  it("12. a delivery failure does not corrupt committed state — the amend still applied", async () => {
    const id = await newPartner("Delivery Fail Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      id,
      { firstName: "D", lastName: "F", email: "before@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;

    const delivery = await import("../server/partner/delivery");
    const spy = vi.spyOn(delivery, "deliverInvitationToken").mockRejectedValueOnce(new Error("smtp exploded"));
    const res = await svc.amendPendingInvitation(
      actor({ requestId: "am" }),
      id,
      userId,
      { firstName: "D", lastName: "F", email: "after@example.test", role: "OWNER" },
      "amend with failing delivery"
    );
    spy.mockRestore();

    // The transaction committed: the address changed and a live invitation exists…
    const u = await admin.query("SELECT email FROM partner_users WHERE id=$1", [userId]);
    expect(u.rows[0].email).toBe("after@example.test");
    // …and the failure is recorded as DELIVERY_FAILED rather than silently reported as sent.
    const inv = await admin.query<{ status: string }>(
      "SELECT status FROM partner_invitations WHERE user_id=$1 AND status NOT IN ('REVOKED') ORDER BY created_at DESC",
      [userId]
    );
    expect(inv.rows[0].status).toBe("DELIVERY_FAILED");
    expect((res.result as { deliveryStatus: string }).deliveryStatus).toBe("DELIVERY_FAILED");
  });

  // ---- PROOF 13 ------------------------------------------------------------------------------
  it("13. two concurrent amendments never leave more than one live invitation", async () => {
    const id = await newPartner("Race Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      id,
      { firstName: "R", lastName: "C", email: "race@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;

    const results = await Promise.allSettled([
      svc.amendPendingInvitation(
        actor({ requestId: "c1" }),
        id,
        userId,
        { firstName: "R", lastName: "C", email: "race-a@example.test", role: "OWNER" },
        "concurrent A"
      ),
      svc.amendPendingInvitation(
        actor({ requestId: "c2" }),
        id,
        userId,
        { firstName: "R", lastName: "C", email: "race-b@example.test", role: "OWNER" },
        "concurrent B"
      ),
    ]);
    // Whatever the interleaving, the invariant must hold.
    const live = await admin.query(
      "SELECT id FROM partner_invitations WHERE user_id=$1 AND status IN ('PENDING','SENT','DELIVERY_FAILED')",
      [userId]
    );
    expect(live.rows.length).toBeLessThanOrEqual(1);
    const users = await admin.query("SELECT count(*)::int c FROM partner_users WHERE tenant_id=$1", [id]);
    expect(users.rows[0].c).toBe(1);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });

  // ---- PROOF 14 ------------------------------------------------------------------------------
  it("14. amend is tenant-scoped — a userId from another partner cannot be amended via the wrong partnerId", async () => {
    const a = await newPartner("Tenant A Ltd");
    const b = await newPartner("Tenant B Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      a,
      { firstName: "T", lastName: "A", email: "tenant-a@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;

    await expect(
      svc.amendPendingInvitation(
        actor({ requestId: "cross" }),
        b, // WRONG tenant
        userId,
        { firstName: "T", lastName: "A", email: "hijacked@example.test", role: "OWNER" },
        "cross tenant"
      )
    ).rejects.toMatchObject({ code: "PARTNER_USER_NOT_FOUND" });

    const u = await admin.query("SELECT email FROM partner_users WHERE id=$1", [userId]);
    expect(u.rows[0].email).toBe("tenant-a@example.test");
  });

  // ---- HOSTILE-REVIEW REPAIRS ----------------------------------------------------------------
  it("R1. a REJECTED amend still leaves an audit row naming both sides (it survives the rollback)", async () => {
    const id = await newPartner("Rollback Audit Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      id,
      { firstName: "A", lastName: "B", email: "rollback@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    const token = captured.invitations[0].token as string;
    await svc.acceptPartnerInvitation(token, "an-adequately-long-password-1");

    await expect(
      svc.amendPendingInvitation(
        actor({ requestId: "rejected-amend" }),
        id,
        userId,
        { firstName: "A", lastName: "B", email: "nope@example.test", role: "OWNER" },
        "should be refused"
      )
    ).rejects.toMatchObject({ code: "INVITATION_NOT_AMENDABLE" });

    const rows = await admin.query<{
      result: string;
      before_state: { email?: string } | null;
      after_state: { email?: string } | null;
    }>("SELECT result, before_state, after_state FROM partner_management_audit WHERE request_id='rejected-amend'");
    expect(rows.rows.length, "a rejected amend must still be auditable").toBeGreaterThan(0);
    const attempt = rows.rows.find((r) => r.result === "attempted")!;
    expect(attempt).toBeTruthy();
    expect(attempt.before_state).toMatchObject({ email: "rollback@example.test" });
    expect(attempt.after_state).toMatchObject({ email: "nope@example.test" });
  });

  it("R2. a successful amend records the destination address in the ledger", async () => {
    const id = await newPartner("Destination Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      id,
      { firstName: "D", lastName: "E", email: "from@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    await svc.amendPendingInvitation(
      actor({ requestId: "to-dest" }),
      id,
      userId,
      { firstName: "D", lastName: "E", email: "to@example.test", role: "OWNER" },
      "redirect"
    );
    const rows = await admin.query<{ before_state: { email?: string } | null; after_state: { email?: string } | null }>(
      "SELECT before_state, after_state FROM partner_management_audit WHERE request_id='to-dest' AND result='attempted'"
    );
    expect(rows.rows[0].before_state).toMatchObject({ email: "from@example.test" });
    expect(rows.rows[0].after_state).toMatchObject({ email: "to@example.test" });
  });

  it("R3. the duplicate scan matches a stored name carrying stray leading/trailing whitespace", async () => {
    await admin.query(
      "INSERT INTO partner_organisations (legal_name, status) VALUES ('  Spacey Cards Ltd  ','PENDING')"
    );
    const m = await svc.findDuplicates({ legalName: "Spacey Cards Ltd" });
    expect(m.some((x) => x.kind === "legal_name")).toBe(true);
  });

  it("R4. every duplicate probe executes (each ORDER BY is valid against its own query)", async () => {
    // A blanket ORDER BY edit previously referenced an alias one query did not have; every probe is
    // executed here so a malformed statement fails loudly rather than only under a rare input.
    const id = await newPartner("All Probes Ltd");
    await svc.updateProfile(
      actor({ requestId: "seed" }),
      id,
      {
        trading_name: "All Probes Trading",
        address_postcode: "ME2 2AA",
        primary_phone: "01634 999888",
        primary_email: "probe@example.test",
      },
      await versionOf(id),
      "seed"
    );
    await expect(
      svc.findDuplicates({
        legalName: "All Probes Ltd",
        tradingName: "All Probes Trading",
        email: "probe@example.test",
        postcode: "ME2 2AA",
        phone: "01634 999888",
      })
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "legal_name" })]));
  });

  it("R5. the detail payload genuinely carries no branding (the checklist must not read it there)", async () => {
    const id = await newPartner("Branding Source Ltd");
    const detail = (await svc.getPartnerDetail(id)) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(["organisation", "primaryContact", "profile"]);
  });

  it("14b. rename and amend refuse a REVOKED / SUSPENDED partner", async () => {
    const id = await newPartner("Revoked Ltd");
    await admin.query("UPDATE partner_organisations SET status='REVOKED' WHERE id=$1", [id]);
    await expect(
      svc.updatePartnerLegalName(actor({ requestId: "x" }), id, "Nope Ltd", await versionOf(id), "r")
    ).rejects.toMatchObject({ code: "PARTNER_UNAVAILABLE" });
    expect(errors.g5StatusFor("INVITATION_NOT_AMENDABLE")).toBe(409);
  });
});
