#!/usr/bin/env node
/*
 * Controlled Canon LiDE physical-jig calibration runner.
 *
 * This command has no server client and no evidence-upload capability. It asks
 * the ImageCaptureCore bridge for one bounded 1200-DPI hardware acquisition,
 * produces a review-only JPEG from that TIFF, and reports a conservative card
 * edge candidate in platen millimetres. A person must visually confirm all
 * edges before any placement zone is persisted. The Scanner's Preview flow is
 * the operator-facing calibration path; this CLI remains a diagnostic tool.
 */
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const lide = require("./lib/lide400-controller");
const { detectCardBounds } = require("./lib/lide400-card-detection");


function numberArg(args, name) {
  const index = args.indexOf(`--${name}`);
  const raw = index >= 0 ? args[index + 1] : undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a finite number`);
  return value;
}

function textArg(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

function rounded(value) {
  return Number(value.toFixed(2));
}

async function reviewCalibration(pathname, appliedRegionMm, previewDirectory) {
  const image = sharp(pathname, { limitInputPixels: false }).rotate();
  const metadata = await image.metadata();
  if (metadata.format !== "tiff" || !metadata.width || !metadata.height) {
    throw new Error("Calibration bridge did not return a readable TIFF");
  }
  const previewPath = path.join(previewDirectory, `${path.basename(pathname, path.extname(pathname))}-review.jpg`);
  await image
    .clone()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(previewPath);

  const probeWidth = Math.min(1400, metadata.width);
  const { data, info } = await image
    .clone()
    .resize(probeWidth, undefined, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const region = {
    x: Number(appliedRegionMm.x),
    y: Number(appliedRegionMm.y),
    width: Number(appliedRegionMm.width),
    height: Number(appliedRegionMm.height),
  };
  const candidate = info.channels === 3 ? detectCardBounds(data, info.width, info.height, region) : null;
  return {
    previewPath,
    image: { width: metadata.width, height: metadata.height, density: metadata.density ?? null, format: metadata.format },
    cardCandidate: candidate && {
      cardBoundsMm: Object.fromEntries(Object.entries(candidate.cardBoundsMm).map(([key, value]) => [key, rounded(value)])),
      surroundingBackgroundMm: Object.fromEntries(Object.entries(candidate.surroundingBackgroundMm).map(([key, value]) => [key, rounded(value)])),
      backgroundRgb: candidate.backgroundRgb,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outputDirectory = path.resolve(textArg(args, "out"));
  const region = {
    x: numberArg(args, "x"),
    y: numberArg(args, "y"),
    width: numberArg(args, "width"),
    height: numberArg(args, "height"),
  };
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const capture = await lide.scanCalibrationRegion(outputDirectory, region);
  const review = await reviewCalibration(capture.path, capture.appliedRegionMm, outputDirectory);
  process.stdout.write(`${JSON.stringify({ startedAt, completedAt: new Date().toISOString(), capture, review })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`LiDE calibration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { detectCardBounds, reviewCalibration };
