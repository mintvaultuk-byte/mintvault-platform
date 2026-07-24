/**
 * print-workflow-service.test.ts — DB-backed. Exercises the server-authoritative
 * batch service against a disposable PostgreSQL 17 cluster, with the PDF renderer
 * and storage stubbed. Proves the atomicity contract the hardening brief demands:
 * reserve → render → finalise, idempotent retry, race-safe concurrent reservation,
 * release-on-render-failure, duplicate protection, reprint + completion, and the
 * append-only audit ledger. No staging/prod touched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const { Client, Pool } = pg;

// Runtime holder so the hoisted mocks can reach the live cluster + toggle failure.
const runtime: { db: unknown; pool: unknown; renderShouldFail: boolean } = {
  db: null,
  pool: null,
  renderShouldFail: false,
};
const seededCerts: { certId: string; ownershipStatus: string }[] = [];

vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("db used before setup");
    return runtime.db;
  },
  get pool() {
    return runtime.pool;
  },
}));

vi.mock("../server/r2", () => ({ uploadToR2: vi.fn(async (k: string) => k) }));

vi.mock("../server/storage", () => ({
  storage: {
    listCertificates: vi.fn(async () => seededCerts),
    getOrGenerateClaimCode: vi.fn(async () => "CLAIMCODE1234"),
  },
}));

// Keep the REAL deriveBatchId / CERTS_PER_PAGE / SHEET_LAYOUT_VERSION; stub only
// the heavy render + upload so no PDF/R2 work happens. renderShouldFail drives the
// release path.
vi.mock("../server/print-batch", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    generatePrintBatchPDF: vi.fn(async () => {
      if (runtime.renderShouldFail) throw new Error("render boom");
      return Buffer.from("pdf");
    }),
    generatePrintBatchPNG: vi.fn(async () => Buffer.from("png")),
    generatePrintBatchPrintPNG: vi.fn(async () => Buffer.from("ppng")),
    generateCricutSVG: vi.fn(() => "<svg/>"),
    uploadPrintBatchArtifacts: vi.fn(async () => {}),
    uploadPrintBatchPDF: vi.fn(async () => {}),
    uploadCricutSvg: vi.fn(async () => {}),
  };
});

const BASE_DDL = `
  CREATE TABLE certificates (
    id serial PRIMARY KEY, certificate_number text UNIQUE NOT NULL,
    grade_approved_at timestamptz, grade_approved_by text, deleted_at timestamptz,
    status varchar(10) NOT NULL DEFAULT 'active', ownership_status varchar(20) NOT NULL DEFAULT 'unclaimed',
    updated_at timestamptz DEFAULT now(), issued_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE label_prints ( id serial PRIMARY KEY, cert_id text UNIQUE NOT NULL, sheet_ref text, queued_at timestamptz DEFAULT now(), printed_at timestamptz );
  CREATE TABLE reprint_log ( id serial PRIMARY KEY, cert_id text NOT NULL, reprint_time timestamptz DEFAULT now() );
  CREATE TABLE audit_log ( id serial PRIMARY KEY, entity_type text NOT NULL, entity_id text NOT NULL, action text NOT NULL, admin_user text, details jsonb DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now() );
`;

const ADMIN = { actor: "admin@mintvault", role: "admin" as const };

let cluster: DisposablePostgres17;
let adminClient: InstanceType<typeof Client>;
// Loaded after mocks are in place.
let svc: typeof import("../server/print-workflow");

async function seedCert(certId: string, printState: string, opts: { approved?: boolean; claimed?: boolean } = {}) {
  await adminClient.query(
    `INSERT INTO certificates (certificate_number, print_state, grade_approved_at, ownership_status)
     VALUES ($1, $2, $3, $4)`,
    [certId, printState, opts.approved === false ? null : new Date(), opts.claimed ? "claimed" : "unclaimed"]
  );
  seededCerts.push({ certId, ownershipStatus: opts.claimed ? "claimed" : "unclaimed" });
}

async function stateOf(certId: string): Promise<string> {
  const r = await adminClient.query(`SELECT print_state FROM certificates WHERE certificate_number=$1`, [certId]);
  return r.rows[0]?.print_state;
}

describe("print-workflow service (DB-backed, mocked renderer)", () => {
  beforeAll(async () => {
    cluster = await startPostgres17("print-workflow-service");
    adminClient = new Client({ connectionString: cluster.url });
    await adminClient.connect();
    await adminClient.query(BASE_DDL);
    const file = listMigrationFiles().find((m) => m.filename.includes("0022_print_workflow"))!;
    await applyMigrations(adminClient, [file]);
    runtime.pool = new Pool({ connectionString: cluster.url, max: 6 });
    runtime.db = drizzle(runtime.pool as InstanceType<typeof Pool>);
    svc = await import("../server/print-workflow");
  }, 120_000);

  afterAll(async () => {
    await (runtime.pool as InstanceType<typeof Pool>)?.end().catch(() => {});
    await adminClient?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    runtime.renderShouldFail = false;
    seededCerts.length = 0;
    await adminClient.query(`TRUNCATE certificates, label_prints, reprint_log, print_batches, print_events RESTART IDENTITY`);
  });

  it("reserves needs_printing certs into a printing batch (happy path)", async () => {
    await seedCert("MV1", "needs_printing");
    await seedCert("MV2", "needs_printing");
    const r = await svc.createBatchAtomic({ certIds: ["MV1", "MV2"], identity: ADMIN });
    expect(r.applied.sort()).toEqual(["MV1", "MV2"]);
    expect(r.kind).toBe("batch");
    expect(r.batchId).toBeTruthy();
    expect(await stateOf("MV1")).toBe("printing");
    const batch = await adminClient.query(`SELECT status, cert_count FROM print_batches WHERE batch_id=$1`, [r.batchId]);
    expect(batch.rows[0].status).toBe("printing");
    expect(Number(batch.rows[0].cert_count)).toBe(2);
    const ev = await adminClient.query(`SELECT to_state FROM print_events WHERE cert_id='MV1' AND action='create_batch'`);
    expect(ev.rows[0].to_state).toBe("printing");
    // label_prints row written (queued, not printed) so the queue printedAt works.
    const lp = await adminClient.query(`SELECT printed_at FROM label_prints WHERE cert_id='MV1'`);
    expect(lp.rows[0].printed_at).toBeNull();
  });

  it("is idempotent — a repeat returns the existing batch without double-reserving", async () => {
    await seedCert("MV10", "needs_printing");
    const first = await svc.createBatchAtomic({ certIds: ["MV10"], identity: ADMIN });
    const second = await svc.createBatchAtomic({ certIds: ["MV10"], identity: ADMIN });
    expect(second.batchId).toBe(first.batchId);
    expect(second.isDuplicate).toBe(true);
    const events = await adminClient.query(`SELECT COUNT(*) FROM print_events WHERE cert_id='MV10' AND action='create_batch'`);
    expect(Number(events.rows[0].count)).toBe(1); // not doubled
  });

  it("rejects an already-printed cert (duplicate protection routes to reprint)", async () => {
    await seedCert("MV20", "printed");
    const r = await svc.createBatchAtomic({ certIds: ["MV20"], identity: ADMIN });
    expect(r.applied).toEqual([]);
    expect(r.rejected[0]).toMatchObject({ certId: "MV20", code: "already_printed" });
    expect(await stateOf("MV20")).toBe("printed"); // untouched
  });

  it("rejects an unapproved cert", async () => {
    await seedCert("MV21", "awaiting_approval", { approved: false });
    const r = await svc.createBatchAtomic({ certIds: ["MV21"], identity: ADMIN });
    expect(r.rejected[0]).toMatchObject({ code: "not_approved" });
  });

  it("releases the reservation and fails loud when rendering fails", async () => {
    await seedCert("MV30", "needs_printing");
    runtime.renderShouldFail = true;
    await expect(svc.createBatchAtomic({ certIds: ["MV30"], identity: ADMIN })).rejects.toThrow();
    // Card rolled back — never printed because a render failed.
    expect(await stateOf("MV30")).toBe("needs_printing");
    const batch = await adminClient.query(`SELECT status FROM print_batches ORDER BY id DESC LIMIT 1`);
    expect(batch.rows[0].status).toBe("failed");
    const rel = await adminClient.query(`SELECT to_state FROM print_events WHERE cert_id='MV30' AND to_state='needs_printing'`);
    expect(rel.rows.length).toBeGreaterThan(0);
  });

  it("reserves each contended cert to exactly one of two concurrent batches", async () => {
    await seedCert("MVX", "needs_printing");
    await seedCert("MVA", "needs_printing");
    await seedCert("MVB", "needs_printing");
    const [a, b] = await Promise.all([
      svc.createBatchAtomic({ certIds: ["MVX", "MVA"], identity: { actor: "a@x", role: "admin" } }),
      svc.createBatchAtomic({ certIds: ["MVX", "MVB"], identity: { actor: "b@x", role: "admin" } }),
    ]);
    const appliedX = [a, b].filter((r) => r.applied.includes("MVX"));
    expect(appliedX.length).toBe(1); // exactly one batch got MVX
    expect(await stateOf("MVX")).toBe("printing");
    // The loser reports MVX as already_reserved.
    const loser = [a, b].find((r) => !r.applied.includes("MVX"))!;
    expect(loser.rejected.some((x) => x.certId === "MVX" && x.code === "already_reserved")).toBe(true);
  });

  it("marks a batch printed → printed; a reprint batch → reprinted", async () => {
    await seedCert("MV40", "needs_printing");
    const batch = await svc.createBatchAtomic({ certIds: ["MV40"], identity: ADMIN });
    const mp = await svc.markBatchPrinted(batch.batchId!, ADMIN);
    expect(mp.applied).toEqual(["MV40"]);
    expect(await stateOf("MV40")).toBe("printed");
    const lp = await adminClient.query(`SELECT printed_at FROM label_prints WHERE cert_id='MV40'`);
    expect(lp.rows[0].printed_at).not.toBeNull();

    // Reprint loop → reprinted.
    await svc.requestReprint({ certIds: ["MV40"], reason: "Damaged during slabbing test", reasonCategory: "damaged_print", identity: ADMIN });
    expect(await stateOf("MV40")).toBe("reprint_required");
    const rp = await svc.createBatchAtomic({ certIds: ["MV40"], identity: ADMIN });
    expect(rp.kind).toBe("reprint");
    await svc.markBatchPrinted(rp.batchId!, ADMIN);
    expect(await stateOf("MV40")).toBe("reprinted");
  });

  it("reprint requires a reason, logs reprint_log + an event with reason/category", async () => {
    await seedCert("MV50", "printed");
    const bad = await svc.requestReprint({ certIds: ["MV50"], reason: "too short", reasonCategory: "lost_label", identity: ADMIN });
    expect(bad.applied).toEqual([]);
    expect(await stateOf("MV50")).toBe("printed");

    await svc.requestReprint({ certIds: ["MV50"], reason: "Lost in the post to the customer", reasonCategory: "lost_label", identity: ADMIN });
    expect(await stateOf("MV50")).toBe("reprint_required");
    const log = await adminClient.query(`SELECT COUNT(*) FROM reprint_log WHERE cert_id='MV50'`);
    expect(Number(log.rows[0].count)).toBe(1);
    const ev = await adminClient.query(`SELECT reason, reason_category, actor FROM print_events WHERE cert_id='MV50' AND action='reprint'`);
    expect(ev.rows[0]).toMatchObject({ reason_category: "lost_label", actor: "admin@mintvault" });
  });

  it("marks completed only from printed/reprinted", async () => {
    await seedCert("MV60", "printed");
    await seedCert("MV61", "needs_printing");
    const ok = await svc.markCompleted({ certIds: ["MV60"], identity: ADMIN });
    expect(ok.applied).toEqual(["MV60"]);
    expect(await stateOf("MV60")).toBe("completed");
    const no = await svc.markCompleted({ certIds: ["MV61"], identity: ADMIN });
    expect(no.applied).toEqual([]);
    expect(no.rejected[0].code).toBe("not_printed_yet");
  });

  it("keeps an append-only audit ledger per cert", async () => {
    await seedCert("MV70", "needs_printing");
    const batch = await svc.createBatchAtomic({ certIds: ["MV70"], identity: ADMIN });
    await svc.markBatchPrinted(batch.batchId!, ADMIN);
    await svc.markCompleted({ certIds: ["MV70"], identity: ADMIN });
    const events = await svc.listCertEvents("MV70");
    const actions = events.map((e) => e.action);
    expect(actions).toContain("create_batch");
    expect(actions).toContain("mark_printed");
    expect(actions).toContain("complete");
    // Every event carries actor + role for attribution.
    expect(events.every((e) => e.actor === "admin@mintvault" && e.actorRole === "admin")).toBe(true);
  });
});
