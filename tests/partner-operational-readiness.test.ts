import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationsRealistic,
  PARTNER_MIGRATIONS_WITH_PER_CARD,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";
import { derivePartnerOperationalReadiness, type PartnerReadinessFacts } from "../server/partner/operational-readiness";

const now = Date.UTC(2026, 7, 16, 12, 0, 0);
const healthy = (over: Partial<PartnerReadinessFacts> = {}): PartnerReadinessFacts => ({
  orgStatus: "ACTIVE",
  portalEnabled: true,
  loginFlagEnabled: true,
  emergencyStop: false,
  owner: {
    userStatus: "ACTIVE",
    passwordConfigured: true,
    invitationValid: false,
    mfaRequired: true,
    mfaConfigured: true,
  },
  locationEligible: true,
  station: {
    enrolledCount: 1,
    approvedActiveCount: 1,
    pendingApprovalCount: 0,
    active: {
      scannerConnected: true,
      lastSeenAt: new Date(now - 60_000).toISOString(),
      calibrationStatus: "VALID",
      currentCalibrationId: "calibration",
      currentProfileRevisionId: "revision",
      appVersion: "1.4.0",
      minimumSupportedVersion: "1.2.0",
    },
  },
  credits: 5,
  nowMs: now,
  ...over,
});

describe("P5 server-authoritative operational readiness", () => {
  it("passes only when all six dimensions pass", () => {
    const result = derivePartnerOperationalReadiness(healthy());
    expect(result.overall).toMatchObject({ ready: true, code: "READY" });
    expect(Object.values(result.dimensions).every((dimension) => dimension.status === "PASS")).toBe(true);
  });

  it("does not convert unknown inputs to pass", () => {
    expect(derivePartnerOperationalReadiness(healthy({ station: null })).dimensions.station.status).toBe("UNKNOWN");
    expect(derivePartnerOperationalReadiness(healthy({ credits: null })).dimensions.credits.status).toBe("UNKNOWN");
    expect(derivePartnerOperationalReadiness(healthy({ emergencyStop: null })).overall.ready).toBe(false);
  });

  it("separates missing wallets, station approval, and station absence", () => {
    expect(derivePartnerOperationalReadiness(healthy({ credits: "NO_WALLET" })).overall.code).toBe("CREDITS_REQUIRED");
    expect(
      derivePartnerOperationalReadiness(
        healthy({ station: { enrolledCount: 0, approvedActiveCount: 0, pendingApprovalCount: 0, active: null } })
      ).overall.code
    ).toBe("STATION_SETUP_REQUIRED");
    const pending = derivePartnerOperationalReadiness(
      healthy({ station: { enrolledCount: 1, approvedActiveCount: 0, pendingApprovalCount: 1, active: null } })
    );
    expect(pending.overall.code).toBe("STATION_APPROVAL_PENDING");
    expect(pending.dimensions.station.status).toBe("PENDING");
    expect(pending.dimensions.station.actions.every((action) => action.href === undefined)).toBe(true);
  });

  it("does not pass a partner with no owner or an enrolled station that is not active", () => {
    expect(derivePartnerOperationalReadiness(healthy({ owner: null })).overall.code).toBe("OWNER_SETUP_REQUIRED");
    const enrolled = derivePartnerOperationalReadiness(
      healthy({ station: { enrolledCount: 1, approvedActiveCount: 0, pendingApprovalCount: 0, active: null } })
    );
    expect(enrolled.overall.code).toBe("STATION_SETUP_REQUIRED");
    expect(enrolled.dimensions.station.status).toBe("BLOCKED");
  });

  it("blocks a zero-credit partner even when all other dimensions pass", () => {
    const result = derivePartnerOperationalReadiness(healthy({ credits: 0 }));
    expect(result.overall).toMatchObject({ ready: false, code: "CREDITS_REQUIRED" });
    expect(result.actions.some((action) => action.href === "/partner/billing")).toBe(true);
  });

  it("uses active locations and complete calibration/profile evidence for station readiness", () => {
    const absentProfile = healthy();
    if (absentProfile.station?.active) absentProfile.station.active.currentProfileRevisionId = undefined;
    expect(derivePartnerOperationalReadiness(absentProfile).dimensions.scanner.status).toBe("UNKNOWN");

    const stale = healthy();
    if (stale.station?.active) stale.station.active.lastSeenAt = new Date(now - 6 * 60_000).toISOString();
    expect(derivePartnerOperationalReadiness(stale).overall.code).toBe("SCANNER_OFFLINE");
  });

  it("blocks disconnected, uncalibrated, and outdated scanners without inventing a failure cause", () => {
    const disconnected = healthy();
    if (disconnected.station?.active) disconnected.station.active.scannerConnected = false;
    expect(derivePartnerOperationalReadiness(disconnected).overall.code).toBe("SCANNER_OFFLINE");

    const calibration = healthy();
    if (calibration.station?.active) calibration.station.active.calibrationStatus = "EXPIRED";
    expect(derivePartnerOperationalReadiness(calibration).overall.code).toBe("CALIBRATION_REQUIRED");

    const old = healthy();
    if (old.station?.active) old.station.active.appVersion = "1.1.9";
    expect(derivePartnerOperationalReadiness(old).overall.code).toBe("SCANNER_UPDATE_REQUIRED");

    const unknownVersion = healthy();
    if (unknownVersion.station?.active) unknownVersion.station.active.appVersion = null;
    expect(derivePartnerOperationalReadiness(unknownVersion).dimensions.scanner.status).toBe("UNKNOWN");

    const noMinimum = healthy();
    if (noMinimum.station?.active) {
      noMinimum.station.active.minimumSupportedVersion = null;
      noMinimum.station.active.appVersion = null;
    }
    expect(derivePartnerOperationalReadiness(noMinimum).overall.ready).toBe(true);
  });

  it("keeps organisation, invitation, and MFA gates server-authoritative", () => {
    expect(derivePartnerOperationalReadiness(healthy({ orgStatus: "SUSPENDED" })).overall.code).toBe(
      "PARTNER_SUSPENDED"
    );
    expect(derivePartnerOperationalReadiness(healthy({ orgStatus: "REVOKED" })).overall.code).toBe("PARTNER_REVOKED");
    expect(derivePartnerOperationalReadiness(healthy({ portalEnabled: false })).overall.code).toBe("PORTAL_DISABLED");
    expect(derivePartnerOperationalReadiness(healthy({ loginFlagEnabled: false })).overall.code).toBe("LOGIN_DISABLED");
    expect(derivePartnerOperationalReadiness(healthy({ emergencyStop: true })).overall.code).toBe("EMERGENCY_STOP");
    expect(derivePartnerOperationalReadiness(healthy({ locationEligible: false })).overall.code).toBe(
      "LOCATION_REQUIRED"
    );

    const invite = derivePartnerOperationalReadiness(
      healthy({
        owner: {
          userStatus: "INVITED",
          passwordConfigured: false,
          invitationValid: true,
          mfaRequired: true,
          mfaConfigured: false,
        },
      })
    );
    expect(invite.overall.code).toBe("AWAITING_PASSWORD_SETUP");
    const expired = derivePartnerOperationalReadiness(
      healthy({
        owner: {
          userStatus: "INVITED",
          passwordConfigured: false,
          invitationValid: false,
          mfaRequired: true,
          mfaConfigured: false,
        },
      })
    );
    expect(expired.overall.code).toBe("INVITATION_EXPIRED");
    const mfa = derivePartnerOperationalReadiness(
      healthy({
        owner: {
          userStatus: "ACTIVE",
          passwordConfigured: true,
          invitationValid: false,
          mfaRequired: true,
          mfaConfigured: false,
        },
      })
    );
    expect(mfa.overall.code).toBe("AWAITING_MFA_SETUP");
    expect(mfa.dimensions.owner.actions.find((action) => action.audience === "PARTNER")?.href).toBe(
      "/partner/security"
    );
  });

  it("provides honest, audience-directed actions without leaking implementation vocabulary", () => {
    const cases = [healthy({ credits: 0 }), healthy({ locationEligible: false }), healthy({ station: null })];
    const internal = /tenant|rls|uuid|sql|partner_stations|partner_wallets|migration/i;
    for (const facts of cases) {
      const result = derivePartnerOperationalReadiness(facts);
      expect(result.overall.message).not.toMatch(internal);
      for (const dimension of Object.values(result.dimensions)) expect(dimension.message).not.toMatch(internal);
      for (const action of result.actions) {
        expect(action.label.length).toBeGreaterThan(0);
        if (action.href) expect(action.href).toMatch(/^\/(partner|admin)\//);
      }
    }
  });
});

describe("P5 operational readiness collection (real PostgreSQL)", () => {
  let cluster: DisposablePostgres17;
  let admin: Client;
  let service: typeof import("../server/partner/partner-management-service");

  beforeAll(async () => {
    cluster = await startPostgres17("partner-operational-readiness-current-main");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    process.env.PARTNER_ADMIN_DATABASE_URL = cluster.url;
    process.env.PARTNER_DATABASE_URL = cluster.url;
    process.env.PARTNER_CREDIT_DATABASE_URL = cluster.url;
    admin = new Client({ connectionString: cluster.url });
    await admin.connect();
    await provisionRealisticRoles(admin);
    for (const statement of [
      "CREATE TABLE users (id varchar primary key default gen_random_uuid(), email varchar unique)",
      "CREATE TABLE submissions (id serial primary key, user_id varchar, status varchar(30), tracking_number text unique, deleted_at timestamptz, status_history jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now())",
      "CREATE TABLE submission_items (id serial primary key, submission_id integer not null)",
      "CREATE TABLE certificates (id serial primary key, cert_id text, submission_id integer, secret text)",
      "CREATE TABLE label_prints (id serial primary key, certificate_id integer, created_at timestamptz not null default now())",
      "CREATE TABLE audit_log (id serial primary key, entity_type text not null, entity_id text not null, action text not null, admin_user text, details jsonb, created_at timestamptz not null default now())",
    ])
      await admin.query(statement);
    for (const table of ["users", "submissions", "submission_items", "certificates", "label_prints", "audit_log"]) {
      await admin.query(`ALTER TABLE ${table} OWNER TO pn_migrator`);
    }
    await applyMigrationsRealistic(admin, cluster.url, [
      ...PARTNER_MIGRATIONS_WITH_PER_CARD,
      // getPartnerOnboardingReadiness reads the existing invitation state as part of owner readiness.
      "0031_partner_user_management",
      "0045_partner_stations",
    ]);
    service = await import("../server/partner/partner-management-service");
  }, 240_000);

  afterAll(async () => {
    const { closePartnerPools } = await import("../server/partner/db");
    await closePartnerPools().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop().catch(() => {});
  });

  it("returns server-derived blockers from real flags, organisation, location, station and wallet tables without writes", async () => {
    const actor = {
      actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorEmail: "p5@example.test",
      requestId: "p5-current-main",
    };
    const created = await service.createPartner(actor, { legalName: "P5 Current Main Ltd" }, "P5 collection proof");
    const partnerId = (created.result as { partnerId: string }).partnerId;
    await admin.query("UPDATE partner_organisations SET status='ACTIVE' WHERE id=$1", [partnerId]);
    for (const [flag, enabled] of [
      ["partner_portal_enabled", true],
      ["partner_login_enabled", true],
      ["partner_emergency_stop", false],
    ] as const) {
      await admin.query(
        "INSERT INTO partner_feature_flags (flag, enabled, tenant_id, location_id) VALUES ($1,$2,NULL,NULL)",
        [flag, enabled]
      );
    }
    const before = await admin.query("SELECT count(*)::int AS wallets FROM partner_wallets WHERE tenant_id=$1", [
      partnerId,
    ]);
    const result = await service.getPartnerOnboardingReadiness(partnerId);
    const after = await admin.query("SELECT count(*)::int AS wallets FROM partner_wallets WHERE tenant_id=$1", [
      partnerId,
    ]);
    expect(result.operational.overall.ready).toBe(false);
    expect(result.operational.dimensions.owner.code).toBe("OWNER_SETUP_REQUIRED");
    expect(result.operational.dimensions.station.code).toBe("STATION_SETUP_REQUIRED");
    expect(result.operational.dimensions.credits.code).toBe("CREDITS_REQUIRED");
    expect(after.rows[0]).toEqual(before.rows[0]);
    await admin.query("UPDATE partner_feature_flags SET enabled=true WHERE flag='partner_emergency_stop'");
    expect((await service.getPartnerOnboardingReadiness(partnerId)).operational.overall.code).toBe("EMERGENCY_STOP");
  });
});
