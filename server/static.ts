import express, { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { getSeoMeta, isKnownPublicRoute, type SeoMeta } from "./seo-config";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function injectMeta(html: string, meta: SeoMeta): string {
  const title = escapeHtml(meta.title);
  const desc  = escapeHtml(meta.description);
  const canon = escapeHtml(meta.canonical);
  const image = meta.ogImage ? escapeHtml(meta.ogImage) : "";

  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${desc}" />`)
    .replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${title}" />`)
    .replace(/<meta property="og:description"[^>]*>/i, `<meta property="og:description" content="${desc}" />`)
    .replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${canon}" />`)
    .replace(/<meta name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${title}" />`)
    .replace(/<meta name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${desc}" />`);

  // Inject canonical, image and robots before </head>. This is rendered on the
  // initial response rather than waiting for client-side effects.
  const extras = [
    `  <link rel="canonical" href="${canon}" />`,
    image ? `  <meta property="og:image" content="${image}" />` : "",
    image ? `  <meta name="twitter:image" content="${image}" />` : "",
    meta.noindex ? `  <meta name="robots" content="noindex, nofollow" />` : "",
  ].filter(Boolean).join("\n");

  out = out.replace("</head>", `${extras}\n  </head>`);
  return out;
}

export function renderPublicHtml(baseHtml: string, pathname: string): { status: number; html: string; noindex: boolean } {
  if (isKnownPublicRoute(pathname)) {
    const meta = getSeoMeta(pathname);
    return { status: 200, html: injectMeta(baseHtml, meta), noindex: !!meta.noindex };
  }

  const notFound: SeoMeta = {
    title: "Page Not Found | MintVault UK",
    description: "The page you requested could not be found.",
    canonical: "https://mintvaultuk.com",
    noindex: true,
  };
  return { status: 404, html: injectMeta(baseHtml, notFound), noindex: true };
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // Cache the base HTML at startup — it doesn't change between requests
  const indexPath = path.resolve(distPath, "index.html");
  const baseHtml = fs.readFileSync(indexPath, "utf-8");

  // Fall through only for recognised client routes. Unknown paths are a real
  // 404 with noindex rather than an indexable SPA soft-404.
  app.use("/{*path}", (req: Request, res: Response) => {
    const rendered = renderPublicHtml(baseHtml, req.path);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (rendered.noindex) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.status(rendered.status).send(rendered.html);
  });
}
