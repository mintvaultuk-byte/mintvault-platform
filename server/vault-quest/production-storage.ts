/**
 * Genesis Production Studio — aggregation + CRUD (Phase 4).
 *
 * getProductionStatus() derives the whole set-centric pipeline from REAL data
 * (characters, families, cards) plus the new production tables. It degrades
 * gracefully: if the Phase-4 tables (migration 0007) are not applied yet, the
 * new-domain queries return empty and those stages read as "not started" — the
 * character/family/card stages stay fully live. Writes to un-migrated tables
 * surface a clear "apply 0007" error at the route layer.
 *
 * VQ-only. Touches no grading/cert/payment table.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { vqStorage } from "./storage";
import { sanitizeWrite } from "./lib/write-sanitize";
import { vqAiGenerations } from "@shared/vq-schema";
import { STATUS_META, type VqStatus } from "@shared/vq-workflow";
import {
  vqSetSettings,
  vqPackagingItems,
  vqPackConfig,
  vqPrintExports,
  vqQaChecks,
  vqReleaseState,
  vqAssetLibrary,
  vqProductionStages,
  PRODUCTION_STAGES,
  type ProductionStageState,
} from "@shared/vq-production-schema";

/** True if the error (or any wrapped cause) is Postgres "undefined_table" (42P01).
 *  Drizzle wraps the pg error in a DrizzleQueryError, so we walk the cause chain. */
export function isUndefinedTable(err: unknown): boolean {
  let e = err as { code?: string; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && e; i++) {
    if (e.code === "42P01") return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** Run a query that may hit a not-yet-migrated table; return the fallback on 42P01. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isUndefinedTable(err)) return fallback; // migration 0007 not applied — degrade gracefully
    throw err;
  }
}

/** A card counts as "done" when its workflow status is success-toned (approved/ready/published). */
function cardIsDone(status: string): boolean {
  return STATUS_META[status as VqStatus]?.tone === "success";
}

const SUPPORT_TYPES = new Set(["Tactic", "Relic", "Vault", "Place"]);
const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0);

export interface StageView {
  key: string;
  title: string;
  stage: number;
  status: ProductionStageState;
  progress: number;
  locked: boolean;
  detail: string;
}

export interface ProductionStatus {
  setCode: string;
  setName: string;
  overallProgress: number;
  nextStep: { key: string; title: string; label: string } | null;
  stages: StageView[];
  counts: {
    charactersTotal: number;
    charactersApproved: number;
    familiesTotal: number;
    familiesComplete: number;
    standardTotal: number;
    standardDone: number;
    supportTotal: number;
    supportDone: number;
    variantTotal: number;
    variantDone: number;
    collectorTotal: number;
    collectorDone: number;
    packagingTotal: number;
    packagingApproved: number;
    printReady: number;
    qaTotal: number;
    qaPassed: number;
    assetsApproved: number;
  };
  release: {
    cardsComplete: boolean;
    packagingComplete: boolean;
    qaPassed: boolean;
    printReady: boolean;
    releaseReady: boolean;
    releaseDate: string | null;
  };
  founder: {
    charactersRemaining: number;
    cardsRemaining: number;
    packagingRemaining: number;
    qaRemaining: number;
    aiGenerationsToday: number;
    aiGenerationsTotal: number;
    recentActivity: { cardId: string | null; kind: string; at: string }[];
  };
  migrationApplied: boolean;
}

export const productionStorage = {
  async getProductionStatus(setCode = "GNV"): Promise<ProductionStatus> {
    const [characters, cards, families] = await Promise.all([
      vqStorage.listCharacters(setCode).catch(() => []),
      vqStorage.listCards({ setCode }).catch(() => []),
      vqStorage.listFamilies(setCode).catch(() => []),
    ]);

    // New-domain data (may be absent until 0007 is applied).
    const settingsRow = await safe(() => db.select().from(vqSetSettings).where(eq(vqSetSettings.setCode, setCode)).then((r) => r[0]), undefined);
    const packaging = await safe(() => db.select().from(vqPackagingItems).where(eq(vqPackagingItems.setCode, setCode)), []);
    const printExports = await safe(() => db.select().from(vqPrintExports).where(eq(vqPrintExports.setCode, setCode)), []);
    const qaChecks = await safe(() => db.select().from(vqQaChecks).where(eq(vqQaChecks.setCode, setCode)), []);
    const releaseRow = await safe(() => db.select().from(vqReleaseState).where(eq(vqReleaseState.setCode, setCode)).then((r) => r[0]), undefined);
    const assets = await safe(() => db.select().from(vqAssetLibrary).where(eq(vqAssetLibrary.setCode, setCode)), []);
    const overrides = await safe(() => db.select().from(vqProductionStages).where(eq(vqProductionStages.setCode, setCode)), []);
    const migrationApplied = settingsRow !== undefined || packaging.length > 0 || overrides.length > 0
      ? true
      : await safe(async () => { await db.select().from(vqSetSettings).limit(1); return true; }, false);

    // ── counts ──
    const charactersTotal = characters.length;
    const charactersApproved = characters.filter((c) => c.approvalStatus === "approved").length;

    const familyApprovedMap = new Map<string, { total: number; approved: number }>();
    for (const c of characters) {
      const e = familyApprovedMap.get(c.familyId) ?? { total: 0, approved: 0 };
      e.total++;
      if (c.approvalStatus === "approved") e.approved++;
      familyApprovedMap.set(c.familyId, e);
    }
    const familiesTotal = families.length;
    const familiesComplete = [...familyApprovedMap.values()].filter((e) => e.total > 0 && e.approved === e.total).length;

    const variant = cards.filter((c) => c.baseCardId);
    const base = cards.filter((c) => !c.baseCardId);
    const standard = base.filter((c) => c.cardType === "Creature");
    const support = base.filter((c) => SUPPORT_TYPES.has(c.cardType));
    const collector = base.filter((c) => c.cardType === "Collector");
    const doneOf = (list: typeof cards) => list.filter((c) => cardIsDone(c.status)).length;

    const packagingApproved = packaging.filter((p) => p.approvalStatus === "approved").length;
    const printReadyCount = printExports.filter((p) => p.status === "print_ready" || p.status === "exported").length;
    const qaPassed = qaChecks.filter((q) => q.status === "approved" || q.status === "completed").length;
    const assetsApproved = assets.filter((a) => a.approved).length;

    const counts = {
      charactersTotal,
      charactersApproved,
      familiesTotal,
      familiesComplete,
      standardTotal: standard.length,
      standardDone: doneOf(standard),
      supportTotal: support.length,
      supportDone: doneOf(support),
      variantTotal: variant.length,
      variantDone: doneOf(variant),
      collectorTotal: collector.length,
      collectorDone: doneOf(collector),
      packagingTotal: packaging.length,
      packagingApproved,
      printReady: printReadyCount,
      qaTotal: qaChecks.length,
      qaPassed,
      assetsApproved,
    };

    // ── per-stage derivation ──
    const overrideByKey = new Map(overrides.map((o) => [o.stageKey, o.status as ProductionStageState]));
    const settingsHasData = !!settingsRow && Object.entries(settingsRow).some(([k, v]) => !["id", "setCode", "locked", "createdAt", "updatedAt"].includes(k) && v != null);

    const REQUIRED_PACKAGING = ["booster_wrapper", "booster_box", "starter_deck"];
    const requiredPackagingApproved = REQUIRED_PACKAGING.filter((t) => packaging.some((p) => p.type === t && p.approvalStatus === "approved")).length;

    function derive(key: string, progress: number, opts: { started?: boolean } = {}): { status: ProductionStageState; progress: number } {
      const ov = overrideByKey.get(key);
      if (ov) return { status: ov, progress: ov === "completed" ? 100 : progress };
      if (progress >= 100) return { status: "completed", progress: 100 };
      if (progress > 0 || opts.started) return { status: "in_progress", progress };
      return { status: "not_started", progress: 0 };
    }

    const raw: Record<string, { status: ProductionStageState; progress: number; detail: string }> = {
      set_setup: {
        ...(settingsRow?.locked ? { status: "completed" as ProductionStageState, progress: 100 } : derive("set_setup", settingsHasData ? 50 : 0, { started: settingsHasData })),
        detail: settingsRow?.locked ? "Locked" : settingsHasData ? "In progress" : "Not started",
      },
      characters: { ...derive("characters", pct(charactersApproved, charactersTotal)), detail: `${charactersApproved}/${charactersTotal} approved` },
      families: { ...derive("families", pct(familiesComplete, familiesTotal || 12)), detail: `${familiesComplete}/${familiesTotal} complete` },
      standard_cards: { ...derive("standard_cards", pct(counts.standardDone, counts.standardTotal)), detail: `${counts.standardDone}/${counts.standardTotal} done` },
      support_cards: { ...derive("support_cards", pct(counts.supportDone, counts.supportTotal)), detail: `${counts.supportDone}/${counts.supportTotal} done` },
      variant_cards: { ...derive("variant_cards", pct(counts.variantDone, counts.variantTotal)), detail: `${counts.variantDone}/${counts.variantTotal} done` },
      packaging: { ...derive("packaging", pct(requiredPackagingApproved, REQUIRED_PACKAGING.length)), detail: `${requiredPackagingApproved}/${REQUIRED_PACKAGING.length} core items` },
      print_files: { ...derive("print_files", pct(printReadyCount, Math.max(printExports.length, 1))), detail: `${printReadyCount} print-ready` },
      qa: { ...derive("qa", pct(qaPassed, Math.max(qaChecks.length, 1))), detail: `${qaPassed}/${qaChecks.length} passed` },
      release: { status: "not_started", progress: 0, detail: "Not started" },
    };

    // Release derives from everything upstream.
    const cardsComplete = raw.standard_cards.status === "completed" && raw.support_cards.status === "completed" && raw.variant_cards.status === "completed";
    const packagingComplete = raw.packaging.status === "completed";
    const qaComplete = raw.qa.status === "completed";
    const printReadyStage = raw.print_files.status === "completed";
    const releaseReady = cardsComplete && packagingComplete && qaComplete && printReadyStage;
    raw.release = {
      status: releaseRow?.archived ? "completed" : releaseReady ? "approved" : "not_started",
      progress: releaseRow?.archived ? 100 : releaseReady ? 90 : 0,
      detail: releaseRow?.archived ? "Archived" : releaseReady ? "Ready to release" : "Awaiting upstream stages",
    };

    // Assemble ordered stages + locking (a stage locks until the previous one completes).
    const stages: StageView[] = [];
    let prevComplete = true;
    for (const def of PRODUCTION_STAGES) {
      const r = raw[def.key];
      const locked = !prevComplete;
      stages.push({ key: def.key, title: def.title, stage: def.stage, status: r.status, progress: r.progress, locked, detail: r.detail });
      prevComplete = r.status === "completed";
    }

    const overallProgress = Math.round(stages.reduce((a, s) => a + s.progress, 0) / stages.length);
    const nextStage = stages.find((s) => s.status !== "completed" && !s.locked) ?? stages.find((s) => s.status !== "completed");
    const nextStep = nextStage ? { key: nextStage.key, title: nextStage.title, label: `Continue ${nextStage.title}` } : null;

    // ── founder metrics ──
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const recentGen = await safe(() => db.select().from(vqAiGenerations).orderBy(desc(vqAiGenerations.createdAt)).limit(10), [] as (typeof vqAiGenerations.$inferSelect)[]);
    // count(*) instead of materialising the whole vq_ai_generations table just to
    // read .length — this runs on every dashboard/workflow poll (P6-R4-01).
    const allGenCount = await safe(async () => (await db.select({ n: sql<number>`count(*)::int` }).from(vqAiGenerations))[0]?.n ?? 0, 0);
    const todayCount = recentGen.filter((g) => g.createdAt && new Date(g.createdAt) >= startOfDay).length;

    const cardsTotalAll = standard.length + support.length + variant.length + collector.length;
    const cardsDoneAll = counts.standardDone + counts.supportDone + counts.variantDone + counts.collectorDone;

    return {
      setCode,
      setName: settingsRow?.name || "Genesis Vault",
      overallProgress,
      nextStep,
      stages,
      counts,
      release: {
        cardsComplete,
        packagingComplete,
        qaPassed: qaComplete,
        printReady: printReadyStage,
        releaseReady,
        releaseDate: releaseRow?.releaseDate ?? null,
      },
      founder: {
        charactersRemaining: Math.max(charactersTotal - charactersApproved, 0),
        cardsRemaining: Math.max(cardsTotalAll - cardsDoneAll, 0),
        packagingRemaining: Math.max(REQUIRED_PACKAGING.length - requiredPackagingApproved, 0),
        qaRemaining: Math.max(qaChecks.length - qaPassed, 0),
        aiGenerationsToday: todayCount,
        aiGenerationsTotal: allGenCount,
        recentActivity: recentGen.map((g) => ({ cardId: g.cardId ?? null, kind: g.prompt ? String(g.prompt).slice(0, 40) : "generation", at: g.createdAt ? new Date(g.createdAt).toISOString() : "" })),
      },
      migrationApplied,
    };
  },

  // ── Settings ──
  getSettings: (setCode: string) => safe(() => db.select().from(vqSetSettings).where(eq(vqSetSettings.setCode, setCode)).then((r) => r[0] ?? null), null),
  async upsertSettings(setCode: string, patch: Record<string, unknown>) {
    const clean = sanitizeWrite(patch);
    const existing = await db.select().from(vqSetSettings).where(eq(vqSetSettings.setCode, setCode)).then((r) => r[0]);
    if (existing) {
      const [row] = await db.update(vqSetSettings).set({ ...clean, updatedAt: new Date() }).where(eq(vqSetSettings.setCode, setCode)).returning();
      return row;
    }
    const [row] = await db.insert(vqSetSettings).values({ ...clean, setCode }).returning();
    return row;
  },

  // ── Packaging ──
  listPackaging: (setCode: string) => safe(() => db.select().from(vqPackagingItems).where(eq(vqPackagingItems.setCode, setCode)).orderBy(vqPackagingItems.type), []),
  createPackaging: async (setCode: string, values: Record<string, unknown>) => (await db.insert(vqPackagingItems).values({ ...sanitizeWrite(values), setCode, type: String(values.type), name: String(values.name) }).returning())[0],
  updatePackaging: async (id: number, setCode: string, patch: Record<string, unknown>) => (await db.update(vqPackagingItems).set({ ...sanitizeWrite(patch), updatedAt: new Date() }).where(and(eq(vqPackagingItems.id, id), eq(vqPackagingItems.setCode, setCode))).returning())[0],

  // ── Pack config ──
  getPackConfig: (setCode: string) => safe(() => db.select().from(vqPackConfig).where(eq(vqPackConfig.setCode, setCode)).then((r) => r[0] ?? null), null),
  async upsertPackConfig(setCode: string, patch: Record<string, unknown>) {
    const clean = sanitizeWrite(patch);
    const existing = await db.select().from(vqPackConfig).where(eq(vqPackConfig.setCode, setCode)).then((r) => r[0]);
    if (existing) return (await db.update(vqPackConfig).set({ ...clean, updatedAt: new Date() }).where(eq(vqPackConfig.id, existing.id)).returning())[0];
    return (await db.insert(vqPackConfig).values({ ...clean, setCode }).returning())[0];
  },

  // ── Print exports ──
  listPrint: (setCode: string) => safe(() => db.select().from(vqPrintExports).where(eq(vqPrintExports.setCode, setCode)), []),
  createPrint: async (setCode: string, values: Record<string, unknown>) => (await db.insert(vqPrintExports).values({ ...sanitizeWrite(values), setCode, type: String(values.type) }).returning())[0],
  updatePrint: async (id: number, setCode: string, patch: Record<string, unknown>) => (await db.update(vqPrintExports).set({ ...sanitizeWrite(patch), updatedAt: new Date() }).where(and(eq(vqPrintExports.id, id), eq(vqPrintExports.setCode, setCode))).returning())[0],

  // ── QA ──
  listQa: (setCode: string) => safe(() => db.select().from(vqQaChecks).where(eq(vqQaChecks.setCode, setCode)), []),
  createQa: async (setCode: string, values: Record<string, unknown>) => (await db.insert(vqQaChecks).values({ ...sanitizeWrite(values), setCode, assetType: String(values.assetType), assetRef: String(values.assetRef) }).returning())[0],
  updateQa: async (id: number, setCode: string, patch: Record<string, unknown>) => (await db.update(vqQaChecks).set({ ...sanitizeWrite(patch), updatedAt: new Date() }).where(and(eq(vqQaChecks.id, id), eq(vqQaChecks.setCode, setCode))).returning())[0],

  // ── Release ──
  getRelease: (setCode: string) => safe(() => db.select().from(vqReleaseState).where(eq(vqReleaseState.setCode, setCode)).then((r) => r[0] ?? null), null),
  async upsertRelease(setCode: string, patch: Record<string, unknown>) {
    const clean = sanitizeWrite(patch);
    const existing = await db.select().from(vqReleaseState).where(eq(vqReleaseState.setCode, setCode)).then((r) => r[0]);
    if (existing) return (await db.update(vqReleaseState).set({ ...clean, updatedAt: new Date() }).where(eq(vqReleaseState.setCode, setCode)).returning())[0];
    return (await db.insert(vqReleaseState).values({ ...clean, setCode }).returning())[0];
  },

  // ── Asset library ──
  listAssets: (setCode: string) => safe(() => db.select().from(vqAssetLibrary).where(eq(vqAssetLibrary.setCode, setCode)).orderBy(vqAssetLibrary.category), []),
  createAsset: async (setCode: string, values: Record<string, unknown>) => (await db.insert(vqAssetLibrary).values({ ...sanitizeWrite(values), setCode, category: String(values.category), name: String(values.name) }).returning())[0],

  // ── Stage overrides ──
  async setStageStatus(setCode: string, stageKey: string, status: string, note?: string) {
    const existing = await db.select().from(vqProductionStages).where(and(eq(vqProductionStages.setCode, setCode), eq(vqProductionStages.stageKey, stageKey))).then((r) => r[0]);
    if (existing) return (await db.update(vqProductionStages).set({ status, note, updatedAt: new Date() }).where(eq(vqProductionStages.id, existing.id)).returning())[0];
    return (await db.insert(vqProductionStages).values({ setCode, stageKey, status, note }).returning())[0];
  },
};
