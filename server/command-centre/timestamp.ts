/**
 * Attention ordering is lexical by design, so every adapter candidate must
 * cross its source boundary as a valid ISO-8601 UTC string. PostgreSQL drivers
 * commonly return either timestamp strings or Date instances.
 */
export function normaliseCommandCentreTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
