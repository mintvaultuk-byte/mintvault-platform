export const VQ_CARD_FACTORY_ROUTE = "/admin/vault-quest/card-factory";

export const VQ_CARD_FACTORY_TEMPLATE_VERSION = "VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.2.1_STAGE_LOCK";
export const VQ_CARD_FACTORY_BRIEF_TEMPLATE_VERSION = "VQ_STANDARD_CREATURE_CARD_TEMPLATE_v1.1_STAGE_LOCK";

export const VQ_CARD_FACTORY_GEOMETRY = {
  canvasMm: { width: 69, height: 94 },
  trimMm: { width: 63, height: 88 },
  centralArtMm: { width: 60, height: 85 },
  bleedMm: 3,
  visibleBorderMm: 3,
  orientation: "portrait",
} as const;

export const VQ_CARD_FACTORY_ELEMENTS = ["Terra", "Volt", "Tide", "Flame", "Gale", "Crystal"] as const;
export type VqCardFactoryElement = (typeof VQ_CARD_FACTORY_ELEMENTS)[number];

export const VQ_CARD_FACTORY_APPROVAL_STATES = [
  "incomplete",
  "draft",
  "ready_for_review",
  "approved_for_print",
  "approval_stale",
  "rejected",
  "superseded",
] as const;
export type VqCardFactoryApprovalState = (typeof VQ_CARD_FACTORY_APPROVAL_STATES)[number];

export const VQ_CARD_FACTORY_PLACEMENT_DEFAULT = {
  scale: 1,
  xOffsetPct: 0,
  yOffsetPct: 0,
  crop: "cover",
  locked: false,
} as const;

export interface VqCardFactoryPlacement {
  scale: number;
  xOffsetPct: number;
  yOffsetPct: number;
  crop: "cover";
  locked: boolean;
}

export interface VqCardFactoryApprovalSnapshot {
  version: number;
  state: "approved_for_print";
  templateVersion: string;
  dataChecksum: string;
  artworkChecksum: string;
  placementChecksum: string;
  renderChecksum: string;
  validationChecksum: string;
  approver: string;
  approvedAt: string;
}

export const VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT = {
  status: "pending",
  requiredDpi: null,
  colourProfile: null,
  bleedMm: null,
  trimMm: null,
  safeZoneMm: null,
  fileFormat: null,
  cornerRadiusMm: null,
  naming: null,
  frontBackOrder: null,
  sheetLayout: null,
  warning: "Internal print proof — manufacturer specification pending",
} as const;

export const VQ_CARD_FACTORY_BANNED_TERMS = ["HP", "Pokémon", "Pokemon", "Weakness", "Resistance", "Retreat"] as const;

export interface VqCardFactoryFamily {
  familyId: string;
  familyName: string;
  element: VqCardFactoryElement;
  stages: readonly [string, string, string];
}

export const VQ_CARD_FACTORY_FAMILIES: readonly VqCardFactoryFamily[] = [
  { familyId: "GNV-F01", familyName: "Flammi", element: "Flame", stages: ["Flammi", "Flammro", "Flamora"] },
  { familyId: "GNV-F02", familyName: "Aquabub", element: "Tide", stages: ["Aquabub", "Aquanix", "Aquadon"] },
  { familyId: "GNV-F03", familyName: "Leafee", element: "Terra", stages: ["Leafee", "Leafflora", "Floraven"] },
  { familyId: "GNV-F04", familyName: "Zappi", element: "Volt", stages: ["Zappi", "Zapstorm", "Zaptor"] },
  { familyId: "GNV-F05", familyName: "Breezi", element: "Gale", stages: ["Breezi", "Breezelle", "Breezar"] },
  { familyId: "GNV-F06", familyName: "Glimmi", element: "Crystal", stages: ["Glimmi", "Glimora", "Glimstar"] },
  { familyId: "GNV-F07", familyName: "Mossi", element: "Terra", stages: ["Mossi", "Mossaro", "Mossrex"] },
  { familyId: "GNV-F08", familyName: "Emberi", element: "Flame", stages: ["Emberi", "Emberon", "Emberos"] },
  { familyId: "GNV-F09", familyName: "Droppi", element: "Tide", stages: ["Droppi", "Droppon", "Droppos"] },
  { familyId: "GNV-F10", familyName: "Sparki", element: "Volt", stages: ["Sparki", "Sparkon", "Sparkos"] },
  { familyId: "GNV-F11", familyName: "Gusti", element: "Gale", stages: ["Gusti", "Guston", "Gustor"] },
  { familyId: "GNV-F12", familyName: "Shardi", element: "Crystal", stages: ["Shardi", "Shardon", "Shardor"] },
] as const;

export interface VqCardFactorySpec {
  collectorNumber: string;
  cardId: string;
  character: string;
  stage: 1 | 2 | 3;
  familyId: string;
  familyName: string;
  element: VqCardFactoryElement;
  expectedPreviousName: string | null;
  setName: "Genesis Vault";
  setCode: "GNV";
  edition: "First Edition";
  year: 2026;
}

export const VQ_STANDARD_CARD_SPECS: readonly VqCardFactorySpec[] = VQ_CARD_FACTORY_FAMILIES.flatMap(
  (family, familyIndex) =>
    family.stages.map((character, stageIndex) => {
      const number = familyIndex * 3 + stageIndex + 1;
      return {
        collectorNumber: String(number).padStart(3, "0"),
        cardId: `GNV-${String(number).padStart(3, "0")}`,
        character,
        stage: (stageIndex + 1) as 1 | 2 | 3,
        familyId: family.familyId,
        familyName: family.familyName,
        element: family.element,
        expectedPreviousName: stageIndex === 0 ? null : family.stages[stageIndex - 1],
        setName: "Genesis Vault",
        setCode: "GNV",
        edition: "First Edition",
        year: 2026,
      };
    })
);

export interface VqFactoryValidationInput {
  collectorNumber?: string | null;
  name?: string | null;
  stage?: number | null;
  familyId?: string | null;
  element?: string | null;
  health?: number | null;
  guard?: number | null;
  shift?: number | null;
  previousStage?: string | null;
  attack1Name?: string | null;
  attack1Cost?: number | null;
  attack1Damage?: number | null;
  attack1Effect?: string | null;
  attack2Name?: string | null;
  attack2Cost?: number | null;
  attack2Damage?: number | null;
  attack2Effect?: string | null;
  vulnerability?: string | null;
  rarity?: string | null;
  edition?: string | null;
  year?: number | null;
  artR2Key?: string | null;
  prevArtR2Key?: string | null;
  artworkApproved?: boolean;
  status?: string | null;
}

export interface VqFactoryCardDataDraft {
  health?: number | null;
  guard?: number | null;
  shift?: number | null;
  vulnerability?: string | null;
  rarity?: string | null;
  attack1Name?: string | null;
  attack1Cost?: number | null;
  attack1Damage?: number | null;
  attack1Effect?: string | null;
  attack2Name?: string | null;
  attack2Cost?: number | null;
  attack2Damage?: number | null;
  attack2Effect?: string | null;
  flavourText?: string | null;
  edition?: string | null;
  year?: number | null;
  footerCopyright?: string | null;
  expectedUpdatedAt?: string | null;
}

export interface VqFactoryValidationIssue {
  code: string;
  field: string;
  message: string;
  severity: "blocker" | "warning";
}

function present(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

export function normalizeVqCollectorNumber(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  const first = raw.split("/")[0].replace(/\D/g, "");
  return first ? first.padStart(3, "0").slice(-3) : "";
}

export function getVqStandardSpec(collectorNumber: string): VqCardFactorySpec | undefined {
  const normalized = normalizeVqCollectorNumber(collectorNumber);
  return VQ_STANDARD_CARD_SPECS.find((card) => card.collectorNumber === normalized);
}

export function findVqStandardSpecByName(name: string): VqCardFactorySpec | undefined {
  const normalized = name.trim().toLowerCase();
  return VQ_STANDARD_CARD_SPECS.find((card) => card.character.toLowerCase() === normalized);
}

const VQ_CARD_FACTORY_ELEMENT_ALIASES: Record<string, VqCardFactoryElement> = {
  blaze: "Flame",
  fire: "Flame",
  water: "Tide",
  aqua: "Tide",
  nature: "Terra",
  blossom: "Terra",
  earth: "Terra",
  storm: "Volt",
  spark: "Volt",
  electric: "Volt",
  wind: "Gale",
};

const VQ_CARD_FACTORY_NAME_ALIASES: Record<string, string> = {
  breezy: "Breezi",
  breezie: "Breezi",
  breezella: "Breezelle",
  breezel: "Breezelle",
  breezer: "Breezar",
};

export function normalizeVqFactoryElement(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const direct = VQ_CARD_FACTORY_ELEMENTS.find((element) => element.toLowerCase() === raw.toLowerCase());
  return direct ?? VQ_CARD_FACTORY_ELEMENT_ALIASES[raw.toLowerCase()] ?? raw;
}

export function normalizeVqFactoryName(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const direct = VQ_STANDARD_CARD_SPECS.find((card) => card.character.toLowerCase() === raw.toLowerCase());
  return direct?.character ?? VQ_CARD_FACTORY_NAME_ALIASES[raw.toLowerCase()] ?? raw;
}

export function safeVqFactoryFilenamePart(value: string, fallback = "card"): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u2044\u2215\u29f8]/g, "-")
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? "-" : char;
    })
    .join("")
    .replace(/["'`<>:;|?*#[\]{}()!@+$%^&,/\\\s]+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 90)
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return cleaned || fallback;
}

export function vqFactoryFilename(spec: VqCardFactorySpec, side: "front" | "back", version = 1, ext = "png"): string {
  return `GV_${spec.collectorNumber}_${safeVqFactoryFilenamePart(spec.character)}_Stage${spec.stage}_${side}_v${version}.${ext}`;
}

export function normalizeVqFactoryPlacement(
  value: Partial<VqCardFactoryPlacement> | null | undefined
): VqCardFactoryPlacement {
  const scale = Number(value?.scale);
  const xOffsetPct = Number(value?.xOffsetPct);
  const yOffsetPct = Number(value?.yOffsetPct);
  return {
    scale: Number.isFinite(scale) ? Math.min(2, Math.max(0.5, scale)) : VQ_CARD_FACTORY_PLACEMENT_DEFAULT.scale,
    xOffsetPct: Number.isFinite(xOffsetPct)
      ? Math.min(100, Math.max(-100, xOffsetPct))
      : VQ_CARD_FACTORY_PLACEMENT_DEFAULT.xOffsetPct,
    yOffsetPct: Number.isFinite(yOffsetPct)
      ? Math.min(100, Math.max(-100, yOffsetPct))
      : VQ_CARD_FACTORY_PLACEMENT_DEFAULT.yOffsetPct,
    crop: "cover",
    locked: !!value?.locked,
  };
}

export function detectVqBannedTerms(values: Array<string | null | undefined>): VqFactoryValidationIssue[] {
  const text = values.filter(Boolean).join("\n");
  return VQ_CARD_FACTORY_BANNED_TERMS.flatMap((term) => {
    const pattern = term === "HP" ? /\bHP\b/i : new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return pattern.test(text)
      ? [{ code: "banned_term", field: "text", message: `Banned term found: ${term}`, severity: "blocker" as const }]
      : [];
  });
}

export function validateVqFactoryCard(
  spec: VqCardFactorySpec,
  input: VqFactoryValidationInput | null | undefined,
  allCards: readonly VqFactoryValidationInput[] = []
): VqFactoryValidationIssue[] {
  const issues: VqFactoryValidationIssue[] = [];
  if (!input) {
    return [
      {
        code: "missing_card",
        field: "card",
        message: "No draft card data exists for this Standard slot.",
        severity: "blocker",
      },
    ];
  }

  const normalized = normalizeVqCollectorNumber(input.collectorNumber);
  if (normalized !== spec.collectorNumber) {
    issues.push({
      code: "wrong_number",
      field: "collectorNumber",
      message: `Collector number must be ${spec.collectorNumber}.`,
      severity: "blocker",
    });
  }
  if (!present(input.name))
    issues.push({ code: "missing_name", field: "name", message: "Card name is required.", severity: "blocker" });
  else if (normalizeVqFactoryName(input.name) !== spec.character) {
    issues.push({
      code: "name_mismatch",
      field: "name",
      message: `Expected locked character name ${spec.character}.`,
      severity: "blocker",
    });
  }
  if (input.stage !== spec.stage)
    issues.push({
      code: "invalid_stage",
      field: "stage",
      message: `Stage must be ${spec.stage}.`,
      severity: "blocker",
    });
  if (input.familyId !== spec.familyId)
    issues.push({
      code: "invalid_family",
      field: "familyId",
      message: `Family must be ${spec.familyId}.`,
      severity: "blocker",
    });
  if (normalizeVqFactoryElement(input.element) !== spec.element)
    issues.push({
      code: "invalid_element",
      field: "element",
      message: `Element must be ${spec.element}.`,
      severity: "blocker",
    });

  if (spec.stage === 1) {
    if (present(input.previousStage))
      issues.push({
        code: "stage1_previous",
        field: "previousStage",
        message: "Stage 1 must not have Evolves From.",
        severity: "blocker",
      });
    if (present(input.prevArtR2Key))
      issues.push({
        code: "stage1_prev_portrait",
        field: "prevArtR2Key",
        message: "Stage 1 must not have a previous-stage portrait.",
        severity: "blocker",
      });
  } else {
    if (input.previousStage !== spec.expectedPreviousName) {
      issues.push({
        code: "wrong_evolves_from",
        field: "previousStage",
        message: `Evolves From must be ${spec.expectedPreviousName}.`,
        severity: "blocker",
      });
    }
    if (!present(input.prevArtR2Key))
      issues.push({
        code: "missing_previous_portrait",
        field: "prevArtR2Key",
        message: "Previous-stage portrait is required.",
        severity: "blocker",
      });
  }

  for (const [field, value] of [
    ["health", input.health],
    ["guard", input.guard],
    ["shift", input.shift],
    ["attack1Cost", input.attack1Cost],
    ["attack1Damage", input.attack1Damage],
  ] as const) {
    if (!Number.isFinite(value))
      issues.push({ code: `missing_${field}`, field, message: `${field} is required.`, severity: "blocker" });
  }
  if (!present(input.attack1Name))
    issues.push({
      code: "missing_attack1_name",
      field: "attack1Name",
      message: "Attack 1 name is required.",
      severity: "blocker",
    });
  if (!present(input.vulnerability))
    issues.push({
      code: "missing_vulnerability",
      field: "vulnerability",
      message: "Vulnerability is required.",
      severity: "blocker",
    });
  if (!present(input.rarity))
    issues.push({ code: "missing_rarity", field: "rarity", message: "Rarity is required.", severity: "blocker" });
  if (!present(input.edition))
    issues.push({ code: "missing_edition", field: "edition", message: "Edition is required.", severity: "blocker" });
  if (input.year !== 2026)
    issues.push({ code: "invalid_year", field: "year", message: "Year must be 2026.", severity: "blocker" });
  if (!present(input.artR2Key))
    issues.push({
      code: "missing_artwork",
      field: "artR2Key",
      message: "Approved card artwork is required.",
      severity: "blocker",
    });
  if (input.artworkApproved === false)
    issues.push({
      code: "unapproved_artwork",
      field: "artwork",
      message: "Artwork must be approved before print approval.",
      severity: "blocker",
    });

  const duplicateCount = allCards.filter(
    (card) => normalizeVqCollectorNumber(card.collectorNumber) === spec.collectorNumber
  ).length;
  if (duplicateCount > 1)
    issues.push({
      code: "duplicate_number",
      field: "collectorNumber",
      message: `Collector number ${spec.collectorNumber} is duplicated.`,
      severity: "blocker",
    });

  issues.push(
    ...detectVqBannedTerms([
      input.name,
      input.attack1Name,
      input.attack1Effect,
      input.attack2Name,
      input.attack2Effect,
      input.vulnerability,
      input.rarity,
      input.edition,
    ])
  );
  return issues;
}
