import type { Express } from "express";
import { normalizeCertId } from "../lib/cert-id";

/**
 * Legacy-URL + SEO 301 redirects, extracted verbatim from server/routes.ts
 * (routes-split increment 3). Pure redirects — no DB, no auth, no shared state.
 * Registration order preserved: called at the exact point in registerRoutes()
 * where these routes previously sat (after the legal-page API, before the
 * cookie-consent route).
 */
export function registerRedirectRoutes(app: Express): void {
  // ── Old cert URL redirects → new DIG URL ──────────────────────────────────
  // These fire for direct URL access (e.g. scanning an old QR code with a legacy URL format)
  app.get("/cert/:certId/report", (req, res, next) => {
    const raw = req.params.certId;
    if (/^MV-/i.test(raw)) {
      return res.redirect(301, `/vault/${normalizeCertId(raw)}`);
    }
    next();
  });
  app.get("/cert/report/:certId", (req, res) => {
    res.redirect(301, `/vault/${normalizeCertId(req.params.certId)}`);
  });
  // Redirect old /dig/:certId URLs to /vault/:certId (for any slabs printed before the rename)
  app.get("/dig/:certId", (req, res) => {
    res.redirect(301, `/vault/${normalizeCertId(req.params.certId)}`);
  });

  // ── Cutover URL redirects → canonical v2 paths (SEO 301s) ─────────────────
  app.get("/how-it-works", (_req, res) => res.redirect(301, "/technology"));
  app.get("/about/the-mintvault-slab", (_req, res) => res.redirect(301, "/technology"));
  app.get("/cert", (_req, res) => res.redirect(301, "/verify"));
  app.get("/guides", (_req, res) => res.redirect(301, "/journal"));
  app.get("/guides/:slug", (req, res) => res.redirect(301, `/journal/${req.params.slug}`));

  // ── Legal route aliases → /legal/<slug> (SEO 301s) ────────────────────────
  app.get("/privacy", (_req, res) => res.redirect(301, "/legal/privacy-policy"));
  app.get("/cookies", (_req, res) => res.redirect(301, "/legal/cookies"));
  app.get("/shipping-requirements", (_req, res) => res.redirect(301, "/legal/shipping-requirements"));
  app.get("/grading-standards", (_req, res) => res.redirect(301, "/standard"));
  app.get("/cancel", (_req, res) => res.redirect(301, "/legal/cancel"));
  app.get("/adr", (_req, res) => res.redirect(301, "/legal/adr"));
  app.get("/website-terms", (_req, res) => res.redirect(301, "/legal/website-terms"));
  app.get("/submission-agreement", (_req, res) => res.redirect(301, "/legal/submission-agreement"));
  app.get("/guarantee-and-correction-policy", (_req, res) =>
    res.redirect(301, "/legal/guarantee-and-correction-policy")
  );
  // Legacy slug → canonical
  app.get("/legal/guarantee", (_req, res) => res.redirect(301, "/legal/guarantee-and-correction-policy"));
}
