import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import {
  VQ_CARD_FACTORY_GEOMETRY,
  VQ_CARD_FACTORY_TEMPLATE_VERSION,
  VQ_STANDARD_CARD_SPECS,
  getVqStandardSpec,
  normalizeVqCollectorNumber,
  validateVqFactoryCard,
  vqFactoryFilename,
  type VqCardFactorySpec,
  type VqFactoryValidationInput,
  type VqFactoryValidationIssue,
} from "@shared/vq-card-factory";
import type { VqCardRow, VqCharacter } from "@shared/vq-schema";
import { vqStorage } from "./storage";
import { fetchArt } from "./render-saved";
import { renderCard, type RenderCardInput } from "./render-service";
import { cardPdf, svgToPng } from "./lib/export";
import { VQ_LOCK } from "./lib/vq-constants";

const MM_TO_PT = 72 / 25.4;
const PREVIEW_DPI = 300;
const MASTER_DPI = 600;

export interface VqFactoryCardRow {
  spec: VqCardFactorySpec;
  card: VqCardRow | null;
  character: VqCharacter | null;
  validation: VqFactoryValidationIssue[];
  completionStatus: "missing" | "blocked" | "ready_for_review" | "approved_for_print";
  blockingReason: string;
  artworkStatus: "missing" | "draft" | "approved";
  dataStatus: "missing" | "draft" | "approved";
  exportReady: boolean;
  lastUpdated: string | null;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function standardNumber(value: string | null | undefined): string {
  return normalizeVqCollectorNumber(value);
}

function factoryInput(
  spec: VqCardFactorySpec,
  card: VqCardRow | null,
  character: VqCharacter | null
): VqFactoryValidationInput | null {
  if (!card) return null;
  return {
    collectorNumber: card.collectorNumber,
    name: card.name,
    stage: card.stageNumber,
    familyId: spec.familyId,
    element: card.element,
    health: card.health,
    guard: card.guard,
    shift: card.shift,
    previousStage: spec.expectedPreviousName,
    attack1Name: card.attack1Name,
    attack1Cost: card.attack1Cost,
    attack1Damage: card.attack1Damage,
    attack1Effect: card.attack1Effect,
    attack2Name: card.attack2Name,
    attack2Cost: card.attack2Cost,
    attack2Damage: card.attack2Damage,
    attack2Effect: card.attack2Effect,
    vulnerability: card.vulnerability,
    rarity: card.rarity,
    edition: card.edition,
    year: card.year,
    artR2Key: card.artR2Key || character?.approvedArtworkR2Key || null,
    prevArtR2Key: card.prevArtR2Key || null,
    artworkApproved: !!(card.artR2Key || character?.approvedArtworkR2Key),
    status: card.status,
  };
}

function findCardForSpec(spec: VqCardFactorySpec, cards: VqCardRow[]): VqCardRow | null {
  return (
    cards.find(
      (card) => standardNumber(card.collectorNumber) === spec.collectorNumber && card.cardType === "Creature"
    ) ||
    cards.find(
      (card) => card.name.trim().toLowerCase() === spec.character.toLowerCase() && card.cardType === "Creature"
    ) ||
    null
  );
}

function characterForSpec(
  spec: VqCardFactorySpec,
  characters: VqCharacter[],
  card: VqCardRow | null
): VqCharacter | null {
  return (
    (card ? characters.find((character) => character.cardId === card.cardId) : undefined) ||
    characters.find((character) => character.characterName.trim().toLowerCase() === spec.character.toLowerCase()) ||
    null
  );
}

function rowStatus(
  card: VqCardRow | null,
  validation: VqFactoryValidationIssue[]
): VqFactoryCardRow["completionStatus"] {
  if (!card) return "missing";
  if (validation.some((issue) => issue.severity === "blocker")) return "blocked";
  if (["approved", "export_ready", "printed_proxy"].includes(card.status)) return "approved_for_print";
  return "ready_for_review";
}

export async function getFactoryRows(): Promise<VqFactoryCardRow[]> {
  const [cards, characters] = await Promise.all([
    vqStorage.listCards({ setCode: "GNV" }),
    vqStorage.listCharacters("GNV"),
  ]);
  const inputs = VQ_STANDARD_CARD_SPECS.map((spec) => factoryInput(spec, findCardForSpec(spec, cards), null)).filter(
    Boolean
  ) as VqFactoryValidationInput[];
  return VQ_STANDARD_CARD_SPECS.map((spec) => {
    const card = findCardForSpec(spec, cards);
    const character = characterForSpec(spec, characters, card);
    const input = factoryInput(spec, card, character);
    const validation = validateVqFactoryCard(spec, input, inputs);
    const completionStatus = rowStatus(card, validation);
    const artworkStatus = input?.artR2Key ? "approved" : "missing";
    const dataStatus = !card
      ? "missing"
      : validation.some(
            (issue) => issue.field !== "artR2Key" && issue.field !== "prevArtR2Key" && issue.code !== "missing_artwork"
          )
        ? "draft"
        : "approved";
    return {
      spec,
      card,
      character,
      validation,
      completionStatus,
      blockingReason: validation.find((issue) => issue.severity === "blocker")?.message ?? "",
      artworkStatus,
      dataStatus,
      exportReady: completionStatus === "approved_for_print",
      lastUpdated: card?.updatedAt
        ? card.updatedAt.toISOString()
        : character?.updatedAt
          ? character.updatedAt.toISOString()
          : null,
    };
  });
}

export async function getFactoryRow(collectorNumber: string): Promise<VqFactoryCardRow | null> {
  const spec = getVqStandardSpec(collectorNumber);
  if (!spec) return null;
  return (await getFactoryRows()).find((row) => row.spec.collectorNumber === spec.collectorNumber) ?? null;
}

function renderInput(spec: VqCardFactorySpec, card: VqCardRow): RenderCardInput {
  return {
    cardId: card.cardId,
    collectorNumber: `${spec.collectorNumber}/036`,
    name: card.name,
    displayName: card.displayName,
    cardType: "Creature",
    element: card.element,
    rarity: card.rarity,
    familyId: spec.familyId,
    familyName: spec.familyName,
    stageNumber: spec.stage,
    lifeStage: spec.stage === 1 ? "BABY" : spec.stage === 2 ? "TEEN" : "FINAL",
    previousStage: spec.expectedPreviousName,
    health: card.health,
    guard: card.guard,
    shift: card.shift,
    attack1Name: card.attack1Name,
    attack1Cost: card.attack1Cost,
    attack1Damage: card.attack1Damage,
    attack1Effect: card.attack1Effect,
    attack2Name: card.attack2Name,
    attack2Cost: card.attack2Cost,
    attack2Damage: card.attack2Damage,
    attack2Effect: card.attack2Effect,
    vulnerability: card.vulnerability,
    keywords: card.keywords,
    setCode: "GNV",
    language: card.language,
    year: card.year,
    edition: card.edition,
  };
}

export async function validateFactoryRender(row: VqFactoryCardRow): Promise<VqFactoryCardRow> {
  if (!row.card) return row;
  if (row.validation.some((issue) => issue.severity === "blocker")) return row;
  const result = await renderCard(renderInput(row.spec, row.card), await fetchArt(row.card), "preview");
  if (result.qa.status === "reject") {
    row.validation.push(
      ...result.qa.issues.map((issue) => ({
        code: "render_qa",
        field: issue.field,
        message: issue.message,
        severity: issue.level === "reject" ? ("blocker" as const) : ("warning" as const),
      }))
    );
    row.completionStatus = "blocked";
    row.blockingReason = row.validation.find((issue) => issue.severity === "blocker")?.message ?? "Render QA failed.";
    row.exportReady = false;
  }
  return row;
}

export async function renderFactoryFront(
  collectorNumber: string,
  mode: "preview" | "master" | "pdf"
): Promise<{ row: VqFactoryCardRow; buffer: Buffer; contentType: string; filename: string; checksum: string }> {
  const row = await validateFactoryRender(await requiredFactoryRow(collectorNumber));
  if (!row.card) throw new Error("No card data exists for this Standard slot.");
  if (row.validation.some((issue) => issue.severity === "blocker"))
    throw new Error(row.blockingReason || "Card is not export-ready.");
  const result = await renderCard(
    renderInput(row.spec, row.card),
    await fetchArt(row.card),
    mode === "preview" ? "preview" : "all"
  );
  const buffer = mode === "pdf" ? result.pdf : mode === "master" ? result.masterPng : result.previewPng;
  if (!buffer) throw new Error("Render failed.");
  return {
    row,
    buffer,
    contentType: mode === "pdf" ? "application/pdf" : "image/png",
    filename: vqFactoryFilename(row.spec, "front", 1, mode === "pdf" ? "pdf" : "png"),
    checksum: sha256(buffer),
  };
}

function backSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="69mm" height="94mm" viewBox="0 0 69 94">
  <defs>
    <radialGradient id="glow" cx="50%" cy="35%" r="70%">
      <stop offset="0" stop-color="#264F9E"/>
      <stop offset="0.45" stop-color="#102A5E"/>
      <stop offset="1" stop-color="#081A3D"/>
    </radialGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F8E7A0"/>
      <stop offset="0.5" stop-color="#C9A227"/>
      <stop offset="1" stop-color="#7A5A12"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="69" height="94" fill="#081A3D"/>
  <rect x="3" y="3" width="63" height="88" fill="url(#glow)" stroke="url(#gold)" stroke-width="0.7"/>
  <rect x="7" y="7" width="55" height="80" fill="none" stroke="#D7DCE6" stroke-opacity="0.35" stroke-width="0.25"/>
  <path d="M34.5 18 L49 32 L43 58 L34.5 70 L26 58 L20 32 Z" fill="none" stroke="url(#gold)" stroke-width="1.2"/>
  <circle cx="34.5" cy="42" r="8" fill="none" stroke="#F8E7A0" stroke-width="0.8"/>
  <text x="34.5" y="39" text-anchor="middle" font-size="5.2" font-family="Arial Black" fill="#F8E7A0">VAULT</text>
  <text x="34.5" y="46" text-anchor="middle" font-size="5.2" font-family="Arial Black" fill="#F8E7A0">QUEST</text>
  <text x="34.5" y="80" text-anchor="middle" font-size="1.6" font-family="Arial" fill="#D7DCE6">GENESIS VAULT</text>
</svg>`;
}

export async function renderFactoryBack(
  spec: VqCardFactorySpec,
  mode: "preview" | "master" | "pdf"
): Promise<{ buffer: Buffer; contentType: string; filename: string; checksum: string }> {
  const svg = backSvg();
  const png = await svgToPng(svg, VQ_LOCK, mode === "preview" ? PREVIEW_DPI : MASTER_DPI);
  const buffer = mode === "pdf" ? await cardPdf(png, VQ_LOCK) : png;
  return {
    buffer,
    contentType: mode === "pdf" ? "application/pdf" : "image/png",
    filename: vqFactoryFilename(spec, "back", 1, mode === "pdf" ? "pdf" : "png"),
    checksum: sha256(buffer),
  };
}

export async function requiredFactoryRow(collectorNumber: string): Promise<VqFactoryCardRow> {
  const row = await getFactoryRow(collectorNumber);
  if (!row) throw new Error("Unknown Standard collector number.");
  return row;
}

export function buildFactoryManifest(rows: VqFactoryCardRow[]) {
  return {
    set: "Genesis Vault",
    range: "001-036",
    templateVersion: VQ_CARD_FACTORY_TEMPLATE_VERSION,
    geometry: VQ_CARD_FACTORY_GEOMETRY,
    manufacturerProfile: {
      status: "pending",
      warning:
        "Manufacturer specification pending. Internal Vault Quest output only; do not claim final printer compatibility.",
    },
    cards: rows.map((row) => ({
      collectorNumber: row.spec.collectorNumber,
      cardName: row.spec.character,
      stage: row.spec.stage,
      family: row.spec.familyName,
      element: row.spec.element,
      rarity: row.card?.rarity ?? null,
      frontFilename: vqFactoryFilename(row.spec, "front"),
      backFilename: vqFactoryFilename(row.spec, "back"),
      version: 1,
      approvalTimestamp: ["approved", "export_ready", "printed_proxy"].includes(row.card?.status ?? "")
        ? (row.card?.updatedAt?.toISOString() ?? null)
        : null,
      templateVersion: VQ_CARD_FACTORY_TEMPLATE_VERSION,
      dataChecksum: row.card ? sha256(JSON.stringify(row.card)) : null,
      artworkChecksum: row.card?.artR2Key ? sha256(row.card.artR2Key) : null,
      frontChecksum: null,
      backChecksum: null,
      status: row.completionStatus,
      blockingReason: row.blockingReason,
    })),
  };
}

export async function buildFactoryProofPdf(rows: VqFactoryCardRow[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 24 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica-Bold").fontSize(18).text("Vault Quest Physical Test-Print Pack", { align: "center" });
    doc.moveDown(0.5);
    doc
      .font("Helvetica")
      .fontSize(10)
      .text("Physical proof required before manufacturing approval.", { align: "center" });
    doc.moveDown();
    doc.text(`Template: ${VQ_CARD_FACTORY_TEMPLATE_VERSION}`);
    doc.text(
      "Includes: one Stage 1, one Stage 2, one Stage 3, front/back proof references, bleed/trim/readability notes."
    );
    doc.moveDown();
    for (const row of rows.slice(0, 6)) {
      doc.font("Helvetica-Bold").text(`${row.spec.collectorNumber} ${row.spec.character} - Stage ${row.spec.stage}`);
      doc.font("Helvetica").text(row.blockingReason || "Ready for proof entry.");
      doc.moveDown(0.3);
    }
    doc.addPage({ size: [69 * MM_TO_PT, 94 * MM_TO_PT], margin: 0 });
    doc
      .font("Helvetica-Bold")
      .fontSize(6)
      .text("TRUE SIZE REFERENCE - 69mm x 94mm", 6 * MM_TO_PT, 6 * MM_TO_PT);
    doc.rect(3 * MM_TO_PT, 3 * MM_TO_PT, 63 * MM_TO_PT, 88 * MM_TO_PT).stroke("#000000");
    doc.end();
  });
}
