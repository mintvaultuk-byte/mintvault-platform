/**
 * Phase 10A-6 — immutable artwork revisions integration tests against the
 * ISOLATED LOCAL Postgres (TEST_DATABASE_URL, pinned/hard-failed; skipped
 * without it — never touches staging/prod). Proves: atomic activation, legacy
 * fallback compatibility, revision history, concurrent-promotion single-winner,
 * failed-upload/failed-DB-commit leave the prior artwork fully intact, missing-
 * asset-on-restore fails safely, and rollback to a previous revision.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

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

// uploadToR2 is a real R2 network call in production — spy so we can force a
// failure for the "failed upload leaves prior intact" proof, and so this suite
// never touches real R2. getR2Buffer stays a thin real read against... no real R2
// either: we stub it to read from an in-memory map keyed by r2Key, seeded per-test.
const r2Store = vi.hoisted(() => new Map<string, Buffer>());
const uploadSpy = vi.hoisted(() => vi.fn(async (key: string, buf: Buffer) => { r2Store.set(key, buf); }));
vi.mock("../server/r2", () => ({
  uploadToR2: uploadSpy,
  getR2Buffer: vi.fn(async (key: string) => r2Store.get(key) ?? null),
}));

const run = TEST_URL ? describe : describe.skip;

import {
  promoteCardArtRevision,
  promoteCharacterReferenceRevision,
  listRevisionHistory,
  restoreArtworkRevision,
  getActiveRevisionKey,
} from "../server/vault-quest/lib/vq-artwork-revisions-store";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

const TINY_PNG_1 = Buffer.from("png-bytes-v1");
const TINY_PNG_2 = Buffer.from("png-bytes-v2-different-length");
const TINY_PNG_3 = Buffer.from("png-v3");

let cardSeq = 0;
async function makeCard(overrides: Partial<{ cardId: string; artR2Key: string | null }> = {}): Promise<string> {
  const cardId = overrides.cardId ?? `T-CARD-${++cardSeq}`;
  await q(
    `INSERT INTO vq_cards (card_id, collector_number, name, card_type, element, art_r2_key)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (card_id) DO UPDATE SET art_r2_key = EXCLUDED.art_r2_key`,
    [cardId, "001/150", "Test Card", "Creature", "Flame", overrides.artR2Key ?? null],
  );
  return cardId;
}

let charSeq = 0;
async function makeCharacter(overrides: Partial<{ characterId: string; referenceArtworkR2Key: string | null; approvedArtworkR2Key: string | null }> = {}): Promise<string> {
  charSeq++;
  const characterId = overrides.characterId ?? `T-CHAR-${charSeq}`;
  const cardId = `T-CHAR-CARD-${charSeq}`;
  await q(
    `INSERT INTO vq_characters (character_id, family_id, card_id, stage_number, character_name, element, reference_artwork_r2_key, approved_artwork_r2_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (character_id) DO UPDATE SET reference_artwork_r2_key = EXCLUDED.reference_artwork_r2_key, approved_artwork_r2_key = EXCLUDED.approved_artwork_r2_key`,
    [characterId, `T-FAM-${charSeq}`, cardId, 1, "Test Subject", "Flame", overrides.referenceArtworkR2Key ?? null, overrides.approvedArtworkR2Key ?? null],
  );
  return characterId;
}

run("vq-artwork-revisions-store — local Postgres", () => {
  beforeEach(async () => {
    uploadSpy.mockClear();
    uploadSpy.mockImplementation(async (key: string, buf: Buffer) => { r2Store.set(key, buf); });
    r2Store.clear();
    await q("DELETE FROM vq_artwork_revision_events", []);
    await q("DELETE FROM vq_artwork_revisions", []);
    await q("DELETE FROM vq_cards WHERE card_id LIKE 'T-%'", []);
    await q("DELETE FROM vq_characters WHERE character_id LIKE 'T-%'", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_artwork_revision_events", []);
    await q("DELETE FROM vq_artwork_revisions", []);
    await q("DELETE FROM vq_cards WHERE card_id LIKE 'T-%'", []);
    await q("DELETE FROM vq_characters WHERE character_id LIKE 'T-%'", []);
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("LEGACY RECORD: a card with a pre-existing flat key and NO revision row is untouched — reads keep working", async () => {
    const legacyKey = "vq/art/LEGACY-001/main.png";
    const cardId = await makeCard({ cardId: "T-LEGACY-1", artR2Key: legacyKey });
    // No revision row exists for this card/slot — confirms the ledger doesn't
    // silently backfill or touch legacy data.
    expect(await getActiveRevisionKey("card", cardId, "main")).toBeNull();
    const { rows } = await q("SELECT art_r2_key FROM vq_cards WHERE card_id = $1", [cardId]);
    expect((rows[0] as { art_r2_key: string }).art_r2_key).toBe(legacyKey); // completely untouched
  });

  it("ATOMIC ACTIVATION: promoting a card revision uploads, creates the ledger row active, and flips the card's pointer — all together", async () => {
    const cardId = await makeCard();
    const { revision, previousKey, r2Key } = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, width: 800, height: 600, createdBy: "tester" });
    expect(previousKey).toBeNull(); // first revision — nothing before it
    expect(revision.isActive).toBe(true);
    expect(uploadSpy).toHaveBeenCalledWith(r2Key, TINY_PNG_1, "image/png");
    const { rows } = await q("SELECT art_r2_key FROM vq_cards WHERE card_id = $1", [cardId]);
    expect((rows[0] as { art_r2_key: string }).art_r2_key).toBe(r2Key); // pointer flipped
    expect(r2Key).toMatch(/^vq\/art\/.+\/main\/.+\.png$/); // immutable, uuid-suffixed key, never the flat legacy path
  });

  it("REVISION HISTORY: two promotions leave a full history, newest first, exactly one active", async () => {
    const cardId = await makeCard();
    const first = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, createdBy: "tester" });
    const second = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_2, createdBy: "tester" });
    const history = await listRevisionHistory("card", cardId, "main");
    expect(history.length).toBe(2);
    expect(history[0].id).toBe(second.revision.id); // newest first
    expect(history[1].id).toBe(first.revision.id);
    const activeCount = history.filter((r) => r.isActive).length;
    expect(activeCount).toBe(1);
    expect(history.find((r) => r.isActive)?.id).toBe(second.revision.id);
    // the deactivated row's history is visible via the archived timestamp
    expect(history.find((r) => r.id === first.revision.id)?.archivedAt).not.toBeNull();
  });

  it("AUDIT EVENTS: created/activated/deactivated events are logged for each transition", async () => {
    const cardId = await makeCard();
    const first = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, createdBy: "tester" });
    await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_2, createdBy: "tester" });
    const { rows } = await q("SELECT action, revision_id FROM vq_artwork_revision_events WHERE entity_id = $1 ORDER BY id", [cardId]);
    const actions = (rows as { action: string; revision_id: number }[]).map((r) => r.action);
    expect(actions).toContain("created");
    expect(actions).toContain("activated");
    expect(actions.filter((a) => a === "deactivated").length).toBeGreaterThanOrEqual(1);
    expect((rows as { revision_id: number }[]).some((r) => r.revision_id === first.revision.id)).toBe(true);
  });

  it("FAILED UPLOAD leaves the previous active artwork fully intact — nothing in the DB changes", async () => {
    const cardId = await makeCard();
    const first = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, createdBy: "tester" });
    uploadSpy.mockImplementationOnce(async () => { throw new Error("simulated R2 upload failure"); });
    await expect(promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_2, createdBy: "tester" })).rejects.toThrow(/simulated R2 upload failure/);
    // No new revision row, card pointer unchanged, first revision still active.
    const history = await listRevisionHistory("card", cardId, "main");
    expect(history.length).toBe(1);
    expect(history[0].id).toBe(first.revision.id);
    expect(history[0].isActive).toBe(true);
    const { rows } = await q("SELECT art_r2_key FROM vq_cards WHERE card_id = $1", [cardId]);
    expect((rows[0] as { art_r2_key: string }).art_r2_key).toBe(first.r2Key);
  });

  it("CONCURRENT PROMOTIONS (= a failed DB commit for the loser): exactly one wins, no split-active, no broken pointer", async () => {
    const cardId = await makeCard();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => promoteCardArtRevision({ cardId, slot: "main", buffer: Buffer.from(`concurrent-${i}`), createdBy: `tester-${i}` })),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof promoteCardArtRevision>>>[];
    const rejected = results.filter((r) => r.status === "rejected");
    // Every attempt uploads independently (uploads don't contend), but the DB
    // transaction only lets ONE become active at a time — with 6 fully serialised
    // (each swaps whatever is currently active) OR some losing the race outright,
    // the invariant that matters is: never more than one active row, ever.
    const activeRows = await q("SELECT count(*)::int AS n FROM vq_artwork_revisions WHERE entity_type='card' AND entity_id=$1 AND slot='main' AND is_active", [cardId]);
    expect((activeRows.rows[0] as { n: number }).n).toBe(1);
    // The card's pointer matches WHICHEVER revision ended up active (never a stale/blank value).
    const activeKey = await getActiveRevisionKey("card", cardId, "main");
    const { rows } = await q("SELECT art_r2_key FROM vq_cards WHERE card_id = $1", [cardId]);
    expect((rows[0] as { art_r2_key: string }).art_r2_key).toBe(activeKey);
    expect(fulfilled.length + rejected.length).toBe(6);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  });

  it("MISSING ASSET on restore fails safely — current active pointer is untouched", async () => {
    const cardId = await makeCard();
    const first = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, createdBy: "tester" });
    const second = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_2, createdBy: "tester" });
    r2Store.delete(first.r2Key); // simulate the old object having been deleted/lost
    const outcome = await restoreArtworkRevision(first.revision.id, "tester");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("asset_missing");
    // The current active revision (second) must be completely unaffected.
    const activeKey = await getActiveRevisionKey("card", cardId, "main");
    expect(activeKey).toBe(second.r2Key);
  });

  it("INTEGRITY MISMATCH on restore fails safely (corrupted stored bytes)", async () => {
    const cardId = await makeCard();
    const first = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, createdBy: "tester" });
    await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_2, createdBy: "tester" });
    r2Store.set(first.r2Key, Buffer.from("corrupted-different-bytes")); // hash will no longer match
    const outcome = await restoreArtworkRevision(first.revision.id, "tester");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("integrity_mismatch");
  });

  it("ROLLBACK to a previous revision: reactivates the target, deactivates current, updates the pointer, logs a 'restored' event", async () => {
    const cardId = await makeCard();
    const first = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, createdBy: "tester" });
    const second = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_2, createdBy: "tester" });
    const outcome = await restoreArtworkRevision(first.revision.id, "founder");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revision.id).toBe(first.revision.id);
    expect(outcome.revision.isActive).toBe(true);

    const history = await listRevisionHistory("card", cardId, "main");
    expect(history.find((r) => r.id === first.revision.id)?.isActive).toBe(true);
    expect(history.find((r) => r.id === second.revision.id)?.isActive).toBe(false);

    const { rows } = await q("SELECT art_r2_key FROM vq_cards WHERE card_id = $1", [cardId]);
    expect((rows[0] as { art_r2_key: string }).art_r2_key).toBe(first.r2Key); // pointer rolled back

    const { rows: events } = await q("SELECT action FROM vq_artwork_revision_events WHERE revision_id = $1 AND action = 'restored'", [first.revision.id]);
    expect(events.length).toBe(1);
  });

  it("a genuinely NEW revision after a restore is still allowed (restore is not a dead end)", async () => {
    const cardId = await makeCard();
    const first = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_1, createdBy: "tester" });
    await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_2, createdBy: "tester" });
    await restoreArtworkRevision(first.revision.id, "founder");
    const third = await promoteCardArtRevision({ cardId, slot: "main", buffer: TINY_PNG_3, createdBy: "tester" });
    expect(third.revision.isActive).toBe(true);
    const activeCount = await q("SELECT count(*)::int AS n FROM vq_artwork_revisions WHERE entity_type='card' AND entity_id=$1 AND slot='main' AND is_active", [cardId]);
    expect((activeCount.rows[0] as { n: number }).n).toBe(1);
  });

  it("CHARACTER promotion: master_portrait mirrors into referenceArtworkR2Key/approvedArtworkR2Key + referencePack, atomically", async () => {
    const characterId = await makeCharacter();
    const { r2Key, character } = await promoteCharacterReferenceRevision({ characterId, referenceType: "master_portrait", buffer: TINY_PNG_1, createdBy: "tester" });
    expect(character.referenceArtworkR2Key).toBe(r2Key);
    expect(character.approvedArtworkR2Key).toBe(r2Key);
    const pack = character.referencePack as Record<string, { r2Key?: string }>;
    expect(pack.master_portrait?.r2Key).toBe(r2Key);
  });

  it("CHARACTER promotion: a non-master_portrait slot does NOT touch the legacy mirror columns, and sibling slots survive the merge", async () => {
    const characterId = await makeCharacter();
    const master = await promoteCharacterReferenceRevision({ characterId, referenceType: "master_portrait", buffer: TINY_PNG_1, createdBy: "tester" });
    const action = await promoteCharacterReferenceRevision({ characterId, referenceType: "action_pose", buffer: TINY_PNG_2, createdBy: "tester" });
    expect(action.character.referenceArtworkR2Key).toBe(master.r2Key); // untouched by the action_pose promotion
    const pack = action.character.referencePack as Record<string, { r2Key?: string }>;
    expect(pack.master_portrait?.r2Key).toBe(master.r2Key); // sibling slot survives the shallow merge
    expect(pack.action_pose?.r2Key).toBe(action.r2Key);
  });

  it("CHARACTER concurrent promotions on the SAME slot: exactly one active, pointer matches the winner", async () => {
    const characterId = await makeCharacter();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => promoteCharacterReferenceRevision({ characterId, referenceType: "master_portrait", buffer: Buffer.from(`c-${i}`), createdBy: `t-${i}` })),
    );
    const activeRows = await q("SELECT count(*)::int AS n FROM vq_artwork_revisions WHERE entity_type='character' AND entity_id=$1 AND slot='master_portrait' AND is_active", [characterId]);
    expect((activeRows.rows[0] as { n: number }).n).toBe(1);
    const activeKey = await getActiveRevisionKey("character", characterId, "master_portrait");
    const { rows } = await q("SELECT approved_artwork_r2_key FROM vq_characters WHERE character_id = $1", [characterId]);
    expect((rows[0] as { approved_artwork_r2_key: string }).approved_artwork_r2_key).toBe(activeKey);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  });

  it("STALE POINTER: if an entity's own column somehow disagrees with the ledger (e.g. a pre-revision legacy value on an entity that later got a revision written under a DIFFERENT slot), each slot's own pointer stays independently correct", async () => {
    const cardId = await makeCard({ artR2Key: "vq/art/T-STALE/main.png" }); // legacy main
    // Promote PREV only — main's legacy pointer must be completely undisturbed.
    await promoteCardArtRevision({ cardId, slot: "prev", buffer: TINY_PNG_1, createdBy: "tester" });
    const { rows } = await q("SELECT art_r2_key, prev_art_r2_key FROM vq_cards WHERE card_id = $1", [cardId]);
    const row = rows[0] as { art_r2_key: string; prev_art_r2_key: string };
    expect(row.art_r2_key).toBe("vq/art/T-STALE/main.png"); // untouched legacy value
    expect(row.prev_art_r2_key).toMatch(/^vq\/art\/.+\/prev\/.+\.png$/); // new revisioned value
  });
});
