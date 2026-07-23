import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { PARTNER_MIGRATIONS, applyMigrationsRealistic } from "./helpers/partner-realistic-db";
import {
  canAssignPartnerRole,
  canManagePartnerRoleAssignment,
  PARTNER_ROLE_LABELS,
} from "../server/partner/permissions";
import { invitationDefinerModelViolations } from "../server/partner/definer-guard";
import {
  createInvitation,
  resendInvitation,
  changeMemberRole,
  revokeMemberSessions,
  setMemberStatus,
  setPartnerStatus,
} from "../server/partner/partner-access-service";
import { setPartnerInvitationDeliveryAdapter } from "../server/partner/invitation-delivery";

const TENANT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LOCATION = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER_TENANT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const OTHER_LOCATION = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("Partner invitations and RBAC (real PostgreSQL)", () => {
  let pg: DisposablePostgres17;
  let admin: Client;
  let runtime: Client;
  let runtimeUrl: string;

  beforeAll(async () => {
    pg = await startPostgres17("partner-auth-invitations");
    admin = new Client({ connectionString: pg.url });
    await admin.connect();
    // 0020 deliberately has no G6D dependency; this proves safe development from the current
    // authority while the final release must separately verify 0018 → 0019 → 0020.
    await applyMigrationsRealistic(admin, pg.url, [
      ...PARTNER_MIGRATIONS,
      "0016_partner_wallet_ledger",
      "0017_partner_credit_reservations",
      "0020_partner_auth_invitations_rbac",
    ]);
    await admin.query("CREATE ROLE partner_invitation_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_invitation_test");
    const runtimeConnection = new URL(pg.url);
    runtimeConnection.username = "partner_invitation_test";
    runtimeConnection.password = "synthetic";
    runtimeUrl = runtimeConnection.toString();
    runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
    process.env.PARTNER_ADMIN_DATABASE_URL = pg.url;

    await admin.query(
      "INSERT INTO partner_roles (id, code, label) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','MVGS_ASSESSMENT_TECHNICIAN','Partner Grader')"
    );
    await admin.query(
      "INSERT INTO partner_roles (id, code, label) VALUES ('cccccccc-cccc-cccc-cccc-ccccccccccc1','PARTNER_RECEPTION','Reception')"
    );
    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'auth-a','Auth A','ACTIVE')",
      [TENANT]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'auth-l',$2,$2,'Auth Location','ACTIVE')",
      [LOCATION, TENANT]
    );
  });

  afterAll(async () => {
    setPartnerInvitationDeliveryAdapter(null);
    await runtime?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await pg?.stop();
  });

  async function invitation(email: string, token: string): Promise<string> {
    const result = await admin.query<{ id: string }>(
      `INSERT INTO partner_invitations (tenant_id, invited_email, role_id, token_hash, expires_at, created_by_email)
       VALUES ($1,$2,'cccccccc-cccc-cccc-cccc-cccccccccccc',$3,now() + interval '1 hour','super@example.com') RETURNING id`,
      [TENANT, email, sha256(token)]
    );
    await admin.query(
      "INSERT INTO partner_invitation_locations (invitation_id, tenant_id, location_id) VALUES ($1,$2,$3)",
      [result.rows[0].id, TENANT, LOCATION]
    );
    return result.rows[0].id;
  }

  it("uses a definer-owned, single-use acceptance transition without raw-token persistence", async () => {
    const token = crypto.randomBytes(32).toString("base64url");
    const invitationId = await invitation("grader@example.com", token);
    const passwordHash = await bcrypt.hash("correct-horse-battery", 12);
    const accepted = await runtime.query<{ outcome: string; accepted_user_id: string; accepted_tenant_id: string }>(
      "SELECT * FROM partner_accept_invitation($1,$2,$3,$4)",
      [sha256(token), "grader@example.com", passwordHash, "test-request"]
    );
    expect(accepted.rows[0]).toMatchObject({ outcome: "accepted", accepted_tenant_id: TENANT });
    const userId = accepted.rows[0].accepted_user_id;
    const member = await admin.query<{ invitation_id: string }>("SELECT invitation_id FROM partner_users WHERE id=$1", [
      userId,
    ]);
    expect(member.rows[0].invitation_id).toBe(invitationId);
    expect((await admin.query("SELECT role_id FROM partner_user_roles WHERE user_id=$1", [userId])).rowCount).toBe(1);
    expect(
      (await admin.query("SELECT location_id FROM partner_user_locations WHERE user_id=$1", [userId])).rows[0]
        .location_id
    ).toBe(LOCATION);
    expect(
      (await admin.query("SELECT token_hash FROM partner_invitations WHERE id=$1", [invitationId])).rows[0].token_hash
    ).toBe(sha256(token));
    expect(
      JSON.stringify((await admin.query("SELECT * FROM partner_access_audit_events WHERE tenant_id=$1", [TENANT])).rows)
    ).not.toContain(token);

    const replay = await runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
      sha256(token),
      "grader@example.com",
      passwordHash,
    ]);
    expect(replay.rows[0].outcome).toBe("used");
    expect(
      (await admin.query("SELECT count(*)::int AS count FROM partner_users WHERE email='grader@example.com' ")).rows[0]
        .count
    ).toBe(1);
  });

  it("rejects concurrent reuse, direct role mutation, direct invitation mutation, and audit rewrites", async () => {
    const token = crypto.randomBytes(32).toString("base64url");
    await invitation("race@example.com", token);
    const passwordHash = await bcrypt.hash("another-correct-horse", 12);
    const peer = new Client({ connectionString: runtimeUrl });
    await peer.connect();
    const [first, second] = await Promise.all([
      runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
        sha256(token),
        "race@example.com",
        passwordHash,
      ]),
      peer.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
        sha256(token),
        "race@example.com",
        passwordHash,
      ]),
    ]);
    await peer.end();
    expect([first.rows[0].outcome, second.rows[0].outcome]).toEqual(expect.arrayContaining(["accepted", "used"]));
    expect(
      (await admin.query("SELECT count(*)::int AS count FROM partner_users WHERE email='race@example.com' ")).rows[0]
        .count
    ).toBe(1);
    await expect(
      runtime.query("UPDATE partner_user_roles SET role_id='cccccccc-cccc-cccc-cccc-cccccccccccc'")
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runtime.query("UPDATE partner_user_locations SET location_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'")
    ).rejects.toThrow(/permission denied/i);
    await expect(runtime.query("UPDATE partner_invitations SET status='ACCEPTED'")).rejects.toThrow(
      /permission denied/i
    );
    await expect(admin.query("UPDATE partner_access_audit_events SET action='member_suspended'")).rejects.toThrow(
      /append-only/i
    );
    await expect(admin.query("DELETE FROM partner_access_audit_events")).rejects.toThrow(/append-only/i);
    await expect(admin.query("TRUNCATE partner_access_audit_events")).rejects.toThrow(/append-only/i);
  });

  it("fails closed for terminal, mismatched, and cross-Partner invitation acceptance", async () => {
    const passwordHash = await bcrypt.hash("terminal-state-password", 12);
    const mismatchedToken = crypto.randomBytes(32).toString("base64url");
    await invitation("identity@example.com", mismatchedToken);
    expect(
      (
        await runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
          sha256(mismatchedToken),
          "not-the-invitee@example.com",
          passwordHash,
        ])
      ).rows[0].outcome
    ).toBe("invalid");
    expect(
      (
        await runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
          sha256(mismatchedToken),
          "identity@example.com",
          passwordHash,
        ])
      ).rows[0].outcome
    ).toBe("accepted");

    const expiredToken = crypto.randomBytes(32).toString("base64url");
    const expired = await admin.query<{ id: string }>(
      `INSERT INTO partner_invitations
         (tenant_id, invited_email, role_id, token_hash, created_by_email, created_at, expires_at)
       VALUES ($1,'expired@example.com','cccccccc-cccc-cccc-cccc-cccccccccccc',$2,'super@example.com',
               now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
      [TENANT, sha256(expiredToken)]
    );
    await admin.query(
      "INSERT INTO partner_invitation_locations (invitation_id, tenant_id, location_id) VALUES ($1,$2,$3)",
      [expired.rows[0].id, TENANT, LOCATION]
    );
    expect(
      (
        await runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
          sha256(expiredToken),
          "expired@example.com",
          passwordHash,
        ])
      ).rows[0].outcome
    ).toBe("expired");

    const revokedToken = crypto.randomBytes(32).toString("base64url");
    const revokedId = await invitation("revoked@example.com", revokedToken);
    await admin.query("UPDATE partner_invitations SET status='REVOKED', revoked_at=now() WHERE id=$1", [revokedId]);
    expect(
      (
        await runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
          sha256(revokedToken),
          "revoked@example.com",
          passwordHash,
        ])
      ).rows[0].outcome
    ).toBe("revoked");

    const supersededToken = crypto.randomBytes(32).toString("base64url");
    const supersededId = await invitation("superseded@example.com", supersededToken);
    await admin.query("UPDATE partner_invitations SET status='SUPERSEDED', superseded_at=now() WHERE id=$1", [
      supersededId,
    ]);
    expect(
      (
        await runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
          sha256(supersededToken),
          "superseded@example.com",
          passwordHash,
        ])
      ).rows[0].outcome
    ).toBe("superseded");

    await admin.query(
      "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'auth-b','Auth B','ACTIVE')",
      [OTHER_TENANT]
    );
    await admin.query(
      "INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES ($1,'auth-b-l',$2,$2,'Auth B Location','ACTIVE')",
      [OTHER_LOCATION, OTHER_TENANT]
    );
    const crossToken = crypto.randomBytes(32).toString("base64url");
    const cross = await admin.query<{ id: string }>(
      `INSERT INTO partner_invitations (tenant_id, invited_email, role_id, token_hash, expires_at, created_by_email)
       VALUES ($1,'grader@example.com','cccccccc-cccc-cccc-cccc-cccccccccccc',$2,now()+interval '1 hour','super@example.com')
       RETURNING id`,
      [OTHER_TENANT, sha256(crossToken)]
    );
    await admin.query(
      "INSERT INTO partner_invitation_locations (invitation_id, tenant_id, location_id) VALUES ($1,$2,$3)",
      [cross.rows[0].id, OTHER_TENANT, OTHER_LOCATION]
    );
    expect(
      (
        await runtime.query<{ outcome: string }>("SELECT outcome FROM partner_accept_invitation($1,$2,$3)", [
          sha256(crossToken),
          "grader@example.com",
          passwordHash,
        ])
      ).rows[0].outcome
    ).toBe("invalid");
    expect(
      (await admin.query("SELECT count(*)::int AS count FROM partner_users WHERE tenant_id=$1", [OTHER_TENANT])).rows[0]
        .count
    ).toBe(0);
  });

  it("enforces role hierarchy and the canonical Partner Grader display mapping", async () => {
    expect(PARTNER_ROLE_LABELS.MVGS_ASSESSMENT_TECHNICIAN).toBe("Partner Grader");
    expect(canAssignPartnerRole(["PARTNER_OWNER"], "PARTNER_MANAGER")).toBe(true);
    expect(canAssignPartnerRole(["PARTNER_MANAGER"], "PARTNER_OWNER")).toBe(false);
    expect(canAssignPartnerRole(["MVGS_ASSESSMENT_TECHNICIAN"], "PARTNER_RECEPTION")).toBe(false);
    expect(
      canManagePartnerRoleAssignment({
        actorUserId: "same-user",
        targetUserId: "same-user",
        actorRoles: ["PARTNER_OWNER"],
        requestedRole: "PARTNER_MANAGER",
      })
    ).toBe(false);
  });

  it("records failed and suppressed Resend-adapter delivery without consuming the invitation", async () => {
    const actor = {
      userId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      email: "super@example.com",
      correlationId: "delivery-state-test",
    };
    setPartnerInvitationDeliveryAdapter(async () => {
      throw new Error("synthetic provider failure");
    });
    const failed = await createInvitation(actor, TENANT, {
      email: "delivery-failed@example.com",
      role: "MVGS_ASSESSMENT_TECHNICIAN",
      locationIds: [LOCATION],
      idempotencyKey: "delivery-failed",
    });
    expect(failed.deliveryStatus).toBe("FAILED");
    expect(
      (await admin.query("SELECT status, delivery_status FROM partner_invitations WHERE id=$1", [failed.invitation.id]))
        .rows[0]
    ).toMatchObject({ status: "PENDING", delivery_status: "FAILED" });

    setPartnerInvitationDeliveryAdapter(async () => ({ suppressed: true }));
    const suppressed = await createInvitation(actor, TENANT, {
      email: "delivery-suppressed@example.com",
      role: "MVGS_ASSESSMENT_TECHNICIAN",
      locationIds: [LOCATION],
      idempotencyKey: "delivery-suppressed",
    });
    expect(suppressed.deliveryStatus).toBe("SUPPRESSED");
    expect(
      (
        await admin.query("SELECT status, delivery_status FROM partner_invitations WHERE id=$1", [
          suppressed.invitation.id,
        ])
      ).rows[0]
    ).toMatchObject({ status: "PENDING", delivery_status: "SUPPRESSED" });
  });

  it("scopes idempotency to the invitation operation and replays a concurrent-safe resend", async () => {
    const deliveredUrls: string[] = [];
    setPartnerInvitationDeliveryAdapter(async ({ invitationUrl }) => {
      deliveredUrls.push(invitationUrl);
      return { providerMessageId: `test-${deliveredUrls.length}` };
    });
    const actor = {
      userId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      email: "super@example.com",
      correlationId: "resend-idempotency-test",
    };
    const original = await createInvitation(actor, TENANT, {
      email: "resend@example.com",
      role: "MVGS_ASSESSMENT_TECHNICIAN",
      locationIds: [LOCATION],
      idempotencyKey: "shared-client-key",
    });
    const first = await resendInvitation(actor, TENANT, original.invitation.id, "shared-client-key");
    const replay = await resendInvitation(actor, TENANT, original.invitation.id, "shared-client-key");
    expect(first.alreadyCompleted).toBe(false);
    expect(replay).toMatchObject({ alreadyCompleted: true, invitation: { id: first.invitation.id } });
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM partner_invitations WHERE resend_of_id=$1", [
          original.invitation.id,
        ])
      ).rows[0].count
    ).toBe(1);
    // A create replay stays scoped to the create operation and does not alias the resend successor.
    const createReplay = await createInvitation(actor, TENANT, {
      email: "another-create@example.com",
      role: "MVGS_ASSESSMENT_TECHNICIAN",
      locationIds: [LOCATION],
      idempotencyKey: "shared-client-key",
    });
    expect(createReplay).toMatchObject({ alreadyCompleted: true, invitation: { id: original.invitation.id } });
    expect(deliveredUrls).toHaveLength(2);
    expect(deliveredUrls.every((url) => url.startsWith("https://mintvaultuk.com/partner/invite#token="))).toBe(true);
    const deliveryToken = new URL(deliveredUrls[0]).hash.slice("#token=".length);
    expect(
      JSON.stringify(
        (
          await admin.query("SELECT delivery_metadata FROM partner_invitations WHERE id IN ($1,$2)", [
            original.invitation.id,
            first.invitation.id,
          ])
        ).rows
      )
    ).not.toContain(deliveryToken);

    const concurrent = await Promise.all(
      [0, 1].map(() =>
        createInvitation(actor, TENANT, {
          email: "concurrent-idempotency@example.com",
          role: "MVGS_ASSESSMENT_TECHNICIAN",
          locationIds: [LOCATION],
          idempotencyKey: "concurrent-create-key",
        })
      )
    );
    expect(new Set(concurrent.map((result) => result.invitation.id)).size).toBe(1);
    expect(concurrent.filter((result) => !result.alreadyCompleted)).toHaveLength(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM partner_invitations WHERE invited_email='concurrent-idempotency@example.com'"
        )
      ).rows[0].count
    ).toBe(1);
  });

  it("keeps invitation acceptance inside the definer governance model", async () => {
    const violations = await invitationDefinerModelViolations((sql, params) => runtime.query(sql, params));
    expect(violations).toEqual([]);
    const acl = await admin.query<{
      public_exec: boolean;
      runtime_exec: boolean;
      owner: string;
      prosecdef: boolean;
      config: string[] | null;
    }>(
      `SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('partner_runtime', p.oid, 'EXECUTE') AS runtime_exec,
              pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='partner_accept_invitation'`
    );
    expect(acl.rows[0]).toMatchObject({
      public_exec: false,
      runtime_exec: true,
      owner: "partner_definer",
      prosecdef: true,
    });
    expect(acl.rows[0].config).toContain("search_path=pg_catalog, public, pg_temp");
  });

  it("fails closed when authentication is disabled and registers the minimal Partner mount", async () => {
    process.env.PARTNER_DATABASE_URL = runtimeUrl;
    process.env.PARTNER_ADMIN_DATABASE_URL = pg.url;
    process.env.MINTVAULT_DATABASE_URL = pg.url;
    await admin.query(
      "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true),(NULL,'partner_authentication_enabled',false)"
    );
    const { createPartnerApp, createPartnerRouter } = await import("../server/partner/app");
    const { closePartnerPools } = await import("../server/partner/db");
    const { pool: mintvaultPool } = await import("../server/db");
    const server = http.createServer(createPartnerApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const disabled = await fetch(`${base}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "password" }),
      });
      expect(disabled.status).toBe(503);
      await admin.query(
        "UPDATE partner_feature_flags SET enabled=true WHERE flag='partner_authentication_enabled' AND tenant_id IS NULL"
      );
      const enabled = await fetch(`${base}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "password" }),
      });
      expect(enabled.status).toBe(401);
      await admin.query(
        "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_emergency_stop',true)"
      );
      const stopped = await fetch(`${base}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "password" }),
      });
      expect(stopped.status).toBe(503);
      await admin.query(
        "UPDATE partner_feature_flags SET enabled=false WHERE flag='partner_emergency_stop' AND tenant_id IS NULL"
      );

      const mainPartnerSurface = express();
      mainPartnerSurface.use(createPartnerRouter());
      mainPartnerSurface.use((_req, res) => res.status(404).json({ error: "not found" }));
      const mainPartnerServer = http.createServer(mainPartnerSurface);
      await new Promise<void>((resolve) => mainPartnerServer.listen(0, "127.0.0.1", resolve));
      const mainPartnerBase = `http://127.0.0.1:${(mainPartnerServer.address() as AddressInfo).port}`;
      try {
        expect((await fetch(`${mainPartnerBase}/api/partner/users`)).status).toBe(401);
        expect((await fetch(`${mainPartnerBase}/api/partner/locations`)).status).toBe(401);
        expect((await fetch(`${mainPartnerBase}/api/partner/session/location`, { method: "POST" })).status).toBe(401);
      } finally {
        await new Promise<void>((resolve) => mainPartnerServer.close(() => resolve()));
      }

      const httpToken = crypto.randomBytes(32).toString("base64url");
      await invitation("http-accept@example.com", httpToken);
      const httpAcceptance = await fetch(`${base}/api/partner/invitations/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: httpToken, email: "http-accept@example.com", password: "http-accept-password" }),
      });
      const acceptedBody = await httpAcceptance.text();
      expect(httpAcceptance.status).toBe(201);
      expect(acceptedBody).not.toContain(httpToken);
      const httpReplay = await fetch(`${base}/api/partner/invitations/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: httpToken, email: "http-accept@example.com", password: "http-accept-password" }),
      });
      expect(httpReplay.status).toBe(400);
      await expect(httpReplay.json()).resolves.toEqual({ error: "invitation unavailable" });

      const login = await fetch(`${base}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "identity@example.com", password: "terminal-state-password" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      expect((await fetch(`${base}/api/partner/session`, { headers: { cookie } })).status).toBe(200);
      const identityUserId = (
        await admin.query<{ id: string }>("SELECT id FROM partner_users WHERE email='identity@example.com'")
      ).rows[0].id;
      const actor = {
        userId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        email: "super@example.com",
        correlationId: "session-enforcement-test",
      };
      await changeMemberRole(actor, TENANT, identityUserId, "PARTNER_RECEPTION", "role downgrade test");
      expect((await fetch(`${base}/api/partner/session`, { headers: { cookie } })).status).toBe(401);

      const relogin = await fetch(`${base}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "identity@example.com", password: "terminal-state-password" }),
      });
      const reloginCookie = relogin.headers.get("set-cookie")!.split(";")[0];
      await revokeMemberSessions(actor, TENANT, identityUserId, "session revocation test");
      expect((await fetch(`${base}/api/partner/session`, { headers: { cookie: reloginCookie } })).status).toBe(401);

      await setMemberStatus(actor, TENANT, identityUserId, false, "member suspension test");
      expect(
        (
          await fetch(`${base}/api/partner/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "identity@example.com", password: "terminal-state-password" }),
          })
        ).status
      ).toBe(401);
      await setMemberStatus(actor, TENANT, identityUserId, true, "member reactivation test");
      await setPartnerStatus(actor, TENANT, false, "Partner suspension test");
      expect(
        (
          await fetch(`${base}/api/partner/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: "identity@example.com", password: "terminal-state-password" }),
          })
        ).status
      ).toBe(401);
      await setPartnerStatus(actor, TENANT, true, "Partner reactivation test");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closePartnerPools();
      await mintvaultPool.end().catch(() => {});
    }
    const mainRoutes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    expect(mainRoutes).toContain("registerPartnerPortalRoutes(app)");
    expect(mainRoutes).toContain("registerPartnerAccessAdminRoutes(app)");
  });

  it("refuses rollback when immutable access evidence exists", async () => {
    const rollbackSql = readFileSync(
      new URL("../migrations/rollback-partner-auth-invitations-rbac.sql", import.meta.url),
      "utf8"
    );
    await expect(admin.query(rollbackSql)).rejects.toThrow(/immutable access-audit evidence exists/);
    await admin.query("ROLLBACK").catch(() => {});
    expect(
      (await admin.query("SELECT to_regclass('public.partner_access_audit_events') AS relation")).rows[0].relation
    ).toBe("partner_access_audit_events");
  });

  it("executes the guarded rollback only for an empty disposable installation", async () => {
    const rollbackPg = await startPostgres17("partner-auth-invitations-rollback");
    const rollbackAdmin = new Client({ connectionString: rollbackPg.url });
    await rollbackAdmin.connect();
    const rollbackMigratorUrl = new URL(rollbackPg.url);
    rollbackMigratorUrl.username = "pn_migrator";
    rollbackMigratorUrl.password = "realistic-migrator-pw";
    const rollbackMigrator = new Client({ connectionString: rollbackMigratorUrl.toString() });
    try {
      await applyMigrationsRealistic(rollbackAdmin, rollbackPg.url, [
        ...PARTNER_MIGRATIONS,
        "0016_partner_wallet_ledger",
        "0017_partner_credit_reservations",
        "0020_partner_auth_invitations_rbac",
      ]);
      await rollbackMigrator.connect();
      await rollbackMigrator.query("CREATE TABLE schema_migrations (filename text PRIMARY KEY)");
      await rollbackMigrator.query(
        "INSERT INTO schema_migrations (filename) VALUES ('0020_partner_auth_invitations_rbac.sql')"
      );
      await rollbackMigrator.query(
        readFileSync(new URL("../migrations/rollback-partner-auth-invitations-rbac.sql", import.meta.url), "utf8")
      );
      expect(
        (await rollbackAdmin.query("SELECT to_regclass('public.partner_invitations') AS relation")).rows[0].relation
      ).toBe(null);
      expect(
        (
          await rollbackAdmin.query(
            "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='partner_users' AND column_name='invitation_id'"
          )
        ).rows[0].count
      ).toBe(0);
      expect(
        (
          await rollbackAdmin.query(
            "SELECT relforcerowsecurity AS force FROM pg_class WHERE oid='partner_users'::regclass"
          )
        ).rows[0].force
      ).toBe(true);
    } finally {
      await rollbackMigrator.end().catch(() => {});
      await rollbackAdmin.end().catch(() => {});
      await rollbackPg.stop();
    }
  }, 60_000);
});
