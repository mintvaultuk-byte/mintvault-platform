/**
 * Partner Portal — reset/notification delivery abstraction (Phase 1).
 *
 * Password-reset tokens are delivered OUT-OF-BAND (email in production). The runtime never returns
 * the token in an HTTP response. A pluggable adapter lets tests capture the token locally without
 * sending real email. In production, if NO approved delivery provider is configured, delivery FAILS
 * CLOSED (throws) — the reset request stays generic to the caller, but no token is issued/leaked.
 */
export type ResetDeliveryAdapter = (email: string, token: string) => Promise<void>;
export type InvitationDeliveryAdapter = (data: {
  email: string;
  token: string;
  partnerName: string;
  roleCode: string;
  expiresAt: Date;
}) => Promise<void>;

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
  return adapter !== null;
}

export function invitationDeliveryConfigured(): boolean {
  return inviteAdapter !== null || !!process.env.RESEND_API_KEY;
}

/** Deliver a reset token. Throws (fail closed) if no provider is configured. */
export async function deliverResetToken(email: string, token: string): Promise<void> {
  if (!adapter) throw new Error("no reset delivery provider configured — failing closed");
  await adapter(email, token);
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
