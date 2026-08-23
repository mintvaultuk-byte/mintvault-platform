/**
 * G5 Super-Admin partner-management — service layer (the only place G5 orchestration lives).
 *
 * Reads: deterministic, bounded, parameterised, secret-free projections via the privileged admin pool
 * (partnerAdminQuery), each scoped by an EXPLICIT WHERE tenant_id = $1 (the admin pool sets no RLS
 * context). Mutations: G5 does its own domain writes (a single atomic UPDATE/INSERT per aggregate),
 * each wrapped in the append-only admin-action audit (attempt row before, terminal row after) with an
 * idempotency-key short-circuit — mirroring the G4 pattern. Versioned aggregates use optimistic
 * locking (WHERE version = $expected). No connector/wallet/slot/billing/grading logic here; no secret
 * is ever read or written; the actor is always server-derived.
 */
import { databaseIdentity, partnerAdminQuery, withPartnerAdminTransaction } from "./db";
import type { OwnerEmailEligibility, PartnerOwnerEmailClash } from "@shared/partner-owner-email";
import { partnerDisplayName } from "@shared/partner-person-name";
import { G5RequestError, canTransitionStatus, isPartnerStatus, type PartnerStatus } from "./partner-management-errors";
import { hashPassword, isValidPartnerPassword } from "./auth";
import { deliverInvitationToken, invitationDeliveryConfigured } from "./delivery";
import { ensureWallet, ensureWalletWithClient, appendFoundationCreditWithClient } from "./partner-wallet-service";
import {
  PARTNER_WELCOME_CREDIT_AMOUNT,
  PARTNER_WELCOME_CREDIT_REASON,
  partnerWelcomeCreditIdempotencyKey,
} from "@shared/partner-welcome-credits";
import { derivePartnerOperationalReadiness, type PartnerReadinessFacts } from "./operational-readiness";
import { loadOnboardingTestCardArmedAt, loadPartnerTestCardFacts } from "./test-card-authority";
import { APP_BASE_URL } from "../app-url";
import type { PoolClient } from "pg";
import crypto from "node:crypto";
import {
  formatPartnerDeliveryAddress,
  isCompletePartnerDeliveryAddress,
  isValidPartnerPostcode,
  normalisePartnerDeliveryAddress,
  type PartnerDeliveryAddress,
  type PartnerDeliveryAddressInput,
} from "@shared/partner-delivery-address";
import {
  hasValidPartnerOperationalContact,
  PARTNER_OPERATIONAL_EMAIL_RE,
  normalisePartnerOperationalEmail,
} from "@shared/partner-operational-contact";
import type { PartnerOperationalReadiness, ReadinessAction, ReadinessDimensionKey } from "@shared/partner-readiness";
import { PUBLIC_PARTNER_PROFILE_PREFIX } from "./public-presence-service";

export interface ActorContext {
  actorUserId: string;
  actorEmail: string;
  requestId: string;
  idempotencyKey?: string;
}

type CreatePartnerFailurePoint = "after_org_insert" | "after_default_location_insert";
type InvitePartnerFailurePoint =
  | "after_user_insert"
  | "after_role_assignment"
  | "before_invitation_insert"
  | "before_invitation_audit";

interface InviteBarrier {
  point: "after_duplicate_check";
  parties: number;
  arrived: number;
  waiters: Array<() => void>;
}

interface AcceptBarrier {
  point: "before_invitation_lock";
  parties: number;
  arrived: number;
  waiters: Array<() => void>;
}

let createPartnerFailurePointForTest: CreatePartnerFailurePoint | null = null;
let invitePartnerFailurePointForTest: InvitePartnerFailurePoint | null = null;
let inviteBarrierForTest: InviteBarrier | null = null;
let acceptBarrierForTest: AcceptBarrier | null = null;

function testHooksAllowed(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function requireTestHooksAllowed(): void {
  if (!testHooksAllowed()) {
    throw new Error("partner management test hooks are only available under the test runner.");
  }
}

export function __setCreatePartnerFailurePointForTest(point: CreatePartnerFailurePoint | null): void {
  requireTestHooksAllowed();
  createPartnerFailurePointForTest = point;
}

export function __setInvitePartnerFailurePointForTest(point: InvitePartnerFailurePoint | null): void {
  requireTestHooksAllowed();
  invitePartnerFailurePointForTest = point;
}

export function __setInvitePartnerBarrierForTest(
  barrier: { point: "after_duplicate_check"; parties: number } | null
): void {
  requireTestHooksAllowed();
  inviteBarrierForTest = barrier ? { point: barrier.point, parties: barrier.parties, arrived: 0, waiters: [] } : null;
}

export function __setAcceptPartnerBarrierForTest(
  barrier: { point: "before_invitation_lock"; parties: number } | null
): void {
  requireTestHooksAllowed();
  acceptBarrierForTest = barrier ? { point: barrier.point, parties: barrier.parties, arrived: 0, waiters: [] } : null;
}

function maybeFailCreatePartnerForTest(point: CreatePartnerFailurePoint): void {
  if (testHooksAllowed() && createPartnerFailurePointForTest === point) {
    throw new Error(`synthetic_create_partner_${point}`);
  }
}

function maybeFailInvitePartnerForTest(point: InvitePartnerFailurePoint): void {
  if (testHooksAllowed() && invitePartnerFailurePointForTest === point) {
    throw new Error(`synthetic_invite_partner_${point}`);
  }
}

async function maybeWaitInviteBarrierForTest(point: "after_duplicate_check"): Promise<void> {
  if (!testHooksAllowed() || inviteBarrierForTest?.point !== point) return;
  const barrier = inviteBarrierForTest;
  barrier.arrived += 1;
  if (barrier.arrived >= barrier.parties) {
    const waiters = barrier.waiters.splice(0);
    inviteBarrierForTest = null;
    for (const release of waiters) release();
    return;
  }
  await new Promise<void>((resolve) => barrier.waiters.push(resolve));
}

async function maybeWaitAcceptBarrierForTest(point: "before_invitation_lock"): Promise<void> {
  if (!testHooksAllowed() || acceptBarrierForTest?.point !== point) return;
  const barrier = acceptBarrierForTest;
  barrier.arrived += 1;
  if (barrier.arrived >= barrier.parties) {
    const waiters = barrier.waiters.splice(0);
    acceptBarrierForTest = null;
    for (const release of waiters) release();
    return;
  }
  await new Promise<void>((resolve) => barrier.waiters.push(resolve));
}

type AuditAction =
  // Closing a card that holds evidence and returning its credit. Named distinctly from a station
  // cancellation so the trail can tell a super-admin void from an operator abandoning a blank card.
  | "partner_card_job_voided"
  | "partner_created"
  | "partner_first_shop_onboarded"
  | "profile_updated"
  | "status_changed"
  | "contact_added"
  | "contact_updated"
  | "contact_deactivated"
  | "branding_updated"
  | "note_added"
  | "partner_user_invited"
  | "partner_invitation_resent"
  | "partner_invitation_revoked"
  | "partner_invitation_accepted"
  | "partner_user_role_changed"
  | "partner_user_suspended"
  | "partner_user_reactivated"
  | "partner_user_password_reset_initiated"
  | "partner_user_sessions_revoked"
  | "partner_user_membership_removed"
  // Added by migration 0033 so security-relevant actions are labelled honestly rather than
  // borrowing a neighbouring action type.
  | "partner_user_mfa_reset"
  | "partner_invitation_amended"
  | "partner_legal_name_changed"
  | "partner_duplicate_override"
  | "partner_wallet_backfilled"
  // AG-1 multi-location. Recorded honestly rather than borrowed from a neighbouring action —
  // a location rename is not a profile update, and 0033 exists because that distinction matters.
  | "partner_location_created"
  | "partner_location_updated"
  | "partner_location_status_changed"
  | "partner_user_locations_changed"
  // Declaring that a shop's NEXT new card is its onboarding test (migration 0109/0110). It
  // authorises one Grading Credit to be spent as a test, so it is recorded honestly rather than
  // folded into profile_updated — the same reason 0033 exists.
  | "partner_onboarding_test_card_armed";

// ---------------------------------------------------------------------------
// Partner + profile lookups (admin pool, explicit tenant scoping).
// ---------------------------------------------------------------------------
interface OrgRow {
  id: string;
  legal_name: string;
  status: string;
  accreditation_level: string;
  health: string;
  created_at: string;
}

async function loadPartner(partnerId: string): Promise<OrgRow> {
  const { rows } = await partnerAdminQuery<OrgRow>(
    `SELECT id, legal_name, status, accreditation_level, health, created_at
       FROM partner_organisations WHERE id = $1`,
    [partnerId]
  );
  if (rows.length === 0) throw new G5RequestError("PARTNER_NOT_FOUND", "Partner organisation not found.");
  return rows[0];
}

/** The partner aggregate version (partner_profiles.version); ensures a profile row exists. */
async function loadOrInitProfileVersion(tenantId: string): Promise<number> {
  const { rows } = await partnerAdminQuery<{ version: number }>(
    `SELECT version FROM partner_profiles WHERE tenant_id = $1`,
    [tenantId]
  );
  if (rows.length > 0) return rows[0].version;
  await partnerAdminQuery(`INSERT INTO partner_profiles (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
    tenantId,
  ]);
  return 1;
}

export interface WalletBackfillResult {
  backfillId: "WALLET-BACKFILL1";
  considered: number;
  provisioned: Array<{ tenantId: string; legalName: string; walletId: string }>;
  alreadyPresent: Array<{ tenantId: string; legalName: string; walletId: string }>;
  skipped: Array<{ tenantId: string; legalName: string; status: string; reason: string }>;
  ledgerEntriesCreated: 0;
}

function walletBackfillAllowed(): boolean {
  if (process.env.PARTNER_WALLET_BACKFILL1_ENABLED !== "true") return false;
  const appUrl = process.env.APP_URL ?? "";
  const appName = process.env.FLY_APP_NAME ?? "";
  const staging = appName === "mintvault-v2" || appUrl.includes("mintvault-v2.fly.dev");
  const local =
    process.env.NODE_ENV !== "production" &&
    (process.env.VITEST === "true" || appUrl.includes("localhost") || appUrl.includes("127.0.0.1"));
  if (local) return true;
  if (!staging) return false;

  const expectedIdentity = process.env.PARTNER_WALLET_BACKFILL1_EXPECTED_DATABASE_IDENTITY?.trim();
  const actualUrl = process.env.PARTNER_ADMIN_DATABASE_URL || process.env.MINTVAULT_DATABASE_URL;
  if (!expectedIdentity || !actualUrl) return false;
  try {
    return databaseIdentity(actualUrl, "PARTNER_ADMIN_DATABASE_URL") === expectedIdentity;
  } catch {
    return false;
  }
}

function walletBackfillIdempotencyKey(actor: ActorContext, tenantId: string): string {
  return `${actor.idempotencyKey ?? "WALLET-BACKFILL1"}:${tenantId}`;
}

export async function provisionMissingActivePartnerWallets(
  actor: ActorContext,
  input: { reason: string; targetTenantIds?: string[] }
): Promise<WalletBackfillResult> {
  if (!walletBackfillAllowed()) {
    throw new G5RequestError("WALLET_BACKFILL_DISABLED", "Wallet backfill is not enabled in this environment.");
  }
  const targets = input.targetTenantIds ?? [];
  const result: WalletBackfillResult = {
    backfillId: "WALLET-BACKFILL1",
    considered: 0,
    provisioned: [],
    alreadyPresent: [],
    skipped: [],
    ledgerEntriesCreated: 0,
  };

  return withPartnerAdminTransaction(async (client) => {
    const orgs = await client.query<{ id: string; legal_name: string; status: string; wallet_id: string | null }>(
      `SELECT o.id, o.legal_name, o.status, w.id AS wallet_id
         FROM partner_organisations o
         LEFT JOIN partner_wallets w ON w.tenant_id = o.id
        WHERE ($1::uuid[] IS NULL OR o.id = ANY($1::uuid[]))
        ORDER BY o.legal_name, o.id`,
      [targets.length ? targets : null]
    );
    result.considered = orgs.rows.length;

    for (const org of orgs.rows) {
      const beforeState = { status: org.status, walletPresent: !!org.wallet_id };
      if (org.status !== "ACTIVE") {
        result.skipped.push({
          tenantId: org.id,
          legalName: org.legal_name,
          status: org.status,
          reason: "organisation_not_active",
        });
        continue;
      }

      const idempotencyKey = walletBackfillIdempotencyKey(actor, org.id);
      await client.query(
        `INSERT INTO partner_management_audit
           (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
         VALUES ($1,'partner_wallet_backfilled',$2,$3,$4,$5,'partner_wallet',$1::uuid::text,$6,'__attempt__','attempted')`,
        [org.id, actor.actorUserId, actor.actorEmail, actor.requestId, idempotencyKey, JSON.stringify(beforeState)]
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO partner_wallets (tenant_id)
         VALUES ($1)
         ON CONFLICT (tenant_id) DO NOTHING
         RETURNING id`,
        [org.id]
      );
      const walletId =
        inserted.rows[0]?.id ??
        (await client.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [org.id])).rows[0]?.id;
      if (!walletId) throw new G5RequestError("INTERNAL_ERROR", "Wallet backfill could not verify wallet.");

      const created = inserted.rowCount === 1;
      await client.query(
        `INSERT INTO partner_management_audit
           (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, after_state, reason, result)
         VALUES ($1,'partner_wallet_backfilled',$2,$3,$4,$5,'partner_wallet',$6,$7,$8,$9,$10)`,
        [
          org.id,
          actor.actorUserId,
          actor.actorEmail,
          actor.requestId,
          idempotencyKey,
          walletId,
          JSON.stringify(beforeState),
          JSON.stringify({ walletId, created, ledgerEntriesCreated: 0 }),
          input.reason,
          created ? "succeeded" : "no_op",
        ]
      );

      const bucket = created ? result.provisioned : result.alreadyPresent;
      bucket.push({ tenantId: org.id, legalName: org.legal_name, walletId });
    }

    return result;
  });
}

// ---------------------------------------------------------------------------
// Append-only audit (partner_management_audit) — attempt row, then terminal row.
// ---------------------------------------------------------------------------
async function recordAttempt(
  actor: ActorContext,
  tenantId: string,
  action: AuditAction,
  entityType: string | null,
  entityId: string | null,
  beforeState: unknown
): Promise<void> {
  await partnerAdminQuery(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'attempted')`,
    [
      tenantId,
      action,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      entityType,
      entityId,
      beforeState == null ? null : JSON.stringify(beforeState),
      "__attempt__",
    ]
  );
}

async function recordTerminal(
  actor: ActorContext,
  tenantId: string,
  action: AuditAction,
  entityType: string | null,
  entityId: string | null,
  afterState: unknown,
  reason: string,
  result: "succeeded" | "failed" | "no_op",
  error?: { code: string; summary: string }
): Promise<void> {
  await partnerAdminQuery(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, after_state, reason, result, error_code, error_summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      tenantId,
      action,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      entityType,
      entityId,
      afterState == null ? null : JSON.stringify(afterState),
      reason,
      result,
      error?.code ?? null,
      error?.summary ?? null,
    ]
  );
}

/**
 * Has this exact operation already succeeded?
 *
 * Scoped to (tenant, action, key), matching the uq_partner_management_audit_idem index that 0107
 * widens to the same three columns. It used to match on the KEY ALONE, which was safe only while
 * MintVault staff were the sole producers of a key. First-shop onboarding added self-service
 * Partner Owner routes that write this ledger too, so a customer-chosen key could otherwise make a
 * later Super Admin mutation — including suspend, revoke-invitation, reset-MFA and revoke-sessions —
 * report `{ ok: true, alreadyCompleted: true }` without executing.
 *
 * Two independent defences, deliberately both: partner-originated keys are namespaced with the
 * authenticated tenant at the route boundary (partnerOriginatedIdempotencyKey, server/partner/routes.ts),
 * and the replay match here can no longer cross a tenant or an action even if a key were to collide.
 */
async function priorSuccess(
  idempotencyKey: string | undefined,
  tenantId: string,
  action: AuditAction
): Promise<boolean> {
  if (!idempotencyKey) return false;
  const { rows } = await partnerAdminQuery(
    `SELECT 1 FROM partner_management_audit
      WHERE idempotency_key = $1 AND tenant_id = $2 AND action_type = $3 AND result = 'succeeded'
      LIMIT 1`,
    [idempotencyKey, tenantId, action]
  );
  return rows.length > 0;
}

/**
 * Replay guard for partner CREATION, which cannot use priorSuccess().
 *
 * At create time no tenant exists yet, so the key namespace is necessarily pre-tenant. This match
 * is therefore deliberately CROSS-TENANT — that is exactly the property a duplicate-create guard
 * needs, because the failure it prevents is "the same request key produced a second organisation".
 * It is still narrowed to the 'partner_created' action so it can never collide with a mutation on
 * an existing partner. The 0107 index cannot serve this case: a retry would carry a different
 * tenant_id and so would not conflict.
 */
async function priorCreateSuccess(idempotencyKey: string | undefined): Promise<boolean> {
  if (!idempotencyKey) return false;
  const { rows } = await partnerAdminQuery(
    `SELECT 1 FROM partner_management_audit
      WHERE idempotency_key = $1 AND action_type = 'partner_created' AND result = 'succeeded'
      LIMIT 1`,
    [idempotencyKey]
  );
  return rows.length > 0;
}

interface DelegateResult<T> {
  result: T;
  entityType: string | null;
  entityId: string | null;
  afterState: unknown;
}

/**
 * Wrap a mutation: idempotency check → attempt row → domain write → terminal row. A pg unique-violation
 * (23505) — the concurrent-idempotency race or a domain uniqueness collision the delegate did not
 * pre-map — is surfaced to the caller; the caller pre-checks so a friendly code is returned first.
 */
async function withAudit<T>(
  actor: ActorContext,
  tenantId: string,
  action: AuditAction,
  reason: string,
  beforeState: unknown,
  delegate: () => Promise<DelegateResult<T>>
): Promise<{ result: T; alreadyCompleted: boolean } | { result: null; alreadyCompleted: true }> {
  if (await priorSuccess(actor.idempotencyKey, tenantId, action)) return { result: null, alreadyCompleted: true };
  await recordAttempt(actor, tenantId, action, null, null, beforeState);
  try {
    const d = await delegate();
    await recordTerminal(actor, tenantId, action, d.entityType, d.entityId, d.afterState, reason, "succeeded");
    return { result: d.result, alreadyCompleted: false };
  } catch (err) {
    // Only the AUDIT idempotency-key collision means "another same-key request already recorded
    // success" → an idempotent replay. A domain unique-violation (e.g. uq_partner_contacts_primary)
    // must NOT be swallowed as alreadyCompleted — it falls through to toG5Error which maps it to the
    // friendly DUPLICATE_PRIMARY_CONTACT and records a terminal 'failed' row.
    const pg = err as { code?: string; constraint?: string };
    if (pg?.code === "23505" && pg.constraint === "uq_partner_management_audit_idem" && actor.idempotencyKey) {
      return { result: null, alreadyCompleted: true };
    }
    const { toG5Error } = await import("./partner-management-errors");
    const g5 = toG5Error(err);
    await recordTerminal(actor, tenantId, action, null, null, null, reason, "failed", {
      code: g5.code,
      summary: g5.message,
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MUTATIONS
// ---------------------------------------------------------------------------
export async function createPartner(
  actor: ActorContext,
  input: { legalName: string; profile?: Record<string, unknown> },
  reason: string
) {
  // Idempotency for create: the org INSERT below has no natural unique key, so a same-key retry would
  // otherwise create a duplicate org before withAudit's own replay check. Short-circuit here, BEFORE
  // any write, when a prior succeeded creation already used this key. Create's key namespace is
  // pre-tenant, so this check is deliberately cross-tenant but action-scoped — see priorCreateSuccess.
  if (await priorCreateSuccess(actor.idempotencyKey)) return { result: null, alreadyCompleted: true };
  return withPartnerAdminTransaction(async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO partner_organisations (legal_name, status) VALUES ($1,'PENDING') RETURNING id`,
      [input.legalName]
    );
    const tenantId = org.rows[0].id;
    maybeFailCreatePartnerForTest("after_org_insert");
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
       VALUES ($1::uuid,'partner_created',$2,$3,$4,$5,'partner',$1::text,$6,'__attempt__','attempted')`,
      [tenantId, actor.actorUserId, actor.actorEmail, actor.requestId, actor.idempotencyKey ?? null, null]
    );
    await client.query(`INSERT INTO partner_profiles (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [
      tenantId,
    ]);
    await client.query(
      `INSERT INTO partner_locations (tenant_id, partner_id, name, status, created_by)
       VALUES ($1::uuid,$1::uuid,'Main location','ACTIVE',$2)`,
      [tenantId, actor.actorUserId]
    );
    maybeFailCreatePartnerForTest("after_default_location_insert");
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, after_state, reason, result)
       VALUES ($1::uuid,'partner_created',$2,$3,$4,$5,'partner',$1::text,$6,$7,'succeeded')`,
      [
        tenantId,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        JSON.stringify({ status: "PENDING", defaultLocation: { name: "Main location", status: "ACTIVE" } }),
        reason,
      ]
    );
    return {
      result: { partnerId: tenantId },
      alreadyCompleted: false,
    };
  });
}

export interface FirstShopOnboardingInput {
  legalName: string;
  /** Optional. A single-location shop is always the Main location; see DEFAULT_MAIN_LOCATION_NAME. */
  locationName?: string | null;
  deliveryAddress: PartnerDeliveryAddressInput;
  /**
   * Optional. Defaults to the Owner, who is the operations contact for a normal new shop — asking
   * an operator to type the same name and email twice is how duplicate contacts get created.
   */
  operationsContact?: { fullName?: string | null; email?: string | null } | null;
  owner: { firstName: string; lastName: string; email: string };
}

/**
 * The one name a single-location shop's location ever has.
 *
 * Defaulted on the SERVER so every caller produces the same canonical record, and so the readiness
 * query's "main location" lookup — which prefers `lower(btrim(name)) = 'main location'` — keeps
 * finding it. A form field that can be typed differently is a field that will be.
 */
export const DEFAULT_MAIN_LOCATION_NAME = "Main location";

function requireFirstShopAddress(raw: PartnerDeliveryAddressInput): PartnerDeliveryAddress {
  const address = normalisePartnerDeliveryAddress(raw);
  if (!address) {
    throw new G5RequestError(
      "VALIDATION_ERROR",
      "Enter address line 1, town/city, a valid postcode, and country for the Main location."
    );
  }
  return address;
}

function requireOperationalContact(fullNameRaw: string, emailRaw: string): { fullName: string; email: string } {
  const fullName = fullNameRaw.trim();
  const email = normalisePartnerOperationalEmail(emailRaw);
  if (!fullName || !PARTNER_OPERATIONAL_EMAIL_RE.test(email)) {
    throw new G5RequestError("VALIDATION_ERROR", "An operations contact name and valid email are required.");
  }
  return { fullName, email };
}

/**
 * Atomically creates the durable first-shop records that are knowable before
 * the Owner accepts their invite: Partner, Main location, structured delivery
 * address, PRIMARY operations contact, Owner invitation and zero-balance wallet.
 *
 * Station enrolment and MFA intentionally stay outside this transaction: they
 * require a real shop Mac and a real Owner. The readiness contract shows those
 * as pending rather than manufacturing a false completion state.
 */
export async function createFirstShopOnboarding(actor: ActorContext, input: FirstShopOnboardingInput, reason: string) {
  const legalName = input.legalName.trim();
  if (legalName.length < 2 || legalName.length > 500) {
    throw new G5RequestError("VALIDATION_ERROR", "A legal or shop name of 2–500 characters is required.");
  }
  const locationName = (input.locationName ?? "").trim() || DEFAULT_MAIN_LOCATION_NAME;
  if (locationName.length < 2 || locationName.length > 120) {
    throw new G5RequestError("VALIDATION_ERROR", "A Main location name of 2–120 characters is required.");
  }
  if (!actor.idempotencyKey || !/^[A-Za-z0-9._:-]{16,128}$/.test(actor.idempotencyKey)) {
    throw new G5RequestError("VALIDATION_ERROR", "A stable onboarding request key is required.");
  }
  const deliveryAddress = requireFirstShopAddress(input.deliveryAddress);
  const ownerFirstName = input.owner.firstName.trim();
  const ownerLastName = input.owner.lastName.trim();
  const ownerEmail = normalisePartnerOperationalEmail(input.owner.email);
  if (!ownerFirstName || !ownerLastName || !PARTNER_OPERATIONAL_EMAIL_RE.test(ownerEmail)) {
    throw new G5RequestError("VALIDATION_ERROR", "A Partner Owner name and valid email are required.");
  }
  /*
   * THE OPERATIONS CONTACT IS THE OWNER unless the caller deliberately supplies a different one.
   *
   * Validation is unchanged — requireOperationalContact still runs, so a supplied contact must be
   * as valid as it ever was, and the Owner's own name and email have already been validated above.
   * This only removes the retyping, and with it the commonest way a shop ended up with two contacts
   * that differ by a typo.
   */
  const suppliedContactName = input.operationsContact?.fullName?.trim() ?? "";
  const suppliedContactEmail = input.operationsContact?.email?.trim() ?? "";
  const operationsContact =
    suppliedContactName || suppliedContactEmail
      ? requireOperationalContact(suppliedContactName, suppliedContactEmail)
      : requireOperationalContact(`${ownerFirstName} ${ownerLastName}`, ownerEmail);

  const committed = await withPartnerAdminTransaction(async (client) => {
    // The audit table's success uniqueness protects the terminal write, but it
    // cannot prevent two new organisation rows from being inserted before that
    // write. A transaction-scoped advisory lock makes one request key one first
    // shop, including double click, retry and two-browser races.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [actor.idempotencyKey]);
    // Separate browser tabs do not share an idempotency key. Serialise their normalised legal/shop
    // name too, then re-check inside that lock, so concurrent first-shop submissions cannot create
    // duplicate canonical Partner records merely because the legacy table permits similar names.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `first-shop-name:${legalName.trim().toLocaleLowerCase("en-GB")}`,
    ]);
    const replay = await client.query<{ entity_id: string }>(
      `SELECT entity_id FROM partner_management_audit
        WHERE idempotency_key=$1 AND action_type='partner_first_shop_onboarded' AND result='succeeded'
        ORDER BY created_at DESC LIMIT 1`,
      [actor.idempotencyKey]
    );
    if (replay.rows[0]?.entity_id) return { replayed: true as const, partnerId: replay.rows[0].entity_id, invite: null };

    // A guided first-shop submit has no "override duplicate" affordance. Requiring the operator
    // to resolve a matching canonical Partner first is safer than quietly creating Shop 1 twice.
    if (
      (
        await client.query(
          "SELECT 1 FROM partner_organisations WHERE lower(btrim(legal_name))=lower(btrim($1)) LIMIT 1",
          [legalName]
        )
      ).rows.length
    ) {
      throw new G5RequestError(
        "VALIDATION_ERROR",
        "A Partner with that legal or shop name already exists. Open its guided readiness instead of creating a duplicate."
      );
    }
    // Partner emails are unique across EVERY Partner (uq_partner_users_email_lower, migration 0003),
    // and that reservation survives revocation because a REVOKED user keeps its row. So this block is
    // correct — but the wording was not. "That team member cannot be invited." is the PARTNER-facing
    // team-service message, deliberately opaque there because naming another tenant would be a
    // cross-tenant "does this person work for another shop?" oracle. This surface is Super Admin only
    // (requireSuperAdmin + step-up) and already lists every Partner, so there is no oracle to protect
    // and the opaque wording told the one operator entitled to the answer nothing — the guided flow
    // read as a broken button. The sibling super-admin invite (invitePartnerUser) has always been
    // explicit; this now matches it, and names the owning Partner so the block is actionable.
    /*
     * The SAME finder the pre-flight eligibility check uses, run inside this transaction where it is
     * actually authoritative. The form asks early so the operator is not surprised; this is what
     * decides. Two implementations of one uniqueness rule is how a pre-check starts lying.
     */
    const ownerClash = await findOwnerEmailClash(
      (sql, params) => client.query(sql, params) as never,
      ownerEmail
    );
    if (ownerClash) {
      const clashName = ownerClash.partnerName.slice(0, 80);
      throw new G5RequestError(
        "DUPLICATE_PARTNER_USER",
        `That Owner email already belongs to an existing Partner user (${clashName} — status ${ownerClash.userStatus}). ` +
          "Partner emails are unique across every Partner, and a revoked user still holds its email. " +
          `Use a different Owner email, or remove that user from ${clashName} first.`
      );
    }
    const ownerRole = await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code='PARTNER_OWNER'");
    if (ownerRole.rows.length !== 1) {
      throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner Owner role is not configured.");
    }

    const org = await client.query<{ id: string }>(
      "INSERT INTO partner_organisations (legal_name, status) VALUES ($1,'PENDING') RETURNING id",
      [legalName]
    );
    const partnerId = org.rows[0].id;
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
       VALUES ($1::uuid,'partner_first_shop_onboarded',$2,$3,$4,$5,'partner',$1::uuid::text,$6,'__attempt__','attempted')`,
      [partnerId, actor.actorUserId, actor.actorEmail, actor.requestId, actor.idempotencyKey, null]
    );
    await client.query("INSERT INTO partner_profiles (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING", [partnerId]);
    const location = await client.query<{ id: string }>(
      `INSERT INTO partner_locations
         (tenant_id, partner_id, name, address, address_line1, address_line2, address_city, address_postcode, address_country, status, created_by)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9)
       RETURNING id`,
      [
        partnerId,
        locationName,
        formatPartnerDeliveryAddress(deliveryAddress),
        deliveryAddress.line1,
        deliveryAddress.line2,
        deliveryAddress.city,
        deliveryAddress.postcode,
        deliveryAddress.country,
        actor.actorUserId,
      ]
    );
    const contact = await client.query<{ id: string }>(
      `INSERT INTO partner_contacts
         (tenant_id, full_name, email, contact_type, is_primary, active, created_by_user_id, created_by_email)
       VALUES ($1,$2,$3,'operations',true,true,$4,$5)
       RETURNING id`,
      [partnerId, operationsContact.fullName, operationsContact.email, actor.actorUserId, actor.actorEmail]
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, last_name, status, created_by)
       VALUES ($1,$1,$2,$3,$4,'INVITED',$5)
       RETURNING id`,
      [partnerId, ownerEmail, ownerFirstName, ownerLastName, actor.actorUserId]
    );
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      partnerId,
      user.rows[0].id,
      ownerRole.rows[0].id,
    ]);
    const invite = await createInvitationRecord(
      client,
      { ...actor, idempotencyKey: undefined },
      partnerId,
      user.rows[0].id,
      ownerEmail,
      "PARTNER_OWNER",
      "partner_user_invited",
      "First-shop Owner invitation"
    );
    const wallet = await ensureWalletWithClient(client, { actorUserId: actor.actorUserId, actorEmail: actor.actorEmail }, partnerId);
    /*
     * FIVE WELCOME CREDITS, granted here and nowhere else.
     *
     * PINNED TO THIS TRANSACTION. appendFoundationCreditWithClient takes the open client, so the
     * grant commits with the organisation, the location, the Owner and the invitation, or it does
     * not happen at all. A creation that rolls back cannot leave a ghost credit behind — which is
     * the whole reason this is not a follow-up call after the transaction closes.
     *
     * EXACTLY ONCE, by key. The key is derived from the partner id alone, so every later event that
     * might plausibly re-run onboarding logic — a refresh, a create retry, an invitation resend, the
     * Owner activating, a Scanner enrolling, a Mac being reinstalled — computes the same key and is
     * absorbed by uq_partner_credit_ledger_idem. `alreadyApplied` is deliberately not treated as an
     * error: losing that race is the correct outcome, not a fault.
     *
     * EXISTING PARTNERS ARE UNAFFECTED. This runs only inside the creation of a brand-new partner,
     * and `source='system'` has never been written before, so no deployment or migration can
     * retroactively grant credits to a shop that already exists. A backfill would be a separate,
     * explicitly owner-approved act.
     */
    await appendFoundationCreditWithClient(
      client,
      { actorUserId: actor.actorUserId, actorEmail: actor.actorEmail },
      {
        tenantId: partnerId,
        amount: PARTNER_WELCOME_CREDIT_AMOUNT,
        entryType: "opening_balance",
        source: "system",
        actorType: "system",
        reason: PARTNER_WELCOME_CREDIT_REASON,
        idempotencyKey: partnerWelcomeCreditIdempotencyKey(partnerId),
        correlationId: actor.requestId ?? null,
        metadata: { grantedBy: "partner_first_shop_onboarded" },
      }
    );
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, after_state, reason, result)
       VALUES ($1::uuid,'partner_first_shop_onboarded',$2,$3,$4,$5,'partner',$1::uuid::text,$6,$7,'succeeded')`,
      [
        partnerId,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey,
        JSON.stringify({
          status: "PENDING",
          mainLocationId: location.rows[0].id,
          operationsContactId: contact.rows[0].id,
          ownerUserId: user.rows[0].id,
          walletId: wallet.id,
        }),
        reason,
      ]
    );
    return { replayed: false as const, partnerId, invite };
  });

  if (committed.replayed || !committed.invite) {
    return { result: { partnerId: committed.partnerId, invitationDeliveryStatus: "NOT_RETRIED" }, alreadyCompleted: true };
  }
  const { delivery, ...invite } = committed.invite;
  let invitationDeliveryStatus: string;
  try {
    invitationDeliveryStatus = await recordInvitationDelivery({ ...invite, delivery });
  } catch {
    // The durable Partner/Owner/invitation transaction has committed. The
    // existing invitation route reports the same explicit unknown outcome rather
    // than claiming delivery failed or attempting a duplicate send.
    invitationDeliveryStatus = "DELIVERY_STATUS_UNKNOWN";
  }
  return { result: { partnerId: committed.partnerId, invitationDeliveryStatus }, alreadyCompleted: false };
}

const PROFILE_FIELDS = [
  "trading_name",
  "organisation_kind",
  "company_number",
  "vat_number",
  "website",
  "primary_email",
  "primary_phone",
  "address_line1",
  "address_line2",
  "address_city",
  "address_postcode",
  "address_country",
  "onboarding_date",
  "internal_tier",
  "health_note",
] as const;

/**
 * Rename the organisation (the one identity field that lives on partner_organisations, not on the
 * profile).
 *
 * AUDIT ACTION: `partner_legal_name_changed`, added by migration 0033. This previously borrowed
 * `profile_updated` because the CHECK constraint permitted nothing better; the ledger is now precise,
 * and the before/after states still name `legal_name` explicitly.
 *
 * The profile version is used as the optimistic lock for the whole partner aggregate (the same lock
 * updateProfile and changeStatus use), so a rename cannot silently overwrite a concurrent edit.
 */
export async function updatePartnerLegalName(
  actor: ActorContext,
  partnerId: string,
  legalName: string,
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (org.status === "REVOKED") {
    throw new G5RequestError("PARTNER_UNAVAILABLE", "A revoked partner cannot be edited.");
  }
  await loadOrInitProfileVersion(org.id);
  return withAudit(actor, org.id, "partner_legal_name_changed", reason, { legal_name: org.legal_name }, async () => {
    // Bump the aggregate version and rename in ONE data-modifying-CTE statement so the two writes are
    // atomic — no window where the version moved but the name did not. Mirrors changeStatus.
    const r = await partnerAdminQuery(
      `WITH bumped AS (
         UPDATE partner_profiles SET version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND version = $2
          RETURNING tenant_id
       )
       UPDATE partner_organisations o
          SET legal_name = $3, updated_at = now()
         FROM bumped
        WHERE o.id = bumped.tenant_id`,
      [org.id, expectedVersion, legalName]
    );
    if (r.rowCount === 0) {
      throw new G5RequestError("VERSION_CONFLICT", "The partner was modified by someone else; reload and retry.");
    }
    return {
      result: { legalName },
      entityType: "partner",
      entityId: org.id,
      afterState: { legal_name: legalName },
    };
  });
}

export interface DuplicateCandidate {
  legalName?: string;
  tradingName?: string;
  email?: string;
  postcode?: string;
  phone?: string;
}


/**
 * OWNER EMAIL ELIGIBILITY — one rule, asked twice.
 *
 * The create path has always refused a clashing Owner email, correctly. What it could not do is say
 * so BEFORE the operator filled in a whole form and pressed the button, which made a correct
 * refusal read as a dead Create button.
 *
 * This is the SAME query the create transaction runs, deliberately extracted rather than
 * reimplemented: a pre-flight check that disagrees with the thing it is checking is worse than no
 * pre-flight check at all. The create path still runs it inside its transaction — this only lets the
 * form ask the same question early. Nothing here writes, and nothing here relaxes uniqueness.
 */
type OwnerEmailClash = Omit<PartnerOwnerEmailClash, "releasable" | "reason" | "nextAction">;

async function findOwnerEmailClash(
  run: <T extends Record<string, unknown>>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>,
  email: string
): Promise<OwnerEmailClash | null> {
  const { rows } = await run<{
    tenant_id: string;
    legal_name: string;
    status: string;
    invitation_status: string | null;
    invitation_expires_at: Date | string | null;
  }>(
    `SELECT u.tenant_id::text AS tenant_id, o.legal_name, u.status,
            i.status AS invitation_status, i.expires_at AS invitation_expires_at
       FROM partner_users u
       JOIN partner_organisations o ON o.id = u.tenant_id
       LEFT JOIN LATERAL (
         SELECT status, expires_at FROM partner_invitations pi
          WHERE pi.tenant_id = u.tenant_id AND pi.user_id = u.id
          ORDER BY pi.created_at DESC LIMIT 1
       ) i ON true
      WHERE lower(u.email) = lower($1)
      LIMIT 1`,
    [email]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    partnerId: row.tenant_id,
    partnerName: row.legal_name,
    userStatus: row.status,
    invitationStatus: row.invitation_status,
    invitationExpiresAt:
      row.invitation_expires_at == null ? null : new Date(row.invitation_expires_at as string | Date).toISOString(),
  };
}


/**
 * Super-Admin-only. The router mounts this behind the same requireSuperAdmin the rest of Partner
 * management uses, so naming the owning Partner and the user's status leaks nothing that operator
 * cannot already read from the partners list. The Partner-facing surfaces keep their deliberately
 * vague disclosure wording; this is not that surface.
 */
export async function checkOwnerEmailEligibility(rawEmail: string): Promise<OwnerEmailEligibility> {
  const email = normalisePartnerOperationalEmail(rawEmail);
  if (!PARTNER_OPERATIONAL_EMAIL_RE.test(email)) {
    throw new G5RequestError("VALIDATION_ERROR", "Enter a valid email address.");
  }
  const clash = await findOwnerEmailClash(
    (sql, params) => partnerAdminQuery(sql, params) as never,
    email
  );
  if (!clash) return { email, available: true, conflict: null };

  /*
   * WHAT CAN ACTUALLY BE DONE, per status. Every branch names an authority that exists.
   *
   * REVOKED is TERMINAL by design: `setPartnerUserStatus` refuses `from === "REVOKED"`, removal only
   * sets REVOKED rather than deleting the row, and no authority changes a non-INVITED user's email.
   * The address stays attached to that person's audit, security, grading, station and financial
   * history, which is exactly what makes it safe to keep and unsafe to quietly hand to somebody new.
   */
  const releasable = clash.userStatus === "INVITED";
  const reason =
    clash.userStatus === "REVOKED"
      ? `This email belongs to a revoked user on ${clash.partnerName}. A revoked user keeps its email permanently, because that address is what ties their audit, security, grading and station history to a person. MintVault has no authority that releases it.`
      : clash.userStatus === "INVITED"
        ? `This email has a pending invitation on ${clash.partnerName}.`
        : `This email belongs to a ${clash.userStatus.toLowerCase()} user on ${clash.partnerName}.`;
  const nextAction = releasable
    ? `Change or revoke that pending invitation on ${clash.partnerName} first, or use a different Owner email.`
    : "Use a different Owner email.";
  return { email, available: false, conflict: { ...clash, releasable, reason, nextAction } };
}

export interface DuplicateMatchRow {
  kind: "email" | "legal_name" | "trading_name" | "postcode" | "phone";
  partnerId: string;
  partnerName: string;
  value: string;
}

/**
 * READ-ONLY pre-creation duplicate scan. Writes nothing and audits nothing — it is a lookup the admin
 * performs before deciding, and an audit row for "I typed a name into a box" would be noise.
 *
 * Matching is normalised in SQL (lower/trim for names, digits-only for phone, spaces stripped for
 * postcode) so "ME2 2AA" and "me22aa" collide, which is the whole point. The `email` probe covers BOTH
 * the profile contact address and partner_users, because a user-email collision is the one the invite
 * transaction will actually reject — surfacing it here turns a confusing late failure into an early,
 * explainable one.
 */
export async function findDuplicates(candidate: DuplicateCandidate): Promise<DuplicateMatchRow[]> {
  const out: DuplicateMatchRow[] = [];
  const norm = (s?: string) => (s ?? "").trim();

  const legalName = norm(candidate.legalName);
  const tradingName = norm(candidate.tradingName);
  const email = norm(candidate.email);
  const postcode = norm(candidate.postcode);
  const phone = norm(candidate.phone);

  if (legalName) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string }>(
      `SELECT id, legal_name FROM partner_organisations
        WHERE lower(btrim(regexp_replace(legal_name, '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace($1, '\\s+', ' ', 'g')))
        ORDER BY legal_name, id
        LIMIT 5`,
      [legalName]
    );
    for (const r of rows)
      out.push({ kind: "legal_name", partnerId: r.id, partnerName: r.legal_name, value: r.legal_name });
  }

  if (tradingName) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; trading_name: string }>(
      `SELECT o.id, o.legal_name, p.trading_name
         FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
        WHERE p.trading_name IS NOT NULL
          AND lower(btrim(regexp_replace(p.trading_name, '\\s+', ' ', 'g'))) = lower(btrim(regexp_replace($1, '\\s+', ' ', 'g')))
        ORDER BY o.legal_name, o.id
        LIMIT 5`,
      [tradingName]
    );
    for (const r of rows)
      out.push({ kind: "trading_name", partnerId: r.id, partnerName: r.legal_name, value: r.trading_name });
  }

  if (email) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; email: string }>(
      `SELECT o.id, o.legal_name, p.primary_email AS email
         FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
        WHERE p.primary_email IS NOT NULL AND lower(p.primary_email) = lower($1)
       UNION
       SELECT o.id, o.legal_name, u.email
         FROM partner_users u JOIN partner_organisations o ON o.id = u.tenant_id
        WHERE lower(u.email) = lower($1)
        ORDER BY 2, 1
        LIMIT 5`,
      [email]
    );
    for (const r of rows) out.push({ kind: "email", partnerId: r.id, partnerName: r.legal_name, value: r.email });
  }

  if (postcode) {
    const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; address_postcode: string }>(
      `SELECT o.id, o.legal_name, p.address_postcode
         FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
        WHERE p.address_postcode IS NOT NULL
          AND upper(replace(p.address_postcode, ' ', '')) = upper(replace($1, ' ', ''))
        ORDER BY o.legal_name, o.id
        LIMIT 5`,
      [postcode]
    );
    for (const r of rows)
      out.push({ kind: "postcode", partnerId: r.id, partnerName: r.legal_name, value: r.address_postcode });
  }

  if (phone) {
    const digits = phone.replace(/[^0-9]/g, "");
    if (digits.length >= 7) {
      const { rows } = await partnerAdminQuery<{ id: string; legal_name: string; primary_phone: string }>(
        `SELECT o.id, o.legal_name, p.primary_phone
           FROM partner_profiles p JOIN partner_organisations o ON o.id = p.tenant_id
          WHERE p.primary_phone IS NOT NULL
            AND regexp_replace(p.primary_phone, '[^0-9]', '', 'g') = $1
          ORDER BY o.legal_name, o.id
          LIMIT 5`,
        [digits]
      );
      for (const r of rows)
        out.push({ kind: "phone", partnerId: r.id, partnerName: r.legal_name, value: r.primary_phone });
    }
  }

  // De-duplicate: the same partner matching the same way twice (e.g. two users sharing an address)
  // should be reported once.
  const seen = new Set<string>();
  return out.filter((m) => {
    const k = `${m.kind}:${m.partnerId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function updateProfile(
  actor: ActorContext,
  partnerId: string,
  fields: Record<string, unknown>,
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  await loadOrInitProfileVersion(org.id);
  return withAudit(actor, org.id, "profile_updated", reason, { fields: Object.keys(fields) }, async () => {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const f of PROFILE_FIELDS) {
      if (f in fields) {
        params.push(fields[f] === "" ? null : fields[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    params.push(org.id, expectedVersion);
    const r = await partnerAdminQuery(
      `UPDATE partner_profiles SET ${sets.length ? sets.join(", ") + "," : ""} version = version + 1, updated_at = now()
         WHERE tenant_id = $${params.length - 1} AND version = $${params.length}`,
      params
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The profile was modified by someone else; reload and retry.");
    return {
      result: { updated: true },
      entityType: "profile",
      entityId: org.id,
      afterState: { fields: Object.keys(fields) },
    };
  });
}

export async function changeStatus(
  actor: ActorContext,
  partnerId: string,
  toStatus: string,
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (!isPartnerStatus(toStatus)) throw new G5RequestError("INVALID_PARTNER_STATUS", "Unknown partner status.");
  if (!canTransitionStatus(org.status, toStatus)) {
    throw new G5RequestError("INVALID_STATUS_TRANSITION", `Cannot move a partner from ${org.status} to ${toStatus}.`);
  }
  await loadOrInitProfileVersion(org.id);
  return withAudit(actor, org.id, "status_changed", reason, { from: org.status }, async () => {
    // An ACTIVE organisation MUST own a wallet: every credit read and the Super Admin
    // /credits/adjust route resolve the wallet first and fail with WALLET_NOT_FOUND without one,
    // which blocks funding and therefore blocks submission acceptance entirely. ensureWallet has
    // existed since G6A but had no caller anywhere in server/, so no org ever got one.
    //
    // Deliberately BEFORE the status write, not after. changeStatus runs on the auto-commit admin
    // pool, so the two writes cannot share a transaction without converting this shipped G5 path to
    // withPartnerAdminTransaction. Ordering gives the same safety for free by choosing the benign
    // failure: if provisioning throws, the status write never runs and the org stays as it was
    // (retry is clean). The reverse order risks the exact state this fixes — ACTIVE with no wallet.
    // The residue when a LATER step fails is a wallet on a non-activated org: zero credits, zero
    // ledger rows, invisible to every surface, and reused verbatim if that org activates later.
    //
    // Safe to run on every transition into ACTIVE (including SUSPENDED → ACTIVE): ensureWallet is
    // idempotent via ON CONFLICT (tenant_id) DO NOTHING plus a definitive re-read, and creates NO
    // ledger row — so a re-activated partner keeps its existing wallet, balance and history.
    let walletProvisioned = false;
    if (toStatus === "ACTIVE") {
      const wallet = await ensureWallet({ actorUserId: actor.actorUserId, actorEmail: actor.actorEmail }, org.id);
      walletProvisioned = !!wallet;
    }

    // Bump the aggregate version under optimistic lock AND set the status in ONE data-modifying-CTE
    // statement, so the two writes are atomic (no "version bumped but status unchanged" window) without
    // a transaction helper. If the version no longer matches, the CTE yields no rows and the org UPDATE
    // affects 0 rows → VERSION_CONFLICT. Business-label only — no flags, portal, slots, users,
    // devices, or sessions are touched. (A wallet IS now provisioned on activation, above.)
    const r = await partnerAdminQuery(
      `WITH bumped AS (
         UPDATE partner_profiles SET version = version + 1, updated_at = now()
           WHERE tenant_id = $1 AND version = $2 RETURNING tenant_id
       )
       UPDATE partner_organisations o SET status = $3, updated_at = now()
         FROM bumped WHERE o.id = bumped.tenant_id`,
      [org.id, expectedVersion, toStatus]
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The partner was modified by someone else; reload and retry.");
    return {
      result: { status: toStatus as PartnerStatus },
      entityType: "partner",
      entityId: org.id,
      afterState: { from: org.status, to: toStatus, walletProvisioned },
    };
  });
}

export async function addContact(
  actor: ActorContext,
  partnerId: string,
  input: {
    fullName: string;
    contactType: string;
    email: string | null;
    phone: string | null;
    title: string | null;
    isPrimary: boolean;
  },
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (input.isPrimary) {
    const dup = await partnerAdminQuery(
      `SELECT 1 FROM partner_contacts WHERE tenant_id = $1 AND is_primary AND active LIMIT 1`,
      [org.id]
    );
    if (dup.rows.length > 0)
      throw new G5RequestError(
        "DUPLICATE_PRIMARY_CONTACT",
        "An active primary contact already exists for this partner."
      );
  }
  return withAudit(actor, org.id, "contact_added", reason, null, async () => {
    const r = await partnerAdminQuery<{ id: string }>(
      `INSERT INTO partner_contacts (tenant_id, full_name, title, email, phone, contact_type, is_primary, created_by_user_id, created_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        org.id,
        input.fullName,
        input.title,
        input.email,
        input.phone,
        input.contactType,
        input.isPrimary,
        actor.actorUserId,
        actor.actorEmail,
      ]
    );
    return {
      result: { contactId: r.rows[0].id },
      entityType: "contact",
      entityId: r.rows[0].id,
      afterState: { contactType: input.contactType, isPrimary: input.isPrimary },
    };
  });
}

export async function updateContact(
  actor: ActorContext,
  partnerId: string,
  contactId: string,
  fields: {
    fullName?: string;
    title?: string | null;
    email?: string | null;
    phone?: string | null;
    contactType?: string;
    isPrimary?: boolean;
  },
  expectedVersion: number,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const existing = await partnerAdminQuery<{ id: string; is_primary: boolean }>(
    `SELECT id, is_primary FROM partner_contacts WHERE id = $1 AND tenant_id = $2`,
    [contactId, org.id]
  );
  if (existing.rows.length === 0) throw new G5RequestError("CONTACT_NOT_FOUND", "Contact not found for this partner.");
  if (fields.isPrimary === true && !existing.rows[0].is_primary) {
    const dup = await partnerAdminQuery(
      `SELECT 1 FROM partner_contacts WHERE tenant_id = $1 AND is_primary AND active AND id <> $2 LIMIT 1`,
      [org.id, contactId]
    );
    if (dup.rows.length > 0)
      throw new G5RequestError(
        "DUPLICATE_PRIMARY_CONTACT",
        "An active primary contact already exists for this partner."
      );
  }
  return withAudit(actor, org.id, "contact_updated", reason, null, async () => {
    const map: Record<string, unknown> = {};
    if (fields.fullName !== undefined) map.full_name = fields.fullName;
    if (fields.title !== undefined) map.title = fields.title;
    if (fields.email !== undefined) map.email = fields.email;
    if (fields.phone !== undefined) map.phone = fields.phone;
    if (fields.contactType !== undefined) map.contact_type = fields.contactType;
    if (fields.isPrimary !== undefined) map.is_primary = fields.isPrimary;
    const cols = Object.keys(map);
    const params: unknown[] = cols.map((c) => map[c]);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    params.push(contactId, org.id, expectedVersion);
    const r = await partnerAdminQuery(
      `UPDATE partner_contacts SET ${sets.length ? sets.join(", ") + "," : ""} version = version + 1, updated_at = now()
         WHERE id = $${params.length - 2} AND tenant_id = $${params.length - 1} AND version = $${params.length}`,
      params
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The contact was modified by someone else; reload and retry.");
    return { result: { updated: true }, entityType: "contact", entityId: contactId, afterState: { fields: cols } };
  });
}

export async function deactivateContact(actor: ActorContext, partnerId: string, contactId: string, reason: string) {
  const org = await loadPartner(partnerId);
  const existing = await partnerAdminQuery(`SELECT 1 FROM partner_contacts WHERE id = $1 AND tenant_id = $2`, [
    contactId,
    org.id,
  ]);
  if (existing.rows.length === 0) throw new G5RequestError("CONTACT_NOT_FOUND", "Contact not found for this partner.");
  return withAudit(actor, org.id, "contact_deactivated", reason, null, async () => {
    // soft deactivation (never DELETE) — clears the primary flag so a new primary can be set.
    await partnerAdminQuery(
      `UPDATE partner_contacts SET active = false, is_primary = false, version = version + 1, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [contactId, org.id]
    );
    return { result: { deactivated: true }, entityType: "contact", entityId: contactId, afterState: { active: false } };
  });
}

export async function upsertBranding(
  actor: ActorContext,
  partnerId: string,
  fields: Record<string, unknown>,
  expectedVersion: number | null,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const BRANDING_FIELDS = [
    "display_name",
    "logo_r2_key",
    "primary_colour",
    "secondary_colour",
    "accent_colour",
    "support_email",
    "support_website",
    "custom_domain",
    "branding_status",
  ];
  return withAudit(actor, org.id, "branding_updated", reason, null, async () => {
    const existing = await partnerAdminQuery<{ version: number }>(
      `SELECT version FROM partner_branding WHERE tenant_id = $1`,
      [org.id]
    );
    if (existing.rows.length === 0) {
      const cols = BRANDING_FIELDS.filter((f) => f in fields);
      const vals = cols.map((c) => (fields[c] === "" ? null : fields[c]));
      const placeholders = cols.map((_, i) => `$${i + 2}`);
      await partnerAdminQuery(
        `INSERT INTO partner_branding (tenant_id${cols.length ? ", " + cols.join(", ") : ""}) VALUES ($1${placeholders.length ? ", " + placeholders.join(", ") : ""})`,
        [org.id, ...vals]
      );
      return { result: { ok: true as const }, entityType: "branding", entityId: org.id, afterState: { fields: cols } };
    }
    if (expectedVersion !== null && existing.rows[0].version !== expectedVersion) {
      throw new G5RequestError("VERSION_CONFLICT", "The branding was modified by someone else; reload and retry.");
    }
    const cols = BRANDING_FIELDS.filter((f) => f in fields);
    const params: unknown[] = cols.map((c) => (fields[c] === "" ? null : fields[c]));
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    params.push(org.id, existing.rows[0].version);
    const r = await partnerAdminQuery(
      `UPDATE partner_branding SET ${sets.length ? sets.join(", ") + "," : ""} version = version + 1, updated_at = now()
         WHERE tenant_id = $${params.length - 1} AND version = $${params.length}`,
      params
    );
    if (r.rowCount === 0)
      throw new G5RequestError("VERSION_CONFLICT", "The branding was modified by someone else; reload and retry.");
    return { result: { ok: true as const }, entityType: "branding", entityId: org.id, afterState: { fields: cols } };
  });
}

export async function addNote(
  actor: ActorContext,
  partnerId: string,
  body: string,
  supersedesNoteId: string | null,
  reason: string
) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "note_added", reason, null, async () => {
    const r = await partnerAdminQuery<{ id: string }>(
      `INSERT INTO partner_internal_notes (tenant_id, body, author_user_id, author_email, supersedes_note_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [org.id, body, actor.actorUserId, actor.actorEmail, supersedesNoteId]
    );
    return { result: { noteId: r.rows[0].id }, entityType: "note", entityId: r.rows[0].id, afterState: null };
  });
}

// ---------------------------------------------------------------------------
// Partner user management + invitations
// ---------------------------------------------------------------------------
export const ADMIN_ROLE_TO_PARTNER_ROLE = {
  OWNER: "PARTNER_OWNER",
  ADMIN: "PARTNER_MANAGER",
  GRADER: "MVGS_ASSESSMENT_TECHNICIAN",
  STAFF: "PARTNER_RECEPTION",
  // AG-2. A role nobody can be given is not a role, so SCANNER_OPERATOR is assignable from both
  // the Super Admin console and the partner's own Staff area.
  SCANNER_OPERATOR: "SCANNER_OPERATOR",
} as const;
export type AdminPartnerRole = keyof typeof ADMIN_ROLE_TO_PARTNER_ROLE;

const PARTNER_ROLE_TO_ADMIN_ROLE: Record<string, AdminPartnerRole> = {
  PARTNER_OWNER: "OWNER",
  PARTNER_MANAGER: "ADMIN",
  MVGS_ASSESSMENT_TECHNICIAN: "GRADER",
  SCANNER_OPERATOR: "SCANNER_OPERATOR",
  PARTNER_RECEPTION: "STAFF",
};
const ADMIN_ROLE_PRECEDENCE = [
  "PARTNER_OWNER",
  "PARTNER_MANAGER",
  "MVGS_ASSESSMENT_TECHNICIAN",
  "PARTNER_RECEPTION",
] as const;

export function isAdminPartnerRole(raw: unknown): raw is AdminPartnerRole {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(ADMIN_ROLE_TO_PARTNER_ROLE, raw);
}

function displayAdminRole(roleCodes: string[]): AdminPartnerRole | string {
  for (const code of ADMIN_ROLE_PRECEDENCE) {
    if (roleCodes.includes(code)) return PARTNER_ROLE_TO_ADMIN_ROLE[code];
  }
  return roleCodes[0] ?? "UNASSIGNED";
}

const INVITE_HOURS = 72;

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function inviteLink(token: string): string {
  return `${APP_BASE_URL}/partner/invite?token=${encodeURIComponent(token)}`;
}

function adminInviteLinkCopyAllowed(): boolean {
  if (process.env.PARTNER_INVITE_ALLOW_ADMIN_LINK_COPY !== "true") return false;
  const appUrl = process.env.APP_URL ?? "";
  const appName = process.env.FLY_APP_NAME ?? "";
  const staging = appName === "mintvault-v2" || appUrl.includes("mintvault-v2.fly.dev");
  const local = process.env.NODE_ENV !== "production" || appUrl.includes("localhost") || appUrl.includes("127.0.0.1");
  return staging || local;
}

async function activeOwnerCount(tenantId: string, exceptUserId?: string): Promise<number> {
  const { rows } = await partnerAdminQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM partner_users u
       JOIN partner_user_roles ur ON ur.user_id = u.id
       JOIN partner_roles r ON r.id = ur.role_id
      WHERE u.tenant_id = $1
        AND u.status = 'ACTIVE'
        AND r.code = 'PARTNER_OWNER'
        AND ($2::uuid IS NULL OR u.id <> $2::uuid)`,
    [tenantId, exceptUserId ?? null]
  );
  return rows[0]?.n ?? 0;
}

async function ensureCanRemoveOwner(tenantId: string, userId: string): Promise<void> {
  const { rows } = await partnerAdminQuery<{ is_owner: boolean; status: string }>(
    `SELECT u.status, EXISTS (
       SELECT 1 FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id
        WHERE ur.user_id = u.id AND r.code = 'PARTNER_OWNER'
     ) AS is_owner
       FROM partner_users u WHERE u.tenant_id=$1 AND u.id=$2`,
    [tenantId, userId]
  );
  if (rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
  if (rows[0].status === "ACTIVE" && rows[0].is_owner && (await activeOwnerCount(tenantId, userId)) === 0) {
    throw new G5RequestError("FINAL_OWNER_REQUIRED", "A partner must keep at least one active owner.");
  }
}

async function createInvitationRecord(
  client: PoolClient,
  actor: ActorContext,
  tenantId: string,
  userId: string,
  email: string,
  roleCode: string,
  action: AuditAction,
  reason: string
): Promise<{
  invitationId: string;
  deliveryStatus: string;
  invitationLink?: string;
  delivery: { email: string; token: string; partnerName: string; roleCode: string; expiresAt: Date; recipientName: string };
}> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 60 * 60 * 1000);
  const previous = await client.query<{ id: string }>(
    `UPDATE partner_invitations
        SET status='REVOKED', revoked_at=now(), updated_at=now()
      WHERE tenant_id=$1 AND user_id=$2 AND status IN ('PENDING','SENT','DELIVERY_FAILED')
      RETURNING id`,
    [tenantId, userId]
  );
  maybeFailInvitePartnerForTest("before_invitation_insert");
  /*
   * The recipient's stored name comes back with the insert, so BOTH the initial invitation and every
   * resend address the person the same way from the same canonical row.
   */
  const { rows } = await client.query<{
    id: string;
    partner_name: string;
    first_name: string | null;
    last_name: string | null;
  }>(
    `WITH ins AS (
       INSERT INTO partner_invitations
         (tenant_id, user_id, email, role_code, token_hash, invited_by_user_id, invited_by_email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id
     )
     SELECT ins.id, o.legal_name AS partner_name, pu.first_name, pu.last_name
       FROM ins, partner_organisations o, partner_users pu
      WHERE o.id=$1 AND pu.id=$2`,
    [tenantId, userId, email, roleCode, sha256(token), actor.actorUserId, actor.actorEmail, expiresAt]
  );
  if (previous.rows.length > 0) {
    await client.query("UPDATE partner_invitations SET superseded_by=$1 WHERE id = ANY($2::uuid[])", [
      rows[0].id,
      previous.rows.map((r) => r.id),
    ]);
  }
  maybeFailInvitePartnerForTest("before_invitation_audit");
  await client.query(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, after_state, reason, result)
     VALUES ($1,$2,$3,$4,$5,$6,'partner_user',$7,$8,$9,'succeeded')`,
    [
      tenantId,
      action,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      userId,
      JSON.stringify({ invitationId: rows[0].id, roleCode, deliveryStatus: "DELIVERY_NOT_CONFIGURED" }),
      reason,
    ]
  );
  return {
    invitationId: rows[0].id,
    deliveryStatus: "DELIVERY_NOT_CONFIGURED",
    delivery: {
      email,
      token,
      partnerName: rows[0].partner_name,
      roleCode,
      expiresAt,
      recipientName: partnerDisplayName({ firstName: rows[0].first_name, lastName: rows[0].last_name, email }),
    },
    invitationLink: adminInviteLinkCopyAllowed() ? inviteLink(token) : undefined,
  };
}

async function recordInvitationDelivery(invite: {
  invitationId: string;
  deliveryStatus: string;
  delivery: { email: string; token: string; partnerName: string; roleCode: string; expiresAt: Date; recipientName: string };
}): Promise<string> {
  if (!invitationDeliveryConfigured()) return invite.deliveryStatus;
  try {
    await deliverInvitationToken(invite.delivery);
    const delivered = await partnerAdminQuery(
      "UPDATE partner_invitations SET status='SENT', delivered_at=now(), delivery_error=NULL, updated_at=now() WHERE id=$1 AND status='PENDING'",
      [invite.invitationId]
    );
    if ((delivered.rowCount ?? 0) === 0) return invite.deliveryStatus;
    return "SENT";
  } catch (err) {
    const failed = await partnerAdminQuery(
      "UPDATE partner_invitations SET status='DELIVERY_FAILED', delivery_error=$2, updated_at=now() WHERE id=$1 AND status='PENDING'",
      [invite.invitationId, (err as Error).message.slice(0, 500)]
    );
    if ((failed.rowCount ?? 0) === 0) return invite.deliveryStatus;
    return "DELIVERY_FAILED";
  }
}

export async function invitePartnerUser(
  actor: ActorContext,
  partnerId: string,
  input: { firstName: string; lastName: string; email: string; role: AdminPartnerRole },
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (org.status === "SUSPENDED" || org.status === "REVOKED") {
    throw new G5RequestError("PARTNER_UNAVAILABLE", "Partner is not available for invitations.");
  }
  const email = normaliseEmail(input.email);
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName || !email) throw new G5RequestError("VALIDATION_ERROR", "Name and email are required.");
  const roleCode = ADMIN_ROLE_TO_PARTNER_ROLE[input.role];
  const committed = await withPartnerAdminTransaction(async (client) => {
    if ((await client.query("SELECT 1 FROM partner_users WHERE lower(email)=lower($1) LIMIT 1", [email])).rows.length) {
      throw new G5RequestError("DUPLICATE_PARTNER_USER", "A partner user with this email already exists.");
    }
    await maybeWaitInviteBarrierForTest("after_duplicate_check");
    const role = await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [roleCode]);
    if (role.rows.length !== 1) {
      throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
    }
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, before_state, reason, result)
       VALUES ($1,'partner_user_invited',$2,$3,$4,$5,'partner_user',$6,'__attempt__','attempted')`,
      [
        org.id,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        JSON.stringify({ email, roleCode }),
      ]
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO partner_users (tenant_id, partner_id, email, first_name, last_name, status, created_by)
       VALUES ($1,$1,$2,$3,$4,'INVITED',$5) RETURNING id`,
      [org.id, email, firstName, lastName, actor.actorUserId]
    );
    maybeFailInvitePartnerForTest("after_user_insert");
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      org.id,
      user.rows[0].id,
      role.rows[0].id,
    ]);
    maybeFailInvitePartnerForTest("after_role_assignment");
    const invite = await createInvitationRecord(
      client,
      actor,
      org.id,
      user.rows[0].id,
      email,
      roleCode,
      "partner_user_invited",
      reason
    );
    return { userId: user.rows[0].id, invite };
  });
  const { delivery, ...invite } = committed.invite;
  invite.deliveryStatus = await recordInvitationDelivery({ ...invite, delivery });
  return { result: { userId: committed.userId, ...invite }, alreadyCompleted: false };
}

/**
 * Amend a PENDING invitation: correct the name, the email address, or the role, and re-issue it.
 *
 * DESIGN NOTE — why this is "amend and re-issue" rather than "edit in place". An invitation that has
 * already left the building is not a draft: a token addressed to the old inbox is live until it is
 * revoked. Silently changing the recipient column while leaving that token valid would mean a typo'd
 * address keeps a working key to the account — a real security hole dressed up as a convenience
 * feature. So changing the details always revokes the outstanding token and mints a new one for the
 * corrected address. `createInvitationRecord` performs the revoke-then-insert in the same transaction
 * and stamps `superseded_by`, so the chain of who-replaced-what is preserved.
 *
 * AUDIT ACTION: `partner_invitation_amended`, added by migration 0033. This previously borrowed
 * `partner_user_invited` because the CHECK constraint permitted nothing better. The distinction
 * matters to an auditor: "a new invitation was issued" and "an existing invitation was redirected to
 * a different address" are very different events.
 *
 * The ledger records BOTH sides of the correction: an `attempted` row carrying the previous
 * name/email/role as `before_state`, and the terminal `succeeded` row carrying the new address and
 * role in `after_state`. Without the new-address half, the ledger could say an invitation was
 * redirected but not where to — which is the one question an audit of this action must answer.
 *
 * Only INVITED users are amendable. Once an invitation is accepted the person exists, and their
 * details are changed through the role/status controls, not by rewriting history.
 */
export async function amendPendingInvitation(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  input: { firstName: string; lastName: string; email: string; role: AdminPartnerRole },
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (org.status === "SUSPENDED" || org.status === "REVOKED") {
    throw new G5RequestError("PARTNER_UNAVAILABLE", "Partner is not available for invitations.");
  }
  const email = normaliseEmail(input.email);
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName || !email) throw new G5RequestError("VALIDATION_ERROR", "Name and email are required.");
  const roleCode = ADMIN_ROLE_TO_PARTNER_ROLE[input.role];

  /*
   * LEDGER: one `attempted` row written on a SEPARATE pooled connection BEFORE the transaction, so
   * it survives a rollback — this is what makes a REJECTED amend (already accepted, duplicate email,
   * wrong tenant) visible in the audit trail at all, matching how withAudit behaves for the
   * mutations that use it. It carries BOTH sides of the correction: the previous identity in
   * before_state and the intended new identity in after_state, so the ledger answers "redirected
   * from whom, to whom" without having to parse the reason text.
   *
   * The pre-read here is advisory only; the authoritative check is the FOR UPDATE re-read inside the
   * transaction below.
   */
  const prior = await partnerAdminQuery<{ email: string; first_name: string; last_name: string }>(
    "SELECT email, first_name, last_name FROM partner_users WHERE tenant_id=$1 AND id=$2",
    [org.id, userId]
  );
  await partnerAdminQuery(
    `INSERT INTO partner_management_audit
       (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, after_state, reason, result)
     VALUES ($1,'partner_invitation_amended',$2,$3,$4,$5,'partner_user',$6,$7,$8,'__attempt__','attempted')`,
    [
      org.id,
      actor.actorUserId,
      actor.actorEmail,
      actor.requestId,
      actor.idempotencyKey ?? null,
      userId,
      prior.rows[0]
        ? JSON.stringify({
            email: prior.rows[0].email,
            firstName: prior.rows[0].first_name,
            lastName: prior.rows[0].last_name,
          })
        : null,
      JSON.stringify({ intent: "amend_pending_invitation", email, roleCode, firstName, lastName }),
    ]
  );

  const committed = await withPartnerAdminTransaction(async (client) => {
    const existing = await client.query<{
      id: string;
      email: string;
      first_name: string;
      last_name: string;
      status: string;
    }>("SELECT id, email, first_name, last_name, status FROM partner_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      org.id,
      userId,
    ]);
    if (existing.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    const before = existing.rows[0];
    if (before.status !== "INVITED") {
      throw new G5RequestError(
        "INVITATION_NOT_AMENDABLE",
        "This invitation has already been accepted. Change the person's role or status instead."
      );
    }

    // Same duplicate rule the original invite enforces, but scoped to OTHER users — re-saving the
    // form without changing the address must not report the invitation as a duplicate of itself.
    const clash = await client.query("SELECT 1 FROM partner_users WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1", [
      email,
      userId,
    ]);
    if (clash.rows.length) {
      throw new G5RequestError("DUPLICATE_PARTNER_USER", "A partner user with this email already exists.");
    }

    const roleRow = await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [roleCode]);
    if (roleRow.rows.length !== 1) {
      throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
    }

    await client.query("UPDATE partner_users SET email=$1, first_name=$2, last_name=$3, updated_at=now() WHERE id=$4", [
      email,
      firstName,
      lastName,
      userId,
    ]);
    await client.query("DELETE FROM partner_user_roles WHERE tenant_id=$1 AND user_id=$2", [org.id, userId]);
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      org.id,
      userId,
      roleRow.rows[0].id,
    ]);

    // Revokes the outstanding token and issues a replacement, stamping superseded_by.
    const invite = await createInvitationRecord(
      client,
      actor,
      org.id,
      userId,
      email,
      roleCode,
      "partner_invitation_amended",
      `${reason} [amended from ${before.first_name} ${before.last_name} <${before.email}>]`
    );
    return { invite };
  });

  const { delivery, ...invite } = committed.invite;
  /*
   * The transaction has COMMITTED. recordInvitationDelivery guards the provider send, but its own
   * bookkeeping UPDATEs are unguarded, so a pool blip there would throw out of this function and be
   * reported as a 500 — telling the operator the amendment failed when the old token is already dead
   * and the new one already exists. Degrade to an explicit unknown status instead of lying.
   */
  try {
    invite.deliveryStatus = await recordInvitationDelivery({ ...invite, delivery });
  } catch (err) {
    console.error(
      "[partner-management] invitation amended and COMMITTED, but delivery bookkeeping failed:",
      (err as { message?: string })?.message ?? err
    );
    invite.deliveryStatus = "DELIVERY_STATUS_UNKNOWN";
  }
  return { result: { userId, ...invite }, alreadyCompleted: false };
}

export async function listPartnerUsers(partnerId: string) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.status, u.last_login_at, u.created_at,
            u.mfa_enabled, u.mfa_required,
            (u.password_hash IS NOT NULL AND u.password_set_at IS NOT NULL) AS password_configured,
            u.password_set_at AS password_configured_at,
            EXISTS (
              SELECT 1 FROM partner_mfa_methods m
               WHERE m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.method='totp'
                 AND m.status='ACTIVE' AND m.secret_ref IS NOT NULL
            ) AS mfa_configured,
            (SELECT count(*)::int FROM partner_sessions s
              WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.revoked_at IS NULL
                AND s.absolute_expires_at > now()) AS active_sessions,
            COALESCE(json_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '[]') AS role_codes,
            li.status AS invitation_status, li.expires_at AS invitation_expires_at,
            li.delivered_at AS invitation_delivered_at, li.consumed_at AS invitation_consumed_at,
            li.created_at AS invitation_created_at
       FROM partner_users u
       LEFT JOIN partner_user_roles ur ON ur.user_id = u.id
       LEFT JOIN partner_roles r ON r.id = ur.role_id
       LEFT JOIN LATERAL (
         SELECT status, expires_at, delivered_at, consumed_at, created_at FROM partner_invitations i
          WHERE i.tenant_id = u.tenant_id AND i.user_id = u.id
          ORDER BY i.created_at DESC LIMIT 1
       ) li ON true
      WHERE u.tenant_id = $1
      GROUP BY u.id, li.status, li.expires_at, li.delivered_at, li.consumed_at, li.created_at
      ORDER BY u.created_at DESC, u.email ASC
      LIMIT 500`,
    [org.id]
  );
  return {
    users: rows.map((u: any) => ({
      ...u,
      role: displayAdminRole(u.role_codes ?? []),
      role_codes: undefined,
    })),
  };
}

export interface PartnerLoginReadiness {
  organisationActive: boolean;
  userActive: boolean;
  invitationValid: boolean;
  passwordConfigured: boolean;
  passwordConfiguredAt: string | null;
  mfaRequired: boolean;
  mfaConfigured: boolean;
  locationEligible: boolean;
  loginEnabled: boolean;
  loginFlagEnabled: boolean;
  portalEnabled: boolean;
  /**
   * Whether this tenant has at least one APPROVED, ACTIVE station.
   * `null` means the station subsystem is not present on this database (migration 0045 unapplied),
   * which is DIFFERENT from "no station yet" and must not be reported as either ready or blocked.
   */
  stationReady: boolean | null;
  onboardingState:
    | "INVITED"
    | "AWAITING_PASSWORD_SETUP"
    | "AWAITING_MFA_SETUP"
    | "STATION_SETUP_REQUIRED"
    | "READY_TO_LOG_IN"
    | "SUSPENDED"
    | "REVOKED"
    | "LOGIN_BLOCKED";
  blockedReasons: string[];
}

function buildLoginReadiness(
  row: {
    org_status: string;
    user_status: string;
    password_configured: boolean;
    password_configured_at: string | null;
    mfa_required: boolean;
    mfa_configured: boolean;
    location_eligible: boolean;
    invitation_status: string | null;
    invitation_expires_at: string | null;
  },
  portalEnabled: boolean,
  loginFlagEnabled: boolean,
  stationReady: boolean | null
): PartnerLoginReadiness {
  const organisationActive = row.org_status === "ACTIVE";
  const userActive = row.user_status === "ACTIVE";
  const passwordConfigured = row.password_configured === true;
  const mfaRequired = row.mfa_required === true;
  const mfaConfigured = row.mfa_configured === true;
  const locationEligible = row.location_eligible === true;
  const invitationValid =
    !!row.invitation_status &&
    ["PENDING", "SENT", "DELIVERY_FAILED"].includes(row.invitation_status) &&
    !!row.invitation_expires_at &&
    new Date(row.invitation_expires_at).getTime() > Date.now();
  const blockedReasons: string[] = [];
  if (!portalEnabled) blockedReasons.push("Partner portal is disabled.");
  if (!loginFlagEnabled) blockedReasons.push("Partner login is disabled.");
  if (!organisationActive) blockedReasons.push(`Organisation is ${row.org_status}.`);
  if (!userActive) blockedReasons.push(`Partner user is ${row.user_status}.`);
  if (!passwordConfigured) {
    blockedReasons.push(
      invitationValid
        ? "Partner must accept the current invitation and create a password."
        : "No valid invitation is available for the partner to create a password."
    );
  }
  if (passwordConfigured && mfaRequired && !mfaConfigured) {
    blockedReasons.push("Partner must enrol an MFA authenticator before the portal is available.");
  }
  if (!locationEligible) blockedReasons.push("Partner user has no active eligible location.");
  // A partner with no approved station can sign in but cannot perform the pilot's core action
  // (capture a card), so reporting them simply "READY" overstates readiness. `null` means the
  // station subsystem is absent from this database, which is not the partner's problem and must not
  // be surfaced as a blocked reason.
  if (stationReady === false) {
    blockedReasons.push("No approved station is enrolled for this partner — capture is unavailable.");
  }

  /*
   * STATE DERIVATION. Three corrections to what this previously reported:
   *
   * 1. REVOKED was collapsed into SUSPENDED. Revocation is terminal; suspension is reversible.
   *    Reporting a revoked account as "suspended" reads to an operator as "reactivate it", which is
   *    not possible, so the two are now distinct.
   *
   * 2. INVITED ignored `invitationValid`, which was computed directly above and then never used in
   *    this expression. A user whose invitation had EXPIRED still reported INVITED, so an operator
   *    waited for an acceptance that could never arrive instead of resending. An INVITED user with a
   *    dead invitation now falls through to AWAITING_PASSWORD_SETUP, whose blockedReasons already
   *    carry the accurate "No valid invitation is available…" line.
   *
   * 3. STATION_SETUP_REQUIRED did not exist at all, so a partner with no station reported
   *    READY_TO_LOG_IN — true for login, misleading for readiness.
   */
  const orgTerminal = row.org_status === "REVOKED" || row.user_status === "REVOKED";
  const orgSuspended = row.org_status === "SUSPENDED" || row.user_status === "SUSPENDED";
  const onboardingState: PartnerLoginReadiness["onboardingState"] = orgTerminal
    ? "REVOKED"
    : orgSuspended
      ? "SUSPENDED"
      : row.user_status === "INVITED" && invitationValid
        ? "INVITED"
        : !passwordConfigured
          ? "AWAITING_PASSWORD_SETUP"
          : mfaRequired && !mfaConfigured
            ? "AWAITING_MFA_SETUP"
            : portalEnabled && loginFlagEnabled && organisationActive && userActive && locationEligible
              ? stationReady === false
                ? "STATION_SETUP_REQUIRED"
                : "READY_TO_LOG_IN"
              : "LOGIN_BLOCKED";
  return {
    organisationActive,
    userActive,
    invitationValid,
    passwordConfigured,
    passwordConfiguredAt: row.password_configured_at,
    mfaRequired,
    mfaConfigured,
    locationEligible,
    stationReady,
    // loginEnabled is deliberately NOT gated on the station: a partner with no station must still be
    // able to sign in — that is how they reach the station-enrolment screen. Station readiness is
    // reported separately, via onboardingState and blockedReasons.
    loginEnabled:
      portalEnabled &&
      loginFlagEnabled &&
      organisationActive &&
      userActive &&
      passwordConfigured &&
      (!mfaRequired || mfaConfigured) &&
      locationEligible,
    loginFlagEnabled,
    portalEnabled,
    onboardingState,
    blockedReasons,
  };
}

function guidedReadinessHref(partnerId: string, dimension: ReadinessDimensionKey): string | undefined {
  const guide = `/admin/partners/${encodeURIComponent(partnerId)}/onboarding`;
  if (dimension === "organisation") return `${guide}?step=shop`;
  if (dimension === "location" || dimension === "delivery") return `${guide}?step=location`;
  if (dimension === "operationsContact") return `${guide}?step=contact`;
  if (dimension === "owner") return `${guide}?step=owner`;
  if (dimension === "station" || dimension === "scanner") return `/admin/partners/${encodeURIComponent(partnerId)}/stations`;
  if (dimension === "credits") return `/admin/partners/${encodeURIComponent(partnerId)}/credits`;
  return undefined;
}

function attachGuidedReadinessActions(
  readiness: PartnerOperationalReadiness,
  partnerId: string
): PartnerOperationalReadiness {
  const withHref = (action: ReadinessAction, dimension: ReadinessDimensionKey): ReadinessAction =>
    action.audience === "SUPER_ADMIN" && !action.href
      ? { ...action, href: guidedReadinessHref(partnerId, dimension) }
      : action;
  const dimensions = {} as PartnerOperationalReadiness["dimensions"];
  for (const dimension of Object.keys(readiness.dimensions) as ReadinessDimensionKey[]) {
    dimensions[dimension] = {
      ...readiness.dimensions[dimension],
      actions: readiness.dimensions[dimension].actions.map((action) => withHref(action, dimension)),
    };
  }
  return {
    ...readiness,
    dimensions,
    actions: readiness.actions.map((action) => ({
      ...withHref(action, action.dimension),
      dimension: action.dimension,
      code: action.code,
    })),
  };
}

export async function getPartnerOnboardingReadiness(partnerId: string) {
  const org = await loadPartner(partnerId);
  let portalEnabled = false;
  let loginFlagEnabled = false;
  /*
   * Tracked separately from the values themselves. resolveGlobalFlag() already fails closed to
   * false, which is correct for a gate but wrong as an input to readiness: `partner_emergency_stop`
   * reading false would mean "nothing is stopped", so an unreadable flag table would be reported as
   * calm. Readiness therefore distinguishes "read it, it was off" from "could not read it".
   */
  let flagsReadable = true;
  let emergencyStop = false;
  try {
    const { resolveGlobalFlag } = await import("./flags");
    [portalEnabled, loginFlagEnabled, emergencyStop] = await Promise.all([
      resolveGlobalFlag("partner_portal_enabled"),
      resolveGlobalFlag("partner_login_enabled"),
      resolveGlobalFlag("partner_emergency_stop"),
    ]);
  } catch {
    portalEnabled = false;
    flagsReadable = false;
  }
  const { rows } = await partnerAdminQuery(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.status AS user_status,
            o.status AS org_status, u.last_login_at,
            (u.password_hash IS NOT NULL AND u.password_set_at IS NOT NULL) AS password_configured,
            u.password_set_at AS password_configured_at, u.mfa_required,
            EXISTS (
              SELECT 1 FROM partner_mfa_methods m
               WHERE m.tenant_id=u.tenant_id AND m.user_id=u.id AND m.method='totp'
                 AND m.status='ACTIVE' AND m.secret_ref IS NOT NULL
            ) AS mfa_configured,
            EXISTS (
              SELECT 1 FROM partner_locations l
               LEFT JOIN partner_user_locations ul ON ul.tenant_id=l.tenant_id AND ul.location_id=l.id AND ul.user_id=u.id
               WHERE l.tenant_id=u.tenant_id AND l.status='ACTIVE'
                 AND (ul.user_id IS NOT NULL OR EXISTS (
                   SELECT 1 FROM partner_user_roles our
                   JOIN partner_roles orole ON orole.id=our.role_id
                   WHERE our.tenant_id=u.tenant_id AND our.user_id=u.id
                     AND orole.code IN ('PARTNER_OWNER','PARTNER_MANAGER','PARTNER_FINANCE_VIEWER')
                 ))
            ) AS location_eligible,
            COALESCE(json_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '[]') AS role_codes,
            (SELECT count(*)::int FROM partner_sessions s
              WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.revoked_at IS NULL
                AND s.absolute_expires_at > now()) AS active_sessions,
            li.status AS invitation_status, li.expires_at AS invitation_expires_at,
            li.delivered_at AS invitation_delivered_at, li.consumed_at AS invitation_consumed_at,
            li.created_at AS invitation_created_at
       FROM partner_users u
       JOIN partner_organisations o ON o.id = u.tenant_id
       LEFT JOIN partner_user_roles ur ON ur.user_id = u.id
       LEFT JOIN partner_roles r ON r.id = ur.role_id
       LEFT JOIN LATERAL (
         SELECT status, expires_at, delivered_at, consumed_at, created_at FROM partner_invitations i
          WHERE i.tenant_id = u.tenant_id AND i.user_id = u.id
          ORDER BY i.created_at DESC LIMIT 1
       ) li ON true
      WHERE u.tenant_id = $1
      GROUP BY u.id, o.status, li.status, li.expires_at, li.delivered_at, li.consumed_at, li.created_at
      ORDER BY u.created_at DESC, u.email ASC
      LIMIT 500`,
    [org.id]
  );
  /*
   * Main-location delivery and operations-contact readiness deliberately come from the exact
   * records that Supplies snapshots. An owner account can be valid while the shop's delivery or
   * contact record is incomplete; keeping this fact separate prevents either surface inventing a
   * duplicate profile/contact authority.
   */
  const { rows: foundationRows } = await partnerAdminQuery<{
    location_address: string | null;
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_postcode: string | null;
    address_country: string | null;
    profile_postcode: string | null;
    profile_country: string | null;
    contact_name: string | null;
    contact_email: string | null;
    contact_active: boolean | null;
    contact_primary: boolean | null;
    contact_type: string | null;
  }>(
    `SELECT main.address AS location_address,
            main.address_line1, main.address_line2, main.address_city,
            main.address_postcode, main.address_country,
            profile.address_postcode AS profile_postcode, profile.address_country AS profile_country,
            operations.full_name AS contact_name, operations.email AS contact_email,
            operations.active AS contact_active, operations.is_primary AS contact_primary,
            operations.contact_type
       FROM partner_organisations organisation
       LEFT JOIN LATERAL (
         SELECT l.address, l.address_line1, l.address_line2, l.address_city,
                l.address_postcode, l.address_country
           FROM partner_locations l
          WHERE l.tenant_id=organisation.id AND l.status='ACTIVE'
          ORDER BY (lower(btrim(l.name)) = 'main location') DESC, l.created_at ASC, l.id ASC
          LIMIT 1
       ) main ON true
       LEFT JOIN partner_profiles profile ON profile.tenant_id=organisation.id
       LEFT JOIN LATERAL (
         SELECT c.full_name, c.email, c.active, c.is_primary, c.contact_type
           FROM partner_contacts c
          WHERE c.tenant_id=organisation.id AND c.active AND c.is_primary
                AND c.contact_type='operations'
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT 1
       ) operations ON true
      WHERE organisation.id=$1`,
    [org.id]
  );
  const foundation = foundationRows[0];
  const hasStructuredAddress = !!foundation && [
    foundation.address_line1,
    foundation.address_line2,
    foundation.address_city,
    foundation.address_postcode,
    foundation.address_country,
  ].some((value) => value != null);
  const structuredDeliveryAddressReady =
    !!foundation &&
    isCompletePartnerDeliveryAddress({
      line1: foundation.address_line1,
      line2: foundation.address_line2,
      city: foundation.address_city,
      postcode: foundation.address_postcode,
      country: foundation.address_country,
    });
  // Records created before 0105 retain the raw location address plus profile postcode/country.
  // Once any structured value exists, incomplete structured data must fail closed instead of
  // falling back to stale legacy fields.
  const legacyDeliveryAddressReady =
    !!foundation &&
    !hasStructuredAddress &&
    (foundation.location_address?.trim().length ?? 0) >= 12 &&
    !!foundation.profile_postcode &&
    !!foundation.profile_country &&
    isValidPartnerPostcode(foundation.profile_postcode, foundation.profile_country);
  const deliveryAddressReady = structuredDeliveryAddressReady || legacyDeliveryAddressReady;
  const operationsContactReady =
    !!foundation &&
    hasValidPartnerOperationalContact({
      fullName: foundation.contact_name,
      email: foundation.contact_email,
      active: foundation.contact_active,
      primary: foundation.contact_primary,
      type: foundation.contact_type,
    });

  /*
   * Station readiness is probed SEPARATELY rather than joined into the query above, because
   * `partner_stations` arrives in migration 0045 and several test migration lists deliberately stop
   * short of it. Referencing the table inline would make this whole endpoint fail on those
   * databases; a guarded probe degrades to `null` (= "cannot tell") instead.
   *
   * `null` is a THIRD state, not a synonym for false: it must never be reported as a blocked reason
   * (the partner has done nothing wrong) nor silently treated as ready.
   */
  let stationReady: boolean | null = null;
  let stationFacts: PartnerReadinessFacts["station"];
  try {
    /*
     * ONE query for the whole station picture — counts plus the single best qualifying station —
     * rather than a count query followed by a per-station health read. Readiness is rendered on
     * every dashboard load, so an N+1 here would be paid constantly.
     *
     * The health row is the most recently seen APPROVED + ACTIVE station: if a shop has several,
     * the one that can actually work now is the right one to report on. Every predicate is
     * explicitly scoped by tenant_id — the admin pool bypasses RLS, so the tenant filter is the
     * only thing standing between this and another shop's fleet.
     */
    /*
     * Built in two tiers because `current_profile_revision_id` may be absent on an older database.
     * The reduced probe marks that fact as `undefined`; the decision contract treats it as UNKNOWN,
     * never as a pass, because capture readiness cannot be established without the revision.
     */
    const stationSql = (withProfileRevision: boolean) => `
      SELECT
        (SELECT count(*)::int FROM partner_stations WHERE tenant_id = $1 AND status <> 'REVOKED') AS enrolled,
        (SELECT count(*)::int FROM partner_stations s2
           JOIN partner_locations l2 ON l2.id = s2.location_id AND l2.tenant_id = s2.tenant_id
          WHERE s2.tenant_id = $1 AND s2.status = 'ACTIVE' AND s2.approved_at IS NOT NULL
            AND l2.status = 'ACTIVE') AS approved_active,
        (SELECT count(*)::int FROM partner_stations
           WHERE tenant_id = $1 AND status = 'PENDING' AND approved_at IS NULL) AS pending_approval,
        a.scanner_connected, a.last_seen_at, a.calibration_status, a.current_calibration_id,
        ${withProfileRevision ? "a.current_profile_revision_id" : "NULL::uuid AS current_profile_revision_id"},
        a.app_version, a.minimum_supported_version
      FROM (SELECT 1) _
      LEFT JOIN LATERAL (
        SELECT s.scanner_connected, s.last_seen_at, s.calibration_status, s.current_calibration_id,
               ${withProfileRevision ? "s.current_profile_revision_id," : ""}
               s.app_version, s.minimum_supported_version
          FROM partner_stations s
          JOIN partner_locations l ON l.id = s.location_id AND l.tenant_id = s.tenant_id AND l.status = 'ACTIVE'
         WHERE s.tenant_id = $1 AND s.status = 'ACTIVE' AND s.approved_at IS NOT NULL
         ORDER BY s.last_seen_at DESC NULLS LAST
         LIMIT 1
      ) a ON true`;
    type StationProbeRow = {
      enrolled: number;
      approved_active: number;
      pending_approval: number;
      scanner_connected: boolean | null;
      last_seen_at: string | null;
      calibration_status: string | null;
      current_calibration_id: string | null;
      current_profile_revision_id: string | null;
      app_version: string | null;
      minimum_supported_version: string | null;
    };
    let hasProfileRevision = true;
    let stationRows;
    try {
      stationRows = await partnerAdminQuery<StationProbeRow>(stationSql(true), [org.id]);
    } catch {
      stationRows = await partnerAdminQuery<StationProbeRow>(stationSql(false), [org.id]);
      hasProfileRevision = false;
    }
    const s = stationRows.rows[0];
    stationReady = (s?.approved_active ?? 0) > 0;
    stationFacts = {
      enrolledCount: s?.enrolled ?? 0,
      approvedActiveCount: s?.approved_active ?? 0,
      pendingApprovalCount: s?.pending_approval ?? 0,
      active:
        s && s.calibration_status !== null
          ? {
              scannerConnected: s.scanner_connected === true,
              lastSeenAt: s.last_seen_at,
              calibrationStatus: s.calibration_status,
              currentCalibrationId: s.current_calibration_id,
              currentProfileRevisionId: hasProfileRevision ? s.current_profile_revision_id : undefined,
              appVersion: s.app_version,
              minimumSupportedVersion: s.minimum_supported_version,
            }
          : null,
    };
  } catch {
    // station subsystem absent on this database — report unknown, not blocked
    stationReady = null;
    stationFacts = null;
  }

  /*
   * CREDITS come from the canonical ledger-derived balance, never a stored or cached figure.
   * WALLET_NOT_FOUND is a real, actionable answer (a legacy partner that predates wallet
   * provisioning) and is distinguished from "the wallet authority could not be consulted", which is
   * UNKNOWN. Collapsing the two would let an outage read as "no credits", or worse, as zero-is-fine.
   */
  /*
   * STAFF facts, derived from the SAME `location_eligible` expression the user query already
   * computes — which is itself the rule listPermittedStationLocations applies (org-wide roles are
   * eligible everywhere ACTIVE; everyone else needs an explicit partner_user_locations row). Reusing
   * it means readiness and the Scanner's own location discovery cannot disagree; re-deriving it here
   * is exactly the two-authorities drift this package exists to prevent.
   */
  const ORG_WIDE_ROLE_CODES = ["PARTNER_OWNER", "PARTNER_MANAGER", "PARTNER_FINANCE_VIEWER"];
  let staff: PartnerReadinessFacts["staff"];
  try {
    const activeUsers = rows.filter((u: any) => u.user_status === "ACTIVE");
    const isOrgWide = (u: any) => (u.role_codes ?? []).some((c: string) => ORG_WIDE_ROLE_CODES.includes(c));
    staff = {
      // Could this person actually be offered a location to enrol a station at?
      scanCapableCount: activeUsers.filter((u: any) => u.location_eligible === true).length,
      // Location-scoped, ACTIVE, and pinned to nothing — capabilities but nowhere to use them.
      locationScopedWithoutLocation: activeUsers.filter((u: any) => !isOrgWide(u) && u.location_eligible !== true).length,
    };
  } catch {
    staff = null;
  }

  let credits: PartnerReadinessFacts["credits"];
  try {
    const { getBalance } = await import("./partner-wallet-service");
    credits = (await getBalance(org.id)).balance;
  } catch (err) {
    credits = (err as { code?: string })?.code === "WALLET_NOT_FOUND" ? "NO_WALLET" : null;
  }

  /*
   * THE ONBOARDING TEST CARD. Read from the explicit `purpose = 'ONBOARDING_TEST'` marker only, and
   * left as null — UNKNOWN — when that authority cannot be consulted. The loader never falls back to
   * "the newest Card Job", so a shop that has genuinely not tested cannot be reported as having done.
   */
  const testCard = await loadPartnerTestCardFacts(org.id);


  /*
   * The OWNER row backing the readiness decision. Chosen deterministically: the PARTNER_OWNER if
   * there is one, else the first listed user, so both audiences reason about the same account
   * rather than "whichever row happened to sort first" differing between callers.
   */
  const ownerRow =
    rows.find((u: any) => (u.role_codes ?? []).includes("PARTNER_OWNER") && u.user_status !== "REVOKED") ??
    rows.find((u: any) => u.user_status !== "REVOKED") ??
    rows[0];

  const operational = attachGuidedReadinessActions(derivePartnerOperationalReadiness({
    orgStatus: org.status,
    staff,
    portalEnabled: flagsReadable ? portalEnabled : null,
    loginFlagEnabled: flagsReadable ? loginFlagEnabled : null,
    emergencyStop: flagsReadable ? emergencyStop : null,
    owner: ownerRow
      ? {
          userStatus: ownerRow.user_status,
          passwordConfigured: ownerRow.password_configured === true,
          invitationValid:
            !!ownerRow.invitation_status &&
            ["PENDING", "SENT", "DELIVERY_FAILED"].includes(ownerRow.invitation_status) &&
            !!ownerRow.invitation_expires_at &&
            new Date(ownerRow.invitation_expires_at).getTime() > Date.now(),
          mfaRequired: ownerRow.mfa_required === true,
          mfaConfigured: ownerRow.mfa_configured === true,
        }
      : null,
    locationEligible: ownerRow?.location_eligible === true,
    deliveryAddressReady,
    operationsContactReady,
    station: stationFacts,
    credits,
    testCard,
    nowMs: Date.now(),
  }), org.id);

  return {
    organisation: { id: org.id, legalName: org.legal_name, status: org.status },
    portalEnabled,
    /**
     * THE authoritative operational verdict, consumed verbatim by both the Partner Portal dashboard
     * and the Super Admin partner workspace. Added alongside the existing fields rather than
     * replacing them, so every current consumer of `users[].readiness` keeps working unchanged.
     */
    operational,
    users: rows.map((u: any) => ({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      role: displayAdminRole(u.role_codes ?? []),
      userStatus: u.user_status,
      invitationStatus: u.invitation_status,
      invitationSentAt: u.invitation_delivered_at,
      invitationCreatedAt: u.invitation_created_at,
      invitationExpiresAt: u.invitation_expires_at,
      acceptedAt: u.invitation_consumed_at,
      lastLoginAt: u.last_login_at,
      activeSessions: u.active_sessions ?? 0,
      readiness: buildLoginReadiness(u, portalEnabled, loginFlagEnabled, stationReady),
    })),
  };
}

export async function resendPartnerInvitation(actor: ActorContext, partnerId: string, userId: string, reason: string) {
  const org = await loadPartner(partnerId);
  const invite = await withPartnerAdminTransaction(async (client) => {
    const { rows } = await client.query<{ email: string; role_code: string; status: string }>(
      `SELECT u.email, r.code AS role_code, u.status
         FROM partner_users u
         JOIN partner_user_roles ur ON ur.user_id = u.id
         JOIN partner_roles r ON r.id = ur.role_id
        WHERE u.tenant_id=$1 AND u.id=$2
        ORDER BY r.code LIMIT 1`,
      [org.id, userId]
    );
    if (rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    if (org.status === "SUSPENDED" || org.status === "REVOKED" || rows[0].status !== "INVITED") {
      throw new G5RequestError("PARTNER_UNAVAILABLE", "Setup invitations are only available for invited accounts.");
    }

    /*
     * SERIALISE RESENDS FOR ONE USER, AND COLLAPSE AN ACCIDENTAL DOUBLE-CLICK.
     *
     * Measured before this existed: two concurrent clicks produced two 200s, two provider sends and
     * two emails — of which only the second link worked, because each mint supersedes the last. The
     * security invariant was never in danger (one live token), but sending somebody two invitations
     * and silently killing the first is exactly the kind of thing that makes an operator distrust
     * the button.
     *
     * A disabled button is not a fix: it protects one tab, not two, and not a retry. The lock is
     * transaction-scoped, so it is released on commit or rollback either way.
     *
     * The window is deliberately short. It collapses a double-click into one email; a deliberate
     * resend seconds later still mints a genuinely fresh invitation, which is the whole point of
     * the control.
     */
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`partner-resend:${userId}`]);
    /*
     * Keyed on a recent RESEND, not on a recent invitation of any kind.
     *
     * Keying it on invitation age collapsed the first genuine resend against the invitation that
     * shop creation had just minted — the operator pressed Resend and nothing was sent. The audit
     * row is written inside the same transaction as the mint, so once the first request commits and
     * releases this lock, the second sees it.
     */
    const recentResend = await client.query<{ entity_id: string }>(
      `SELECT entity_id FROM partner_management_audit
        WHERE tenant_id=$1 AND entity_id=$2
          AND action_type='partner_invitation_resent' AND result='succeeded'
          AND created_at > now() - interval '10 seconds'
        ORDER BY created_at DESC LIMIT 1`,
      [org.id, userId]
    );
    if (recentResend.rows[0]) {
      const live = await client.query<{ id: string }>(
        `SELECT id FROM partner_invitations
          WHERE tenant_id=$1 AND user_id=$2 AND status IN ('PENDING','SENT')
          ORDER BY created_at DESC LIMIT 1`,
        [org.id, userId]
      );
      if (live.rows[0]) return { replayed: true as const, invitationId: live.rows[0].id };
    }
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, idempotency_key, entity_type, entity_id, before_state, reason, result)
       VALUES ($1,'partner_invitation_resent',$2,$3,$4,$5,'partner_user',$6,$7,'__attempt__','attempted')`,
      [
        org.id,
        actor.actorUserId,
        actor.actorEmail,
        actor.requestId,
        actor.idempotencyKey ?? null,
        userId,
        JSON.stringify({ email: rows[0].email }),
      ]
    );
    return createInvitationRecord(
      client,
      actor,
      org.id,
      userId,
      rows[0].email,
      rows[0].role_code,
      "partner_invitation_resent",
      reason
    );
  });
  if ("replayed" in invite) {
    // A duplicate click inside the window. Nothing was minted and nothing is sent again.
    return { result: { invitationId: invite.invitationId, deliveryStatus: "ALREADY_SENT" }, alreadyCompleted: true };
  }
  const { delivery, ...publicInvite } = invite;
  publicInvite.deliveryStatus = await recordInvitationDelivery({ ...publicInvite, delivery });
  return { result: publicInvite, alreadyCompleted: false };
}

export async function copyPartnerInvitationLink(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  reason: string
) {
  if (!adminInviteLinkCopyAllowed()) {
    throw new G5RequestError("FORBIDDEN", "Invitation link copy is not available in this environment.");
  }
  const resent = await resendPartnerInvitation(actor, partnerId, userId, `${reason} [admin link copy]`);
  if (!resent.result?.invitationLink) {
    throw new G5RequestError("FORBIDDEN", "Invitation link copy is not available in this environment.");
  }
  return resent;
}

export async function revokePartnerInvitation(actor: ActorContext, partnerId: string, userId: string, reason: string) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "partner_invitation_revoked", reason, { userId }, async () => {
    const exists = await partnerAdminQuery("SELECT 1 FROM partner_users WHERE tenant_id=$1 AND id=$2", [
      org.id,
      userId,
    ]);
    if (exists.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    const r = await partnerAdminQuery(
      `UPDATE partner_invitations
          SET status='REVOKED', revoked_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND status IN ('PENDING','SENT','DELIVERY_FAILED')`,
      [org.id, userId]
    );
    if ((r.rowCount ?? 0) < 1) {
      throw new G5RequestError("PARTNER_INVITATION_NOT_FOUND", "No live invitation exists for this team member.");
    }
    return {
      result: { revoked: r.rowCount ?? 0 },
      entityType: "partner_user",
      entityId: userId,
      afterState: { revokedInvitations: r.rowCount ?? 0 },
    };
  });
}

export async function changePartnerUserRole(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  role: AdminPartnerRole,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const roleCode = ADMIN_ROLE_TO_PARTNER_ROLE[role];
  return withPartnerAdminTransaction(async (client) => {
    const exists = await client.query("SELECT 1 FROM partner_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
      org.id,
      userId,
    ]);
    if (exists.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    if (roleCode !== "PARTNER_OWNER") {
      const ownerCheck = await client.query<{ blocked: boolean }>(
        `SELECT (
           u.status='ACTIVE'
           AND EXISTS (
             SELECT 1 FROM partner_user_roles ur JOIN partner_roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND r.code = 'PARTNER_OWNER'
           )
           AND NOT EXISTS (
             SELECT 1 FROM partner_users other
              JOIN partner_user_roles our ON our.user_id = other.id
              JOIN partner_roles rr ON rr.id = our.role_id
             WHERE other.tenant_id=$1 AND other.id<>$2 AND other.status='ACTIVE' AND rr.code='PARTNER_OWNER'
           )
         ) AS blocked
          FROM partner_users u WHERE u.tenant_id=$1 AND u.id=$2`,
        [org.id, userId]
      );
      if (ownerCheck.rows[0]?.blocked) {
        throw new G5RequestError("FINAL_OWNER_REQUIRED", "A partner must keep at least one active owner.");
      }
    }
    const roleRow = await client.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [roleCode]);
    if (roleRow.rows.length !== 1) {
      throw new G5RequestError("PARTNER_ROLE_NOT_CONFIGURED", "Partner role is not configured.");
    }
    await client.query("DELETE FROM partner_user_roles WHERE tenant_id=$1 AND user_id=$2", [org.id, userId]);
    await client.query("INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)", [
      org.id,
      userId,
      roleRow.rows[0].id,
    ]);
    await client.query(
      "UPDATE partner_users SET credential_version=credential_version+1, updated_at=now() WHERE id=$1",
      [userId]
    );
    await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [org.id, userId]
    );
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, entity_type, entity_id, after_state, reason, result)
       VALUES ($1,'partner_user_role_changed',$2,$3,$4,'partner_user',$5,$6,$7,'succeeded')`,
      [org.id, actor.actorUserId, actor.actorEmail, actor.requestId, userId, JSON.stringify({ roleCode }), reason]
    );
    return { result: { ok: true }, alreadyCompleted: false };
  });
}

export async function setPartnerUserStatus(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  status: "ACTIVE" | "SUSPENDED" | "REVOKED",
  reason: string
) {
  const org = await loadPartner(partnerId);
  const current = await partnerAdminQuery<{ status: string }>(
    "SELECT status FROM partner_users WHERE tenant_id=$1 AND id=$2",
    [org.id, userId]
  );
  if (current.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
  const from = current.rows[0].status;
  const allowed =
    from === status ||
    (from === "INVITED" && status === "REVOKED") ||
    (from === "ACTIVE" && (status === "SUSPENDED" || status === "REVOKED")) ||
    (from === "SUSPENDED" && (status === "ACTIVE" || status === "REVOKED"));
  if (!allowed || from === "REVOKED") {
    throw new G5RequestError("INVALID_STATUS_TRANSITION", "Team member status transition is not allowed.");
  }
  if (status !== "ACTIVE") await ensureCanRemoveOwner(org.id, userId);
  const action: AuditAction =
    status === "ACTIVE"
      ? "partner_user_reactivated"
      : status === "SUSPENDED"
        ? "partner_user_suspended"
        : "partner_user_membership_removed";
  return withAudit(actor, org.id, action, reason, { userId, status }, async () => {
    const r = await partnerAdminQuery(
      `UPDATE partner_users
          SET status=$3, credential_version=credential_version+1, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [org.id, userId, status]
    );
    if (r.rowCount !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    await partnerAdminQuery(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [org.id, userId]
    );
    return { result: { ok: true }, entityType: "partner_user", entityId: userId, afterState: { status } };
  });
}

/**
 * Send the partner user a password-reset link.
 *
 * SECURITY POSTURE — no password is ever seen, set or stored by an administrator. This composes the
 * two primitives that already exist for the self-service flow: `createPasswordResetToken` stores only
 * a SHA-256 hash of a fresh token, and `deliverResetToken` sends the link out-of-band. There is no
 * temporary password, no plaintext, and the token is never returned in the HTTP response.
 *
 * DELIVERY HONESTY: the reset is reported with the delivery status the transport actually produced.
 * A committed token whose email did not leave the building must not be reported as "sent".
 */
export async function sendPartnerUserPasswordReset(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const u = await partnerAdminQuery<{ email: string; status: string }>(
    "SELECT email, status FROM partner_users WHERE tenant_id=$1 AND id=$2",
    [org.id, userId]
  );
  if (u.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
  if (u.rows[0].status !== "ACTIVE") {
    throw new G5RequestError(
      "INVALID_STATUS_TRANSITION",
      "Only an active account can be sent a password reset. Reactivate the account first."
    );
  }
  const email = u.rows[0].email;
  return withAudit(actor, org.id, "partner_user_password_reset_initiated", reason, { userId }, async () => {
    const { createPasswordResetToken } = await import("./auth");
    // force: this is an authenticated Super Admin action already wrapped in withAudit above. The
    // reissue cooldown exists to stop an UNAUTHENTICATED flood holding a partner's recovery shut;
    // applying it here would leave the operator with no token to deliver and no way to help.
    const token = await createPasswordResetToken(org.id, userId, { force: true });
    if (token === null) throw new Error("Password reset token was not issued.");
    let deliveryStatus = "SENT";
    try {
      const { deliverResetToken } = await import("./delivery");
      await deliverResetToken(email, token);
    } catch {
      // The token is already stored. Report the truth rather than a comforting lie; the operator can
      // retry once the mail problem is fixed. No token, address or provider detail is surfaced.
      deliveryStatus = "DELIVERY_FAILED";
    }
    return {
      result: { deliveryStatus },
      entityType: "partner_user",
      entityId: userId,
      // NEVER the token — only the fact that one was issued.
      afterState: { passwordResetIssued: true, deliveryStatus },
    };
  });
}

/**
 * Clear a partner user's second factor so they must enrol a fresh authenticator.
 *
 * WHAT THIS DOES, precisely: disables every MFA method on the account, burns the unused recovery
 * codes, flips `mfa_enabled` off and `mfa_required` on, bumps `credential_version` and revokes live
 * sessions. The user cannot sign in again until they re-enrol — which is the point: an admin
 * resetting a second factor must not leave the account momentarily protected by nothing.
 *
 * NO SECRET IS READ OR RETURNED. The TOTP secret is not decrypted, not logged and not surfaced; it is
 * marked DISABLED in place. Recovery codes are marked used, never displayed.
 *
 * AUDIT ACTION: `partner_user_mfa_reset` (migration 0033). Borrowing `partner_user_sessions_revoked`
 * would have hidden a second-factor reset inside a routine sign-out entry.
 */
export async function resetPartnerUserMfa(actor: ActorContext, partnerId: string, userId: string, reason: string) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "partner_user_mfa_reset", reason, { userId }, async () => {
    return withPartnerAdminTransaction(async (client) => {
      const exists = await client.query("SELECT 1 FROM partner_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        org.id,
        userId,
      ]);
      if (exists.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");

      const methods = await client.query(
        "UPDATE partner_mfa_methods SET status='DISABLED' WHERE tenant_id=$1 AND user_id=$2 AND status<>'DISABLED'",
        [org.id, userId]
      );
      const codes = await client.query(
        "UPDATE partner_recovery_codes SET used_at=now() WHERE tenant_id=$1 AND user_id=$2 AND used_at IS NULL",
        [org.id, userId]
      );
      await client.query(
        `UPDATE partner_users
            SET mfa_enabled=false, mfa_required=true, credential_version=credential_version+1, updated_at=now()
          WHERE tenant_id=$1 AND id=$2`,
        [org.id, userId]
      );
      await client.query(
        "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
        [org.id, userId]
      );
      /*
       * PARTNER-VISIBLE TIMELINE entry. Preserves the exact contract the legacy route wrote via
       * adminAudit — action `partner_mfa_admin_reset`, record_type `partner_user`, record_id = the
       * user, reason, and `after_value.by` = the acting admin. Consolidating the two implementations
       * must NOT quietly drop an evidence surface the partner can already see: without this row the
       * partner's own audit timeline would lose a record it has today.
       *
       * `partner_audit_events.action` is unconstrained text, so this needs no migration and no new
       * audit-action value.
       */
      await client.query(
        `INSERT INTO partner_audit_events (tenant_id, action, reason, record_type, record_id, after_value)
         VALUES ($1,'partner_mfa_admin_reset',$2,'partner_user',$3,$4::jsonb)`,
        [org.id, reason, userId, JSON.stringify({ by: actor.actorEmail })]
      );
      /*
       * PARTNER-VISIBLE evidence, written in the SAME transaction so it can never disagree with the
       * reset itself. partner_management_audit is the internal admin ledger the partner cannot read;
       * without this row a MintVault admin could clear a partner owner's second factor and the
       * partner's own security timeline would show nothing. Severity 'high' matches the pre-existing
       * legacy behaviour this consolidates.
       *
       * `detail` carries the affected user and counts ONLY — never a TOTP secret, recovery code,
       * session token or invitation token. `secret_ref` is not selected anywhere in this function.
       */
      await client.query(
        "INSERT INTO partner_security_events (tenant_id, severity, kind, detail) VALUES ($1,'high','partner_mfa_admin_reset',$2::jsonb)",
        [
          org.id,
          JSON.stringify({
            userId,
            methodsDisabled: methods.rowCount ?? 0,
            recoveryCodesBurned: codes.rowCount ?? 0,
            actorEmail: actor.actorEmail,
          }),
        ]
      );
      return {
        result: {
          methodsDisabled: methods.rowCount ?? 0,
          recoveryCodesBurned: codes.rowCount ?? 0,
        },
        entityType: "partner_user",
        entityId: userId,
        afterState: { mfaEnabled: false, mfaRequired: true, sessionsRevoked: true },
      };
    });
  });
}

export async function revokePartnerUserSessions(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  reason: string
) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "partner_user_sessions_revoked", reason, { userId }, async () => {
    const exists = await partnerAdminQuery("SELECT 1 FROM partner_users WHERE tenant_id=$1 AND id=$2", [
      org.id,
      userId,
    ]);
    if (exists.rows.length !== 1) throw new G5RequestError("PARTNER_USER_NOT_FOUND", "Partner user not found.");
    const activeBefore = await partnerAdminQuery(
      "SELECT 1 FROM partner_sessions WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL LIMIT 1",
      [org.id, userId]
    );
    const r = await partnerAdminQuery(
      "UPDATE partner_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [org.id, userId]
    );
    return {
      result: { revoked: r.rowCount ?? 0, hadSessions: activeBefore.rows.length > 0 },
      entityType: "partner_user",
      entityId: userId,
      afterState: { revoked: r.rowCount ?? 0, hadSessions: activeBefore.rows.length > 0 },
    };
  });
}

export async function acceptPartnerInvitation(token: string, password: string) {
  if (typeof token !== "string" || token.length < 20 || !isValidPartnerPassword(password)) {
    return { ok: false as const, reason: "invalid" as const };
  }
  const tokenHash = sha256(token);
  const pwHash = await hashPassword(password);
  return withPartnerAdminTransaction(async (client) => {
    await maybeWaitAcceptBarrierForTest("before_invitation_lock");
    const { rows } = await client.query<{
      id: string;
      tenant_id: string;
      user_id: string;
      email: string;
      role_code: string;
      status: string;
      expires_at: string;
      user_status: string;
      org_status: string;
    }>(
      `SELECT i.id, i.tenant_id, i.user_id, i.email, i.role_code, i.status, i.expires_at,
              u.status AS user_status, o.status AS org_status
         FROM partner_invitations i
         JOIN partner_users u ON u.id = i.user_id AND u.tenant_id = i.tenant_id
         JOIN partner_organisations o ON o.id = i.tenant_id
        WHERE i.token_hash = $1
        FOR UPDATE OF i, u`,
      [tokenHash]
    );
    if (rows.length !== 1) return { ok: false as const, reason: "invalid" as const };
    const inv = rows[0];
    if (
      !["PENDING", "SENT", "DELIVERY_FAILED"].includes(inv.status) ||
      inv.user_status !== "INVITED" ||
      inv.org_status === "SUSPENDED" ||
      inv.org_status === "REVOKED" ||
      new Date(inv.expires_at).getTime() <= Date.now()
    ) {
      if (new Date(inv.expires_at).getTime() <= Date.now() && inv.status !== "EXPIRED") {
        await client.query("UPDATE partner_invitations SET status='EXPIRED', updated_at=now() WHERE id=$1", [inv.id]);
      }
      return { ok: false as const, reason: "invalid" as const };
    }
    /*
     * P0-E — MANDATORY SECOND FACTOR FROM THE FIRST SIGN-IN.
     *
     * `mfa_required` defaults to false (migrations/0002_partner_auth_support.sql:9) and acceptance
     * never set it, so a brand-new partner OWNER — the single most privileged principal in a tenant
     * — received a fully MFA-passed session on their first login and unrestricted access to every
     * partner API, while both the invitation page and the security page told them two-step was
     * required. Setting it here is the whole fix: partnerLogin() then mints an mfa-pending session
     * (mfa_passed=false), and requirePartnerAuth / requirePartnerCapability (server/partner/
     * session.ts) already refuse every normal partner route without mfa_passed.
     *
     * WHY THIS DOES NOT LOCK THE OWNER OUT. The enrolment path is deliberately reachable from an
     * mfa-pending session: POST /mfa/enrol and POST /mfa/confirm are the only two authenticated
     * routes that do NOT sit behind requirePartnerAuth (server/partner/routes.ts), and
     * mfaEnrolStart's F1 guard only blocks REPLACING an existing factor — bootstrap with no active
     * method stays open. A freshly-accepted user has no method, so they can always enrol. The login
     * response and GET /session now carry `mfaEnrolmentRequired` so the Portal sends them to
     * enrolment instead of an impossible code prompt. Proven end to end in
     * tests/partner-mfa-enrolment-mandatory.test.ts.
     *
     * This applies to EVERY invited role, not just owners: `partner_users.mfa_required` is the only
     * gate the session layer reads, and a weaker rule for staff would be a softer way in to the same
     * tenant.
     */
    await client.query(
      `UPDATE partner_users
          SET password_hash=$2, password_set_at=now(), status='ACTIVE', failed_login_count=0, locked_until=NULL,
              mfa_required=true, credential_version=credential_version+1, updated_at=now()
        WHERE id=$1 AND tenant_id=$3`,
      [inv.user_id, pwHash, inv.tenant_id]
    );
    await client.query(
      `UPDATE partner_invitations
          SET status='REVOKED', revoked_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id<>$3 AND status IN ('PENDING','SENT','DELIVERY_FAILED')`,
      [inv.tenant_id, inv.user_id, inv.id]
    );
    await client.query(
      "UPDATE partner_invitations SET status='CONSUMED', consumed_at=now(), updated_at=now() WHERE id=$1",
      [inv.id]
    );
    await client.query(
      `INSERT INTO partner_management_audit
         (tenant_id, action_type, actor_user_id, actor_email, request_id, entity_type, entity_id, after_state, reason, result)
       VALUES ($1,'partner_invitation_accepted',$2,$3,$4,'partner_user',$5,$6,'invitation accepted','succeeded')`,
      [
        inv.tenant_id,
        inv.user_id,
        inv.email,
        `partner-invite-${Date.now()}`,
        inv.user_id,
        JSON.stringify({ invitationId: inv.id, roleCode: inv.role_code }),
      ]
    );
    return { ok: true as const, email: inv.email, organisationStatus: inv.org_status };
  });
}

export async function getPartnerInvitationPreview(token: string) {
  if (typeof token !== "string" || token.length < 20) return { ok: false as const, reason: "invalid" as const };
  const { rows } = await partnerAdminQuery<{
    email: string;
    partner_name: string;
    role_code: string;
    status: string;
    expires_at: string;
    user_status: string;
    org_status: string;
  }>(
    `SELECT i.email, o.legal_name AS partner_name, i.role_code, i.status, i.expires_at,
            u.status AS user_status, o.status AS org_status
       FROM partner_invitations i
       JOIN partner_users u ON u.id = i.user_id AND u.tenant_id = i.tenant_id
       JOIN partner_organisations o ON o.id = i.tenant_id
      WHERE i.token_hash = $1`,
    [sha256(token)]
  );
  if (rows.length !== 1) return { ok: false as const, reason: "invalid" as const };
  const inv = rows[0];
  const valid =
    ["PENDING", "SENT", "DELIVERY_FAILED"].includes(inv.status) &&
    inv.user_status === "INVITED" &&
    inv.org_status !== "SUSPENDED" &&
    inv.org_status !== "REVOKED" &&
    new Date(inv.expires_at).getTime() > Date.now();
  if (!valid) return { ok: false as const, reason: "invalid" as const };
  return {
    ok: true as const,
    email: inv.email,
    partnerName: inv.partner_name,
    roleCode: inv.role_code,
    expiresAt: inv.expires_at,
  };
}

// ---------------------------------------------------------------------------
// READS (deterministic, bounded, secret-free)
// ---------------------------------------------------------------------------
export async function listPartners(
  filters: { search?: string; status?: string; kind?: string },
  offset: number,
  limit: number
) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => {
    params.push(val);
    clauses.push(sql.replace("$?", `$${params.length}`));
  };
  if (filters.status) add("o.status = $?", filters.status);
  if (filters.kind) add("p.organisation_kind = $?", filters.kind);
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const p = `$${params.length}`;
    clauses.push(`(o.legal_name ILIKE ${p} OR p.trading_name ILIKE ${p} OR p.primary_email ILIKE ${p})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit, offset);
  const { rows } = await partnerAdminQuery(
    `SELECT o.id, o.legal_name, o.status, o.accreditation_level, o.health, o.created_at,
            p.trading_name, p.organisation_kind, p.primary_email,
            (SELECT full_name FROM partner_contacts c WHERE c.tenant_id = o.id AND c.is_primary AND c.active LIMIT 1) AS primary_contact_name,
            (SELECT count(*)::int FROM partner_locations l WHERE l.tenant_id = o.id) AS location_count,
            (SELECT count(*)::int FROM partner_users u WHERE u.tenant_id = o.id) AS user_count,
            (SELECT count(*)::int FROM partner_connector_records r WHERE r.tenant_id = o.id) AS connector_total,
            (SELECT max(r.updated_at) FROM partner_connector_records r WHERE r.tenant_id = o.id) AS last_connector_activity
       FROM partner_organisations o
       LEFT JOIN partner_profiles p ON p.tenant_id = o.id
       ${where}
      ORDER BY o.created_at DESC, o.id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countParams = params.slice(0, params.length - 2);
  const total = await partnerAdminQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM partner_organisations o LEFT JOIN partner_profiles p ON p.tenant_id = o.id ${where}`,
    countParams
  );
  return { rows, total: total.rows[0].n };
}

export async function getPartnerDetail(partnerId: string) {
  const org = await loadPartner(partnerId);
  const profile = await partnerAdminQuery(`SELECT * FROM partner_profiles WHERE tenant_id = $1`, [org.id]);
  const primaryContact = await partnerAdminQuery(
    `SELECT id, full_name, title, email, phone, contact_type FROM partner_contacts WHERE tenant_id = $1 AND is_primary AND active LIMIT 1`,
    [org.id]
  );
  return { organisation: org, profile: profile.rows[0] ?? null, primaryContact: primaryContact.rows[0] ?? null };
}

export async function listContacts(partnerId: string) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT id, full_name, title, email, phone, contact_type, is_primary, active, version, created_at, updated_at
       FROM partner_contacts WHERE tenant_id = $1 ORDER BY is_primary DESC, active DESC, full_name ASC, id ASC
      LIMIT 500`,
    [org.id]
  );
  return { contacts: rows };
}

export async function getBranding(partnerId: string) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(`SELECT * FROM partner_branding WHERE tenant_id = $1`, [org.id]);
  return { branding: rows[0] ?? null };
}

export async function listNotes(partnerId: string, offset: number, limit: number) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT id, body, author_email, supersedes_note_id, created_at FROM partner_internal_notes
       WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [org.id, limit, offset]
  );
  return { notes: rows };
}

export async function getActivity(partnerId: string, offset: number, limit: number) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT * FROM (
        SELECT created_at, 'audit'::text AS source, action AS kind, reason AS detail FROM partner_audit_events WHERE tenant_id = $1
        UNION ALL
        SELECT created_at, 'security'::text AS source, kind AS kind, NULL::text AS detail FROM partner_security_events WHERE tenant_id = $1
        UNION ALL
        SELECT created_at, 'management'::text AS source, action_type AS kind, reason AS detail FROM partner_management_audit WHERE tenant_id = $1 AND result = 'succeeded'
     ) feed
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [org.id, limit, offset]
  );
  return { activity: rows };
}

export async function getStatistics(partnerId: string) {
  const org = await loadPartner(partnerId);
  const counts = await partnerAdminQuery<{ locations: number; users: number; submissions: number }>(
    `SELECT
        (SELECT count(*)::int FROM partner_locations WHERE tenant_id = $1) AS locations,
        (SELECT count(*)::int FROM partner_users WHERE tenant_id = $1) AS users,
        (SELECT count(*)::int FROM partner_submissions WHERE tenant_id = $1) AS submissions`,
    [org.id]
  );
  const byState = await partnerAdminQuery<{ state: string; n: number }>(
    `SELECT state, count(*)::int AS n FROM partner_connector_records WHERE tenant_id = $1 GROUP BY state`,
    [org.id]
  );
  const last = await partnerAdminQuery<{ last: string | null }>(
    `SELECT max(updated_at) AS last FROM partner_connector_records WHERE tenant_id = $1`,
    [org.id]
  );
  const connectorCountsByState: Record<string, number> = {};
  for (const r of byState.rows) connectorCountsByState[r.state] = r.n;
  return {
    locationCount: counts.rows[0].locations,
    userCount: counts.rows[0].users,
    submissionCount: counts.rows[0].submissions,
    connectorCountsByState,
    lastConnectorActivityAt: last.rows[0].last,
    // No tenant-linked source for MintVault certificates/grading (Phase-1 rule) — explicitly unavailable.
    certificatesCount: null,
    gradedCount: null,
    unavailable: ["certificatesCount", "gradedCount"],
  };
}

export async function getPartnerAudit(partnerId: string, offset: number, limit: number) {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery(
    `SELECT id, action_type, actor_email, request_id, entity_type, entity_id, reason, result, error_code, created_at
       FROM partner_management_audit WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
    [org.id, limit, offset]
  );
  return { audit: rows };
}

// ---------------------------------------------------------------------------
// AG-1 — MULTI-LOCATION
//
// partner_locations has been multi-location-capable since migration 0001: tenant-scoped rows, a
// status ladder, per-user assignment via partner_user_locations, a station binding that already
// carries (tenant_id, location_id), and a resolver (findSoleEligibleLocation) that already handles
// the zero / exactly-one / more-than-one cases correctly. The ONE thing missing was any way to
// create a second row: createPartner() inserts a single 'Main location' and nothing else in the
// server tree has ever inserted into that table.
//
// So this section adds the missing administrative surface and NOTHING ELSE. No second location
// model, no new table, no column, no backfill. Existing single-location partners are unaffected —
// their one row keeps its id, and every code path that reads a location keeps reading the same one.
// ---------------------------------------------------------------------------

/** Locations are never hard-deleted (locked rule 14); a closed shop is SUSPENDED and stays auditable. */
const LOCATION_STATUSES = new Set(["PENDING", "ACTIVE", "SUSPENDED"]);

export interface PartnerLocationRow {
  id: string;
  publicRef: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressPostcode: string | null;
  addressCountry: string | null;
  address: string | null;
  status: string;
  createdAt: string;
  /** Approved, non-revoked stations bound to this location. */
  stationCount: number;
  /** Users explicitly assigned here. Org-wide roles reach every location and are NOT counted. */
  assignedUserCount: number;
  publicProfileConfigured: boolean;
  publicProfileReady: boolean;
  publicProfileLive: boolean;
  publicProfileBlockingReasons: string[];
  publicProfileUrl: string;
}

function cleanLocationName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length < 2 || name.length > 120) {
    throw new G5RequestError("VALIDATION_ERROR", "A location name of 2-120 characters is required.");
  }
  return name;
}

function cleanLocationAddress(value: unknown): string | null {
  if (value == null || value === "") return null;
  const address = typeof value === "string" ? value.trim() : "";
  if (address.length > 500)
    throw new G5RequestError("VALIDATION_ERROR", "A location address must be under 500 characters.");
  return address || null;
}

/**
 * Every location of one partner, with the two counts an administrator actually needs before
 * suspending one: how many stations sit there, and how many people are pinned to it.
 *
 * Both counts are computed in SQL rather than by the caller, so a large estate does not turn one
 * screen into N+1 round trips.
 */
export async function listPartnerLocations(partnerId: string): Promise<PartnerLocationRow[]> {
  const org = await loadPartner(partnerId);
  const { rows } = await partnerAdminQuery<{
    id: string;
    public_ref: string;
    name: string;
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_postcode: string | null;
    address_country: string | null;
    address: string | null;
    status: string;
    created_at: string;
    station_count: string;
    assigned_user_count: string;
  }>(
    `SELECT l.id, l.public_ref, l.name, l.address_line1, l.address_line2, l.address_city,
            l.address_postcode, l.address_country, l.address, l.status, l.created_at,
            COALESCE((SELECT count(*) FROM partner_stations s
                       WHERE s.location_id = l.id AND s.tenant_id = l.tenant_id
                         AND s.status <> 'REVOKED'), 0)::text AS station_count,
            COALESCE((SELECT count(*) FROM partner_user_locations pul
                       WHERE pul.location_id = l.id AND pul.tenant_id = l.tenant_id), 0)::text
              AS assigned_user_count
       FROM partner_locations l
      WHERE l.tenant_id = $1
      ORDER BY (l.status = 'ACTIVE') DESC, l.name`,
    [org.id]
  );
  return rows.map((r) => ({
    id: r.id,
    publicRef: r.public_ref,
    name: r.name,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    addressCity: r.address_city,
    addressPostcode: r.address_postcode,
    addressCountry: r.address_country,
    address: r.address,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    stationCount: Number(r.station_count),
    assignedUserCount: Number(r.assigned_user_count),
    // Publication state is intentionally loaded from the optional public-presence
    // schema through the dedicated status endpoint. Keeping the base operational
    // list independent allows schema-first deployment.
    publicProfileConfigured: false,
    publicProfileReady: false,
    publicProfileLive: false,
    publicProfileBlockingReasons: ["PUBLICATION_STATUS_SEPARATE"],
    publicProfileUrl: `${PUBLIC_PARTNER_PROFILE_PREFIX}${encodeURIComponent(r.public_ref)}`,
  }));
}

/**
 * Add a shop floor to an existing partner.
 *
 * Created ACTIVE, because an administrator adding a location is the approval — there is no second
 * party to wait for, unlike a station, whose PENDING state exists so that a Mac cannot enrol itself
 * into service. `partner_id` is set to the tenant id, matching the shape 0001 established and
 * createPartner() already uses.
 *
 * The duplicate-name refusal comes from uq_partner_locations_tenant_name_live (0084) and is
 * translated here into a message an administrator can act on, rather than a raw constraint error.
 */
export async function createPartnerLocation(
  actor: ActorContext,
  partnerId: string,
  input: { name: unknown; address?: unknown },
  reason: string
) {
  const org = await loadPartner(partnerId);
  const name = cleanLocationName(input.name);
  const address = cleanLocationAddress(input.address);

  return withAudit(actor, org.id, "partner_location_created", reason, null, async () => {
    let created;
    try {
      created = await partnerAdminQuery<{ id: string; public_ref: string }>(
        `INSERT INTO partner_locations (tenant_id, partner_id, name, address, status, created_by)
         VALUES ($1::uuid,$1::uuid,$2,$3,'ACTIVE',$4)
         RETURNING id, public_ref`,
        [org.id, name, address, actor.actorUserId]
      );
    } catch (err) {
      if ((err as { constraint?: string })?.constraint === "uq_partner_locations_tenant_name_live") {
        throw new G5RequestError(
          "VALIDATION_ERROR",
          `This partner already has a location called "${name}". Two shop floors with one name make every station list and audit line ambiguous.`
        );
      }
      throw err;
    }
    return {
      result: {
        locationId: created.rows[0].id,
        publicRef: created.rows[0].public_ref,
        name,
        address,
        status: "ACTIVE",
      },
      entityType: "location",
      entityId: created.rows[0].id,
      afterState: { name, address, status: "ACTIVE" },
    };
  });
}

/**
 * Correct a location's name or address.
 *
 * The location id is NEVER reissued, so every station, Card Job, certificate origin snapshot and
 * audit row that already points here keeps pointing here. Renaming a shop must not rewrite the
 * provenance of cards it has already graded — locked rule 8 — and it does not: the origin snapshot
 * on `certificates` was frozen at issue and is trigger-protected.
 */
export async function updatePartnerLocation(
  actor: ActorContext,
  partnerId: string,
  locationId: string,
  input: { name?: unknown; address?: unknown },
  reason: string
) {
  const org = await loadPartner(partnerId);
  const before = await partnerAdminQuery<{ name: string; address: string | null; status: string }>(
    `SELECT name, address, status FROM partner_locations WHERE id=$1 AND tenant_id=$2`,
    [locationId, org.id]
  );
  if (before.rows.length === 0) throw new G5RequestError("PARTNER_NOT_FOUND", "Location not found for this partner.");

  const name = "name" in input && input.name !== undefined ? cleanLocationName(input.name) : before.rows[0].name;
  const address =
    "address" in input && input.address !== undefined ? cleanLocationAddress(input.address) : before.rows[0].address;

  return withAudit(actor, org.id, "partner_location_updated", reason, before.rows[0], async () => {
    /*
     * Only a CHANGED raw address clears the structured record.
     *
     * The intent of the wipe is sound: once an operator rewrites the one-string address, the
     * structured columns behind it are stale, and resolveDeliverySnapshot correctly fails closed on
     * a half-structured record rather than mixing the two authorities. But the admin "Edit location"
     * modal always submits `address`, prefilled from the stored value — so changing only the NAME
     * counted as an address edit and silently NULLed address_line1..address_country. A first shop
     * onboarded through the guided flow would then fall back to the legacy path, and Supplies would
     * start refusing with DELIVERY_ADDRESS_REQUIRED — an error whose remedy text points at a screen
     * that cannot restore those fields. Comparing against the stored value makes an unchanged string
     * what it actually is: not an edit.
     */
    const rawAddressEdited = "address" in input && input.address !== undefined && address !== before.rows[0].address;
    try {
      await partnerAdminQuery(
        `UPDATE partner_locations
            SET name=$3, address=$4,
                address_line1=CASE WHEN $5 THEN NULL ELSE address_line1 END,
                address_line2=CASE WHEN $5 THEN NULL ELSE address_line2 END,
                address_city=CASE WHEN $5 THEN NULL ELSE address_city END,
                address_postcode=CASE WHEN $5 THEN NULL ELSE address_postcode END,
                address_country=CASE WHEN $5 THEN NULL ELSE address_country END,
                updated_at=now()
          WHERE id=$1 AND tenant_id=$2`,
        [locationId, org.id, name, address, rawAddressEdited]
      );
    } catch (err) {
      if ((err as { constraint?: string })?.constraint === "uq_partner_locations_tenant_name_live") {
        throw new G5RequestError("VALIDATION_ERROR", `This partner already has a location called "${name}".`);
      }
      throw err;
    }
    return {
      result: { locationId, name, address },
      entityType: "location",
      entityId: locationId,
      afterState: { name, address },
    };
  });
}

/**
 * The guided onboarding address editor. It writes only the selected existing
 * Main-location record and stores the legacy display string as a deterministic
 * rendering of the structured canonical fields; it never creates another
 * location or profile address.
 */
export async function updateFirstShopDeliveryAddress(
  actor: ActorContext,
  partnerId: string,
  locationId: string,
  rawAddress: PartnerDeliveryAddressInput,
  reason: string
) {
  const org = await loadPartner(partnerId);
  const address = requireFirstShopAddress(rawAddress);
  const before = await partnerAdminQuery<{ id: string; status: string }>(
    "SELECT id, status FROM partner_locations WHERE id=$1 AND tenant_id=$2",
    [locationId, org.id]
  );
  if (before.rows.length !== 1 || before.rows[0].status !== "ACTIVE") {
    throw new G5RequestError("PARTNER_NOT_FOUND", "Active Main location not found for this partner.");
  }
  return withAudit(actor, org.id, "partner_location_updated", reason, { locationId }, async () => {
    await partnerAdminQuery(
      `UPDATE partner_locations
          SET address=$3, address_line1=$4, address_line2=$5, address_city=$6,
              address_postcode=$7, address_country=$8, updated_at=now()
        WHERE id=$1 AND tenant_id=$2`,
      [
        locationId,
        org.id,
        formatPartnerDeliveryAddress(address),
        address.line1,
        address.line2,
        address.city,
        address.postcode,
        address.country,
      ]
    );
    return {
      result: { locationId, address },
      entityType: "location",
      entityId: locationId,
      afterState: { structuredDeliveryAddress: true },
    };
  });
}

/**
 * Reconciles an existing primary contact in place when it is the wrong type,
 * rather than creating a duplicate contact merely to make readiness green.
 */
export async function upsertFirstShopOperationsContact(
  actor: ActorContext,
  partnerId: string,
  raw: { fullName: string; email: string },
  reason: string
) {
  const contact = requireOperationalContact(raw.fullName, raw.email);
  const org = await loadPartner(partnerId);
  const existing = await partnerAdminQuery<{ id: string; version: number }>(
    `SELECT id, version
       FROM partner_contacts
      WHERE tenant_id=$1 AND active AND is_primary
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [org.id]
  );
  if (existing.rows[0]) {
    const updated = await updateContact(
      actor,
      org.id,
      existing.rows[0].id,
      { fullName: contact.fullName, email: contact.email, contactType: "operations", isPrimary: true },
      existing.rows[0].version,
      reason
    );
    return { ...updated, result: { contactId: existing.rows[0].id, reused: true } };
  }
  const created = await addContact(
    actor,
    org.id,
    { fullName: contact.fullName, email: contact.email, contactType: "operations", phone: null, title: null, isPrimary: true },
    reason
  );
  return { ...created, result: { contactId: (created.result as { contactId: string } | null)?.contactId ?? null, reused: false } };
}

async function loadOnboardingMainLocation(partnerId: string): Promise<{
  id: string;
  name: string;
  status: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressPostcode: string | null;
  addressCountry: string | null;
} | null> {
  const { rows } = await partnerAdminQuery<{
    id: string;
    name: string;
    status: string;
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_postcode: string | null;
    address_country: string | null;
  }>(
    `SELECT id, name, status, address_line1, address_line2, address_city, address_postcode, address_country
       FROM partner_locations
      WHERE tenant_id=$1 AND status='ACTIVE'
      ORDER BY (lower(btrim(name)) = 'main location') DESC, created_at ASC, id ASC
      LIMIT 1`,
    [partnerId]
  );
  const location = rows[0];
  return location
    ? {
        id: location.id,
        name: location.name,
        status: location.status,
        addressLine1: location.address_line1,
        addressLine2: location.address_line2,
        addressCity: location.address_city,
        addressPostcode: location.address_postcode,
        addressCountry: location.address_country,
      }
    : null;
}

export async function getFirstShopOnboarding(partnerId: string) {
  const org = await loadPartner(partnerId);
  const [mainLocation, contacts, readiness, profile] = await Promise.all([
    loadOnboardingMainLocation(org.id),
    listContacts(org.id),
    getPartnerOnboardingReadiness(org.id),
    partnerAdminQuery<{ version: number }>("SELECT version FROM partner_profiles WHERE tenant_id=$1", [org.id]),
  ]);
  // The direct loader intentionally mirrors readiness/Supplies' exact selection rule rather than
  // reusing the alphabetised locations-directory query. This also keeps early first-shop setup
  // available before a station exists.
  const primaryContact =
    (contacts.contacts as Array<{ active: boolean; is_primary: boolean }>).find(
      (contact) => contact.active && contact.is_primary
    ) ?? null;
  const owner = readiness.users.find((user: { role: string }) => user.role === "OWNER") ?? null;
  /*
   * Armed-but-not-yet-scanned is a state the Card Job facts CANNOT express — no job exists yet — and
   * it is the one the operator most needs to distinguish. "Nothing has happened" and "we have told
   * this shop's next card to be the test and are waiting for the Mac" look identical without it.
   * `undefined` means the arming authority itself was unreadable, and the wizard says so rather than
   * claiming nothing is armed.
   */
  const testCardArmedAt = await loadOnboardingTestCardArmedAt(org.id);
  return {
    organisation: readiness.organisation,
    profileVersion: profile.rows[0]?.version ?? 1,
    mainLocation,
    primaryContact,
    owner,
    operational: readiness.operational,
    testCardArmedAt: testCardArmedAt === undefined ? null : testCardArmedAt,
    testCardArmingReadable: testCardArmedAt !== undefined,
  };
}

/**
 * DECLARE that this shop's next new Card Job is its onboarding test card.
 *
 * This is the canonical initiation the marker requires. MintVault Scanner has no concept of a test
 * card and should not need one: an operator arms the shop here, the very next NEW at that shop is
 * stamped ONBOARDING_TEST inside the transaction that mints it (card-job-authority's
 * resolveCardJobPurpose), and the arm is consumed in the same breath. The classification is
 * therefore still made at the moment of creation by an explicit instruction — never applied to a
 * card that already exists, and never inferred from timing.
 *
 * COSTS. Arming spends nothing. The card the shop then scans costs exactly one Grading Credit, like
 * any other card, because a test card IS an ordinary card; only its label differs.
 *
 * IDEMPOTENT. Arming an already-armed shop is a successful no-op that writes no second audit row —
 * recording an event that did not occur would put a false entry in the one ledger an investigation
 * would trust. Arming a shop that already has an OPEN test card is refused with a cause the operator
 * can act on, rather than silently queueing a second one that 0109 would later reject.
 */
export async function armOnboardingTestCard(actor: ActorContext, partnerId: string, reason: string) {
  const org = await loadPartner(partnerId);
  await loadOrInitProfileVersion(org.id);

  const open = await partnerAdminQuery(
    `SELECT 1 FROM partner_card_jobs
      WHERE tenant_id = $1 AND purpose = 'ONBOARDING_TEST' AND status NOT IN ('COMPLETED','CANCELLED')
      LIMIT 1`,
    [org.id]
  );
  if (open.rows.length > 0) {
    throw new G5RequestError(
      "TEST_CARD_ALREADY_OPEN",
      "This shop already has an onboarding test card in progress. Finish or cancel that card first."
    );
  }

  const already = await loadOnboardingTestCardArmedAt(org.id);
  if (already === undefined) {
    throw new G5RequestError(
      "TEST_CARD_UNAVAILABLE",
      "The onboarding test-card authority is not available on this deployment."
    );
  }
  if (already !== null) return { result: { armedAt: already, changed: false }, alreadyCompleted: false };

  return withAudit(actor, org.id, "partner_onboarding_test_card_armed", reason, { armedAt: null }, async () => {
    // Conditional on the column still being clear, so two operators arming at once write one arm and
    // one no-op rather than two audit rows describing one state change.
    const armed = await partnerAdminQuery<{ armed_at: string }>(
      `UPDATE partner_profiles
          SET onboarding_test_card_armed_at = now(),
              onboarding_test_card_armed_by = $2,
              updated_at = now()
        WHERE tenant_id = $1 AND onboarding_test_card_armed_at IS NULL
        RETURNING onboarding_test_card_armed_at AS armed_at`,
      [org.id, actor.actorUserId]
    );
    const armedAt = armed.rows[0]?.armed_at ?? (await loadOnboardingTestCardArmedAt(org.id)) ?? null;
    return {
      result: { armedAt, changed: armed.rows.length > 0 },
      entityType: "partner",
      entityId: org.id,
      afterState: { armedAt },
    };
  });
}

/**
 * Open or close a shop floor. Never a delete.
 *
 * SUSPENDING IS A REAL OPERATIONAL EVENT, not a tidy-up, so the guards are deliberate:
 *
 *  - The LAST active location cannot be suspended. Every station and every user assignment hangs off
 *    a location; removing the last one would leave the partner unable to start any card while
 *    appearing perfectly healthy. Suspend the ORGANISATION for that.
 *  - Active stations are reported rather than silently orphaned. `assertStartAllowed` and
 *    `authoriseFix` both re-read location status, so capture at a suspended location stops server
 *    side — but an administrator should be told what they are about to stop.
 *
 * Cards already in flight keep their MV, their certificate and their credit: a closed shop floor is
 * not a reason to unpick paid work.
 */
export async function setPartnerLocationStatus(
  actor: ActorContext,
  partnerId: string,
  locationId: string,
  toStatus: string,
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (!LOCATION_STATUSES.has(toStatus)) {
    throw new G5RequestError("VALIDATION_ERROR", "A location status must be PENDING, ACTIVE or SUSPENDED.");
  }
  const before = await partnerAdminQuery<{ status: string; name: string }>(
    `SELECT status, name FROM partner_locations WHERE id=$1 AND tenant_id=$2`,
    [locationId, org.id]
  );
  if (before.rows.length === 0) throw new G5RequestError("PARTNER_NOT_FOUND", "Location not found for this partner.");
  if (before.rows[0].status === toStatus) {
    /*
     * Already in the requested state. Returned as a successful no-op rather than an error, so a
     * retried request is not punished — but `changed: false` says plainly that nothing happened, and
     * no audit row is written, because recording a suspension that did not occur would put a false
     * event in the one ledger an investigation would trust.
     *
     * `alreadyCompleted` is false: this was not an idempotency-key replay, it was a request whose
     * work was already done.
     */
    return { result: { locationId, status: toStatus, changed: false }, alreadyCompleted: false };
  }

  if (toStatus !== "ACTIVE") {
    const remaining = await partnerAdminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_locations
        WHERE tenant_id=$1 AND status='ACTIVE' AND id <> $2`,
      [org.id, locationId]
    );
    if (Number(remaining.rows[0].n) === 0) {
      throw new G5RequestError(
        "VALIDATION_ERROR",
        "This is the partner's only active location. Suspend the partner organisation instead — leaving it with no active location would stop all work while still looking healthy."
      );
    }
  }

  return withAudit(actor, org.id, "partner_location_status_changed", reason, before.rows[0], async () => {
    await partnerAdminQuery(`UPDATE partner_locations SET status=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2`, [
      locationId,
      org.id,
      toStatus,
    ]);
    const stations = await partnerAdminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM partner_stations
        WHERE tenant_id=$1 AND location_id=$2 AND status='ACTIVE'`,
      [org.id, locationId]
    );
    return {
      result: {
        locationId,
        status: toStatus,
        changed: true,
        /** Reported, not hidden: these stations stop capturing the moment this commits. */
        activeStationsAffected: Number(stations.rows[0].n),
      },
      entityType: "location",
      entityId: locationId,
      afterState: { status: toStatus, activeStationsAffected: Number(stations.rows[0].n) },
    };
  });
}

/**
 * Set exactly which shop floors a named user may operate at.
 *
 * REPLACES the whole set rather than adding one at a time, because "which locations may this person
 * work at" is a single decision and an add/remove pair leaves a window in which the answer is
 * neither the old one nor the new one.
 *
 * An EMPTY set is permitted and meaningful: the user is pinned nowhere and
 * `findSoleEligibleLocation` returns null for them, which the submission path already treats as
 * fail-CLOSED. It is not an error, and it must not be quietly converted into "all locations".
 *
 * Org-wide roles (OWNER / MANAGER / FINANCE_VIEWER) reach every ACTIVE location by role, so these
 * rows are advisory for them and authoritative for everybody else — the same rule
 * findSoleEligibleLocation and switchLocation already enforce. This function does not reimplement
 * that rule; it only records the assignments the rule reads.
 */
export async function setPartnerUserLocations(
  actor: ActorContext,
  partnerId: string,
  userId: string,
  locationIds: unknown,
  reason: string
) {
  const org = await loadPartner(partnerId);
  if (!Array.isArray(locationIds)) {
    throw new G5RequestError("VALIDATION_ERROR", "A list of location ids is required (an empty list is allowed).");
  }
  const requested = [...new Set(locationIds.map((id) => (typeof id === "string" ? id : "")))].filter(Boolean);

  const user = await partnerAdminQuery<{ id: string }>(`SELECT id FROM partner_users WHERE id=$1 AND tenant_id=$2`, [
    userId,
    org.id,
  ]);
  if (user.rows.length === 0) throw new G5RequestError("PARTNER_NOT_FOUND", "User not found for this partner.");

  // Every requested location must belong to THIS tenant. Checked in SQL against the tenant rather
  // than trusted from the request, so a valid-looking id from another partner cannot be assigned.
  if (requested.length > 0) {
    const owned = await partnerAdminQuery<{ id: string }>(
      `SELECT id FROM partner_locations WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
      [org.id, requested]
    );
    if (owned.rows.length !== requested.length) {
      throw new G5RequestError("VALIDATION_ERROR", "One or more locations do not belong to this partner.");
    }
  }

  const before = await partnerAdminQuery<{ location_id: string }>(
    `SELECT location_id FROM partner_user_locations WHERE tenant_id=$1 AND user_id=$2 ORDER BY location_id`,
    [org.id, userId]
  );
  const beforeIds = before.rows.map((r) => r.location_id);

  return withAudit(actor, org.id, "partner_user_locations_changed", reason, { locationIds: beforeIds }, async () => {
    await partnerAdminQuery(
      `DELETE FROM partner_user_locations WHERE tenant_id=$1 AND user_id=$2 AND NOT (location_id = ANY($3::uuid[]))`,
      [org.id, userId, requested]
    );
    if (requested.length > 0) {
      await partnerAdminQuery(
        `INSERT INTO partner_user_locations (tenant_id, user_id, location_id)
         SELECT $1::uuid, $2::uuid, unnest($3::uuid[])
         ON CONFLICT (user_id, location_id) DO NOTHING`,
        [org.id, userId, requested]
      );
    }
    return {
      result: { userId, locationIds: requested },
      entityType: "partner_user",
      entityId: userId,
      afterState: { locationIds: requested },
    };
  });
}

/**
 * Void a Card Job whose capture geometry cannot be recovered.
 *
 * Thin on purpose. The authority — what may be voided, releasing the credit exactly once,
 * preserving the MV number, leaving the evidence untouched — lives in
 * `voidCardJobUnrecoverableGeometry`, next to the station cancellation it deliberately differs
 * from, so the two refusal sets can be read against each other in one file. This adds the
 * super-admin wrapper: partner resolution, a mandatory reason, and the audit envelope.
 */
export async function voidPartnerCardJob(
  actor: ActorContext,
  partnerId: string,
  cardJobId: string,
  reason: string
) {
  const org = await loadPartner(partnerId);
  return withAudit(actor, org.id, "partner_card_job_voided", reason, { cardJobId }, async () => {
    const { voidCardJobUnrecoverableGeometry } = await import("./card-job-cancellation");
    const job = await lookupCardJobLocation(org.id, cardJobId);
    const voided = await voidCardJobUnrecoverableGeometry({
      tenantId: org.id,
      locationId: job.locationId,
      cardJobId,
      actorUserId: actor.actorUserId,
      actorEmail: actor.actorEmail ?? null,
      reason,
    });
    return {
      result: voided,
      entityType: "partner_card_job",
      entityId: voided.cardJobId,
      // The audit "after" is the fact that matters later: the card is closed, the number survives,
      // and the credit went back exactly once (or was already spent and correctly left alone).
      afterState: {
        status: voided.status,
        mvNumber: voided.mvNumber,
        reservationId: voided.reservationId,
        reservationReleased: voided.reservationReleased,
        cancelledCaptureSessions: voided.cancelledCaptureSessions,
        evidenceRetained: true,
      },
    };
  });
}

/** The job's own location, so the void runs under the same tenant+location scope as its creation. */
async function lookupCardJobLocation(tenantId: string, cardJobId: string): Promise<{ locationId: string | null }> {
  return withPartnerAdminTransaction(async (client) => {
    const found = await client.query<{ location_id: string | null }>(
      "SELECT location_id FROM partner_card_jobs WHERE tenant_id=$1 AND id=$2",
      [tenantId, cardJobId]
    );
    if (found.rows.length !== 1) throw new G5RequestError("PARTNER_NOT_FOUND", "Card Job not found.");
    return { locationId: found.rows[0].location_id ?? null };
  });
}
