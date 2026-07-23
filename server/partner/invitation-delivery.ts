/**
 * Partner invitation delivery boundary. Raw invitation tokens exist only long enough to build the
 * fragment URL passed to the configured adapter/Resend request. They are never logged, stored, or
 * returned by an API response.
 */
import { sendPartnerInvitationEmail } from "../email";

const INVITATION_PAGE = "https://mintvaultuk.com/partner/invite";

export type PartnerInvitationDeliveryAdapter = (input: {
  email: string;
  invitationUrl: string;
  expiresAt: Date;
  roleLabel: string;
}) => Promise<{ providerMessageId?: string; suppressed?: boolean }>;

let adapter: PartnerInvitationDeliveryAdapter | null = null;

/** Test/development hook. Production uses the existing Resend implementation by default. */
export function setPartnerInvitationDeliveryAdapter(next: PartnerInvitationDeliveryAdapter | null): void {
  adapter = next;
}

export function partnerInvitationUrl(token: string): string {
  return `${INVITATION_PAGE}#token=${encodeURIComponent(token)}`;
}

export async function deliverPartnerInvitation(input: {
  email: string;
  token: string;
  expiresAt: Date;
  roleLabel: string;
}): Promise<{ providerMessageId?: string; suppressed?: boolean }> {
  const invitationUrl = partnerInvitationUrl(input.token);
  if (adapter) {
    return adapter({ email: input.email, invitationUrl, expiresAt: input.expiresAt, roleLabel: input.roleLabel });
  }
  const result = await sendPartnerInvitationEmail({
    email: input.email,
    invitationUrl,
    expiresAt: input.expiresAt,
    roleLabel: input.roleLabel,
  });
  return { providerMessageId: result.id };
}
