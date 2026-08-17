/**
 * Partner Portal — reset/notification delivery abstraction (Phase 1).
 *
 * Password-reset tokens are delivered OUT-OF-BAND (email in production). The runtime never returns
 * the token in an HTTP response. A pluggable adapter lets tests capture the token locally without
 * sending real email. In production, if NO approved delivery provider is configured, delivery FAILS
 * CLOSED (throws) — the reset request stays generic to the caller, but no token is issued/leaked.
 */
import { requireCredentialLinkBaseUrl } from "../app-url";

export type ResetDeliveryAdapter = (email: string, token: string) => Promise<void>;
export type InvitationDeliveryAdapter = (data: {
  email: string;
  token: string;
  partnerName: string;
  roleCode: string;
  expiresAt: Date;
}) => Promise<void>;

/**
 * Constant, fully-redacted operational signal emitted when a reset delivery does not happen.
 * Deliberately carries NO variable content — a reset delivery failure must never become an oracle
 * for token material or for whether an address is a partner account.
 */
export const RESET_DELIVERY_FAILED_SIGNAL = "[partner-reset] delivery failed";

let adapter: ResetDeliveryAdapter | null = null;
let inviteAdapter: InvitationDeliveryAdapter | null = null;

/** Configure the delivery adapter (a real email provider in prod; a capturing double in tests). */
export function setResetDeliveryAdapter(a: ResetDeliveryAdapter | null): void {
  adapter = a;
}

export function setInvitationDeliveryAdapter(a: InvitationDeliveryAdapter | null): void {
  inviteAdapter = a;
}

export function resetDeliveryConfigured(): boolean {
  return adapter !== null || !!process.env.RESEND_API_KEY;
}

export function invitationDeliveryConfigured(): boolean {
  return inviteAdapter !== null || !!process.env.RESEND_API_KEY;
}

/**
 * Deliver a reset token. Throws (fail closed) if no provider is configured.
 *
 * SECRECY: no thrown message may contain the token, the reset URL, or the recipient address —
 * the provider error is deliberately discarded and replaced with a constant string so neither the
 * secret nor partner-account existence can leak into logs or error reporting.
 */
export async function deliverResetToken(email: string, token: string): Promise<void> {
  if (adapter) {
    await adapter(email, token);
    return;
  }
  let sent: { id: string } | null;
  try {
    // Imported inside the try so a module-resolution failure is caught and signalled like any other
    // delivery failure, instead of escaping as a raw (potentially path-revealing) error.
    const { sendPartnerResetEmail } = await import("../email");
    const { RESET_TOKEN_MINUTES } = await import("./auth");
    sent = await sendPartnerResetEmail({
      email,
      resetUrl: `${requireCredentialLinkBaseUrl()}/partner/reset?token=${encodeURIComponent(token)}`,
      expiresMinutes: RESET_TOKEN_MINUTES,
    });
  } catch {
    // Redacted failure signal: constant text only. No token, no recipient, and nothing that
    // indicates whether the address belongs to a partner account.
    console.warn(RESET_DELIVERY_FAILED_SIGNAL);
    throw new Error("partner reset delivery failed");
  }
  if (!sent) {
    console.warn(RESET_DELIVERY_FAILED_SIGNAL);
    throw new Error("no reset delivery provider configured — failing closed");
  }
}

/** Deliver an invitation token. Throws (fail closed) if no provider is configured. */
export async function deliverInvitationToken(data: {
  email: string;
  token: string;
  partnerName: string;
  roleCode: string;
  expiresAt: Date;
}): Promise<void> {
  if (inviteAdapter) {
    await inviteAdapter(data);
    return;
  }
  const { sendPartnerInvitationEmail } = await import("../email");
  const sent = await sendPartnerInvitationEmail({
    email: data.email,
    partnerName: data.partnerName,
    roleCode: data.roleCode,
    invitationUrl: `${process.env.APP_URL || "https://mintvaultuk.com"}/partner/invite?token=${encodeURIComponent(
      data.token
    )}`,
    expiresAt: data.expiresAt,
  });
  if (!sent) throw new Error("no invitation delivery provider configured — failing closed");
}
