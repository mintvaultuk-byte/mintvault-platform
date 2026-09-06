import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyMigrations, listMigrationFiles } from "../scripts/db/migrate";
import {
  ObjectWriteAbandonError,
  ObjectWriteCoordinator,
  readObjectWriteSnapshot,
  sha256Hex,
  type ObjectInspection,
  type ObjectStoreName,
  type ObjectStorePort,
  type ObjectWriteInput,
  type ObjectWriteTransactionRunner,
} from "../server/lib/object-write-coordinator";
import { finalizePartnerCardImageObjectWrite } from "../server/partner/submission-service";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";
const LOCATION = "33333333-3333-3333-3333-333333333333";
const USER = "44444444-4444-4444-4444-444444444444";
const SUBMISSION = "55555555-5555-5555-5555-555555555555";
const CARD = "66666666-6666-6666-6666-666666666666";

const migration = (filename: string) => {
  const found = listMigrationFiles().find((candidate) => candidate.filename === filename);
  if (!found) throw new Error(`${filename} is missing from the production migration runner`);
  return found;
};

class MemoryStore implements ObjectStorePort {
  readonly objects = new Map<string, Buffer>();
  afterPut: (() => Promise<void>) | null = null;

  private identity(store: ObjectStoreName, key: string): string {
    return `${store}:${key}`;
  }

  async inspect(store: ObjectStoreName, objectKey: string): Promise<ObjectInspection> {
    const body = this.objects.get(this.identity(store, objectKey));
    return body ? { exists: true, byteLength: body.length, sha256: sha256Hex(body) } : { exists: false };
  }

  async putCreateOnly(input: { store: ObjectStoreName; objectKey: string; body: Buffer }): Promise<void> {
    const identity = this.identity(input.store, input.objectKey);
    if (this.objects.has(identity)) throw new Error("conditional create collision");
    this.objects.set(identity, Buffer.from(input.body));
    await this.afterPut?.();
  }

  async deleteR2(objectKey: string): Promise<void> {
    this.objects.delete(this.identity("R2", objectKey));
  }
}

describe("Partner card image durable object publication", () => {
  let cluster: DisposablePostgres17;
  let admin: pg.Pool;
  let partner: pg.Pool;
  let store: MemoryStore;

  beforeAll(async () => {
    cluster = await startPostgres17("partner-card-image-object-write");
    admin = new pg.Pool({ connectionString: cluster.url, max: 8 });
    await admin.query(`
      CREATE ROLE partner_runtime LOGIN PASSWORD 'partner-test' NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE partner_organisations (id uuid PRIMARY KEY);
      CREATE TABLE certificates (id serial PRIMARY KEY);
      CREATE TABLE submissions (
        id serial PRIMARY KEY,
        tracking_number text NOT NULL UNIQUE,
        status text NOT NULL,
        status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
        on_receipt_photo_urls text,
        received_at timestamptz,
        deleted_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE audit_log (
        id serial PRIMARY KEY,
        entity_type text NOT NULL,
        entity_id text NOT NULL,
        action text NOT NULL,
        admin_user text,
        details jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION partner_current_tenant()
      RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
        SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid
      $fn$;
    `);
    await applyMigrations(admin, [
      migration("0121_main_runtime_role_authority.sql"),
      migration("0122_object_write_intent_reconciliation.sql"),
    ]);
    await admin.query(`
      CREATE TABLE partner_submissions (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES partner_organisations(id),
        location_id uuid NOT NULL,
        status text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE partner_submission_cards (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES partner_organisations(id),
        submission_id uuid NOT NULL REFERENCES partner_submissions(id),
        front_image_key text,
        back_image_key text,
        removed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE partner_submission_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        submission_id uuid NOT NULL,
        actor_user_id uuid,
        event_type text NOT NULL,
        from_status text,
        to_status text,
        reason text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE partner_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        location_id uuid,
        actor_user_id uuid,
        device_id uuid,
        action text NOT NULL,
        record_type text,
        record_id text,
        before_value jsonb,
        after_value jsonb,
        ip inet,
        session_id uuid,
        reason text,
        correlation_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE partner_submissions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE partner_submissions FORCE ROW LEVEL SECURITY;
      ALTER TABLE partner_submission_cards ENABLE ROW LEVEL SECURITY;
      ALTER TABLE partner_submission_cards FORCE ROW LEVEL SECURITY;
      ALTER TABLE partner_submission_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE partner_submission_events FORCE ROW LEVEL SECURITY;
      ALTER TABLE partner_audit_events ENABLE ROW LEVEL SECURITY;
      ALTER TABLE partner_audit_events FORCE ROW LEVEL SECURITY;
      CREATE POLICY partner_submissions_tenant ON partner_submissions
        TO partner_runtime USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());
      CREATE POLICY partner_submission_cards_tenant ON partner_submission_cards
        TO partner_runtime USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());
      CREATE POLICY partner_submission_events_tenant ON partner_submission_events
        TO partner_runtime USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());
      CREATE POLICY partner_audit_events_tenant ON partner_audit_events
        TO partner_runtime USING (tenant_id=partner_current_tenant()) WITH CHECK (tenant_id=partner_current_tenant());
      GRANT USAGE ON SCHEMA public TO partner_runtime;
      GRANT SELECT,UPDATE ON partner_submissions,partner_submission_cards TO partner_runtime;
      GRANT SELECT,INSERT ON partner_submission_events,partner_audit_events TO partner_runtime;
      INSERT INTO partner_organisations(id) VALUES
        ('${TENANT}'),('${OTHER_TENANT}');
    `);
    const url = new URL(cluster.url);
    url.username = "partner_runtime";
    url.password = "partner-test";
    partner = new pg.Pool({ connectionString: url.toString(), max: 8 });
  }, 60_000);

  afterAll(async () => {
    await partner?.end().catch(() => {});
    await admin?.end().catch(() => {});
    await cluster?.stop();
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE partner_audit_events,partner_submission_events,object_write_items,certificates,object_write_operations,partner_submission_cards,partner_submissions"
    );
    await admin.query(
      `INSERT INTO partner_submissions(id,tenant_id,location_id,status) VALUES ($1,$2,$3,'draft')`,
      [SUBMISSION, TENANT, LOCATION]
    );
    await admin.query(
      `INSERT INTO partner_submission_cards(id,tenant_id,submission_id) VALUES ($1,$2,$3)`,
      [CARD, TENANT, SUBMISSION]
    );
    store = new MemoryStore();
  });

  function runner(tenantId = TENANT): ObjectWriteTransactionRunner {
    return {
      async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
        const client = await partner.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
          const result = await operation(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
    };
  }

  function request(suffix: string): ObjectWriteInput {
    const body = Buffer.from(`partner-card-${suffix}`);
    return {
      tenantId: TENANT,
      idempotencyKey: `partner-card-image:${sha256Hex(`browser-${suffix}`)}`,
      operationKind: "PARTNER_CARD_IMAGE",
      aggregateType: "partner_submission_card",
      aggregateId: CARD,
      actorId: USER,
      expectedState: { beforeKey: null, submissionStatus: "draft" },
      intentPayload: {
        tenantId: TENANT,
        submissionId: SUBMISSION,
        cardId: CARD,
        side: "front",
        beforeKey: null,
        locationId: LOCATION,
        actorUserId: USER,
        sessionId: "77777777-7777-7777-7777-777777777777",
        mime: "image/jpeg",
        size: body.length,
      },
      items: [
        {
          store: "R2",
          logicalSlot: "front",
          objectKey: `partner-submissions/${TENANT}/${SUBMISSION}/${CARD}/revisions/${suffix}/front.jpg`,
          priorObjectKey: null,
          body,
          contentType: "image/jpeg",
          objectClass: "CANONICAL",
        },
      ],
    };
  }

  it("publishes the pointer, object descriptor, event, audit and COMMITTED state atomically under Partner RLS", async () => {
    const transactionRunner = runner();
    const coordinator = new ObjectWriteCoordinator(transactionRunner, store, "partner-test", 2_000);
    const input = request("success");
    const result = await coordinator.execute(input, finalizePartnerCardImageObjectWrite);

    expect(result.result).toEqual(
      expect.objectContaining({
        operationId: result.operationId,
        submissionId: SUBMISSION,
        cardId: CARD,
        logicalSlot: "front",
        key: input.items[0].objectKey,
        sha256: sha256Hex(input.items[0].body),
        byteLength: input.items[0].body.length,
        contentType: "image/jpeg",
      })
    );
    expect((await admin.query("SELECT front_image_key FROM partner_submission_cards")).rows[0].front_image_key).toBe(
      input.items[0].objectKey
    );
    const event = (await admin.query("SELECT metadata FROM partner_submission_events")).rows[0];
    expect(event.metadata.object.operationId).toBe(result.operationId);
    const audit = (await admin.query("SELECT correlation_id,after_value FROM partner_audit_events")).rows[0];
    expect(audit.correlation_id).toBe(result.operationId);
    expect(audit.after_value.object.key).toBe(input.items[0].objectKey);
    expect((await admin.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("COMMITTED");

    const invisible = await runner(OTHER_TENANT).transaction((client) =>
      readObjectWriteSnapshot(client, OTHER_TENANT, input.idempotencyKey)
    );
    expect(invisible).toBeNull();
  });

  it("replays from the stored manifest after the first commit changed the card pointer", async () => {
    const transactionRunner = runner();
    const coordinator = new ObjectWriteCoordinator(transactionRunner, store, "partner-test", 2_000);
    const input = request("replay");
    const first = await coordinator.execute(input, finalizePartnerCardImageObjectWrite);
    const snapshot = await transactionRunner.transaction((client) =>
      readObjectWriteSnapshot(client, TENANT, input.idempotencyKey)
    );
    expect(snapshot).not.toBeNull();
    const replay = await coordinator.execute(
      {
        tenantId: snapshot!.tenantId,
        idempotencyKey: snapshot!.idempotencyKey,
        operationKind: snapshot!.operationKind,
        aggregateType: snapshot!.aggregateType,
        aggregateId: snapshot!.aggregateId,
        actorId: snapshot!.actorId,
        expectedState: snapshot!.expectedState,
        intentPayload: snapshot!.intentPayload,
        items: snapshot!.items.map((item) => ({
          store: item.store,
          logicalSlot: item.logicalSlot,
          objectKey: item.objectKey,
          priorObjectKey: item.priorObjectKey,
          body: input.items[0].body,
          contentType: item.contentType,
          objectClass: item.objectClass,
          required: item.required,
          retentionDays: item.retentionDays ?? undefined,
        })),
      },
      finalizePartnerCardImageObjectWrite
    );
    expect(replay).toEqual(expect.objectContaining({ operationId: first.operationId, replayed: true }));
    expect((await admin.query("SELECT count(*)::int AS count FROM partner_submission_events")).rows[0].count).toBe(1);
    expect((await admin.query("SELECT count(*)::int AS count FROM partner_audit_events")).rows[0].count).toBe(1);
  });

  it("leaves a verified operation reconcilable and rolls back publication when the pointer CAS loses a race", async () => {
    const input = request("stale");
    store.afterPut = async () => {
      await admin.query("UPDATE partner_submission_cards SET front_image_key='racer/front.jpg' WHERE id=$1", [CARD]);
    };
    const coordinator = new ObjectWriteCoordinator(runner(), store, "partner-test", 2_000);
    await expect(coordinator.execute(input, finalizePartnerCardImageObjectWrite)).rejects.toBeInstanceOf(
      ObjectWriteAbandonError
    );
    expect((await admin.query("SELECT front_image_key FROM partner_submission_cards")).rows[0].front_image_key).toBe(
      "racer/front.jpg"
    );
    expect((await admin.query("SELECT count(*)::int AS count FROM partner_submission_events")).rows[0].count).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS count FROM partner_audit_events")).rows[0].count).toBe(0);
    expect((await admin.query("SELECT state FROM object_write_operations")).rows[0].state).toBe("ABANDONED");
    expect((await admin.query("SELECT cleanup_state FROM object_write_items")).rows[0].cleanup_state).toBe("PENDING");
  });
});
