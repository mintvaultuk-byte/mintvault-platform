/**
 * Phase B — END-TO-END route-level proof: a locked/canonical character's Bible
 * fields and Master Reference can be deliberately edited/replaced WITHOUT
 * unlocking it, via the new `confirmReplaceLocked` flag, while everything stays
 * fully audited (immutable revisions, character-revision snapshots) and the
 * character never silently leaves its locked state. Also proves the new
 * GET /artwork-revisions/:id/image route and that /describe is no longer
 * blocked by lock (it only ever drafts a suggestion, never persists).
 *
 * Mounts the REAL admin router with the REAL vqStorage against the isolated
 * local Postgres; only auth + R2 bytes are mocked (same pattern as
 * vq-artwork-revisions-route.integration.test.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "55432" && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});
vi.mock("../server/auth", () => ({ requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next() }));

const r2Store = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async (key: string, buf: Buffer) => { r2Store.set(key, buf); }),
  getR2Buffer: vi.fn(async (key: string) => r2Store.get(key) ?? null),
  getR2ObjectStream: vi.fn(async () => null),
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function patch(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function getJson(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function getBinary(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, buf: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PNG_1 = () => require("sharp")({ create: { width: 96, height: 96, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PNG_2 = () => require("sharp")({ create: { width: 96, height: 96, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer();

run("locked-character edit/replace (Phase B) — real router + real vqStorage + local Postgres", () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerVaultQuestAdminRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  beforeEach(async () => {
    r2Store.clear();
    await q("DELETE FROM vq_artwork_revision_events", []);
    await q("DELETE FROM vq_artwork_revisions", []);
    await q("DELETE FROM vq_artwork_candidates WHERE character_id LIKE 'LK-%'", []);
    await q("DELETE FROM vq_character_revisions WHERE character_id LIKE 'LK-%'", []);
    await q("DELETE FROM vq_cards WHERE card_id LIKE 'LK-%'", []);
    await q("DELETE FROM vq_characters WHERE character_id LIKE 'LK-%'", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_artwork_revision_events", []);
    await q("DELETE FROM vq_artwork_revisions", []);
    await q("DELETE FROM vq_artwork_candidates WHERE character_id LIKE 'LK-%'", []);
    await q("DELETE FROM vq_character_revisions WHERE character_id LIKE 'LK-%'", []);
    await q("DELETE FROM vq_cards WHERE card_id LIKE 'LK-%'", []);
    await q("DELETE FROM vq_characters WHERE character_id LIKE 'LK-%'", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  async function seedCharacter() {
    await q(
      `INSERT INTO vq_characters (character_id, family_id, card_id, stage_number, character_name, element, description_status, visual_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      ["LK-CHAR-1", "LK-FAM-1", "LK-CARD-1", 1, "Lockbeast", "Flame", "approved", "Original description"],
    );
  }
  async function seedCandidate(png: Buffer) {
    const key = `vq/characters/LK-CHAR-1/candidates/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    r2Store.set(key, png);
    const { rows } = await q(
      `INSERT INTO vq_artwork_candidates (character_id, slot, reference_type, source, r2_key, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      ["LK-CHAR-1", "main", "master_portrait", "generated", key, "candidate", "admin"],
    );
    return (rows[0] as { id: number }).id;
  }
  async function getCharacterRow() {
    const { rows } = await q("SELECT locked, description_status, reference_pack, visual_description FROM vq_characters WHERE character_id = $1", ["LK-CHAR-1"]);
    return rows[0] as { locked: boolean; description_status: string; reference_pack: { master_portrait?: { r2Key: string } }; visual_description: string };
  }

  it("PATCH Bible edit: 423 when locked without confirmReplaceLocked, succeeds + demotes description with it, character stays locked", async () => {
    await seedCharacter();
    await q("UPDATE vq_characters SET locked = true WHERE character_id = $1", ["LK-CHAR-1"]);

    const blocked = await patch("/api/admin/vault-quest/characters/LK-CHAR-1", { visualDescription: "Edited while locked", reason: "test" });
    expect(blocked.status).toBe(423);
    expect(await getCharacterRow()).toMatchObject({ locked: true, description_status: "approved", visual_description: "Original description" });

    const allowed = await patch("/api/admin/vault-quest/characters/LK-CHAR-1", { visualDescription: "Edited while locked", reason: "test", confirmReplaceLocked: true });
    expect(allowed.status).toBe(200);
    const row = await getCharacterRow();
    expect(row.locked).toBe(true); // still locked — the flag never unlocks it
    expect(row.visual_description).toBe("Edited while locked");
    expect(row.description_status).toBe("needs_review"); // text-before-pixels demotion still applies

    const revisions = await q("SELECT * FROM vq_character_revisions WHERE character_id = $1", ["LK-CHAR-1"]);
    expect(revisions.rows.length).toBeGreaterThan(0); // the pre-edit snapshot is preserved, never destroyed
  });

  it("/describe is never blocked by lock (draft-only, nothing persisted)", async () => {
    await seedCharacter();
    await q("UPDATE vq_characters SET locked = true WHERE character_id = $1", ["LK-CHAR-1"]);
    const res = await post("/api/admin/vault-quest/characters/LK-CHAR-1/describe", { mode: "generate" });
    // No ANTHROPIC_API_KEY in the test env → the route itself may 503/422 on provider
    // unavailability, but it must NEVER be the 423 lock guard we just removed.
    expect(res.status).not.toBe(423);
  });

  it("approve-candidate: 423 when locked without confirmReplaceLocked; with it, replaces the reference, archives the old one, character stays locked", async () => {
    await seedCharacter();
    const firstCandidateId = await seedCandidate(await PNG_1());
    const approveFirst = await post("/api/admin/vault-quest/characters/LK-CHAR-1/approve-candidate", { candidateId: firstCandidateId });
    expect(approveFirst.status).toBe(200); // not locked yet — succeeds normally

    await q("UPDATE vq_characters SET locked = true WHERE character_id = $1", ["LK-CHAR-1"]);
    const secondCandidateId = await seedCandidate(await PNG_2());

    const blocked = await post("/api/admin/vault-quest/characters/LK-CHAR-1/approve-candidate", { candidateId: secondCandidateId });
    expect(blocked.status).toBe(423);

    const allowed = await post("/api/admin/vault-quest/characters/LK-CHAR-1/approve-candidate", { candidateId: secondCandidateId, confirmReplaceLocked: true });
    expect(allowed.status).toBe(200);
    expect((allowed.json as { locked: boolean }).locked).toBe(true); // character never left locked

    const row = await getCharacterRow();
    expect(row.locked).toBe(true);

    const history = await getJson("/api/admin/vault-quest/artwork-revisions?entityType=character&entityId=LK-CHAR-1&slot=master_portrait");
    const revs = (history.json as { revisions: { id: number; isActive: boolean }[] }).revisions;
    expect(revs.length).toBe(2);
    expect(revs.filter((r) => r.isActive).length).toBe(1); // exactly one active — the OLD one archived, not deleted
  });

  it("restore: 423 when locked without confirmReplaceLocked; with it, rolls back the active pointer, character stays locked", async () => {
    await seedCharacter();
    const png1 = await PNG_1();
    const firstCandidateId = await seedCandidate(png1);
    await post("/api/admin/vault-quest/characters/LK-CHAR-1/approve-candidate", { candidateId: firstCandidateId });

    await q("UPDATE vq_characters SET locked = true WHERE character_id = $1", ["LK-CHAR-1"]);
    const png2 = await PNG_2();
    const secondCandidateId = await seedCandidate(png2);
    await post("/api/admin/vault-quest/characters/LK-CHAR-1/approve-candidate", { candidateId: secondCandidateId, confirmReplaceLocked: true });

    const history = await getJson("/api/admin/vault-quest/artwork-revisions?entityType=character&entityId=LK-CHAR-1&slot=master_portrait");
    const revs = (history.json as { revisions: { id: number; r2Key: string; isActive: boolean }[] }).revisions;
    const archived = revs.find((r) => !r.isActive)!;

    const blocked = await post(`/api/admin/vault-quest/artwork-revisions/${archived.id}/restore`, {});
    expect(blocked.status).toBe(423);

    const allowed = await post(`/api/admin/vault-quest/artwork-revisions/${archived.id}/restore`, { confirmReplaceLocked: true });
    expect(allowed.status).toBe(200);
    expect((allowed.json as { r2Key: string }).r2Key).toBe(archived.r2Key); // rolled back to the FIRST image's key

    const row = await getCharacterRow();
    expect(row.locked).toBe(true); // still locked — restoring never unlocks it
    expect(row.reference_pack.master_portrait?.r2Key).toBe(archived.r2Key); // pointer follows the restore

    const preview = await getBinary("/api/admin/vault-quest/characters/LK-CHAR-1/pack/master_portrait");
    expect(preview.buf?.equals(png1)).toBe(true); // rolled back to the FIRST image's actual bytes
  });

  it("GET /artwork-revisions/:id/image serves the exact bytes for a character revision, 404s for a card revision (character-only route)", async () => {
    await seedCharacter();
    const png1 = await PNG_1();
    const firstCandidateId = await seedCandidate(png1);
    await post("/api/admin/vault-quest/characters/LK-CHAR-1/approve-candidate", { candidateId: firstCandidateId });

    const history = await getJson("/api/admin/vault-quest/artwork-revisions?entityType=character&entityId=LK-CHAR-1&slot=master_portrait");
    const revs = (history.json as { revisions: { id: number }[] }).revisions;
    const image = await getBinary(`/api/admin/vault-quest/artwork-revisions/${revs[0].id}/image`);
    expect(image.status).toBe(200);
    expect(image.buf?.equals(png1)).toBe(true);

    await q(`INSERT INTO vq_cards (card_id, collector_number, name, card_type, element) VALUES ($1,$2,$3,$4,$5)`, ["LK-CARD-2", "099/150", "Card Two", "Creature", "Water"]);
    const cardPng = await PNG_2();
    const form = new FormData();
    form.append("file", new Blob([cardPng], { type: "image/png" }), "art.png");
    const uploadRes = await fetch(`${base}/api/admin/vault-quest/cards/LK-CARD-2/art?slot=main`, { method: "POST", body: form });
    expect(uploadRes.status).toBe(200);
    const cardHistory = await getJson("/api/admin/vault-quest/artwork-revisions?entityType=card&entityId=LK-CARD-2&slot=main");
    const cardRevs = (cardHistory.json as { revisions: { id: number }[] }).revisions;
    const cardImage = await getBinary(`/api/admin/vault-quest/artwork-revisions/${cardRevs[0].id}/image`);
    expect(cardImage.status).toBe(404); // card entity revisions aren't served by this character-only route

    const missing = await getBinary("/api/admin/vault-quest/artwork-revisions/999999999/image");
    expect(missing.status).toBe(404);
  });
});
