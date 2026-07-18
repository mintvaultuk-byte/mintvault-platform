/**
 * Partner Portal — customer service (Phase 2 completion). The partner_customers table + RLS +
 * grants already exist (migration 0007); this completes the wiring the submission wizard needs
 * ("New customer creation" is an explicit requirement) — createSubmissionDraft could already
 * VERIFY an existing customerId, but nothing could CREATE one. Same withTenant/RLS pattern as
 * submission-service.ts.
 */
import type { PoolClient } from "pg";
import { withTenant } from "./db";
import type { PartnerPrincipal } from "./session";

export class CustomerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const VALIDATION = (msg: string) => new CustomerError("validation", msg);

export interface PartnerCustomer {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  reference: string | null;
  createdAt: string;
}

function toCustomer(r: any): PartnerCustomer {
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    reference: r.reference,
    createdAt: r.created_at,
  };
}

export async function listCustomers(principal: PartnerPrincipal, search?: string): Promise<PartnerCustomer[]> {
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    const { rows } = search
      ? await c.query(
          `SELECT id, full_name, email, phone, reference, created_at FROM partner_customers
            WHERE full_name ILIKE $1 OR reference ILIKE $1 ORDER BY full_name LIMIT 50`,
          [`%${search}%`],
        )
      : await c.query(`SELECT id, full_name, email, phone, reference, created_at FROM partner_customers ORDER BY full_name LIMIT 50`);
    return rows.map(toCustomer);
  });
}

export interface CreateCustomerInput {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  reference?: string | null;
}

// Deliberately simple format check (not RFC 5322) — good enough to catch typos ("bob@") without
// rejecting real-world addresses a stricter regex would choke on. Matches the pattern used by
// HTML5 <input type="email">'s baseline validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createCustomer(principal: PartnerPrincipal, input: CreateCustomerInput): Promise<PartnerCustomer> {
  if (!input.fullName || !input.fullName.trim()) throw VALIDATION("Customer name is required.");
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw VALIDATION("Enter a valid customer email.");
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    const { rows } = await c.query(
      `INSERT INTO partner_customers (tenant_id, full_name, email, phone, reference, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, full_name, email, phone, reference, created_at`,
      [principal.tenantId, input.fullName.trim(), email, input.phone ?? null, input.reference ?? null, principal.userId],
    );
    return toCustomer(rows[0]);
  });
}
