/**
 * G6D reservation-expiry entry point. Registered from server/index.ts through the normal
 * advisory-lock scheduler so every production instance may tick, while only one instance mutates
 * reservations at a time. The domain operation is idempotent and also handles a pre-0017 database
 * as a safe no-op during an application-first rollout.
 */
import { expireExpiredReservations } from "../partner/partner-credit-reservation-service";

export async function runPartnerCreditReservationExpiry(): Promise<{ processed: number; expired: string[] }> {
  return expireExpiredReservations({ limit: 100 });
}
