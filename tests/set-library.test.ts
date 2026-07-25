import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  execute: vi.fn(),
  txExecute: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("../server/db", () => ({
  db: {
    execute: mockDb.execute,
    transaction: mockDb.transaction,
  },
}));

import {
  listSetLibrary,
  normalizeSetNameKey,
  normalizeSetCode,
  recordSetReviewDecision,
  SetLibraryError,
  updateSetLibraryRecord,
  validateSetLibraryEdit,
} from "../server/services/set-library";

const baseSetRow = {
  source: "custom",
  set_id: "mv1",
  set_name: "Original Set",
  card_game: "pokemon",
  series: "Promo",
  release_year: 2024,
  total_cards: 10,
  subset: null,
  archived: false,
  updated_at: "2026-01-01T00:00:00.000Z",
  linked_cards: 2,
  linked_certificates: 3,
};

beforeEach(() => {
  mockDb.execute.mockReset();
  mockDb.txExecute.mockReset();
  mockDb.transaction.mockReset();
  mockDb.transaction.mockImplementation(async (fn: (tx: { execute: typeof mockDb.txExecute }) => Promise<unknown>) =>
    fn({ execute: mockDb.txExecute })
  );
});

function mockEnsureSchema(execute: ReturnType<typeof vi.fn>) {
  execute.mockResolvedValueOnce({ rows: [] });
  execute.mockResolvedValueOnce({ rows: [] });
  execute.mockResolvedValueOnce({ rows: [] });
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(query);
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown })?.value;
      if (Array.isArray(value)) return value.join("");
      if (typeof chunk === "string") return chunk;
      return "";
    })
    .join("");
}

describe("set library service", () => {
  it("normalizes set codes without creating duplicate code shapes", () => {
    expect(normalizeSetCode(" MV 10 EN ")).toBe("mv10en");
  });

  it("normalizes set names across punctuation variants for duplicate checks", () => {
    expect(normalizeSetNameKey("Pokémon Trading Card Game Classic - Charizard Deck")).toBe(
      "pokemon trading card game classic charizard deck"
    );
  });

  it("validates editable fields without allowing blank names, blank codes or invalid counts", () => {
    expect(() => validateSetLibraryEdit({ setId: "", setName: "Set" })).toThrow(SetLibraryError);
    expect(() => validateSetLibraryEdit({ setId: "mv2", setName: " " })).toThrow(SetLibraryError);
    expect(() => validateSetLibraryEdit({ setId: "mv2", setName: "Set", totalCards: -1 })).toThrow(SetLibraryError);
    expect(() => validateSetLibraryEdit({ setId: "mv2", setName: "Set", releaseYear: 2024.5 })).toThrow(
      SetLibraryError
    );
    expect(
      validateSetLibraryEdit({ setId: " MV2 ", setName: " Corrected ", totalCards: 0, reason: "Correction" })
    ).toMatchObject({
      setId: "mv2",
      setName: "Corrected",
      totalCards: 0,
    });
  });

  it("lists bounded set records with data-quality suggestions and numeric code sorting", async () => {
    mockEnsureSchema(mockDb.execute);
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        {
          ...baseSetRow,
          set_id: "mv10",
          set_name: "Example Trainer Gallery",
          release_year: null,
          total_cards: null,
          linked_cards: 0,
          linked_certificates: 0,
        },
        { ...baseSetRow, set_id: "mv2", set_name: "Alpha Set", linked_cards: 1, linked_certificates: 1 },
      ],
    });
    mockDb.execute.mockResolvedValueOnce({ rows: [] });

    const result = await listSetLibrary({ sort: "code_low_high", tab: "needs_attention" });

    expect(result.bounded).toBe(true);
    expect(result.sets.map((row) => row.setId)).toEqual(["mv10"]);
    expect(result.sets[0].issueLabels).toEqual(
      expect.arrayContaining(["Missing year", "Missing card count", "No linked cards or certificates"])
    );
    expect(result.sets[0].suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "subset_phrase_trainer_gallery",
          suggested: expect.objectContaining({ subset: "Trainer Gallery" }),
        }),
      ])
    );
  });

  it("persists ignored or rejected review decisions so dismissed suggestions no longer need attention", async () => {
    mockEnsureSchema(mockDb.execute);
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ ...baseSetRow, set_id: "mv10", set_name: "Example Trainer Gallery", release_year: null }],
    });
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ source: "custom", set_id: "mv10", suggestion_key: "missing_year" }],
    });

    const result = await listSetLibrary({ tab: "needs_attention" });

    expect(result.sets[0].suggestions.find((s) => s.key === "missing_year")?.dismissed).toBe(true);
    expect(result.sets[0].issueLabels).not.toContain("Missing year");
  });

  it("shows both source records in cross-source duplicate suggestions", async () => {
    mockEnsureSchema(mockDb.execute);
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        { ...baseSetRow, source: "custom", set_id: "mv1", set_name: "Shared Name" },
        { ...baseSetRow, source: "tcgdex", set_id: " MV1 ", set_name: "Shared Name" },
      ],
    });
    mockDb.execute.mockResolvedValueOnce({ rows: [] });

    const result = await listSetLibrary({ filters: "possible_duplicates" });
    const duplicateCode = result.sets[0].suggestions.find((suggestion) => suggestion.key === "duplicate_code");
    const duplicateName = result.sets[0].suggestions.find((suggestion) => suggestion.key === "possible_duplicate_name");

    expect(duplicateCode?.current.duplicateSources).toEqual(["custom:mv1", "tcgdex: MV1 "]);
    expect(duplicateName?.current.duplicateSources).toEqual(["custom:mv1", "tcgdex: MV1 "]);
  });

  it("updates an existing source row without changing its stable ID and records old/new audit details", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });

    const result = await updateSetLibraryRecord(
      "custom",
      "mv1",
      {
        setId: "mv1",
        setName: "Corrected Set",
        tcg: "pokemon",
        series: "Promo",
        releaseYear: 2025,
        totalCards: 12,
        subset: "Trainer Gallery",
        archived: false,
        reason: "Correct source data",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { id: "admin@example.com", role: "admin" }
    );

    expect(result).toMatchObject({
      ok: true,
      source: "custom",
      oldSetId: "mv1",
      linkedCardsUpdated: 0,
      certificatesUpdated: 0,
    });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    const updateSql =
      mockDb.txExecute.mock.calls.map((call) => sqlText(call[0])).find((text) => text.includes("UPDATE custom_sets")) ||
      "";
    const auditSql =
      mockDb.txExecute.mock.calls
        .map((call) => sqlText(call[0]))
        .find((text) => text.includes("INSERT INTO audit_log")) || "";
    expect(updateSql).toContain("UPDATE custom_sets");
    expect(updateSql).not.toContain("set_id =");
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE card_master"))).toBe(false);
    expect(auditSql).toContain("INSERT INTO audit_log");
    expect(auditSql).toContain("set_library_update");
  });

  it("rejects stale catalogue edits when the caller posts an old updatedAt version", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({
      rows: [{ ...baseSetRow, updated_at: "2026-01-02T00:00:00.000Z" }],
    });

    await expect(
      updateSetLibraryRecord(
        "custom",
        "mv1",
        {
          setId: "mv1",
          setName: "Corrected Set",
          tcg: "pokemon",
          updatedAt: "2026-01-01T00:00:00.000Z",
          reason: "Correction",
        },
        { id: "admin@example.com", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE custom_sets"))).toBe(false);
  });

  it("requires a reason and a current version before accepting a catalogue update", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });

    await expect(
      updateSetLibraryRecord(
        "custom",
        "mv1",
        { setId: "mv1", setName: "Corrected Set", tcg: "pokemon", reason: "Correction" },
        { id: "admin@example.com", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE custom_sets"))).toBe(false);
  });

  it("rejects attempts to change a stable set ID without touching linked cards", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });

    await expect(
      updateSetLibraryRecord(
        "custom",
        "mv1",
        {
          setId: "mv2",
          setName: "Renamed Set",
          tcg: "pokemon",
          reason: "Correction",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        { id: "admin@example.com", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE card_master"))).toBe(false);
  });

  it("uses a content version for active legacy card-set records", async () => {
    mockEnsureSchema(mockDb.txExecute);
    const legacy = { ...baseSetRow, source: "card_sets", updated_at: null };
    mockDb.txExecute.mockResolvedValueOnce({ rows: [legacy] });

    await expect(
      updateSetLibraryRecord(
        "card_sets",
        "mv1",
        { setId: "mv1", setName: "Corrected Set", tcg: "pokemon", reason: "Correction", version: "stale" },
        { id: "admin@example.com", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it("records approve/reject/ignore review decisions with audit trail", async () => {
    mockEnsureSchema(mockDb.execute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });

    await expect(
      recordSetReviewDecision("custom", "mv1", "subset_phrase_trainer_gallery", "reject", "Not a set correction", {
        id: "staff@example.com",
        role: "staff",
      })
    ).resolves.toEqual({ ok: true });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(sqlText(mockDb.txExecute.mock.calls[0][0])).toContain("set_review_decisions");
    expect(sqlText(mockDb.txExecute.mock.calls[1][0])).toContain("set_review_decision");
  });

  it("keeps admin and staff set-library routes behind the correct gates", () => {
    const adminRoutes = readFileSync("server/routes/admin-config.ts", "utf8");
    const staffRoutes = readFileSync("server/routes/staff.ts", "utf8");
    expect(adminRoutes).toContain('app.get("/api/admin/sets", requireAdmin');
    expect(adminRoutes).toContain('app.patch("/api/admin/sets/:source/:setId"');
    expect(adminRoutes).toContain("requireAdmin");
    expect(staffRoutes).toContain('app.get("/api/staff/sets", requireCapability("editSets")');
    expect(staffRoutes).toContain('"/api/staff/sets/:source/:setId"');
    expect(staffRoutes).toContain('requireCapability("editSets")');
    expect(staffRoutes).not.toContain(
      'requireCapability("grade"), async (req: Request, res: Response) => {\n    try {\n      return res.json(await listSetLibrary'
    );
  });
});
