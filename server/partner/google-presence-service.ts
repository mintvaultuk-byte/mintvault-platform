import crypto from "node:crypto";
import type { PoolClient } from "pg";
import type { PartnerPrincipal } from "./session";
import { partnerAdminQuery, partnerRuntimeQuery, withTenant } from "./db";
import { resolveGlobalFlag } from "./flags";
import { writePartnerAudit, writePartnerSecurity } from "./audit";
import {
  createGoogleOAuthProof,
  decryptGoogleSecret,
  encryptGoogleSecret,
  googleBusinessConfigReadiness,
  googleOAuthAuthorizationUrl,
  hashGoogleOAuthState,
  oauthVerifierAad,
  refreshTokenAad,
  type GoogleBusinessConfig,
} from "./google-presence-crypto";
import {
  exchangeGoogleAuthorizationCode,
  getGoogleBusinessLocation,
  GoogleBusinessProviderError,
  listGoogleBusinessCandidates,
  refreshGoogleAccessToken,
  revokeGoogleRefreshToken,
  type GoogleBusinessCandidate,
} from "./google-business-client";
import { preferredGoogleMapsUrl } from "./public-presence-service";
import { isHardStopped, readEmergencyState } from "./emergency";

const GOOGLE_FLAG = "google_partner_presence_enabled";
const OAUTH_TTL_MINUTES = 10;
const CANDIDATE_TTL_MINUTES = 30;
let schemaReady = false;

export type GooglePresenceUnavailableReason = "feature_disabled" | "not_configured" | "schema_unavailable";

export type GooglePresenceCapability =
  | { available: true; config: GoogleBusinessConfig }
  | { available: false; reason: GooglePresenceUnavailableReason };

export class GooglePresenceError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "invalid_request"
      | "location_unavailable"
      | "already_connected"
      | "oauth_invalid"
      | "oauth_replayed"
      | "candidate_expired"
      | "listing_already_connected"
      | "operation_frozen"
      | "provider_unavailable",
    public readonly status: number
  ) {
    super(code);
  }
}

async function googleSchemaAvailable(): Promise<boolean> {
  if (schemaReady) return true;
  try {
    const { rows } = await partnerRuntimeQuery<{ ready: boolean }>(
      `SELECT to_regclass('public.partner_google_oauth_states') IS NOT NULL
           AND to_regclass('public.partner_google_connections') IS NOT NULL
           AND to_regclass('public.partner_google_credentials') IS NOT NULL
           AND to_regclass('public.partner_google_location_candidates') IS NOT NULL
           AND to_regclass('public.partner_google_profile_cache') IS NOT NULL AS ready`
    );
    schemaReady = rows[0]?.ready === true;
    return schemaReady;
  } catch {
    return false;
  }
}

/** Route-local positive gate. Never called from portal mount/readiness. */
export async function getGooglePresenceCapability(): Promise<GooglePresenceCapability> {
  if (!(await resolveGlobalFlag(GOOGLE_FLAG))) return { available: false, reason: "feature_disabled" };
  const readiness = googleBusinessConfigReadiness();
  if (!readiness.ready) return { available: false, reason: readiness.reason };
  if (!(await googleSchemaAvailable())) return { available: false, reason: "schema_unavailable" };
  return { available: true, config: readiness.config };
}

export function resetGooglePresenceSchemaCacheForTests(): void {
  schemaReady = false;
}

async function assertOwner(client: PoolClient, principal: PartnerPrincipal): Promise<void> {
  const owner = await client.query(
    `SELECT 1
       FROM partner_user_roles ur
       JOIN partner_roles r ON r.id=ur.role_id
      WHERE ur.user_id=$1 AND ur.tenant_id=$2 AND r.code='PARTNER_OWNER'
      LIMIT 1`,
    [principal.userId, principal.tenantId]
  );
  if (owner.rowCount !== 1) throw new GooglePresenceError("forbidden", 403);
}

async function assertActiveLocation(client: PoolClient, principal: PartnerPrincipal, locationId: string): Promise<void> {
  const location = await client.query(
    `SELECT 1 FROM partner_locations
      WHERE id=$1 AND tenant_id=$2 AND partner_id=$2 AND status='ACTIVE'`,
    [locationId, principal.tenantId]
  );
  if (location.rowCount !== 1) throw new GooglePresenceError("location_unavailable", 404);
}

async function assertMutableGoogleTarget(
  client: PoolClient,
  principal: PartnerPrincipal,
  locationId: string
): Promise<void> {
  const emergency = await readEmergencyState(client, { tenantId: principal.tenantId, locationId });
  if (isHardStopped(emergency) || emergency.viewOnly || emergency.sensitiveDisabled) {
    throw new GooglePresenceError("operation_frozen", 423);
  }
}

function verifierBinding(principal: PartnerPrincipal, locationId: string) {
  return { tenantId: principal.tenantId, locationId, userId: principal.userId, sessionId: principal.sessionId };
}

function credentialBinding(tenantId: string, locationId: string, connectionId: string) {
  return { tenantId, locationId, connectionId };
}

export async function beginGoogleBusinessConnection(
  principal: PartnerPrincipal,
  locationId: string,
  config: GoogleBusinessConfig
): Promise<{ authorizationUrl: string; expiresInMinutes: number }> {
  const proof = createGoogleOAuthProof();
  const encryptedVerifier = encryptGoogleSecret(proof.verifier, config, oauthVerifierAad(verifierBinding(principal, locationId)));
  await withTenant({ tenantId: principal.tenantId, locationId }, async (client) => {
    await assertOwner(client, principal);
    await assertActiveLocation(client, principal, locationId);
    await assertMutableGoogleTarget(client, principal, locationId);
    const existing = await client.query(
      `SELECT 1 FROM partner_google_connections
        WHERE location_id=$1 AND connection_status='CONNECTED'
        LIMIT 1`,
      [locationId]
    );
    if (existing.rowCount) throw new GooglePresenceError("already_connected", 409);
    await client.query(
      `DELETE FROM partner_google_oauth_states
        WHERE actor_user_id=$1 AND (expires_at <= now() OR consumed_at IS NOT NULL)`,
      [principal.userId]
    );
    await client.query(
      `INSERT INTO partner_google_oauth_states
         (tenant_id,location_id,actor_user_id,session_id,state_hash,code_verifier_ciphertext,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,now() + ($7 || ' minutes')::interval)`,
      [principal.tenantId, locationId, principal.userId, principal.sessionId, proof.stateHash, encryptedVerifier, String(OAUTH_TTL_MINUTES)]
    );
    await writePartnerAudit(client, {
      tenantId: principal.tenantId,
      locationId,
      actorUserId: principal.userId,
      sessionId: principal.sessionId,
      action: "partner_google_oauth_started",
      recordType: "partner_google_connection",
      reason: "Partner Owner initiated Google Business connection",
    });
  });
  return {
    authorizationUrl: googleOAuthAuthorizationUrl(config, proof),
    expiresInMinutes: OAUTH_TTL_MINUTES,
  };
}

interface ConsumedState {
  id: string;
  location_id: string;
  code_verifier_ciphertext: string;
}

export async function completeGoogleBusinessOAuth(input: {
  principal: PartnerPrincipal;
  state: string;
  code: string;
  config: GoogleBusinessConfig;
  /** Test seam for deterministic provider contract proof; production omits it. */
  fetchImpl?: typeof fetch;
}): Promise<{ locationId: string; candidateCount: number }> {
  if (input.principal.viewOnly || input.principal.sensitiveDisabled) {
    throw new GooglePresenceError("forbidden", 403);
  }
  if (!input.state || input.state.length > 512 || !input.code || input.code.length > 4096) {
    throw new GooglePresenceError("oauth_invalid", 400);
  }
  const stateHash = hashGoogleOAuthState(input.state);
  const consumed = await withTenant({ tenantId: input.principal.tenantId }, async (client) => {
    await assertOwner(client, input.principal);
    const result = await client.query<ConsumedState>(
      `SELECT id,location_id,code_verifier_ciphertext
         FROM partner_google_oauth_states
        WHERE tenant_id=$1 AND actor_user_id=$2 AND session_id=$3 AND state_hash=$4
          AND consumed_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [input.principal.tenantId, input.principal.userId, input.principal.sessionId, stateHash]
    );
    if (result.rowCount !== 1) throw new GooglePresenceError("oauth_replayed", 400);
    await assertActiveLocation(client, input.principal, result.rows[0].location_id);
    await assertMutableGoogleTarget(client, input.principal, result.rows[0].location_id);
    await client.query("UPDATE partner_google_oauth_states SET consumed_at=now() WHERE id=$1", [result.rows[0].id]);
    return result.rows[0];
  });

  let verifier: string;
  try {
    verifier = decryptGoogleSecret(
      consumed.code_verifier_ciphertext,
      input.config,
      oauthVerifierAad(verifierBinding(input.principal, consumed.location_id))
    );
  } catch {
    throw new GooglePresenceError("oauth_invalid", 400);
  }

  let tokenSet;
  let candidates: GoogleBusinessCandidate[];
  try {
    tokenSet = await exchangeGoogleAuthorizationCode({
      config: input.config, code: input.code, verifier, fetchImpl: input.fetchImpl,
    });
    candidates = await listGoogleBusinessCandidates({ accessToken: tokenSet.accessToken, fetchImpl: input.fetchImpl });
  } catch (err) {
    throw new GooglePresenceError(
      err instanceof GoogleBusinessProviderError && err.code === "oauth_rejected" ? "oauth_invalid" : "provider_unavailable",
      err instanceof GoogleBusinessProviderError && err.code === "oauth_rejected" ? 400 : 503
    );
  }
  if (!tokenSet.refreshToken || candidates.length === 0) {
    if (tokenSet.refreshToken) void revokeGoogleRefreshToken(tokenSet.refreshToken);
    throw new GooglePresenceError(candidates.length === 0 ? "location_unavailable" : "oauth_invalid", 400);
  }

  try {
    await withTenant({ tenantId: input.principal.tenantId, locationId: consumed.location_id }, async (client) => {
      await assertOwner(client, input.principal);
      await assertActiveLocation(client, input.principal, consumed.location_id);
      await assertMutableGoogleTarget(client, input.principal, consumed.location_id);
      await client.query(
        `DELETE FROM partner_google_connections
          WHERE location_id=$1 AND connection_status='PENDING_SELECTION'`,
        [consumed.location_id]
      );
      // Supersede a broken/revoked connection only after Google has issued and
      // returned a usable new credential. Any failure rolls this transaction
      // back, preserving the prior state for diagnosis/disconnect.
      const superseded = await client.query<{ id: string }>(
        `SELECT id FROM partner_google_connections
          WHERE location_id=$1 AND connection_status IN ('ACTION_REQUIRED','REVOKED','ERROR')
          FOR UPDATE`,
        [consumed.location_id]
      );
      if (superseded.rows.length) {
        const ids = superseded.rows.map((row) => row.id);
        await client.query("DELETE FROM partner_google_credentials WHERE connection_id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM partner_google_profile_cache WHERE connection_id=ANY($1::uuid[])", [ids]);
        await client.query("DELETE FROM partner_google_location_candidates WHERE connection_id=ANY($1::uuid[])", [ids]);
        await client.query(
          `UPDATE partner_google_connections SET connection_status='DISCONNECTED',disconnected_at=now(),updated_at=now()
            WHERE id=ANY($1::uuid[])`,
          [ids]
        );
      }
      const connection = await client.query<{ id: string }>(
        `INSERT INTO partner_google_connections (tenant_id,location_id,connection_status,connected_by)
         VALUES ($1,$2,'PENDING_SELECTION',$3) RETURNING id`,
        [input.principal.tenantId, consumed.location_id, input.principal.userId]
      );
      const connectionId = connection.rows[0].id;
      const encryptedRefreshToken = encryptGoogleSecret(
        tokenSet.refreshToken!,
        input.config,
        refreshTokenAad(credentialBinding(input.principal.tenantId, consumed.location_id, connectionId))
      );
      await client.query(
        `INSERT INTO partner_google_credentials
           (tenant_id,location_id,connection_id,refresh_token_ciphertext,key_version)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.principal.tenantId, consumed.location_id, connectionId, encryptedRefreshToken, input.config.keyVersion]
      );
      for (const candidate of candidates) {
        await client.query(
          `INSERT INTO partner_google_location_candidates
             (tenant_id,location_id,connection_id,candidate_handle,google_account_name,google_location_name,
              google_place_id,google_maps_uri,business_name,business_address,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now() + ($11 || ' minutes')::interval)`,
          [
            input.principal.tenantId,
            consumed.location_id,
            connectionId,
            crypto.randomBytes(24).toString("base64url"),
            candidate.accountName,
            candidate.locationName,
            candidate.placeId,
            candidate.mapsUri,
            candidate.businessName,
            candidate.businessAddress,
            String(CANDIDATE_TTL_MINUTES),
          ]
        );
      }
      await writePartnerAudit(client, {
        tenantId: input.principal.tenantId,
        locationId: consumed.location_id,
        actorUserId: input.principal.userId,
        sessionId: input.principal.sessionId,
        action: "partner_google_oauth_completed",
        recordType: "partner_google_connection",
        recordId: connectionId,
        after: { candidateCount: candidates.length },
      });
    });
  } catch (err) {
    void revokeGoogleRefreshToken(tokenSet.refreshToken);
    throw err;
  }
  return { locationId: consumed.location_id, candidateCount: candidates.length };
}

export interface GooglePresenceLocationView {
  locationId: string;
  locationName: string;
  connectionId: string | null;
  state: "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "ACTION_REQUIRED" | "REVOKED" | "ERROR";
  businessName: string | null;
  businessAddress: string | null;
  placeId: string | null;
  mapsUrl: string | null;
  lastSyncAt: string | null;
  candidates: Array<{ handle: string; businessName: string; businessAddress: string | null }>;
}

export async function getGooglePresenceStatus(
  principal: PartnerPrincipal
): Promise<{ owner: boolean; locations: GooglePresenceLocationView[] }> {
  return withTenant({ tenantId: principal.tenantId }, async (client) => {
    const ownerResult = await client.query(
      `SELECT 1 FROM partner_user_roles ur JOIN partner_roles r ON r.id=ur.role_id
        WHERE ur.user_id=$1 AND ur.tenant_id=$2 AND r.code='PARTNER_OWNER' LIMIT 1`,
      [principal.userId, principal.tenantId]
    );
    const accessPredicate = principal.orgWide
      ? "TRUE"
      : "EXISTS (SELECT 1 FROM partner_user_locations ul WHERE ul.location_id=l.id AND ul.user_id=$1)";
    const params = principal.orgWide ? [] : [principal.userId];
    const result = await client.query(
      `SELECT l.id AS location_id, l.name AS location_name,
              c.id AS connection_id, c.connection_status, c.business_name, c.business_address,
              c.google_place_id, c.google_maps_uri, c.last_sync_at
         FROM partner_locations l
         LEFT JOIN LATERAL (
           SELECT * FROM partner_google_connections c
            WHERE c.location_id=l.id AND c.connection_status <> 'DISCONNECTED'
            ORDER BY c.updated_at DESC, c.created_at DESC LIMIT 1
         ) c ON TRUE
        WHERE l.status='ACTIVE' AND ${accessPredicate}
        ORDER BY l.name`,
      params
    );
    const connectionIds = result.rows.map((row: any) => row.connection_id).filter(Boolean);
    const owner = ownerResult.rowCount === 1;
    const candidateResult = owner && connectionIds.length
      ? await client.query(
          `SELECT connection_id,candidate_handle,business_name,business_address
             FROM partner_google_location_candidates
            WHERE connection_id=ANY($1::uuid[]) AND expires_at > now()
            ORDER BY business_name,candidate_handle`,
          [connectionIds]
        )
      : { rows: [] as any[] };
    return {
      owner,
      locations: result.rows.map((row: any) => {
        const candidates = candidateResult.rows
          .filter((candidate: any) => candidate.connection_id === row.connection_id)
          .map((candidate: any) => ({
            handle: candidate.candidate_handle,
            businessName: candidate.business_name,
            businessAddress: candidate.business_address ?? null,
          }));
        return {
          locationId: row.location_id,
          locationName: row.location_name,
          connectionId: row.connection_id ?? null,
          // An expired selection must not strand the owner in a CONNECTING state
          // with no actionable listing. Starting again atomically replaces it.
          state: row.connection_status === "PENDING_SELECTION"
            ? (owner ? (candidates.length ? "CONNECTING" : "NOT_CONNECTED") : "CONNECTING")
            : row.connection_status ?? "NOT_CONNECTED",
          businessName: row.business_name ?? null,
          businessAddress: row.business_address ?? null,
          placeId: row.google_place_id ?? null,
          mapsUrl: preferredGoogleMapsUrl({
            mapsUri: row.google_maps_uri,
            placeId: row.google_place_id,
            address: row.business_address,
            businessName: row.business_name,
          }),
          lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
          candidates,
        };
      }),
    };
  });
}

export async function confirmGoogleBusinessCandidate(input: {
  principal: PartnerPrincipal;
  locationId: string;
  candidateHandle: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(input.candidateHandle)) throw new GooglePresenceError("invalid_request", 400);
  try {
    await withTenant({ tenantId: input.principal.tenantId, locationId: input.locationId }, async (client) => {
      await assertOwner(client, input.principal);
      await assertActiveLocation(client, input.principal, input.locationId);
      await assertMutableGoogleTarget(client, input.principal, input.locationId);
      const candidate = await client.query(
        `SELECT c.* FROM partner_google_location_candidates c
          JOIN partner_google_connections g ON g.id=c.connection_id
         WHERE c.candidate_handle=$1 AND c.location_id=$2 AND c.tenant_id=$3
           AND c.expires_at > now() AND g.connection_status='PENDING_SELECTION'
         FOR UPDATE OF c,g`,
        [input.candidateHandle, input.locationId, input.principal.tenantId]
      );
      if (candidate.rowCount !== 1) throw new GooglePresenceError("candidate_expired", 404);
      const row = candidate.rows[0];
      await client.query(
        `UPDATE partner_google_connections
            SET google_account_name=$2,google_location_name=$3,google_place_id=$4,google_maps_uri=$5,
                business_name=$6,business_address=$7,connection_status='CONNECTED',connected_at=now(),
                disconnected_at=NULL,last_sync_at=now(),last_error_code=NULL,updated_at=now()
          WHERE id=$1`,
        [row.connection_id,row.google_account_name,row.google_location_name,row.google_place_id,row.google_maps_uri,row.business_name,row.business_address]
      );
      await client.query(
        `INSERT INTO partner_google_profile_cache
           (tenant_id,location_id,connection_id,business_name,business_address,google_place_id,google_maps_uri,cached_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now()+interval '24 hours')
         ON CONFLICT (connection_id) DO UPDATE SET business_name=EXCLUDED.business_name,
           business_address=EXCLUDED.business_address,google_place_id=EXCLUDED.google_place_id,
           google_maps_uri=EXCLUDED.google_maps_uri,cached_at=now(),expires_at=EXCLUDED.expires_at`,
        [input.principal.tenantId,input.locationId,row.connection_id,row.business_name,row.business_address,row.google_place_id,row.google_maps_uri]
      );
      await client.query("DELETE FROM partner_google_location_candidates WHERE connection_id=$1", [row.connection_id]);
      await writePartnerAudit(client, {
        tenantId: input.principal.tenantId,
        locationId: input.locationId,
        actorUserId: input.principal.userId,
        sessionId: input.principal.sessionId,
        action: "partner_google_location_connected",
        recordType: "partner_google_connection",
        recordId: row.connection_id,
        after: { businessName: row.business_name, placeIdPresent: !!row.google_place_id },
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new GooglePresenceError("listing_already_connected", 409);
    throw err;
  }
}

interface CredentialRow {
  connection_id: string;
  location_id: string;
  refresh_token_ciphertext: string;
  google_location_name: string;
}

async function readCredential(principal: PartnerPrincipal, locationId: string): Promise<CredentialRow> {
  return withTenant({ tenantId: principal.tenantId, locationId }, async (client) => {
    await assertOwner(client, principal);
    await assertActiveLocation(client, principal, locationId);
    await assertMutableGoogleTarget(client, principal, locationId);
    const result = await client.query<CredentialRow>(
      `SELECT c.id AS connection_id,c.location_id,k.refresh_token_ciphertext,c.google_location_name
         FROM partner_google_connections c
         JOIN partner_google_credentials k ON k.connection_id=c.id
        WHERE c.location_id=$1 AND c.connection_status IN ('CONNECTED','ACTION_REQUIRED','REVOKED','ERROR')
        ORDER BY c.updated_at DESC LIMIT 1`,
      [locationId]
    );
    if (result.rowCount !== 1) throw new GooglePresenceError("location_unavailable", 404);
    return result.rows[0];
  });
}

export async function refreshGoogleBusinessConnection(
  principal: PartnerPrincipal,
  locationId: string,
  config: GoogleBusinessConfig
): Promise<void> {
  const credential = await readCredential(principal, locationId);
  let refreshToken: string;
  try {
    refreshToken = decryptGoogleSecret(
      credential.refresh_token_ciphertext,
      config,
      refreshTokenAad(credentialBinding(principal.tenantId, locationId, credential.connection_id))
    );
  } catch {
    throw new GooglePresenceError("provider_unavailable", 503);
  }
  try {
    const token = await refreshGoogleAccessToken({ config, refreshToken });
    const candidate = await getGoogleBusinessLocation({ accessToken: token.accessToken, locationName: credential.google_location_name });
    await withTenant({ tenantId: principal.tenantId, locationId }, async (client) => {
      await assertOwner(client, principal);
      await assertActiveLocation(client, principal, locationId);
      await assertMutableGoogleTarget(client, principal, locationId);
      await client.query(
        `UPDATE partner_google_connections SET business_name=$2,business_address=$3,google_place_id=$4,
           google_maps_uri=$5,connection_status='CONNECTED',last_sync_at=now(),last_error_code=NULL,updated_at=now()
         WHERE id=$1`,
        [credential.connection_id,candidate.businessName,candidate.businessAddress,candidate.placeId,candidate.mapsUri]
      );
      await client.query(
        `INSERT INTO partner_google_profile_cache
           (tenant_id,location_id,connection_id,business_name,business_address,google_place_id,google_maps_uri,cached_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now()+interval '24 hours')
         ON CONFLICT (connection_id) DO UPDATE SET business_name=EXCLUDED.business_name,
           business_address=EXCLUDED.business_address,google_place_id=EXCLUDED.google_place_id,
           google_maps_uri=EXCLUDED.google_maps_uri,cached_at=now(),expires_at=EXCLUDED.expires_at`,
        [principal.tenantId,locationId,credential.connection_id,candidate.businessName,candidate.businessAddress,candidate.placeId,candidate.mapsUri]
      );
      await writePartnerAudit(client, {
        tenantId: principal.tenantId, locationId, actorUserId: principal.userId, sessionId: principal.sessionId,
        action: "partner_google_location_refreshed", recordType: "partner_google_connection", recordId: credential.connection_id,
      });
    });
  } catch (err) {
    const authRejected = err instanceof GoogleBusinessProviderError && err.code === "oauth_rejected";
    await withTenant({ tenantId: principal.tenantId, locationId }, async (client) => {
      await assertOwner(client, principal);
      await assertActiveLocation(client, principal, locationId);
      await assertMutableGoogleTarget(client, principal, locationId);
      await client.query(
        `UPDATE partner_google_connections SET connection_status=$2,last_error_code=$3,updated_at=now() WHERE id=$1`,
        [credential.connection_id, authRejected ? "ACTION_REQUIRED" : "ERROR", authRejected ? "oauth_rejected" : "provider_unavailable"]
      );
      await writePartnerSecurity(client, {
        tenantId: principal.tenantId, severity: authRejected ? "high" : "medium",
        kind: authRejected ? "partner_google_authorization_required" : "partner_google_sync_failed",
        detail: { connectionId: credential.connection_id, locationId },
      });
    });
    throw new GooglePresenceError(authRejected ? "oauth_invalid" : "provider_unavailable", authRejected ? 409 : 503);
  }
}

export async function disconnectGoogleBusinessConnection(
  principal: PartnerPrincipal,
  locationId: string,
  config: GoogleBusinessConfig
): Promise<void> {
  const credential = await readCredential(principal, locationId);
  let refreshToken: string | null = null;
  try {
    refreshToken = decryptGoogleSecret(
      credential.refresh_token_ciphertext,
      config,
      refreshTokenAad(credentialBinding(principal.tenantId, locationId, credential.connection_id))
    );
  } catch {
    // Local deletion remains authoritative even if an old key cannot decrypt.
  }
  await withTenant({ tenantId: principal.tenantId, locationId }, async (client) => {
    await assertOwner(client, principal);
    await assertActiveLocation(client, principal, locationId);
    await assertMutableGoogleTarget(client, principal, locationId);
    await client.query("DELETE FROM partner_google_credentials WHERE connection_id=$1", [credential.connection_id]);
    await client.query("DELETE FROM partner_google_profile_cache WHERE connection_id=$1", [credential.connection_id]);
    await client.query("DELETE FROM partner_google_location_candidates WHERE connection_id=$1", [credential.connection_id]);
    await client.query(
      `UPDATE partner_google_connections SET connection_status='DISCONNECTED',disconnected_at=now(),
         last_error_code=NULL,updated_at=now() WHERE id=$1`,
      [credential.connection_id]
    );
    await writePartnerAudit(client, {
      tenantId: principal.tenantId, locationId, actorUserId: principal.userId, sessionId: principal.sessionId,
      action: "partner_google_location_disconnected", recordType: "partner_google_connection", recordId: credential.connection_id,
    });
  });
  if (refreshToken) await revokeGoogleRefreshToken(refreshToken);
}

/** Super Admin projection: connection state only. Credentials, provider account
 * resource names, OAuth state, candidate handles and errors are never returned. */
export async function getAdminGooglePresence(partnerId: string): Promise<{
  available: boolean;
  locations: Array<{
    locationId: string;
    state: string;
    businessName: string | null;
    businessAddress: string | null;
    placeId: string | null;
    mapsUrl: string | null;
    lastSyncAt: string | null;
  }>;
}> {
  const ready = await partnerAdminQuery<{ ready: boolean }>(
    "SELECT to_regclass('public.partner_google_connections') IS NOT NULL AS ready"
  );
  if (ready.rows[0]?.ready !== true) return { available: false, locations: [] };
  const { rows } = await partnerAdminQuery(
    `SELECT l.id AS location_id,c.connection_status,c.business_name,c.business_address,
            c.google_place_id,c.google_maps_uri,c.last_sync_at
       FROM partner_locations l
       LEFT JOIN LATERAL (
         SELECT * FROM partner_google_connections c
          WHERE c.location_id=l.id AND c.tenant_id=l.tenant_id AND c.connection_status <> 'DISCONNECTED'
          ORDER BY c.updated_at DESC,c.created_at DESC LIMIT 1
       ) c ON TRUE
      WHERE l.tenant_id=$1
      ORDER BY l.name`,
    [partnerId]
  );
  return {
    available: true,
    locations: rows.map((row: any) => ({
      locationId: row.location_id,
      state: row.connection_status === "PENDING_SELECTION" ? "CONNECTING" : row.connection_status ?? "NOT_CONNECTED",
      businessName: row.business_name ?? null,
      businessAddress: row.business_address ?? null,
      placeId: row.google_place_id ?? null,
      mapsUrl: preferredGoogleMapsUrl({
        mapsUri: row.google_maps_uri,
        placeId: row.google_place_id,
        address: row.business_address,
        businessName: row.business_name,
      }),
      lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    })),
  };
}
