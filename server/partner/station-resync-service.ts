import crypto from "node:crypto";
import type { PartnerPrincipal } from "./session";
import { withPartnerAdminTransaction } from "./db";
import { STATION_CODE_RE, verifyStationResyncSignature } from "./station-identity";
import { StationServiceError } from "./station-service";

function stationCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!STATION_CODE_RE.test(code)) throw new StationServiceError("validation", "stationCode is invalid");
  return code;
}

export async function issueStationResyncChallenge(
  principal: PartnerPrincipal,
  stationCodeInput: unknown
): Promise<{ stationCode: string; challengeId: string; challenge: string; expiresAt: string }> {
  const code = stationCode(stationCodeInput);
  return withPartnerAdminTransaction(async (client) => {
    const station = await client.query<{ id: string; location_id: string }>(
      `SELECT id,location_id FROM partner_stations
        WHERE station_code=$1 AND tenant_id=$2 AND status='ACTIVE'
          AND ($3::boolean OR location_id=$4::uuid)`,
      [code, principal.tenantId, principal.orgWide, principal.locationId]
    );
    if (!station.rows[0]) throw new StationServiceError("forbidden", "Station is not available for replay recovery");
    await client.query(
      `UPDATE partner_station_resync_challenges SET consumed_at=now()
        WHERE station_id=$1 AND consumed_at IS NULL AND expires_at<=now()`,
      [station.rows[0].id]
    );
    const existing = await client.query<{ id: string; challenge: string; expires_at: string; actor_user_id: string }>(
      `SELECT id,challenge,expires_at,actor_user_id FROM partner_station_resync_challenges
        WHERE station_id=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`,
      [station.rows[0].id]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].actor_user_id !== principal.userId) {
        throw new StationServiceError("forbidden", "Replay recovery is already controlled by another operator");
      }
      return {
        stationCode: code,
        challengeId: existing.rows[0].id,
        challenge: existing.rows[0].challenge,
        expiresAt: new Date(existing.rows[0].expires_at).toISOString(),
      };
    }
    const id = crypto.randomUUID();
    const challenge = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await client.query(
      `INSERT INTO partner_station_resync_challenges
         (id,station_id,tenant_id,location_id,actor_user_id,challenge,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, station.rows[0].id, principal.tenantId, station.rows[0].location_id, principal.userId, challenge, expiresAt]
    );
    return { stationCode: code, challengeId: id, challenge, expiresAt: expiresAt.toISOString() };
  });
}

export async function completeStationResync(
  principal: PartnerPrincipal,
  input: { stationCode: unknown; challengeId: unknown; signature: unknown }
): Promise<{ stationCode: string; credentialEpoch: number; requestEpoch: number; requestSequence: 0 }> {
  const code = stationCode(input.stationCode);
  const challengeId = typeof input.challengeId === "string" ? input.challengeId.toLowerCase() : "";
  const signature = typeof input.signature === "string" ? input.signature : "";
  if (!/^[0-9a-f-]{36}$/.test(challengeId) || !/^[A-Za-z0-9_-]{64,256}$/.test(signature)) {
    throw new StationServiceError("validation", "Replay recovery proof is invalid");
  }
  return withPartnerAdminTransaction(async (client) => {
    const station = await client.query<{
      id: string;
      location_id: string;
      public_key_pem: string;
      credential_epoch: number;
      request_epoch: number;
    }>(
      `SELECT id,location_id,public_key_pem,credential_epoch,request_epoch
         FROM partner_stations
        WHERE station_code=$1 AND tenant_id=$2 AND status='ACTIVE'
          AND ($3::boolean OR location_id=$4::uuid)
        FOR UPDATE`,
      [code, principal.tenantId, principal.orgWide, principal.locationId]
    );
    const current = station.rows[0];
    if (!current) throw new StationServiceError("forbidden", "Station is not available for replay recovery");
    const challenge = await client.query<{ challenge: string }>(
      `SELECT challenge FROM partner_station_resync_challenges
        WHERE id=$1 AND station_id=$2 AND actor_user_id=$3
          AND consumed_at IS NULL AND expires_at>now()
        FOR UPDATE`,
      [challengeId, current.id, principal.userId]
    );
    const proof = challenge.rows[0];
    if (!proof || !verifyStationResyncSignature(current.public_key_pem, {
      stationCode: code,
      challengeId,
      challenge: proof.challenge,
    }, signature)) {
      throw new StationServiceError("forbidden", "Replay recovery signature is invalid or expired");
    }
    const updated = await client.query<{ credential_epoch: number; request_epoch: number }>(
      `UPDATE partner_stations
          SET request_epoch=request_epoch+1,last_request_sequence=0,updated_at=now()
        WHERE id=$1
        RETURNING credential_epoch,request_epoch`,
      [current.id]
    );
    await client.query(`UPDATE partner_station_resync_challenges SET consumed_at=now() WHERE id=$1`, [challengeId]);
    await client.query(
      `INSERT INTO partner_station_events (tenant_id,location_id,station_id,actor_user_id,event_type,detail)
       VALUES ($1,$2,$3,$4,'station_replay_resynchronised',$5::jsonb)`,
      [
        principal.tenantId,
        current.location_id,
        current.id,
        principal.userId,
        JSON.stringify({ challengeId, requestEpoch: updated.rows[0].request_epoch }),
      ]
    );
    return {
      stationCode: code,
      credentialEpoch: Number(updated.rows[0].credential_epoch),
      requestEpoch: Number(updated.rows[0].request_epoch),
      requestSequence: 0,
    };
  });
}
