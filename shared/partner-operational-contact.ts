/** One canonical validation predicate for an operational delivery contact. */
export const PARTNER_OPERATIONAL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalisePartnerOperationalEmail(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
export function hasValidPartnerOperationalContact(value: {
  fullName?: string | null;
  email?: string | null;
  active?: boolean | null;
  primary?: boolean | null;
  type?: string | null;
}): boolean {
  return (
    value.active === true &&
    value.primary === true &&
    value.type === "operations" &&
    typeof value.fullName === "string" &&
    value.fullName.trim().length > 0 &&
    PARTNER_OPERATIONAL_EMAIL_RE.test(normalisePartnerOperationalEmail(value.email))
  );
}
