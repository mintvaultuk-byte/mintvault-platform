/**
 * Partner Portal — reset/notification delivery abstraction (Phase 1).
 *
 * Password-reset tokens are delivered OUT-OF-BAND (email in production). The runtime never returns
 * the token in an HTTP response. A pluggable adapter lets tests capture the token locally without
 * sending real email. In production, if NO approved delivery provider is configured, delivery FAILS
 * CLOSED (throws) — the reset request stays generic to the caller, but no token is issued/leaked.
 */
export type ResetDeliveryAdapter = (email: string, token: string) => Promise<void>;

let adapter: ResetDeliveryAdapter | null = null;

/** Configure the delivery adapter (a real email provider in prod; a capturing double in tests). */
export function setResetDeliveryAdapter(a: ResetDeliveryAdapter | null): void {
  adapter = a;
}

export function resetDeliveryConfigured(): boolean {
  return adapter !== null;
}

/** Deliver a reset token. Throws (fail closed) if no provider is configured. */
export async function deliverResetToken(email: string, token: string): Promise<void> {
  if (!adapter) throw new Error("no reset delivery provider configured — failing closed");
  await adapter(email, token);
}
