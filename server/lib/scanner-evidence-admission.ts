import type { NextFunction, Request, Response } from "express";
import { uploadMemoryAdmission, uploadMemoryBudget } from "./upload-memory-admission";

/**
 * Bounded admission ahead of multer's legacy memory storage.
 *
 * A 1200-DPI TIFF is intentionally large. Until the signed R2 staging
 * protocol replaces this compatibility receive path, accepting an arbitrary
 * number of multipart bodies would permit a burst to reserve unbounded Node
 * heap. This gate runs before multer begins reading a body and applies
 * backpressure (503 + Retry-After) rather than queueing large request streams
 * in memory. The Scanner's existing idempotent local queue retries it.
 */
export type ScannerEvidenceAdmission = {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  stats: () => { active: number; max: number; rejected: number };
};

function positiveBoundedInteger(raw: string | undefined, fallback: number, ceiling: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isSafeInteger(value) && value >= 1 && value <= ceiling ? value : fallback;
}

export function createScannerEvidenceAdmission(
  max = positiveBoundedInteger(process.env.SCANNER_EVIDENCE_INGEST_CONCURRENCY, 2, 8)
): ScannerEvidenceAdmission {
  let active = 0;
  let rejected = 0;
  return {
    middleware(_req, res, next) {
      if (active >= max) {
        rejected += 1;
        res.setHeader("Retry-After", "5");
        res
          .status(503)
          .json({ error: "Scanner evidence intake is busy; retry shortly", code: "scanner_evidence_backpressure" });
        return;
      }
      active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
      // `close` also fires after a normal finish on some Node/Express paths;
      // the idempotent release avoids a double decrement.
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    stats: () => ({ active, max, rejected }),
  };
}

export const scannerEvidenceAdmission = {
  // 128 MiB TIFF plus raw decode and evidence-derivative headroom.
  middleware: uploadMemoryAdmission("scanner_evidence", 512),
  stats: uploadMemoryBudget.stats,
};
