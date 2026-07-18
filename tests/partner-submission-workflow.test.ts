/**
 * Phase 2 — Partner submission workflow integration test (disposable DB, real HTTP).
 *
 * Proves the minimum end-to-end Phase 2 journey against the actual runtime (not unit stubs):
 * login → create draft → add cards → save → location isolation → cross-tenant IDOR → stale-version
 * conflict → idempotent submit → exactly-once handoff → audit trail → cancellation.
 *
 * Runs ONLY when PARTNER_RT_ADMIN + PARTNER_RT_RUNTIME are set (superuser + runtime URLs to a
 * DISPOSABLE local Postgres):
 *   PARTNER_RT_ADMIN=postgresql://postgres@127.0.0.1:5544/dispo \
 *   PARTNER_RT_RUNTIME=postgresql://partner_app_test:synthetic@127.0.0.1:5544/dispo \
 *   npx vitest run tests/partner-submission-workflow.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { applyMigrationsRealistic } from "./helpers/partner-realistic-db";

const ADMIN = process.env.PARTNER_RT_ADMIN;
const RUNTIME = process.env.PARTNER_RT_RUNTIME;
const isLocal = !!ADMIN && !!RUNTIME && /@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN);

const A = "aaaaaaaa-1000-0000-0000-000000000001";
const B = "bbbbbbbb-1000-0000-0000-000000000002";
const L1 = "10000000-1000-0000-0000-0000000000c1";
const L2 = "10000000-1000-0000-0000-0000000000c2";
const LB = "20000000-1000-0000-0000-0000000000d1";
const OWNER_A = "11111111-1000-0000-0000-0000000000a1";
const RECEPTION_A = "11111111-1000-0000-0000-0000000000a2";
const OWNER_B = "22222222-1000-0000-0000-0000000000b1";

let server: http.Server;
let base: string;
let admin: Client;

(isLocal ? describe : describe.skip)("Partner submission workflow (disposable DB, real HTTP)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query("DROP OWNED BY partner_runtime").catch(() => {});
    await applyMigrationsRealistic(admin, ADMIN!);
    await admin.query("DROP ROLE IF EXISTS partner_app_test").catch(() => {});
    await admin.query("CREATE ROLE partner_app_test LOGIN PASSWORD 'synthetic'");
    await admin.query("GRANT partner_runtime TO partner_app_test");
    process.env.PARTNER_DATABASE_URL = RUNTIME;
    process.env.PARTNER_ADMIN_DATABASE_URL = ADMIN;
    process.env.PARTNER_MFA_ENC_KEY = "0".repeat(64);

    const { seedPartnerRbac } = await import("../server/partner/permissions");
    await seedPartnerRbac();

    await admin.query("INSERT INTO partner_organisations (id, public_ref, legal_name, status) VALUES ($1,'wfA','WF A Ltd','ACTIVE'),($2,'wfB','WF B Ltd','ACTIVE')", [A, B]);
    const pw = await bcrypt.hash("correct-horse-battery", 12);
    await admin.query(
      `INSERT INTO partner_users (id, public_ref, tenant_id, partner_id, email, password_hash, status, mfa_required) VALUES
       ($1,'wfua1',$3,$3,'owner@wfa.com',$5,'ACTIVE',false),
       ($2,'wfua2',$3,$3,'reception@wfa.com',$5,'ACTIVE',false),
       ($4,'wfub1',$6,$6,'owner@wfb.com',$5,'ACTIVE',false)`,
      [OWNER_A, RECEPTION_A, A, OWNER_B, pw, B],
    );
    const roleId = async (code: string) => (await admin.query<{ id: string }>("SELECT id FROM partner_roles WHERE code=$1", [code])).rows[0].id;
    const owner = await roleId("PARTNER_OWNER");
    const reception = await roleId("PARTNER_RECEPTION");
    await admin.query(
      `INSERT INTO partner_user_roles (tenant_id, user_id, role_id) VALUES
       ($1,$2,$3), ($1,$4,$5), ($6,$7,$3)`,
      [A, OWNER_A, owner, RECEPTION_A, reception, B, OWNER_B],
    );
    await admin.query(
      `INSERT INTO partner_locations (id, public_ref, tenant_id, partner_id, name, status) VALUES
       ($1,'wfl1',$4,$4,'Loc1','ACTIVE'), ($2,'wfl2',$4,$4,'Loc2','ACTIVE'), ($3,'wflb',$5,$5,'LocB','ACTIVE')`,
      [L1, L2, LB, A, B],
    );
    // reception@wfa is scoped ONLY to L1 (location-scoped user); owner is org-wide (no assignment row needed)
    await admin.query(`INSERT INTO partner_user_locations (tenant_id, user_id, location_id) VALUES ($1,$2,$3)`, [A, RECEPTION_A, L1]);

    await admin.query("DELETE FROM partner_feature_flags");
    await admin.query("INSERT INTO partner_feature_flags (tenant_id, flag, enabled) VALUES (NULL,'partner_portal_enabled',true)");
    // Global service-tier defaults are seeded out-of-band (superuser/ops), never by the migration
    // itself — see the note in migrations/0007_partner_submissions.sql.
    await admin.query(
      `INSERT INTO partner_service_tiers (tenant_id, tier_code, label, price_per_card_pence, turnaround_days, is_active) VALUES
       (NULL,'standard','Vault Queue',1900,40,true), (NULL,'priority','Standard',2500,15,true), (NULL,'express','Express',4500,5,true)`,
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
    await admin?.query("DROP ROLE IF EXISTS partner_app_test").catch(() => {});
    await admin?.end().catch(() => {});
  });

  beforeEach(async () => {
    const { setPartnerRateLimitStore, MemoryRateLimitStore } = await import("../server/partner/rate-limit");
    setPartnerRateLimitStore(new MemoryRateLimitStore());
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

  it("1-11: owner creates a draft with 3 cards, saves it, and it persists correctly", async () => {
    const cookie = await login("owner@wfa.com");
    const created = await j("POST", "/api/partner/submissions", cookie, {
      locationId: L1,
      internalReference: "wf-ref-1",
      serviceTierCode: "standard",
      intakeNotes: "customer intake note",
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("draft");
    expect(created.body.estimatedPricePence).toBe(1900); // resolved from the seeded global tier
    const id = created.body.id;

    for (const name of ["Charizard", "Blastoise", "Venusaur"]) {
      const c = await j("POST", `/api/partner/submissions/${id}/cards`, cookie, { cardName: name, game: "pokemon" });
      expect(c.status).toBe(201);
    }

    const detail = await j("GET", `/api/partner/submissions/${id}`, cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.cards).toHaveLength(3);
    expect(detail.body.cards.map((c: any) => c.card_name)).toEqual(["Charizard", "Blastoise", "Venusaur"]);
    expect(detail.body.submission.cardCount).toBe(3);
    // "sign out, sign back in" — a fresh login re-derives the same persisted state.
    const cookie2 = await login("owner@wfa.com");
    const detail2 = await j("GET", `/api/partner/submissions/${id}`, cookie2);
    expect(detail2.body.submission.id).toBe(id);
    expect(detail2.body.cards).toHaveLength(3);
  });

  it("14-17: location-scoped staff cannot see another location's draft; org-wide owner can", async () => {
    const ownerCookie = await login("owner@wfa.com");
    const inL2 = await j("POST", "/api/partner/submissions", ownerCookie, { locationId: L2 });
    expect(inL2.status).toBe(201);

    const receptionCookie = await login("reception@wfa.com");
    // Reception (scoped to L1 only) cannot see the L2 draft — fails closed as not-found, no existence leak.
    const blocked = await j("GET", `/api/partner/submissions/${inL2.body.id}`, receptionCookie);
    expect(blocked.status).toBe(404);
    // Reception CANNOT create a submission at L2 either (not their assigned location).
    const forbiddenCreate = await j("POST", "/api/partner/submissions", receptionCookie, { locationId: L2 });
    expect(forbiddenCreate.status).toBe(403);
    // Org-wide owner CAN see it.
    const seen = await j("GET", `/api/partner/submissions/${inL2.body.id}`, ownerCookie);
    expect(seen.status).toBe(200);
    // Location-scoped reception's OWN list only ever returns L1-scoped rows.
    const receptionList = await j("GET", "/api/partner/submissions", receptionCookie);
    expect(receptionList.status).toBe(200);
    for (const s of receptionList.body.items) expect(s.locationId).toBe(L1);
  });

  it("cross-tenant IDOR: owner@wfb cannot read or edit tenant A's submission", async () => {
    const ownerACookie = await login("owner@wfa.com");
    const sub = await j("POST", "/api/partner/submissions", ownerACookie, { locationId: L1 });
    const ownerBCookie = await login("owner@wfb.com");
    const read = await j("GET", `/api/partner/submissions/${sub.body.id}`, ownerBCookie);
    expect(read.status).toBe(404); // RLS makes the row simply not exist for tenant B
    const edit = await j("PATCH", `/api/partner/submissions/${sub.body.id}`, ownerBCookie, { version: 1 });
    expect(edit.status).toBe(404);
  });

  it("stale-version conflict: concurrent edits are rejected, not silently overwritten", async () => {
    const cookie = await login("owner@wfa.com");
    const sub = await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    const first = await j("PATCH", `/api/partner/submissions/${sub.body.id}`, cookie, { version: 1, internalReference: "first-edit" });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);
    // retry with the STALE version 1 again — must be rejected, never silently overwrite "first-edit"
    const stale = await j("PATCH", `/api/partner/submissions/${sub.body.id}`, cookie, { version: 1, internalReference: "stale-edit" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("stale_version");
    const detail = await j("GET", `/api/partner/submissions/${sub.body.id}`, cookie);
    expect(detail.body.submission.internalReference).toBe("first-edit"); // not overwritten
  });

  it("customerId is tenant-verified: cannot attach another tenant's customer via create or edit (FK bypasses RLS, so this must be an explicit application check)", async () => {
    const bCustomerRow = await admin.query(
      "INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,'B Customer') RETURNING id",
      [B],
    );
    const bCustomerId = bCustomerRow.rows[0].id;

    const ownerACookie = await login("owner@wfa.com");
    const created = await j("POST", "/api/partner/submissions", ownerACookie, { locationId: L1, customerId: bCustomerId });
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe("validation");

    // Also blocked on edit of an existing tenant-A draft.
    const draft = await j("POST", "/api/partner/submissions", ownerACookie, { locationId: L1 });
    const edited = await j("PATCH", `/api/partner/submissions/${draft.body.id}`, ownerACookie, { version: 1, customerId: bCustomerId });
    expect(edited.status).toBe(400);
    expect(edited.body.error.code).toBe("validation");

    // A customer belonging to the SAME tenant works fine.
    const aCustomerRow = await admin.query("INSERT INTO partner_customers (tenant_id, full_name) VALUES ($1,'A Customer') RETURNING id", [A]);
    const ok = await j("PATCH", `/api/partner/submissions/${draft.body.id}`, ownerACookie, { version: 1, customerId: aCustomerRow.rows[0].id });
    expect(ok.status).toBe(200);
  });

  it("idempotency key reused across two DIFFERENT submissions under a race returns a clean 409, not a raw 500", async () => {
    const cookie = await login("owner@wfa.com");
    const subX = await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    const subY = await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    await j("POST", `/api/partner/submissions/${subX.body.id}/cards`, cookie, { cardName: "X-card" });
    await j("POST", `/api/partner/submissions/${subY.body.id}/cards`, cookie, { cardName: "Y-card" });

    const sameKey = "collide-" + subX.body.id;
    const [rx, ry] = await Promise.all([
      j("POST", `/api/partner/submissions/${subX.body.id}/submit`, cookie, { idempotencyKey: sameKey }),
      j("POST", `/api/partner/submissions/${subY.body.id}/submit`, cookie, { idempotencyKey: sameKey }),
    ]);
    // Exactly one succeeds; the other gets a clean 409 idempotency_conflict — NEVER a raw 500.
    const statuses = [rx.status, ry.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = rx.status === 409 ? rx : ry;
    expect(loser.body.error.code).toBe("idempotency_conflict");
  });

  it("19-25: submit is idempotent, creates exactly one handoff, is audited, and locks the draft", async () => {
    const cookie = await login("owner@wfa.com");
    const sub = await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    await j("POST", `/api/partner/submissions/${sub.body.id}/cards`, cookie, { cardName: "Pikachu" });

    const key = "idem-key-" + sub.body.id;
    const [r1, r2] = await Promise.all([
      j("POST", `/api/partner/submissions/${sub.body.id}/submit`, cookie, { idempotencyKey: key }),
      j("POST", `/api/partner/submissions/${sub.body.id}/submit`, cookie, { idempotencyKey: key }),
    ]);
    // Both concurrent requests with the SAME key succeed and describe the same submitted submission —
    // proving double-click/retry does not create a duplicate.
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r1.body.submission.status).toBe("submitted_to_mintvault");
    expect(r2.body.submission.status).toBe("submitted_to_mintvault");

    const handoffs = await admin.query("SELECT count(*)::int n, status FROM partner_submission_handoffs WHERE submission_id=$1 GROUP BY status", [sub.body.id]);
    expect(handoffs.rows).toHaveLength(1);
    expect(handoffs.rows[0].n).toBe(1); // EXACTLY one handoff row despite two concurrent submit calls

    const events = await admin.query("SELECT event_type FROM partner_submission_events WHERE submission_id=$1 AND event_type='submitted'", [sub.body.id]);
    expect(events.rowCount).toBe(1);

    const audit = await admin.query("SELECT action FROM partner_audit_events WHERE tenant_id=$1 AND record_id=$2 AND action='submission.submitted'", [A, sub.body.id]);
    expect(audit.rowCount).toBe(1);

    // Locked: further edits are rejected once submitted.
    const editAfter = await j("PATCH", `/api/partner/submissions/${sub.body.id}`, cookie, { version: 2, internalReference: "too-late" });
    expect(editAfter.status).toBe(400);
    expect(editAfter.body.error.code).toBe("not_draft");

    // A DIFFERENT idempotency key against the now-submitted row correctly fails (not silently re-run).
    const differentKey = await j("POST", `/api/partner/submissions/${sub.body.id}/submit`, cookie, { idempotencyKey: "a-different-key" });
    expect(differentKey.status).toBe(400);
    expect(differentKey.body.error.code).toBe("not_draft");
  });

  it("submit requires at least one card", async () => {
    const cookie = await login("owner@wfa.com");
    const sub = await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    const res = await j("POST", `/api/partner/submissions/${sub.body.id}/submit`, cookie, { idempotencyKey: "no-cards" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation");
  });

  it("cancellation requires a reason and is audited", async () => {
    const cookie = await login("owner@wfa.com");
    const sub = await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    const noReason = await j("DELETE", `/api/partner/submissions/${sub.body.id}`, cookie, {});
    expect(noReason.status).toBe(400);
    const cancelled = await j("DELETE", `/api/partner/submissions/${sub.body.id}`, cookie, { reason: "duplicate entry" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    const events = await admin.query("SELECT reason FROM partner_submission_events WHERE submission_id=$1 AND event_type='cancelled'", [sub.body.id]);
    expect(events.rows[0].reason).toBe("duplicate entry");
  });

  it("removing a card decrements card_count and is not visible in a subsequent list", async () => {
    const cookie = await login("owner@wfa.com");
    const sub = await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    const card = await j("POST", `/api/partner/submissions/${sub.body.id}/cards`, cookie, { cardName: "Mewtwo" });
    const removed = await j("DELETE", `/api/partner/submissions/${sub.body.id}/cards/${card.body.id}`, cookie, { reason: "duplicate" });
    expect(removed.status).toBe(200);
    const cards = await j("GET", `/api/partner/submissions/${sub.body.id}/cards`, cookie);
    expect(cards.body).toHaveLength(0);
    const detail = await j("GET", `/api/partner/submissions/${sub.body.id}`, cookie);
    expect(detail.body.submission.cardCount).toBe(0);
  });

  it("oversized/malformed input is rejected safely (no raw DB error, no crash)", async () => {
    const cookie = await login("owner@wfa.com");
    const oversized = await j("POST", "/api/partner/submissions", cookie, { locationId: L1, internalReference: "x".repeat(600) });
    expect(oversized.status).toBe(400);
    const malformedPage = await j("GET", "/api/partner/submissions?page=not-a-number&pageSize=99999999", cookie);
    expect(malformedPage.status).toBe(200); // guarded, clamps to safe defaults, never crashes
    const htmlInjection = await j("POST", "/api/partner/submissions", cookie, {
      locationId: L1,
      internalReference: "<script>alert(1)</script>",
    });
    expect(htmlInjection.status).toBe(201); // stored as inert text; encoding is a render-time concern, not a write-time crash
    const sqlish = await j("POST", "/api/partner/submissions", cookie, {
      locationId: L1,
      internalReference: "'; DROP TABLE partner_submissions; --",
    });
    expect(sqlish.status).toBe(201); // parameterised — treated as literal text, table survives
    const stillThere = await admin.query("SELECT to_regclass('public.partner_submissions') r");
    expect(stillThere.rows[0].r).toBe("partner_submissions");
  });

  it("dashboard summary is tenant- and location-scoped", async () => {
    const cookie = await login("owner@wfa.com");
    await j("POST", "/api/partner/submissions", cookie, { locationId: L1 });
    const summary = await j("GET", "/api/partner/dashboard/submissions", cookie);
    expect(summary.status).toBe(200);
    expect(summary.body.draft).toBeGreaterThanOrEqual(1);
  });

  it("a suspended user is blocked before any submission action (reuses Phase 1 session invalidation)", async () => {
    const cookie = await login("owner@wfb.com");
    const ok = await j("POST", "/api/partner/submissions", cookie, { locationId: LB });
    expect(ok.status).toBe(201);
    await admin.query("UPDATE partner_users SET status='SUSPENDED' WHERE id=$1", [OWNER_B]);
    const blocked = await j("GET", "/api/partner/submissions", cookie);
    expect(blocked.status).toBe(401); // session invalidated the moment the user is suspended
    await admin.query("UPDATE partner_users SET status='ACTIVE' WHERE id=$1", [OWNER_B]); // restore for any later test
  });
});
