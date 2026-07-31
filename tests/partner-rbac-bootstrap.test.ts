/**
 * FIRST-OWNER-INVITATION BLOCKER — runtime regression proofs (real PostgreSQL 17).
 *
 * THE BUG THIS PINS: migration 0001 CREATEs partner_roles / partner_permissions /
 * partner_role_permissions but never POPULATES them, and `seedPartnerRbac()` was called from thirteen
 * TEST files and no production code path whatsoever. Every partner suite seeded RBAC in its own
 * beforeAll, so the entire suite passed green while the deployed product could not issue its FIRST
 * invitation: invitePartnerUser looks up `partner_roles WHERE code='PARTNER_OWNER'`, found zero rows,
 * and returned PARTNER_ROLE_NOT_CONFIGURED — "Partner role is not configured."
 *
 * Confirmed on staging 2026-07-31: partner_roles = 0, partner_permissions = 0, role_permissions = 0.
 *
 * These tests deliberately DO NOT call seedPartnerRbac() in beforeAll — that habit is precisely what
 * masked the defect. The unseeded state is reproduced first, then the production bootstrap is proven
 * to fix it.
 *
 * Also covers migration 0033 (audit-action precision): existing rows stay valid, each new action is
 * accepted, and an unknown action is still rejected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Client } from "pg";
import {
  provisionRealisticRoles,
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION,
} from "./helpers/partner-realistic-db";

const ADMIN_DB = process.env.PARTNER_RBAC_RT_ADMIN;

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

const captured = vi.hoisted(() => ({ invitations: [] as Array<Record<string, unknown>> }));
vi.mock("../server/partner/delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/partner/delivery")>();
  return {
    ...actual,
    invitationDeliveryConfigured: () => true,
    deliverInvitationToken: vi.fn(async (d: Record<string, unknown>) => {
      captured.invitations.push(d);
    }),
  };
});

describe("Partner RBAC bootstrap coverage is wired up", () => {
  it("is not silently skipped in CI", () => {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      expect(isLocal, "PARTNER_RBAC_RT_ADMIN must be a disposable loopback PostgreSQL 17 URL in CI").toBe(true);
    }
    if (!isLocal) console.warn("[partner-rbac-bootstrap] skipped: PARTNER_RBAC_RT_ADMIN not a loopback URL");
  });
});

let admin: Client;
let svc: typeof import("../server/partner/partner-management-service");
let perms: typeof import("../server/partner/permissions");

const ACTOR = {
  actorUserId: "aaaa1111-2222-3333-4444-555566667777",
  actorEmail: "superadmin@example.test",
  requestId: "rbac-rt",
} as const;
const actor = (extra: Record<string, unknown> = {}) => ({ ...ACTOR, ...extra }) as never;

describe.skipIf(!isLocal)("First-owner invitation blocker + migration 0033 (PostgreSQL 17)", () => {
  beforeAll(async () => {
    process.env.MINTVAULT_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN_DB;
    process.env.PARTNER_DATABASE_URL = ADMIN_DB;
    process.env.SESSION_SECRET = "synthetic-rbac-secret-not-committed";

    admin = new Client({ connectionString: ADMIN_DB });
    await admin.connect();
    const v = await admin.query<{ n: string }>("SELECT current_setting('server_version_num') AS n");
    expect(Number(v.rows[0].n), "requires PostgreSQL 17").toBeGreaterThanOrEqual(170000);

    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await provisionRealisticRoles(admin);
    await admin.query(`CREATE TABLE IF NOT EXISTS users (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(), email varchar UNIQUE, first_name varchar,
      last_name varchar, role varchar(20) NOT NULL DEFAULT 'customer', created_at timestamp NOT NULL DEFAULT now())`);
    await admin.query(
      "CREATE TABLE IF NOT EXISTS submissions (id serial PRIMARY KEY, user_id varchar, tracking_number text UNIQUE)"
    );
    await admin.query("CREATE TABLE IF NOT EXISTS submission_items (id serial PRIMARY KEY, submission_id integer)");
    await admin.query("ALTER TABLE users OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submissions OWNER TO pn_migrator");
    await admin.query("ALTER TABLE submission_items OWNER TO pn_migrator");
    await applyMigrationsRealistic(admin, ADMIN_DB!, PARTNER_MIGRATIONS_WITH_AUDIT_PRECISION);

    // DELIBERATELY NOT calling seedPartnerRbac() here — that is the habit that hid the bug.
    svc = await import("../server/partner/partner-management-service");
    perms = await import("../server/partner/permissions");
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
  });

  beforeEach(async () => {
    captured.invitations.length = 0;
    await admin.query(`TRUNCATE partner_management_audit, partner_audit_events, partner_invitations,
      partner_user_roles, partner_users, partner_locations, partner_profiles, partner_organisations CASCADE`);
  });

  async function newPartner(name: string) {
    const r = await svc.createPartner(actor({ requestId: `c-${name}` }), { legalName: name }, "rbac proof");
    return (r.result as { partnerId: string }).partnerId;
  }
  const clearRbac = () =>
    admin.query("TRUNCATE partner_role_permissions, partner_user_roles, partner_roles, partner_permissions CASCADE");

  // ---- THE BLOCKER ---------------------------------------------------------------------------
  it("REPRODUCES the staging blocker: with RBAC unseeded, the first OWNER invitation fails", async () => {
    await clearRbac();
    expect((await admin.query("SELECT count(*)::int n FROM partner_roles")).rows[0].n).toBe(0);

    const id = await newPartner("Blocker Repro Ltd");
    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "blocked" }),
        id,
        { firstName: "Oliver", lastName: "Test Partner", email: "mintvaultuk@example.test", role: "OWNER" },
        "first owner"
      )
    ).rejects.toMatchObject({ code: "PARTNER_ROLE_NOT_CONFIGURED" });
  });

  it("FIXES it: the production bootstrap seeds RBAC and the first OWNER invitation then succeeds", async () => {
    await clearRbac();
    const id = await newPartner("MintVault Pilot Partner One Ltd");

    // The exact production call site added to server/index.ts. It is fire-and-forget, so await the
    // underlying idempotent seed to make the assertion deterministic.
    await perms.seedPartnerRbac();

    const roles = await admin.query<{ code: string }>("SELECT code FROM partner_roles ORDER BY code");
    expect(roles.rows.map((r) => r.code)).toContain("PARTNER_OWNER");

    const res = await svc.invitePartnerUser(
      actor({ requestId: "first-owner" }),
      id,
      { firstName: "Oliver", lastName: "Test Partner", email: "mintvaultuk@example.test", role: "OWNER" },
      "first owner invitation"
    );
    const userId = (res.result as { userId: string }).userId;
    expect(userId).toBeTruthy();

    // no pre-existing user or invitation was required — this partner had neither a moment ago
    const users = await admin.query("SELECT id, status FROM partner_users WHERE tenant_id=$1", [id]);
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].status).toBe("INVITED");

    // the correct partner role was resolved and assigned
    const assigned = await admin.query<{ code: string }>(
      `SELECT r.code FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id WHERE ur.user_id=$1`,
      [userId]
    );
    expect(assigned.rows.map((r) => r.code)).toEqual(["PARTNER_OWNER"]);
  });

  it("bootstrap is idempotent — running it repeatedly never duplicates a role", async () => {
    await clearRbac();
    await perms.seedPartnerRbac();
    const first = (await admin.query("SELECT count(*)::int n FROM partner_roles")).rows[0].n;
    await perms.seedPartnerRbac();
    await perms.seedPartnerRbac();
    const after = (await admin.query("SELECT count(*)::int n FROM partner_roles")).rows[0].n;
    expect(after).toBe(first);
    expect((await admin.query("SELECT count(*)::int n FROM partner_roles WHERE code='PARTNER_OWNER'")).rows[0].n).toBe(
      1
    );
  });

  it("the invitation token is stored ONLY as a hash, and delivery feedback is honest", async () => {
    await perms.seedPartnerRbac();
    const id = await newPartner("Hash Proof Ltd");
    const res = await svc.invitePartnerUser(
      actor({ requestId: "hash" }),
      id,
      { firstName: "A", lastName: "B", email: "hash@example.test", role: "OWNER" },
      "invite"
    );
    const token = captured.invitations[0].token as string;
    const { createHash } = await import("node:crypto");
    const rows = await admin.query<{ token_hash: string }>("SELECT token_hash FROM partner_invitations");
    expect(rows.rows[0].token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows.rows)).not.toContain(token);
    // the raw token is never returned to the caller
    expect(JSON.stringify(res.result)).not.toContain(token);
    expect((res.result as { deliveryStatus: string }).deliveryStatus).toBe("SENT");
  });

  it("duplicate LIVE invitations remain blocked after the fix", async () => {
    await perms.seedPartnerRbac();
    const id = await newPartner("Dup Guard Ltd");
    await svc.invitePartnerUser(
      actor({ requestId: "d1" }),
      id,
      { firstName: "A", lastName: "B", email: "dup@example.test", role: "OWNER" },
      "first"
    );
    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "d2" }),
        id,
        { firstName: "C", lastName: "D", email: "dup@example.test", role: "STAFF" },
        "second"
      )
    ).rejects.toMatchObject({ code: "DUPLICATE_PARTNER_USER" });

    const live = await admin.query(
      "SELECT id FROM partner_invitations WHERE status IN ('PENDING','SENT','DELIVERY_FAILED')"
    );
    expect(live.rows).toHaveLength(1);
  });

  // ---- MIGRATION 0033 ------------------------------------------------------------------------
  describe("migration 0033 — audit-action precision", () => {
    it("preserves all 18 pre-existing values and adds exactly the four approved ones", async () => {
      const { rows } = await admin.query<{ d: string }>(
        "SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='chk_partner_management_audit_action'"
      );
      const permitted = (rows[0].d.match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
      const original = [
        "partner_created",
        "profile_updated",
        "status_changed",
        "contact_added",
        "contact_updated",
        "contact_deactivated",
        "branding_updated",
        "note_added",
        "partner_user_invited",
        "partner_invitation_resent",
        "partner_invitation_revoked",
        "partner_invitation_accepted",
        "partner_user_role_changed",
        "partner_user_suspended",
        "partner_user_reactivated",
        "partner_user_password_reset_initiated",
        "partner_user_sessions_revoked",
        "partner_user_membership_removed",
      ];
      for (const a of original) expect(permitted).toContain(a);
      const added = permitted.filter((p) => !original.includes(p)).sort();
      expect(added).toEqual([
        "partner_duplicate_override",
        "partner_invitation_amended",
        "partner_legal_name_changed",
        "partner_user_mfa_reset",
      ]);
      expect(permitted).toHaveLength(22);
    });

    it("accepts each new action and still REJECTS an unknown one", async () => {
      const id = await newPartner("Constraint Ltd");
      for (const a of [
        "partner_user_mfa_reset",
        "partner_invitation_amended",
        "partner_legal_name_changed",
        "partner_duplicate_override",
      ]) {
        await expect(
          admin.query(
            `INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result)
             VALUES ($1,$2,$3,$4,'t','succeeded')`,
            [id, a, ACTOR.actorUserId, ACTOR.actorEmail]
          )
        ).resolves.toBeTruthy();
      }
      await expect(
        admin.query(
          `INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result)
           VALUES ($1,'totally_made_up_action',$2,$3,'t','succeeded')`,
          [id, ACTOR.actorUserId, ACTOR.actorEmail]
        )
      ).rejects.toThrow(/chk_partner_management_audit_action|violates check constraint/);
    });

    it("pre-existing rows written under the OLD constraint remain valid", async () => {
      const id = await newPartner("Legacy Rows Ltd");
      await admin.query(
        `INSERT INTO partner_management_audit (tenant_id, action_type, actor_user_id, actor_email, request_id, result)
         VALUES ($1,'partner_created',$2,$3,'legacy','succeeded')`,
        [id, ACTOR.actorUserId, ACTOR.actorEmail]
      );
      // Re-validating the constraint must not reject anything already stored.
      await expect(
        admin.query("ALTER TABLE partner_management_audit VALIDATE CONSTRAINT chk_partner_management_audit_action")
      ).resolves.toBeTruthy();
    });

    it("a rename is now recorded under its OWN action, not borrowed from profile_updated", async () => {
      await perms.seedPartnerRbac();
      const id = await newPartner("Rename Action Ltd");
      const v = await admin.query<{ version: number }>("SELECT version FROM partner_profiles WHERE tenant_id=$1", [id]);
      await svc.updatePartnerLegalName(actor({ requestId: "ren" }), id, "Renamed Ltd", v.rows[0].version, "why");
      const rows = await admin.query<{ action_type: string }>(
        "SELECT action_type FROM partner_management_audit WHERE request_id='ren' AND result='succeeded'"
      );
      expect(rows.rows[0].action_type).toBe("partner_legal_name_changed");
    });
  });
});
