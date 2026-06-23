/**
 * Redacts sensitive fields from an API response body before it is written to
 * the request log (the response logger in server/index.ts).
 *
 * Phase 0 (remediation): this is a behaviour-preserving extraction of the
 * previous inline logic, which stripped ONLY the `password` field. The output
 * is byte-identical to before; the only purpose of extracting it is to create
 * a tested seam.
 *
 * Phase 1 (security/redact-logs-and-errors) widens the deny-list to cover
 * tokens, emails, signed URLs, etc. — at which point the `it.todo` cases in
 * tests/log-redaction.test.ts become real assertions. Until then this function
 * must keep its current behaviour so logs stay usable.
 */
export function sanitizeResponseBodyForLog(body: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!body || typeof body !== "object") return body;
  const safe = { ...body };
  delete safe.password;
  return safe;
}
