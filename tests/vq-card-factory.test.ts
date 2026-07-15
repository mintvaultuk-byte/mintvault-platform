import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  VQ_CARD_FACTORY_BANNED_TERMS,
  VQ_CARD_FACTORY_ELEMENTS,
  VQ_CARD_FACTORY_GEOMETRY,
  VQ_CARD_FACTORY_TEMPLATE_VERSION,
  VQ_STANDARD_CARD_SPECS,
  detectVqBannedTerms,
  getVqStandardSpec,
  validateVqFactoryCard,
  vqFactoryFilename,
  type VqFactoryValidationInput,
} from "../shared/vq-card-factory";
import { renderCard, type RenderCardInput } from "../server/vault-quest/render-service";
import { VQ_ELEMENTS, VQ_LOCK } from "../server/vault-quest/lib/vq-constants";

vi.mock("../server/db", () => ({ db: {}, pool: { end: vi.fn() } }));

const repoRoot = path.resolve(__dirname, "..");

function validInput(overrides: Partial<VqFactoryValidationInput> = {}): VqFactoryValidationInput {
  return {
    collectorNumber: "001",
    name: "Flammi",
    stage: 1,
    familyId: "flammi",
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
    expect(VQ_STANDARD_CARD_SPECS.map((card) => card.stage)).toEqual(
      Array.from({ length: 12 }, () => [1, 2, 3]).flat()
    );
    expect(VQ_CARD_FACTORY_ELEMENTS).toEqual(["Terra", "Volt", "Tide", "Flame", "Gale", "Crystal"]);
    for (const element of VQ_CARD_FACTORY_ELEMENTS) {
      expect(VQ_ELEMENTS[element]).toBeTruthy();
    }
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
