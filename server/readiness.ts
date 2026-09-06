/**
 * Release readiness contract.
 *
 * Liveness answers only "is this process running?". Readiness answers whether
 * this build can safely receive customer traffic. The database half checks the
 * migration journal plus critical relations and ALWAYS triggers. The process
 * half combines a pure environment-shape check with process-local installation
 * signals. It never contacts a provider and returns stable names only, never
 * configuration values.
 */
import { partnerSharedRateLimitStoreInstalled } from "./partner/rate-limit";
import { getPartnerAdminCapability } from "./partner/admin-capability";
import { partnerOperationalReadAuthorityReady } from "./partner/operational-authority";
import { objectWriteRuntimeInstalled } from "./lib/object-write-runtime-state";
import { COMPONENT_READINESS_REGISTRY } from "./lib/component-readiness-registry";
import { checkVqRuntimeReadiness } from "./lib/vq-schema-contract";
export { checkVqRuntimeReadiness } from "./lib/vq-schema-contract";

export const REQUIRED_RELEASE_MIGRATIONS = COMPONENT_READINESS_REGISTRY.requiredMigrations;
export const REQUIRED_RELEASE_RELATIONS = COMPONENT_READINESS_REGISTRY.requiredRelations;
export const REQUIRED_RELEASE_TRIGGERS = COMPONENT_READINESS_REGISTRY.requiredTriggers;

/** PostgreSQL permits the same trigger name on different relations. */
export const REQUIRED_RELEASE_TRIGGER_RELATIONS = COMPONENT_READINESS_REGISTRY.requiredTriggerRelations;

export const REQUIRED_PRODUCTION_ENVIRONMENT = COMPONENT_READINESS_REGISTRY.requiredEnvironment;

export type ReadinessEnvironment = Readonly<Record<string, string | undefined>>;

export interface ConfigurationReadiness {
  ok: boolean;
  required: boolean;
  missing: string[];
  invalid: string[];
}

export interface RuntimeReadiness {
  ok: boolean;
  unavailable: string[];
}

export interface ReadinessRuntimeProbes {
  partnerSharedRateLimitStoreInstalled: () => boolean;
  objectWriteRuntimeInstalled?: () => boolean;
  partnerAdminAuthorityReady?: () => Promise<boolean>;
}

const DEFAULT_RUNTIME_PROBES: ReadinessRuntimeProbes = {
  partnerSharedRateLimitStoreInstalled,
  objectWriteRuntimeInstalled,
  partnerAdminAuthorityReady: async () =>
    (await getPartnerAdminCapability()).ok && (await partnerOperationalReadAuthorityReady()),
};

function configured(env: ReadinessEnvironment, name: string): string | null {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function validHttpsUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function stripeMode(value: string | null, keyKind: "sk" | "pk"): "live" | "test" | null {
  const match = value?.match(new RegExp(`^${keyKind}_(live|test)_.+`));
  return match ? (match[1] as "live" | "test") : null;
}

function validPartnerMfaKey(value: string | null): boolean {
  if (!value) return false;
  if (/^[0-9a-f]{64}$/i.test(value)) return true;
  // Buffer.from(base64) is deliberately permissive, so require canonical base64
  // shape before checking the decoded 32-byte AES-256 key length.
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

/**
 * Validate only the configuration needed to admit customer traffic.
 * Development and test processes retain their supported partial-provider mode;
 * NODE_ENV=production is intentionally fail closed.
 */
export function checkReleaseConfiguration(env: ReadinessEnvironment = process.env): ConfigurationReadiness {
  if ((env.NODE_ENV ?? "").trim().toLowerCase() !== "production") {
    return { ok: true, required: false, missing: [], invalid: [] };
  }

  const missing: string[] = REQUIRED_PRODUCTION_ENVIRONMENT.filter((name) => !configured(env, name));
  const notificationKeyVersion = configured(env, "CUSTOMER_NOTIFICATION_ENC_KEY_VERSION");
  if (/^[1-9][0-9]*$/.test(notificationKeyVersion ?? "")) {
    const keyName = `CUSTOMER_NOTIFICATION_ENC_KEY_V${notificationKeyVersion}`;
    if (!configured(env, keyName)) missing.push(keyName);
  }
  if (configured(env, "PARTNER_DATABASE_URL") && !configured(env, "PARTNER_MFA_ENC_KEY")) {
    missing.push("PARTNER_MFA_ENC_KEY");
  }
  const invalid: string[] = [];
  const addInvalid = (...names: string[]) => {
    for (const name of names) if (!invalid.includes(name) && !missing.includes(name)) invalid.push(name);
  };

  const declaredStripeMode = configured(env, "STRIPE_ENV");
  if (declaredStripeMode && declaredStripeMode !== "live" && declaredStripeMode !== "test") {
    addInvalid("STRIPE_ENV");
  }

  const secretMode = stripeMode(configured(env, "STRIPE_SECRET_KEY"), "sk");
  const publishableMode = stripeMode(configured(env, "STRIPE_PUBLISHABLE_KEY"), "pk");
  if (configured(env, "STRIPE_SECRET_KEY") && !secretMode) addInvalid("STRIPE_SECRET_KEY");
  if (configured(env, "STRIPE_PUBLISHABLE_KEY") && !publishableMode) addInvalid("STRIPE_PUBLISHABLE_KEY");
  if (secretMode && publishableMode && secretMode !== publishableMode) {
    addInvalid("STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY");
  }
  if (declaredStripeMode === "live" || declaredStripeMode === "test") {
    if (secretMode && secretMode !== declaredStripeMode) addInvalid("STRIPE_SECRET_KEY");
    if (publishableMode && publishableMode !== declaredStripeMode) addInvalid("STRIPE_PUBLISHABLE_KEY");
  }
  const webhookSecret = configured(env, "STRIPE_WEBHOOK_SECRET");
  if (webhookSecret && !/^whsec_.+/.test(webhookSecret)) addInvalid("STRIPE_WEBHOOK_SECRET");

  for (const name of ["APP_URL", "R2_ENDPOINT", "B2_ENDPOINT"] as const) {
    const value = configured(env, name);
    if (value && !validHttpsUrl(value)) addInvalid(name);
  }
  if (configured(env, "RESEND_DOMAIN_VERIFIED") !== "true") addInvalid("RESEND_DOMAIN_VERIFIED");
  if (notificationKeyVersion && !/^[1-9][0-9]*$/.test(notificationKeyVersion)) {
    addInvalid("CUSTOMER_NOTIFICATION_ENC_KEY_VERSION");
  } else if (notificationKeyVersion) {
    const keyName = `CUSTOMER_NOTIFICATION_ENC_KEY_V${notificationKeyVersion}`;
    const keyValue = configured(env, keyName);
    if (keyValue && !validPartnerMfaKey(keyValue)) addInvalid(keyName);
  }

  const partnerDatabaseUrl = configured(env, "PARTNER_DATABASE_URL");
  const partnerMfaKey = configured(env, "PARTNER_MFA_ENC_KEY");
  if (partnerDatabaseUrl && partnerMfaKey && !validPartnerMfaKey(partnerMfaKey)) {
    addInvalid("PARTNER_MFA_ENC_KEY");
  }
  if (configured(env, "MINTVAULT_MIGRATION_DATABASE_URL")) {
    addInvalid("MINTVAULT_MIGRATION_DATABASE_URL");
  }
  const mainDatabaseUrl = configured(env, "MINTVAULT_DATABASE_URL");
  const partnerAdminDatabaseUrl = configured(env, "PARTNER_ADMIN_DATABASE_URL");
  if (mainDatabaseUrl && partnerAdminDatabaseUrl) {
    try {
      const main = new URL(mainDatabaseUrl);
      const partnerAdmin = new URL(partnerAdminDatabaseUrl);
      if (!main.username || !partnerAdmin.username || main.username === partnerAdmin.username) {
        addInvalid("PARTNER_ADMIN_DATABASE_URL");
      }
    } catch {
      addInvalid("PARTNER_ADMIN_DATABASE_URL");
    }
  }

  return { ok: missing.length === 0 && invalid.length === 0, required: true, missing, invalid };
}

/**
 * Process-local dependencies that cannot be inferred from database shape.
 * Names are stable operator diagnostics; no configuration or provider value is
 * returned. Memory/test stores deliberately cannot satisfy this contract.
 */
export function checkReleaseRuntime(
  env: ReadinessEnvironment = process.env,
  probes: ReadinessRuntimeProbes = DEFAULT_RUNTIME_PROBES
): RuntimeReadiness {
  if ((env.NODE_ENV ?? "").trim().toLowerCase() !== "production") {
    return { ok: true, unavailable: [] };
  }
  const unavailable = probes.partnerSharedRateLimitStoreInstalled()
    ? []
    : [COMPONENT_READINESS_REGISTRY.runtimeSignals.partner_shared_rate_limit_store];
  if (probes.objectWriteRuntimeInstalled?.() !== true) {
    unavailable.push(COMPONENT_READINESS_REGISTRY.runtimeSignals.object_write_reconciliation_runtime);
  }
  return { ok: unavailable.length === 0, unavailable };
}

export interface ReadinessQueryable {
  query: (
    text: string,
    params?: readonly unknown[]
  ) => Promise<{
    rows: Array<{
      ready: boolean;
      missing_relations: string[];
      missing_migrations: string[];
      missing_triggers: string[];
      runtime_authority_ready?: boolean;
    }>;
  }>;
}

const SESSION_STORE_CONTRACT_PREDICATE = `
  EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'session'
     HAVING COUNT(*) = 3
        AND COUNT(*) FILTER (
          WHERE is_nullable = 'NO'
            AND (
              (column_name = 'sid' AND data_type = 'character varying')
              OR (column_name = 'sess' AND data_type = 'json')
              OR (
                column_name = 'expire'
                AND data_type = 'timestamp without time zone'
                AND datetime_precision = 6
              )
            )
        ) = 3
  )
  AND EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.session')
       AND c.contype = 'p'
       AND c.convalidated
       AND c.conkey = ARRAY[(
         SELECT a.attnum
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass('public.session')
            AND a.attname = 'sid'
            AND NOT a.attisdropped
       )]::smallint[]
  )
  AND EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_attribute a
        ON a.attrelid = i.indrelid
       AND a.attname = 'expire'
       AND NOT a.attisdropped
     WHERE i.indrelid = to_regclass('public.session')
       AND idx.relname = 'IDX_session_expire'
       AND i.indisvalid
       AND i.indisready
       AND i.indpred IS NULL
       AND i.indexprs IS NULL
       AND i.indnatts = 1
       AND i.indnkeyatts = 1
       AND a.attnum = ANY(i.indkey)
  )`;

/** Exported solely so the disposable migration proof executes the exact predicate readiness uses. */
export const SESSION_STORE_READINESS_SQL = `SELECT (${SESSION_STORE_CONTRACT_PREDICATE}) AS ready`;

const PAYMENT_FULFILMENT_CONTRACT_PREDICATE = `
  to_regclass('public.grading_payment_fulfilments') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('submission_id','integer',true), ('tracking_number','text',true),
        ('payment_intent_id','text',true), ('payment_metadata','jsonb',true),
        ('amount_pence','integer',true), ('currency','character varying(3)',true),
        ('paid_at','timestamp with time zone',true), ('confirmation_payload','jsonb',true),
        ('provider_idempotency_key','text',true), ('status','text',true),
        ('attempt_count','integer',true), ('next_attempt_at','timestamp with time zone',true),
        ('claim_token','text',false), ('claim_expires_at','timestamp with time zone',false),
        ('last_error','text',false), ('estimate_completed_at','timestamp with time zone',false),
        ('credit_completed_at','timestamp with time zone',false),
        ('promo_completed_at','timestamp with time zone',false),
        ('user_link_completed_at','timestamp with time zone',false),
        ('email_completed_at','timestamp with time zone',false),
        ('provider_message_id','text',false), ('completed_at','timestamp with time zone',false),
        ('created_at','timestamp with time zone',true), ('updated_at','timestamp with time zone',true)
      ) AS required(name, expected_type, required_not_null)
      LEFT JOIN pg_attribute a
        ON a.attrelid = to_regclass('public.grading_payment_fulfilments')
       AND a.attname = required.name
       AND a.attnum > 0
       AND NOT a.attisdropped
     WHERE format_type(a.atttypid, a.atttypmod) IS DISTINCT FROM required.expected_type
        OR (required.required_not_null AND a.attnotnull IS DISTINCT FROM true)
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.grading_payment_fulfilments')
       AND c.contype = 'p' AND c.convalidated
       AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (submission_id)'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.grading_payment_fulfilments')
       AND c.contype = 'u' AND c.convalidated
       AND pg_get_constraintdef(c.oid) = 'UNIQUE (payment_intent_id)'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.grading_payment_fulfilments')
       AND c.contype = 'u' AND c.convalidated
       AND pg_get_constraintdef(c.oid) = 'UNIQUE (provider_idempotency_key)'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.grading_payment_fulfilments')
       AND c.contype = 'f' AND c.convalidated
       AND c.confrelid = to_regclass('public.submissions')
       AND c.confdeltype = 'r'
       AND position('FOREIGN KEY (submission_id)' IN pg_get_constraintdef(c.oid)) > 0
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.grading_payment_fulfilments')
       AND c.conname = 'chk_grading_payment_fulfilment_claim'
       AND c.contype = 'c' AND c.convalidated
       AND position('PROCESSING' IN pg_get_constraintdef(c.oid)) > 0
       AND position('claim_token IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
       AND position('claim_expires_at IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = to_regclass('public.grading_payment_fulfilments')
       AND c.conname = 'chk_grading_payment_fulfilment_complete'
       AND c.contype = 'c' AND c.convalidated
       AND position('COMPLETE' IN pg_get_constraintdef(c.oid)) > 0
       AND position('email_completed_at IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
       AND position('completed_at IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
  )
  AND EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = to_regclass('public.idx_grading_payment_fulfilments_due')
       AND i.indrelid = to_regclass('public.grading_payment_fulfilments')
       AND i.indisvalid AND i.indisready
       AND i.indnkeyatts = 2 AND i.indnatts = 2 AND i.indexprs IS NULL
       AND pg_get_indexdef(i.indexrelid, 1, true) = 'next_attempt_at'
       AND pg_get_indexdef(i.indexrelid, 2, true) = 'submission_id'
       AND position('status' IN pg_get_indexdef(i.indexrelid)) > 0
       AND position('PENDING' IN pg_get_indexdef(i.indexrelid)) > 0
       AND position('FAILED' IN pg_get_indexdef(i.indexrelid)) > 0
       AND position('PROCESSING' IN pg_get_indexdef(i.indexrelid)) > 0
  )`;

/** Exported solely so the real-PostgreSQL payment proof executes the readiness predicate verbatim. */
export const PAYMENT_FULFILMENT_READINESS_SQL = `SELECT (${PAYMENT_FULFILMENT_CONTRACT_PREDICATE}) AS ready`;

const CUSTOMER_NOTIFICATION_CONTRACT_PREDICATE = `
  to_regclass('public.customer_notification_outbox') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('id','bigint',true), ('event_key','text',true), ('kind','text',true),
      ('aggregate_type','text',true), ('aggregate_id','text',true),
      ('template_version','integer',true), ('encrypted_payload','text',true),
      ('encryption_key_version','integer',true), ('payload_fingerprint','text',true),
      ('provider_idempotency_key','text',true), ('status','text',true),
      ('attempt_count','integer',true), ('next_attempt_at','timestamp with time zone',false),
      ('claim_token','text',false), ('claim_expires_at','timestamp with time zone',false),
      ('uncertain_delivery_at','timestamp with time zone',false),
      ('provider_message_id','text',false), ('delivered_at','timestamp with time zone',false),
      ('created_at','timestamp with time zone',true), ('updated_at','timestamp with time zone',true)
    ) AS required(name, expected_type, required_not_null)
    LEFT JOIN pg_attribute a
      ON a.attrelid=to_regclass('public.customer_notification_outbox')
     AND a.attname=required.name AND a.attnum > 0 AND NOT a.attisdropped
    WHERE format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM required.expected_type
       OR (required.required_not_null AND a.attnotnull IS DISTINCT FROM true)
  )
  AND EXISTS (SELECT 1 FROM pg_constraint c
    WHERE c.conrelid=to_regclass('public.customer_notification_outbox') AND c.contype='p'
      AND c.convalidated AND pg_get_constraintdef(c.oid)='PRIMARY KEY (id)')
  AND EXISTS (SELECT 1 FROM pg_constraint c
    WHERE c.conrelid=to_regclass('public.customer_notification_outbox') AND c.contype='u'
      AND c.convalidated AND pg_get_constraintdef(c.oid)='UNIQUE (event_key)')
  AND EXISTS (SELECT 1 FROM pg_constraint c
    WHERE c.conrelid=to_regclass('public.customer_notification_outbox') AND c.contype='u'
      AND c.convalidated AND pg_get_constraintdef(c.oid)='UNIQUE (provider_idempotency_key)')
  AND EXISTS (SELECT 1 FROM pg_constraint c
    WHERE c.conrelid=to_regclass('public.customer_notification_outbox') AND c.contype='c'
      AND c.convalidated AND position('RECONCILIATION_REQUIRED' IN pg_get_constraintdef(c.oid)) > 0)
  AND EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid=to_regclass('public.idx_customer_notification_outbox_due')
      AND i.indrelid=to_regclass('public.customer_notification_outbox')
      AND i.indisvalid AND i.indisready AND i.indnkeyatts=2 AND i.indnatts=2
      AND pg_get_indexdef(i.indexrelid,1,true)='next_attempt_at'
      AND pg_get_indexdef(i.indexrelid,2,true)='id'
      AND position('PROCESSING' IN pg_get_indexdef(i.indexrelid)) > 0
  )`;

export const CUSTOMER_NOTIFICATION_READINESS_SQL = `SELECT (${CUSTOMER_NOTIFICATION_CONTRACT_PREDICATE}) AS ready`;

const OBJECT_WRITE_CONTRACT_PREDICATE = `
  to_regclass('public.object_write_operations') IS NOT NULL
  AND to_regclass('public.object_write_items') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('object_write_operations','id','uuid',true),
      ('object_write_operations','tenant_id','uuid',false),
      ('object_write_operations','idempotency_key','text',true),
      ('object_write_operations','state','text',true),
      ('object_write_operations','manifest_sha256','character(64)',true),
      ('object_write_operations','intent_payload','jsonb',true),
      ('object_write_operations','result_payload','jsonb',false),
      ('object_write_operations','lease_token','uuid',false),
      ('object_write_items','operation_id','uuid',true),
      ('object_write_items','object_key','text',true),
      ('object_write_items','content_sha256','character(64)',true),
      ('object_write_items','byte_length','bigint',true),
      ('object_write_items','retention_days','integer',false),
      ('object_write_items','minimum_retain_until','timestamp with time zone',false),
      ('object_write_items','missing_observed_at','timestamp with time zone',false),
      ('object_write_items','observed_version_id','text',false),
      ('object_write_items','verification_state','text',true),
      ('object_write_items','write_disposition','text',true),
      ('object_write_items','cleanup_state','text',true),
      ('certificates','object_write_operation_id','uuid',false)
    ) AS required(relation_name,column_name,expected_type,required_not_null)
    LEFT JOIN pg_attribute a
      ON a.attrelid=to_regclass('public.' || required.relation_name)
     AND a.attname=required.column_name AND a.attnum > 0 AND NOT a.attisdropped
    WHERE format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM required.expected_type
       OR (required.required_not_null AND a.attnotnull IS DISTINCT FROM true)
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid=to_regclass('public.object_write_items')
       AND c.contype='f' AND c.convalidated
       AND c.confrelid=to_regclass('public.object_write_operations')
       AND c.confdeltype='r'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid=to_regclass('public.certificates')
       AND c.conname='fk_certificates_object_write_operation'
       AND c.contype='f' AND c.convalidated
       AND c.confrelid=to_regclass('public.object_write_operations')
       AND c.confdeltype='r'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid=to_regclass('public.uq_certificates_object_write_operation')
       AND i.indrelid=to_regclass('public.certificates')
       AND i.indisvalid AND i.indisready AND i.indisunique
       AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indexprs IS NULL
       AND pg_get_indexdef(i.indexrelid,1,true)='object_write_operation_id'
       AND position('object_write_operation_id IS NOT NULL' IN pg_get_indexdef(i.indexrelid)) > 0
  )
  AND EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid=to_regclass('public.uq_object_write_operation_idempotency')
       AND i.indrelid=to_regclass('public.object_write_operations')
       AND i.indisvalid AND i.indisready AND i.indisunique
       AND i.indnkeyatts=2 AND i.indnatts=2
       AND pg_get_indexdef(i.indexrelid,1,true)=
           'COALESCE(tenant_id, ''00000000-0000-0000-0000-000000000000''::uuid)'
       AND pg_get_indexdef(i.indexrelid,2,true)='idempotency_key'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid=to_regclass('public.idx_object_write_operation_due')
       AND i.indrelid=to_regclass('public.object_write_operations')
       AND i.indisvalid AND i.indisready
       AND position('PREPARED' IN pg_get_indexdef(i.indexrelid)) > 0
       AND position('UPLOADING' IN pg_get_indexdef(i.indexrelid)) > 0
       AND position('VERIFIED' IN pg_get_indexdef(i.indexrelid)) > 0
       AND position('RECONCILIATION_REQUIRED' IN pg_get_indexdef(i.indexrelid)) > 0
  )
  AND EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid=to_regclass('public.uq_object_write_items_store_key')
       AND i.indrelid=to_regclass('public.object_write_items')
       AND i.indisvalid AND i.indisready AND i.indisunique
       AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL
       AND pg_get_indexdef(i.indexrelid,1,true)='store'
       AND pg_get_indexdef(i.indexrelid,2,true)='object_key'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid=to_regclass('public.object_write_items')
       AND c.conname='chk_object_write_item_verified'
       AND c.contype='c' AND c.convalidated
       AND position('observed_sha256 = content_sha256' IN pg_get_constraintdef(c.oid)) > 0
       AND position('observed_byte_length = byte_length' IN pg_get_constraintdef(c.oid)) > 0
       AND position('observed_version_id IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
       AND position('verified_at IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
  )
  AND EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid=to_regclass('public.object_write_operations')
       AND c.relrowsecurity AND c.relforcerowsecurity
  )
  AND EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid=to_regclass('public.object_write_items')
       AND c.relrowsecurity AND c.relforcerowsecurity
  )
  AND EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='object_write_operations'
          AND policyname='object_write_operations_main' AND permissive='PERMISSIVE'
          AND cmd='ALL' AND roles=ARRAY['mintvault_app'::name]
          AND qual='true' AND with_check='true')
  AND EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='object_write_operations'
          AND policyname='object_write_operations_partner' AND permissive='PERMISSIVE'
          AND cmd='ALL' AND roles=ARRAY['partner_runtime'::name]
          AND position('tenant_id' IN qual) > 0
          AND position('partner_current_tenant()' IN qual) > 0
          AND position('tenant_id' IN with_check) > 0
          AND position('partner_current_tenant()' IN with_check) > 0)
  AND EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='object_write_items'
          AND policyname='object_write_items_main' AND permissive='PERMISSIVE'
          AND cmd='ALL' AND roles=ARRAY['mintvault_app'::name]
          AND qual='true' AND with_check='true')
  AND EXISTS (SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename='object_write_items'
          AND policyname='object_write_items_partner' AND permissive='PERMISSIVE'
          AND cmd='ALL' AND roles=ARRAY['partner_runtime'::name]
          AND position('object_write_operations' IN qual) > 0
          AND position('operation_id' IN qual) > 0
          AND position('object_write_operations' IN with_check) > 0
          AND position('operation_id' IN with_check) > 0)
  AND has_table_privilege('mintvault_app','public.object_write_operations','SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('mintvault_app','public.object_write_operations','DELETE')
  AND has_table_privilege('partner_runtime','public.object_write_operations','SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('partner_runtime','public.object_write_operations','DELETE')
  AND has_table_privilege('mintvault_app','public.object_write_items','SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('mintvault_app','public.object_write_items','DELETE')
  AND has_table_privilege('partner_runtime','public.object_write_items','SELECT,INSERT,UPDATE')
  AND NOT has_table_privilege('partner_runtime','public.object_write_items','DELETE')
  AND EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid=to_regclass('public.submissions')
       AND a.attname='on_receipt_photo_objects'
       AND a.atttypid='jsonb'::regtype
       AND a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped
  )
  AND EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid=to_regclass('public.submissions')
       AND a.attname='on_receipt_photo_revision'
       AND a.atttypid='bigint'::regtype
       AND a.attnotnull AND a.attnum > 0 AND NOT a.attisdropped
  )`;

export const OBJECT_WRITE_READINESS_SQL = `SELECT (${OBJECT_WRITE_CONTRACT_PREDICATE}) AS ready`;

const PRINT_WORKFLOW_CONTRACT_PREDICATE = `
  to_regclass('public.certificates') IS NOT NULL
  AND to_regclass('public.print_batches') IS NOT NULL
  AND to_regclass('public.print_events') IS NOT NULL
  AND to_regclass('public.label_prints') IS NOT NULL
  AND to_regclass('public.label_overrides') IS NOT NULL
  AND to_regclass('public.reprint_log') IS NOT NULL
  AND to_regclass('public.audit_log') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('certificates','certificate_number','text',true),
      ('certificates','print_state','character varying(24)',true),
      ('certificates','grade_type','text',true),
      ('certificates','grade','numeric(4,1)',false),
      ('certificates','grade_approved_at','timestamp without time zone|timestamp with time zone',false),
      ('certificates','grader_status','character varying(20)',true),
      ('certificates','status','character varying(10)',true),
      ('certificates','deleted_at','timestamp without time zone|timestamp with time zone',false),
      ('certificates','ownership_status','character varying(20)',true),
      ('certificates','updated_at','timestamp without time zone|timestamp with time zone',false),
      ('certificates','claim_code','text',false),
      ('print_batches','id','integer',true),
      ('print_batches','batch_id','text',true),
      ('print_batches','kind','character varying(12)',true),
      ('print_batches','status','character varying(12)',true),
      ('print_batches','cert_ids','jsonb',true),
      ('print_batches','cert_count','integer',true),
      ('print_batches','success_count','integer',true),
      ('print_batches','failure_count','integer',true),
      ('print_batches','created_by','text',false),
      ('print_batches','created_by_role','character varying(16)',false),
      ('print_batches','created_at','timestamp without time zone',true),
      ('print_batches','printed_at','timestamp without time zone',false),
      ('print_batches','notes','text',false),
      ('print_batches','reason','text',false),
      ('print_batches','reason_category','character varying(24)',false),
      ('print_batches','layout_version','text',false),
      ('print_events','id','integer',true),
      ('print_events','cert_id','text',true),
      ('print_events','batch_id','text',false),
      ('print_events','actor','text',true),
      ('print_events','actor_role','character varying(16)',false),
      ('print_events','action','character varying(24)',true),
      ('print_events','from_state','character varying(24)',false),
      ('print_events','to_state','character varying(24)',false),
      ('print_events','reason','text',false),
      ('print_events','reason_category','character varying(24)',false),
      ('print_events','created_at','timestamp without time zone',true),
      ('label_prints','id','integer',true),
      ('label_prints','cert_id','text',true),
      ('label_prints','sheet_ref','text',false),
      ('label_prints','queued_at','timestamp without time zone|timestamp with time zone',true),
      ('label_prints','printed_at','timestamp without time zone|timestamp with time zone',false),
      ('label_overrides','id','integer',true),
      ('label_overrides','cert_id','text',true),
      ('label_overrides','card_name_override','text',false),
      ('label_overrides','set_override','text',false),
      ('label_overrides','variant_override','text',false),
      ('label_overrides','language_override','text',false),
      ('label_overrides','year_override','text',false),
      ('label_overrides','edited_at','timestamp without time zone|timestamp with time zone',true),
      ('reprint_log','id','integer',true),
      ('reprint_log','cert_id','text',true),
      ('reprint_log','reprint_time','timestamp without time zone|timestamp with time zone',true),
      ('audit_log','id','integer',true),
      ('audit_log','entity_type','text',true),
      ('audit_log','entity_id','text',true),
      ('audit_log','action','text',true),
      ('audit_log','admin_user','text',false),
      ('audit_log','details','jsonb',false),
      ('audit_log','created_at','timestamp without time zone|timestamp with time zone',true)
    ) AS required(relation_name,column_name,expected_type,required_not_null)
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.' || required.relation_name)
     AND attribute.attname=required.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE format_type(attribute.atttypid,attribute.atttypmod) IS NULL
       OR NOT (format_type(attribute.atttypid,attribute.atttypmod) = ANY(string_to_array(required.expected_type,'|')))
       OR (required.required_not_null AND attribute.attnotnull IS DISTINCT FROM true)
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('certificates','print_state',ARRAY['''awaiting_approval''::character varying']),
      ('print_batches','id',ARRAY[
        'nextval(''print_batches_id_seq''::regclass)',
        'nextval(''public.print_batches_id_seq''::regclass)'
      ]),
      ('print_batches','kind',ARRAY['''batch''::character varying']),
      ('print_batches','status',ARRAY['''open''::character varying']),
      ('print_batches','cert_ids',ARRAY['''[]''::jsonb']),
      ('print_batches','cert_count',ARRAY['0']),
      ('print_batches','success_count',ARRAY['0']),
      ('print_batches','failure_count',ARRAY['0']),
      ('print_batches','created_at',ARRAY['now()']),
      ('print_events','id',ARRAY[
        'nextval(''print_events_id_seq''::regclass)',
        'nextval(''public.print_events_id_seq''::regclass)'
      ]),
      ('print_events','created_at',ARRAY['now()']),
      ('label_prints','id',ARRAY[
        'nextval(''label_prints_id_seq''::regclass)',
        'nextval(''public.label_prints_id_seq''::regclass)'
      ]),
      ('label_prints','queued_at',ARRAY['now()']),
      ('label_overrides','id',ARRAY[
        'nextval(''label_overrides_id_seq''::regclass)',
        'nextval(''public.label_overrides_id_seq''::regclass)'
      ]),
      ('label_overrides','edited_at',ARRAY['now()']),
      ('reprint_log','id',ARRAY[
        'nextval(''reprint_log_id_seq''::regclass)',
        'nextval(''public.reprint_log_id_seq''::regclass)'
      ]),
      ('reprint_log','reprint_time',ARRAY['now()']),
      ('audit_log','id',ARRAY[
        'nextval(''audit_log_id_seq''::regclass)',
        'nextval(''public.audit_log_id_seq''::regclass)'
      ]),
      ('audit_log','created_at',ARRAY['now()'])
    ) AS required(relation_name,column_name,expected_expressions)
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.' || required.relation_name)
     AND attribute.attname=required.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef default_row
      ON default_row.adrelid=attribute.attrelid
     AND default_row.adnum=attribute.attnum
    WHERE pg_get_expr(default_row.adbin,default_row.adrelid) IS NULL
       OR NOT (pg_get_expr(default_row.adbin,default_row.adrelid) = ANY(required.expected_expressions))
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('print_batches'),
      ('print_events'),
      ('label_prints'),
      ('label_overrides'),
      ('reprint_log'),
      ('audit_log')
    ) AS required(relation_name)
    WHERE NOT EXISTS (
      SELECT 1
        FROM pg_attribute attribute
        JOIN pg_constraint constraint_row
          ON constraint_row.conrelid=attribute.attrelid
         AND constraint_row.contype='p'
         AND constraint_row.convalidated
         AND constraint_row.conkey=ARRAY[attribute.attnum]
       WHERE attribute.attrelid=to_regclass('public.' || required.relation_name)
         AND attribute.attname='id'
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('print_batches','print_batches_id_seq'),
      ('print_events','print_events_id_seq'),
      ('label_prints','label_prints_id_seq'),
      ('label_overrides','label_overrides_id_seq'),
      ('reprint_log','reprint_log_id_seq'),
      ('audit_log','audit_log_id_seq')
    ) AS required(relation_name,sequence_name)
    WHERE pg_get_serial_sequence('public.' || required.relation_name,'id')
          IS DISTINCT FROM 'public.' || required.sequence_name
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_row
     WHERE constraint_row.conrelid=to_regclass('public.print_batches')
       AND constraint_row.contype='u'
       AND constraint_row.convalidated
       AND pg_get_constraintdef(constraint_row.oid)='UNIQUE (batch_id)'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_row
     WHERE constraint_row.conrelid=to_regclass('public.label_prints')
       AND constraint_row.contype='u'
       AND constraint_row.convalidated
       AND pg_get_constraintdef(constraint_row.oid)='UNIQUE (cert_id)'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint constraint_row
     WHERE constraint_row.conrelid=to_regclass('public.label_overrides')
       AND constraint_row.contype='u'
       AND constraint_row.convalidated
       AND pg_get_constraintdef(constraint_row.oid)='UNIQUE (cert_id)'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index index_row
     WHERE index_row.indexrelid=to_regclass('public.idx_certificates_print_state')
       AND index_row.indrelid=to_regclass('public.certificates')
       AND index_row.indisvalid AND index_row.indisready
       AND index_row.indpred IS NULL
       AND index_row.indnkeyatts=1 AND index_row.indnatts=1 AND index_row.indexprs IS NULL
       AND pg_get_indexdef(index_row.indexrelid,1,true)='print_state'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index index_row
     WHERE index_row.indexrelid=to_regclass('public.idx_print_events_cert')
       AND index_row.indrelid=to_regclass('public.print_events')
       AND index_row.indisvalid AND index_row.indisready
       AND index_row.indpred IS NULL
       AND index_row.indnkeyatts=1 AND index_row.indnatts=1 AND index_row.indexprs IS NULL
       AND pg_get_indexdef(index_row.indexrelid,1,true)='cert_id'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index index_row
     WHERE index_row.indexrelid=to_regclass('public.idx_print_batches_status')
       AND index_row.indrelid=to_regclass('public.print_batches')
       AND index_row.indisvalid AND index_row.indisready AND index_row.indpred IS NULL
       AND index_row.indnkeyatts=1 AND index_row.indnatts=1 AND index_row.indexprs IS NULL
       AND pg_get_indexdef(index_row.indexrelid,1,true)='status'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index index_row
     WHERE index_row.indexrelid=to_regclass('public.idx_print_batches_created_at')
       AND index_row.indrelid=to_regclass('public.print_batches')
       AND index_row.indisvalid AND index_row.indisready AND index_row.indpred IS NULL
       AND index_row.indnkeyatts=1 AND index_row.indnatts=1 AND index_row.indexprs IS NULL
       AND pg_get_indexdef(index_row.indexrelid,1,true)='created_at'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index index_row
     WHERE index_row.indexrelid=to_regclass('public.idx_print_events_batch')
       AND index_row.indrelid=to_regclass('public.print_events')
       AND index_row.indisvalid AND index_row.indisready AND index_row.indpred IS NULL
       AND index_row.indnkeyatts=1 AND index_row.indnatts=1 AND index_row.indexprs IS NULL
       AND pg_get_indexdef(index_row.indexrelid,1,true)='batch_id'
  )
  AND EXISTS (
    SELECT 1 FROM pg_index index_row
     WHERE index_row.indexrelid=to_regclass('public.idx_print_events_created_at')
       AND index_row.indrelid=to_regclass('public.print_events')
       AND index_row.indisvalid AND index_row.indisready AND index_row.indpred IS NULL
       AND index_row.indnkeyatts=1 AND index_row.indnatts=1 AND index_row.indexprs IS NULL
       AND pg_get_indexdef(index_row.indexrelid,1,true)='created_at'
  )`;

export const PRINT_WORKFLOW_READINESS_SQL = `SELECT (${PRINT_WORKFLOW_CONTRACT_PREDICATE}) AS ready`;

export interface ReleaseReadiness {
  ok: boolean;
  missingRelations: string[];
  missingMigrations: string[];
  missingTriggers: string[];
  missingConfiguration: string[];
  invalidConfiguration: string[];
  unavailableRuntime: string[];
  queryFailed: boolean;
}

/** Exported so disposable PostgreSQL mutation proofs execute the exact release query. */
export const RELEASE_READINESS_SQL = `
WITH required_relations(name) AS (
  SELECT unnest($1::text[])
), required_migrations(filename) AS (
  SELECT unnest($2::text[])
), required_triggers(name, relation_name) AS (
  SELECT * FROM unnest($3::text[], $4::text[])
), session_contract AS (
  SELECT (${SESSION_STORE_CONTRACT_PREDICATE}) AS ready
), payment_fulfilment_contract AS (
  SELECT (${PAYMENT_FULFILMENT_CONTRACT_PREDICATE}) AS ready
), customer_notification_contract AS (
  SELECT (${CUSTOMER_NOTIFICATION_CONTRACT_PREDICATE}) AS ready
), object_write_contract AS (
  SELECT (${OBJECT_WRITE_CONTRACT_PREDICATE}) AS ready
), print_workflow_contract AS (
  SELECT (${PRINT_WORKFLOW_CONTRACT_PREDICATE}) AS ready
), runtime_authority AS (
  SELECT CASE WHEN NOT $5::boolean THEN true ELSE EXISTS (
    SELECT 1
      FROM pg_roles login
      JOIN pg_roles app_role ON app_role.rolname = 'mintvault_app'
     WHERE login.rolname = current_user
       AND login.rolcanlogin
       AND login.rolinherit
       AND NOT login.rolsuper
       AND NOT login.rolbypassrls
       AND NOT login.rolcreatedb
       AND NOT login.rolcreaterole
       AND NOT login.rolreplication
       AND NOT app_role.rolcanlogin
       AND NOT app_role.rolsuper
       AND NOT app_role.rolbypassrls
       AND NOT app_role.rolcreatedb
       AND NOT app_role.rolcreaterole
       AND NOT app_role.rolreplication
       AND pg_has_role(login.rolname, app_role.rolname, 'member')
       AND NOT EXISTS (
         SELECT 1 FROM pg_auth_members other_membership
          WHERE other_membership.member = login.oid
            AND other_membership.roleid <> app_role.oid
       )
       AND NOT EXISTS (
         SELECT 1 FROM pg_auth_members group_membership
          WHERE group_membership.member = app_role.oid
       )
       AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = login.oid)
       AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = login.oid)
       AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = login.oid)
       AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = login.oid)
       AND NOT has_schema_privilege(login.rolname, 'public', 'CREATE')
       AND has_table_privilege(login.rolname, 'public.public_rate_limit_buckets', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.public_rate_limit_buckets', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.public_rate_limit_buckets', 'UPDATE')
       AND has_table_privilege(login.rolname, 'public.public_rate_limit_buckets', 'DELETE')
       AND has_table_privilege(login.rolname, 'public.session', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.session', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.session', 'UPDATE')
       AND has_table_privilege(login.rolname, 'public.session', 'DELETE')
       AND has_table_privilege(login.rolname, 'public.certificates', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.certificates', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.certificates', 'UPDATE')
       AND NOT has_table_privilege(login.rolname, 'public.certificates', 'DELETE')
       AND NOT has_table_privilege(login.rolname, 'public.certificates', 'TRUNCATE')
       AND has_table_privilege(login.rolname, 'public.print_batches', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.print_batches', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.print_batches', 'UPDATE')
       AND NOT has_table_privilege(login.rolname, 'public.print_batches', 'DELETE')
       AND NOT has_table_privilege(login.rolname, 'public.print_batches', 'TRUNCATE')
       AND has_table_privilege(login.rolname, 'public.label_prints', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.label_prints', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.label_prints', 'UPDATE')
       AND NOT has_table_privilege(login.rolname, 'public.label_prints', 'DELETE')
       AND NOT has_table_privilege(login.rolname, 'public.label_prints', 'TRUNCATE')
       AND has_table_privilege(login.rolname, 'public.label_overrides', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.label_overrides', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.label_overrides', 'UPDATE')
       AND has_table_privilege(login.rolname, 'public.label_overrides', 'DELETE')
       AND NOT has_table_privilege(login.rolname, 'public.label_overrides', 'TRUNCATE')
       AND has_table_privilege(login.rolname, 'public.reprint_log', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.reprint_log', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.reprint_log', 'UPDATE')
       AND NOT has_table_privilege(login.rolname, 'public.reprint_log', 'DELETE')
       AND NOT has_table_privilege(login.rolname, 'public.reprint_log', 'TRUNCATE')
       AND has_table_privilege(login.rolname, 'public.print_events', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.print_events', 'INSERT')
       AND NOT has_table_privilege(login.rolname, 'public.print_events', 'UPDATE')
       AND NOT has_table_privilege(login.rolname, 'public.print_events', 'DELETE')
       AND NOT has_table_privilege(login.rolname, 'public.print_events', 'TRUNCATE')
       AND has_table_privilege(login.rolname, 'public.audit_log', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.audit_log', 'INSERT')
       AND NOT has_table_privilege(login.rolname, 'public.audit_log', 'UPDATE')
       AND NOT has_table_privilege(login.rolname, 'public.audit_log', 'DELETE')
       AND NOT has_table_privilege(login.rolname, 'public.audit_log', 'TRUNCATE')
       AND has_sequence_privilege(login.rolname, 'public.print_batches_id_seq', 'USAGE')
       AND has_sequence_privilege(login.rolname, 'public.print_batches_id_seq', 'SELECT')
       AND NOT has_sequence_privilege(login.rolname, 'public.print_batches_id_seq', 'UPDATE')
       AND has_sequence_privilege(login.rolname, 'public.print_events_id_seq', 'USAGE')
       AND has_sequence_privilege(login.rolname, 'public.print_events_id_seq', 'SELECT')
       AND NOT has_sequence_privilege(login.rolname, 'public.print_events_id_seq', 'UPDATE')
       AND has_sequence_privilege(login.rolname, 'public.label_prints_id_seq', 'USAGE')
       AND has_sequence_privilege(login.rolname, 'public.label_prints_id_seq', 'SELECT')
       AND NOT has_sequence_privilege(login.rolname, 'public.label_prints_id_seq', 'UPDATE')
       AND has_sequence_privilege(login.rolname, 'public.label_overrides_id_seq', 'USAGE')
       AND has_sequence_privilege(login.rolname, 'public.label_overrides_id_seq', 'SELECT')
       AND NOT has_sequence_privilege(login.rolname, 'public.label_overrides_id_seq', 'UPDATE')
       AND has_sequence_privilege(login.rolname, 'public.reprint_log_id_seq', 'USAGE')
       AND has_sequence_privilege(login.rolname, 'public.reprint_log_id_seq', 'SELECT')
       AND NOT has_sequence_privilege(login.rolname, 'public.reprint_log_id_seq', 'UPDATE')
       AND has_sequence_privilege(login.rolname, 'public.audit_log_id_seq', 'USAGE')
       AND has_sequence_privilege(login.rolname, 'public.audit_log_id_seq', 'SELECT')
       AND NOT has_sequence_privilege(login.rolname, 'public.audit_log_id_seq', 'UPDATE')
       AND has_table_privilege(login.rolname, 'public.partner_applications', 'SELECT')
       AND has_table_privilege(login.rolname, 'public.partner_applications', 'INSERT')
       AND has_table_privilege(login.rolname, 'public.partner_applications', 'UPDATE')
       AND NOT has_table_privilege(login.rolname, 'public.partner_applications', 'DELETE')
       AND NOT EXISTS (
         SELECT 1
           FROM pg_class denied
           JOIN pg_namespace denied_ns ON denied_ns.oid = denied.relnamespace
          WHERE denied_ns.nspname = 'public'
            AND denied.relkind IN ('r','p','v','m','f')
            AND (
              denied.relname = 'field_welders'
              OR (left(denied.relname, 8) = 'partner_' AND denied.relname <> 'partner_applications')
            )
            AND (
              has_table_privilege(login.rolname, denied.oid, 'SELECT')
              OR has_table_privilege(login.rolname, denied.oid, 'INSERT')
              OR has_table_privilege(login.rolname, denied.oid, 'UPDATE')
              OR has_table_privilege(login.rolname, denied.oid, 'DELETE')
              OR has_table_privilege(login.rolname, denied.oid, 'TRUNCATE')
              OR has_table_privilege(login.rolname, denied.oid, 'REFERENCES')
              OR has_table_privilege(login.rolname, denied.oid, 'TRIGGER')
            )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM pg_class direct_relation
           CROSS JOIN LATERAL aclexplode(direct_relation.relacl) acl
          WHERE direct_relation.relacl IS NOT NULL
            AND acl.grantee = login.oid
       )
  ) END AS ready
), missing_relations AS (
  SELECT array_agg(name ORDER BY name) AS names
    FROM required_relations, session_contract, payment_fulfilment_contract,
         customer_notification_contract, object_write_contract, print_workflow_contract
   WHERE to_regclass(name) IS NULL
      OR (name = 'public.session' AND NOT session_contract.ready)
      OR (
        name = 'public.grading_payment_fulfilments'
        AND NOT payment_fulfilment_contract.ready
      )
      OR (
        name = 'public.customer_notification_outbox'
        AND NOT customer_notification_contract.ready
      )
      OR (
        name IN ('public.object_write_operations','public.object_write_items')
        AND NOT object_write_contract.ready
      )
      OR (
        name IN (
          'public.certificates',
          'public.print_batches',
          'public.print_events',
          'public.label_prints',
          'public.label_overrides',
          'public.reprint_log',
          'public.audit_log'
        )
        AND NOT print_workflow_contract.ready
      )
), missing_migrations AS (
  SELECT array_agg(r.filename ORDER BY r.filename) AS names
    FROM required_migrations r
   WHERE NOT EXISTS (
     SELECT 1 FROM public.schema_migrations m
      WHERE m.filename = r.filename
        AND m.status = 'applied'
        AND m.completed_at IS NOT NULL
   )
), missing_triggers AS (
  SELECT array_agg(r.name ORDER BY r.name) AS names
    FROM required_triggers r
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger t
      WHERE t.tgname = r.name
        AND t.tgrelid = to_regclass(r.relation_name)
        AND NOT t.tgisinternal
        AND t.tgenabled = 'A'
   )
)
SELECT
  cardinality(COALESCE(mr.names, ARRAY[]::text[])) = 0
    AND cardinality(COALESCE(mm.names, ARRAY[]::text[])) = 0
    AND cardinality(COALESCE(mt.names, ARRAY[]::text[])) = 0
    AND runtime_authority.ready AS ready,
  COALESCE(mr.names, ARRAY[]::text[]) AS missing_relations,
  COALESCE(mm.names, ARRAY[]::text[]) AS missing_migrations,
  COALESCE(mt.names, ARRAY[]::text[]) AS missing_triggers,
  runtime_authority.ready AS runtime_authority_ready
FROM missing_relations mr, missing_migrations mm, missing_triggers mt, runtime_authority`;

/** Never throws and never exposes database details to the public probe. */
export async function checkReleaseReadiness(
  queryable: ReadinessQueryable,
  env: ReadinessEnvironment = process.env,
  runtimeProbes: ReadinessRuntimeProbes = DEFAULT_RUNTIME_PROBES
): Promise<ReleaseReadiness> {
  const configuration = checkReleaseConfiguration(env);
  const runtime = checkReleaseRuntime(env, runtimeProbes);
  const production = (env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  // Operational Partner facts are consumed by always-mounted MintVault admin,
  // print, QA, scanner and growth paths, not only by the Partner Portal. The
  // separate credential is therefore a production-wide runtime dependency.
  const requirePartnerAdmin = production;
  let partnerAdminReady = true;
  if (requirePartnerAdmin) {
    try {
      partnerAdminReady = (await runtimeProbes.partnerAdminAuthorityReady?.()) === true;
    } catch {
      partnerAdminReady = false;
    }
  }
  const partnerAdminUnavailable = partnerAdminReady
    ? []
    : [COMPONENT_READINESS_REGISTRY.runtimeSignals.partner_admin_database_authority];
  const vqUnavailable = [COMPONENT_READINESS_REGISTRY.runtimeSignals.vault_quest_database_authority];
  try {
    const result = await queryable.query(RELEASE_READINESS_SQL, [
      [...REQUIRED_RELEASE_RELATIONS],
      [...REQUIRED_RELEASE_MIGRATIONS],
      [...REQUIRED_RELEASE_TRIGGERS],
      [...REQUIRED_RELEASE_TRIGGER_RELATIONS],
      production,
    ]);
    const row = result.rows[0];
    if (!row) {
      return {
        ok: false,
        missingRelations: [],
        missingMigrations: [],
        missingTriggers: [],
        missingConfiguration: configuration.missing,
        invalidConfiguration: configuration.invalid,
        unavailableRuntime: [...runtime.unavailable, ...partnerAdminUnavailable, ...vqUnavailable],
        queryFailed: true,
      };
    }
    const vq = await checkVqRuntimeReadiness(queryable, production);
    return {
      ok: row.ready === true && configuration.ok && runtime.ok && partnerAdminReady && vq.ready,
      missingRelations: row.missing_relations ?? [],
      missingMigrations: row.missing_migrations ?? [],
      missingTriggers: row.missing_triggers ?? [],
      missingConfiguration: configuration.missing,
      invalidConfiguration: configuration.invalid,
      unavailableRuntime: [
        ...runtime.unavailable,
        ...(row.runtime_authority_ready === false
          ? [COMPONENT_READINESS_REGISTRY.runtimeSignals.main_database_runtime_authority]
          : []),
        ...partnerAdminUnavailable,
        ...(vq.ready ? [] : vqUnavailable),
      ],
      queryFailed: vq.queryFailed,
    };
  } catch {
    return {
      ok: false,
      missingRelations: [],
      missingMigrations: [],
      missingTriggers: [],
      missingConfiguration: configuration.missing,
      invalidConfiguration: configuration.invalid,
      unavailableRuntime: [...runtime.unavailable, ...partnerAdminUnavailable, ...vqUnavailable],
      queryFailed: true,
    };
  }
}
