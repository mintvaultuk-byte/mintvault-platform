/**
 * Small, dependency-free helpers shared by the Super Admin operations routes
 * and their focused tests. Keeping query normalisation here makes the HTTP
 * handler's security boundary explicit and easy to audit.
 */

export const OPERATIONS_SEARCH_MIN_LENGTH = 2;
export const OPERATIONS_SEARCH_MAX_LENGTH = 80;
export const OPERATIONS_RESULTS_PER_TYPE = 8;

export function normaliseOperationsSearchQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, OPERATIONS_SEARCH_MAX_LENGTH);
}

/** Exact numeric identifiers are useful before they reach the normal text minimum. */
export function isExactNumericOperationsQuery(value: string): boolean {
  return /^\d+$/.test(value);
}

export function isEligibleOperationsSearchQuery(value: string): boolean {
  return isExactNumericOperationsQuery(value) || value.length >= OPERATIONS_SEARCH_MIN_LENGTH;
}

/**
 * Escape SQL LIKE metacharacters. The route still passes this value as a bound
 * parameter; this additionally prevents a user from broadening a search with
 * `%`, `_`, or the LIKE escape character itself.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Keep email lookup possible without returning more customer PII than needed. */
export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const [local, domain] = value.split("@");
  if (!domain) return "…";
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}…@${domain}`;
}

export function operationsSearchPattern(query: string): string {
  return `%${escapeLikePattern(query)}%`;
}
