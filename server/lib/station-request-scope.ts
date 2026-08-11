/**
 * Which paths a SIGNED PARTNER STATION principal may reach.
 *
 * `requireScannerOrAdmin` is shared with six pre-existing GLOBAL admin certificate routes —
 * `/api/admin/orphan-certs`, `/api/admin/certs/:certId/preview`, `POST /api/admin/certs/:certId/image`,
 * `DELETE /api/admin/certs/:certId` and `/api/admin/scan-status/:certId`. Those routes address
 * `certificates` by certificate_number with NO tenant predicate, because their only principals were
 * ever an admin cookie or the HQ scanner token. Admitting a partner station principal to the shared
 * middleware silently handed every approved partner cross-tenant reads, evidence overwrites,
 * presigned-URL disclosure and soft-deletes across the whole certificate estate.
 *
 * Station-reachable paths are therefore allowlisted explicitly rather than inherited, and a station
 * that reaches anything else is REFUSED rather than falling through to the admin-cookie check — a
 * station key must never be evaluated as an admin credential.
 *
 * This module deliberately has NO imports. The boundary suite imports it directly, and pulling in
 * `scanner-auth.ts` would drag the whole server module graph (storage → db → config) into what is
 * meant to be a pure, database-free test.
 *
 * KNOWN CONSEQUENCE (follow-up, not a regression): the Electron station signs every request once it
 * holds a station session, so the app's "Fix orphan…" picker, cert preview and scan-status lookups
 * now receive 403 when driven by a signed station. They are not on the PREVIEW → SCAN → ACCEPT
 * capture path. Restoring them safely needs per-route tenant scoping (bind `:certId` to the
 * station's tenant through the same `partner_connector_imports` join the capture service uses),
 * which is a larger change than this release should carry.
 */
const STATION_ALLOWED_PATHS = [
  // The station's own armed capture work. Every one of these is additionally bound to the
  // station's claimed session by requireStationCaptureAgent and the capture service.
  /^\/api\/admin\/scanner\/capture-sessions(?:\/|\?|$)/,
  /^\/api\/admin\/scanner\/targets(?:\/|\?|$)/,
  /^\/api\/admin\/scanner\/station(?:\/|\?|$)/,
  // Advisory display hint only: returns cert_counter.last_issued + 1 and no certificate data.
  /^\/api\/admin\/next-cert-id(?:\/|\?|$)/,
];

/** Is this path reachable by a signed station principal? Prefix-anchored; query string ignored. */
export function stationPathAllowed(path: string): boolean {
  const clean = path.split("?")[0];
  return STATION_ALLOWED_PATHS.some((re) => re.test(clean));
}
