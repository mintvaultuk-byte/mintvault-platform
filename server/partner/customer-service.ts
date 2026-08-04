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

export interface PartnerCustomer {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  reference: string | null;
  createdAt: string;
  updatedAt: string | null;
}

function toCustomer(r: any): PartnerCustomer {
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    reference: r.reference,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  };
}

export async function listCustomers(principal: PartnerPrincipal, search?: string): Promise<PartnerCustomer[]> {
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    const { rows } = search
      ? await c.query(
          `SELECT id, full_name, email, phone, reference, created_at, updated_at FROM partner_customers
            WHERE full_name ILIKE $1 OR reference ILIKE $1 ORDER BY full_name LIMIT 50`,
          [`%${search}%`]
        )
      : await c.query(
          `SELECT id, full_name, email, phone, reference, created_at, updated_at FROM partner_customers ORDER BY full_name LIMIT 50`
        );
    return rows.map(toCustomer);
  });
}

export async function getCustomer(principal: PartnerPrincipal, customerId: string): Promise<PartnerCustomer> {
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    const { rows } = await c.query(
      `SELECT id, full_name, email, phone, reference, created_at, updated_at
         FROM partner_customers
        WHERE id=$1 AND tenant_id=$2`,
      [customerId, principal.tenantId]
    );
    if (rows.length !== 1) throw new CustomerError("not_found", "Customer not found.");
    return toCustomer(rows[0]);
  });
}

export interface CreateCustomerInput {
  fullName: string;
  email?: string | null;
  phone?: string | null;
  reference?: string | null;
}

// Deliberately simple format check (not RFC 5322) — good enough to catch typos ("bob@") without
// rejecting real-world addresses a stricter validator would choke on.
function isPlausibleEmail(value: string): boolean {
  if (!value || value.length > 254) return false;
  if ([...value].some((ch) => ch.trim() === "")) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@") || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  return domain.includes(".") && domain.split(".").every(Boolean);
}

export async function createCustomer(
  principal: PartnerPrincipal,
  input: CreateCustomerInput
): Promise<PartnerCustomer> {
  if (!input.fullName || !input.fullName.trim()) throw VALIDATION("Customer name is required.");
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !isPlausibleEmail(email)) throw VALIDATION("Enter a valid customer email.");
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    const { rows } = await c.query(
      `INSERT INTO partner_customers (tenant_id, full_name, email, phone, reference, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, full_name, email, phone, reference, created_at, updated_at`,
      [principal.tenantId, input.fullName.trim(), email, input.phone ?? null, input.reference ?? null, principal.userId]
    );
    return toCustomer(rows[0]);
  });
}

export interface UpdateCustomerInput {
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  reference?: string | null;
}

export async function updateCustomer(
  principal: PartnerPrincipal,
  customerId: string,
  input: UpdateCustomerInput
): Promise<PartnerCustomer> {
  if (Object.keys(input).length === 0) throw VALIDATION("No customer changes were provided.");
  if (input.fullName !== undefined && !input.fullName.trim()) throw VALIDATION("Customer name is required.");
  const email = input.email === undefined ? undefined : input.email?.trim().toLowerCase() || null;
  if (email && !isPlausibleEmail(email)) throw VALIDATION("Enter a valid customer email.");
  return withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    const { rows } = await c.query(
      `UPDATE partner_customers SET
         full_name = COALESCE($3, full_name),
         email = CASE WHEN $7 THEN $4 ELSE email END,
         phone = CASE WHEN $8 THEN $5 ELSE phone END,
         reference = CASE WHEN $9 THEN $6 ELSE reference END,
         updated_at = now()
       WHERE id=$1 AND tenant_id=$2
       RETURNING id, full_name, email, phone, reference, created_at, updated_at`,
      [
        customerId,
        principal.tenantId,
        input.fullName?.trim() ?? null,
        email ?? null,
        input.phone ?? null,
        input.reference ?? null,
        input.email !== undefined,
        input.phone !== undefined,
        input.reference !== undefined,
      ]
    );
    if (rows.length !== 1) throw new CustomerError("not_found", "Customer not found.");
    return toCustomer(rows[0]);
  });
}
