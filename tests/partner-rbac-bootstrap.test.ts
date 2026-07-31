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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("the PRODUCTION entrypoint (bootstrapPartnerRbac) seeds — not just the test-only helper", async () => {
    /*
     * MUTATION GAP CLOSED: the other tests called seedPartnerRbac() directly, so deleting the
     * production call site left the suite green — the very shape of the original defect, where a
     * test-only seed masked missing startup wiring. This drives the REAL production entrypoint.
     */
    await clearRbac();
    expect((await admin.query("SELECT count(*)::int n FROM partner_roles")).rows[0].n).toBe(0);

    perms.bootstrapPartnerRbac(); // fire-and-forget, exactly as server/index.ts calls it
    // poll rather than sleep — the bootstrap is intentionally not awaited in production
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      const r = await admin.query<{ n: number }>(
        "SELECT count(*)::int n FROM partner_roles WHERE code='PARTNER_OWNER'"
      );
      ok = r.rows[0].n === 1;
      if (!ok) await new Promise((res) => setTimeout(res, 50));
    }
    expect(ok, "bootstrapPartnerRbac must seed PARTNER_ROLE_CODES without any test helper").toBe(true);

    const id = await newPartner("Prod Entrypoint Ltd");
    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "prod-entry" }),
        id,
        { firstName: "P", lastName: "E", email: "prod@example.test", role: "OWNER" },
        "first owner via production bootstrap"
      )
    ).resolves.toBeTruthy();
  });

  it("server/index.ts actually CALLS the bootstrap on the startup path", () => {
    // Source assertion, because deleting the call site is otherwise invisible to a DB test that
    // invokes the function directly. Pins both the import and the call.
    const src = readFileSync(join(__dirname, "..", "server", "index.ts"), "utf8");
    expect(src).toMatch(/import \{ bootstrapPartnerRbac \} from "\.\/partner\/permissions"/);
    expect(src).toMatch(/^\s*bootstrapPartnerRbac\(\);\s*$/m);
    // and it must sit on the listen path, next to the connector runtime
    const idx = src.indexOf("bootstrapPartnerRbac();");
    const listenIdx = src.indexOf("httpServer.listen");
    expect(idx).toBeGreaterThan(listenIdx);
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

  it("PARTIAL seed state is repaired on the next boot", async () => {
    await clearRbac();
    await perms.seedPartnerRbac();
    // Simulate a crash midway: roles+permissions survived, role_permissions did not.
    await admin.query("DELETE FROM partner_role_permissions");
    await admin.query("DELETE FROM partner_roles WHERE code='PARTNER_OWNER'");
    expect((await admin.query("SELECT count(*)::int n FROM partner_roles WHERE code='PARTNER_OWNER'")).rows[0].n).toBe(
      0
    );

    await perms.seedPartnerRbac();
    expect((await admin.query("SELECT count(*)::int n FROM partner_roles WHERE code='PARTNER_OWNER'")).rows[0].n).toBe(
      1
    );
    const rp = await admin.query<{ n: number }>(
      `SELECT count(*)::int n FROM partner_role_permissions rp
         JOIN partner_roles r ON r.id=rp.role_id WHERE r.code='PARTNER_OWNER'`
    );
    expect(rp.rows[0].n).toBeGreaterThan(0);
  });

  it("two CONCURRENT bootstraps are safe — no duplicates, no missing permissions", async () => {
    await clearRbac();
    // Mirrors N Fly machines booting at once.
    await Promise.all([perms.seedPartnerRbac(), perms.seedPartnerRbac(), perms.seedPartnerRbac()]);
    const roles = await admin.query<{ code: string; n: number }>(
      "SELECT code, count(*)::int n FROM partner_roles GROUP BY code HAVING count(*) > 1"
    );
    expect(roles.rows, "no duplicate role rows").toEqual([]);
    const perms2 = await admin.query<{ code: string }>(
      "SELECT code, count(*)::int n FROM partner_permissions GROUP BY code HAVING count(*) > 1"
    );
    expect(perms2.rows, "no duplicate permission rows").toEqual([]);
    const owner = await admin.query<{ n: number }>(
      `SELECT count(*)::int n FROM partner_role_permissions rp
         JOIN partner_roles r ON r.id=rp.role_id WHERE r.code='PARTNER_OWNER'`
    );
    expect(owner.rows[0].n, "owner must still have its permissions after a concurrent seed").toBeGreaterThan(0);
  });

  it("role→permission mappings are complete for every seeded role", async () => {
    await clearRbac();
    await perms.seedPartnerRbac();
    const rows = await admin.query<{ code: string; n: number }>(
      `SELECT r.code, count(rp.permission_id)::int n
         FROM partner_roles r LEFT JOIN partner_role_permissions rp ON rp.role_id = r.id
        GROUP BY r.code ORDER BY r.code`
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) expect(r.n, `${r.code} has no permissions`).toBeGreaterThan(0);
  });

  it("an unknown role code still fails closed after seeding", async () => {
    await perms.seedPartnerRbac();
    const id = await newPartner("Unknown Role Ltd");
    await expect(
      svc.invitePartnerUser(
        actor({ requestId: "badrole" }),
        id,
        // deliberately outside ADMIN_ROLE_TO_PARTNER_ROLE
        { firstName: "X", lastName: "Y", email: "x@example.test", role: "SUPERUSER" as never },
        "bad role"
      )
    ).rejects.toBeTruthy();
  });

  it("readiness reports RBAC state — the fail-soft bootstrap is OBSERVABLE, not silent", async () => {
    await clearRbac();
    const bad = await perms.refreshPartnerRbacStatus();
    expect(bad.state, "unseeded RBAC must be reported as failed").toBe("failed");
    expect(bad.error).toMatch(/PARTNER_OWNER/);

    await perms.seedPartnerRbac();
    const good = await perms.refreshPartnerRbacStatus();
    expect(good.state).toBe("ready");
    expect(good.error).toBeNull();
  });

  // ---- SECURITY ACTIONS -----------------------------------------------------------------------
  it("admin password reset stores only a HASH, is single-use, and never returns the token", async () => {
    await perms.seedPartnerRbac();
    const id = await newPartner("Reset Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      id,
      { firstName: "R", lastName: "S", email: "reset@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    const token = captured.invitations[0].token as string;
    await svc.acceptPartnerInvitation(token, "an-adequately-long-password-1");

    const res = await svc.sendPartnerUserPasswordReset(actor({ requestId: "pr" }), id, userId, "user locked out");
    // no token, no password anywhere in the response
    const body = JSON.stringify(res.result);
    expect(body).not.toMatch(/[a-f0-9]{40,}/);
    expect(body).not.toContain("password");

    const rows = await admin.query<{ token_hash: string; expires_at: string; used_at: string | null }>(
      "SELECT token_hash, expires_at, used_at FROM partner_password_reset_tokens WHERE user_id=$1",
      [userId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/); // sha256, not a raw token
    expect(new Date(rows.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(rows.rows[0].used_at).toBeNull();

    // audited under the precise, already-permitted action
    const audit = await admin.query<{ action_type: string; after_state: Record<string, unknown> | null }>(
      "SELECT action_type, after_state FROM partner_management_audit WHERE request_id='pr' AND result='succeeded'"
    );
    expect(audit.rows[0].action_type).toBe("partner_user_password_reset_initiated");
    expect(JSON.stringify(audit.rows[0].after_state)).not.toMatch(/[a-f0-9]{40,}/);
  });

  it("password reset is refused for a non-ACTIVE account and across tenants", async () => {
    await perms.seedPartnerRbac();
    const a = await newPartner("Tenant A Reset Ltd");
    const b = await newPartner("Tenant B Reset Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      a,
      { firstName: "A", lastName: "A", email: "pending@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    // still INVITED, never accepted
    await expect(
      svc.sendPartnerUserPasswordReset(actor({ requestId: "p1" }), a, userId, "too early")
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
    // wrong tenant
    await expect(
      svc.sendPartnerUserPasswordReset(actor({ requestId: "p2" }), b, userId, "cross tenant")
    ).rejects.toMatchObject({ code: "PARTNER_USER_NOT_FOUND" });
  });

  it("MFA reset disables methods, burns recovery codes, revokes sessions and forces re-enrolment", async () => {
    await perms.seedPartnerRbac();
    const id = await newPartner("MFA Reset Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      id,
      { firstName: "M", lastName: "F", email: "mfa@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    await svc.acceptPartnerInvitation(captured.invitations[0].token as string, "an-adequately-long-password-1");

    // synthetic active second factor + recovery code + live session
    await admin.query(
      "INSERT INTO partner_mfa_methods (tenant_id, user_id, method, secret_ref, status) VALUES ($1,$2,'totp','enc:synthetic-ref','ACTIVE')",
      [id, userId]
    );
    await admin.query("INSERT INTO partner_recovery_codes (tenant_id, user_id, code_hash) VALUES ($1,$2,'hash-1')", [
      id,
      userId,
    ]);
    await admin.query("UPDATE partner_users SET mfa_enabled=true WHERE id=$1", [userId]);
    // A live session, so revocation is provable rather than assumed (accepting an invitation does
    // not itself create one).
    await admin.query(
      `INSERT INTO partner_sessions (tenant_id, user_id, token_hash, credential_version, absolute_expires_at)
       VALUES ($1,$2,'synthetic-session-hash',1, now() + interval '12 hours')`,
      [id, userId]
    );
    const before = await admin.query<{ credential_version: number }>(
      "SELECT credential_version FROM partner_users WHERE id=$1",
      [userId]
    );

    const res = await svc.resetPartnerUserMfa(actor({ requestId: "mfa" }), id, userId, "device lost");
    expect((res.result as { methodsDisabled: number }).methodsDisabled).toBe(1);
    expect((res.result as { recoveryCodesBurned: number }).recoveryCodesBurned).toBe(1);

    const m = await admin.query<{ status: string }>("SELECT status FROM partner_mfa_methods WHERE user_id=$1", [
      userId,
    ]);
    expect(m.rows.every((r) => r.status === "DISABLED")).toBe(true);
    const rc = await admin.query<{ used_at: string | null }>(
      "SELECT used_at FROM partner_recovery_codes WHERE user_id=$1",
      [userId]
    );
    expect(rc.rows.every((r) => r.used_at !== null)).toBe(true);
    const u = await admin.query<{ mfa_enabled: boolean; mfa_required: boolean; credential_version: number }>(
      "SELECT mfa_enabled, mfa_required, credential_version FROM partner_users WHERE id=$1",
      [userId]
    );
    expect(u.rows[0].mfa_enabled).toBe(false);
    expect(u.rows[0].mfa_required).toBe(true);
    expect(u.rows[0].credential_version).toBeGreaterThan(before.rows[0].credential_version);
    // MUTATION GAP CLOSED: assert the live session row is actually revoked, not merely that the
    // credential version moved. Removing the session UPDATE previously survived the suite.
    const sess = await admin.query<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM partner_sessions WHERE user_id=$1",
      [userId]
    );
    expect(sess.rows.length, "the accepted invitation should have created a session row").toBeGreaterThan(0);
    expect(
      sess.rows.every((r) => r.revoked_at !== null),
      "every live session must be revoked"
    ).toBe(true);

    // the audit names the action precisely and leaks no secret material
    const audit = await admin.query<{ action_type: string; after_state: Record<string, unknown> | null }>(
      "SELECT action_type, after_state FROM partner_management_audit WHERE request_id='mfa' AND result='succeeded'"
    );
    expect(audit.rows[0].action_type).toBe("partner_user_mfa_reset");
    const j = JSON.stringify(audit.rows[0].after_state);
    expect(j).not.toContain("synthetic-ref");
    expect(j).not.toContain("hash-1");
  });

  it("MFA reset is tenant-scoped", async () => {
    await perms.seedPartnerRbac();
    const a = await newPartner("MFA Tenant A Ltd");
    const b = await newPartner("MFA Tenant B Ltd");
    const created = await svc.invitePartnerUser(
      actor({ requestId: "i" }),
      a,
      { firstName: "A", lastName: "A", email: "mfa-a@example.test", role: "OWNER" },
      "invite"
    );
    const userId = (created.result as { userId: string }).userId;
    await expect(svc.resetPartnerUserMfa(actor({ requestId: "x" }), b, userId, "cross tenant")).rejects.toMatchObject({
      code: "PARTNER_USER_NOT_FOUND",
    });
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
