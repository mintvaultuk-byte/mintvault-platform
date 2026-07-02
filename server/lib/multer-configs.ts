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

export const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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
