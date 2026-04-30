/**
 * server/vault-club-audit.ts
 *
 * Thin wrapper over storage.writeAuditLog() that pins the entity_type +
 * admin_user shape used for Vault Club subscription state changes. The
 * underlying audit_log table (shared/schema.ts) is unchanged.
 *
 * Phase 1 Step 1 — STUB. Defined but NOT wired to anything yet. Webhook
 * handlers in Step 3 will call this from the
 * customer.subscription.created/updated/deleted handlers, with the full
 * Stripe event payload passed through `details`.
 *
 * Audit row shape:
 *   entity_type  = "vault_club_subscription"
 *   entity_id    = subscription row id (NOT the Stripe sub id — internal)
 *   action       = e.g. "created", "trial_started", "trial_ended_paid",
 *                       "renewed", "payment_failed", "canceled", "reactivated"
 *   admin_user   = "stripe-webhook" for webhook-driven changes,
 *                  "system" for cron-driven (e.g. trial expiry sweeps),
 *                  admin email for manual admin changes
 *   details      = jsonb. For webhook events, include {
 *                    stripe_event_id, stripe_subscription_id,
 *                    previous_status, new_status, raw: <event payload>
 *                  }
 */

import { storage } from "./storage";

export type VaultClubAuditAction =
  | "created"
  | "trial_started"
  | "trial_ended_paid"
  | "trial_ended_canceled"
  | "renewed"
  | "payment_failed"
  | "payment_recovered"
  | "canceled"
  | "reactivated"
  | "comped"
  | "comp_revoked";

export async function writeVaultClubSubscriptionAudit(
  subscriptionId: string,
  action: VaultClubAuditAction,
  adminUser: "stripe-webhook" | "system" | (string & {}),
  details: Record<string, unknown> = {}
): Promise<void> {
  await storage.writeAuditLog(
    "vault_club_subscription",
    subscriptionId,
    action,
    adminUser,
    details
  );
}
