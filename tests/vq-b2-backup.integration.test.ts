/**
 * Phase 10A-8 — VQ R2→B2 backup worker integration tests against the ISOLATED
 * LOCAL Postgres (TEST_DATABASE_URL, pinned/hard-failed; skipped without it —
 * never touches staging/prod). Proves: pending→archived copy, idempotent
 * skip-if-already-in-B2, integrity-mismatch refuses to upload, the
 * assertVqBackupKey hard-isolation guard rejects a non-VQ key without ever
 * calling B2, failed rows are only retried when asked, dry-run performs zero
 * I/O and zero writes, missing R2 object is a failure (not a mismatch), and
 * batchSize bounds a single run.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok =
    (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
    u.port === (process.env.MINTVAULT_TEST_PG16_PORT || "55432") &&
    u.pathname === "/mintvault_vq_phase10_local";
  if (!ok)
    throw new Error(
      `REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`
    );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});

// getR2Buffer is a real R2 network call in production — stub it to read from an
// in-memory map keyed by r2Key, seeded per-test. uploadToB2/existsInB2 stubbed
// the same way so this suite never touches real R2 or real B2.
const r2Store = vi.hoisted(() => new Map<string, Buffer>());
const b2Store = vi.hoisted(() => new Set<string>());
const uploadToB2Spy = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    b2Store.add(key);
    return key;
  })
);
const existsInB2Spy = vi.hoisted(() => vi.fn(async (key: string) => b2Store.has(key)));
vi.mock("../server/r2", () => ({
  getR2Buffer: vi.fn(async (key: string) => r2Store.get(key) ?? null),
}));
vi.mock("../server/b2", () => ({
  uploadToB2: uploadToB2Spy,
  existsInB2: existsInB2Spy,
}));

const run = TEST_URL ? describe : describe.skip;

import { backupVqArtworkRevisions } from "../server/vault-quest/lib/vq-b2-backup";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) =>
  (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);
const sha256Hex = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const TINY_PNG_1 = Buffer.from("b2-test-bytes-v1");
const TINY_PNG_2 = Buffer.from("b2-test-bytes-v2-different-length");

let seq = 0;
async function seedRevision(
  overrides: Partial<{
    entityType: "character" | "card";
    entityId: string;
    slot: string;
    r2Key: string;
    buf: Buffer;
    sha256: string;
    byteSize: number;
    backupState: "pending" | "archived" | "failed";
    isActive: boolean;
  }> = {}
): Promise<{ id: number; r2Key: string }> {
  seq++;
  const buf = overrides.buf ?? TINY_PNG_1;
  const r2Key = overrides.r2Key ?? `vq/art/T-B2-${seq}/main/rev-${seq}.png`;
  const sha256 = overrides.sha256 ?? sha256Hex(buf);
  const byteSize = overrides.byteSize ?? buf.length;
  if (!overrides.r2Key || overrides.sha256 === undefined) r2Store.set(r2Key, buf);
  const { rows } = await q(
    `INSERT INTO vq_artwork_revisions (entity_type, entity_id, slot, r2_key, sha256, byte_size, mime, is_active, backup_state)
     VALUES ($1,$2,$3,$4,$5,$6,'image/png',$7,$8) RETURNING id`,
    [
      overrides.entityType ?? "card",
      overrides.entityId ?? `T-B2-${seq}`,
      overrides.slot ?? "main",
      r2Key,
      sha256,
      byteSize,
      overrides.isActive ?? true,
      overrides.backupState ?? "pending",
    ]
  );
  return { id: (rows[0] as { id: number }).id, r2Key };
}

run("vq-b2-backup — local Postgres", () => {
  beforeEach(async () => {
    uploadToB2Spy.mockClear();
    existsInB2Spy.mockClear();
    r2Store.clear();
    b2Store.clear();
    await q("DELETE FROM vq_artwork_revisions WHERE entity_id LIKE 'T-B2-%'", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_artwork_revisions WHERE entity_id LIKE 'T-B2-%'", []);
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("PENDING → ARCHIVED: a pending revision with matching bytes is copied to B2 and backup_state flips", async () => {
    const { id, r2Key } = await seedRevision({ buf: TINY_PNG_1 });
    const summary = await backupVqArtworkRevisions({ dryRun: false, batchSize: 50 });
    expect(summary.copied).toBe(1);
    expect(summary.failed).toBe(0);
    expect(uploadToB2Spy).toHaveBeenCalledWith(r2Key, TINY_PNG_1, "image/png", 90);
    const { rows } = await q("SELECT backup_state FROM vq_artwork_revisions WHERE id = $1", [id]);
    expect((rows[0] as { backup_state: string }).backup_state).toBe("archived");
  });

  it("IDEMPOTENT: a revision already present in B2 is skipped (no re-upload) but still marked archived", async () => {
    const { id, r2Key } = await seedRevision({ buf: TINY_PNG_1 });
    b2Store.add(r2Key); // already backed up out-of-band
    const summary = await backupVqArtworkRevisions({ dryRun: false, batchSize: 50 });
    expect(summary.skippedAlreadyInB2).toBe(1);
    expect(summary.copied).toBe(0);
    expect(uploadToB2Spy).not.toHaveBeenCalled();
    const { rows } = await q("SELECT backup_state FROM vq_artwork_revisions WHERE id = $1", [id]);
    expect((rows[0] as { backup_state: string }).backup_state).toBe("archived");
  });

  it("INTEGRITY MISMATCH: corrupt bytes are never uploaded; row marked failed, not archived", async () => {
    const wrongBuf = TINY_PNG_2;
    const { id, r2Key } = await seedRevision({ buf: TINY_PNG_1, sha256: sha256Hex(wrongBuf) }); // stored hash won't match the actual R2 bytes
    r2Store.set(r2Key, TINY_PNG_1); // the "real" bytes don't match the recorded hash
    const summary = await backupVqArtworkRevisions({ dryRun: false, batchSize: 50 });
    expect(summary.integrityMismatches).toBe(1);
    expect(uploadToB2Spy).not.toHaveBeenCalled();
    const { rows } = await q("SELECT backup_state FROM vq_artwork_revisions WHERE id = $1", [id]);
    expect((rows[0] as { backup_state: string }).backup_state).toBe("failed");
  });

  it("MISSING R2 OBJECT: a pending revision whose R2 object is gone is a failure, not an integrity mismatch", async () => {
    const { id, r2Key } = await seedRevision({ buf: TINY_PNG_1 });
    r2Store.delete(r2Key); // simulate a deleted/missing R2 object
    const summary = await backupVqArtworkRevisions({ dryRun: false, batchSize: 50 });
    expect(summary.failed).toBe(1);
    expect(summary.integrityMismatches).toBe(0);
    expect(uploadToB2Spy).not.toHaveBeenCalled();
    const { rows } = await q("SELECT backup_state FROM vq_artwork_revisions WHERE id = $1", [id]);
    expect((rows[0] as { backup_state: string }).backup_state).toBe("failed");
  });

  it("HARD ISOLATION: a non-VQ-approved key is rejected by assertVqBackupKey and B2 is never called", async () => {
    // Directly seeds a row with a key shape assertVqBackupKey must reject
    // (grading prefix) — proves the guard, not just convention, keeps this
    // worker off certificate images even if a row like this ever existed.
    const { id } = await seedRevision({ r2Key: "images/MV1/front.png", entityId: "T-B2-guard" });
    const summary = await backupVqArtworkRevisions({ dryRun: false, batchSize: 50 });
    expect(summary.guardRejected).toBe(1);
    expect(existsInB2Spy).not.toHaveBeenCalled();
    expect(uploadToB2Spy).not.toHaveBeenCalled();
    const { rows } = await q("SELECT backup_state FROM vq_artwork_revisions WHERE id = $1", [id]);
    expect((rows[0] as { backup_state: string }).backup_state).toBe("pending"); // untouched, not silently marked either way
  });

  it("RETRY: a failed row is skipped by default and only retried when retryFailed is set", async () => {
    const { id, r2Key } = await seedRevision({ buf: TINY_PNG_1, backupState: "failed" });
    const first = await backupVqArtworkRevisions({ dryRun: false, batchSize: 50 });
    expect(first.candidates).toBe(0); // failed rows excluded by default
    expect(uploadToB2Spy).not.toHaveBeenCalled();

    const second = await backupVqArtworkRevisions({ dryRun: false, batchSize: 50, retryFailed: true });
    expect(second.candidates).toBe(1);
    expect(second.copied).toBe(1);
    expect(uploadToB2Spy).toHaveBeenCalledWith(r2Key, TINY_PNG_1, "image/png", 90);
    const { rows } = await q("SELECT backup_state FROM vq_artwork_revisions WHERE id = $1", [id]);
    expect((rows[0] as { backup_state: string }).backup_state).toBe("archived");
  });

  it("DRY RUN: zero R2/B2 calls, zero DB writes, but reports the plan", async () => {
    const { id } = await seedRevision({ buf: TINY_PNG_1 });
    const summary = await backupVqArtworkRevisions({ dryRun: true, batchSize: 50 });
    expect(summary.candidates).toBe(1);
    expect(summary.copied).toBe(1); // "would copy"
    expect(summary.bytesCopied).toBe(TINY_PNG_1.length);
    expect(existsInB2Spy).not.toHaveBeenCalled();
    expect(uploadToB2Spy).not.toHaveBeenCalled();
    const { rows } = await q("SELECT backup_state FROM vq_artwork_revisions WHERE id = $1", [id]);
    expect((rows[0] as { backup_state: string }).backup_state).toBe("pending"); // untouched
  });

  it("BATCH SIZE bounds a single run", async () => {
    await seedRevision({ buf: TINY_PNG_1 });
    await seedRevision({ buf: TINY_PNG_1 });
    await seedRevision({ buf: TINY_PNG_1 });
    const summary = await backupVqArtworkRevisions({ dryRun: false, batchSize: 2 });
    expect(summary.candidates).toBe(2);
  });
});
