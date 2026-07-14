/**
 * AI Creature Designer (Phase 2) — END-TO-END route wiring on the REAL admin router
 * + REAL vqStorage against the isolated local Postgres. The text provider is mocked
 * (canned concept JSON) so no external AI is called; Higgsfield + R2 are mocked and
 * ASSERTED never-called (concept generation and family creation are text-only).
 *
 * All test data is isolated under setCode "TST" so the canonical GNV set is untouched.
 *
 * Proves (spec test list): valid 3-stage concept from an idea; no Higgsfield/no R2;
 * approval creates exactly 1 family + 3 stages; rollback prevents partial creation;
 * duplicate family/stage names blocked; alternative-name generation; stages linked;
 * evolution descriptions stored; existing families unchanged; Stage 1 id returned for
 * auto-open; stage descriptions approved (the artwork handoff input).
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

// Higgsfield + R2 — mocked and asserted NEVER called (text-only pipeline).
const higgsSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateHiggsfieldArtwork: higgsSpy };
});
const r2UploadSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/r2", () => ({
  uploadToR2: r2UploadSpy,
  getR2Buffer: vi.fn(async () => null),
  getR2ObjectStream: vi.fn(async () => null),
}));

// Text provider — canned concept JSON so generateFamilyConcept's real parse/guard runs.
const completeSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/provider", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getTextProvider: () => ({ id: "anthropic", model: "test-model", complete: completeSpy }) };
});

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";
import { CONCEPT_STAGE_DRAWABLE_KEYS, type FamilyConcept } from "@shared/vq-creature-concept";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// Build a full, valid concept (all fields populated) for a given family + stage names.
function buildConcept(familyName: string, stageNames: [string, string, string], element = "Flame"): FamilyConcept {
  const stage = (n: 1 | 2 | 3, name: string) => {
    const drawable = Object.fromEntries(CONCEPT_STAGE_DRAWABLE_KEYS.map((k) => [k, `${k} for ${name}`]));
    return {
      stageNumber: n, name,
      shortDescription: `${name} short`, signatureAbility: `${name} ability`, flavourText: `${name} flavour`,
      ...drawable,
      stageProgressionNotes: n === 1 ? "establishing baby form" : `evolves from stage ${n - 1}: bigger body, developed silhouette`,
    } as FamilyConcept["stages"][number];
  };
  return {
    family: { name: familyName, element, theme: "theme", evolutionDirection: "grows bigger", palette: "warm oranges", sharedTraits: "amber eyes", lore: "a gentle line of flame creatures" },
    stages: [stage(1, stageNames[0]), stage(2, stageNames[1]), stage(3, stageNames[2])],
  };
}
const conceptJson = (c: FamilyConcept) => JSON.stringify(c);

async function cleanTst() {
  await q("DELETE FROM vq_ai_generations WHERE kind = 'family-concept'", []);
  await q("DELETE FROM vq_characters WHERE set_code = 'TST' OR character_id LIKE 'TST-%'", []);
  await q("DELETE FROM vq_cards WHERE set_code = 'TST' OR card_id LIKE 'TST-%'", []);
  await q("DELETE FROM vq_families WHERE set_code = 'TST' OR family_id LIKE 'TST-%'", []);
}

run("AI Creature Designer — routes + real storage + local Postgres", () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    registerVaultQuestAdminRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); });
    });
  });
  beforeEach(async () => { higgsSpy.mockReset(); r2UploadSpy.mockReset(); completeSpy.mockReset(); await cleanTst(); });
  afterAll(async () => { await cleanTst(); await new Promise<void>((r) => server.close(() => r())); await (pool as unknown as { end: () => Promise<void> }).end(); });

  it("idea → a valid 3-stage concept; NO Higgsfield call, NO R2 write", async () => {
    completeSpy.mockResolvedValueOnce(conceptJson(buildConcept("Petalpuff", ["Budling", "Bloomkin", "Petalpuff"])));
    const res = await post("/api/admin/vault-quest/creature-concept", { idea: "a tiny soft cuddly flower creature that loves hugs" });
    expect(res.status).toBe(200);
    const concept = (res.json as { concept: FamilyConcept }).concept;
    expect(concept.stages).toHaveLength(3);
    expect(concept.family.name).toBe("Petalpuff");
    expect(concept.stages[1].stageProgressionNotes).toMatch(/evolves from/i);
    expect(higgsSpy).not.toHaveBeenCalled();
    expect(r2UploadSpy).not.toHaveBeenCalled();
  });

  it("approval creates EXACTLY one family + three linked stages, descriptions approved, audit recorded; NO Higgsfield/R2", async () => {
    const concept = buildConcept("Emberling", ["Sparky", "Blazepup", "Emberling"]);
    const res = await post("/api/admin/vault-quest/families/from-concept", { concept, setCode: "TST", founderInput: { idea: "fire pup" } });
    expect(res.status).toBe(201);
    const body = res.json as { ok: true; familyId: string; stageCharacterIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.familyId).toBe("TST-F01");
    expect(body.stageCharacterIds[0]).toBe("TST-F01-S1"); // Simple mode opens this

    const fam = await q("SELECT * FROM vq_families WHERE set_code = 'TST'", []);
    expect(fam.rows).toHaveLength(1);
    const cards = await q("SELECT * FROM vq_cards WHERE set_code = 'TST' ORDER BY stage_number", []);
    expect(cards.rows).toHaveLength(3);
    const chars = await q("SELECT character_id, stage_number, evolves_from_character_id, description_status, stage_progression_notes FROM vq_characters WHERE set_code = 'TST' ORDER BY stage_number", []);
    expect(chars.rows).toHaveLength(3);
    const rows = chars.rows as { character_id: string; stage_number: number; evolves_from_character_id: string | null; description_status: string; stage_progression_notes: string }[];
    expect(rows[0].evolves_from_character_id).toBeNull();
    expect(rows[1].evolves_from_character_id).toBe("TST-F01-S1"); // links correct
    expect(rows[2].evolves_from_character_id).toBe("TST-F01-S2");
    expect(rows.every((r) => r.description_status === "approved")).toBe(true); // artwork handoff input
    expect(rows[1].stage_progression_notes).toMatch(/evolves from/i); // evolution description stored

    const audit = await q("SELECT * FROM vq_ai_generations WHERE kind = 'family-concept'", []);
    expect(audit.rows.length).toBe(1);
    expect(higgsSpy).not.toHaveBeenCalled();
    expect(r2UploadSpy).not.toHaveBeenCalled();
  });

  it("duplicate FAMILY name is blocked (409 collision) — nothing created", async () => {
    await q(`INSERT INTO vq_families (family_id, set_code, element, name) VALUES ('TST-F09','TST','Flame','Dupey')`, []);
    const concept = buildConcept("Dupey", ["A one", "B two", "C three"]);
    const res = await post("/api/admin/vault-quest/families/from-concept", { concept, setCode: "TST" });
    expect(res.status).toBe(409);
    expect((res.json as { reason: string }).reason).toBe("collision");
    // only the seeded family exists; no new one was created
    const fam = await q("SELECT * FROM vq_families WHERE set_code = 'TST'", []);
    expect(fam.rows).toHaveLength(1);
  });

  it("duplicate STAGE name is blocked (409 collision)", async () => {
    await q(`INSERT INTO vq_families (family_id, set_code, element, name) VALUES ('TST-F09','TST','Flame','Otherfam')`, []);
    await q(`INSERT INTO vq_cards (card_id, collector_number, name, card_type, element, set_code) VALUES ('TST-900','900/900','Clashy','Creature','Flame','TST')`, []);
    await q(`INSERT INTO vq_characters (character_id, set_code, family_id, card_id, stage_number, character_name, element) VALUES ('TST-F09-S1','TST','TST-F09','TST-900',1,'Clashy','Flame')`, []);
    const concept = buildConcept("Freshfam", ["Clashy", "B two", "C three"]);
    const res = await post("/api/admin/vault-quest/families/from-concept", { concept, setCode: "TST" });
    expect(res.status).toBe(409);
    expect((res.json as { conflicts: string[] }).conflicts.join(" ")).toMatch(/stage name/i);
  });

  it("transaction ROLLS BACK on a mid-transaction id clash — no partial family", async () => {
    // Pre-seed the character id the transaction will try to create for stage 3, so its
    // insert conflicts and the WHOLE transaction rolls back.
    await q(`INSERT INTO vq_families (family_id, set_code, element, name) VALUES ('TST-OTHER','TST','Flame','Otherfam')`, []);
    await q(`INSERT INTO vq_cards (card_id, collector_number, name, card_type, element, set_code) VALUES ('TST-DUMMY','1/1','Dummy','Creature','Flame','TST')`, []);
    await q(`INSERT INTO vq_characters (character_id, set_code, family_id, card_id, stage_number, character_name, element) VALUES ('TST-F01-S3','TST','TST-OTHER','TST-DUMMY',3,'Prehog','Flame')`, []);
    const concept = buildConcept("Rollbackfam", ["Rb one", "Rb two", "Rb three"]);
    const res = await post("/api/admin/vault-quest/families/from-concept", { concept, setCode: "TST" });
    expect(res.status).toBe(409);
    expect((res.json as { reason: string }).reason).toBe("exists");
    // The family TST-F01 must NOT exist and none of its cards were created.
    const fam = await q("SELECT * FROM vq_families WHERE family_id = 'TST-F01'", []);
    expect(fam.rows).toHaveLength(0);
    const partialChars = await q("SELECT * FROM vq_characters WHERE family_id = 'TST-F01'", []);
    expect(partialChars.rows).toHaveLength(0);
  });

  it("alternative-name generation returns non-colliding names", async () => {
    await q(`INSERT INTO vq_families (family_id, set_code, element, name) VALUES ('TST-F09','TST','Flame','Clashy')`, []);
    const res = await post("/api/admin/vault-quest/creature-concept/alt-names", { familyName: "Clashy", stageNames: ["Clashy I", "Clashy II", "Clashy III"], setCode: "TST" });
    expect(res.status).toBe(200);
    const sugg = res.json as { familyName: string; stageNames: string[] };
    expect(sugg.familyName).not.toBe("Clashy");
    expect(sugg.stageNames).toHaveLength(3);
  });

  it("per-field SUGGEST returns a list for that field; ONE text call; NO Higgsfield/R2", async () => {
    completeSpy.mockResolvedValueOnce(JSON.stringify({ suggestions: ["Fluffi", "Pufflet", "Floofi", "Pompom", "Mosskin", "Petali", "Bloomi", "Cotti"] }));
    const res = await post("/api/admin/vault-quest/creature-concept/suggest", { field: "stage_name", context: { familyName: "Petalpuff", stageNumber: 1 } });
    expect(res.status).toBe(200);
    const body = res.json as { field: string; suggestions: string[] };
    expect(body.field).toBe("stage_name");
    expect(body.suggestions.length).toBeGreaterThanOrEqual(5);
    expect(completeSpy).toHaveBeenCalledTimes(1); // one small request
    expect(higgsSpy).not.toHaveBeenCalled();
    expect(r2UploadSpy).not.toHaveBeenCalled();
  });

  it("SUGGEST for a DIFFERENT field is an independent request (its own list)", async () => {
    completeSpy.mockResolvedValueOnce(JSON.stringify({ suggestions: ["Petal Burst", "Flower Shield", "Cotton Hug", "Pollen Dance"] }));
    const res = await post("/api/admin/vault-quest/creature-concept/suggest", { field: "signature_ability", context: { stageName: "Petalpuff" } });
    expect(res.status).toBe(200);
    expect((res.json as { suggestions: string[] }).suggestions).toContain("Petal Burst");
    expect(completeSpy).toHaveBeenCalledTimes(1); // only the ability call — nothing else regenerated
  });

  it("SUGGEST rejects an unknown field (400)", async () => {
    const res = await post("/api/admin/vault-quest/creature-concept/suggest", { field: "not_a_field" });
    expect(res.status).toBe(400);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("existing families in OTHER sets are unchanged by a creation", async () => {
    const before = await q("SELECT count(*)::int AS n FROM vq_families WHERE set_code = 'GNV'", []);
    const beforeN = (before.rows[0] as { n: number }).n;
    const concept = buildConcept("Isolatedfam", ["Iso1", "Iso2", "Iso3"]);
    const res = await post("/api/admin/vault-quest/families/from-concept", { concept, setCode: "TST" });
    expect(res.status).toBe(201);
    const after = await q("SELECT count(*)::int AS n FROM vq_families WHERE set_code = 'GNV'", []);
    expect((after.rows[0] as { n: number }).n).toBe(beforeN); // GNV untouched
  });
});
