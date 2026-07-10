/**
 * Genesis Production Studio routes (Phase 4). VQ-only, admin-gated.
 *
 * Read routes degrade gracefully when the Phase-4 tables aren't migrated yet.
 * Write routes surface a clear "apply migrations-vq/0007" message instead of a
 * raw 500 when the tables are absent. Registered alongside the existing VQ admin
 * routes; touches no grading/cert/payment surface.
 */
import type { Express, Request, Response } from "express";
import { requireAdmin } from "../auth";
import { productionStorage, isUndefinedTable } from "../vault-quest/production-storage";

function isMissingTable(err: unknown): boolean {
  return isUndefinedTable(err);
}
function handleWriteError(res: Response, err: unknown) {
  if (isMissingTable(err)) {
    return res.status(501).json({
      error: "Vault Quest production tables are not migrated yet. Apply migrations-vq/0007_production_studio.sql to enable this feature.",
      needsMigration: true,
    });
  }
  console.error("[vq-production] write failed:", (err as Error)?.message);
  return res.status(500).json({ error: "Vault Quest production write failed" });
}

export function registerVaultQuestProductionRoutes(app: Express): void {
  const base = "/api/admin/vault-quest/sets/:setCode";

  // ── Production status (the pipeline/dashboard/founder feed) ──
  app.get(`${base}/production`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      res.json(await productionStorage.getProductionStatus(req.params.setCode));
    } catch (err) {
      console.error("[vq-production] status failed:", (err as Error)?.message);
      res.status(500).json({ error: "Failed to compute production status" });
    }
  });

  // ── Set Settings ──
  app.get(`${base}/settings`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    res.json((await productionStorage.getSettings(req.params.setCode)) ?? {});
  });
  app.put(`${base}/settings`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      const existing = await productionStorage.getSettings(req.params.setCode);
      if (existing?.locked && !req.body?.__unlock) return res.status(409).json({ error: "Set settings are locked. Unlock before editing." });
      res.json(await productionStorage.upsertSettings(req.params.setCode, req.body ?? {}));
    } catch (err) {
      handleWriteError(res, err);
    }
  });

  // ── Packaging ──
  app.get(`${base}/packaging`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    res.json(await productionStorage.listPackaging(req.params.setCode));
  });
  app.post(`${base}/packaging`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      if (!req.body?.type || !req.body?.name) return res.status(400).json({ error: "type and name required" });
      res.status(201).json(await productionStorage.createPackaging(req.params.setCode, req.body));
    } catch (err) {
      handleWriteError(res, err);
    }
  });
  app.patch(`${base}/packaging/:id`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      res.json(await productionStorage.updatePackaging(Number(req.params.id), req.body ?? {}));
    } catch (err) {
      handleWriteError(res, err);
    }
  });

  // ── Pack config ──
  app.get(`${base}/pack-config`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    res.json((await productionStorage.getPackConfig(req.params.setCode)) ?? {});
  });
  app.put(`${base}/pack-config`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      res.json(await productionStorage.upsertPackConfig(req.params.setCode, req.body ?? {}));
    } catch (err) {
      handleWriteError(res, err);
    }
  });

  // ── Print exports ──
  app.get(`${base}/print`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    res.json(await productionStorage.listPrint(req.params.setCode));
  });
  app.post(`${base}/print`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      if (!req.body?.type) return res.status(400).json({ error: "type required" });
      res.status(201).json(await productionStorage.createPrint(req.params.setCode, req.body));
    } catch (err) {
      handleWriteError(res, err);
    }
  });
  app.patch(`${base}/print/:id`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      res.json(await productionStorage.updatePrint(Number(req.params.id), req.body ?? {}));
    } catch (err) {
      handleWriteError(res, err);
    }
  });

  // ── QA ──
  app.get(`${base}/qa`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    res.json(await productionStorage.listQa(req.params.setCode));
  });
  app.post(`${base}/qa`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      if (!req.body?.assetType || !req.body?.assetRef) return res.status(400).json({ error: "assetType and assetRef required" });
      res.status(201).json(await productionStorage.createQa(req.params.setCode, req.body));
    } catch (err) {
      handleWriteError(res, err);
    }
  });
  app.patch(`${base}/qa/:id`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      res.json(await productionStorage.updateQa(Number(req.params.id), req.body ?? {}));
    } catch (err) {
      handleWriteError(res, err);
    }
  });

  // ── Release ──
  app.get(`${base}/release`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    res.json((await productionStorage.getRelease(req.params.setCode)) ?? {});
  });
  app.put(`${base}/release`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      res.json(await productionStorage.upsertRelease(String(req.params.setCode), req.body ?? {}));
    } catch (err) {
      handleWriteError(res, err);
    }
  });

  // ── Asset library ──
  app.get(`${base}/assets`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    res.json(await productionStorage.listAssets(String(req.params.setCode)));
  });
  app.post(`${base}/assets`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      if (!req.body?.category || !req.body?.name) return res.status(400).json({ error: "category and name required" });
      res.status(201).json(await productionStorage.createAsset(String(req.params.setCode), req.body));
    } catch (err) {
      handleWriteError(res, err);
    }
  });

  // ── Stage override (manual approve/lock/needs-review a stage) ──
  app.post(`${base}/stage/:stageKey`, requireAdmin, async (req: Request<Record<string, string>>, res: Response) => {
    try {
      if (!req.body?.status) return res.status(400).json({ error: "status required" });
      res.json(await productionStorage.setStageStatus(String(req.params.setCode), String(req.params.stageKey), String(req.body.status), req.body.note));
    } catch (err) {
      handleWriteError(res, err);
    }
  });
}
