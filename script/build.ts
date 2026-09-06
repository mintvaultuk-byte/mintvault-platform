import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
import { execSync } from "child_process";
import { resolveBuildGitSha } from "./build-provenance";

// The exact commit this artifact was built from — embedded so /api/version can
// PROVE which code is actually running. A stale-checkout deploy silently wiped
// newer prod code twice this cycle; production Docker builds fail closed when
// Git is absent and no valid build argument was injected.
const checkoutGitSha = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
})();

const GIT_SHA = resolveBuildGitSha({
  checkoutSha: checkoutGitSha,
  environmentSha: process.env.GIT_SHA,
  production: process.env.NODE_ENV === "production" || process.env.BUILD_PROVENANCE_REQUIRED === "1",
});

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
      "process.env.VITE_PARTNER_NETWORK_CONSOLIDATION": JSON.stringify(
        process.env.VITE_PARTNER_NETWORK_CONSOLIDATION ?? "false"
      ),
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

  // One-off: set-name designation repair (scripts/repair-set-designations.ts).
  // DRY-RUN by default; --apply writes (single transaction, audit_log per cert).
  // Safe to remove this block once applied to prod:
  //   fly ssh console --app mintvault -C "node /app/dist/repair-set-designations.cjs"
  console.log("building one-off set-designation repair script...");
  await esbuild({
    entryPoints: ["scripts/repair-set-designations.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/repair-set-designations.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    external: externals,
    logLevel: "info",
  });

  // Incident-specific, STAGING-only Canon LiDE 400 geometry repair. The
  // artifact is inert unless deliberately invoked and is dry-run by default.
  console.log("building STAGING Canon geometry repair script...");
  await esbuild({
    entryPoints: ["scripts/staging/repair-canon-lide400-geometry.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/repair-canon-lide400-geometry.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    external: externals,
    logLevel: "info",
  });

  // Numbered migration runner for explicit one-off execution inside the Fly
  // production image. Normal web startup remains dist/index.cjs; this artifact
  // only runs when an operator deliberately invokes:
  //   node /app/dist/migrate.cjs --apply
  console.log("building numbered migration runner...");
  await esbuild({
    entryPoints: ["scripts/db/migrate.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/migrate.cjs",
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
