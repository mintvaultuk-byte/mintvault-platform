import express, { type Express, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { getSeoMeta, isKnownPublicRoute, type SeoMeta } from "./seo-config";
import {
  getPublicPartnerLocation,
  getPublicPartnerDirectoryState,
  isValidPublicPartnerRef,
  PublicPartnerPresenceUnavailableError,
  type PublicPartnerLocation,
} from "./partner/public-presence-service";

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
    meta.schema
      ? `  <script type="application/ld+json" data-mintvault-ssr-schema>${JSON.stringify(meta.schema).replace(/</g, "\\u003c")}</script>`
      : "",
  ].filter(Boolean).join("\n");

  out = out.replace("</head>", `${extras}\n  </head>`);
  return out;
}

function renderNotFoundHtml(baseHtml: string): { status: number; html: string; noindex: boolean } {
  const notFound: SeoMeta = {
    title: "Page Not Found | MintVault UK",
    description: "The page you requested could not be found.",
    canonical: "https://mintvaultuk.com",
    noindex: true,
  };
  return { status: 404, html: injectMeta(baseHtml, notFound), noindex: true };
}

export function renderPublicHtml(baseHtml: string, pathname: string): { status: number; html: string; noindex: boolean } {
  if (isKnownPublicRoute(pathname)) {
    const meta = getSeoMeta(pathname);
    return { status: 200, html: injectMeta(baseHtml, meta), noindex: !!meta.noindex };
  }

  return renderNotFoundHtml(baseHtml);
}

export interface PublicPartnerSeoResolver {
  directoryEnabled(): Promise<boolean>;
  profile(publicRef: string): Promise<PublicPartnerLocation | null>;
}

const defaultPublicPartnerSeoResolver: PublicPartnerSeoResolver = {
  directoryEnabled: async () => (await getPublicPartnerDirectoryState()) === "ENABLED",
  profile: getPublicPartnerLocation,
};

/**
 * Public Partner routes are data-dependent: a client-only route registration
 * would turn unpublished profiles into indexable soft 404s. Resolve these two
 * paths before returning HTML while leaving the existing deterministic static
 * renderer untouched for every established route and its unit tests.
 */
export async function renderPublicHtmlWithPartnerPresence(
  baseHtml: string,
  pathname: string,
  resolver: PublicPartnerSeoResolver = defaultPublicPartnerSeoResolver
): Promise<{ status: number; html: string; noindex: boolean }> {
  const clean = (pathname.split("?")[0].split("#")[0] || "/").replace(/\/+$/, "") || "/";
  if (clean === "/find-a-partner") {
    if (!(await resolver.directoryEnabled())) return renderNotFoundHtml(baseHtml);
    const meta = getSeoMeta(clean);
    meta.schema = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Find a MintVault Partner",
      url: "https://mintvaultuk.com/find-a-partner",
      description: meta.description,
    };
    return { status: 200, html: injectMeta(baseHtml, meta), noindex: false };
  }

  const match = clean.match(/^\/partners\/location\/([^/]+)$/);
  if (match) {
    let publicRef = "";
    try {
      publicRef = decodeURIComponent(match[1]);
    } catch {
      return renderNotFoundHtml(baseHtml);
    }
    if (!isValidPublicPartnerRef(publicRef)) return renderNotFoundHtml(baseHtml);
    const location = await resolver.profile(publicRef);
    if (!location) return renderNotFoundHtml(baseHtml);
    const canonical = `https://mintvaultuk.com/partners/location/${encodeURIComponent(location.publicRef)}`;
    const schema: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: location.displayName,
      url: canonical,
      parentOrganization: { "@type": "Organization", name: "MintVault UK", url: "https://mintvaultuk.com" },
    };
    if (location.address) {
      schema.address = { "@type": "PostalAddress", streetAddress: location.address, addressCountry: "GB" };
    }
    if (location.serviceArea) schema.areaServed = location.serviceArea;
    if (location.mapsUrl) schema.hasMap = location.mapsUrl;
    if (location.phone) schema.telephone = location.phone;
    if (location.email) schema.email = location.email;
    if (location.websiteUrl) schema.sameAs = [location.websiteUrl];
    const meta: SeoMeta = {
      title: `${location.displayName} — ${location.locationName} | MintVault Partner`,
      description: location.address
        ? `${location.displayName} is an approved MintVault Partner location at ${location.address}. View public shop details.`
        : `${location.displayName} is an approved MintVault Partner serving ${location.serviceArea}. View public contact details.`,
      canonical,
      schema,
    };
    return { status: 200, html: injectMeta(baseHtml, meta), noindex: false };
  }

  return renderPublicHtml(baseHtml, pathname);
}

// Express removes the matched portion of a mounted wildcard route from
// `req.path`. The original URL is the only stable pathname at this boundary.
export function publicRequestPath(originalUrl: string): string {
  return originalUrl || "/";
}

export const staticAssetOptions = { index: false };

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // HTML routes, including `/`, must fall through to the renderer so initial
  // responses receive their route-specific canonical and robots policy.
  app.use(express.static(distPath, staticAssetOptions));

  // Cache the base HTML at startup — it doesn't change between requests
  const indexPath = path.resolve(distPath, "index.html");
  const baseHtml = fs.readFileSync(indexPath, "utf-8");

  // Fall through only for recognised client routes. Unknown paths are a real
  // 404 with noindex rather than an indexable SPA soft-404.
  app.use("/{*path}", async (req: Request, res: Response) => {
    try {
      const rendered = await renderPublicHtmlWithPartnerPresence(baseHtml, publicRequestPath(req.originalUrl));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (rendered.noindex) res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.status(rendered.status).send(rendered.html);
    } catch (err) {
      if (!(err instanceof PublicPartnerPresenceUnavailableError)) throw err;
      const unavailable: SeoMeta = {
        title: "Partner discovery temporarily unavailable | MintVault UK",
        description: "Partner discovery is temporarily unavailable. Please try again shortly.",
        canonical: "https://mintvaultuk.com/find-a-partner",
        noindex: true,
      };
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
      res.setHeader("Retry-After", "60");
      res.status(503).send(injectMeta(baseHtml, unavailable));
    }
  });
}
