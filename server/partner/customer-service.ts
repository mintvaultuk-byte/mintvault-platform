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
    message: string
  ) {
    super(message);
  }
}
const VALIDATION = (msg: string) => new CustomerError("validation", msg);
const DUPLICATE = (msg: string) => new CustomerError("duplicate", msg);

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
          [`%${search}%`]
        )
      : await c.query(
          `SELECT id, full_name, email, phone, reference, created_at FROM partner_customers ORDER BY full_name LIMIT 50`
        );
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedInput(input: CreateCustomerInput): Required<CreateCustomerInput> {
  if (!input.fullName || !input.fullName.trim()) throw VALIDATION("Customer name is required.");
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw VALIDATION("Enter a valid customer email.");
  return {
    fullName: input.fullName.trim(),
    email,
    phone: input.phone?.trim() || null,
    reference: input.reference?.trim() || null,
  };
}

async function lockTenantCustomerBook(c: PoolClient, tenantId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`partner_customers:${tenantId}`]);
}

async function assertNoDuplicateCustomer(
  c: PoolClient,
  tenantId: string,
  input: Required<CreateCustomerInput>,
  excludeCustomerId: string | null
): Promise<void> {
  if (!input.email && !input.reference) return;
  const { rows } = await c.query<{ id: string; email: string | null; reference: string | null }>(
    `SELECT id, email, reference
       FROM partner_customers
      WHERE tenant_id=$1
        AND ($2::uuid IS NULL OR id<>$2::uuid)
        AND (
          ($3::text IS NOT NULL AND email=$3)
          OR ($4::text IS NOT NULL AND lower(reference)=lower($4))
        )
      LIMIT 1`,
    [tenantId, excludeCustomerId, input.email, input.reference]
  );
  if (rows.length !== 0) {
    const duplicate = rows[0];
    if (input.email && duplicate.email === input.email) {
      throw DUPLICATE("A customer with that email already exists.");
    }
    throw DUPLICATE("A customer with that reference already exists.");
  }
}

export async function createCustomer(
  principal: PartnerPrincipal,
  input: CreateCustomerInput
): Promise<PartnerCustomer> {
  const clean = normalizedInput(input);
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    await lockTenantCustomerBook(c, principal.tenantId);
    await assertNoDuplicateCustomer(c, principal.tenantId, clean, null);
    const { rows } = await c.query(
      `INSERT INTO partner_customers (tenant_id, full_name, email, phone, reference, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, full_name, email, phone, reference, created_at`,
      [principal.tenantId, clean.fullName, clean.email, clean.phone, clean.reference, principal.userId]
    );
    return toCustomer(rows[0]);
  });
}

export async function updateCustomer(
  principal: PartnerPrincipal,
  customerId: string,
  input: CreateCustomerInput
): Promise<PartnerCustomer> {
  if (!UUID_RE.test(customerId)) throw new CustomerError("not_found", "Customer not found.");
  const clean = normalizedInput(input);
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    await lockTenantCustomerBook(c, principal.tenantId);
    const existing = await c.query("SELECT 1 FROM partner_customers WHERE id=$1 AND tenant_id=$2", [
      customerId,
      principal.tenantId,
    ]);
    if (existing.rows.length !== 1) throw new CustomerError("not_found", "Customer not found.");
    await assertNoDuplicateCustomer(c, principal.tenantId, clean, customerId);
    const { rows } = await c.query(
      `UPDATE partner_customers
          SET full_name=$3, email=$4, phone=$5, reference=$6, updated_at=now()
        WHERE id=$1 AND tenant_id=$2
        RETURNING id, full_name, email, phone, reference, created_at`,
      [customerId, principal.tenantId, clean.fullName, clean.email, clean.phone, clean.reference]
    );
    if (rows.length !== 1) throw new CustomerError("not_found", "Customer not found.");
    return toCustomer(rows[0]);
  });
}
