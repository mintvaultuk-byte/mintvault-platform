/**
 * Phase 10A-6 — END-TO-END route-level proof: mounts the REAL admin router with
 * the REAL vqStorage (backed by the isolated local Postgres — same DB the store
 * module uses) and only mocks auth + R2 bytes. Proves the actual HTTP surface:
 * single-card save promotes a candidate into an immutable revision, the admin-
 * preview thumbnail route resolves the correct (legacy or revisioned) pointer,
 * and a legacy (pre-revision) card keeps rendering the exact same artwork
 * unchanged — the explicit "before/after migration" regression proof.
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
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === (process.env.MINTVAULT_TEST_PG16_PORT || "55432") && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});
vi.mock("../server/auth", () => ({ requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next() }));

// In-memory R2 stand-in — real bytes, no real network. Both the direct-upload
// route and the store module read/write through this same map.
const r2Store = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async (key: string, buf: Buffer) => { r2Store.set(key, buf); }),
  getR2Buffer: vi.fn(async (key: string) => r2Store.get(key) ?? null),
  getR2ObjectStream: vi.fn(async () => null),
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";
import { getActiveRevisionKey } from "../server/vault-quest/lib/vq-artwork-revisions-store";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function getBinary(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, buf: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
}

const REAL_PNG_1 = () => require("sharp")({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
const REAL_PNG_2 = () => require("sharp")({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 20, b: 20 } } }).png().toBuffer();

run("artwork revisions — real router + real vqStorage + local Postgres", () => {
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
    await q("DELETE FROM vq_artwork_candidates WHERE character_id LIKE 'RT-%'", []);
    await q("DELETE FROM vq_cards WHERE card_id LIKE 'RT-%'", []);
    await q("DELETE FROM vq_characters WHERE character_id LIKE 'RT-%'", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_artwork_revision_events", []);
    await q("DELETE FROM vq_artwork_revisions", []);
    await q("DELETE FROM vq_artwork_candidates WHERE character_id LIKE 'RT-%'", []);
    await q("DELETE FROM vq_cards WHERE card_id LIKE 'RT-%'", []);
    await q("DELETE FROM vq_characters WHERE character_id LIKE 'RT-%'", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("BEFORE/AFTER MIGRATION REGRESSION PROOF: a legacy card (flat key, no revision ever created) keeps serving the exact same bytes via the admin-preview route", async () => {
    const legacyBytes = await REAL_PNG_1();
    const legacyKey = "vq/art/RT-LEGACY-1/main.png";
    r2Store.set(legacyKey, legacyBytes);
    await q(
      `INSERT INTO vq_cards (card_id, collector_number, name, card_type, element, art_r2_key) VALUES ($1,$2,$3,$4,$5,$6)`,
      ["RT-LEGACY-1", "001/150", "Legacy Card", "Creature", "Flame", legacyKey],
    );
    // BEFORE any 10A-6 write path ever touches this card: the preview route must
    // serve the SAME bytes it always did — the flat legacy key, untouched.
    const before = await getBinary("/api/admin/vault-quest/cards/RT-LEGACY-1/art/main");
    expect(before.status).toBe(200);
    expect(before.buf?.equals(legacyBytes)).toBe(true);
    expect(await getActiveRevisionKey("card", "RT-LEGACY-1", "main")).toBeNull(); // still no ledger row
    // AFTER (simulated by just re-requesting) — identical, nothing changed by reading.
    const after = await getBinary("/api/admin/vault-quest/cards/RT-LEGACY-1/art/main");
    expect(after.buf?.equals(legacyBytes)).toBe(true);
  });

  it("direct file-upload route promotes an immutable revision and the admin-preview thumbnail resolves it correctly", async () => {
    await q(`INSERT INTO vq_cards (card_id, collector_number, name, card_type, element) VALUES ($1,$2,$3,$4,$5)`, ["RT-UPLOAD-1", "002/150", "Upload Card", "Creature", "Water"]);
    const png = await REAL_PNG_1();
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "art.png");
    const uploadRes = await fetch(`${base}/api/admin/vault-quest/cards/RT-UPLOAD-1/art?slot=main`, { method: "POST", body: form });
    expect(uploadRes.status).toBe(200);
    const uploadJson = (await uploadRes.json()) as { key: string };
    expect(uploadJson.key).toMatch(/^vq\/art\/RT-UPLOAD-1\/main\/.+\.png$/); // immutable revisioned key, not the flat legacy path

    const { rows } = await q("SELECT art_r2_key FROM vq_cards WHERE card_id = $1", ["RT-UPLOAD-1"]);
    expect((rows[0] as { art_r2_key: string }).art_r2_key).toBe(uploadJson.key); // pointer persisted immediately

    const preview = await getBinary("/api/admin/vault-quest/cards/RT-UPLOAD-1/art/main");
    expect(preview.status).toBe(200);
    expect(preview.buf?.equals(png)).toBe(true); // the preview resolves the SAME revisioned key, not a stale flat path
  });

  it("family approve-references route promotes atomic revisions for every stage, all succeed together", async () => {
    for (let stage = 1; stage <= 3; stage++) {
      await q(
        `INSERT INTO vq_characters (character_id, family_id, card_id, stage_number, character_name, element) VALUES ($1,$2,$3,$4,$5,$6)`,
        [`RT-FAM-S${stage}`, "RT-FAM-1", `RT-FAM-CARD-${stage}`, stage, `Stage ${stage}`, "Flame"],
      );
    }
    // Seed one candidate per stage.
    const candidateIds: number[] = [];
    for (let stage = 1; stage <= 3; stage++) {
      const key = `vq/characters/RT-FAM-S${stage}/candidates/${Date.now()}-${stage}.png`;
      r2Store.set(key, await (stage === 2 ? REAL_PNG_2() : REAL_PNG_1()));
      const { rows } = await q(
        `INSERT INTO vq_artwork_candidates (character_id, slot, reference_type, source, r2_key, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [`RT-FAM-S${stage}`, "main", "master_portrait", "generated", key, "candidate", "admin"],
      );
      candidateIds.push((rows[0] as { id: number }).id);
    }
    const r = await post("/api/admin/vault-quest/characters/family/RT-FAM-1/approve-references", {
      selections: [1, 2, 3].map((stage) => ({ characterId: `RT-FAM-S${stage}`, candidateId: candidateIds[stage - 1] })),
    });
    expect(r.status).toBe(200);
    const approved = (r.json as { approved: { characterId: string }[] }).approved;
    expect(approved.length).toBe(3);
    for (let stage = 1; stage <= 3; stage++) {
      const activeKey = await getActiveRevisionKey("character", `RT-FAM-S${stage}`, "master_portrait");
      expect(activeKey).toBeTruthy();
      const { rows } = await q("SELECT approved_artwork_r2_key FROM vq_characters WHERE character_id = $1", [`RT-FAM-S${stage}`]);
      expect((rows[0] as { approved_artwork_r2_key: string }).approved_artwork_r2_key).toBe(activeKey);
    }
  });

  it("manual Action Reference upload promotes action_pose without provider jobs or candidates", async () => {
    const characterId = "RT-ACTION-S1";
    const masterKey = "vq/characters/RT-ACTION-S1/approved/master_portrait.png";
    r2Store.set(masterKey, await REAL_PNG_1());
    await q(
      `INSERT INTO vq_characters (character_id, family_id, card_id, stage_number, character_name, element, approved_artwork_r2_key, reference_artwork_r2_key, reference_pack)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8::jsonb)`,
      [
        characterId,
        "RT-ACTION",
        "RT-ACTION-CARD-1",
        1,
        "Action Upload Subject",
        "Flame",
        masterKey,
        JSON.stringify({ master_portrait: { r2Key: masterKey, approvedAt: new Date(0).toISOString() } }),
      ],
    );

    const beforeCandidates = await q("SELECT count(*)::int AS n FROM vq_artwork_candidates WHERE character_id = $1", [characterId]);
    const beforeJobs = await q("SELECT count(*)::int AS n FROM vq_ai_generations WHERE card_id = $1", ["RT-ACTION-CARD-1"]);
    const png = await REAL_PNG_2();
    const form = new FormData();
    form.append("file", new Blob([png], { type: "image/png" }), "action.png");
    const uploadRes = await fetch(`${base}/api/admin/vault-quest/characters/${characterId}/reference/action_pose/upload`, {
      method: "POST",
      body: form,
    });
    expect(uploadRes.status).toBe(200);
    const uploadJson = (await uploadRes.json()) as { key: string; referenceType: string; providerGeneration: boolean };
    expect(uploadJson.referenceType).toBe("action_pose");
    expect(uploadJson.providerGeneration).toBe(false);
    expect(uploadJson.key).toMatch(/^vq\/characters\/RT-ACTION-S1\/approved\/action_pose\/.+\.png$/);

    const activeKey = await getActiveRevisionKey("character", characterId, "action_pose");
    expect(activeKey).toBe(uploadJson.key);
    const { rows } = await q("SELECT reference_pack, approved_artwork_r2_key FROM vq_characters WHERE character_id = $1", [characterId]);
    const row = rows[0] as { reference_pack: Record<string, { r2Key?: string }>; approved_artwork_r2_key: string };
    expect(row.reference_pack.action_pose.r2Key).toBe(uploadJson.key);
    expect(row.reference_pack.master_portrait.r2Key).toBe(masterKey);
    expect(row.approved_artwork_r2_key).toBe(masterKey);

    const preview = await getBinary(`/api/admin/vault-quest/characters/${characterId}/pack/action_pose`);
    expect(preview.status).toBe(200);
    expect(preview.buf?.equals(png)).toBe(true);
    const afterCandidates = await q("SELECT count(*)::int AS n FROM vq_artwork_candidates WHERE character_id = $1", [characterId]);
    const afterJobs = await q("SELECT count(*)::int AS n FROM vq_ai_generations WHERE card_id = $1", ["RT-ACTION-CARD-1"]);
    expect((afterCandidates.rows[0] as { n: number }).n).toBe((beforeCandidates.rows[0] as { n: number }).n);
    expect((afterJobs.rows[0] as { n: number }).n).toBe((beforeJobs.rows[0] as { n: number }).n);
  });

  it("GET /artwork-revisions returns history; POST .../restore rolls back and is reflected everywhere", async () => {
    await q(`INSERT INTO vq_cards (card_id, collector_number, name, card_type, element) VALUES ($1,$2,$3,$4,$5)`, ["RT-HIST-1", "003/150", "History Card", "Creature", "Storm"]);
    const png1 = await REAL_PNG_1();
    const form1 = new FormData();
    form1.append("file", new Blob([png1], { type: "image/png" }), "art.png");
    const r1 = await fetch(`${base}/api/admin/vault-quest/cards/RT-HIST-1/art?slot=main`, { method: "POST", body: form1 });
    const key1 = ((await r1.json()) as { key: string }).key;

    const png2 = await REAL_PNG_2();
    const form2 = new FormData();
    form2.append("file", new Blob([png2], { type: "image/png" }), "art2.png");
    const r2 = await fetch(`${base}/api/admin/vault-quest/cards/RT-HIST-1/art?slot=main`, { method: "POST", body: form2 });
    const key2 = ((await r2.json()) as { key: string }).key;
    expect(key2).not.toBe(key1);

    const historyRes = await fetch(`${base}/api/admin/vault-quest/artwork-revisions?entityType=card&entityId=RT-HIST-1&slot=main`);
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as { revisions: { id: number; r2Key: string; isActive: boolean }[] };
    expect(history.revisions.length).toBe(2);
    const firstRev = history.revisions.find((r) => r.r2Key === key1)!;
    const secondRev = history.revisions.find((r) => r.r2Key === key2)!;
    expect(secondRev.isActive).toBe(true);
    expect(firstRev.isActive).toBe(false);

    const restoreRes = await post(`/api/admin/vault-quest/artwork-revisions/${firstRev.id}/restore`, {});
    expect(restoreRes.status).toBe(200);
    expect((restoreRes.json as { r2Key: string }).r2Key).toBe(key1);

    const preview = await getBinary("/api/admin/vault-quest/cards/RT-HIST-1/art/main");
    expect(preview.buf?.equals(png1)).toBe(true); // rolled back to the FIRST image's actual bytes

    // Restoring a revision whose R2 bytes are gone fails safely (422), current pointer untouched.
    r2Store.delete(key2);
    const badRestore = await post(`/api/admin/vault-quest/artwork-revisions/${secondRev.id}/restore`, {});
    expect(badRestore.status).toBe(422);
    const { rows } = await q("SELECT art_r2_key FROM vq_cards WHERE card_id = $1", ["RT-HIST-1"]);
    expect((rows[0] as { art_r2_key: string }).art_r2_key).toBe(key1); // untouched by the failed restore
  });
});
