/**
 * Phase 2 completion — new Partner workflow API integration tests (disposable DB, real HTTP).
 *
 * Covers the four backend surfaces added to unblock the submission wizard (Increment B), which
 * tests/partner-submission-workflow.test.ts does not exercise directly:
 *   - GET  /api/partner/locations           (location list + switcher)
 *   - GET  /api/partner/customers           (search)
 *   - POST /api/partner/customers           (create)
 *   - GET  /api/partner/service-tiers       (wizard's Service step)
 *   - PATCH /api/partner/submissions/:id/cards/:cardId (wizard's Cards step edit)
 *
 * Runs ONLY when PARTNER_RT_ADMIN + PARTNER_RT_RUNTIME are set (superuser + runtime URLs to a
 * DISPOSABLE local Postgres):
 *   PARTNER_RT_ADMIN=postgresql://postgres@127.0.0.1:5544/dispo \
 *   PARTNER_RT_RUNTIME=postgresql://partner_app_test_rt:synthetic@127.0.0.1:5544/dispo \
 *   npx vitest run tests/partner-workflow-apis.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import {
  applyMigrationsRealistic,
  pinAccountingTopologyTo,
  PARTNER_MIGRATIONS_WITH_LIFECYCLE,
  provisionRealisticRoles,
} from "./helpers/partner-realistic-db";

const r2Calls = vi.hoisted(() => ({ uploads: [] as string[], deletes: [] as string[] }));
vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async (key: string) => {
    r2Calls.uploads.push(key);
    return key;
  }),
  getR2SignedUrl: vi.fn(async (key: string) => `https://r2.example.invalid/${encodeURIComponent(key)}`),
  deleteFromR2: vi.fn(async (key: string) => {
    r2Calls.deletes.push(key);
  }),
}));

const ADMIN = process.env.PARTNER_RT_ADMIN;
const RUNTIME = process.env.PARTNER_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-2000-0000-0000-000000000001";
const B = "bbbbbbbb-2000-0000-0000-000000000002";
const L1 = "10000000-2000-0000-0000-0000000000c1"; // tenant A, assigned to RECEPTION_A
const L2 = "10000000-2000-0000-0000-0000000000c2"; // tenant A, NOT assigned to RECEPTION_A
const L3_SUSPENDED = "10000000-2000-0000-0000-0000000000c3"; // tenant A, SUSPENDED
const LB = "20000000-2000-0000-0000-0000000000d1"; // tenant B
const OWNER_A = "11111111-2000-0000-0000-0000000000a1"; // org-wide
const RECEPTION_A = "11111111-2000-0000-0000-0000000000a2"; // scoped to L1 only
const RECEPTION_SOLO = "11111111-2000-0000-0000-0000000000a3"; // scoped to L1 only (single-location UX case)
const TECH_A = "11111111-2000-0000-0000-0000000000a4"; // assessment technician, scoped to L1 only
const OWNER_B = "22222222-2000-0000-0000-0000000000b1";
const GRADER_A = "33333333-2000-0000-0000-0000000000a5";

let server: http.Server;
let base: string;
let admin: Client;

async function createCertificateTables(c: Client): Promise<void> {
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { certificates } = await import("../shared/schema");
  const cfg = getTableConfig(certificates);
  const cols = cfg.columns.map((col: any) => {
    let type: string = col.getSQLType();
    if (/^vector/i.test(type)) type = "text";
    if (col.primary && /serial|integer/i.test(type)) type = "SERIAL";
    return [`"${col.name}"`, type, col.primary ? "PRIMARY KEY" : ""].filter(Boolean).join(" ");
  });
  await c.query(`CREATE TABLE certificates (${cols.join(", ")})`);
  await c.query(`ALTER TABLE certificates ADD COLUMN auth_status text DEFAULT 'genuine'`);
  await c.query(`ALTER TABLE certificates ADD COLUMN auth_notes text`);
  await c.query(`ALTER TABLE certificates ADD COLUMN private_notes text`);
  await c.query(`CREATE TABLE cert_counter (
    id integer PRIMARY KEY,
    last_issued bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

(isLocal ? describe : describe.skip)(
  "Partner Phase 2 completion — new workflow APIs (disposable DB, real HTTP)",
  () => {
    beforeAll(async () => {
      admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      // Start from a genuinely empty schema. These three suites share one PARTNER_RT_ADMIN database,
      // and each applies a DIFFERENT migration list as pn_migrator. Without a reset the second suite
      // re-runs an earlier migration's `CREATE OR REPLACE FUNCTION` over a definer function a later
      // migration has already redefined, and PostgreSQL rejects it with "cannot change return type of
      // existing function". `DROP OWNED BY partner_runtime` does not help — the functions and tables
      // are owned by pn_migrator. The database is disposable by contract, so dropping the schema is
      // safe and is what "disposable DB" already implies.
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
      // The G6D lineage includes the connector migrations (0010-0014), which GRANT on the
      // MintVault-side users/submissions/submission_items tables. Nothing in the partner set
      // creates them, so stub them first — same pattern as tests/partner-submission-workflow.
      // provisionRealisticRoles must run first because these are reassigned to pn_migrator.
      await provisionRealisticRoles(admin);
      await admin.query(
        `CREATE TABLE IF NOT EXISTS users (
          id varchar primary key default gen_random_uuid(),
          email varchar unique,
          role varchar default 'customer',
          can_grade boolean not null default false,
          can_scan boolean not null default false,
          can_print boolean not null default false,
          can_edit_sets boolean not null default false,
          deleted_at timestamp,
          credential_version integer not null default 1
        )`
      );
      await admin.query(
        "CREATE TABLE IF NOT EXISTS submissions (id serial primary key, user_id varchar, tracking_number text unique)"
      );
      await admin.query(
        "CREATE TABLE IF NOT EXISTS submission_items (id serial primary key, submission_id integer not null)"
      );
      await admin.query(`CREATE TABLE IF NOT EXISTS audit_log (
        id serial primary key, entity_type text not null, entity_id text not null, action text not null,
        admin_user text, details jsonb, created_at timestamptz not null default now()
      )`);
      await createCertificateTables(admin);
      for (const t of ["users", "submissions", "submission_items", "audit_log", "certificates", "cert_counter"]) {
        await admin.query(`ALTER TABLE ${t} OWNER TO pn_migrator`);
      }
      await applyMigrationsRealistic(admin, ADMIN!, PARTNER_MIGRATIONS_WITH_LIFECYCLE);
      await admin.query("DROP ROLE IF EXISTS partner_app_test_rt").catch(() => {});
      await admin.query("CREATE ROLE partner_app_test_rt LOGIN PASSWORD 'synthetic'");
      await admin.query("GRANT partner_runtime TO partner_app_test_rt");
      process.env.PARTNER_DATABASE_URL = RUNTIME;
      process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
      // CI pins MINTVAULT_DATABASE_URL globally to a DIFFERENT database; the G6D accounting
      // topology assertion in server/partner/db.ts then throws. Pin it to this suite's own.
      pinAccountingTopologyTo(ADMIN);
      process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);

      const { seedPartnerRbac } = await import("../server/partner/permissions");
      await seedPartnerRbac();

      await admin.query(
        "INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'apiA','API A Ltd','ACTIVE'),($2,'apiB','API B Ltd','ACTIVE')",
        [A, B]
      );

      // Submit reserves a grading credit PER CARD, so any suite that drives a real submission needs
      // a funded wallet. Seeded AFTER the organisation rows exist — ensureWallet resolves the org
      // first and fails with ORG_NOT_FOUND otherwise.
      {
        const wallet = await import("../server/partner/partner-wallet-service");
        const actor = { actorUserId: null, actorEmail: "workflow-apis@example.test" };
        for (const [tenantId, key] of [
          [A, "workflow-apis-wallet-a"],
          [B, "workflow-apis-wallet-b"],
        ] as const) {
          await wallet.ensureWallet(actor, tenantId);
          await wallet.appendFoundationCredit(actor, {
            tenantId,
            amount: 100,
            entryType: "purchase",
            source: "admin",
            reason: "Workflow API regression credits",
            idempotencyKey: key,
            actorType: "admin",
          });
        }
      }

      const pw = await bcrypt.hash("correct-horse-battery", 12);
      await admin.query(
        `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES
       ($1,'apiua1',$4,$4,'owner@apia.com',$6,'ACTIVE',false),
       ($2,'apiua2',$4,$4,'reception@apia.com',$6,'ACTIVE',false),
       ($3,'apiua3',$4,$4,'solo@apia.com',$6,'ACTIVE',false),
       ($8,'apiua4',$4,$4,'tech@apia.com',$6,'ACTIVE',false),
       ($5,'apiub1',$7,$7,'owner@apib.com',$6,'ACTIVE',false)`,
        [OWNER_A, RECEPTION_A, RECEPTION_SOLO, A, OWNER_B, pw, B, TECH_A]
      );
      await admin.query(
        "INSERT INTO users (id, email, role, can_grade) VALUES ($1,'grader@mintvault.test','staff',true)",
        [GRADER_A]
      );
      const roleId = async (code: string) =>
        (await admin.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [code])).rows[0].id;
      const owner = await roleId("PARTNER_OWNER");
      const reception = await roleId("PARTNER_RECEPTION");
      const technician = await roleId("MVGS_ASSESSMENT_TECHNICIAN");
      await admin.query(
        `INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES
       ($1,$2,$3), ($1,$4,$5), ($1,$6,$5), ($1,$9,$10), ($7,$8,$3)`,
        [A, OWNER_A, owner, RECEPTION_A, reception, RECEPTION_SOLO, B, OWNER_B, TECH_A, technician]
      );
      await admin.query(
        `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES
       ($1,'apil1',$5,$5,'API Loc1','ACTIVE'), ($2,'apil2',$5,$5,'API Loc2','ACTIVE'),
       ($3,'apil3',$5,$5,'API Loc3 Suspended','SUSPENDED'), ($4,'apilb',$6,$6,'API LocB','ACTIVE')`,
        [L1, L2, L3_SUSPENDED, LB, A, B]
      );
      // RECEPTION_A assigned to L1 only (used for the "unassigned location hidden" + "switch rejects" cases).
      // RECEPTION_SOLO assigned to L1 only too, and is the ONLY assignment seeded for it — the single-location UX case.
      await admin.query(
        `INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3), ($1,$4,$3), ($1,$5,$3)`,
        [A, RECEPTION_A, L1, RECEPTION_SOLO, TECH_A]
      );

      await admin.query("DELETE FROM partner_feature_flags");
      await admin.query(
        "INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true)"
      );
      await admin.query(
        `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES
       (NULL,'api-global','API Global Tier',1500,30,true),
       (NULL,'api-global-disabled','API Global Disabled',1200,30,false)`
      );
      await admin.query(
        `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES
       ($1,'api-a-private','API A Private',2200,10,true), ($1,'api-a-disabled','API A Disabled',900,10,false)`,
        [A]
      );
      // Tenant B's own private tier — must never be visible to tenant A.
      await admin.query(
        `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES
       ($1,'api-b-private','API B Private',5000,3,true)`,
        [B]
      );

      const { createPartnerApp } = await import("../server/partner/app");
      server = http.createServer(createPartnerApp());
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((r) => server?.close(() => r()));
      const { closePartnerPools } = await import("../server/partner/db");
      await closePartnerPools();
      await admin?.query("DROP ROLE IF EXISTS partner_app_test_rt").catch(() => {});
      await admin?.end().catch(() => {});
    });

    beforeEach(async () => {
      const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
      setPartnerRateLimitStore(new MemoryRateLimitStore());
      r2Calls.uploads.length = 0;
      r2Calls.deletes.length = 0;
    });

    async function login(email: string) {
      const res = await fetch(`${base}/api/partner/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "correct-horse-battery" }),
      });
      return res.headers.get("set-cookie")?.split(";")[0] ?? "";
    }
    const j = async (method: string, path: string, cookie: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU8a4QAAAABJRU5ErkJggg==",
      "base64"
    );
    const uploadImage = async (
      path: string,
      cookie: string,
      bytes: Buffer = pngBytes
    ): Promise<{ status: number; body: any }> => {
      const form = new FormData();
      form.set("image", new Blob([bytes], { type: "image/png" }), "card.png");
      const res = await fetch(`${base}${path}`, { method: "POST", headers: { cookie }, body: form });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    async function draftId(cookie: string, locationId = L1): Promise<string> {
      const sub = await j("POST", "/api/partner/submissions", cookie, { locationId });
      return sub.body.id;
    }
    async function submittedWithImages(cookie: string, locationId = L1): Promise<{ id: string; cardIds: string[] }> {
      const id = await draftId(cookie, locationId);
      const first = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Bridge One" });
      const second = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Bridge Two" });
      for (const cardId of [first.body.id, second.body.id]) {
        const front = await uploadImage(`/api/partner/submissions/${id}/cards/${cardId}/images/front`, cookie);
        expect(front.status).toBe(200);
        const back = await uploadImage(`/api/partner/submissions/${id}/cards/${cardId}/images/back`, cookie);
        expect(back.status).toBe(200);
      }
      const submitted = await j("POST", `/api/partner/submissions/${id}/submit`, cookie, {
        idempotencyKey: `bridge-submit-${id}`,
      });
      expect(submitted.status).toBe(200);
      return { id, cardIds: [first.body.id, second.body.id] };
    }
    async function submitGradeThroughHqRoutes(
      certId: number
    ): Promise<{ draftStatus: number; draftBody: any; submitStatus: number; submitBody: any }> {
      const express = (await import("express")).default;
      const session = (await import("express-session")).default;
      const { registerGraderRoutes } = await import("../server/routes/grader");
      const app = express();
      app.use(express.json());
      app.use(session({ secret: "partner-bridge-test", resave: false, saveUninitialized: true }));
      app.use((req, _res, next) => {
        Object.assign(req.session as any, {
          isStaff: true,
          staffId: GRADER_A,
          staffEmail: "grader@mintvault.test",
          capGrade: true,
          isGrader: true,
          graderId: GRADER_A,
          graderEmail: "grader@mintvault.test",
          credentialVersion: 1,
          authenticatedAt: Date.now(),
          authUserId: GRADER_A,
          authRole: "staff",
          isAdmin: false,
        });
        next();
      });
      registerGraderRoutes(app);
      const graderServer = http.createServer(app);
      await new Promise<void>((resolve) => graderServer.listen(0, "127.0.0.1", resolve));
      const graderBase = `http://127.0.0.1:${(graderServer.address() as AddressInfo).port}`;
      try {
        const payload = {
          overall_grade: "8.5",
          grade_centering: "8.5",
          grade_corners: "8.5",
          grade_edges: "8.5",
          grade_surface: "8.5",
          card_name: "Bridge One",
          set_name: "Bridge Set",
          grade_explanation: "Partner bridge grading proof.",
        };
        const draft = await fetch(`${graderBase}/api/grader/certificates/${certId}/grade`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const submit = await fetch(`${graderBase}/api/grader/certificates/${certId}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return {
          draftStatus: draft.status,
          draftBody: await draft.json().catch(() => ({})),
          submitStatus: submit.status,
          submitBody: await submit.json().catch(() => ({})),
        };
      } finally {
        await new Promise<void>((resolve) => graderServer.close(() => resolve()));
      }
    }

    // ── Locations ──────────────────────────────────────────────────────────
    describe("GET /locations", () => {
      it("org-wide owner sees every ACTIVE tenant location, never SUSPENDED, never another tenant's", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("GET", "/api/partner/locations", cookie);
        expect(r.status).toBe(200);
        const ids = r.body.map((l: any) => l.id);
        expect(ids).toContain(L1);
        expect(ids).toContain(L2);
        expect(ids).not.toContain(L3_SUSPENDED); // suspended never listed
        expect(ids).not.toContain(LB); // cross-tenant never listed
      });

      it("location-scoped reception sees only their assignment, not L2", async () => {
        const cookie = await login("reception@apia.com");
        const r = await j("GET", "/api/partner/locations", cookie);
        expect(r.status).toBe(200);
        const ids = r.body.map((l: any) => l.id);
        expect(ids).toEqual([L1]);
      });

      it("tenant B owner never sees tenant A's locations", async () => {
        const cookie = await login("owner@apib.com");
        const r = await j("GET", "/api/partner/locations", cookie);
        expect(r.status).toBe(200);
        for (const l of r.body) expect(l.id).not.toBe(L1);
      });

      it("unauthenticated request is rejected", async () => {
        const r = await j("GET", "/api/partner/locations", "");
        expect(r.status).toBe(401);
      });
    });

    describe("POST /session/location — switch revalidates server-side", () => {
      it("location-scoped reception cannot switch to an unassigned (but same-tenant) location", async () => {
        const cookie = await login("reception@apia.com");
        const r = await j("POST", "/api/partner/session/location", cookie, { locationId: L2 });
        expect(r.status).toBe(403);
        expect(r.body.error).toBe("not_assigned");
      });

      it("switching to a SUSPENDED location is rejected even for an org-wide owner", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("POST", "/api/partner/session/location", cookie, { locationId: L3_SUSPENDED });
        expect(r.status).toBe(404);
        expect(r.body.error).toBe("not_active");
      });

      it("switching to another tenant's location fails closed as not-found (no existence leak)", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("POST", "/api/partner/session/location", cookie, { locationId: LB });
        expect(r.status).toBe(404);
      });

      it("a valid, assigned location switch succeeds and is reflected in the session", async () => {
        const cookie = await login("reception@apia.com");
        const r = await j("POST", "/api/partner/session/location", cookie, { locationId: L1 });
        expect(r.status).toBe(200);
        const session = await j("GET", "/api/partner/session", cookie);
        expect(session.body.locationId).toBe(L1);
      });
    });

    // ── Customers ──────────────────────────────────────────────────────────
    describe("customers", () => {
      it("create + list round-trips for the authenticated tenant", async () => {
        const cookie = await login("owner@apia.com");
        const created = await j("POST", "/api/partner/customers", cookie, {
          fullName: "  Jamie Example  ",
          email: "Jamie@Example.com",
          phone: "07700 900000",
          reference: "ext-ref-1",
        });
        expect(created.status).toBe(201);
        expect(created.body.fullName).toBe("Jamie Example"); // trimmed
        expect(created.body.email).toBe("jamie@example.com"); // normalised lowercase

        const list = await j("GET", "/api/partner/customers", cookie);
        expect(list.status).toBe(200);
        expect(list.body.some((c: any) => c.id === created.body.id)).toBe(true);
      });

      it("cross-tenant customers are invisible via list", async () => {
        const cookieA = await login("owner@apia.com");
        const cookieB = await login("owner@apib.com");
        const createdB = await j("POST", "/api/partner/customers", cookieB, { fullName: "B-Only Customer" });
        expect(createdB.status).toBe(201);
        const listA = await j("GET", "/api/partner/customers", cookieA);
        expect(listA.body.some((c: any) => c.id === createdB.body.id)).toBe(false);
      });

      it("a client-supplied tenant/organisation field is ignored — creation always uses the authenticated tenant", async () => {
        const cookie = await login("owner@apia.com");
        const created = await j("POST", "/api/partner/customers", cookie, {
          fullName: "Spoofed Tenant Attempt",
          tenantId: B,
          organisationId: B,
        });
        expect(created.status).toBe(201);
        const row = await admin.query("SELECT tenant_id FROM partner_customers WHERE id=$1", [created.body.id]);
        expect(row.rows[0].tenant_id).toBe(A); // never B, despite the client's attempt
      });

      it("empty or whitespace-only name is rejected", async () => {
        const cookie = await login("owner@apia.com");
        const empty = await j("POST", "/api/partner/customers", cookie, { fullName: "" });
        expect(empty.status).toBe(400);
        const whitespace = await j("POST", "/api/partner/customers", cookie, { fullName: "   " });
        expect(whitespace.status).toBe(400);
      });

      it("oversized fields are rejected", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("POST", "/api/partner/customers", cookie, { fullName: "x".repeat(600) });
        expect(r.status).toBe(400);
      });

      it("malformed email is rejected, present-but-empty email is treated as absent", async () => {
        const cookie = await login("owner@apia.com");
        const bad = await j("POST", "/api/partner/customers", cookie, { fullName: "Bad Email", email: "not-an-email" });
        expect(bad.status).toBe(400);
        const blank = await j("POST", "/api/partner/customers", cookie, { fullName: "Blank Email", email: "" });
        expect(blank.status).toBe(201);
        expect(blank.body.email).toBeNull();
      });

      it("script-shaped and SQL-shaped values are stored as inert text, never executed", async () => {
        const cookie = await login("owner@apia.com");
        const script = await j("POST", "/api/partner/customers", cookie, { fullName: "<script>alert(1)</script>" });
        expect(script.status).toBe(201);
        expect(script.body.fullName).toBe("<script>alert(1)</script>"); // stored inert; encoding is a render-time concern
        const sqlish = await j("POST", "/api/partner/customers", cookie, {
          fullName: "Robert'); DROP TABLE partner_customers;--",
        });
        expect(sqlish.status).toBe(201);
        const stillThere = await admin.query("SELECT to_regclass('public.partner_customers') r");
        expect(stillThere.rows[0].r).toBe("partner_customers");
      });

      it("search filters by name/reference and stays tenant-scoped", async () => {
        const cookie = await login("owner@apia.com");
        await j("POST", "/api/partner/customers", cookie, { fullName: "Searchable Zzyzx" });
        const r = await j("GET", "/api/partner/customers?search=Zzyzx", cookie);
        expect(r.status).toBe(200);
        expect(r.body.every((c: any) => c.fullName.includes("Zzyzx"))).toBe(true);
      });

      it("unauthenticated create is rejected", async () => {
        const r = await j("POST", "/api/partner/customers", "", { fullName: "No Session" });
        expect(r.status).toBe(401);
      });

      it("read + update stay tenant scoped and reject malformed field shapes", async () => {
        const cookieA = await login("owner@apia.com");
        const cookieB = await login("owner@apib.com");
        const created = await j("POST", "/api/partner/customers", cookieA, {
          fullName: "Editable Customer",
          email: "old@example.com",
        });
        expect(created.status).toBe(201);
        const malformed = await j("PATCH", `/api/partner/customers/${created.body.id}`, cookieA, {
          email: { nested: "nope" },
        });
        expect(malformed.status).toBe(400);
        const updated = await j("PATCH", `/api/partner/customers/${created.body.id}`, cookieA, {
          fullName: "Edited Customer",
          email: null,
          reference: "edited-ref",
        });
        expect(updated.status).toBe(200);
        expect(updated.body.fullName).toBe("Edited Customer");
        expect(updated.body.email).toBeNull();
        const fetched = await j("GET", `/api/partner/customers/${created.body.id}`, cookieA);
        expect(fetched.status).toBe(200);
        expect(fetched.body.reference).toBe("edited-ref");
        const crossTenant = await j("GET", `/api/partner/customers/${created.body.id}`, cookieB);
        expect(crossTenant.status).toBe(404);
      });
    });

    // ── Service tiers ──────────────────────────────────────────────────────
    describe("GET /service-tiers", () => {
      it("active global tier is listed", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("GET", "/api/partner/service-tiers", cookie);
        expect(r.status).toBe(200);
        const global = r.body.find((t: any) => t.tierCode === "api-global");
        expect(global).toBeTruthy();
        expect(global.pricePerCardPence).toBe(1500);
      });

      it("own active private tier is listed", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("GET", "/api/partner/service-tiers", cookie);
        const own = r.body.find((t: any) => t.tierCode === "api-a-private");
        expect(own).toBeTruthy();
        expect(own.pricePerCardPence).toBe(2200);
      });

      it("another tenant's private tier is never listed", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("GET", "/api/partner/service-tiers", cookie);
        expect(r.body.some((t: any) => t.tierCode === "api-b-private")).toBe(false);
      });

      it("disabled tiers (global or org-specific) are never listed", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("GET", "/api/partner/service-tiers", cookie);
        expect(r.body.some((t: any) => t.tierCode === "api-global-disabled")).toBe(false);
        expect(r.body.some((t: any) => t.tierCode === "api-a-disabled")).toBe(false);
      });

      it("only UI-required fields are returned — no hidden internal pricing/id fields leak", async () => {
        const cookie = await login("owner@apia.com");
        const r = await j("GET", "/api/partner/service-tiers", cookie);
        const tier = r.body[0];
        expect(Object.keys(tier).sort()).toEqual(["label", "pricePerCardPence", "tierCode", "turnaroundDays"].sort());
      });

      it("a tenant's tier list is always a safe array, never an error, and never another tenant's tier", async () => {
        const cookie = await login("owner@apib.com"); // tenant B: sees its own private tier + globals only
        const r = await j("GET", "/api/partner/service-tiers", cookie);
        expect(r.status).toBe(200);
        expect(Array.isArray(r.body)).toBe(true);
        expect(r.body.some((t: any) => t.tierCode === "api-a-private")).toBe(false);
      });

      it("unauthenticated request is rejected", async () => {
        const r = await j("GET", "/api/partner/service-tiers", "");
        expect(r.status).toBe(401);
      });
    });

    describe("read-only catalogue and credit preview", () => {
      it("partner catalogue snapshot is authenticated and does not expose admin write routes", async () => {
        const unauth = await j("GET", "/api/partner/catalogue/snapshot", "");
        expect(unauth.status).toBe(401);
        const cookie = await login("owner@apia.com");
        const r = await j("GET", "/api/partner/catalogue/snapshot", cookie);
        expect(r.status).toBe(200);
        expect(r.body).toHaveProperty("snapshot");
        expect(r.body).toHaveProperty("categories");
      });

      it("credit preview is read-only and counts card quantity before submit", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Preview One", quantity: 2 });
        await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Preview Two", quantity: 3 });
        const beforeReservations = await admin.query(
          "SELECT count(*)::int n FROM partner_credit_reservations WHERE submission_reference=$1",
          [id]
        );
        const preview = await j("GET", `/api/partner/submissions/${id}/credit-preview`, cookie);
        expect(preview.status).toBe(200);
        expect(preview.body.cardRows).toBe(2);
        expect(preview.body.cardUnits).toBe(5);
        expect(preview.body.availableCredits).toBeGreaterThanOrEqual(5);
        const afterReservations = await admin.query(
          "SELECT count(*)::int n FROM partner_credit_reservations WHERE submission_reference=$1",
          [id]
        );
        expect(afterReservations.rows[0].n).toBe(beforeReservations.rows[0].n);
      });

      it("credit preview hides wallet totals from users without credit-view permission", async () => {
        const cookie = await login("reception@apia.com");
        const id = await draftId(cookie);
        await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Preview Reception", quantity: 2 });
        const preview = await j("GET", `/api/partner/submissions/${id}/credit-preview`, cookie);
        expect(preview.status).toBe(200);
        expect(preview.body).toMatchObject({
          cardRows: 1,
          cardUnits: 2,
          availableCredits: null,
          reservedCredits: null,
          remainingAfterSubmit: null,
          enoughCredits: true,
        });
      });
    });

    describe("submission draft edits", () => {
      it("explicit null clears a selected customer instead of being treated as no change", async () => {
        const cookie = await login("owner@apia.com");
        const customer = await j("POST", "/api/partner/customers", cookie, { fullName: "Clearable Customer" });
        expect(customer.status).toBe(201);
        const created = await j("POST", "/api/partner/submissions", cookie, {
          locationId: L1,
          customerId: customer.body.id,
        });
        expect(created.status).toBe(201);
        expect(created.body.customerId).toBe(customer.body.id);
        const cleared = await j("PATCH", `/api/partner/submissions/${created.body.id}`, cookie, {
          version: created.body.version,
          customerId: null,
        });
        expect(cleared.status).toBe(200);
        expect(cleared.body.customerId).toBeNull();
        const row = await admin.query("SELECT customer_id FROM partner_submissions WHERE id=$1", [created.body.id]);
        expect(row.rows[0].customer_id).toBeNull();
      });
    });

    describe("partner card image uploads", () => {
      it("uploads front/back images, stores only scoped keys, and writes audit/event evidence", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Image Card" });
        const front = await uploadImage(`/api/partner/submissions/${id}/cards/${card.body.id}/images/front`, cookie);
        expect(front.status).toBe(200);
        expect(front.body.hasFrontImage).toBe(true);
        expect(front.body.frontImageUrl).toContain("https://r2.example.invalid/");
        const back = await uploadImage(`/api/partner/submissions/${id}/cards/${card.body.id}/images/back`, cookie);
        expect(back.status).toBe(200);
        expect(back.body.hasBackImage).toBe(true);
        const detail = await j("GET", `/api/partner/submissions/${id}`, cookie);
        const detailCard = detail.body.cards.find((c: any) => c.id === card.body.id);
        expect(detailCard.frontImageUrl).toContain("https://r2.example.invalid/");
        expect(detailCard.backImageUrl).toContain("https://r2.example.invalid/");
        expect(r2Calls.uploads.every((key) => key.startsWith(`partner-submissions/${A}/${id}/${card.body.id}/`))).toBe(
          true
        );
        const row = await admin.query(
          "SELECT front_image_key, back_image_key FROM partner_submission_cards WHERE id=$1",
          [card.body.id]
        );
        expect(row.rows[0].front_image_key).toContain("/front/");
        expect(row.rows[0].back_image_key).toContain("/back/");
        const events = await admin.query(
          "SELECT count(*)::int n FROM partner_submission_events WHERE submission_id=$1 AND event_type='card_image_uploaded'",
          [id]
        );
        expect(events.rows[0].n).toBe(2);
        const audits = await admin.query(
          "SELECT count(*)::int n FROM partner_audit_events WHERE record_id=$1 AND action='submission_card.image_uploaded'",
          [card.body.id]
        );
        expect(audits.rows[0].n).toBe(2);
      });

      it("rejects cross-tenant image upload without changing the owned card", async () => {
        const cookieA = await login("owner@apia.com");
        const cookieB = await login("owner@apib.com");
        const id = await draftId(cookieA);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookieA, { cardName: "Tenant Image" });
        const attempt = await uploadImage(`/api/partner/submissions/${id}/cards/${card.body.id}/images/front`, cookieB);
        expect(attempt.status).toBe(404);
        expect(r2Calls.uploads).toEqual([]);
        expect(r2Calls.deletes).toEqual([]);
        const row = await admin.query("SELECT front_image_key FROM partner_submission_cards WHERE id=$1", [
          card.body.id,
        ]);
        expect(row.rows[0].front_image_key).toBeNull();
      });

      it("rejects image replacement after submission without uploading a new object", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Locked Image" });
        const first = await uploadImage(`/api/partner/submissions/${id}/cards/${card.body.id}/images/front`, cookie);
        expect(first.status).toBe(200);
        r2Calls.uploads.length = 0;
        r2Calls.deletes.length = 0;
        const submitted = await j("POST", `/api/partner/submissions/${id}/submit`, cookie, {
          idempotencyKey: `image-lock-${id}`,
        });
        expect(submitted.status).toBe(200);
        const attempt = await uploadImage(`/api/partner/submissions/${id}/cards/${card.body.id}/images/front`, cookie);
        expect(attempt.status).toBe(409);
        expect(r2Calls.uploads).toEqual([]);
        expect(r2Calls.deletes).toEqual([]);
      });

      it("rejects non-image bytes before storing a card image key", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Bad Image" });
        const bad = await uploadImage(
          `/api/partner/submissions/${id}/cards/${card.body.id}/images/front`,
          cookie,
          Buffer.from("not an image")
        );
        expect(bad.status).toBe(400);
        const row = await admin.query("SELECT front_image_key FROM partner_submission_cards WHERE id=$1", [
          card.body.id,
        ]);
        expect(row.rows[0].front_image_key).toBeNull();
      });
    });

    describe("Partner -> HQ grading bridge", () => {
      it("creates assigned Partner-origin canonical work items and leaves credits reserved", async () => {
        const cookie = await login("owner@apia.com");
        const { id, cardIds } = await submittedWithImages(cookie);
        const labelsTable = await admin.query("SELECT to_regclass('public.label_prints') AS rel");
        const res = await j("POST", `/api/partner/submissions/${id}/grading-work-items`, cookie, {
          graderId: GRADER_A,
        });
        expect(res.status).toBe(201);
        expect(res.body.created).toBe(2);
        expect(res.body.existing).toBe(false);
        expect(res.body.workItems).toHaveLength(2);
        expect(res.body.workItems.map((w: any) => w.partnerSubmissionCardId).sort()).toEqual([...cardIds].sort());

        const certs = await admin.query(
          `SELECT id, status, print_state, assigned_grader_id, grader_status, origin_type,
                  origin_partner_id::text, origin_location_id::text, grade_approved_at,
                  front_image_path, back_image_path, private_notes
             FROM certificates WHERE id = ANY($1::int[]) ORDER BY id`,
          [res.body.workItems.map((w: any) => w.certId)]
        );
        expect(certs.rows).toHaveLength(2);
        for (const cert of certs.rows as any[]) {
          expect(cert.status).toBe("draft");
          expect(cert.print_state).toBe("awaiting_approval");
          expect(cert.assigned_grader_id).toBe(GRADER_A);
          expect(cert.grader_status).toBe("assigned");
          expect(cert.origin_type).toBe("PARTNER");
          expect(cert.origin_partner_id).toBe(A);
          expect(cert.origin_location_id).toBe(L1);
          expect(cert.grade_approved_at).toBeNull();
          expect(cert.front_image_path).toContain(`partner-submissions/${A}/${id}/`);
          expect(cert.back_image_path).toContain(`partner-submissions/${A}/${id}/`);
          expect(cert.private_notes).toBeNull();
        }

        const reservations = await admin.query(
          `SELECT status, count(*)::int n FROM partner_credit_reservations
            WHERE tenant_id=$1 AND submission_reference=$2 GROUP BY status`,
          [A, id]
        );
        expect(reservations.rows).toEqual([{ status: "active", n: 2 }]);
        const consumed = await admin.query(
          `SELECT COALESCE(sum(amount),0)::int AS amount FROM partner_credit_ledger
            WHERE tenant_id=$1 AND entry_type='consumption'`,
          [A]
        );
        expect(consumed.rows[0].amount).toBe(0);
        expect((await admin.query("SELECT status FROM partner_submissions WHERE id=$1", [id])).rows[0].status).toBe(
          "submitted_to_mintvault"
        );
        expect(labelsTable.rows[0].rel).toBeNull();
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS n FROM audit_log
                WHERE action='partner_grading_work_item_created'
                  AND details->>'partner_submission_id'=$1`,
              [id]
            )
          ).rows[0].n
        ).toBe(2);

        const grade = await submitGradeThroughHqRoutes(res.body.workItems[0].certId);
        expect(grade.draftStatus, JSON.stringify(grade.draftBody)).toBe(200);
        expect(grade.submitStatus).toBe(200);
        expect(grade.submitBody).toMatchObject({ ok: true, gradingStatus: "pending_review", reviewRequired: true });
        const submittedCert = await admin.query(
          `SELECT grader_status, review_required, grade_approved_at, print_state, status
             FROM certificates WHERE id=$1`,
          [res.body.workItems[0].certId]
        );
        expect(submittedCert.rows[0]).toMatchObject({
          grader_status: "pending_review",
          review_required: true,
          grade_approved_at: null,
          print_state: "awaiting_approval",
          status: "draft",
        });
      });

      it("is idempotent for an already-bridged submission", async () => {
        const cookie = await login("owner@apia.com");
        const { id } = await submittedWithImages(cookie);
        const first = await j("POST", `/api/partner/submissions/${id}/grading-work-items`, cookie, {
          graderId: GRADER_A,
        });
        expect(first.status).toBe(201);
        const second = await j("POST", `/api/partner/submissions/${id}/grading-work-items`, cookie, {
          graderId: GRADER_A,
        });
        expect(second.status).toBe(200);
        expect(second.body.existing).toBe(true);
        expect(second.body.created).toBe(0);
        expect(second.body.workItems.map((w: any) => w.certId)).toEqual(first.body.workItems.map((w: any) => w.certId));
      });

      it("fails closed for bad state, missing images, tenant, location, role and grader", async () => {
        const owner = await login("owner@apia.com");
        const otherTenant = await login("owner@apib.com");
        const reception = await login("reception@apia.com");
        const tech = await login("tech@apia.com");

        const draft = await draftId(owner);
        const draftAttempt = await j("POST", `/api/partner/submissions/${draft}/grading-work-items`, owner, {
          graderId: GRADER_A,
        });
        expect(draftAttempt.status).toBe(409);
        expect(draftAttempt.body.error.code).toBe("invalid_state");

        const missingImages = await draftId(owner);
        await j("POST", `/api/partner/submissions/${missingImages}/cards`, owner, { cardName: "No Images" });
        expect(
          (
            await j("POST", `/api/partner/submissions/${missingImages}/submit`, owner, {
              idempotencyKey: `bridge-missing-images-${missingImages}`,
            })
          ).status
        ).toBe(200);
        const missingAttempt = await j("POST", `/api/partner/submissions/${missingImages}/grading-work-items`, owner, {
          graderId: GRADER_A,
        });
        expect(missingAttempt.status).toBe(409);
        expect(missingAttempt.body.error.code).toBe("missing_images");

        const { id } = await submittedWithImages(owner);
        expect(
          (
            await j("POST", `/api/partner/submissions/${id}/grading-work-items`, otherTenant, {
              graderId: GRADER_A,
            })
          ).status
        ).toBe(404);
        expect(
          (
            await j("POST", `/api/partner/submissions/${id}/grading-work-items`, reception, {
              graderId: GRADER_A,
            })
          ).status
        ).toBe(403);

        const l2 = await submittedWithImages(owner, L2);
        const crossLocation = await j("POST", `/api/partner/submissions/${l2.id}/grading-work-items`, tech, {
          graderId: GRADER_A,
        });
        expect(crossLocation.status).toBe(403);

        const badGrader = await j("POST", `/api/partner/submissions/${id}/grading-work-items`, owner, {
          graderId: OWNER_A,
        });
        expect(badGrader.status).toBe(400);
        expect(badGrader.body.error.code).toBe("validation");
      });
    });

    // ── Card edit ──────────────────────────────────────────────────────────
    describe("PATCH /submissions/:id/cards/:cardId", () => {
      it("a valid edit succeeds and writes a card_updated event", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Original Name" });
        const edited = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, cookie, {
          cardName: "Edited Name",
          year: 1999,
        });
        expect(edited.status).toBe(200);
        expect(edited.body.card_name).toBe("Edited Name");
        expect(edited.body.year).toBe(1999);
        const events = await admin.query(
          "SELECT count(*)::int n FROM partner_submission_events WHERE submission_id=$1 AND event_type='card_updated'",
          [id]
        );
        expect(events.rows[0].n).toBe(1);
      });

      it("cross-tenant card edit is denied (404, no existence leak)", async () => {
        const cookieA = await login("owner@apia.com");
        const cookieB = await login("owner@apib.com");
        const idA = await draftId(cookieA);
        const cardA = await j("POST", `/api/partner/submissions/${idA}/cards`, cookieA, { cardName: "Tenant A Card" });
        const attempt = await j("PATCH", `/api/partner/submissions/${idA}/cards/${cardA.body.id}`, cookieB, {
          cardName: "Hijacked",
        });
        expect(attempt.status).toBe(404);
        const unchanged = await admin.query("SELECT card_name FROM partner_submission_cards WHERE id=$1", [
          cardA.body.id,
        ]);
        expect(unchanged.rows[0].card_name).toBe("Tenant A Card");
      });

      it("cross-location card edit is denied for a location-scoped user", async () => {
        const ownerCookie = await login("owner@apia.com");
        const idL2 = await draftId(ownerCookie, L2); // owner creates a draft at L2
        const card = await j("POST", `/api/partner/submissions/${idL2}/cards`, ownerCookie, { cardName: "L2 Card" });
        const receptionCookie = await login("reception@apia.com"); // scoped to L1 only
        const attempt = await j("PATCH", `/api/partner/submissions/${idL2}/cards/${card.body.id}`, receptionCookie, {
          cardName: "Hijacked",
        });
        expect(attempt.status).toBe(404);
      });

      it("a card ID belonging to a DIFFERENT submission (same tenant) is rejected", async () => {
        const cookie = await login("owner@apia.com");
        const id1 = await draftId(cookie);
        const id2 = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id1}/cards`, cookie, { cardName: "Sub1 Card" });
        const attempt = await j("PATCH", `/api/partner/submissions/${id2}/cards/${card.body.id}`, cookie, {
          cardName: "Wrong Submission",
        });
        expect(attempt.status).toBe(404);
      });

      it("editing a card on an already-submitted submission is denied", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Will Submit" });
        const submitted = await j("POST", `/api/partner/submissions/${id}/submit`, cookie, {
          idempotencyKey: "card-edit-lock-" + id,
        });
        expect(submitted.status).toBe(200);
        const attempt = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, cookie, {
          cardName: "Too Late",
        });
        expect(attempt.status).toBe(400);
        expect(attempt.body.error.code).toBe("not_draft");
      });

      it("invalid quantity (zero, negative, non-integer) is rejected, existing quantity untouched", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, {
          cardName: "Qty Card",
          quantity: 3,
        });
        for (const bad of [0, -1, 2.5, "5", [1], { n: 1 }]) {
          const r = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, cookie, { quantity: bad });
          expect(r.status, `quantity=${JSON.stringify(bad)}`).toBe(400);
          expect(r.body.error.code).toBe("invalid_quantity");
        }
        const unchanged = await admin.query("SELECT quantity FROM partner_submission_cards WHERE id=$1", [
          card.body.id,
        ]);
        expect(unchanged.rows[0].quantity).toBe(3); // never silently changed by a rejected edit
      });

      it("invalid year is rejected rather than silently no-op'd", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, {
          cardName: "Year Card",
          year: 2000,
        });
        const r = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, cookie, { year: 3000 });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe("invalid_year");
        const unchanged = await admin.query("SELECT year FROM partner_submission_cards WHERE id=$1", [card.body.id]);
        expect(unchanged.rows[0].year).toBe(2000);
      });

      it("invalid declared value is rejected rather than silently no-op'd", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, {
          cardName: "Value Card",
          declaredValuePence: 500,
        });
        const r = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, cookie, {
          declaredValuePence: -1,
        });
        expect(r.status).toBe(400);
        expect(r.body.error.code).toBe("invalid_declared_value");
        const unchanged = await admin.query("SELECT declared_value_pence FROM partner_submission_cards WHERE id=$1", [
          card.body.id,
        ]);
        expect(unchanged.rows[0].declared_value_pence).toBe(500);
      });

      it("oversized text field is rejected", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Text Card" });
        const r = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, cookie, {
          customerNotes: "x".repeat(600),
        });
        expect(r.status).toBe(400);
      });

      it("unknown card ID is rejected as not-found", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const r = await j(
          "PATCH",
          `/api/partner/submissions/${id}/cards/00000000-0000-0000-0000-000000000000`,
          cookie,
          { cardName: "Ghost" }
        );
        expect(r.status).toBe(404);
      });

      it("script-shaped and SQL-shaped edit values are stored as inert text, table survives", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Inert Card" });
        const r = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, cookie, {
          customerNotes: "'; DROP TABLE partner_submission_cards; --",
        });
        expect(r.status).toBe(200);
        const stillThere = await admin.query("SELECT to_regclass('public.partner_submission_cards') r");
        expect(stillThere.rows[0].r).toBe("partner_submission_cards");
      });

      it("unauthenticated edit is rejected", async () => {
        const cookie = await login("owner@apia.com");
        const id = await draftId(cookie);
        const card = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: "Auth Card" });
        const r = await j("PATCH", `/api/partner/submissions/${id}/cards/${card.body.id}`, "", { cardName: "Nope" });
        expect(r.status).toBe(401);
      });
    });
  }
);
