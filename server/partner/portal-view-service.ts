import type { PartnerPrincipal } from "./session";
import { withTenant } from "./db";

function wholeCredit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error("Partner credit projection returned an invalid whole-credit value.");
  return parsed;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface PartnerPortalContext {
  organisationName: string;
  tradingName: string | null;
  displayName: string;
  role: string;
  locationName: string | null;
}

export async function getPartnerPortalContext(principal: PartnerPrincipal): Promise<PartnerPortalContext> {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT o.legal_name,
              to_jsonb(u)->>'first_name' AS first_name,
              to_jsonb(u)->>'last_name' AS last_name,
              u.email,
              l.name AS location_name,
              COALESCE((
                SELECT r.label
                  FROM partner_user_roles ur
                  JOIN partner_roles r ON r.id=ur.role_id
                 WHERE ur.user_id=u.id AND ur.tenant_id=o.id
                 ORDER BY CASE r.code
                   WHEN 'PARTNER_OWNER' THEN 1 WHEN 'PARTNER_MANAGER' THEN 2
                   WHEN 'PARTNER_FINANCE_VIEWER' THEN 3 ELSE 4 END, r.code
                 LIMIT 1
              ), 'Partner user') AS role_label
         FROM partner_organisations o
         JOIN partner_users u ON u.id=$1 AND u.tenant_id=o.id
         LEFT JOIN partner_locations l ON l.id=$2 AND l.tenant_id=o.id
        WHERE o.id=$3`,
      [principal.userId, principal.locationId, principal.tenantId]
    );
    if (result.rowCount !== 1) throw new Error("Partner portal context is unavailable.");
    const row = result.rows[0];
    const profileSchema = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.partner_profiles')::text AS relation"
    );
    const profile = profileSchema.rows[0]?.relation
      ? await client.query<{ trading_name: string | null }>(
          "SELECT trading_name FROM partner_profiles WHERE tenant_id=$1",
          [principal.tenantId]
        )
      : null;
    const fullName = [row.first_name, row.last_name].filter((value) => typeof value === "string" && value).join(" ");
    return {
      organisationName: String(row.legal_name),
      tradingName: profile?.rows[0]?.trading_name || null,
      displayName: fullName || String(row.email),
      role: String(row.role_label),
      locationName: typeof row.location_name === "string" ? row.location_name : null,
    };
  });
}

export interface PartnerCreditSummary {
  configured: boolean;
  walletStatus: string | null;
  availableCredits: number | null;
  reservedCredits: number | null;
  consumedThisMonth: number | null;
  consumedLifetime: number | null;
  postedBalance: number | null;
  balanceStatus: "healthy" | "low" | "empty" | "inactive" | "unknown";
}

export interface PartnerCreditLedgerEntry {
  id: string;
  date: string;
  type: string;
  quantity: number;
  submissionReference: string | null;
  cardReference: string | null;
  actor: string;
  source: string;
  runningBalance: number;
  reason: string;
}

export interface PartnerCreditView {
  summary: PartnerCreditSummary;
  ledger: PartnerCreditLedgerEntry[];
  purchaseHistory: PartnerCreditLedgerEntry[];
}

export async function getPartnerCreditView(principal: PartnerPrincipal): Promise<PartnerCreditView> {
  return withTenant({ tenantId: principal.tenantId, locationId: principal.locationId }, async (client) => {
    const availability = await client.query<Record<string, unknown>>(
      `SELECT wallet_id, status, ledger_balance, active_reserved, available_balance, consumed_reservations,
              (SELECT count(*)::bigint
                 FROM partner_credit_reservations r
                WHERE r.tenant_id=$1 AND r.status='consumed'
                  AND r.consumed_at >= date_trunc('month', now())) AS consumed_this_month
         FROM partner_credit_availability
        WHERE tenant_id=$1`,
      [principal.tenantId]
    );

    if (availability.rowCount !== 1) {
      return {
        summary: {
          configured: false,
          walletStatus: null,
          availableCredits: null,
          reservedCredits: null,
          consumedThisMonth: null,
          consumedLifetime: null,
          postedBalance: null,
          balanceStatus: "unknown",
        },
        ledger: [],
        purchaseHistory: [],
      };
    }

    const wallet = availability.rows[0];
    const ledgerResult = await client.query<Record<string, unknown>>(
      `SELECT l.id, l.created_at, l.entry_type, l.amount, l.source, l.reason, l.actor_type,
              l.actor_email, r.submission_reference, r.card_reference,
              SUM(l.amount) OVER (ORDER BY l.created_at ASC, l.id ASC)::bigint AS running_balance
         FROM partner_credit_ledger l
         LEFT JOIN partner_credit_reservations r
           ON r.id::text=l.correlation_id AND r.tenant_id=l.tenant_id
        WHERE l.tenant_id=$1
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT 200`,
      [principal.tenantId]
    );
    const ledger = ledgerResult.rows.map((row): PartnerCreditLedgerEntry => ({
      id: String(row.id),
      date: iso(row.created_at) ?? "",
      type: String(row.entry_type),
      quantity: wholeCredit(row.amount),
      submissionReference: typeof row.submission_reference === "string" ? row.submission_reference : null,
      cardReference: typeof row.card_reference === "string" ? row.card_reference : null,
      actor:
        typeof row.actor_email === "string" && row.actor_email ? row.actor_email : String(row.actor_type ?? "System"),
      source: String(row.source),
      runningBalance: wholeCredit(row.running_balance),
      reason: String(row.reason),
    }));
    const available = wholeCredit(wallet.available_balance);
    const status = String(wallet.status);
    return {
      summary: {
        configured: true,
        walletStatus: status,
        availableCredits: available,
        reservedCredits: wholeCredit(wallet.active_reserved),
        consumedThisMonth: wholeCredit(wallet.consumed_this_month),
        consumedLifetime: wholeCredit(wallet.consumed_reservations),
        postedBalance: wholeCredit(wallet.ledger_balance),
        balanceStatus:
          status !== "active" ? "inactive" : available === 0 ? "empty" : available <= 5 ? "low" : "healthy",
      },
      ledger,
      purchaseHistory: ledger.filter((entry) => entry.type === "purchase"),
    };
  });
}

export interface PartnerSessionView {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  ip: string | null;
  revokedAt: string | null;
}

export async function listOwnPartnerSessions(principal: PartnerPrincipal): Promise<PartnerSessionView[]> {
  return withTenant({ tenantId: principal.tenantId }, async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, created_at, last_seen_at, absolute_expires_at, ip, revoked_at
         FROM partner_sessions
        WHERE tenant_id=$1 AND user_id=$2
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
      [principal.tenantId, principal.userId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      current: String(row.id) === principal.sessionId,
      createdAt: iso(row.created_at) ?? "",
      lastSeenAt: iso(row.last_seen_at),
      expiresAt: iso(row.absolute_expires_at) ?? "",
      ip: typeof row.ip === "string" ? row.ip : null,
      revokedAt: iso(row.revoked_at),
    }));
  });
}

export async function revokeOwnPartnerSession(principal: PartnerPrincipal, sessionId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    return false;
  }
  return withTenant({ tenantId: principal.tenantId }, async (client) => {
    const result = await client.query(
      `UPDATE partner_sessions SET revoked_at=COALESCE(revoked_at,now())
        WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
      [sessionId, principal.tenantId, principal.userId]
    );
    return result.rowCount === 1;
  });
}
