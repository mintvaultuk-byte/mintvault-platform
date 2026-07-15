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

  it("validates editable fields without allowing blank names, blank codes or invalid counts", () => {
    expect(() => validateSetLibraryEdit({ setId: "", setName: "Set" })).toThrow(SetLibraryError);
    expect(() => validateSetLibraryEdit({ setId: "mv2", setName: " " })).toThrow(SetLibraryError);
    expect(() => validateSetLibraryEdit({ setId: "mv2", setName: "Set", totalCards: -1 })).toThrow(SetLibraryError);
    expect(() => validateSetLibraryEdit({ setId: "mv2", setName: "Set", releaseYear: 2024.5 })).toThrow(
      SetLibraryError
    );
    expect(validateSetLibraryEdit({ setId: " MV2 ", setName: " Corrected ", totalCards: 0 })).toMatchObject({
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

  it("updates an existing source row, prevents duplicate creation, and records old/new audit details", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });

    const result = await updateSetLibraryRecord(
      "custom",
      "mv1",
      {
        setId: "mv2",
        setName: "Corrected Set",
        tcg: "pokemon",
        series: "Promo",
        releaseYear: 2025,
        totalCards: 12,
        subset: "Trainer Gallery",
        archived: false,
        reason: "Correct source data",
        confirmLinkedCardUpdate: true,
      },
      { id: "admin@example.com", role: "admin" }
    );

    expect(result).toMatchObject({
      ok: true,
      source: "custom",
      oldSetId: "mv1",
      linkedCardsUpdated: 2,
      certificatesUpdated: 0,
    });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.txExecute).toHaveBeenCalledTimes(10);
    const updateSql = sqlText(mockDb.txExecute.mock.calls[6][0]);
    const linkedCardsSql = sqlText(mockDb.txExecute.mock.calls[8][0]);
    const auditSql = sqlText(mockDb.txExecute.mock.calls[9][0]);
    expect(updateSql).toContain("UPDATE custom_sets");
    expect(linkedCardsSql).toContain("UPDATE card_master");
    expect(auditSql).toContain("INSERT INTO audit_log");
    expect(auditSql).toContain("set_library_update");
  });

  it("rejects duplicate code collisions before writing a set update", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [{ source: "tcgdex", set_id: "mv2" }] });

    await expect(
      updateSetLibraryRecord(
        "custom",
        "mv1",
        { setId: "mv2", setName: "Corrected Set", tcg: "pokemon" },
        { id: "admin@example.com", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE custom_sets"))).toBe(false);
  });

  it("blocks code collisions across every set source", async () => {
    for (const [source, collision] of [
      ["custom", "tcgdex"],
      ["custom", "card_sets"],
      ["tcgdex", "card_sets"],
    ] as const) {
      mockDb.txExecute.mockReset();
      mockEnsureSchema(mockDb.txExecute);
      mockDb.txExecute.mockResolvedValueOnce({ rows: [{ ...baseSetRow, source }] });
      mockDb.txExecute.mockResolvedValueOnce({ rows: [{ source: collision, set_id: " MV2 " }] });

      await expect(
        updateSetLibraryRecord(
          source,
          "mv1",
          { setId: " mv2 ", setName: "Corrected Set", tcg: "pokemon" },
          { id: "admin@example.com", role: "admin" }
        )
      ).rejects.toMatchObject({ status: 409 });
      expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE card_master"))).toBe(false);
    }
  });

  it("allows retaining the current code while editing another field", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });

    await expect(
      updateSetLibraryRecord(
        "custom",
        " MV1 ",
        { setId: "mv1", setName: "Renamed Set", tcg: "pokemon", series: "Promo", releaseYear: 2024, totalCards: 10 },
        { id: "admin@example.com", role: "admin" }
      )
    ).resolves.toMatchObject({ ok: true, linkedCardsUpdated: 0 });
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE card_master"))).toBe(false);
  });

  it("requires explicit linked-card confirmation before changing a code with cards", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });

    await expect(
      updateSetLibraryRecord(
        "custom",
        "mv1",
        { setId: "mv2", setName: "Corrected Set", tcg: "pokemon" },
        { id: "admin@example.com", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE card_master"))).toBe(false);
  });

  it("blocks ambiguous card-master rewrites when the old code exists in another source", async () => {
    mockEnsureSchema(mockDb.txExecute);
    mockDb.txExecute.mockResolvedValueOnce({ rows: [baseSetRow] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [] });
    mockDb.txExecute.mockResolvedValueOnce({ rows: [{ source: "tcgdex", set_id: "mv1" }] });

    await expect(
      updateSetLibraryRecord(
        "custom",
        "mv1",
        { setId: "mv2", setName: "Corrected Set", tcg: "pokemon", confirmLinkedCardUpdate: true },
        { id: "admin@example.com", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(mockDb.txExecute.mock.calls.some((call) => sqlText(call[0]).includes("UPDATE card_master"))).toBe(false);
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
