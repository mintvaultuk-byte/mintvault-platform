import crypto from "node:crypto";
import { withPartnerAdminTransaction } from "./db";
import { writePartnerAudit } from "./audit";
import { getUserPermissions, getUserRoles } from "./permissions";
import { SCANNER_ACCESS_MINUTES, SESSION_ABSOLUTE_HOURS } from "./auth";
import { StationServiceError, type StationPrincipal } from "./station-service";
import type { PartnerPrincipal } from "./session";

const ORG_WIDE_ROLES = new Set(["PARTNER_OWNER", "PARTNER_MANAGER", "PARTNER_FINANCE_VIEWER"]);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function scannerToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 2048) {
    throw new StationServiceError("validation", "Scanner refresh credential is invalid");
  }
  return value;
}

export interface ScannerSessionAuthority {
  refreshToken: string;
  stationCode: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

/**
 * Exchange one freshly authenticated, MFA-passed Scanner access session for a
 * twelve-hour refresh family bound to this exact station.  Retrying after a
 * response loss revokes the undisclosed prior token and returns one new token;
 * no business authority is duplicated.
 */
export async function bindScannerRefreshSession(
  station: StationPrincipal,
  operator: PartnerPrincipal
): Promise<ScannerSessionAuthority> {
  if (operator.sessionKind !== "SCANNER" || !operator.mfaPassed || !operator.permissions.has("partner.cards.scan")) {
    throw new StationServiceError("forbidden", "A fresh Scanner login with MFA is required");
  }
  if (
    operator.tenantId !== station.tenantId ||
    (!operator.orgWide && operator.locationId !== station.locationId) ||
    (operator.stationId && operator.stationId !== station.id)
  ) {
    throw new StationServiceError("forbidden", "Scanner session scope does not match this station");
  }
  const refreshToken = crypto.randomBytes(32).toString("base64url");
  return withPartnerAdminTransaction(async (client) => {
    const current = await client.query<{
      created_at: string;
      absolute_expires_at: string;
      revoked_at: string | null;
      session_kind: string;
      station_id: string | null;
    }>(
      `SELECT created_at,absolute_expires_at,revoked_at,session_kind,station_id
         FROM partner_sessions
        WHERE id=$1 AND tenant_id=$2 AND user_id=$3
        FOR UPDATE`,
      [operator.sessionId, station.tenantId, operator.userId]
    );
    const source = current.rows[0];
    if (
      !source ||
      source.revoked_at ||
      source.session_kind !== "SCANNER" ||
      (source.station_id && source.station_id !== station.id) ||
      new Date(source.absolute_expires_at).getTime() <= Date.now()
    ) {
      throw new StationServiceError("forbidden", "Fresh Scanner login has expired or is already bound elsewhere");
    }
    const refreshExpiresAt = new Date(
      new Date(source.created_at).getTime() + SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000
    );
    if (refreshExpiresAt.getTime() <= Date.now()) {
      throw new StationServiceError("forbidden", "Scanner refresh lifetime has expired");
    }
    await client.query(
      `UPDATE partner_scanner_refresh_sessions
          SET revoked_at=now()
        WHERE user_id=$1 AND revoked_at IS NULL`,
      [operator.userId]
    );
    const inserted = await client.query<{ id: string; absolute_expires_at: string }>(
      `INSERT INTO partner_scanner_refresh_sessions
         (tenant_id,location_id,user_id,station_id,source_session_id,token_hash,credential_version,absolute_expires_at)
       SELECT $1,$2,$3,$4,$5,$6,u.credential_version,$7
         FROM partner_users u
        WHERE u.id=$3 AND u.tenant_id=$1 AND u.status='ACTIVE'
       RETURNING id,absolute_expires_at`,
      [
        station.tenantId,
        station.locationId,
        operator.userId,
        station.id,
        operator.sessionId,
        sha256(refreshToken),
        refreshExpiresAt.toISOString(),
      ]
    );
    if (inserted.rowCount !== 1) {
      throw new StationServiceError("forbidden", "Scanner operator is no longer active");
    }
    const bound = await client.query(
      `UPDATE partner_sessions
          SET station_id=$2,scanner_refresh_id=$3
        WHERE id=$1 AND revoked_at IS NULL AND session_kind='SCANNER'
          AND (station_id IS NULL OR station_id=$2)`,
      [operator.sessionId, station.id, inserted.rows[0].id]
    );
    if (bound.rowCount !== 1) {
      throw new StationServiceError("forbidden", "Scanner access session could not be bound to this station");
    }
    await writePartnerAudit(client, {
      tenantId: station.tenantId,
      locationId: station.locationId,
      actorUserId: operator.userId,
      deviceId: station.id,
      sessionId: operator.sessionId,
      action: "scanner_refresh_session_bound",
      recordType: "partner_station",
      recordId: station.id,
    });
    return {
      refreshToken,
      stationCode: station.code,
      accessExpiresAt: new Date(source.absolute_expires_at).toISOString(),
      refreshExpiresAt: new Date(inserted.rows[0].absolute_expires_at).toISOString(),
    };
  });
}

/** Mint a new fifteen-minute access bearer only when refresh + live station
 * signature + current RBAC/location/credential state all agree. */
export async function refreshScannerAccessSession(
  station: StationPrincipal,
  refreshTokenInput: unknown
): Promise<{ accessToken: string; accessExpiresAt: string; refreshExpiresAt: string }> {
  const refreshToken = scannerToken(refreshTokenInput);
  const accessToken = crypto.randomBytes(32).toString("base64url");
  return withPartnerAdminTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      tenant_id: string;
      location_id: string;
      user_id: string;
      station_id: string;
      credential_version: number;
      absolute_expires_at: string;
      revoked_at: string | null;
      user_status: string;
      user_credential_version: number;
      organisation_status: string;
      location_status: string;
      station_status: string;
    }>(
      `SELECT refresh.id,refresh.tenant_id,refresh.location_id,refresh.user_id,refresh.station_id,
              refresh.credential_version,refresh.absolute_expires_at,refresh.revoked_at,
              users.status AS user_status,users.credential_version AS user_credential_version,
              organisation.status AS organisation_status,location.status AS location_status,
              station.status AS station_status
         FROM partner_scanner_refresh_sessions refresh
         JOIN partner_users users ON users.id=refresh.user_id
         JOIN partner_organisations organisation ON organisation.id=refresh.tenant_id
         JOIN partner_locations location ON location.id=refresh.location_id
         JOIN partner_stations station ON station.id=refresh.station_id
        WHERE refresh.token_hash=$1
        FOR UPDATE OF refresh`,
      [sha256(refreshToken)]
    );
    const refresh = selected.rows[0];
    if (
      !refresh ||
      refresh.revoked_at ||
      refresh.station_id !== station.id ||
      refresh.tenant_id !== station.tenantId ||
      refresh.location_id !== station.locationId ||
      refresh.user_status !== "ACTIVE" ||
      refresh.organisation_status !== "ACTIVE" ||
      refresh.location_status !== "ACTIVE" ||
      refresh.station_status !== "ACTIVE" ||
      refresh.credential_version !== refresh.user_credential_version ||
      new Date(refresh.absolute_expires_at).getTime() <= Date.now()
    ) {
      throw new StationServiceError("forbidden", "Scanner refresh credential is expired, revoked or bound elsewhere");
    }
    const permissions = await getUserPermissions(client, refresh.user_id);
    const roles = await getUserRoles(client, refresh.user_id);
    if (!permissions.has("partner.cards.scan")) {
      throw new StationServiceError("forbidden", "Scanner operator permission is no longer active");
    }
    const orgWide = roles.some((role) => ORG_WIDE_ROLES.has(role));
    if (!orgWide) {
      const assigned = await client.query(
        "SELECT 1 FROM partner_user_locations WHERE user_id=$1 AND location_id=$2",
        [refresh.user_id, station.locationId]
      );
      if (assigned.rowCount !== 1) {
        throw new StationServiceError("forbidden", "Scanner operator is no longer assigned to this station location");
      }
    }
    await client.query(
      `UPDATE partner_sessions SET revoked_at=now()
        WHERE scanner_refresh_id=$1 AND revoked_at IS NULL`,
      [refresh.id]
    );
    const inserted = await client.query<{ absolute_expires_at: string }>(
      `INSERT INTO partner_sessions
         (tenant_id,user_id,location_id,token_hash,credential_version,mfa_passed,absolute_expires_at,
          session_kind,station_id,scanner_refresh_id)
       VALUES ($1,$2,$3,$4,$5,true,now() + ($6 || ' minutes')::interval,'SCANNER',$7,$8)
       RETURNING absolute_expires_at`,
      [
        station.tenantId,
        refresh.user_id,
        station.locationId,
        sha256(accessToken),
        refresh.user_credential_version,
        String(SCANNER_ACCESS_MINUTES),
        station.id,
        refresh.id,
      ]
    );
    await client.query("UPDATE partner_scanner_refresh_sessions SET last_used_at=now() WHERE id=$1", [refresh.id]);
    await writePartnerAudit(client, {
      tenantId: station.tenantId,
      locationId: station.locationId,
      actorUserId: refresh.user_id,
      deviceId: station.id,
      action: "scanner_access_session_refreshed",
      recordType: "partner_station",
      recordId: station.id,
    });
    return {
      accessToken,
      accessExpiresAt: new Date(inserted.rows[0].absolute_expires_at).toISOString(),
      refreshExpiresAt: new Date(refresh.absolute_expires_at).toISOString(),
    };
  });
}

/** SHIFT CHANGE revokes the complete station-bound family.  Unknown/already
 * revoked tokens are an idempotent success and disclose no user/session data. */
export async function revokeScannerSession(
  station: StationPrincipal,
  refreshTokenInput: unknown
): Promise<void> {
  const refreshToken = scannerToken(refreshTokenInput);
  await withPartnerAdminTransaction(async (client) => {
    const selected = await client.query<{ id: string; user_id: string }>(
      `SELECT id,user_id FROM partner_scanner_refresh_sessions
        WHERE token_hash=$1 AND station_id=$2 AND tenant_id=$3
        FOR UPDATE`,
      [sha256(refreshToken), station.id, station.tenantId]
    );
    const refresh = selected.rows[0];
    if (!refresh) return;
    await client.query(
      "UPDATE partner_sessions SET revoked_at=now() WHERE scanner_refresh_id=$1 AND revoked_at IS NULL",
      [refresh.id]
    );
    await client.query(
      "UPDATE partner_scanner_refresh_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1",
      [refresh.id]
    );
    await writePartnerAudit(client, {
      tenantId: station.tenantId,
      locationId: station.locationId,
      actorUserId: refresh.user_id,
      deviceId: station.id,
      action: "scanner_shift_change",
      recordType: "partner_station",
      recordId: station.id,
    });
  });
}
