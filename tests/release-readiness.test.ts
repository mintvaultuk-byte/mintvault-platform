import { describe, expect, it, vi } from "vitest";
import {
  checkReleaseReadiness,
  checkReleaseConfiguration,
  checkReleaseRuntime,
  REQUIRED_PRODUCTION_ENVIRONMENT,
  REQUIRED_RELEASE_MIGRATIONS,
  REQUIRED_RELEASE_RELATIONS,
  REQUIRED_RELEASE_TRIGGER_RELATIONS,
  REQUIRED_RELEASE_TRIGGERS,
  PAYMENT_FULFILMENT_READINESS_SQL,
} from "../server/readiness";

describe("release readiness contract", () => {
  it("requires the journal, critical surfaces, scanner evidence and permanent-identity triggers", () => {
    expect(REQUIRED_RELEASE_RELATIONS).toEqual(
      expect.arrayContaining([
        "public.schema_migrations",
        "public.certificates",
        "public.cert_counter",
        "public.partner_organisations",
        "public.scanner_processing_jobs",
        "public.certificate_image_evidence",
        "public.partner_rate_limit_buckets",
        "public.public_rate_limit_buckets",
        "public.grading_payment_fulfilments",
        "public.session",
        "public.object_write_operations",
        "public.object_write_items",
      ])
    );
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0114_certificate_identity_authority.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0089_partner_shared_rate_limit_buckets.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0115_runtime_schema_convergence.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0116_nfc_physical_lock_integrity.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0117_grading_payment_fulfilment_outbox.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0118_nfc_lock_intent_reconciliation.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0119_session_store_authority.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0120_customer_notification_outbox.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0121_main_runtime_role_authority.sql");
    expect(REQUIRED_RELEASE_MIGRATIONS).toContain("0122_object_write_intent_reconciliation.sql");
    expect(REQUIRED_RELEASE_TRIGGERS).toEqual(
      expect.arrayContaining([
        "trg_certificate_number_immutable",
        "trg_cert_counter_identity_guard",
        "trg_cert_counter_refuse_truncate",
        "trg_nfc_locked_binding_immutable",
        "trg_nfc_lock_intent_guards_binding",
        "trg_object_write_operation_guard",
        "trg_object_write_item_guard",
      ])
    );
    expect(REQUIRED_RELEASE_TRIGGERS.map((name, index) => [name, REQUIRED_RELEASE_TRIGGER_RELATIONS[index]])).toEqual(
      expect.arrayContaining([
        ["trg_certificate_number_immutable", "public.certificates"],
        ["trg_cert_counter_identity_guard", "public.cert_counter"],
        ["trg_cert_counter_refuse_truncate", "public.cert_counter"],
        ["trg_nfc_locked_binding_immutable", "public.certificates"],
        ["trg_nfc_lock_intent_guards_binding", "public.certificates"],
        ["trg_object_write_operation_guard", "public.object_write_operations"],
        ["trg_object_write_item_guard", "public.object_write_items"],
      ])
    );
    expect(PAYMENT_FULFILMENT_READINESS_SQL).toMatch(
      /PRIMARY KEY \(submission_id\)[\s\S]+public\.submissions[\s\S]+chk_grading_payment_fulfilment_claim[\s\S]+idx_grading_payment_fulfilments_due/
    );
  });

  it("is ready only when the database returns a completely satisfied contract", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          ready: true,
          missing_relations: [],
          missing_migrations: [],
          missing_triggers: [],
        },
      ],
    }));

    await expect(checkReleaseReadiness({ query })).resolves.toEqual({
      ok: true,
      missingRelations: [],
      missingMigrations: [],
      missingTriggers: [],
      missingConfiguration: [],
      invalidConfiguration: [],
      unavailableRuntime: [],
      queryFailed: false,
    });
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/schema_migrations[\s\S]+pg_trigger/), [
      [...REQUIRED_RELEASE_RELATIONS],
      [...REQUIRED_RELEASE_MIGRATIONS],
      [...REQUIRED_RELEASE_TRIGGERS],
      [...REQUIRED_RELEASE_TRIGGER_RELATIONS],
      false,
    ]);
    expect(query.mock.calls[0][0]).toMatch(/payment_fulfilment_contract[\s\S]+public\.grading_payment_fulfilments/);
  });

  it("fails closed on missing contract members without leaking them into an HTTP response", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          ready: false,
          missing_relations: ["public.cert_counter"],
          missing_migrations: ["0114_certificate_identity_authority.sql"],
          missing_triggers: ["trg_certificate_number_immutable"],
        },
      ],
    }));
    await expect(checkReleaseReadiness({ query })).resolves.toEqual({
      ok: false,
      missingRelations: ["public.cert_counter"],
      missingMigrations: ["0114_certificate_identity_authority.sql"],
      missingTriggers: ["trg_certificate_number_immutable"],
      missingConfiguration: [],
      invalidConfiguration: [],
      unavailableRuntime: [],
      queryFailed: false,
    });
  });

  it("fails closed when the query throws or returns no row", async () => {
    const rejection = checkReleaseReadiness({
      query: vi.fn(async () => Promise.reject(new Error("secret db detail"))),
    });
    await expect(rejection).resolves.toMatchObject({ ok: false, queryFailed: true });
    await expect(checkReleaseReadiness({ query: vi.fn(async () => ({ rows: [] })) })).resolves.toMatchObject({
      ok: false,
      queryFailed: true,
    });
  });

  const completeProductionEnvironment = (): Record<string, string> => ({
    NODE_ENV: "production",
    STRIPE_ENV: "test",
    STRIPE_SECRET_KEY: "sk_test_synthetic-readiness-only",
    STRIPE_PUBLISHABLE_KEY: "pk_test_synthetic-readiness-only",
    STRIPE_WEBHOOK_SECRET: "whsec_synthetic-readiness-only",
    SESSION_SECRET: "synthetic-session-secret",
    SIGNED_URL_SECRET: "synthetic-signed-url-secret",
    APP_URL: "https://mintvault.invalid.test",
    R2_ENDPOINT: "https://r2.invalid.test",
    R2_ACCESS_KEY_ID: "synthetic-r2-key-id",
    R2_SECRET_ACCESS_KEY: "synthetic-r2-secret",
    R2_BUCKET_NAME: "synthetic-r2-bucket",
    B2_ENDPOINT: "https://b2.invalid.test",
    B2_KEY_ID: "synthetic-b2-key-id",
    B2_APPLICATION_KEY: "synthetic-b2-secret",
    B2_BUCKET: "synthetic-b2-bucket",
    RESEND_API_KEY: "re_synthetic-readiness-only",
    RESEND_DOMAIN_VERIFIED: "true",
    CUSTOMER_NOTIFICATION_ENC_KEY_VERSION: "1",
    CUSTOMER_NOTIFICATION_ENC_KEY_V1: "0000000000000000000000000000000000000000000000000000000000000000",
    MINTVAULT_DATABASE_URL: "postgres://runtime:synthetic@db.invalid/mintvault",
    PARTNER_ADMIN_DATABASE_URL: "postgres://partner-admin:synthetic@db.invalid/mintvault",
  });

  it("requires complete, coherent customer-provider configuration in production", () => {
    const env = completeProductionEnvironment();
    expect(checkReleaseConfiguration(env)).toEqual({ ok: true, required: true, missing: [], invalid: [] });

    env.STRIPE_SECRET_KEY = "sk_live_synthetic-readiness-only";
    env.APP_URL = "http://mintvault.invalid.test";
    env.RESEND_DOMAIN_VERIFIED = "false";
    expect(checkReleaseConfiguration(env)).toEqual({
      ok: false,
      required: true,
      missing: [],
      invalid: expect.arrayContaining([
        "STRIPE_SECRET_KEY",
        "STRIPE_PUBLISHABLE_KEY",
        "APP_URL",
        "RESEND_DOMAIN_VERIFIED",
      ]),
    });
  });

  it("reports names only, conditionally validates Partner MFA, and permits partial local/test providers", () => {
    const missing = checkReleaseConfiguration({ NODE_ENV: "production", PARTNER_DATABASE_URL: "postgres://secret" });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(
      expect.arrayContaining([...REQUIRED_PRODUCTION_ENVIRONMENT, "PARTNER_MFA_ENC_KEY", "PARTNER_ADMIN_DATABASE_URL"])
    );
    expect(JSON.stringify(missing)).not.toContain("postgres://secret");

    const invalidPartner = completeProductionEnvironment();
    invalidPartner.PARTNER_DATABASE_URL = "postgres://synthetic";
    invalidPartner.PARTNER_MFA_ENC_KEY = "not-a-key";
    expect(checkReleaseConfiguration(invalidPartner).invalid).toContain("PARTNER_MFA_ENC_KEY");

    expect(checkReleaseConfiguration({ NODE_ENV: "test" })).toEqual({
      ok: true,
      required: false,
      missing: [],
      invalid: [],
    });
  });

  it("combines database and configuration state without exposing configuration values", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ready: true, missing_relations: [], missing_migrations: [], missing_triggers: [] }],
    }));
    const env = completeProductionEnvironment();
    delete env.B2_APPLICATION_KEY;

    await expect(
      checkReleaseReadiness({ query }, env, {
        partnerSharedRateLimitStoreInstalled: () => true,
        objectWriteRuntimeInstalled: () => true,
        partnerAdminAuthorityReady: async () => true,
      })
    ).resolves.toMatchObject({
      ok: false,
      queryFailed: false,
      missingConfiguration: ["B2_APPLICATION_KEY"],
      invalidConfiguration: [],
      unavailableRuntime: [],
    });
  });

  it("rejects migration authority in the web process and enforces a distinct explicit Partner admin identity", () => {
    const leakedMigrationAuthority = completeProductionEnvironment();
    leakedMigrationAuthority.MINTVAULT_MIGRATION_DATABASE_URL = "postgres://owner:secret@db.invalid/mintvault";
    expect(checkReleaseConfiguration(leakedMigrationAuthority).invalid).toContain("MINTVAULT_MIGRATION_DATABASE_URL");

    const partner = completeProductionEnvironment();
    partner.MINTVAULT_DATABASE_URL = "postgres://runtime:synthetic@db.invalid/mintvault";
    partner.PARTNER_DATABASE_URL = "postgres://partner-runtime:synthetic@db.invalid/mintvault";
    partner.PARTNER_MFA_ENC_KEY = "0000000000000000000000000000000000000000000000000000000000000000";
    delete partner.PARTNER_ADMIN_DATABASE_URL;
    expect(checkReleaseConfiguration(partner).missing).toContain("PARTNER_ADMIN_DATABASE_URL");
    partner.PARTNER_ADMIN_DATABASE_URL = "postgres://runtime:different@db.invalid/mintvault";
    expect(checkReleaseConfiguration(partner).invalid).toContain("PARTNER_ADMIN_DATABASE_URL");
    partner.PARTNER_ADMIN_DATABASE_URL = "postgres://partner-admin:synthetic@db.invalid/mintvault";
    expect(checkReleaseConfiguration(partner)).toEqual({ ok: true, required: true, missing: [], invalid: [] });
  });

  it("surfaces main and Partner database authority failures as stable readiness names", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          ready: false,
          runtime_authority_ready: false,
          missing_relations: [],
          missing_migrations: [],
          missing_triggers: [],
        },
      ],
    }));
    const env = completeProductionEnvironment();
    env.MINTVAULT_DATABASE_URL = "postgres://runtime:synthetic@db.invalid/mintvault";
    env.PARTNER_DATABASE_URL = "postgres://partner-runtime:synthetic@db.invalid/mintvault";
    env.PARTNER_ADMIN_DATABASE_URL = "postgres://partner-admin:synthetic@db.invalid/mintvault";
    env.PARTNER_MFA_ENC_KEY = "0000000000000000000000000000000000000000000000000000000000000000";
    await expect(
      checkReleaseReadiness({ query }, env, {
        partnerSharedRateLimitStoreInstalled: () => true,
        objectWriteRuntimeInstalled: () => true,
        partnerAdminAuthorityReady: async () => false,
      })
    ).resolves.toMatchObject({
      ok: false,
      unavailableRuntime: ["main_database_runtime_authority", "partner_admin_database_authority"],
    });
  });

  it("requires Partner admin authority even when the Partner Portal runtime is not configured", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          ready: true,
          runtime_authority_ready: true,
          missing_relations: [],
          missing_migrations: [],
          missing_triggers: [],
        },
      ],
    }));
    const env = completeProductionEnvironment();
    expect(env.PARTNER_DATABASE_URL).toBeUndefined();
    await expect(
      checkReleaseReadiness({ query }, env, {
        partnerSharedRateLimitStoreInstalled: () => true,
        objectWriteRuntimeInstalled: () => true,
        partnerAdminAuthorityReady: async () => false,
      })
    ).resolves.toMatchObject({
      ok: false,
      unavailableRuntime: ["partner_admin_database_authority"],
    });
  });

  it("keeps production unready until the shared Partner limiter is installed", async () => {
    expect(
      checkReleaseRuntime(completeProductionEnvironment(), {
        partnerSharedRateLimitStoreInstalled: () => false,
        objectWriteRuntimeInstalled: () => true,
      })
    ).toEqual({ ok: false, unavailable: ["partner_shared_rate_limit_store"] });
    expect(
      checkReleaseRuntime(completeProductionEnvironment(), {
        partnerSharedRateLimitStoreInstalled: () => true,
        objectWriteRuntimeInstalled: () => true,
      })
    ).toEqual({ ok: true, unavailable: [] });
    expect(
      checkReleaseRuntime(completeProductionEnvironment(), {
        partnerSharedRateLimitStoreInstalled: () => true,
        objectWriteRuntimeInstalled: () => false,
      })
    ).toEqual({ ok: false, unavailable: ["object_write_reconciliation_runtime"] });
    expect(checkReleaseRuntime({ NODE_ENV: "test" }, { partnerSharedRateLimitStoreInstalled: () => false })).toEqual({
      ok: true,
      unavailable: [],
    });

    const query = vi.fn(async () => ({
      rows: [{ ready: true, missing_relations: [], missing_migrations: [], missing_triggers: [] }],
    }));
    await expect(
      checkReleaseReadiness({ query }, completeProductionEnvironment(), {
        partnerSharedRateLimitStoreInstalled: () => false,
        objectWriteRuntimeInstalled: () => true,
        partnerAdminAuthorityReady: async () => true,
      })
    ).resolves.toMatchObject({
      ok: false,
      queryFailed: false,
      unavailableRuntime: ["partner_shared_rate_limit_store"],
    });
  });
});
