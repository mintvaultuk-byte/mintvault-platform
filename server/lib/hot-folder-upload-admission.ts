import type { NextFunction, Request, Response } from "express";
import { uploadMemoryAdmission, uploadMemoryBudget } from "./upload-memory-admission";

export type HotFolderUploadAdmission = {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  stats: () => { active: number; max: number; rejected: number };
};

function positiveBoundedInteger(raw: string | undefined, fallback: number, ceiling: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isSafeInteger(value) && value >= 1 && value <= ceiling ? value : fallback;
}

/**
 * Bound the 50 MiB memory-storage route before multer reads a body. The watcher
 * retries transient failures, so rejecting excess work is safer than queueing
 * several full request bodies inside a 2 GiB machine.
 */
export function createHotFolderUploadAdmission(
  max = positiveBoundedInteger(process.env.HOT_FOLDER_UPLOAD_CONCURRENCY, 2, 8)
): HotFolderUploadAdmission {
  let active = 0;
  let rejected = 0;
  return {
    middleware(_req, res, next) {
      if (active >= max) {
        rejected += 1;
        res.setHeader("Retry-After", "5");
        res.status(503).json({ error: "Hot-folder intake is busy; retry shortly", code: "hot_folder_backpressure" });
        return;
      }
      active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    stats: () => ({ active, max, rejected }),
  };
}

export const hotFolderUploadAdmission = {
  // 50 MiB body + multipart copy + sharp decode/derivative headroom.
  middleware: uploadMemoryAdmission("hot_folder", 256),
  stats: uploadMemoryBudget.stats,
};
