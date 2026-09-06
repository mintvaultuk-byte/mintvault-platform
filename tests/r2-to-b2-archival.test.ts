import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand } from "@aws-sdk/client-s3";

const runtime = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
  r2Send: vi.fn(),
  inspectB2: vi.fn(),
  uploadB2: vi.fn(),
  extendB2: vi.fn(),
  r2: new Map<string, Buffer>(),
  b2: new Map<string, Buffer>(),
}));

vi.mock("../server/db", () => ({ db: { execute: runtime.execute, transaction: runtime.transaction } }));
vi.mock("../server/r2", () => ({ getR2Client: () => ({ send: runtime.r2Send }) }));
vi.mock("../server/b2", () => ({
  extendB2ComplianceRetention: runtime.extendB2,
  inspectB2ObjectIntegrity: runtime.inspectB2,
  uploadToB2: runtime.uploadB2,
}));

import { archiveStaleImages } from "../server/workers/r2-to-b2-archival";

const sha256 = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const candidate = { id: 7, certificate_number: "MV7", grade_approved_at: new Date("2025-01-01") };

function evidenceRow(body: Buffer) {
  const digest = sha256(body);
  return {
    id: 41,
    side: "front" as const,
    evidence_class: "NEW_IMMUTABLE_MASTER" as const,
    object_key: `evidence/masters/7/front/${digest}.tif`,
    sha256: digest,
    byte_length: String(body.length),
    working_object_key: null,
    working_sha256: null,
  };
}

function seedR2Transport(): void {
  runtime.r2Send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetObjectCommand) {
      const key = String(command.input.Key);
      const body = runtime.r2.get(key);
      if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return {
        Body: (async function* () {
          yield body;
        })(),
        ContentType: key.endsWith(".tif") ? "image/tiff" : "image/jpeg",
      };
    }
    throw new Error(`unexpected R2 command ${String(command)}`);
  });
}

describe("certificate R2-to-B2 archival integrity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    runtime.execute.mockReset();
    runtime.transaction.mockReset();
    runtime.r2Send.mockReset();
    runtime.inspectB2.mockReset();
    runtime.uploadB2.mockReset();
    runtime.extendB2.mockReset();
    runtime.r2.clear();
    runtime.b2.clear();
    process.env.R2_BUCKET_NAME = "local-r2-test";
    seedR2Transport();
    runtime.transaction.mockImplementation(async (callback: (tx: { execute: typeof runtime.execute }) => unknown) =>
      callback({ execute: runtime.execute })
    );
    runtime.inspectB2.mockImplementation(async (key: string) => {
      const body = runtime.b2.get(key);
      return body
        ? {
            exists: true,
            byteLength: body.length,
            sha256: sha256(body),
            contentType: "image/tiff",
            objectLockMode: "COMPLIANCE",
            objectLockRetainUntil: new Date("2099-01-01"),
          }
        : { exists: false };
    });
    runtime.uploadB2.mockImplementation(async (key: string, body: Buffer) => {
      runtime.b2.set(key, Buffer.from(body));
      return key;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("archives an immutable master solely from the evidence ledger and ignores mutable derivative prefixes", async () => {
    const master = Buffer.from("authoritative-tiff-master");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.r2.set("images/MV7/mutable-display.jpg", Buffer.from("mutable-display"));
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ id: candidate.id }] })
      .mockResolvedValueOnce({ rows: [{ entity_id: "MV7" }] });

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ certsProcessed: 1, objectsCopied: 1, objectsSkipped: 0, errors: 0 });
    expect(runtime.uploadB2).toHaveBeenCalledWith(row.object_key, master, "image/tiff", 90);
    expect(runtime.inspectB2).toHaveBeenCalledTimes(2); // missing before upload, byte-verified after upload
    expect(runtime.b2.get(row.object_key)).toEqual(master);
    expect([...runtime.b2.keys()]).toEqual([row.object_key]);
    expect(runtime.execute).toHaveBeenCalledTimes(4); // candidate, ledger, row lock, atomic mark+audit
  });

  it("archives every evidence revision and its ledger-bound working derivative", async () => {
    const front = Buffer.from("front-master-revision-one");
    const back = Buffer.from("back-master-revision-two");
    const working = Buffer.from("front-working-derivative");
    const frontRow = evidenceRow(front);
    const workingDigest = sha256(working);
    frontRow.working_object_key = `evidence/working/7/front/${workingDigest}.v1.jpg`;
    frontRow.working_sha256 = workingDigest;
    const backDigest = sha256(back);
    const backRow = {
      ...evidenceRow(back),
      id: 42,
      side: "back" as const,
      object_key: `evidence/masters/7/back/${backDigest}.tif`,
      sha256: backDigest,
    };
    runtime.r2.set(frontRow.object_key, front);
    runtime.r2.set(frontRow.working_object_key, working);
    runtime.r2.set(backRow.object_key, back);
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [frontRow, backRow] })
      .mockResolvedValueOnce({ rows: [{ id: candidate.id }] })
      .mockResolvedValueOnce({ rows: [{ entity_id: "MV7" }] });

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 3, objectsSkipped: 0, errors: 0 });
    expect([...runtime.b2.keys()].sort()).toEqual(
      [frontRow.object_key, frontRow.working_object_key, backRow.object_key].sort()
    );
  });

  it("refuses archived_to_b2_at when the required evidence ledger is empty", async () => {
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // archive_failed audit

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ certsProcessed: 1, objectsCopied: 0, errors: 1 });
    expect(runtime.r2Send).not.toHaveBeenCalled();
    expect(runtime.inspectB2).not.toHaveBeenCalled();
    expect(runtime.uploadB2).not.toHaveBeenCalled();
    expect(runtime.execute).toHaveBeenCalledTimes(3); // no completion UPDATE
  });

  it("skips an existing B2 object only after its actual bytes match size and SHA-256", async () => {
    const master = Buffer.from("matching-master");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.b2.set(row.object_key, Buffer.from(master));
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ id: candidate.id }] })
      .mockResolvedValueOnce({ rows: [{ entity_id: "MV7" }] });

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, objectsSkipped: 1, errors: 0 });
    expect(runtime.inspectB2).toHaveBeenCalledTimes(1);
    expect(runtime.uploadB2).not.toHaveBeenCalled();
  });

  it("refuses to replace an existing corrupt Compliance-locked B2 object", async () => {
    const master = Buffer.from("correct-master");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.b2.set(row.object_key, Buffer.from("corrupt-locked-object"));
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }); // archive_failed audit

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, objectsSkipped: 0, errors: 1 });
    expect(runtime.uploadB2).not.toHaveBeenCalled();
    expect(runtime.b2.get(row.object_key)?.toString()).toBe("corrupt-locked-object");
    expect(runtime.execute).toHaveBeenCalledTimes(3); // no completion UPDATE
  });

  it("refuses an existing byte-correct B2 object when COMPLIANCE retention is not observed", async () => {
    const master = Buffer.from("matching-but-unlocked-master");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.b2.set(row.object_key, Buffer.from(master));
    runtime.inspectB2.mockResolvedValue({
      exists: true,
      byteLength: master.length,
      sha256: sha256(master),
      contentType: "image/tiff",
      objectLockMode: undefined,
      objectLockRetainUntil: undefined,
    });
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }); // archive_failed audit

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, objectsSkipped: 0, errors: 1 });
    expect(runtime.uploadB2).not.toHaveBeenCalled();
    expect(runtime.transaction).not.toHaveBeenCalled();
  });

  it("renews an existing byte-correct B2 object's expired COMPLIANCE retention", async () => {
    const master = Buffer.from("matching-with-expired-retention");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.inspectB2
      .mockResolvedValueOnce({
        exists: true,
        byteLength: master.length,
        sha256: sha256(master),
        contentType: "image/tiff",
        objectLockMode: "COMPLIANCE",
        objectLockRetainUntil: new Date("2020-01-01"),
      })
      .mockResolvedValueOnce({
        exists: true,
        byteLength: master.length,
        sha256: sha256(master),
        contentType: "image/tiff",
        objectLockMode: "COMPLIANCE",
        objectLockRetainUntil: new Date(Date.now() + 90 * 86_400_000),
      });
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ id: candidate.id }] })
      .mockResolvedValueOnce({ rows: [{ entity_id: "MV7" }] });

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, objectsSkipped: 1, errors: 0 });
    expect(runtime.extendB2).toHaveBeenCalledWith(row.object_key, expect.any(Date));
    expect(runtime.inspectB2).toHaveBeenCalledTimes(2);
    expect(runtime.uploadB2).not.toHaveBeenCalled();
  });

  it("renews an existing byte-correct B2 object without a full remaining retention window", async () => {
    const master = Buffer.from("matching-with-only-seven-days-retention");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.inspectB2
      .mockResolvedValueOnce({
        exists: true,
        byteLength: master.length,
        sha256: sha256(master),
        contentType: "image/tiff",
        objectLockMode: "COMPLIANCE",
        objectLockRetainUntil: new Date(Date.now() + 7 * 86_400_000),
      })
      .mockResolvedValueOnce({
        exists: true,
        byteLength: master.length,
        sha256: sha256(master),
        contentType: "image/tiff",
        objectLockMode: "COMPLIANCE",
        objectLockRetainUntil: new Date(Date.now() + 90 * 86_400_000),
      });
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ id: candidate.id }] })
      .mockResolvedValueOnce({ rows: [{ entity_id: "MV7" }] });

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, objectsSkipped: 1, errors: 0 });
    expect(runtime.extendB2).toHaveBeenCalledWith(row.object_key, expect.any(Date));
    expect(runtime.uploadB2).not.toHaveBeenCalled();
  });

  it("refuses completion when retention renewal cannot be observed afterwards", async () => {
    const master = Buffer.from("matching-but-renewal-not-observed");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    const insufficient = {
      exists: true as const,
      byteLength: master.length,
      sha256: sha256(master),
      contentType: "image/tiff",
      objectLockMode: "COMPLIANCE",
      objectLockRetainUntil: new Date(Date.now() + 7 * 86_400_000),
    };
    runtime.inspectB2.mockResolvedValue(insufficient);
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }); // archive_failed audit

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, objectsSkipped: 0, errors: 1 });
    expect(runtime.extendB2).toHaveBeenCalledTimes(1);
    expect(runtime.inspectB2).toHaveBeenCalledTimes(2);
    expect(runtime.uploadB2).not.toHaveBeenCalled();
    expect(runtime.transaction).not.toHaveBeenCalled();
  });

  it("refuses completion when a new upload cannot prove its requested COMPLIANCE retention", async () => {
    const master = Buffer.from("new-upload-without-observed-lock");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.inspectB2.mockResolvedValueOnce({ exists: false }).mockResolvedValueOnce({
      exists: true,
      byteLength: master.length,
      sha256: sha256(master),
      contentType: "image/tiff",
      objectLockMode: undefined,
      objectLockRetainUntil: undefined,
    });
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }); // archive_failed audit

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, objectsSkipped: 0, errors: 1 });
    expect(runtime.uploadB2).toHaveBeenCalledWith(row.object_key, master, "image/tiff", 90);
    expect(runtime.transaction).not.toHaveBeenCalled();
  });

  it("refuses completion when the evidence ledger changes while object copies are in flight", async () => {
    const master = Buffer.from("master-before-concurrent-recapture");
    const row = evidenceRow(master);
    runtime.r2.set(row.object_key, master);
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ id: candidate.id }] }) // certificate lock
      .mockResolvedValueOnce({ rows: [] }) // ledger fingerprint rejected the mark
      .mockResolvedValueOnce({ rows: [] }); // archive_failed audit

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 1, errors: 1 });
    expect(runtime.b2.get(row.object_key)).toEqual(master); // safe partial copy remains reusable
    expect(runtime.execute).toHaveBeenCalledTimes(5);
  });

  it("refuses a source master whose bytes do not match the evidence ledger", async () => {
    const authoritative = Buffer.from("authoritative-master");
    const corruptR2 = Buffer.from("corrupt-r2-master");
    const row = evidenceRow(authoritative);
    runtime.r2.set(row.object_key, corruptR2);
    runtime.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }); // archive_failed audit

    const result = await archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90 });

    expect(result).toMatchObject({ objectsCopied: 0, errors: 1 });
    expect(runtime.inspectB2).not.toHaveBeenCalled();
    expect(runtime.uploadB2).not.toHaveBeenCalled();
  });
});
