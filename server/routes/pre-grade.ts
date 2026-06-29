/**
 * server/routes/pre-grade.ts
 *
 * Public AI pre-grade estimation routes.
 * Extracted from server/routes.ts for maintainability.
 */

import type { Express } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { rejectInvalidUploads } from "../routes";

export function registerPreGradeRoutes(app: Express): void {
  // Public AI pre-grade — 3/hour per IP. Each call invokes Claude Haiku
  // (paid). Tight cap is deliberate; expect VPN abuse to bypass over
  // time and add captcha / signed-token gating if it materialises.
  const preGradeRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "AI pre-grade is limited to 3 requests per hour per IP. Try again later." },
  });

  // TIFF preview transcoding (/api/pre-grade/preview) — sharp resize +
  // JPEG encode only, no AI cost. Higher cap so users uploading scanner
  // TIFFs for front + back can preview both sides without spending
  // grading quota. Still capped to deter abuse of the public endpoint.
  const preGradePreviewRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many preview requests. Try again later." },
  });

  // Multer config for /api/pre-grade. In-memory storage (per spec — no
  // data stored on disk or R2), 20 MB per file, accepts JPEG/PNG/TIFF.
  const preGradeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 2 },
    fileFilter: (_req, file, cb) => {
      const ok = ["image/jpeg", "image/png", "image/tiff", "image/tif", "image/x-tiff"].includes(
        (file.mimetype || "").toLowerCase()
      );
      cb(null, ok);
    },
  });

  // POST /api/pre-grade — public AI pre-grade. No auth. Rate-limited.
  // Runs the uploaded front (+ optional back) through the standard
  // display pipeline (generateImageVariants → tightenForDisplay [which
  // includes whitewashEdgesBySaturation] → maskRoundedCorners) and
  // passes the cleaned buffers to gradeCardFromBuffer (Claude Haiku).
  // Returns the full AiGrading object including per-subgrade confidence.
  // Nothing is persisted — buffers stay in memory and are discarded.
  app.post(
    "/api/pre-grade",
    preGradeRateLimit,
    preGradeUpload.fields([
      { name: "front", maxCount: 1 },
      { name: "back", maxCount: 1 },
    ]),
    async (req, res) => {
      try {
        const files = req.files as { front?: Express.Multer.File[]; back?: Express.Multer.File[] } | undefined;
        const frontFile = files?.front?.[0];
        const backFile = files?.back?.[0];
        if (!frontFile) {
          return res.status(400).json({ error: "Front image required (multipart field: 'front')." });
        }
        if (!backFile) {
          return res.status(400).json({ error: "Back image required (multipart field: 'back')." });
        }

        const uploadErr = await rejectInvalidUploads([frontFile, backFile]);
        if (uploadErr) return res.status(400).json({ error: uploadErr });

        const { generateImageVariants, gradeCardFromBuffer } = await import("../ai-grading-service");
        const { tightenForDisplay, maskRoundedCorners } = await import("../image-processing");

        const processOne = async (buf: Buffer, side: "front" | "back"): Promise<Buffer> => {
          // generateImageVariants runs deskew → cropToYellowBorder|autoCrop
          // → reCentreBitmap, then exposes the post-recentre buffer as
          // centredUnpadded — exactly what tightenForDisplay expects.
          const variants = await generateImageVariants(buf);
          const centredUnpadded = (variants as any).centredUnpadded as Buffer;
          // tightenForDisplay runs detectCardEdgesByCoverage + the per-side
          // whitewashEdgesBySaturation internally.
          const tight = await tightenForDisplay(centredUnpadded, undefined, undefined, side);
          // Final rounded-corner mask matches the standard display output.
          return await maskRoundedCorners(tight);
        };

        console.log(
          `[pre-grade] processing front=${(frontFile.buffer.length / 1024).toFixed(0)}KB back=${(backFile.buffer.length / 1024).toFixed(0)}KB`
        );
        const [frontProcessed, backProcessed] = await Promise.all([
          processOne(frontFile.buffer, "front"),
          processOne(backFile.buffer, "back"),
        ]);

        const grading = await gradeCardFromBuffer(frontProcessed, backProcessed);
        if (!grading) {
          return res.status(503).json({
            error: "AI pre-grade is temporarily unavailable. Please try again later.",
          });
        }

        res.json({ success: true, grading });
      } catch (err: any) {
        console.error("[pre-grade] failed:", err.message);
        res.status(500).json({ error: "Pre-grade failed." }); // H-d — no raw err.message to client (logged above)
      }
    }
  );

  // POST /api/pre-grade/preview — converts any sharp-readable image
  // (incl. TIFF) to a small JPEG preview for the client. In-memory only;
  // nothing persisted. Uses preGradePreviewRateLimit (20/hour/IP) so
  // previewing doesn't eat the user's 3/hour grading quota — sharp
  // resize + JPEG encode is cheap and ~10× preview headroom matches
  // realistic use (front + back × a few replacements).
  app.post("/api/pre-grade/preview", preGradePreviewRateLimit, preGradeUpload.single("image"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "Image required (multipart field: 'image')." });
      }
      const sharp = (await import("sharp")).default;
      const jpeg = await sharp(file.buffer)
        .rotate()
        .resize(800, undefined, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70, progressive: true })
        .toBuffer();
      res.set("Content-Type", "image/jpeg");
      res.set("Cache-Control", "no-store");
      res.send(jpeg);
    } catch (err: any) {
      console.error("[pre-grade/preview] failed:", err.message);
      res.status(500).json({ error: "Preview generation failed." }); // H-d — no raw err.message to client (logged above)
    }
  });
}
