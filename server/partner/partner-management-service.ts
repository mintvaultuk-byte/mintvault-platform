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
import { G5RequestError, canTransitionStatus, isPartnerStatus, type PartnerStatus } from "./partner-management-errors";
import { hashPassword, isValidPartnerPassword } from "./auth";
import { deliverInvitationToken, invitationDeliveryConfigured } from "./delivery";
import { ensureWallet } from "./partner-wallet-service";
import { APP_BASE_URL } from "../app-url";
import type { PoolClient } from "pg";
import crypto from "node:crypto";

export interface ActorContext {
  actorUserId: string;
  actorEmail: string;
  requestId: string;
  idempotencyKey?: string;
}

type CreatePartnerFailurePoint = "after_org_insert" | "after_default_location_insert";
type InvitePartnerFailurePoint =
  "after_user_insert" | "after_role_assignment" | "before_invitation_insert" | "before_invitation_audit";

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
  | "partner_created"
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
  | "partner_wallet_backfilled";

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
        (
          await client.query<{ id: string }>("SELECT id FROM partner_wallets WHERE tenant_id=$1", [org.id])
        ).rows[0]?.id;
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

async function priorSuccess(idempotencyKey: string | undefined): Promise<boolean> {
  if (!idempotencyKey) return false;
  const { rows } = await partnerAdminQuery(
    `SELECT 1 FROM partner_management_audit WHERE idempotency_key = $1 AND result = 'succeeded' LIMIT 1`,
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
  if (await priorSuccess(actor.idempotencyKey)) return { result: null, alreadyCompleted: true };
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
  // otherwise create a duplicate org before withAudit's own priorSuccess check. Short-circuit here,
  // BEFORE any write, when a prior succeeded action already used this key (create's key namespace is
  // pre-tenant, so this pre-check is global — matching the ledger's global idempotency namespace).
  if (await priorSuccess(actor.idempotencyKey)) return { result: null, alreadyCompleted: true };
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
} as const;
export type AdminPartnerRole = keyof typeof ADMIN_ROLE_TO_PARTNER_ROLE;

const PARTNER_ROLE_TO_ADMIN_ROLE: Record<string, AdminPartnerRole> = {
  PARTNER_OWNER: "OWNER",
  PARTNER_MANAGER: "ADMIN",
  MVGS_ASSESSMENT_TECHNICIAN: "GRADER",
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
  delivery: { email: string; token: string; partnerName: string; roleCode: string; expiresAt: Date };
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
  const { rows } = await client.query<{ id: string; partner_name: string }>(
    `WITH ins AS (
       INSERT INTO partner_invitations
         (tenant_id, user_id, email, role_code, token_hash, invited_by_user_id, invited_by_email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id
     )
     SELECT ins.id, o.legal_name AS partner_name FROM ins, partner_organisations o WHERE o.id=$1`,
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
    delivery: { email, token, partnerName: rows[0].partner_name, roleCode, expiresAt },
    invitationLink: adminInviteLinkCopyAllowed() ? inviteLink(token) : undefined,
  };
}

async function recordInvitationDelivery(invite: {
  invitationId: string;
  deliveryStatus: string;
  delivery: { email: string; token: string; partnerName: string; roleCode: string; expiresAt: Date };
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
  onboardingState:
    | "INVITED"
    | "AWAITING_PASSWORD_SETUP"
    | "AWAITING_MFA_SETUP"
    | "READY_TO_LOG_IN"
    | "SUSPENDED"
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
  loginFlagEnabled: boolean
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
  const onboardingState: PartnerLoginReadiness["onboardingState"] =
    row.user_status === "SUSPENDED" || row.org_status === "SUSPENDED" || row.user_status === "REVOKED" || row.org_status === "REVOKED"
      ? "SUSPENDED"
      : row.user_status === "INVITED"
        ? "INVITED"
        : !passwordConfigured
          ? "AWAITING_PASSWORD_SETUP"
          : mfaRequired && !mfaConfigured
            ? "AWAITING_MFA_SETUP"
            : portalEnabled && loginFlagEnabled && organisationActive && userActive && locationEligible
              ? "READY_TO_LOG_IN"
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
    loginEnabled:
      portalEnabled && loginFlagEnabled && organisationActive && userActive && passwordConfigured &&
      (!mfaRequired || mfaConfigured) && locationEligible,
    loginFlagEnabled,
    portalEnabled,
    onboardingState,
    blockedReasons,
  };
}

export async function getPartnerOnboardingReadiness(partnerId: string) {
  const org = await loadPartner(partnerId);
  let portalEnabled = false;
  let loginFlagEnabled = false;
  try {
    const { resolveGlobalFlag } = await import("./flags");
    [portalEnabled, loginFlagEnabled] = await Promise.all([
      resolveGlobalFlag("partner_portal_enabled"),
      resolveGlobalFlag("partner_login_enabled"),
    ]);
  } catch {
    portalEnabled = false;
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
  return {
    organisation: { id: org.id, legalName: org.legal_name, status: org.status },
    portalEnabled,
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
      readiness: buildLoginReadiness(u, portalEnabled, loginFlagEnabled),
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
    const token = await createPasswordResetToken(org.id, userId);
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
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    !isValidPartnerPassword(password)
  ) {
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
