/**
 * Pure, dependency-free Vault Quest R2 key-space guards.
 *
 * Extracted from render-saved.ts so the security-critical isolation logic (VQ may
 * only ever touch its own `vq/` keyspace — never grading / customer objects in the
 * SAME shared bucket) can be unit-tested without importing the render engine.
 * No side effects, no imports. Re-exported from render-saved.ts for existing
 * call-sites.
 */

/**
 * HARD prefix guard for every Vault Quest R2 WRITE. VQ may only ever write inside
 * its own isolated prefixes — it must never be able to touch MintVault grading /
 * customer paths (images/, certificates/, labels/, scans/, uploads/, …). Called
 * at every VQ upload site; throws on anything outside the allowlist or any key
 * that could be normalised elsewhere (`..`, backslash, leading slash, control
 * chars). R2 keys are literal strings, so this is defence-in-depth — but it makes
 * the isolation a hard invariant instead of a convention.
 */
export const VQ_WRITE_PREFIXES = ["vq/art-candidates/", "vq/art/", "vq/characters/"] as const;
export function assertVqWriteKey(key: string): string {
  const ok =
    VQ_WRITE_PREFIXES.some((p) => key.startsWith(p)) &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.startsWith("/") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f]/.test(key);
  if (!ok) throw new Error(`blocked R2 write outside Vault Quest prefixes: "${key.slice(0, 80)}"`);
  return key;
}

/**
 * Read-side mirror of {@link assertVqWriteKey}. Every VQ R2 READ must stay inside
 * the `vq/` keyspace and must not contain a path-traversal escape (`..`),
 * backslash, leading slash, or control char. Isolation from grading/customer
 * objects (same bucket) relies today on R2 treating keys as opaque literals — this
 * guard makes it a hard invariant instead, so a `..`-bearing key can never reach
 * getR2Buffer even if a normalising layer (CDN / disk cache) is ever inserted in
 * front of R2. Applied at the client-influenced read sites (derived card-art keys
 * and the reuse source); DB-sourced keys are already write-guarded at creation.
 */
export function assertVqReadKey(key: string): string {
  const ok =
    key.startsWith("vq/") &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.startsWith("/") &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f]/.test(key);
  if (!ok) throw new Error(`blocked R2 read outside Vault Quest keyspace: "${key.slice(0, 80)}"`);
  return key;
}
