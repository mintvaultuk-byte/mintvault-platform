import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import {
  createPoolTransactionRunner,
  sha256Hex,
  type ObjectInspection,
  type ObjectStoreName,
  type ObjectStorePort,
} from "../server/lib/object-write-coordinator";
import { persistScannerEvidenceCapture } from "../server/lib/scanner-evidence-persistence";
import type { ScannerEvidenceInspection } from "../server/lib/image-evidence";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const SESSION = "11111111-1111-4111-8111-111111111111";
const STATION = "22222222-2222-4222-8222-222222222222";

const migration = (filename: string) => {
  const found = listMigrationFiles().find((candidate) => candidate.filename === filename);
  if (!found) throw new Error(`${filename} is missing from the production migration runner`);
  return found;
};

class MemoryStore implements ObjectStorePort {
  readonly objects = new Map<string, Buffer>();
  putCalls = 0;

  private identity(store: ObjectStoreName, objectKey: string): string {
    return `${store}:${objectKey}`;
  }

  async inspect(store: ObjectStoreName, objectKey: string): Promise<ObjectInspection> {
    const body = this.objects.get(this.identity(store, objectKey));
    return body ? { exists: true, byteLength: body.length, sha256: sha256Hex(body) } : { exists: false };
  }

  async putCreateOnly(input: { store: ObjectStoreName; objectKey: string; body: Buffer }): Promise<void> {
    this.putCalls += 1;
    const identity = this.identity(input.store, input.objectKey);
    if (this.objects.has(identity)) throw new Error("conditional create collision");
    this.objects.set(identity, Buffer.from(input.body));
  }

  async deleteR2(objectKey: string): Promise<void> {
    this.objects.delete(this.identity("R2", objectKey));
  }
}

function inspection(body: Buffer): ScannerEvidenceInspection {
  return {
    evidenceClass: "NEW_IMMUTABLE_MASTER",
    sha256: sha256Hex(body),
    byteLength: body.length,
    format: "tiff",
    mimeType: "image/tiff",
    extension: "tif",
    width: 1200,
    height: 1600,
    bitDepth: 16,
    dpi: 1200,
    channels: 3,
    hasAlpha: false,
    colourSpace: "srgb",
    hasIccProfile: true,
  };
}

describe("scanner immutable-master durable object publication", () => {
  let cluster: DisposablePostgres17;
  let pool: pg.Pool;
  let store: MemoryStore;
  let applicationPool: pg.Pool | null = null;
  const originalDatabaseUrl = process.env.MINTVAULT_DATABASE_URL;

  beforeAll(async () => {
    cluster = await startPostgres17("scanner-evidence-object-write");
    process.env.MINTVAULT_DATABASE_URL = cluster.url;
    pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
    await pool.query(`
      CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE partner_organisations (id uuid PRIMARY KEY);
      CREATE TABLE submissions (id integer PRIMARY KEY);
      CREATE TABLE certificates (
        id serial PRIMARY KEY,
        certificate_number text NOT NULL UNIQUE,
        deleted_at timestamptz,
        archived_to_b2_at timestamptz,
        raw_uploaded boolean NOT NULL DEFAULT false,
        scan_status text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION partner_current_tenant()
      RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
        SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid
      $fn$;
    `);
    await applyMigrations(pool, [
      migration("0121_main_runtime_role_authority.sql"),
      migration("0122_object_write_intent_reconciliation.sql"),
    ]);
    await pool.query(`
      CREATE TABLE certificate_image_evidence (
        id serial PRIMARY KEY,
        certificate_id integer NOT NULL REFERENCES certificates(id),
        side text NOT NULL,
        evidence_class text NOT NULL,
        evidence_version text NOT NULL,
        object_key text NOT NULL UNIQUE,
        sha256 char(64) NOT NULL,
        byte_length bigint NOT NULL,
        pixel_width integer NOT NULL,
        pixel_height integer NOT NULL,
        bit_depth integer,
        dpi integer,
        format text NOT NULL,
        capture_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_current boolean NOT NULL DEFAULT true,
        superseded_at timestamptz,
        superseded_by_id integer REFERENCES certificate_image_evidence(id),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX uq_scanner_evidence_current_side
        ON certificate_image_evidence(certificate_id,side) WHERE is_current;
      CREATE TABLE scanner_capture_sessions (
        id uuid PRIMARY KEY,
        certificate_id integer NOT NULL REFERENCES certificates(id),
        side text NOT NULL,
        station_id uuid,
        state text NOT NULL,
        captured_at timestamptz,
        failure_reason text
      );
      CREATE TABLE scanner_evidence_staging (
        id uuid PRIMARY KEY,
        capture_session_id uuid NOT NULL REFERENCES scanner_capture_sessions(id),
        object_key text NOT NULL,
        state text NOT NULL,
        accepted_at timestamptz,
        finalizing_at timestamptz,
        failure_reason text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE scanner_processing_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        certificate_id integer NOT NULL REFERENCES certificates(id),
        station_id uuid,
        job_kind text NOT NULL DEFAULT 'scanner_derivatives',
        state text NOT NULL DEFAULT 'queued',
        available_at timestamptz NOT NULL DEFAULT now(),
        rerun_requested boolean NOT NULL DEFAULT false,
        last_error text,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX uq_scanner_processing_active_certificate
        ON scanner_processing_jobs(certificate_id,job_kind) WHERE state IN ('queued','running','retry');
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        admin_user text,
        details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await applicationPool?.end().catch(() => {});
    await pool?.end().catch(() => {});
    await cluster?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.MINTVAULT_DATABASE_URL;
    else process.env.MINTVAULT_DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE audit_log,scanner_processing_jobs,scanner_evidence_staging,scanner_capture_sessions,
               certificate_image_evidence,certificates,object_write_items,object_write_operations
      RESTART IDENTITY
    `);
    await pool.query(
      `INSERT INTO certificates(id,certificate_number,archived_to_b2_at)
       VALUES (1,'MV-SCAN-1',NOW())`
    );
    await pool.query(
      `INSERT INTO scanner_capture_sessions(id,certificate_id,side,station_id,state)
       VALUES ($1,1,'front',$2,'capturing')`,
      [SESSION, STATION]
    );
    store = new MemoryStore();
  });

  function request(body: Buffer, sessionId = SESSION, allowRecapture = false) {
    return {
      certificateId: 1,
      side: "front" as const,
      body,
      inspection: inspection(body),
      allowRecapture,
      captureMetadata: {
        captureSessionId: sessionId,
        stationId: STATION,
        actorId: "scanner-operator",
        workstationId: "MV-STN-TEST",
        profileVersion: "mintvault-canon-lide-400-v3",
      },
    };
  }

  const dependencies = () => ({
    runner: createPoolTransactionRunner(pool),
    store,
    workerId: "scanner-evidence-test",
  });

  it("commits the verified object, evidence pointer, session, processing job, audit and operation atomically", async () => {
    const body = Buffer.from("scanner-front-master");
    const first = await persistScannerEvidenceCapture(request(body), dependencies());
    expect(first.replayed).toBe(false);
    expect(store.putCalls).toBe(1);

    const state = await pool.query(`
      SELECT c.raw_uploaded,c.scan_status,c.archived_to_b2_at,
             e.object_key,e.sha256,e.capture_metadata ->> 'objectWriteOperationId' AS evidence_operation,
             s.state AS session_state,
             o.state AS operation_state,i.verification_state,i.write_disposition
        FROM certificates c
        JOIN certificate_image_evidence e ON e.certificate_id=c.id AND e.is_current
        JOIN scanner_capture_sessions s ON s.certificate_id=c.id AND s.side=e.side
        JOIN object_write_operations o ON o.id=$1
        JOIN object_write_items i ON i.operation_id=o.id
       WHERE c.id=1`,
      [first.operationId]
    );
    expect(state.rows[0]).toMatchObject({
      raw_uploaded: true,
      scan_status: "processing",
      archived_to_b2_at: null,
      object_key: first.objectKey,
      sha256: sha256Hex(body),
      evidence_operation: first.operationId,
      session_state: "captured",
      operation_state: "COMMITTED",
      verification_state: "VERIFIED",
      write_disposition: "CREATED",
    });
    expect((await pool.query("SELECT count(*)::int AS n FROM scanner_processing_jobs")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(1);

    const replay = await persistScannerEvidenceCapture(request(body), dependencies());
    expect(replay).toEqual({ ...first, replayed: true });
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM certificate_image_evidence")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM scanner_processing_jobs")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(1);
  });

  it("recovers a verified object after the publication transaction fails, without duplicating domain rows", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_scanner_acceptance_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action='scanner_capture_accepted' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER reject_scanner_acceptance_audit
        BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_scanner_acceptance_audit()
    `);
    const body = Buffer.from("scanner-crash-recovery");
    await expect(persistScannerEvidenceCapture(request(body), dependencies())).rejects.toThrow(/injected audit failure/i);
    expect(store.objects.size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM certificate_image_evidence")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe(
      "RECONCILIATION_REQUIRED"
    );
    expect((await pool.query("SELECT state FROM scanner_capture_sessions WHERE id=$1", [SESSION])).rows[0].state).toBe(
      "capturing"
    );

    await pool.query("DROP TRIGGER reject_scanner_acceptance_audit ON audit_log");
    const recovered = await persistScannerEvidenceCapture(request(body), dependencies());
    expect(recovered.replayed).toBe(false);
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("COMMITTED");
    expect((await pool.query("SELECT count(*)::int AS n FROM certificate_image_evidence")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(1);
  });

  it("allows exactly one concurrent recapture from one prior revision and abandons the stale contender", async () => {
    await persistScannerEvidenceCapture(request(Buffer.from("scanner-original")), dependencies());
    const sessions = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ];
    await pool.query(
      `INSERT INTO scanner_capture_sessions(id,certificate_id,side,station_id,state)
       VALUES ($1,1,'front',$3,'capturing'),($2,1,'front',$3,'capturing')`,
      [sessions[0], sessions[1], STATION]
    );
    const outcomes = await Promise.allSettled([
      persistScannerEvidenceCapture(request(Buffer.from("scanner-recapture-a"), sessions[0], true), dependencies()),
      persistScannerEvidenceCapture(request(Buffer.from("scanner-recapture-b"), sessions[1], true), dependencies()),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const evidence = await pool.query(
      "SELECT id,is_current,superseded_by_id FROM certificate_image_evidence ORDER BY id"
    );
    expect(evidence.rows).toHaveLength(2);
    expect(evidence.rows.filter((row) => row.is_current)).toHaveLength(1);
    expect(evidence.rows[0].superseded_by_id).toBe(evidence.rows[1].id);
    const operationStates = (await pool.query("SELECT state FROM object_write_operations ORDER BY created_at,id")).rows.map(
      (row) => row.state
    );
    expect(operationStates.filter((state) => state === "COMMITTED")).toHaveLength(2);
    expect(operationStates.filter((state) => state === "ABANDONED")).toHaveLength(1);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM object_write_items item
            JOIN object_write_operations operation ON operation.id=item.operation_id
           WHERE operation.state='ABANDONED' AND item.cleanup_state='PENDING'`
        )
      ).rows[0].n
    ).toBe(1);
  });

  it("registers the scanner finalizer so the production required-kind registry is complete", async () => {
    const registry = await import("../server/lib/object-write-finalizer-registry");
    const builtIns = await import("../server/object-write-finalizers");
    registry.__resetObjectWriteFinalizersForTests();
    builtIns.__resetBuiltInObjectWriteFinalizersForTests();
    builtIns.registerBuiltInObjectWriteFinalizers();
    expect(registry.objectWriteFinalizerRegistryComplete()).toBe(true);
    expect(registry.resolveObjectWriteFinalizer("SCANNER_EVIDENCE_CAPTURE")?.finalize).toBe(
      (await import("../server/lib/scanner-evidence-persistence")).finalizeScannerEvidenceCaptureObjectWrite
    );
    applicationPool = (await import("../server/db")).pool;
  });
});
