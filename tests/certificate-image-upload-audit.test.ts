/**
 * M-2 · `POST /api/admin/certificates/:id/upload-images` must leave truthful,
 * durable evidence of every image change it commits.
 *
 * WHAT WENT WRONG
 * This is the route the real grading UI uploads through. It wrote
 * `front_image_path`, `back_image_path`, every `grading_*` capture column,
 * `image_quality_checks` and `crop_geometry` through a series of INDEPENDENT
 * auto-committing raw UPDATEs, and wrote ZERO audit rows. A customer's card
 * images could be replaced with no record of who did it or when, and a failure
 * partway through left the row half-updated. PR #260 made the metadata route
 * truthful and explicitly flagged this one as still unaudited.
 *
 * WHAT THESE TESTS DRIVE
 * The durable half — `persistImageUploadAudited` — against a REAL disposable
 * PostgreSQL 17 cluster, with real transactions, real rollback and real audit
 * rows. Only object storage is mocked, because R2 cannot participate in a
 * database transaction and that is precisely the boundary under test.
 *
 * The sharp/deskew/crop pipeline is deliberately NOT exercised: it is untouched
 * by this change, and running it would make these assertions slow and noisy
 * without proving anything about transactions or audit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { startPostgres17, type DisposablePostgres17 } from "./helpers/postgres17-cluster";

const runtime = vi.hoisted(() => ({ db: null as unknown, pool: null as unknown }));
vi.mock("../server/db", () => ({
  get db() {
    if (!runtime.db) throw new Error("Image-upload audit test database used before setup");
    return runtime.db;
  },
  get pool() {
    return runtime.pool;
  },
}));

/** R2 is stubbed, but every delete is RECORDED — compensation is under test. */
const r2 = vi.hoisted(() => ({ deletes: [] as string[], failDelete: new Set<string>() }));
vi.mock("../server/r2", () => ({
  deleteFromR2: vi.fn(async (k: string) => {
    if (r2.failDelete.has(k)) throw new Error("R2 delete failed");
    r2.deletes.push(k);
  }),
  uploadToR2: vi.fn(async (k: string) => k),
  getR2SignedUrl: vi.fn(async () => "https://example.invalid/signed"),
}));

let cluster: DisposablePostgres17;
let pool: pg.Pool;
let persist: typeof import("../server/lib/certificate-image-persistence").persistImageUploadAudited;
let AUDIT_ACTION: string;
let VARIANT_ACTION: string;
let FAILURE_ACTION: string;

const CERT_ID = "MV1";
const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

beforeAll(async () => {
  cluster = await startPostgres17("certificate-image-upload-audit");
  pool = new pg.Pool({ connectionString: cluster.url, max: 4 });
  runtime.pool = pool;
  runtime.db = drizzle(pool);

  await q(`
    CREATE TABLE certificates (
      id SERIAL PRIMARY KEY,
      certificate_number TEXT NOT NULL,
      front_image_path TEXT,
      back_image_path TEXT,
      grading_front_original TEXT,
      grading_front_cropped TEXT,
      grading_front_display TEXT,
      grading_back_original TEXT,
      grading_back_cropped TEXT,
      grading_back_display TEXT,
      grading_angled_original TEXT,
      grading_angled_cropped TEXT,
      grading_closeup_original TEXT,
      grading_closeup_cropped TEXT,
      grading_front_greyscale TEXT,
      grading_front_highcontrast TEXT,
      grading_front_edgeenhanced TEXT,
      grading_front_inverted TEXT,
      grading_back_greyscale TEXT,
      grading_back_highcontrast TEXT,
      grading_back_edgeenhanced TEXT,
      grading_back_inverted TEXT,
      image_quality_checks JSONB,
      crop_geometry JSONB,
      grade NUMERIC,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await q(`
    CREATE TABLE audit_log (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      admin_user TEXT,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);

  const mod = await import("../server/lib/certificate-image-persistence");
  persist = mod.persistImageUploadAudited;
  AUDIT_ACTION = mod.IMAGE_UPLOAD_AUDIT_ACTION;
  VARIANT_ACTION = mod.IMAGE_VARIANTS_AUDIT_ACTION;
  FAILURE_ACTION = mod.IMAGE_UPLOAD_FAILURE_AUDIT_ACTION;
});

afterAll(async () => {
  await pool?.end();
  await cluster?.stop();
});

let certRowId: number;
beforeEach(async () => {
  r2.deletes.length = 0;
  r2.failDelete.clear();
  await q(`DELETE FROM audit_log`);
  await q(`DELETE FROM certificates`);
  const rows = await q(
    `INSERT INTO certificates (certificate_number, front_image_path, back_image_path, grade)
     VALUES ($1, $2, $3, 9.5) RETURNING id`,
    [CERT_ID, "images/MV1/front.jpg", null]
  );
  certRowId = rows[0].id;
});

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const obj = (key: string, column: string, body: string, preexisting = false) => ({
  key,
  column,
  sha256: sha(body),
  bytes: Buffer.byteLength(body),
  contentType: "image/jpeg",
  preexisting,
});

const readCert = async () => (await q(`SELECT * FROM certificates WHERE id = $1`, [certRowId]))[0];
const readAudits = async () => await q(`SELECT * FROM audit_log ORDER BY id`);

describe("M-2 · a committed image upload leaves exactly one truthful audit row", () => {
  it("1. a front-image upload creates ONE accurate audit event", async () => {
    const res = await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: {
        front_image_path: "images/MV1/front.jpg",
        grading_front_cropped: "grading/MV1/front_cropped.jpg",
      },
      uploadedObjects: [
        obj("images/MV1/front.jpg", "front_image_path", "NEW-FRONT", true),
        obj("grading/MV1/front_cropped.jpg", "grading_front_cropped", "NEW-FRONT"),
      ],
      actor: "admin@example.test",
    });
    expect(res.committed).toBe(true);

    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    const a = audits[0];
    expect(a.action).toBe(AUDIT_ACTION);
    expect(a.entity_type).toBe("certificate");
    expect(a.admin_user).toBe("admin@example.test");
    expect(a.created_at).toBeTruthy();
    // front_image_path did NOT move (same deterministic key); the grading column did.
    expect(a.details.changedFields).toEqual(["grading_front_cropped"]);
    expect((await readCert()).grading_front_cropped).toBe("grading/MV1/front_cropped.jpg");
  });

  it("2. a back-image upload creates ONE accurate audit event", async () => {
    await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { back_image_path: "images/MV1/back.jpg" },
      uploadedObjects: [obj("images/MV1/back.jpg", "back_image_path", "BACK")],
      actor: "admin@example.test",
    });
    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].details.changedFields).toEqual(["back_image_path"]);
    expect(audits[0].details.changes[0]).toMatchObject({
      field: "back_image_path",
      from: null,
      to: "images/MV1/back.jpg",
    });
    expect((await readCert()).back_image_path).toBe("images/MV1/back.jpg");
  });

  it("3. both images updated together are recorded in ONE row", async () => {
    await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: {
        front_image_path: "images/MV1/front2.jpg",
        back_image_path: "images/MV1/back.jpg",
        image_quality_checks: JSON.stringify({ front: { ok: true } }),
      },
      uploadedObjects: [
        obj("images/MV1/front2.jpg", "front_image_path", "F"),
        obj("images/MV1/back.jpg", "back_image_path", "B"),
      ],
      actor: "admin@example.test",
    });
    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    expect(new Set(audits[0].details.changedFields)).toEqual(
      new Set(["front_image_path", "back_image_path", "image_quality_checks"])
    );
    const cert = await readCert();
    expect(cert.front_image_path).toBe("images/MV1/front2.jpg");
    expect(cert.back_image_path).toBe("images/MV1/back.jpg");
  });

  it("4. SAME storage path + CHANGED content is still provable", async () => {
    // The whole reason a path-only audit was not enough: these keys are
    // deterministic, so a replacement moves no column value at all.
    const res = await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { front_image_path: "images/MV1/front.jpg" },
      uploadedObjects: [obj("images/MV1/front.jpg", "front_image_path", "COMPLETELY-DIFFERENT-BYTES", true)],
      actor: "admin@example.test",
    });
    expect(res.committed).toBe(true);
    expect(res.changedFields).toEqual([]); // no column moved …

    const audits = await readAudits();
    expect(audits, "a same-key replacement must STILL be audited").toHaveLength(1);
    const uploaded = audits[0].details.uploadedObjects;
    expect(uploaded).toHaveLength(1);
    // … but the content identity proves the customer's image was replaced.
    expect(uploaded[0].pathChanged).toBe(false);
    expect(uploaded[0].sha256).toBe(sha("COMPLETELY-DIFFERENT-BYTES"));
    expect(uploaded[0].bytes).toBe(Buffer.byteLength("COMPLETELY-DIFFERENT-BYTES"));
    expect(uploaded[0].contentType).toBe("image/jpeg");
    expect(audits[0].details.changedFields).toEqual([]);
  });

  it("8. a request that commits nothing and uploads nothing audits nothing", async () => {
    const res = await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { front_image_path: "images/MV1/front.jpg" }, // identical to stored
      uploadedObjects: [],
      actor: "admin@example.test",
    });
    expect(res.committed).toBe(true);
    expect(res.changedFields).toEqual([]);
    expect(await readAudits()).toHaveLength(0);
  });

  it("8b. a no-op never fabricates changed-field entries", async () => {
    await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { front_image_path: "images/MV1/front.jpg" },
      uploadedObjects: [obj("images/MV1/front.jpg", "front_image_path", "SAME", true)],
      actor: "admin@example.test",
    });
    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].details.changes).toEqual([]);
    expect(audits[0].details.changedFields).toEqual([]);
  });

  it("10. the audit uses the CANONICAL certificate id, as the metadata route does", async () => {
    await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { back_image_path: "images/MV1/back.jpg" },
      uploadedObjects: [obj("images/MV1/back.jpg", "back_image_path", "B")],
      actor: "admin@example.test",
    });
    const a = (await readAudits())[0];
    expect(a.entity_id).toBe("MV1");
    expect(a.entity_id).not.toBe(String(certRowId));
    // The numeric row id is retained INSIDE details for continuity.
    expect(a.details.certificateId).toBe(certRowId);
    expect(a.details.certId).toBe("MV1");
  });

  it("records no signed URLs, credentials or PII — object KEYS only", async () => {
    await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { back_image_path: "images/MV1/back.jpg" },
      uploadedObjects: [obj("images/MV1/back.jpg", "back_image_path", "B")],
      actor: "admin@example.test",
    });
    const raw = JSON.stringify((await readAudits())[0].details);
    for (const forbidden of ["X-Amz-Signature", "Signature=", "https://", "AccessKey", "secret"]) {
      expect(raw, `audit must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("M-2 · the database write and its audit are atomic", () => {
  it("6/7. an unwritable audit rolls the column update BACK", async () => {
    const before = await readCert();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_img CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      const res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { back_image_path: "images/MV1/back.jpg" },
        uploadedObjects: [obj("images/MV1/back.jpg", "back_image_path", "B")],
        actor: "admin@example.test",
      });
      expect(res.committed, "must report failure, not success").toBe(false);

      const after = await readCert();
      expect(after.back_image_path, "no unaudited committed mutation").toBe(before.back_image_path);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_img`);
    }
  });

  it("5. a failed database write commits nothing and audits nothing", async () => {
    const before = await readCert();
    const res = await persist({
      id: 999999, // no such certificate
      certId: CERT_ID,
      updates: { back_image_path: "images/MV1/back.jpg" },
      uploadedObjects: [obj("images/MV1/back.jpg", "back_image_path", "B")],
      actor: "admin@example.test",
    });
    expect(res.committed).toBe(false);
    expect(await readAudits()).toHaveLength(0);
    expect((await readCert()).back_image_path).toBe(before.back_image_path);
  });

  it("9. nothing is ever audited as committed when the transaction failed", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_img2 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { grading_front_cropped: "grading/MV1/front_cropped.jpg" },
        uploadedObjects: [obj("grading/MV1/front_cropped.jpg", "grading_front_cropped", "X")],
        actor: "admin@example.test",
      });
      const rows = await q(`SELECT * FROM audit_log WHERE details->>'outcome' = 'committed'`);
      expect(rows).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_img2`);
    }
  });
});

describe("M-2 · compensation after a failed transaction", () => {
  it("removes objects this request CREATED", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_img3 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      const res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { grading_front_cropped: "grading/MV1/front_cropped.jpg" },
        uploadedObjects: [obj("grading/MV1/front_cropped.jpg", "grading_front_cropped", "X")],
        actor: "admin@example.test",
      });
      expect(res.committed).toBe(false);
      expect(res.orphansRemoved).toEqual(["grading/MV1/front_cropped.jpg"]);
      expect(r2.deletes).toEqual(["grading/MV1/front_cropped.jpg"]);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_img3`);
    }
  });

  it("NEVER deletes an object the last committed row still points at", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_img4 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      const res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { front_image_path: "images/MV1/front.jpg" },
        // preexisting: this key IS the committed front_image_path.
        uploadedObjects: [obj("images/MV1/front.jpg", "front_image_path", "NEW", true)],
        actor: "admin@example.test",
      });
      expect(res.committed).toBe(false);
      expect(res.orphansRemoved).toEqual([]);
      expect(r2.deletes, "deleting it would break the live certificate").toEqual([]);
      // The unrecoverable part is surfaced rather than swallowed.
      expect(res.overwrittenCommittedObjects).toEqual(["images/MV1/front.jpg"]);
      expect((await readCert()).front_image_path).toBe("images/MV1/front.jpg");
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_img4`);
    }
  });

  it("HIGH REGRESSION — a RE-uploaded grading key is never deleted", async () => {
    // The grading keys are deterministic, so re-shooting an angle uploads to the
    // SAME key the committed row already points at. An earlier revision of this
    // module decided orphan-eligibility from COLUMN_TO_CERT_KEY, which maps only
    // front/back image path, so every grading_* key looked like an orphan and a
    // failed transaction would have deleted the live object.
    await q(`UPDATE certificates SET grading_front_cropped = $1 WHERE id = $2`, [
      "grading/MV1/front_cropped.jpg",
      certRowId,
    ]);
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_img6 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      const res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { grading_front_cropped: "grading/MV1/front_cropped.jpg" },
        // preexisting:false is exactly what the real route computes for this
        // column — the module must NOT trust it as sole permission to delete.
        uploadedObjects: [obj("grading/MV1/front_cropped.jpg", "grading_front_cropped", "RESHOT")],
        actor: "admin@example.test",
      });
      expect(res.committed).toBe(false);
      expect(res.orphansRemoved).toEqual([]);
      expect(r2.deletes, "the committed grading object must survive").toEqual([]);
      expect(res.overwrittenCommittedObjects).toEqual(["grading/MV1/front_cropped.jpg"]);
      expect((await readCert()).grading_front_cropped).toBe("grading/MV1/front_cropped.jpg");
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_img6`);
    }
  });

  it("a genuinely NEW key is still cleaned up (the fix is not over-broad)", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_img7 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      const res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { grading_closeup_cropped: "grading/MV1/closeup_cropped.jpg" },
        uploadedObjects: [obj("grading/MV1/closeup_cropped.jpg", "grading_closeup_cropped", "NEW")],
        actor: "admin@example.test",
      });
      expect(res.committed).toBe(false);
      expect(res.orphansRemoved).toEqual(["grading/MV1/closeup_cropped.jpg"]);
      expect(r2.deletes).toEqual(["grading/MV1/closeup_cropped.jpg"]);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_img7`);
    }
  });

  it("reports cleanup failure truthfully instead of hiding it", async () => {
    r2.failDelete.add("grading/MV1/back_cropped.jpg");
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_img5 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      const res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { grading_back_cropped: "grading/MV1/back_cropped.jpg" },
        uploadedObjects: [obj("grading/MV1/back_cropped.jpg", "grading_back_cropped", "X")],
        actor: "admin@example.test",
      });
      expect(res.committed).toBe(false);
      expect(res.orphansRemoved).toEqual([]);
      expect(res.orphanCleanupFailed).toEqual(["grading/MV1/back_cropped.jpg"]);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_img5`);
    }
  });

  it("a SUCCESSFUL commit deletes nothing at all", async () => {
    await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { grading_back_cropped: "grading/MV1/back_cropped.jpg" },
      uploadedObjects: [obj("grading/MV1/back_cropped.jpg", "grading_back_cropped", "X")],
      actor: "admin@example.test",
    });
    expect(r2.deletes).toEqual([]);
  });
});

describe("M-2 · only allowlisted columns can ever be written", () => {
  it("a non-allowlisted key is dropped, never interpolated into SQL", async () => {
    const res = await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: {
        back_image_path: "images/MV1/back.jpg",
        // Would be a grading-owned write, and an identifier-injection vector.
        'grade" = 1, "front_image_path': "pwned",
        grade: "1",
      },
      uploadedObjects: [obj("images/MV1/back.jpg", "back_image_path", "B")],
      actor: "admin@example.test",
    });
    expect(res.committed).toBe(true);
    const cert = await readCert();
    expect(cert.grade, "the ownership boundary holds — grade is untouched").toBe("9.5");
    expect(cert.front_image_path).toBe("images/MV1/front.jpg");
    expect(res.changedFields).toEqual(["back_image_path"]);
  });

  it("jsonb columns round-trip as documents, not strings", async () => {
    await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { image_quality_checks: JSON.stringify({ front: { blurScore: 12 } }) },
      uploadedObjects: [],
      actor: "admin@example.test",
    });
    expect((await readCert()).image_quality_checks).toEqual({ front: { blurScore: 12 } });
  });
});

describe("M-2 · the background variant pass is audited too", () => {
  it("variant columns commit with their own distinguishable audit action", async () => {
    const res = await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: {
        grading_front_greyscale: "grading/MV1/front_greyscale.jpg",
        grading_front_inverted: "grading/MV1/front_inverted.jpg",
      },
      uploadedObjects: [
        obj("grading/MV1/front_greyscale.jpg", "grading_front_greyscale", "G"),
        obj("grading/MV1/front_inverted.jpg", "grading_front_inverted", "I"),
      ],
      actor: "admin@example.test",
      action: VARIANT_ACTION,
    });
    expect(res.committed).toBe(true);

    const audits = await readAudits();
    expect(audits).toHaveLength(1);
    // Distinct from the operator-facing upload event, so the two cannot be
    // confused when reading the trail.
    expect(audits[0].action).toBe(VARIANT_ACTION);
    expect(audits[0].action).not.toBe(AUDIT_ACTION);
    expect(audits[0].entity_id).toBe("MV1");
    expect(new Set(audits[0].details.changedFields)).toEqual(
      new Set(["grading_front_greyscale", "grading_front_inverted"])
    );
    const cert = await readCert();
    expect(cert.grading_front_greyscale).toBe("grading/MV1/front_greyscale.jpg");
  });

  it("a failed variant persist commits nothing", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT block_var CHECK (action <> '${VARIANT_ACTION}')`);
    try {
      const res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { grading_back_greyscale: "grading/MV1/back_greyscale.jpg" },
        uploadedObjects: [obj("grading/MV1/back_greyscale.jpg", "grading_back_greyscale", "G")],
        actor: "admin@example.test",
        action: VARIANT_ACTION,
      });
      expect(res.committed).toBe(false);
      expect((await readCert()).grading_back_greyscale).toBeNull();
      expect(await readAudits()).toHaveLength(0);
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT block_var`);
    }
  });
});

/**
 * M-3 (hostile review of PR #262) · the ONE unrecoverable outcome must leave a
 * durable record.
 *
 * WHAT WENT WRONG
 * R2 keys here are deterministic, so a re-upload replaces the BYTES at a key the
 * committed row already points at. Objects are written before the transaction
 * and cannot be rolled back, so when the transaction then fails the previous
 * content is gone for good. Compensation correctly refuses to DELETE such an
 * object — the committed row still references it — but the only evidence that a
 * customer's card image had been replaced was a `console.error`, which is no
 * evidence at all once the log rotates.
 *
 * The failure record is deliberately narrow: it is written ONLY when a committed
 * object was actually overwritten. Ordinary orphan cleanup overwrote nothing and
 * left committed state untouched; auditing that would train readers to ignore
 * the event.
 */
describe("M-3 · an unrecoverable overwrite leaves a durable failure record", () => {
  const failureRows = async () => (await readAudits()).filter((a: any) => a.action === FAILURE_ACTION);

  it("an overwritten COMMITTED key + a failed transaction writes exactly one failure event", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT m3_block1 CHECK (action <> '${AUDIT_ACTION}')`);
    let res: any;
    try {
      res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { front_image_path: "images/MV1/front.jpg" },
        uploadedObjects: [obj("images/MV1/front.jpg", "front_image_path", "REPLACEMENT-BYTES", true)],
        actor: "admin@example.test",
      });
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m3_block1`);
    }

    expect(res.committed).toBe(false);
    expect(res.failureAuditRecorded).toBe(true);
    // The object itself is untouched — the committed row still points at it.
    expect(r2.deletes).toEqual([]);

    const rows = await failureRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.entity_type).toBe("certificate");
    expect(row.entity_id).toBe("MV1");
    expect(row.admin_user).toBe("admin@example.test");
    expect(row.created_at).toBeTruthy();
    expect(row.details.overwrittenCommittedObjects).toEqual([
      { key: "images/MV1/front.jpg", column: "front_image_path", side: "front", bytes: "REPLACEMENT-BYTES".length },
    ]);
    expect(row.details.sides).toEqual(["front"]);
    expect(row.details.overwrittenCommittedObjectCount).toBe(1);
  });

  it("the event states plainly that the database mutation did NOT commit", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT m3_block2 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { front_image_path: "images/MV1/front.jpg" },
        uploadedObjects: [obj("images/MV1/front.jpg", "front_image_path", "X", true)],
        actor: "admin@example.test",
      });
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m3_block2`);
    }
    const d = (await failureRows())[0].details;
    // No reader may mistake this for a successful upload…
    expect(d.committed).toBe(false);
    expect(d.databaseMutationCommitted).toBe(false);
    expect(d.outcome).toBe("not_committed");
    expect(d.outcome).not.toBe("committed");
    // …and the R2/Postgres boundary is stated, not dressed up as atomicity.
    expect(String(d.note)).toMatch(/cannot be rolled back/i);
    expect(String(d.note)).toMatch(/did not commit/i);
    // The certificate really is unchanged.
    expect((await readCert()).front_image_path).toBe("images/MV1/front.jpg");
  });

  it("RECOVERABLE orphan cleanup writes NO failure event", async () => {
    // A brand-new key this request created and then deleted overwrote nothing.
    await q(`ALTER TABLE audit_log ADD CONSTRAINT m3_block3 CHECK (action <> '${AUDIT_ACTION}')`);
    let res: any;
    try {
      res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { grading_closeup_cropped: "grading/MV1/closeup_cropped.jpg" },
        uploadedObjects: [obj("grading/MV1/closeup_cropped.jpg", "grading_closeup_cropped", "NEW")],
        actor: "admin@example.test",
      });
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m3_block3`);
    }
    expect(res.committed).toBe(false);
    expect(res.orphansRemoved).toEqual(["grading/MV1/closeup_cropped.jpg"]);
    expect(res.overwrittenCommittedObjects).toEqual([]);
    expect(res.failureAuditRecorded).toBe(false);
    expect(await failureRows(), "recoverable cleanup must not raise a failure event").toHaveLength(0);
  });

  it("a SUCCESSFUL commit writes no failure event", async () => {
    const res = await persist({
      id: certRowId,
      certId: CERT_ID,
      updates: { back_image_path: "images/MV1/back.jpg" },
      uploadedObjects: [obj("images/MV1/back.jpg", "back_image_path", "B")],
      actor: "admin@example.test",
    });
    expect(res.committed).toBe(true);
    expect(res.failureAuditRecorded).toBe(false);
    expect(await failureRows()).toHaveLength(0);
  });

  it("an unwritable FAILURE audit preserves the original failure and deletes nothing", async () => {
    // Block BOTH the upload audit (causing the transaction to fail) and the
    // failure audit (so the secondary write fails too).
    await q(
      `ALTER TABLE audit_log ADD CONSTRAINT m3_block4 CHECK (action NOT IN ('${AUDIT_ACTION}', '${FAILURE_ACTION}'))`
    );
    let res: any;
    try {
      res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { front_image_path: "images/MV1/front.jpg" },
        uploadedObjects: [obj("images/MV1/front.jpg", "front_image_path", "X", true)],
        actor: "admin@example.test",
      });
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m3_block4`);
    }
    // The ORIGINAL failure still stands — it is never masked or upgraded.
    expect(res.committed).toBe(false);
    expect(res.failureAuditRecorded).toBe(false);
    // It did not throw: the caller still gets to return its 500.
    expect(res.overwrittenCommittedObjects).toEqual(["images/MV1/front.jpg"]);
    // And above all, no committed object was deleted.
    expect(r2.deletes).toEqual([]);
    expect((await readCert()).front_image_path).toBe("images/MV1/front.jpg");
    expect(await readAudits()).toHaveLength(0);
  });

  it("records orphan-cleanup failure alongside the overwrite, truthfully", async () => {
    r2.failDelete.add("grading/MV1/angled_cropped.jpg");
    await q(`ALTER TABLE audit_log ADD CONSTRAINT m3_block5 CHECK (action <> '${AUDIT_ACTION}')`);
    let res: any;
    try {
      res = await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: {
          front_image_path: "images/MV1/front.jpg",
          grading_angled_cropped: "grading/MV1/angled_cropped.jpg",
        },
        uploadedObjects: [
          obj("images/MV1/front.jpg", "front_image_path", "X", true),
          obj("grading/MV1/angled_cropped.jpg", "grading_angled_cropped", "NEW"),
        ],
        actor: "admin@example.test",
      });
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m3_block5`);
    }
    expect(res.committed).toBe(false);
    expect(res.orphanCleanupFailed).toEqual(["grading/MV1/angled_cropped.jpg"]);
    const d = (await failureRows())[0].details;
    expect(d.orphanCleanupFailedCount).toBe(1);
    expect(d.orphanCleanupFailedKeys).toEqual(["grading/MV1/angled_cropped.jpg"]);
    expect(d.orphansRemovedCount).toBe(0);
  });

  it("carries NO signed URL, credential, secret, header or stack trace", async () => {
    await q(`ALTER TABLE audit_log ADD CONSTRAINT m3_block6 CHECK (action <> '${AUDIT_ACTION}')`);
    try {
      await persist({
        id: certRowId,
        certId: CERT_ID,
        updates: { front_image_path: "images/MV1/front.jpg" },
        uploadedObjects: [obj("images/MV1/front.jpg", "front_image_path", "X", true)],
        actor: "admin@example.test",
      });
    } finally {
      await q(`ALTER TABLE audit_log DROP CONSTRAINT m3_block6`);
    }
    const raw = JSON.stringify((await failureRows())[0].details);
    for (const forbidden of [
      "X-Amz-Signature",
      "Signature=",
      "https://",
      "AccessKey",
      "secret",
      "authorization",
      "cookie",
      "at Object.",
      ".ts:",
    ]) {
      expect(raw, `failure audit must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // A coarse category is enough to triage; a raw message is not carried.
    expect((await failureRows())[0].details.failureCategory).toBeTruthy();
  });
});
