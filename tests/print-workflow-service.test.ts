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
import { createHash } from "node:crypto";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const { Client, Pool } = pg;

// Runtime holder so the hoisted mocks can reach the live cluster + toggle failure.
const runtime: {
  db: unknown;
  pool: unknown;
  renderShouldFail: boolean;
  renderedItems: unknown[];
  afterObjectPut: (() => Promise<void>) | null;
} = {
  db: null,
  pool: null,
  renderShouldFail: false,
  renderedItems: [],
  afterObjectPut: null,
};
const seededCerts: { certId: string; ownershipStatus: string }[] = [];
const r2Objects = new Map<string, Buffer>();

vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("db used before setup");
    return runtime.db;
  },
  get pool() {
    return runtime.pool;
  },
}));

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async (key: string, body: Buffer) => {
    r2Objects.set(key, Buffer.from(body));
    return key;
  }),
  inspectR2ObjectIntegrity: vi.fn(async (key: string) => {
    const body = r2Objects.get(key);
    return body
      ? { exists: true, byteLength: body.length, sha256: createHash("sha256").update(body).digest("hex") }
      : { exists: false };
  }),
  uploadCreateOnlyToR2: vi.fn(async (key: string, body: Buffer) => {
    if (r2Objects.has(key)) throw new Error("conditional create collision");
    r2Objects.set(key, Buffer.from(body));
    const callback = runtime.afterObjectPut;
    runtime.afterObjectPut = null;
    await callback?.();
  }),
  deleteFromR2: vi.fn(async (key: string) => {
    r2Objects.delete(key);
  }),
}));

vi.mock("../server/storage", () => ({
  storage: {
    listCertificates: vi.fn(async () => seededCerts),
    getOrGenerateClaimCode: vi.fn(async (certId: string) => {
      await (runtime.pool as InstanceType<typeof Pool>).query(
        "UPDATE certificates SET claim_code=COALESCE(claim_code,'CLAIMCODE1234') WHERE certificate_number=$1",
        [certId]
      );
      return "CLAIMCODE1234";
    }),
  },
}));

// Keep the REAL deriveBatchId / CERTS_PER_PAGE / SHEET_LAYOUT_VERSION; stub only
// the heavy render + upload so no PDF/R2 work happens. renderShouldFail drives the
// release path.
vi.mock("../server/print-batch", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    generatePrintBatchPDF: vi.fn(async (items: unknown[]) => {
      runtime.renderedItems = items;
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
    -- The service now reads these to enforce the grade-printability gate (a numeric
    -- certificate may never enter a printable batch without a valid MVGS ladder grade),
    -- so the fixture must model them or the gate would be untestable here.
    grade_type text NOT NULL DEFAULT 'numeric', grade numeric(4,1), grader_status text NOT NULL DEFAULT 'approved',
    claim_code text, origin_type text NOT NULL DEFAULT 'HQ',
    card_name text, set_name text, variant text, language text, year_text text,
    updated_at timestamptz DEFAULT now(), issued_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE label_overrides (
    id serial PRIMARY KEY, cert_id text UNIQUE NOT NULL,
    card_name_override text, set_override text, variant_override text,
    language_override text, year_override text, edited_at timestamptz NOT NULL DEFAULT now()
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
let printBatch: typeof import("../server/print-batch");

async function seedCert(
  certId: string,
  printState: string,
  opts: { approved?: boolean; claimed?: boolean; gradeType?: string; grade?: number | null } = {}
) {
  await adminClient.query(
    `INSERT INTO certificates (certificate_number, print_state, grade_approved_at, ownership_status, grade_type, grade)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      certId,
      printState,
      opts.approved === false ? null : new Date(),
      opts.claimed ? "claimed" : "unclaimed",
      opts.gradeType ?? "numeric",
      // Default to a real ladder grade so existing tests describe a printable card;
      // pass grade: null explicitly to exercise the gate.
      opts.grade === undefined ? 8.5 : opts.grade,
    ]
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
    await adminClient.query(`
      CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE partner_organisations(id uuid PRIMARY KEY);
      CREATE TABLE submissions(
        id serial PRIMARY KEY,tracking_number text NOT NULL UNIQUE,status text NOT NULL,
        status_history jsonb NOT NULL DEFAULT '[]'::jsonb,on_receipt_photo_urls text,
        received_at timestamptz,deleted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION partner_current_tenant()
      RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
        SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid
      $fn$;
    `);
    await adminClient.query(BASE_DDL);
    const migration = (filename: string) => listMigrationFiles().find((m) => m.filename === filename)!;
    await applyMigrations(adminClient, [
      migration("0022_print_workflow_lifecycle.sql"),
      migration("0121_main_runtime_role_authority.sql"),
      migration("0122_object_write_intent_reconciliation.sql"),
    ]);
    runtime.pool = new Pool({ connectionString: cluster.url, max: 6 });
    runtime.db = drizzle(runtime.pool as InstanceType<typeof Pool>);
    svc = await import("../server/print-workflow");
    printBatch = await import("../server/print-batch");
  }, 120_000);

  afterAll(async () => {
    await (runtime.pool as InstanceType<typeof Pool>)?.end().catch(() => {});
    await adminClient?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    runtime.renderShouldFail = false;
    runtime.renderedItems = [];
    runtime.afterObjectPut = null;
    vi.clearAllMocks();
    seededCerts.length = 0;
    r2Objects.clear();
    await adminClient.query(
      `TRUNCATE object_write_items,object_write_operations,certificates,label_overrides,label_prints,reprint_log,print_batches,print_events RESTART IDENTITY`
    );
  });

  it("reserves needs_printing certs into a printing batch (happy path)", async () => {
    await seedCert("MV1", "needs_printing");
    await seedCert("MV2", "needs_printing");
    const r = await svc.createBatchAtomic({ certIds: ["MV1", "MV2"], identity: ADMIN });
    expect(r.applied.sort()).toEqual(["MV1", "MV2"]);
    expect(r.kind).toBe("batch");
    expect(r.batchId).toBeTruthy();
    expect(await stateOf("MV1")).toBe("printing");
    const batch = await adminClient.query(`SELECT status, cert_count FROM print_batches WHERE batch_id=$1`, [
      r.batchId,
    ]);
    expect(batch.rows[0].status).toBe("printing");
    expect(Number(batch.rows[0].cert_count)).toBe(2);
    const ev = await adminClient.query(
      `SELECT to_state FROM print_events WHERE cert_id='MV1' AND action='create_batch'`
    );
    expect(ev.rows[0].to_state).toBe("printing");
    // label_prints row written (queued, not printed) so the queue printedAt works.
    const lp = await adminClient.query(`SELECT printed_at FROM label_prints WHERE cert_id='MV1'`);
    expect(lp.rows[0].printed_at).toBeNull();
  });

  it("emits Cricut artifacts through five cards and switches six cards to PDF-only", async () => {
    for (let index = 1; index <= 5; index++) await seedCert(`MVC${index}`, "needs_printing");
    const five = await svc.createBatchAtomic({ certIds: [1, 2, 3, 4, 5].map((n) => `MVC${n}`), identity: ADMIN });
    expect(five).toMatchObject({ pdfOnly: false, isPdfMultiPage: false, multiSheet: false, pageCount: 1 });
    expect(printBatch.generatePrintBatchPNG).toHaveBeenCalledTimes(1);
    expect(printBatch.generatePrintBatchPrintPNG).toHaveBeenCalledTimes(1);
    expect(printBatch.generateCricutSVG).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    for (let index = 1; index <= 6; index++) await seedCert(`MVP${index}`, "needs_printing");
    const six = await svc.createBatchAtomic({ certIds: [1, 2, 3, 4, 5, 6].map((n) => `MVP${n}`), identity: ADMIN });
    expect(six).toMatchObject({ pdfOnly: true, isPdfMultiPage: false, multiSheet: true, pageCount: 1 });
    expect(printBatch.generatePrintBatchPDF).toHaveBeenCalledTimes(1);
    expect(printBatch.generatePrintBatchPNG).not.toHaveBeenCalled();
    expect(printBatch.generatePrintBatchPrintPNG).not.toHaveBeenCalled();
    expect(printBatch.generateCricutSVG).not.toHaveBeenCalled();
  });

  it("applies label overrides to the actual batch renderer and binds them into the final CAS", async () => {
    await seedCert("MVOVERRIDE", "needs_printing");
    await adminClient.query("UPDATE certificates SET card_name='Original' WHERE certificate_number='MVOVERRIDE'");
    await adminClient.query(
      "INSERT INTO label_overrides(cert_id,card_name_override) VALUES ('MVOVERRIDE','Operator Label')"
    );
    const result = await svc.createBatchAtomic({
      certIds: ["MVOVERRIDE"],
      identity: ADMIN,
      idempotencyKey: "override-render",
    });
    expect(result.applied).toEqual(["MVOVERRIDE"]);
    expect((runtime.renderedItems[0] as { cert: { cardName: string } }).cert.cardName).toBe("Operator Label");
  });

  it("terminally abandons and compensates when an override changes after render", async () => {
    await seedCert("MVOVERRACE", "needs_printing");
    await adminClient.query(
      "INSERT INTO label_overrides(cert_id,card_name_override) VALUES ('MVOVERRACE','Before Render')"
    );
    runtime.afterObjectPut = async () => {
      await adminClient.query(
        "UPDATE label_overrides SET card_name_override='After Render',edited_at=now() WHERE cert_id='MVOVERRACE'"
      );
    };
    await expect(
      svc.createBatchAtomic({ certIds: ["MVOVERRACE"], identity: ADMIN, idempotencyKey: "override-race" })
    ).rejects.toThrow("render inputs changed");
    expect(await stateOf("MVOVERRACE")).toBe("needs_printing");
    expect((await adminClient.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("ABANDONED");
    expect((await adminClient.query("SELECT count(*)::int AS count FROM label_prints")).rows[0].count).toBe(0);
    expect((await adminClient.query("SELECT status FROM print_batches")).rows[0].status).toBe("failed");
    expect(
      (await adminClient.query("SELECT count(*)::int AS count FROM print_events WHERE reason_category='object_write_abandoned'"))
        .rows[0].count
    ).toBe(1);
    expect(
      (await adminClient.query("SELECT count(*)::int AS count FROM object_write_items WHERE cleanup_state='PENDING'"))
        .rows[0].count
    ).toBeGreaterThan(0);
  });

  it("is idempotent — a repeat returns the existing batch without double-reserving", async () => {
    await seedCert("MV10", "needs_printing");
    const first = await svc.createBatchAtomic({ certIds: ["MV10"], identity: ADMIN, idempotencyKey: "mv10" });
    const second = await svc.createBatchAtomic({ certIds: ["MV10"], identity: ADMIN, idempotencyKey: "mv10" });
    expect(second.batchId).toBe(first.batchId);
    expect(second.isDuplicate).toBe(true);
    const events = await adminClient.query(
      `SELECT COUNT(*) FROM print_events WHERE cert_id='MV10' AND action='create_batch'`
    );
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
    expect(batch.rows).toHaveLength(0);
    const rel = await adminClient.query(
      `SELECT to_state FROM print_events WHERE cert_id='MV30' AND to_state='needs_printing'`
    );
    expect(rel.rows).toHaveLength(0);
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

    // Exactly ONE reservation exists for MVX — it is never double-reserved. The
    // append-only create_batch event is the durable record of a reservation, and
    // only the winning batch may carry MVX in its cert_ids.
    const events = await adminClient.query(
      `SELECT batch_id FROM print_events WHERE cert_id='MVX' AND action='create_batch'`
    );
    expect(events.rows.length).toBe(1);
    const batches = await adminClient.query(`SELECT batch_id FROM print_batches WHERE cert_ids @> '["MVX"]'::jsonb`);
    expect(batches.rows.length).toBe(1);
    expect(batches.rows[0].batch_id).toBe(events.rows[0].batch_id);

    // The loser must be rejected for MVX through one of the TWO legitimate
    // concurrency paths. WHICH one is a pure read-timing detail with no
    // behavioural difference, so asserting a single code makes this test flaky:
    //   already_reserved → the loser's pre-flight read still saw MVX batchable,
    //                      then the state-guarded UPDATE claimed 0 rows because
    //                      the winner had committed first (server/print-workflow.ts).
    //   invalid_from     → the winner's print_state='printing' was already committed
    //                      when the loser's pre-flight read ran, so the pure state
    //                      machine rejected MVX up front (shared/print-lifecycle.ts —
    //                      "printing" is not a batchable from-state).
    // Both prove the same invariant: the loser never got MVX.
    const loser = [a, b].find((r) => !r.applied.includes("MVX"))!;
    const loserX = loser.rejected.find((x) => x.certId === "MVX");
    expect(loserX, "the losing batch must report MVX as rejected").toBeDefined();
    expect(["already_reserved", "invalid_from"]).toContain(loserX!.code);
    expect(loser.applied).not.toContain("MVX");
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
    await svc.requestReprint({
      certIds: ["MV40"],
      reason: "Damaged during slabbing test",
      reasonCategory: "damaged_print",
      identity: ADMIN,
    });
    expect(await stateOf("MV40")).toBe("reprint_required");
    const rp = await svc.createBatchAtomic({ certIds: ["MV40"], identity: ADMIN });
    expect(rp.kind).toBe("reprint");
    await svc.markBatchPrinted(rp.batchId!, ADMIN);
    expect(await stateOf("MV40")).toBe("reprinted");
  });

  it("reprint requires a reason, logs reprint_log + an event with reason/category", async () => {
    await seedCert("MV50", "printed");
    const bad = await svc.requestReprint({
      certIds: ["MV50"],
      reason: "too short",
      reasonCategory: "lost_label",
      identity: ADMIN,
    });
    expect(bad.applied).toEqual([]);
    expect(await stateOf("MV50")).toBe("printed");

    await svc.requestReprint({
      certIds: ["MV50"],
      reason: "Lost in the post to the customer",
      reasonCategory: "lost_label",
      identity: ADMIN,
    });
    expect(await stateOf("MV50")).toBe("reprint_required");
    const log = await adminClient.query(`SELECT COUNT(*) FROM reprint_log WHERE cert_id='MV50'`);
    expect(Number(log.rows[0].count)).toBe(1);
    const ev = await adminClient.query(
      `SELECT reason, reason_category, actor FROM print_events WHERE cert_id='MV50' AND action='reprint'`
    );
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

  it("F1 regression: concurrent IDENTICAL submits never strand a cert or corrupt the batch", async () => {
    await seedCert("MVDUP", "needs_printing");
    const [a, b] = await Promise.all([
      svc.createBatchAtomic({ certIds: ["MVDUP"], identity: ADMIN }),
      svc.createBatchAtomic({ certIds: ["MVDUP"], identity: ADMIN }),
    ]);
    const winners = [a, b].filter((r) => r.applied.includes("MVDUP"));
    // Either exactly one request reserved it, or (if the 2nd read after the 1st
    // committed) the 2nd returned the 1st as a duplicate — never two live reserves.
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(await stateOf("MVDUP")).toBe("printing");
    const winnerBatch = winners.find((r) => !r.isDuplicate)?.batchId ?? winners[0].batchId!;
    // The winning batch row is non-empty and the cert is still markable (not stranded).
    const row = await adminClient.query(`SELECT cert_ids, status FROM print_batches WHERE batch_id=$1`, [winnerBatch]);
    expect(row.rows[0].cert_ids).toEqual(["MVDUP"]);
    const mp = await svc.markBatchPrinted(winnerBatch, ADMIN);
    expect(mp.applied).toEqual(["MVDUP"]);
    expect(await stateOf("MVDUP")).toBe("printed");
  });

  it("backend-F3 regression: mark-printed rejects a never-rendered ('rendering') batch", async () => {
    await seedCert("MVREND", "needs_printing");
    await adminClient.query(
      `INSERT INTO print_batches (batch_id, kind, status, cert_ids, cert_count, created_by) VALUES ('aaaa000000000001','batch','rendering','["MVREND"]'::jsonb,1,'admin@mintvault')`
    );
    await adminClient.query(`UPDATE certificates SET print_state='printing' WHERE certificate_number='MVREND'`);
    const r = await svc.markBatchPrinted("aaaa000000000001", ADMIN);
    expect(r.applied).toEqual([]);
    expect(r.rejected[0].code).toBe("not_printable");
    expect(await stateOf("MVREND")).toBe("printing"); // NOT advanced to printed
  });

  it("DB-F2 regression: a second same-actor reprint of the same cert reserves a distinct batch", async () => {
    await seedCert("MVRR", "printed");
    await svc.requestReprint({
      certIds: ["MVRR"],
      reason: "First damage on the corner",
      reasonCategory: "damaged_print",
      identity: ADMIN,
    });
    const b1 = await svc.createBatchAtomic({ certIds: ["MVRR"], identity: ADMIN });
    await svc.markBatchPrinted(b1.batchId!, ADMIN);
    expect(await stateOf("MVRR")).toBe("reprinted");
    await svc.requestReprint({
      certIds: ["MVRR"],
      reason: "Second, different damage later",
      reasonCategory: "damaged_print",
      identity: ADMIN,
    });
    const b2 = await svc.createBatchAtomic({ certIds: ["MVRR"], identity: ADMIN });
    expect(b2.applied).toEqual(["MVRR"]); // NOT swallowed as a duplicate of b1
    expect(b2.batchId).not.toBe(b1.batchId);
    expect(await stateOf("MVRR")).toBe("printing");
  });

  // ── Grade-printability gate (production incident 2026-07-25: 22 ungraded certificates
  // were rendered onto a real label sheet reading 0 / POOR) ─────────────────────────────
  it("refuses to batch a numeric cert with NO grade, and creates NOTHING", async () => {
    await seedCert("MVNOGRADE", "needs_printing", { grade: null });
    const before = await adminClient.query(`SELECT count(*)::int n FROM print_batches`);
    const r = await svc.createBatchAtomic({ certIds: ["MVNOGRADE"], identity: ADMIN });
    expect(r.applied).toEqual([]);
    expect(r.batchId).toBeNull();
    expect(r.rejected[0]?.code).toBe("missing_numeric_grade");
    expect(r.rejected[0]?.message).toContain("MVNOGRADE");
    // Atomic: no batch row, no print event, no state change.
    const after = await adminClient.query(`SELECT count(*)::int n FROM print_batches`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const ev = await adminClient.query(`SELECT count(*)::int n FROM print_events WHERE cert_id='MVNOGRADE'`);
    expect(ev.rows[0].n).toBe(0);
    expect(await stateOf("MVNOGRADE")).toBe("needs_printing");
  });

  it("refuses an off-ladder grade and a contradictory kind/grade pair", async () => {
    await seedCert("MVOFFLADDER", "needs_printing", { grade: 7.55 });
    const a = await svc.createBatchAtomic({ certIds: ["MVOFFLADDER"], identity: ADMIN });
    expect(a.batchId).toBeNull();
    expect(a.rejected[0]?.code).toBe("off_ladder_numeric_grade");

    await seedCert("MVCONTRA", "needs_printing", { gradeType: "NO", grade: 8.5 });
    const b = await svc.createBatchAtomic({ certIds: ["MVCONTRA"], identity: ADMIN });
    expect(b.batchId).toBeNull();
    expect(b.rejected[0]?.code).toBe("kind_grade_contradiction");
  });

  it("an authentication-only cert with no grade batches fine — that is its correct state", async () => {
    await seedCert("MVAUTHOK", "needs_printing", { gradeType: "NO", grade: null });
    const r = await svc.createBatchAtomic({ certIds: ["MVAUTHOK"], identity: ADMIN });
    expect(r.applied).toEqual(["MVAUTHOK"]);
    expect(r.batchId).toBeTruthy();
    expect(await stateOf("MVAUTHOK")).toBe("printing");
  });

  it("one bad card blocks the WHOLE sheet — a physical sheet is not printed half-good", async () => {
    await seedCert("MVGOOD1", "needs_printing", { grade: 9 });
    await seedCert("MVBAD1", "needs_printing", { grade: null });
    const r = await svc.createBatchAtomic({ certIds: ["MVGOOD1", "MVBAD1"], identity: ADMIN });
    expect(r.applied).toEqual([]);
    expect(r.batchId).toBeNull();
    // The good card must NOT have been reserved.
    expect(await stateOf("MVGOOD1")).toBe("needs_printing");
    expect(await stateOf("MVBAD1")).toBe("needs_printing");
  });

  it("a REPRINT is held to the same rule — no historical-artefact exemption", async () => {
    await seedCert("MVREPNOGRADE", "reprint_required", { grade: null });
    const r = await svc.createBatchAtomic({ certIds: ["MVREPNOGRADE"], identity: ADMIN });
    expect(r.applied).toEqual([]);
    expect(r.batchId).toBeNull();
    expect(r.rejected[0]?.code).toBe("missing_numeric_grade");
    expect(await stateOf("MVREPNOGRADE")).toBe("reprint_required");
  });

  it("reconciler releases a stale 'rendering' batch but leaves a fresh one alone", async () => {
    await seedCert("MVSTUCK", "needs_printing");
    await seedCert("MVFRESH", "needs_printing");
    await adminClient.query(
      `UPDATE certificates SET print_state='printing' WHERE certificate_number IN ('MVSTUCK','MVFRESH')`
    );
    await adminClient.query(
      `INSERT INTO print_batches (batch_id, kind, status, cert_ids, cert_count, created_by, created_at)
       VALUES ('bbbb000000000001','batch','rendering','["MVSTUCK"]'::jsonb,1,'admin@mintvault', NOW() - INTERVAL '20 minutes'),
              ('bbbb000000000002','batch','rendering','["MVFRESH"]'::jsonb,1,'admin@mintvault', NOW())`
    );
    const released = await svc.reconcileStuckPrintBatches(15);
    expect(released).toBe(1);
    expect(await stateOf("MVSTUCK")).toBe("needs_printing"); // released
    expect(await stateOf("MVFRESH")).toBe("printing"); // fresh render untouched (age guard)
    const b = await adminClient.query(`SELECT status FROM print_batches WHERE batch_id='bbbb000000000001'`);
    expect(b.rows[0].status).toBe("failed");
    const ev = await adminClient.query(
      `SELECT to_state FROM print_events WHERE cert_id='MVSTUCK' AND reason='stuck_rendering_reconciled'`
    );
    expect(ev.rows[0].to_state).toBe("needs_printing");
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
