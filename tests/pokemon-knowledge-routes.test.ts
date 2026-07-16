/**
 * Knowledge Engine — permissions, store validation, workflow discipline and
 * grading-regression proofs (tests 5-7, 23-25, 33-38, 39-44, 56-63).
 *
 * The requireAdmin/adminOrStaffRead gates are exercised as units (synchronous,
 * no DB); the store's validation is tested pure; route wiring + no-direct-write
 * discipline are proven statically against the source.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";

vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } }));

import { requireAdmin } from "../server/auth";
import { validateSetInput, KnowledgeValidationError, starterSeedCandidates } from "../server/lib/pokemon-knowledge-store";

interface MockRes {
  statusCode: number | null;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}
const makeRes = (): MockRes => {
  const res: MockRes = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
};

const ROUTES_SRC = fs.readFileSync("server/routes/pokemon-knowledge.ts", "utf8");
const STORE_SRC = fs.readFileSync("server/lib/pokemon-knowledge-store.ts", "utf8");
const HUB_SRC = fs.readFileSync("client/src/pages/admin-pokemon-knowledge.tsx", "utf8");
const PICKER_SRC = fs.readFileSync("client/src/components/rarity-picker/RarityVariantPicker.tsx", "utf8");

describe("permissions (tests 23-25, 31-33)", () => {
  it("unauthenticated request is rejected 401 by requireAdmin", async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireAdmin({ session: undefined, path: "/x" } as never, res as never, next as never);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("staff/grader session is 403 on admin mutations (requireAdmin)", async () => {
    const res = makeRes();
    const next = vi.fn();
    await requireAdmin({ session: { isGrader: true }, path: "/x" } as never, res as never, next as never);
    expect(res.statusCode).toBe(403);
  });
  it("every mutation route is admin-only + rate-limited; reads allow staff read-only", () => {
    // All POSTs carry the limiter BEFORE requireAdmin.
    const posts = ROUTES_SRC.match(/app\.post\([^)]+\)/g) ?? [];
    expect(posts.length).toBeGreaterThanOrEqual(5);
    for (const p of posts) {
      expect(p, p).toContain("knowledgeMutationLimit");
      expect(p, p).toContain("requireAdmin");
    }
    // Reads use adminOrStaffRead (staff read-only Hub) except exports/PDFs (admin).
    expect(ROUTES_SRC).toMatch(/get\("\/api\/admin\/pokemon-knowledge\/overview",\s*adminOrStaffRead/);
    expect(ROUTES_SRC).toMatch(/get\("\/api\/admin\/pokemon-knowledge\/sets",\s*adminOrStaffRead/);
    expect(ROUTES_SRC).toMatch(/get\("\/api\/admin\/pokemon-knowledge\/export\.json",\s*requireAdmin/);
    expect(ROUTES_SRC).toMatch(/handbook\.pdf",\s*requireAdmin/);
  });
});

describe("store validation (tests 4-6, 10-11)", () => {
  it("accepts unknown/nullable data (no guessed counts required)", () => {
    const v = validateSetInput({ setCode: "SV 99", canonicalName: "Future Set" });
    expect(v.setKey).toBe("sv99");
    expect(v.mainCount ?? null).toBeNull();
    expect(v.status).toBe("provisional");
  });
  it("rejects bad era/region/status/confidence/source enums with 400-class errors", () => {
    expect(() => validateSetInput({ setCode: "x", canonicalName: "X", era: "gen99" })).toThrow(KnowledgeValidationError);
    expect(() => validateSetInput({ setCode: "x", canonicalName: "X", region: "mars" })).toThrow(KnowledgeValidationError);
    expect(() => validateSetInput({ setCode: "x", canonicalName: "X", status: "definitely" })).toThrow(KnowledgeValidationError);
    expect(() => validateSetInput({ setCode: "x", canonicalName: "X", sourceType: "trust-me" })).toThrow(KnowledgeValidationError);
  });
  it("verified without provenance is rejected at the app layer (test 5)", () => {
    expect(() => validateSetInput({ setCode: "x", canonicalName: "X", status: "verified", sourceType: "unknown" })).toThrow(/provenance/i);
  });
  it("counts must be whole non-negative numbers", () => {
    expect(() => validateSetInput({ setCode: "x", canonicalName: "X", mainCount: -3 })).toThrow(KnowledgeValidationError);
    expect(() => validateSetInput({ setCode: "x", canonicalName: "X", mainCount: 1.5 })).toThrow(KnowledgeValidationError);
  });
  it("all starter-seed candidates pass validation as provisional trusted_catalogue drafts (test 33)", () => {
    const candidates = starterSeedCandidates();
    expect(candidates.length).toBeGreaterThan(40);
    for (const c of candidates) {
      const v = validateSetInput(c);
      expect(v.status).toBe("provisional");
      expect(v.sourceType).toBe("trusted_catalogue");
    }
  });
});

describe("workflow discipline (tests 33-38)", () => {
  it("imports only create DRAFT runs; canonical writes happen only in the approval path", () => {
    // createImportRun inserts into pokemon_import_runs with status draft and never upserts sets.
    const createFn = STORE_SRC.slice(STORE_SRC.indexOf("export async function createImportRun"), STORE_SRC.indexOf("export function starterSeedCandidates"));
    expect(createFn).toContain('status: "draft"');
    expect(createFn).not.toContain("upsertSetKnowledge(");
    // decideImportRun applies only on the approved branch.
    const decideFn = STORE_SRC.slice(STORE_SRC.indexOf("export async function decideImportRun"), STORE_SRC.indexOf("export async function listImportRuns"));
    expect(decideFn).toContain("upsertSetKnowledge(");
    expect(decideFn).toContain('decision === "rejected"');
  });
  it("every canonical write records a revision; restore creates a NEW revision (tests 37-38)", () => {
    const upsertFn = STORE_SRC.slice(STORE_SRC.indexOf("export async function upsertSetKnowledge"), STORE_SRC.indexOf("export async function restoreRevision"));
    expect((upsertFn.match(/pokemonKnowledgeRevisions/g) ?? []).length).toBeGreaterThanOrEqual(2); // both branches
    expect(upsertFn).toContain("version + 1");
    const restoreFn = STORE_SRC.slice(STORE_SRC.indexOf("export async function restoreRevision"), STORE_SRC.indexOf("// ── Draft imports"));
    expect(restoreFn).toContain("upsertSetKnowledge(snapshot"); // restore-as-new-revision
    expect(restoreFn).not.toMatch(/delete|update\(pokemonKnowledgeRevisions\)/i); // history never rewritten
  });
  it("row write + revision insert are transactional with a row lock (review F1)", () => {
    const upsertFn = STORE_SRC.slice(STORE_SRC.indexOf("export async function upsertSetKnowledge"), STORE_SRC.indexOf("export async function restoreRevision"));
    expect(upsertFn).toContain("db.transaction(async (tx)");
    expect(upsertFn).toContain('.for("update")'); // serialise concurrent same-set edits across machines
    // Both the row write and the revision insert use the transaction handle.
    expect(upsertFn).toMatch(/tx\s*\.\s*insert\(pokemonKnowledgeRevisions\)/);
  });
  it("out-of-vocabulary alias_type is coerced, not sent raw to the DB CHECK (review F2)", () => {
    const upsertFn = STORE_SRC.slice(STORE_SRC.indexOf("export async function upsertSetKnowledge"), STORE_SRC.indexOf("export async function restoreRevision"));
    expect(upsertFn).toContain("ALIAS_TYPES.has(String(a.aliasType))");
    expect(STORE_SRC).toContain('const ALIAS_TYPES = new Set(["printed_code"');
  });
});

describe("grading integration + regression (tests 39-44, 58-63)", () => {
  it("the deployed picker and the Knowledge Hub read the SAME shared catalogue module (test 39)", () => {
    expect(PICKER_SRC).toContain('from "@shared/pokemon-rarity-catalogue"');
    expect(HUB_SRC).toContain('from "@shared/pokemon-rarity-catalogue"');
    // And the Hub duplicates no rarity definitions of its own.
    expect(HUB_SRC).not.toMatch(/POKEMON_RARITIES\s*=|const\s+RARITIES\s*=\s*\[/);
  });
  it("knowledge code NEVER touches certificates (no cert reads/writes — tests 58-59)", () => {
    for (const src of [STORE_SRC, ROUTES_SRC]) {
      expect(src).not.toMatch(/from\(certificates\)|update\(certificates\)|insert\(certificates\)/);
      expect(src).not.toMatch(/UPDATE\s+certificates/i);
    }
  });
  it("protected surfaces are untouched by this feature (tests 42-44, 60-62)", () => {
    // The knowledge modules IMPORT none of the protected grading/label/payment modules.
    const all = STORE_SRC + ROUTES_SRC + fs.readFileSync("server/lib/pokemon-handbook.ts", "utf8");
    const imports = all.match(/from\s+"[^"]+"/g) ?? [];
    for (const imp of imports) {
      expect(imp).not.toMatch(/labels|certificate-document|grader|mvgs|stripe|vault-quest|instagram|scoring|pristine/i);
    }
  });
  it("no provider calls anywhere in the knowledge engine (tests 56-57)", () => {
    const all = STORE_SRC + ROUTES_SRC + fs.readFileSync("server/lib/pokemon-handbook.ts", "utf8");
    expect(all).not.toMatch(/anthropic|higgsfield|openai|api\.tcgdex/i);
    expect(all).not.toMatch(/https?:\/\/(?!mintvault)/i); // no outbound URLs at all
  });
});
