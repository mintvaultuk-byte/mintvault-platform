import type { NextFunction, Request, Response } from "express";
import { uploadMemoryAdmission, uploadMemoryBudget } from "./upload-memory-admission";

function configuredMaximum(): number {
  const value = Number.parseInt(process.env.PUBLIC_IMAGE_PROCESSING_CONCURRENCY || "", 10);
  return Number.isSafeInteger(value) && value >= 1 && value <= 8 ? value : 2;
}

export function createPublicImageProcessingAdmission(max = configuredMaximum()) {
  let active = 0;
  let rejected = 0;
  const middleware = (_req: Request, res: Response, next: NextFunction): void => {
    if (active >= max) {
      rejected += 1;
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: "Image processing is busy; retry shortly", code: "image_backpressure" });
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
  };
  return { middleware, stats: () => ({ active, max, rejected }) };
}

/** One process-wide budget shared by pre-grade, preview and credit-owned estimate. */
export const publicImageProcessingAdmission = {
  // Covers the largest public path: 2 x 20 MiB plus concurrent image decodes.
  middleware: uploadMemoryAdmission("public_image", 192),
  stats: uploadMemoryBudget.stats,
};
