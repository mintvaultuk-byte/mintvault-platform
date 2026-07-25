import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ db: {} }));
vi.mock("../server/storage", () => ({ storage: { writeAuditLog: vi.fn(async () => {}) } }));

import {
  CustomSetEditError,
  type CustomSetEditorStore,
  type CustomSetRecord,
  editCustomSetDetails,
  normalizeCustomSetCode,
  normalizeCustomSetName,
  validateCustomSetEdit,
} from "../server/services/custom-set-editor";

const oldSet: CustomSetRecord = {
  setId: "mv1",
  setName: "Original Set",
  series: "Promo",
  releaseYear: 2024,
  totalCards: 10,
};

function makeStore(overrides: Partial<CustomSetEditorStore> = {}) {
  const store = {
    transaction: vi.fn(async (fn: (store: CustomSetEditorStore) => Promise<unknown>) =>
      fn(store as CustomSetEditorStore)
    ),
    getCustomSet: vi.fn(async () => oldSet),
    findByCode: vi.fn(async () => null),
    findIdentical: vi.fn(async () => null),
    updateCustomSet: vi.fn(async () => {}),
    countCertificatesForSet: vi.fn(async () => 3),
    writeAuditLog: vi.fn(async () => {}),
    ...overrides,
  } satisfies CustomSetEditorStore;
  return store;
}

describe("custom set editor", () => {
  it("normalizes set codes without creating duplicate code shapes", () => {
    expect(normalizeCustomSetCode(" MV 10 EN ")).toBe("mv10en");
  });

  it("normalizes set names across punctuation and repeated whitespace for duplicate checks", () => {
    expect(normalizeCustomSetName(" Pokémon  TCG: Classic - Charizard Deck ")).toBe(
      "pokemon tcg classic charizard deck"
    );
  });

  it("rejects blank names and blank codes", () => {
    expect(() => validateCustomSetEdit({ setId: "", setName: "Set" })).toThrow(CustomSetEditError);
    expect(() => validateCustomSetEdit({ setId: "mv2", setName: " " })).toThrow(CustomSetEditError);
  });

  it("rejects invalid year and non-integer or negative card counts", () => {
    expect(() => validateCustomSetEdit({ setId: "mv2", setName: "Set", releaseYear: 2024.5 })).toThrow(
      CustomSetEditError
    );
    expect(() => validateCustomSetEdit({ setId: "mv2", setName: "Set", totalCards: 12.5 })).toThrow(CustomSetEditError);
    expect(() => validateCustomSetEdit({ setId: "mv2", setName: "Set", totalCards: -1 })).toThrow(CustomSetEditError);
  });

  it("edits name, code, year, series, and card count on the existing record", async () => {
    const store = makeStore();
    const result = await editCustomSetDetails(
      store,
      "mv1",
      { setId: " MV2 ", setName: "Corrected Set", series: "Series A", releaseYear: 2025, totalCards: 12 },
      { user: "admin@example.com", role: "admin" }
    );

    expect(result).toMatchObject({
      setId: "mv2",
      setName: "Corrected Set",
      series: "Series A",
      releaseYear: 2025,
      totalCards: 12,
      certificatesUpdated: 0,
      linkedCertificates: 3,
    });
    expect(store.updateCustomSet).toHaveBeenCalledWith("mv1", {
      setId: "mv2",
      setName: "Corrected Set",
      series: "Series A",
      releaseYear: 2025,
      totalCards: 12,
    });
    expect(store.transaction).toHaveBeenCalledTimes(1);
  });

  it("allows retaining the current code when another field changes", async () => {
    const store = makeStore();
    await editCustomSetDetails(
      store,
      "mv1",
      { setId: "mv1", setName: "Renamed Set", series: "Promo", releaseYear: 2024, totalCards: 10 },
      { user: "admin", role: "admin" }
    );
    expect(store.findByCode).toHaveBeenCalledWith("mv1", "mv1");
    expect(store.updateCustomSet).toHaveBeenCalledWith(
      "mv1",
      expect.objectContaining({ setId: "mv1", setName: "Renamed Set" })
    );
  });

  it("rejects no-op edits without writing misleading audit entries", async () => {
    const store = makeStore();
    await expect(
      editCustomSetDetails(
        store,
        "mv1",
        { setId: "mv1", setName: "Original Set", series: "Promo", releaseYear: 2024, totalCards: 10 },
        { user: "admin", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(store.updateCustomSet).not.toHaveBeenCalled();
    expect(store.writeAuditLog).not.toHaveBeenCalled();
  });

  it("prevents duplicate code collisions", async () => {
    const store = makeStore({ findByCode: vi.fn(async () => ({ ...oldSet, setId: "mv2" })) });
    await expect(
      editCustomSetDetails(store, "mv1", { setId: "mv2", setName: "Corrected Set" }, { user: "admin", role: "admin" })
    ).rejects.toMatchObject({ status: 409 });
    expect(store.updateCustomSet).not.toHaveBeenCalled();
    expect(store.writeAuditLog).not.toHaveBeenCalled();
  });

  it("prevents duplicate identical set records", async () => {
    const store = makeStore({ findIdentical: vi.fn(async () => ({ ...oldSet, setId: "mv-other" })) });
    await expect(
      editCustomSetDetails(
        store,
        "mv1",
        { setId: "mv2", setName: "Original Set", series: "Promo", releaseYear: 2024, totalCards: 10 },
        { user: "admin", role: "admin" }
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(store.updateCustomSet).not.toHaveBeenCalled();
    expect(store.writeAuditLog).not.toHaveBeenCalled();
  });

  it("preserves certificate display snapshots and records an audit log", async () => {
    const store = makeStore();
    await editCustomSetDetails(
      store,
      "mv1",
      { setId: "mv1", setName: "Corrected Set", series: "Promo", releaseYear: 2024, totalCards: 10 },
      { user: "grader@example.com", role: "staff" }
    );

    expect(store.countCertificatesForSet).toHaveBeenCalledWith(oldSet);
    expect(store.writeAuditLog).toHaveBeenCalledWith(
      oldSet,
      expect.objectContaining({ setName: "Corrected Set" }),
      { user: "grader@example.com", role: "staff" },
      3
    );
  });

  it("surfaces audit failure instead of returning success from a partial update", async () => {
    const store = makeStore({ writeAuditLog: vi.fn(async () => Promise.reject(new Error("audit failed"))) });
    await expect(
      editCustomSetDetails(
        store,
        "mv1",
        { setId: "mv1", setName: "Corrected Set", series: "Promo", releaseYear: 2024, totalCards: 10 },
        { user: "admin", role: "admin" }
      )
    ).rejects.toThrow("audit failed");
    expect(store.transaction).toHaveBeenCalledTimes(1);
  });

  it("requires edit-sets capability for staff set edits and delegates to the canonical service", () => {
    const source = readFileSync("server/routes/grader.ts", "utf8");
    const route = source.slice(
      source.indexOf('app.patch("/api/staff/custom-sets/:setId"'),
      source.indexOf("// ── Shared admin+grader")
    );
    expect(route).toContain("s?.isAdmin");
    expect(route).toContain("s.capEditSets");
    expect(route).toContain("can_edit_sets");
    expect(route).not.toContain("capPrint");
    expect(route).not.toContain("capGrade");
    expect(route).toContain('updateSetLibraryRecord("custom"');
  });
});
