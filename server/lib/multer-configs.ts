import multer from "multer";
import path from "path";

// Shared multer upload configs (extracted from routes.ts so domain modules can
// import them). Pure config — behaviour identical to before.

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

export const preGradeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/tiff", "image/tif", "image/x-tiff"].includes(
      (file.mimetype || "").toLowerCase()
    );
    cb(null, ok);
  },
});

export const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp)$/i.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error("Images only"));
  },
});

export const gradingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB for high-res scans
  fileFilter: (_req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp|tiff?)$/i.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

export const attachImagesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB, matches scan-ingest
  fileFilter: (_req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp|tiff?)$/i.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error("Unsupported image format"));
  },
});

export const phoneUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(jpg|jpeg|png|webp|heic)$/i.test(path.extname(file.originalname)) || file.mimetype.startsWith("image/"))
      cb(null, true);
    else cb(new Error("Images only"));
  },
});

export const hotFolderUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const gradeWithAiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export const identifyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const toolsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// V850/SilverFast 48-bit TIFF masters are approximately 52 MB in the current
// 900-DPI baseline. Keep a bounded headroom for 1200-DPI calibration captures
// (the supplied real 1200 TIFF is 101,342,372 bytes / 96.7 MiB);
// decoded-pixel limits are enforced again by image-evidence inspection.
export const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 128 * 1024 * 1024, files: 2 },
});

export const certImgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const reelAssetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB cap
});

export const ACCEPTED_UPLOAD_MIMES = new Set([
  "image/jpeg",
  "image/jpg", // less standard but seen from some clients
  "image/png",
  "image/tiff",
  "image/x-tiff", // alternate TIFF mime
  "image/webp",
]);

export const igImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (ACCEPTED_UPLOAD_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported format ${file.mimetype} — accepted: JPEG, PNG, TIFF, WebP`));
  },
});

/**
 * Supply product images. 4 MB, ONE file, and a deliberately tight mimetype gate.
 *
 * This is a first pass only: the authority validates the MAGIC BYTES and then genuinely decodes the
 * image server-side (setSupplyProductImageForSuperAdmin), because a declared mimetype and a file
 * extension are both attacker-controlled. Rejecting obvious rubbish here just keeps it out of memory.
 */
export const supplyProductImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes((file.mimetype || "").toLowerCase());
    cb(null, ok);
  },
});
