import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  VQ_CARD_FACTORY_BANNED_TERMS,
  VQ_CARD_FACTORY_ELEMENTS,
  VQ_CARD_FACTORY_GEOMETRY,
  VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT,
  VQ_CARD_FACTORY_TEMPLATE_VERSION,
  normalizeVqFactoryPlacement,
  normalizeVqFactoryElement,
  normalizeVqFactoryName,
  VQ_STANDARD_CARD_SPECS,
  detectVqBannedTerms,
  getVqStandardSpec,
  validateVqFactoryCard,
  vqFactoryFilename,
  type VqFactoryValidationInput,
} from "../shared/vq-card-factory";
import { renderCard, type RenderCardInput } from "../server/vault-quest/render-service";
import { VQ_ELEMENTS, VQ_LOCK } from "../server/vault-quest/lib/vq-constants";
import { vqStorage } from "../server/vault-quest/storage";
import type { VqCardRow, VqCharacter, VqFamily } from "../shared/vq-schema";

vi.mock("../server/db", () => ({ db: {}, pool: { end: vi.fn() } }));

const repoRoot = path.resolve(__dirname, "..");

function validInput(overrides: Partial<VqFactoryValidationInput> = {}): VqFactoryValidationInput {
  return {
    collectorNumber: "001",
    name: "Flammi",
    stage: 1,
    familyId: "GNV-F01",
    element: "Flame",
    health: 4,
    guard: 1,
    shift: 1,
    previousStage: null,
    attack1Name: "Ember Seal",
    attack1Cost: 1,
    attack1Damage: 2,
    attack1Effect: "Shift one Core Seal toward the active row.",
    attack2Name: null,
    attack2Cost: null,
    attack2Damage: null,
    attack2Effect: null,
    vulnerability: "Tide",
    rarity: "Common",
    edition: "First Edition",
    year: 2026,
    artR2Key: "vq/art/GNV-001/main.png",
    prevArtR2Key: null,
    artworkApproved: true,
    status: "draft",
    ...overrides,
  };
}

function issueCodes(input: VqFactoryValidationInput) {
  const spec = getVqStandardSpec(input.collectorNumber);
  expect(spec).toBeTruthy();
  return validateVqFactoryCard(spec!, input, [input]).map((issue) => issue.code);
}

describe("Vault Quest Card Factory set plan", () => {
  it("locks the Standard 001-036 creature family list and elements", () => {
    expect(VQ_STANDARD_CARD_SPECS).toHaveLength(36);
    expect(VQ_STANDARD_CARD_SPECS.map((card) => card.collectorNumber)).toEqual(
      Array.from({ length: 36 }, (_, index) => String(index + 1).padStart(3, "0"))
    );
    expect(new Set(VQ_STANDARD_CARD_SPECS.map((card) => card.character)).size).toBe(36);
    expect(VQ_STANDARD_CARD_SPECS.at(0)?.character).toBe("Flammi");
    expect(VQ_STANDARD_CARD_SPECS.at(-1)?.character).toBe("Shardor");
    expect(VQ_STANDARD_CARD_SPECS.at(0)?.cardId).toBe("GNV-001");
    expect(VQ_STANDARD_CARD_SPECS.at(0)?.familyId).toBe("GNV-F01");
    expect(VQ_STANDARD_CARD_SPECS.map((card) => card.stage)).toEqual(
      Array.from({ length: 12 }, () => [1, 2, 3]).flat()
    );
    expect(VQ_CARD_FACTORY_ELEMENTS).toEqual(["Terra", "Volt", "Tide", "Flame", "Gale", "Crystal"]);
    for (const element of VQ_CARD_FACTORY_ELEMENTS) {
      expect(VQ_ELEMENTS[element]).toBeTruthy();
    }
  });

  it("declares manufacturer readiness as pending rather than printer-certified", () => {
    expect(VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT.warning).toBe(
      "Internal print proof — manufacturer specification pending"
    );
    expect(VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT.requiredDpi).toBeNull();
    expect(VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT.colourProfile).toBeNull();
  });

  it("keeps the requested manufacturing geometry and live canonical template explicit", () => {
    expect(VQ_CARD_FACTORY_GEOMETRY).toEqual({
      canvasMm: { width: 69, height: 94 },
      trimMm: { width: 63, height: 88 },
      centralArtMm: { width: 60, height: 85 },
      bleedMm: 3,
      visibleBorderMm: 3,
      orientation: "portrait",
    });
    expect(VQ_LOCK.canvas_mm).toEqual([69, 94]);
    expect(VQ_LOCK.trim_mm).toEqual([63, 88]);
    expect(VQ_LOCK.bleed_mm).toBe(3);
    expect(VQ_CARD_FACTORY_TEMPLATE_VERSION).toBe("VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.2.1_STAGE_LOCK");
  });

  it("uses safe deterministic GV export filenames without accepting traversal", () => {
    const spec = getVqStandardSpec("001");
    expect(spec).toBeTruthy();
    expect(vqFactoryFilename(spec!, "front")).toBe("GV_001_Flammi_Stage1_front_v1.png");
    expect(vqFactoryFilename({ ...spec!, character: "../Flammi\nBad" }, "back", 7, "pdf")).toBe(
      "GV_001_Flammi-Bad_Stage1_back_v7.pdf"
    );
  });
});

describe("Vault Quest Card Factory validation", () => {
  it("accepts the six approved Phase 1 elements and legacy labels that map to them", () => {
    expect(VQ_CARD_FACTORY_ELEMENTS).toEqual(["Terra", "Volt", "Tide", "Flame", "Gale", "Crystal"]);
    expect(normalizeVqFactoryElement("Blaze")).toBe("Flame");
    expect(normalizeVqFactoryElement("Water")).toBe("Tide");
    expect(normalizeVqFactoryElement("Nature")).toBe("Terra");
    expect(normalizeVqFactoryElement("Storm")).toBe("Volt");
    expect(normalizeVqFactoryElement("Wind")).toBe("Gale");
    for (const element of VQ_CARD_FACTORY_ELEMENTS) {
      const spec = VQ_STANDARD_CARD_SPECS.find((card) => card.element === element)!;
      const input = validInput({
        collectorNumber: spec.collectorNumber,
        name: spec.character,
        familyId: spec.familyId,
        stage: spec.stage,
        previousStage: spec.expectedPreviousName,
        prevArtR2Key: spec.stage === 1 ? null : `vq/art/${spec.collectorNumber}-prev.png`,
        element,
      });
      expect(validateVqFactoryCard(spec, input, [input]).map((issue) => issue.code)).not.toContain("invalid_element");
    }
  });

  it("accepts every locked Standard creature name, including the Breezi line", () => {
    expect(normalizeVqFactoryName("Breezy")).toBe("Breezi");
    expect(normalizeVqFactoryName("Breezella")).toBe("Breezelle");
    for (const spec of VQ_STANDARD_CARD_SPECS) {
      const input = validInput({
        collectorNumber: spec.collectorNumber,
        name: spec.character,
        familyId: spec.familyId,
        stage: spec.stage,
        element: spec.element,
        previousStage: spec.expectedPreviousName,
        prevArtR2Key: spec.stage === 1 ? null : `vq/art/${spec.collectorNumber}-prev.png`,
      });
      expect(validateVqFactoryCard(spec, input, [input]).map((issue) => issue.code)).not.toContain("name_mismatch");
    }
  });

  it("rejects banned trading-card terms and keeps Vault Quest terminology", () => {
    expect(VQ_CARD_FACTORY_BANNED_TERMS).toEqual(["HP", "Pokémon", "Pokemon", "Weakness", "Resistance", "Retreat"]);
    expect(detectVqBannedTerms(["Health and Guard with Shift, Vulnerability, Core, and Seals"])).toEqual([]);
    expect(detectVqBannedTerms(["HP, Weakness, Resistance, Retreat, Pokemon"]).map((issue) => issue.message)).toEqual([
      "Banned term found: HP",
      "Banned term found: Pokemon",
      "Banned term found: Weakness",
      "Banned term found: Resistance",
      "Banned term found: Retreat",
    ]);
  });

  it("enforces stage relationships for the locked evolution chain", () => {
    expect(issueCodes(validInput())).not.toContain("stage_mismatch");
    expect(
      issueCodes(
        validInput({
          collectorNumber: "002",
          name: "Flammro",
          stage: 2,
          previousStage: "Flammi",
          prevArtR2Key: "vq/art/GNV-001/main.png",
        })
      )
    ).not.toContain("previous_stage_mismatch");
    expect(
      issueCodes(
        validInput({
          collectorNumber: "002",
          name: "Flammro",
          stage: 2,
          previousStage: "Wrong",
          prevArtR2Key: "vq/art/GNV-001/main.png",
        })
      )
    ).toContain("wrong_evolves_from");
    expect(
      issueCodes(
        validInput({
          collectorNumber: "003",
          name: "Flamora",
          stage: 3,
          previousStage: "Flammi",
          prevArtR2Key: "vq/art/GNV-002/main.png",
        })
      )
    ).toContain("wrong_evolves_from");
    expect(issueCodes(validInput({ familyId: "GV-WRONG" }))).toContain("invalid_family");
  });

  it("keeps Stage 1 portrait-free and requires genuine previous portraits for Stage 2/3", () => {
    expect(issueCodes(validInput({ prevArtR2Key: "vq/art/prev.png" }))).toContain("stage1_prev_portrait");
    expect(
      issueCodes(
        validInput({
          collectorNumber: "005",
          name: "Aquanix",
          familyId: "GNV-F02",
          stage: 2,
          element: "Tide",
          previousStage: "Aquabub",
          prevArtR2Key: null,
        })
      )
    ).toContain("missing_previous_portrait");
    expect(
      issueCodes(
        validInput({
          collectorNumber: "005",
          name: "Aquanix",
          familyId: "GNV-F02",
          stage: 2,
          element: "Tide",
          previousStage: "Aquabub",
          prevArtR2Key: "vq/characters/GNV-F02-S1/approved/master_portrait.png",
        })
      )
    ).not.toContain("missing_previous_portrait");
  });

  it("blocks incomplete artwork and duplicate collector numbers before approval/export", () => {
    const duplicate = validInput({ name: "Flammi Clone" });
    const issues = validateVqFactoryCard(
      getVqStandardSpec("001")!,
      validInput({ artR2Key: null, artworkApproved: false }),
      [validInput(), duplicate]
    );
    expect(issues.map((issue) => issue.code)).toContain("missing_artwork");
    expect(issues.map((issue) => issue.code)).toContain("duplicate_number");
  });
});

describe("Vault Quest Card Factory render and provider safety", () => {
  it("resolves an existing approved previous-stage portrait without requiring a copied card prevArtR2Key", async () => {
    const { getFactoryRows } = await import("../server/vault-quest/card-factory");
    const cards = [
      {
        ...validInput({
          collectorNumber: "004/036",
          name: "Aquabub",
          familyId: "GNV-F02",
          element: "Tide",
        }),
        cardId: "GNV-004",
        cardType: "Creature",
        displayName: "Aquabub",
        lifeStage: "BABY",
        keywords: [],
        effects: null,
        renderR2Key: null,
        variantTier: "STANDARD",
        baseCardId: null,
        setCode: "GNV",
        language: "EN",
        notes: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      {
        ...validInput({
          collectorNumber: "005/036",
          name: "Aquanix",
          familyId: "GNV-F02",
          stage: 2,
          element: "Tide",
          previousStage: "Aquabub",
          prevArtR2Key: null,
        }),
        cardId: "GNV-005",
        cardType: "Creature",
        displayName: "Aquanix",
        lifeStage: "TEEN",
        keywords: [],
        effects: null,
        renderR2Key: null,
        variantTier: "STANDARD",
        baseCardId: null,
        setCode: "GNV",
        language: "EN",
        notes: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ] as VqCardRow[];
    const families = [
      {
        id: 1,
        familyId: "GNV-F02",
        setCode: "GNV",
        element: "Tide",
        name: "Aquabub",
        stage1Name: "Aquabub",
        stage2Name: "Aquanix",
        stage3Name: "Aquadon",
        createdAt: new Date(0),
      },
    ] as VqFamily[];
    const characters = [
      {
        id: 1,
        characterId: "GNV-F02-S1",
        setCode: "GNV",
        familyId: "GNV-F02",
        familyName: "Aquabub",
        cardId: "GNV-004",
        stageNumber: 1,
        characterName: "Aquabub",
        element: "Tide",
        referencePack: { master_portrait: { r2Key: "vq/characters/GNV-F02-S1/approved/master_portrait.png" } },
        approvedArtworkR2Key: null,
        referenceArtworkR2Key: null,
        variantCardIds: [],
        gameMetadata: {},
        descriptionStatus: "draft",
        approvalStatus: "draft",
        locked: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ] as VqCharacter[];
    vi.spyOn(vqStorage, "listCards").mockResolvedValue(cards);
    vi.spyOn(vqStorage, "listCharacters").mockResolvedValue(characters);
    vi.spyOn(vqStorage, "listFamilies").mockResolvedValue(families);
    vi.spyOn(vqStorage, "getConfig").mockResolvedValue({});

    const aquanix = (await getFactoryRows()).find((row) => row.spec.collectorNumber === "005")!;
    expect(aquanix.previousStagePortraitStatus).toBe("linked");
    expect(aquanix.validation.map((issue) => issue.code)).not.toContain("missing_previous_portrait");

    vi.restoreAllMocks();
  });

  it("saves founder draft data through audited card storage and blocks double-save with stale timestamps", async () => {
    const { saveFactoryCardData } = await import("../server/vault-quest/card-factory");
    const updatedAt = new Date("2026-01-01T00:00:00.000Z");
    const card = {
      ...validInput({ collectorNumber: "004/036", name: "Aquabub", familyId: "GNV-F02", element: "Tide" }),
      cardId: "GNV-004",
      cardType: "Creature",
      displayName: "Aquabub",
      lifeStage: "BABY",
      keywords: [],
      effects: null,
      renderR2Key: null,
      variantTier: "STANDARD",
      baseCardId: null,
      setCode: "GNV",
      language: "EN",
      notes: null,
      createdAt: new Date(0),
      updatedAt,
    } as VqCardRow;
    vi.spyOn(vqStorage, "listCards").mockResolvedValue([card]);
    vi.spyOn(vqStorage, "listCharacters").mockResolvedValue([]);
    vi.spyOn(vqStorage, "listFamilies").mockResolvedValue([
      {
        id: 1,
        familyId: "GNV-F02",
        setCode: "GNV",
        element: "Tide",
        name: "Aquabub",
        stage1Name: "Aquabub",
        stage2Name: "Aquanix",
        stage3Name: "Aquadon",
        createdAt: new Date(0),
      },
    ] as VqFamily[]);
    vi.spyOn(vqStorage, "getConfig").mockResolvedValue({});
    const save = vi.spyOn(vqStorage, "saveCard").mockResolvedValue({ ...card, attack1Cost: 2 } as VqCardRow);

    await saveFactoryCardData(
      "004",
      {
        attack1Cost: 2,
        attack1Damage: 3,
        attack1Name: "Bubble Guard",
        health: 4,
        guard: 1,
        shift: 1,
        rarity: "Common",
        vulnerability: "Volt",
        edition: "First Edition",
        year: 2026,
        expectedUpdatedAt: updatedAt.toISOString(),
      },
      "founder"
    );
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cardId: "GNV-004", attack1Cost: 2 }), "founder");
    await expect(
      saveFactoryCardData("004", { expectedUpdatedAt: "2026-01-02T00:00:00.000Z" }, "founder")
    ).rejects.toThrow(/changed since/i);

    vi.restoreAllMocks();
  });

  it("renders the front preview through the existing canonical renderer at 69mm x 94mm", async () => {
    const art = await sharp({ create: { width: 1600, height: 1100, channels: 4, background: "#d0472b" } })
      .png()
      .toBuffer();
    const input: RenderCardInput = {
      cardId: "GNV-001",
      collectorNumber: "001/036",
      name: "Flammi",
      displayName: "Flammi",
      cardType: "Creature",
      element: "Flame",
      rarity: "Common",
      familyId: "flammi",
      familyName: "Flammi Family",
      stageNumber: 1,
      lifeStage: "BABY",
      previousStage: null,
      health: 4,
      guard: 1,
      shift: 1,
      attack1Name: "Ember Seal",
      attack1Cost: 1,
      attack1Damage: 2,
      attack1Effect: "Shift one Core Seal.",
      attack2Name: null,
      attack2Cost: null,
      attack2Damage: null,
      attack2Effect: null,
      vulnerability: "Tide",
      keywords: [],
      setCode: "GNV",
      language: "EN",
      year: 2026,
      edition: "First Edition",
    };

    const result = await renderCard(input, { mainArt: art }, "preview");
    expect(result.qa.status).toBe("pass");
    const metadata = await sharp(result.previewPng!).metadata();
    expect(metadata.width).toBe(815);
    expect(metadata.height).toBe(1110);
  });

  it("renders the universal back without creating provider jobs or artwork", async () => {
    const { renderFactoryBack } = await import("../server/vault-quest/card-factory");
    const spec = getVqStandardSpec("001")!;
    const result = await renderFactoryBack(spec, "preview");
    const metadata = await sharp(result.buffer).metadata();
    expect(result.filename).toBe("GV_001_Flammi_Stage1_back_v1.png");
    expect(result.contentType).toBe("image/png");
    expect(metadata.width).toBe(815);
    expect(metadata.height).toBe(1110);
  });

  it("writes physical PDF page boxes for media, trim, bleed and crop", async () => {
    const { renderFactoryBack } = await import("../server/vault-quest/card-factory");
    const result = await renderFactoryBack(getVqStandardSpec("001")!, "pdf");
    const pdf = result.buffer.toString("latin1");
    const mmToPt = 72 / 25.4;
    const box = (name: string) => {
      const match = new RegExp(`/${name}\\s*\\[([^\\]]+)\\]`).exec(pdf);
      expect(match, `${name} missing`).toBeTruthy();
      return match![1].trim().split(/\s+/).map(Number);
    };
    expect(box("MediaBox").map((n) => Number(n.toFixed(3)))).toEqual([
      0,
      0,
      Number((69 * mmToPt).toFixed(3)),
      Number((94 * mmToPt).toFixed(3)),
    ]);
    expect(box("TrimBox").map((n) => Number(n.toFixed(3)))).toEqual([
      Number((3 * mmToPt).toFixed(3)),
      Number((3 * mmToPt).toFixed(3)),
      Number((66 * mmToPt).toFixed(3)),
      Number((91 * mmToPt).toFixed(3)),
    ]);
    expect(box("BleedBox")).toEqual(box("MediaBox"));
    expect(box("CropBox")).toEqual(box("MediaBox"));
  });

  it("applies persisted placement deterministically before canonical rendering", async () => {
    const { applyFactoryPlacementToMainArt } = await import("../server/vault-quest/card-factory");
    const source = await sharp({ create: { width: 1000, height: 1000, channels: 4, background: "#00ff00" } })
      .png()
      .toBuffer();
    const placement = normalizeVqFactoryPlacement({ scale: 1.25, xOffsetPct: 30, yOffsetPct: -20, locked: true });
    const a = await applyFactoryPlacementToMainArt(source, placement);
    const b = await applyFactoryPlacementToMainArt(source, placement);
    expect(a.equals(b)).toBe(true);
    const metadata = await sharp(a).metadata();
    expect(metadata.width).toBe(1710);
    expect(metadata.height).toBe(1050);
  });

  it("marks approval stale when data, artwork, placement or template change", async () => {
    const {
      cardFactoryArtworkChecksum,
      cardFactoryDataChecksum,
      cardFactoryPlacementChecksum,
      resolveFactoryApprovalState,
    } = await import("../server/vault-quest/card-factory");
    const placement = normalizeVqFactoryPlacement(null);
    const card = {
      cardId: "GNV-001",
      collectorNumber: "001/036",
      name: "Flammi",
      displayName: "Flammi",
      cardType: "Creature",
      element: "Flame",
      rarity: "Common",
      familyId: "GNV-F01",
      stageNumber: 1,
      lifeStage: "BABY",
      health: 4,
      guard: 1,
      shift: 1,
      attack1Name: "Ember Seal",
      attack1Cost: 1,
      attack1Damage: 2,
      attack1Effect: "Shift one Core Seal.",
      attack2Name: null,
      attack2Cost: null,
      attack2Damage: null,
      attack2Effect: null,
      vulnerability: "Tide",
      keywords: [],
      artR2Key: "vq/art/GNV-001/main.png",
      prevArtR2Key: null,
      setCode: "GNV",
      language: "EN",
      year: 2026,
      edition: "First Edition",
      status: "approved",
    } as VqCardRow;
    const approval = {
      version: 1,
      state: "approved_for_print" as const,
      templateVersion: VQ_CARD_FACTORY_TEMPLATE_VERSION,
      dataChecksum: cardFactoryDataChecksum(card),
      artworkChecksum: cardFactoryArtworkChecksum(card),
      placementChecksum: cardFactoryPlacementChecksum(placement),
      renderChecksum: "render",
      validationChecksum: "validation",
      approver: "admin",
      approvedAt: new Date(0).toISOString(),
    };
    expect(resolveFactoryApprovalState(card, placement, approval).approvalState).toBe("current");
    expect(resolveFactoryApprovalState({ ...card, health: 9 } as VqCardRow, placement, approval).approvalState).toBe(
      "stale"
    );
    expect(
      resolveFactoryApprovalState({ ...card, artR2Key: "vq/art/GNV-001/new.png" } as VqCardRow, placement, approval)
        .approvalState
    ).toBe("stale");
    expect(resolveFactoryApprovalState(card, normalizeVqFactoryPlacement({ scale: 1.1 }), approval).approvalState).toBe(
      "stale"
    );
  });

  it("emits CSV and missing/blocked reports with deterministic ordering", async () => {
    const { buildFactoryCsvManifest, buildFactoryMissingBlockedReport } =
      await import("../server/vault-quest/card-factory");
    const rows = [
      {
        spec: getVqStandardSpec("001")!,
        card: null,
        character: null,
        validation: [{ code: "missing_card", field: "card", message: "Missing", severity: "blocker" as const }],
        completionStatus: "missing" as const,
        blockingReason: "Missing",
        artworkStatus: "missing" as const,
        dataStatus: "missing" as const,
        exportReady: false,
        lastUpdated: null,
        placement: normalizeVqFactoryPlacement(null),
        approval: null,
        approvalState: "missing" as const,
        approvalStaleReason: null,
        previousStagePortraitStatus: "not_required" as const,
      },
    ];
    expect(buildFactoryCsvManifest(rows).split("\n")[0]).toContain("collectorNumber");
    expect(buildFactoryCsvManifest(rows)).toContain("GV_001_Flammi_Stage1_front_v1.png");
    expect(buildFactoryMissingBlockedReport(rows)).toContain("001 Flammi: Missing");
  });

  it("calculates progress, queue ordering, checklist and export gates without false completion", async () => {
    const { buildFactoryProgress, buildFactoryWorkQueue } = await import("../server/vault-quest/card-factory");
    const rows = VQ_STANDARD_CARD_SPECS.map((spec, index) => ({
      spec,
      productionRecord: {
        cardId: spec.cardId,
        collectorNumber: spec.collectorNumber,
        familyId: spec.familyId,
        familyName: spec.familyName,
        stage: spec.stage,
        element: spec.element,
        templateVersion: VQ_CARD_FACTORY_TEMPLATE_VERSION,
        previousStageName: spec.expectedPreviousName,
      },
      card: index === 0 ? ({ cardId: "GNV-001" } as VqCardRow) : null,
      character: null,
      validation:
        index === 0
          ? []
          : [
              {
                code: "missing_card",
                field: "card",
                message: "No draft card data exists.",
                severity: "blocker" as const,
              },
            ],
      completionStatus: index === 0 ? ("approved_for_print" as const) : ("missing" as const),
      blockingReason: index === 0 ? "" : "No draft card data exists.",
      artworkStatus: index === 1 ? ("draft" as const) : index === 0 ? ("approved" as const) : ("missing" as const),
      dataStatus: index === 2 ? ("draft" as const) : index === 0 ? ("approved" as const) : ("missing" as const),
      validationStatus: index === 0 ? ("approved_for_print" as const) : ("blocked" as const),
      exportStatus: index === 0 ? ("ready" as const) : ("blocked" as const),
      checklist: {
        artwork: index === 1 ? ("draft" as const) : index === 0 ? ("approved" as const) : ("missing" as const),
        data: index === 2 ? ("draft" as const) : index === 0 ? ("approved" as const) : ("missing" as const),
        preview: index === 0 ? ("ready" as const) : ("blocked" as const),
        validation: index === 0 ? ("approved_for_print" as const) : ("blocked" as const),
        approval: index === 0 ? ("current" as const) : ("missing" as const),
        export: index === 0 ? ("ready" as const) : ("blocked" as const),
      },
      exportReady: index === 0,
      lastUpdated: null,
      placement: normalizeVqFactoryPlacement(null),
      approval: null,
      approvalState: index === 0 ? ("current" as const) : ("missing" as const),
      approvalStaleReason: null,
      previousStagePortraitStatus: spec.stage === 1 ? ("not_required" as const) : ("missing" as const),
    }));

    expect(rows).toHaveLength(36);
    expect(rows.map((row) => row.productionRecord.collectorNumber)).toEqual(
      Array.from({ length: 36 }, (_, index) => String(index + 1).padStart(3, "0"))
    );
    expect(buildFactoryProgress(rows)).toEqual({
      total: 36,
      cardsCompleted: 1,
      cardsAwaitingArtwork: 34,
      cardsAwaitingData: 35,
      cardsAwaitingApproval: 0,
      cardsExportReady: 1,
      percentageComplete: 3,
    });
    expect(
      buildFactoryWorkQueue(rows, "collector")
        .map((row) => row.spec.collectorNumber)
        .slice(0, 3)
    ).toEqual(["002", "003", "004"]);
    expect(buildFactoryWorkQueue(rows, "data_missing")[0].dataStatus).not.toBe("approved");
    expect(rows[1].checklist.export).toBe("blocked");
    expect(rows[1].exportReady).toBe(false);
  });

  it("keeps Card Factory source VQ-only and free of generation/provider calls", () => {
    const files = [
      "server/vault-quest/card-factory.ts",
      "server/routes/vault-quest-card-factory.ts",
      "client/src/pages/admin-vault-quest-card-factory.tsx",
    ];
    const source = files.map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8")).join("\n");
    expect(source).not.toMatch(
      /generateHiggsfieldArtwork|createHiggsfieldPrediction|\/generate|provider-job|generationAllowed/i
    );
    expect(source).not.toMatch(/stripe|payment|certificate|grading|social-studio/i);
    expect(source).toContain("renderCard(");
  });
});
