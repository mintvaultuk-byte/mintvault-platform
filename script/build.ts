import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
import { execSync } from "child_process";

// The exact commit this artifact was built from — embedded so /api/version can
// PROVE which code is actually running. A stale-checkout deploy silently wiped
// newer prod code twice this cycle; this is the machine-checkable guard against
// it. Falls back to a Fly/env value or "unknown" when git isn't in the context.
const GIT_SHA = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return (process.env.GIT_SHA || process.env.FLY_IMAGE_REF || "unknown").slice(0, 40);
  }
})();

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "bcryptjs",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "pg",
  "qrcode",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.GIT_SHA": JSON.stringify(GIT_SHA),
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // One-off: MVGS v2 prod column migration (scripts/run-mvgs-v2-migration.ts).
  // Bundled to dist so it can run inside the prod container with plain node:
  //   fly ssh console --app mintvault -C "node /app/dist/run-mvgs-v2-migration.cjs"
  // Not minified, so any prod error/stack stays legible. Safe to remove this
  // block once the migration has been applied to prod.
  console.log("building one-off mvgs-v2 migration script...");
  await esbuild({
    entryPoints: ["scripts/run-mvgs-v2-migration.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/run-mvgs-v2-migration.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
