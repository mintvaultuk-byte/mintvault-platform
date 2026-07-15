import { createHash } from "node:crypto";
import type { Express, Request, Response } from "express";
import { requireAdmin } from "../auth";
import {
  approveFactoryCard,
  buildFactoryCsvManifest,
  buildFactoryManifest,
  buildFactoryMissingBlockedReport,
  buildFactoryProofPdf,
  buildFactoryProgress,
  buildFactoryWorkQueue,
  getFactoryRows,
  renderFactoryBack,
  renderFactoryFront,
  requiredFactoryRow,
  saveFactoryCardData,
  saveFactoryPlacement,
  validateFactoryRender,
} from "../vault-quest/card-factory";
import { getVqStandardSpec, normalizeVqFactoryPlacement } from "@shared/vq-card-factory";

function sendFile(res: Response, file: { buffer: Buffer; contentType: string; filename: string; checksum: string }) {
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `inline; filename="${file.filename}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-MintVault-Provider-Generation", "false");
  res.setHeader("X-Vault-Quest-Render-Checksum", file.checksum);
  res.setHeader("Content-Length", String(file.buffer.length));
  res.end(file.buffer);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function handleFactoryError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : "Card Factory action failed";
  const status = /unknown|not found/i.test(message)
    ? 404
    : /changed since|reload before saving|concurrently/i.test(message)
      ? 409
      : /not export-ready|missing|required|blocked|No card/i.test(message)
        ? 422
        : 500;
  res.status(status).json({ error: message });
}

export function registerVaultQuestCardFactoryRoutes(app: Express): void {
  const base = "/api/admin/vault-quest/card-factory";

  app.get(`${base}/dashboard`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await getFactoryRows();
      const progress = buildFactoryProgress(rows);
      const workQueue = buildFactoryWorkQueue(rows);
      const totals = {
        total: rows.length,
        fullyReady: progress.cardsCompleted,
        missingData: rows.filter(
          (row) =>
            row.dataStatus === "missing" ||
            row.validation.some((issue) => issue.code.startsWith("missing_") && !issue.code.includes("artwork"))
        ).length,
        missingArtwork: rows.filter((row) => row.artworkStatus === "missing").length,
        invalidRelationships: rows.filter((row) =>
          row.validation.some((issue) =>
            ["stage1_previous", "stage1_prev_portrait", "wrong_evolves_from", "missing_previous_portrait"].includes(
              issue.code
            )
          )
        ).length,
        readyForReview: rows.filter((row) => row.completionStatus === "ready_for_review").length,
        readyForExport: progress.cardsExportReady,
      };
      res.json({
        rows,
        totals,
        progress,
        workQueue: workQueue.map((row) => row.spec.collectorNumber),
        providerGeneration: false,
      });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.get(`${base}/cards/:collectorNumber`, requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await requiredFactoryRow(String(req.params.collectorNumber));
      res.json({ row, providerGeneration: false });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/cards/:collectorNumber/validate`, requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await validateFactoryRender(await requiredFactoryRow(String(req.params.collectorNumber)));
      res.json({ row, providerGeneration: false });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/validate-all`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await getFactoryRows();
      const checked = await Promise.all(rows.map((row) => validateFactoryRender(row)));
      res.json({ rows: checked, count: checked.length, providerGeneration: false });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.put(`${base}/cards/:collectorNumber/placement`, requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await requiredFactoryRow(String(req.params.collectorNumber));
      if (!row.card) return res.status(422).json({ error: "No card data exists for this Standard slot.", row });
      if (JSON.stringify(req.body ?? {}).length > 1000)
        return res.status(413).json({ error: "Placement payload too large." });
      const input = normalizeVqFactoryPlacement(req.body ?? {});
      const placement = await saveFactoryPlacement(row.card.cardId, input);
      res.json({ placement, providerGeneration: false });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.put(`${base}/cards/:collectorNumber/data`, requireAdmin, async (req: Request, res: Response) => {
    try {
      if (JSON.stringify(req.body ?? {}).length > 12000)
        return res.status(413).json({ error: "Card data payload too large." });
      const actor = req.session?.adminEmail || "admin";
      const row = await saveFactoryCardData(String(req.params.collectorNumber), req.body ?? {}, actor);
      res.json({ row, providerGeneration: false });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/cards/:collectorNumber/approve`, requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await requiredFactoryRow(String(req.params.collectorNumber));
      const actor = req.session?.adminEmail || "admin";
      const approval = await approveFactoryCard(row, actor);
      res.json({ approval, approved: true, providerGeneration: false });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/cards/:collectorNumber/front.png`, requireAdmin, async (req: Request, res: Response) => {
    try {
      sendFile(res, await renderFactoryFront(String(req.params.collectorNumber), "master"));
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/cards/:collectorNumber/front-preview.png`, requireAdmin, async (req: Request, res: Response) => {
    try {
      sendFile(res, await renderFactoryFront(String(req.params.collectorNumber), "preview"));
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/cards/:collectorNumber/front.pdf`, requireAdmin, async (req: Request, res: Response) => {
    try {
      sendFile(res, await renderFactoryFront(String(req.params.collectorNumber), "pdf"));
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/cards/:collectorNumber/back.png`, requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await requiredFactoryRow(String(req.params.collectorNumber));
      sendFile(res, await renderFactoryBack(row.spec, "master"));
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/cards/:collectorNumber/back.pdf`, requireAdmin, async (req: Request, res: Response) => {
    try {
      const row = await requiredFactoryRow(String(req.params.collectorNumber));
      sendFile(res, await renderFactoryBack(row.spec, "pdf"));
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.get(`${base}/manifest.json`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      res.json(buildFactoryManifest(await getFactoryRows()));
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.get(`${base}/manifest.csv`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const csv = buildFactoryCsvManifest(await getFactoryRows());
      sendFile(res, {
        buffer: Buffer.from(csv),
        contentType: "text/csv; charset=utf-8",
        filename: "GV_card_factory_manifest.csv",
        checksum: sha256(Buffer.from(csv)),
      });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.get(`${base}/missing-blocked-report.txt`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const report = buildFactoryMissingBlockedReport(await getFactoryRows());
      sendFile(res, {
        buffer: Buffer.from(report),
        contentType: "text/plain; charset=utf-8",
        filename: "GV_missing_blocked_report.txt",
        checksum: sha256(Buffer.from(report)),
      });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.get(`${base}/manufacturing-readiness`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await getFactoryRows();
      const blockers = rows.filter((row) => !row.exportReady);
      res.json({
        eligible: blockers.length === 0,
        exportStructure: [
          "36 front PNGs",
          "Universal back PNG",
          "Individual print PDFs",
          "Combined proof PDF",
          "Manifest CSV",
          "Manifest JSON",
          "Checksums",
          "Template/version report",
          "Missing/blocked report",
          "README",
        ],
        manufacturerProfileStatus: "Manufacturer specification pending",
        manufacturerReady: false,
        warning: "Internal print proof — manufacturer specification pending",
        blockers: blockers.map((row) => ({
          collectorNumber: row.spec.collectorNumber,
          cardName: row.spec.character,
          reason: row.blockingReason || "Not approved for export",
        })),
      });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/manufacturing-export/plan`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await getFactoryRows();
      const blockers = rows.filter((row) => !row.exportReady);
      if (blockers.length > 0) {
        return res.status(422).json({
          error: "Final manufacturing export is blocked until all 36 cards have current Card Factory approvals.",
          providerGeneration: false,
          manufacturerReady: false,
          blockers: blockers.map((row) => ({
            collectorNumber: row.spec.collectorNumber,
            cardName: row.spec.character,
            reason: row.blockingReason || row.approvalStaleReason || "Not approved for export",
          })),
        });
      }
      res.json({
        providerGeneration: false,
        manufacturerReady: false,
        warning: "Internal print proof — manufacturer specification pending",
        order: rows.map((row) => row.spec.collectorNumber),
        contents: [
          "36 approved front PNGs",
          "Universal back PNG",
          "Individual front PDFs",
          "Combined proof PDF",
          "Manifest JSON",
          "Manifest CSV",
          "Checksums file",
          "Template/version report",
          "Missing/blocked report",
          "README",
        ],
      });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.post(`${base}/physical-proof.pdf`, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const rows = await getFactoryRows();
      const preferred = ["001", "002", "003"]
        .map((number) => rows.find((row) => row.spec.collectorNumber === number))
        .filter(Boolean);
      const proofRows = (preferred.length ? preferred : rows.slice(0, 3)) as typeof rows;
      const pdf = await buildFactoryProofPdf(proofRows);
      sendFile(res, {
        buffer: pdf,
        contentType: "application/pdf",
        filename: "GV_physical_test_print_pack.pdf",
        checksum: sha256(pdf),
      });
    } catch (err) {
      handleFactoryError(res, err);
    }
  });

  app.get(`${base}/spec/:collectorNumber`, requireAdmin, async (req: Request, res: Response) => {
    const spec = getVqStandardSpec(String(req.params.collectorNumber));
    if (!spec) return res.status(404).json({ error: "Unknown Standard collector number." });
    res.json({ spec });
  });
}
