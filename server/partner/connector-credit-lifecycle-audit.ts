/**
 * Durable evidence for a connector terminal transition that is blocked by a credit-linkage
 * invariant. The attempted transition's transaction rolls back by design; this separate, immutable
 * event is therefore the only safe way to preserve evidence without allowing the terminal state.
 */
import { withPartnerAdminTransaction } from "./db";
import { ConnectorError } from "./connector-errors";

export async function recordConnectorCreditLifecycleFailure(params: {
  connectorId: string;
  tenantId: string;
  expectedVersion: number;
  actorId?: string | null;
  actorType?: "system" | "operator";
}): Promise<void> {
  await withPartnerAdminTransaction(async (client) => {
    const record = await client.query<{
      id: string;
      state: string;
      attempt_count: number;
      partner_submission_id: string;
    }>(
      `SELECT id, state, attempt_count, partner_submission_id
         FROM partner_connector_records
        WHERE id=$1 AND tenant_id=$2 AND version=$3
        FOR KEY SHARE`,
      [params.connectorId, params.tenantId, params.expectedVersion]
    );
    if (record.rowCount !== 1) {
      throw new ConnectorError("stale_claim", "Connector record changed before credit failure could be audited.");
    }
    const row = record.rows[0];
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [params.tenantId]);
    await client.query(
      `INSERT INTO partner_credit_accounting_exceptions
         (tenant_id, partner_submission_id, connector_record_id, event_type, reason_code, idempotency_key, metadata)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'connector_terminal_blocked','credit_lifecycle_invariant',$4,$5::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        params.tenantId,
        row.partner_submission_id,
        row.id,
        `g6d-connector-terminal-blocked:${row.id}:${params.expectedVersion}`,
        JSON.stringify({
          code: "credit_lifecycle_invariant",
          action: "terminal_transition_blocked",
          connector_state: row.state,
          attempt_number: row.attempt_count,
          actor_type: params.actorType ?? "system",
          actor_id: params.actorId ?? null,
        }),
      ]
    );
  });
}
