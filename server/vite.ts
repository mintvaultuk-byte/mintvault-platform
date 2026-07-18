import { type Express } from "express";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export async function setupVite(server: Server, app: Express) {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  // node_modules may be a SYMLINK (e.g. a git worktree that shares the primary
  // checkout's install). Vite resolves package assets — like the @fontsource
  // variable fonts pulled in by the client — to their REALPATH, which then falls
  // outside the worktree root and Vite's default fs.allow. Because the
  // customLogger.error handler below escalates that 403 to process.exit(1), the
  // dev server was dying on the first font request (fs-allow deny → exit 1).
  // Explicitly allow the real node_modules directory so legitimate package
  // assets serve normally. Dev-only (setupVite never runs in production).
  const fsAllow = [projectRoot];
  try {
    const nmReal = fs.realpathSync(path.join(projectRoot, "node_modules"));
    if (!fsAllow.includes(nmReal)) fsAllow.push(nmReal);
  } catch {
    /* no node_modules (or not a symlink) — Vite's default allow is fine */
  }

  const serverOptions = {
    middlewareMode: true,
    hmr: { server, path: "/vite-hmr" },
    allowedHosts: true as const,
    fs: { allow: fsAllow },
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
