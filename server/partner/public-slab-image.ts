/**
 * The anonymous slab-image lookup — extracted so it can be PROVEN, not just asserted.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────────────────────
 * BLOCKER B2 was that `GET /api/public/slab-image/:certNumber/:kind` — unauthenticated, and the
 * image source for the public slab showcase, the public certificate page and every card tile on a
 * partner shop profile — resolved its certificate with `storage.getCertificateByCertId()` (a
 * Drizzle `SELECT *`) and a raw `db.execute`, both on the owner, BYPASSRLS, unbounded MintVault
 * pool that Super Admin depends on.
 *
 * The repair moved it to the least-privileged 0061 reader against the 0064 projection. But while
 * the lookup lived inline in a 12,000-line route file, the only way to test it was to stand up the
 * entire Express app, and the only thing anyone could realistically write was a source-text pin —
 * which proves the code READS a certain way, not that it BEHAVES that way. Mutation
 * PUBLIC-IMAGE-ADMIN1 ("route the lookup back through the privileged pool") had no detector at all.
 *
 * Twelve lines in their own module make the difference between a claim and a proof.
 *
 * ── THE PROPERTY THIS FILE EXISTS TO GUARANTEE ──────────────────────────────────────────────
 * Anonymous slab-image traffic reaches the database ONLY through `partnerPublicQuery`, and there
 * is NO privileged fallback. If the public reader cannot serve — the URL is unset, the login role
 * is not a member of `partner_public_reader`, the endpoint is down — this THROWS, and the route
 * turns that into a 503. It does not quietly succeed on the owner connection.
 *
 * That asymmetry is the whole design. A public showcase that is briefly down is recoverable in one
 * deploy; anonymous traffic silently executing with owner privilege is not recoverable by noticing
 * later, because nothing about it looks wrong.
 */
import { partnerPublicQuery } from "./db";

/** What the proxy needs, and nothing else: a resolved storage key and a yes/no. */
export interface PublicSlabImageRow {
  /** The R2 object key of the front scan, already resolved by the projection's precedence. */
  scanObjectKey: string | null;
  /** Distinguishes "eligible, no image" from "not eligible" WITHOUT inferring it from a NULL key. */
  hasScan: boolean;
}

/**
 * Resolve one publication-eligible certificate's slab image, as the least-privileged reader.
 *
 * Returns `null` when the certificate is not publicly eligible — deleted, not active, ungraded, or
 * awaiting HQ approval. That gate lives in the VIEW DEFINITION (migration 0064), not here, so a
 * future edit to this function cannot widen what anonymous callers can see. A row that does not
 * come back IS the 404.
 *
 * THROWS on any database failure. Deliberately: the caller classifies (a Neon restart is a 503, a
 * query bug is a 500 that shows up in alerting) and a swallow here would turn both into a silent
 * 404 — indistinguishable from "no such certificate", which is how an outage becomes invisible.
 */
export async function lookupPublicSlabImage(certNumber: string): Promise<PublicSlabImageRow | null> {
  const { rows } = await partnerPublicQuery<{ scan_object_key: string | null; has_scan: boolean }>(
    `SELECT scan_object_key, has_scan
       FROM public_slab_image_projection
      WHERE certificate_number = $1
      LIMIT 1`,
    [certNumber],
  );
  const row = rows[0];
  if (!row) return null;
  return { scanObjectKey: row.scan_object_key, hasScan: row.has_scan === true };
}
