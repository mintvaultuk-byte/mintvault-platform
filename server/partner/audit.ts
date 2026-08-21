/**
 * Partner Portal — audit + security event writers (append-only).
 *
 * The partner_runtime role has INSERT+SELECT (no UPDATE/DELETE) on these tables, so events cannot
 * be tampered with by the runtime. Writers NEVER persist secrets, password hashes, MFA secrets, or
 * raw session tokens — payloads are shaped by the caller and passed through a redactor as defence.
 */
import type { PoolClient } from "pg";
import { withTenant } from "./db";
import { redactSensitive } from "../lib/auth-security";

/** Strip any secret-shaped keys from a details object before it is stored/logged. */
export function redactDetails(obj: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!obj) return {};
  return redactSensitive(obj) as Record<string, unknown>;
}

export interface AuditInput {
  tenantId: string;
  locationId?: string | null;
  actorUserId?: string | null;
  deviceId?: string | null;
  action: string;
  recordType?: string | null;
  recordId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  sessionId?: string | null;
  reason?: string | null;
  correlationId?: string | null;
}

/** Write an audit event within an existing tenant transaction. */
export async function writePartnerAudit(client: PoolClient, e: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO partner_audit_events
       (tenant_id, location_id, actor_user_id, device_id, action, record_type, record_id,
        before_value, after_value, ip, session_id, reason, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      e.tenantId, e.locationId ?? null, e.actorUserId ?? null, e.deviceId ?? null, e.action,
      e.recordType ?? null, e.recordId ?? null,
      e.before ? redactDetails(e.before) : null, e.after ? redactDetails(e.after) : null,
      e.ip ?? null, e.sessionId ?? null, e.reason ?? null, e.correlationId ?? null,
    ],
  );
}

/** Convenience: open a tenant transaction just to write one audit event. */
export async function auditInOwnTxn(e: AuditInput): Promise<void> {
  await withTenant({ tenantId: e.tenantId, locationId: e.locationId ?? null }, (c) => writePartnerAudit(c, e));
}

export interface SecurityInput {
  tenantId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  kind: string;
  detail?: Record<string, unknown> | null;
}

export async function writePartnerSecurity(client: PoolClient, e: SecurityInput): Promise<void> {
  await client.query(
    `INSERT INTO partner_security_events (tenant_id, severity, kind, detail) VALUES ($1,$2,$3,$4)`,
    [e.tenantId, e.severity, e.kind, e.detail ? redactDetails(e.detail) : null],
  );
}
