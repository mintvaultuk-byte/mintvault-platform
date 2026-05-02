/**
 * server/vault-club-consents.ts
 *
 * Phase 1 Step 5d — Vault Club consent helpers.
 *
 * Two operations, both audited:
 *
 *   - recordConsent(...) — INSERT one row. Every checkout attempt that
 *     passes the duplicate-sub guards records its own row. Returns the
 *     row id and captured_at for downstream Stripe-metadata use.
 *
 *   - attachConsentToStripeRefs(...) — UPDATE the row with the Stripe
 *     Customer + Session ids once the Checkout Session creation
 *     succeeds. Idempotent via COALESCE: re-attaching the same ids
 *     to an already-attached row is a no-op.
 *
 * Every write writes an audit_log row (entity_type
 * 'vault_club_consent', actions 'consent_recorded' /
 * 'consent_linked'). Regulator may ask for a paper trail under DMCC.
 *
 * Soft-delete posture: rows are NEVER deleted. A user later disputing
 * a charge needs the consent record to persist beyond the
 * subscription's lifetime. ON DELETE CASCADE on user_id only fires
 * if the user record itself is deleted (deletion-of-user is its own
 * GDPR scope; the consent rows go with the user, intentionally).
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";

// ── Audit helper — pinned to the vault_club_consent entity_type ──────────

type ConsentAuditAction = "consent_recorded" | "consent_linked";

async function writeConsentAudit(
  consentId: string,
  action: ConsentAuditAction,
  details: Record<string, unknown> = {},
): Promise<void> {
  await storage.writeAuditLog(
    "vault_club_consent",
    consentId,
    action,
    "system",
    details,
  );
}

// ── Public helpers ────────────────────────────────────────────────────────

export interface RecordConsentInput {
  userId: string;
  termsVersion: string;
  consentTextHash: string;
  interval: "month" | "year";
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RecordConsentResult {
  id: string;
  capturedAt: Date;
}

/**
 * INSERT a new consent row. No ON CONFLICT — every call appends. The
 * caller is responsible for not calling this on duplicate-sub paths
 * (handleVaultClubCheckout runs the Layer 1 + Layer 2 guards before
 * reaching this).
 *
 * IP and user-agent are captured for evidentiary value. Both nullable
 * because some test paths and admin tools won't set them.
 */
export async function recordConsent(
  input: RecordConsentInput,
): Promise<RecordConsentResult> {
  const result = await db.execute(sql`
    INSERT INTO vault_club_consents
      (user_id, terms_version, consent_text_hash, interval, ip_address, user_agent)
    VALUES
      (${input.userId}, ${input.termsVersion}, ${input.consentTextHash},
       ${input.interval}, ${input.ipAddress}::inet, ${input.userAgent})
    RETURNING id, captured_at
  `);
  const row = result.rows[0] as { id: string; captured_at: string };
  const capturedAt = new Date(row.captured_at);

  await writeConsentAudit(row.id, "consent_recorded", {
    user_id: input.userId,
    terms_version: input.termsVersion,
    consent_text_hash: input.consentTextHash,
    interval: input.interval,
    has_ip: input.ipAddress !== null,
    has_user_agent: input.userAgent !== null,
  });

  return { id: row.id, capturedAt };
}

export interface AttachStripeRefsInput {
  stripeCustomerId: string;
  stripeSessionId: string;
}

/**
 * Set the Stripe ids on a consent row that previously had them null.
 * COALESCE ensures we never overwrite an already-attached value — if
 * a retry of the checkout call somehow re-enters with a different
 * session id, the original sticks. (In practice the duplicate-sub
 * guard runs first and prevents the retry; this is belt-and-braces.)
 */
export async function attachConsentToStripeRefs(
  consentId: string,
  refs: AttachStripeRefsInput,
): Promise<void> {
  await db.execute(sql`
    UPDATE vault_club_consents
    SET stripe_customer_id = COALESCE(stripe_customer_id, ${refs.stripeCustomerId}),
        stripe_session_id  = COALESCE(stripe_session_id,  ${refs.stripeSessionId})
    WHERE id = ${consentId}
  `);
  await writeConsentAudit(consentId, "consent_linked", {
    stripe_customer_id: refs.stripeCustomerId,
    stripe_session_id: refs.stripeSessionId,
  });
}
