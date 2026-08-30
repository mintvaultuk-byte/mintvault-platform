import type { NextFunction, Request, Response } from "express";

export const MIB = 1024 * 1024;

export type UploadMemoryBudgetStats = {
  activeBytes: number;
  activeReservations: number;
  maxBytes: number;
  rejected: number;
};

function configuredBudgetBytes(): number {
  const requestedMiB = Number.parseInt(process.env.UPLOAD_MEMORY_BUDGET_MB || "", 10);
  const boundedMiB =
    Number.isSafeInteger(requestedMiB) && requestedMiB >= 512 && requestedMiB <= 1536 ? requestedMiB : 768;
  return boundedMiB * MIB;
}

/**
 * One weighted process budget for every in-memory upload and image decode.
 *
 * A request reserves its worst-case route footprint before multer reads a byte.
 * Raw caps alone are insufficient because sharp/TIFF decodes and busboy buffer
 * concatenation coexist with the uploaded Buffer. The 768 MiB default fits the
 * largest supported single route on a 2 GiB Machine while leaving runtime/DB/
 * V8 headroom. All route classes draw from this same counter, so individually
 * safe semaphores cannot add up to an OOM.
 */
export function createUploadMemoryBudget(maxBytes = configuredBudgetBytes()) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("upload memory budget must be positive");
  let activeBytes = 0;
  let activeReservations = 0;
  let rejected = 0;

  const reserve = (label: string, reservationBytes: number) => {
    if (!/^[a-z0-9_-]+$/.test(label)) throw new Error("invalid upload admission label");
    if (!Number.isSafeInteger(reservationBytes) || reservationBytes < 1) {
      throw new Error("upload admission reservation must be positive");
    }

    return (_req: Request, res: Response, next: NextFunction): void => {
      if (reservationBytes > maxBytes || activeBytes + reservationBytes > maxBytes) {
        rejected += 1;
        res.setHeader("Retry-After", "5");
        res.status(503).json({ error: "Upload capacity is busy; retry shortly", code: "upload_backpressure" });
        return;
      }

      activeBytes += reservationBytes;
      activeReservations += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeBytes = Math.max(0, activeBytes - reservationBytes);
        activeReservations = Math.max(0, activeReservations - 1);
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    };
  };

  const stats = (): UploadMemoryBudgetStats => ({ activeBytes, activeReservations, maxBytes, rejected });
  return { reserve, stats };
}

export const uploadMemoryBudget = createUploadMemoryBudget();

/** Reserve whole MiB values so route inventory stays auditable beside multer caps. */
export function uploadMemoryAdmission(label: string, reservationMiB: number) {
  return uploadMemoryBudget.reserve(label, reservationMiB * MIB);
}

const jsonBodyAdmission = uploadMemoryAdmission("json_body", 4);
const formBodyAdmission = uploadMemoryAdmission("urlencoded_body", 1);

/**
 * Protect the global parsers before session/auth exists. Missing Content-Length
 * (chunked transfer) reserves the full parser footprint; a declared oversize is
 * rejected without consuming the body, and a lying undersize is still stopped
 * by the parser's own byte limit.
 */
export function requestBodyMemoryAdmission(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) return next();
  const mediaType = String(req.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const json = mediaType === "application/json" || mediaType.endsWith("+json");
  const form = mediaType === "application/x-www-form-urlencoded";
  if (!json && !form) return next();

  const rawLength = req.headers["content-length"];
  const length = rawLength === undefined ? null : Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
  if (length !== null && (!Number.isSafeInteger(length) || length < 0)) {
    res.status(400).json({ error: "Invalid Content-Length" });
    return;
  }
  const parserLimit = json ? MIB : 100 * 1024;
  if (length !== null && length > parserLimit) {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }
  (json ? jsonBodyAdmission : formBodyAdmission)(req, res, next);
}
