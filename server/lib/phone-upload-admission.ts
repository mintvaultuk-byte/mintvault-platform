import type { NextFunction, Request, Response } from "express";

/**
 * Bounded admission ahead of the phone-QR upload's memory storage.
 *
 * `phoneUpload` (server/lib/multer-configs.ts) uses multer.memoryStorage with a
 * 30 MB fileSize cap, and the mobile page uploads the RAW camera file with no
 * client-side compression (client/src/pages/mobile-upload.tsx) — so the cap is
 * legitimate and must not be lowered. What was missing is a ceiling on how many
 * of those bodies may be in flight at once.
 *
 * MEASURED (2026-08-27, disposable loopback runtime, real server):
 *   12 concurrent 29 MB uploads → 771.8 MB of external/ArrayBuffer allocation,
 *   RSS 433.8 MB → 648.9 MB. That is ~64 MB resident per in-flight upload —
 *   roughly 2x the file, because busboy's chunks and the concatenated buffer
 *   are both live. Extrapolated, ~30 concurrent bodies exhaust the 2 GB Fly
 *   machine (fly.toml: memory = "2gb", cpus = 1).
 *
 * MEASURED legitimate upload peak (sharp, 2026-08-27):
 *   12 MP (4032x3024, typical iPhone) -> 34.9 MB raw decode, +48.3 MB RSS.
 *   48 MP (8064x6048, high-end)       -> 139.5 MB raw decode, +114.5 MB RSS.
 *   Worst realistic upload is therefore ~180 MB peak (a 30 MB file's ~64 MB of
 *   buffering plus a 48 MP decode); a typical 4 MB phone photo is ~56 MB.
 *
 * DERIVATION of the default (4):
 *   2048 MB machine - ~336 MB measured working set under load = ~1712 MB free.
 *   Node does not degrade gracefully into an OOM kill, so budget at most half
 *   of that for upload bursts: ~850 MB. At the ~180 MB worst case that is ~4.7
 *   concurrent uploads; at the ~56 MB typical case it would allow ~15.
 *   Take the worst case: 4. Worst-case residency becomes 4 x 180 MB = 720 MB on
 *   top of the 336 MB working set, ~1056 MB total, leaving ~990 MB of headroom.
 *
 *   Real demand is far below this: the QR flow is one photo per displayed code,
 *   so per-machine concurrency is realistically 1-2, and 4 leaves 2-4x headroom.
 *   The counter is per-process, so the two-machine fleet allows 8 in aggregate
 *   while each machine stays individually bounded - which is what prevents the
 *   OOM. The scanner's equivalent gate (server/lib/scanner-evidence-admission.ts)
 *   defaults to 2 for its larger 128 MiB TIFFs; this is the same idiom, sized for
 *   this route. The goal is not throughput: it is that legitimate traffic can
 *   never exhaust a machine.
 *
 * Deliberately a separate module rather than a parameter on the scanner gate:
 * the scanner's behaviour must not change, and the two limits are independent.
 */
export type PhoneUploadAdmission = {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  stats: () => { active: number; max: number; rejected: number };
};

function positiveBoundedInteger(raw: string | undefined, fallback: number, ceiling: number): number {
  const value = Number.parseInt(raw || "", 10);
  return Number.isSafeInteger(value) && value >= 1 && value <= ceiling ? value : fallback;
}

export function createPhoneUploadAdmission(
  max = positiveBoundedInteger(process.env.PHONE_UPLOAD_CONCURRENCY, 4, 8)
): PhoneUploadAdmission {
  let active = 0;
  let rejected = 0;
  return {
    middleware(_req, res, next) {
      if (active >= max) {
        rejected += 1;
        res.setHeader("Retry-After", "5");
        res
          .status(503)
          .json({ error: "Upload capacity is busy; please retry in a moment", code: "upload_backpressure" });
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

export const phoneUploadAdmission = createPhoneUploadAdmission();
