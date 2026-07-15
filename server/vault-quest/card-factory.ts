import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import {
  VQ_CARD_FACTORY_GEOMETRY,
  VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT,
  VQ_CARD_FACTORY_PLACEMENT_DEFAULT,
  VQ_CARD_FACTORY_TEMPLATE_VERSION,
  VQ_STANDARD_CARD_SPECS,
  getVqStandardSpec,
  normalizeVqFactoryPlacement,
  normalizeVqCollectorNumber,
  validateVqFactoryCard,
  vqFactoryFilename,
  type VqCardFactoryApprovalSnapshot,
  type VqCardFactoryPlacement,
  type VqCardFactorySpec,
  type VqFactoryValidationInput,
  type VqFactoryValidationIssue,
} from "@shared/vq-card-factory";
import type { VqCardRow, VqCharacter, VqFamily } from "@shared/vq-schema";
import { vqStorage } from "./storage";
import { fetchArt } from "./render-saved";
import { renderCard, type RenderCardInput } from "./render-service";
import { cardPdf, svgToPng } from "./lib/export";
import { VQ_LOCK } from "./lib/vq-constants";

const MM_TO_PT = 72 / 25.4;
const PREVIEW_DPI = 300;
const MASTER_DPI = 600;
const ART_WINDOW = { widthPx: 1710, heightPx: 1050 };

export interface VqFactoryCardRow {
  spec: VqCardFactorySpec;
  productionRecord: {
    cardId: string;
    collectorNumber: string;
    familyId: string;
    familyName: string;
    stage: 1 | 2 | 3;
    element: VqCardFactorySpec["element"];
    templateVersion: string;
    previousStageName: string | null;
  };
  card: VqCardRow | null;
  character: VqCharacter | null;
  validation: VqFactoryValidationIssue[];
  completionStatus: "missing" | "blocked" | "ready_for_review" | "approved_for_print";
  blockingReason: string;
  artworkStatus: "missing" | "draft" | "approved";
  dataStatus: "missing" | "draft" | "approved";
  validationStatus: "blocked" | "ready_for_review" | "approved_for_print";
  exportStatus: "blocked" | "ready";
  checklist: {
    artwork: "missing" | "draft" | "approved";
    data: "missing" | "draft" | "approved";
    preview: "blocked" | "ready";
    validation: "blocked" | "ready_for_review" | "approved_for_print";
    approval: "missing" | "current" | "stale";
    export: "blocked" | "ready";
  };
  exportReady: boolean;
  lastUpdated: string | null;
  placement: VqCardFactoryPlacement;
  approval: VqCardFactoryApprovalSnapshot | null;
  approvalState: "missing" | "current" | "stale";
  approvalStaleReason: string | null;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function standardNumber(value: string | null | undefined): string {
  return normalizeVqCollectorNumber(value);
}

function configKey(kind: "placement" | "approval" | "approvals", cardId: string): string {
  return `card_factory.${kind}.${cardId}`;
}

function jsonParse<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function cardFactoryDataChecksum(card: VqCardRow): string {
  return sha256(
    JSON.stringify({
      collectorNumber: card.collectorNumber,
      name: card.name,
      displayName: card.displayName,
      cardType: card.cardType,
      element: card.element,
      rarity: card.rarity,
      familyId: card.familyId,
      stageNumber: card.stageNumber,
      lifeStage: card.lifeStage,
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
      setCode: card.setCode,
      language: card.language,
      year: card.year,
      edition: card.edition,
    })
  );
}

export function cardFactoryArtworkChecksum(card: VqCardRow): string {
  return sha256(JSON.stringify({ artR2Key: card.artR2Key ?? null, prevArtR2Key: card.prevArtR2Key ?? null }));
}

export function cardFactoryPlacementChecksum(placement: VqCardFactoryPlacement): string {
  return sha256(JSON.stringify(normalizeVqFactoryPlacement(placement)));
}

function factoryInput(
  spec: VqCardFactorySpec,
  card: VqCardRow | null,
  character: VqCharacter | null,
  family: VqFamily | null
): VqFactoryValidationInput | null {
  if (!card) return null;
  const previousStage =
    card.stageNumber === 2
      ? (family?.stage1Name ?? null)
      : card.stageNumber === 3
        ? (family?.stage2Name ?? null)
        : null;
  return {
    collectorNumber: card.collectorNumber,
    name: card.name,
    stage: card.stageNumber,
    familyId: card.familyId,
    element: card.element,
    health: card.health,
    guard: card.guard,
    shift: card.shift,
    previousStage,
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

function familyForSpec(spec: VqCardFactorySpec, families: VqFamily[], card: VqCardRow | null): VqFamily | null {
  return families.find((family) => family.familyId === (card?.familyId ?? spec.familyId)) ?? null;
}

function productionRecordForSpec(spec: VqCardFactorySpec): VqFactoryCardRow["productionRecord"] {
  return {
    cardId: spec.cardId,
    collectorNumber: spec.collectorNumber,
    familyId: spec.familyId,
    familyName: spec.familyName,
    stage: spec.stage,
    element: spec.element,
    templateVersion: VQ_CARD_FACTORY_TEMPLATE_VERSION,
    previousStageName: spec.expectedPreviousName,
  };
}

export function resolveFactoryApprovalState(
  card: VqCardRow | null,
  placement: VqCardFactoryPlacement,
  approval: VqCardFactoryApprovalSnapshot | null
): Pick<VqFactoryCardRow, "approvalState" | "approvalStaleReason"> {
  if (!card || !approval) return { approvalState: "missing", approvalStaleReason: null };
  if (approval.templateVersion !== VQ_CARD_FACTORY_TEMPLATE_VERSION)
    return { approvalState: "stale", approvalStaleReason: "Template version changed." };
  if (approval.dataChecksum !== cardFactoryDataChecksum(card))
    return { approvalState: "stale", approvalStaleReason: "Card data changed after approval." };
  if (approval.artworkChecksum !== cardFactoryArtworkChecksum(card))
    return { approvalState: "stale", approvalStaleReason: "Artwork pointer changed after approval." };
  if (approval.placementChecksum !== cardFactoryPlacementChecksum(placement))
    return { approvalState: "stale", approvalStaleReason: "Artwork placement changed after approval." };
  return { approvalState: "current", approvalStaleReason: null };
}

function rowStatus(
  card: VqCardRow | null,
  validation: VqFactoryValidationIssue[],
  approvalState: VqFactoryCardRow["approvalState"]
): VqFactoryCardRow["completionStatus"] {
  if (!card) return "missing";
  if (validation.some((issue) => issue.severity === "blocker")) return "blocked";
  if (["approved", "export_ready", "printed_proxy"].includes(card.status) && approvalState === "current")
    return "approved_for_print";
  return "ready_for_review";
}

export async function getFactoryRows(): Promise<VqFactoryCardRow[]> {
  const [cards, characters, families] = await Promise.all([
    vqStorage.listCards({ setCode: "GNV" }),
    vqStorage.listCharacters("GNV"),
    vqStorage.listFamilies("GNV"),
  ]);
  const config = await vqStorage.getConfig();
  const inputs = VQ_STANDARD_CARD_SPECS.map((spec) => {
    const card = findCardForSpec(spec, cards);
    return factoryInput(spec, card, null, familyForSpec(spec, families, card));
  }).filter(Boolean) as VqFactoryValidationInput[];
  return VQ_STANDARD_CARD_SPECS.map((spec) => {
    const card = findCardForSpec(spec, cards);
    const character = characterForSpec(spec, characters, card);
    const family = familyForSpec(spec, families, card);
    const placement = normalizeVqFactoryPlacement(
      card ? jsonParse(config[configKey("placement", card.cardId)], VQ_CARD_FACTORY_PLACEMENT_DEFAULT) : null
    );
    const approval = card
      ? jsonParse<VqCardFactoryApprovalSnapshot | null>(config[configKey("approval", card.cardId)], null)
      : null;
    const approvalView = resolveFactoryApprovalState(card, placement, approval);
    const input = factoryInput(spec, card, character, family);
    const validation = validateVqFactoryCard(spec, input, inputs);
    if (approvalView.approvalState === "stale") {
      validation.push({
        code: "approval_stale",
        field: "approval",
        message: approvalView.approvalStaleReason ?? "Approval is stale.",
        severity: "blocker",
      });
    }
    const completionStatus = rowStatus(card, validation, approvalView.approvalState);
    const artworkStatus = input?.artR2Key
      ? approvalView.approvalState === "current"
        ? "approved"
        : "draft"
      : "missing";
    const dataStatus = !card
      ? "missing"
      : validation.some(
            (issue) =>
              !["artR2Key", "prevArtR2Key", "artwork", "approval"].includes(issue.field) &&
              issue.code !== "missing_artwork" &&
              issue.code !== "unapproved_artwork" &&
              issue.code !== "approval_stale"
          )
        ? "draft"
        : "approved";
    const validationStatus =
      completionStatus === "approved_for_print"
        ? "approved_for_print"
        : completionStatus === "ready_for_review"
          ? "ready_for_review"
          : "blocked";
    const exportStatus = completionStatus === "approved_for_print" ? "ready" : "blocked";
    return {
      spec,
      productionRecord: productionRecordForSpec(spec),
      card,
      character,
      validation,
      completionStatus,
      blockingReason: validation.find((issue) => issue.severity === "blocker")?.message ?? "",
      artworkStatus,
      dataStatus,
      validationStatus,
      exportStatus,
      checklist: {
        artwork: artworkStatus,
        data: dataStatus,
        preview: validation.some((issue) => issue.severity === "blocker") ? "blocked" : "ready",
        validation: validationStatus,
        approval: approvalView.approvalState,
        export: exportStatus,
      },
      exportReady: completionStatus === "approved_for_print",
      lastUpdated: card?.updatedAt
        ? card.updatedAt.toISOString()
        : character?.updatedAt
          ? character.updatedAt.toISOString()
          : null,
      placement,
      approval,
      approvalState: approvalView.approvalState,
      approvalStaleReason: approvalView.approvalStaleReason,
    };
  });
}

export function buildFactoryProgress(rows: VqFactoryCardRow[]) {
  const total = rows.length;
  const cardsCompleted = rows.filter((row) => row.completionStatus === "approved_for_print").length;
  const cardsAwaitingArtwork = rows.filter((row) => row.artworkStatus === "missing").length;
  const cardsAwaitingData = rows.filter((row) => row.dataStatus !== "approved").length;
  const cardsAwaitingApproval = rows.filter((row) => row.completionStatus === "ready_for_review").length;
  const cardsExportReady = rows.filter((row) => row.exportReady).length;
  return {
    total,
    cardsCompleted,
    cardsAwaitingArtwork,
    cardsAwaitingData,
    cardsAwaitingApproval,
    cardsExportReady,
    percentageComplete: total === 0 ? 0 : Math.round((cardsCompleted / total) * 100),
  };
}

export type VqFactoryQueueSort =
  | "collector"
  | "family"
  | "stage"
  | "artwork_missing"
  | "data_missing"
  | "ready_for_review";

function statusPriority(row: VqFactoryCardRow, sort: VqFactoryQueueSort): number {
  if (sort === "artwork_missing") return row.artworkStatus === "missing" ? 0 : 1;
  if (sort === "data_missing") return row.dataStatus !== "approved" ? 0 : 1;
  if (sort === "ready_for_review") return row.completionStatus === "ready_for_review" ? 0 : 1;
  return 0;
}

export function buildFactoryWorkQueue(rows: VqFactoryCardRow[], sort: VqFactoryQueueSort = "collector") {
  const blocked = rows.filter((row) => !row.exportReady);
  return [...blocked].sort((a, b) => {
    const priority = statusPriority(a, sort) - statusPriority(b, sort);
    if (priority !== 0) return priority;
    if (sort === "family") {
      const family = a.spec.familyName.localeCompare(b.spec.familyName);
      if (family !== 0) return family;
    }
    if (sort === "stage") {
      const stage = a.spec.stage - b.spec.stage;
      if (stage !== 0) return stage;
    }
    return a.spec.collectorNumber.localeCompare(b.spec.collectorNumber);
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

export async function applyFactoryPlacementToMainArt(
  mainArt: Buffer,
  placement: VqCardFactoryPlacement
): Promise<Buffer> {
  const normalized = normalizeVqFactoryPlacement(placement);
  const meta = await sharp(mainArt).metadata();
  const sourceWidth = meta.width ?? ART_WINDOW.widthPx;
  const sourceHeight = meta.height ?? ART_WINDOW.heightPx;
  const coverScale = Math.max(ART_WINDOW.widthPx / sourceWidth, ART_WINDOW.heightPx / sourceHeight) * normalized.scale;
  const resizedWidth = Math.max(1, Math.round(sourceWidth * coverScale));
  const resizedHeight = Math.max(1, Math.round(sourceHeight * coverScale));
  const extraX = Math.max(0, resizedWidth - ART_WINDOW.widthPx);
  const extraY = Math.max(0, resizedHeight - ART_WINDOW.heightPx);
  const left = Math.max(0, Math.min(extraX, Math.round(extraX / 2 + (normalized.xOffsetPct / 100) * (extraX / 2))));
  const top = Math.max(0, Math.min(extraY, Math.round(extraY / 2 + (normalized.yOffsetPct / 100) * (extraY / 2))));
  return sharp(mainArt)
    .resize(resizedWidth, resizedHeight)
    .extract({ left, top, width: ART_WINDOW.widthPx, height: ART_WINDOW.heightPx })
    .png()
    .toBuffer();
}

async function placedArt(card: VqCardRow, placement: VqCardFactoryPlacement) {
  const art = await fetchArt(card);
  if (!art.mainArt) return art;
  return { ...art, mainArt: await applyFactoryPlacementToMainArt(art.mainArt, placement) };
}

export async function validateFactoryRender(row: VqFactoryCardRow): Promise<VqFactoryCardRow> {
  if (!row.card) return row;
  if (row.validation.some((issue) => issue.severity === "blocker")) return row;
  const result = await renderCard(renderInput(row.spec, row.card), await placedArt(row.card, row.placement), "preview");
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
    await placedArt(row.card, row.placement),
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

export async function saveFactoryPlacement(
  cardId: string,
  placement: Partial<VqCardFactoryPlacement>
): Promise<VqCardFactoryPlacement> {
  const normalized = normalizeVqFactoryPlacement(placement);
  await vqStorage.setConfig(configKey("placement", cardId), JSON.stringify(normalized));
  return normalized;
}

export async function approveFactoryCard(
  row: VqFactoryCardRow,
  approver: string
): Promise<VqCardFactoryApprovalSnapshot> {
  if (!row.card) throw new Error("No card data exists for this Standard slot.");
  const checked = await validateFactoryRender(row);
  const blocker = checked.validation.find((issue) => issue.severity === "blocker");
  if (blocker) throw new Error(blocker.message);
  const render = await renderCard(renderInput(row.spec, row.card), await placedArt(row.card, row.placement), "preview");
  if (!render.previewPng) throw new Error("Preview render failed.");
  const history = jsonParse<VqCardFactoryApprovalSnapshot[]>(
    (await vqStorage.getConfig())[configKey("approvals", row.card.cardId)],
    []
  );
  const snapshot: VqCardFactoryApprovalSnapshot = {
    version: history.length + 1,
    state: "approved_for_print",
    templateVersion: VQ_CARD_FACTORY_TEMPLATE_VERSION,
    dataChecksum: cardFactoryDataChecksum(row.card),
    artworkChecksum: cardFactoryArtworkChecksum(row.card),
    placementChecksum: cardFactoryPlacementChecksum(row.placement),
    renderChecksum: sha256(render.previewPng),
    validationChecksum: sha256(JSON.stringify(checked.validation)),
    approver,
    approvedAt: new Date().toISOString(),
  };
  await vqStorage.setConfig(configKey("approval", row.card.cardId), JSON.stringify(snapshot));
  await vqStorage.setConfig(configKey("approvals", row.card.cardId), JSON.stringify([...history, snapshot]));
  await vqStorage.setCardStatusAudited(
    row.card.cardId,
    "approved",
    `Card Factory print approval v${snapshot.version}: template=${snapshot.templateVersion}; data=${snapshot.dataChecksum}; art=${snapshot.artworkChecksum}; placement=${snapshot.placementChecksum}; render=${snapshot.renderChecksum}`,
    approver
  );
  return snapshot;
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
    manufacturerProfile: VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT,
    cards: rows.map((row) => ({
      collectorNumber: row.spec.collectorNumber,
      cardName: row.spec.character,
      stage: row.spec.stage,
      family: row.spec.familyName,
      element: row.spec.element,
      rarity: row.card?.rarity ?? null,
      frontFilename: vqFactoryFilename(row.spec, "front"),
      backFilename: vqFactoryFilename(row.spec, "back"),
      version: row.approval?.version ?? null,
      approvalTimestamp: row.approval?.approvedAt ?? null,
      templateVersion: VQ_CARD_FACTORY_TEMPLATE_VERSION,
      dataChecksum: row.card ? cardFactoryDataChecksum(row.card) : null,
      artworkChecksum: row.card ? cardFactoryArtworkChecksum(row.card) : null,
      placementChecksum: cardFactoryPlacementChecksum(row.placement),
      renderChecksum: row.approval?.renderChecksum ?? null,
      frontChecksum: null,
      backChecksum: null,
      status: row.completionStatus,
      approvalState: row.approvalState,
      blockingReason: row.blockingReason,
    })),
  };
}

export function buildFactoryCsvManifest(rows: VqFactoryCardRow[]): string {
  const header = [
    "collectorNumber",
    "cardName",
    "stage",
    "family",
    "element",
    "status",
    "approvalState",
    "frontFilename",
    "backFilename",
    "dataChecksum",
    "artworkChecksum",
    "placementChecksum",
    "renderChecksum",
    "blockingReason",
  ];
  const csv = [header.join(",")];
  for (const row of rows) {
    const values = [
      row.spec.collectorNumber,
      row.spec.character,
      String(row.spec.stage),
      row.spec.familyName,
      row.spec.element,
      row.completionStatus,
      row.approvalState,
      vqFactoryFilename(row.spec, "front"),
      vqFactoryFilename(row.spec, "back"),
      row.card ? cardFactoryDataChecksum(row.card) : "",
      row.card ? cardFactoryArtworkChecksum(row.card) : "",
      cardFactoryPlacementChecksum(row.placement),
      row.approval?.renderChecksum ?? "",
      row.blockingReason,
    ];
    csv.push(values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
  }
  return `${csv.join("\n")}\n`;
}

export function buildFactoryMissingBlockedReport(rows: VqFactoryCardRow[]): string {
  const lines = [
    "Vault Quest Card Factory Missing/Blocked Report",
    `Template: ${VQ_CARD_FACTORY_TEMPLATE_VERSION}`,
    VQ_CARD_FACTORY_MANUFACTURER_PROFILE_CONTRACT.warning,
    "",
  ];
  for (const row of rows) {
    if (row.exportReady) continue;
    lines.push(
      `${row.spec.collectorNumber} ${row.spec.character}: ${row.blockingReason || row.validation.map((issue) => issue.message).join("; ") || "Not approved for export"}`
    );
  }
  return `${lines.join("\n")}\n`;
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
