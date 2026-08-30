import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync } from "node:fs";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import {
  ObjectWriteAbandonError,
  createPoolTransactionRunner,
  sha256Hex,
  type ObjectInspection,
  type ObjectStoreName,
  type ObjectStorePort,
} from "../server/lib/object-write-coordinator";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const runtime = vi.hoisted(() => ({ db: null as unknown, pool: null as unknown }));
vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("Manual-image test database used before setup");
    return runtime.db;
  },
  get pool() {
    return runtime.pool;
  },
}));
vi.mock("../server/lib/object-write-store", () => ({ objectWriteStore: {} }));
vi.mock("../server/r2", () => ({ deleteFromR2: vi.fn() }));

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

describe("manual certificate-image durable publication", () => {
  let cluster: DisposablePostgres17;
  let pool: pg.Pool;
  let store: MemoryStore;
  let persistence: typeof import("../server/lib/certificate-image-persistence");

  beforeAll(async () => {
    cluster = await startPostgres17("manual-certificate-image-object-write");
    pool = new pg.Pool({ connectionString: cluster.url, max: 8 });
    runtime.pool = pool;
    runtime.db = drizzle(pool);
    await pool.query(`
      CREATE ROLE partner_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE partner_organisations (id uuid PRIMARY KEY);
      CREATE TABLE submissions (id integer PRIMARY KEY);
      CREATE TABLE certificates (
        id serial PRIMARY KEY,
        certificate_number text NOT NULL UNIQUE,
        deleted_at timestamptz,
        front_image_path text,back_image_path text,
        grading_front_original text,grading_front_cropped text,grading_front_display text,
        grading_back_original text,grading_back_cropped text,grading_back_display text,
        grading_angled_original text,grading_angled_cropped text,
        grading_closeup_original text,grading_closeup_cropped text,
        grading_front_greyscale text,grading_front_highcontrast text,
        grading_front_edgeenhanced text,grading_front_inverted text,
        grading_back_greyscale text,grading_back_highcontrast text,
        grading_back_edgeenhanced text,grading_back_inverted text,
        image_quality_checks jsonb,crop_geometry jsonb,
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
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,entity_type text NOT NULL,entity_id text NOT NULL,
        action text NOT NULL,admin_user text,details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    persistence = await import("../server/lib/certificate-image-persistence");
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE audit_log,certificates,object_write_items,object_write_operations RESTART IDENTITY"
    );
    await pool.query(
      "INSERT INTO certificates(id,certificate_number,grading_front_original) VALUES (1,'MV-MANUAL-1','images/old-front.jpg')"
    );
    store = new MemoryStore();
  });

  const dependencies = () => ({
    runner: createPoolTransactionRunner(pool),
    store,
    workerId: "manual-image-test",
  });
  const request = (writeVersion: string, body = Buffer.from("manual-front-image")) => ({
    id: 1,
    certId: "MV-MANUAL-1",
    side: "front" as const,
    previousKey: "images/old-front.jpg",
    body,
    actor: "admin@mintvault.test",
    replaceExisting: true,
    originalFilename: "front.png",
    mimeReceived: "image/png",
    sizeInBytes: 1234,
    writeVersion,
  });

  it("commits the create-only object, pointer, request audit and operation as one outcome", async () => {
    const first = await persistence.persistManualCertificateImageObjectWrite(
      request("11111111-1111-4111-8111-111111111111"),
      dependencies()
    );
    expect(first.replayed).toBe(false);
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT grading_front_original FROM certificates WHERE id=1")).rows[0]).toEqual({
      grading_front_original: first.objectKey,
    });
    const audit = (
      await pool.query("SELECT action,admin_user,details FROM audit_log WHERE entity_id='MV-MANUAL-1'")
    ).rows[0];
    expect(audit).toMatchObject({
      action: "image_attached_manual",
      admin_user: "admin@mintvault.test",
      details: {
        objectWriteAtomic: true,
        requestMetadata: {
          side: "front",
          replace_existing: true,
          original_filename: "front.png",
          mime_received: "image/png",
          size_in_bytes: 1234,
        },
      },
    });
    expect((await pool.query("SELECT state FROM object_write_operations WHERE id=$1", [first.operationId])).rows[0].state)
      .toBe("COMMITTED");

    const replay = await persistence.persistManualCertificateImageObjectWrite(
      request("11111111-1111-4111-8111-111111111111"),
      dependencies()
    );
    expect(replay).toEqual({ ...first, replayed: true });
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(1);
  });

  it("recovers after a post-PUT audit failure without a second object write", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_manual_image_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action='image_attached_manual' THEN RAISE EXCEPTION 'injected manual audit failure'; END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER reject_manual_image_audit
        BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_manual_image_audit()
    `);
    const input = request("22222222-2222-4222-8222-222222222222", Buffer.from("retry-manual-image"));
    await expect(persistence.persistManualCertificateImageObjectWrite(input, dependencies())).rejects.toThrow(
      /injected manual audit failure/i
    );
    expect(store.objects.size).toBe(1);
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT grading_front_original FROM certificates WHERE id=1")).rows[0]
      .grading_front_original).toBe("images/old-front.jpg");
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe(
      "RECONCILIATION_REQUIRED"
    );

    await pool.query("DROP TRIGGER reject_manual_image_audit ON audit_log");
    const recovered = await persistence.persistManualCertificateImageObjectWrite(input, dependencies());
    expect(recovered.replayed).toBe(false);
    expect(store.putCalls).toBe(1);
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("COMMITTED");
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(1);
  });

  it("lets exactly one concurrent replacement win and abandons the stale contender", async () => {
    const outcomes = await Promise.allSettled([
      persistence.persistManualCertificateImageObjectWrite(
        request("33333333-3333-4333-8333-333333333333", Buffer.from("concurrent-a")),
        dependencies()
      ),
      persistence.persistManualCertificateImageObjectWrite(
        request("44444444-4444-4444-8444-444444444444", Buffer.from("concurrent-b")),
        dependencies()
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(ObjectWriteAbandonError);
    expect(
      (await pool.query("SELECT state FROM object_write_operations ORDER BY created_at,id")).rows.map(
        (row) => row.state
      )
    ).toEqual(expect.arrayContaining(["COMMITTED", "ABANDONED"]));
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(1);
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

  it("abandons publication when the certificate was deleted after route preflight", async () => {
    await pool.query("UPDATE certificates SET deleted_at=now() WHERE id=1");
    await expect(
      persistence.persistManualCertificateImageObjectWrite(
        request("55555555-5555-4555-8555-555555555555", Buffer.from("deleted-certificate-image")),
        dependencies()
      )
    ).rejects.toBeInstanceOf(ObjectWriteAbandonError);
    expect((await pool.query("SELECT grading_front_original FROM certificates WHERE id=1")).rows[0]
      .grading_front_original).toBe("images/old-front.jpg");
    expect((await pool.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("ABANDONED");
    expect((await pool.query("SELECT cleanup_state FROM object_write_items")).rows[0].cleanup_state).toBe("PENDING");
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(0);
  });

  it("is the publication authority wired by the real manual-image HTTP route", () => {
    const routeSource = readFileSync("server/routes.ts", "utf8");
    const route = routeSource.slice(
      routeSource.indexOf('"/api/admin/certs/:certId/image"'),
      routeSource.indexOf('// DELETE — soft-delete only', routeSource.indexOf('"/api/admin/certs/:certId/image"'))
    );
    expect(route).toContain("persistManualCertificateImageObjectWrite");
    expect(route).not.toContain("uploadToR2(");
  });
});
