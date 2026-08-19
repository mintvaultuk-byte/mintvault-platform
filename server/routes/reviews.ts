import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { getReviewConfiguration, recordReviewClick, suppressReviewRequest } from "../review-request-service";

const reviewLinkLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: "Too many review-link requests. Please try again later.",
});

const html = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Review preference | MintVault UK</title></head>
<body style="margin:0;background:#090909;color:#eee;font:16px/1.5 Arial,sans-serif">
<main style="max-width:560px;margin:64px auto;padding:28px;border:1px solid #D4AF37;border-radius:8px;background:#111">
<h1 style="color:#D4AF37;font-size:22px">MintVault review preference</h1>${body}</main></body></html>`;

export function registerReviewRequestRoutes(app: Express): void {
  app.get("/reviews/r/:token", reviewLinkLimit, async (req, res) => {
    const config = getReviewConfiguration();
    if (config.state !== "READY") return res.status(503).send("Review destination is not configured.");
    if (!(await recordReviewClick(String(req.params.token)))) return res.status(404).send("Review link not found.");
    res.setHeader("Cache-Control", "private, no-store");
    return res.redirect(302, config.destination.toString());
  });

  app.get("/reviews/preferences/:token", reviewLinkLimit, (req, res) => {
    const token = String(req.params.token);
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return res.status(404).send("Preference link not found.");
    res.setHeader("Cache-Control", "private, no-store");
    return res.status(200).send(
      html(`<p>Confirm that MintVault should suppress this review request.</p>
<form method="post" action="/reviews/preferences/${token}"><button type="submit" style="padding:10px 18px;background:#D4AF37;border:0;border-radius:4px;font-weight:bold">Suppress request</button></form>`)
    );
  });

  app.post("/reviews/preferences/:token", reviewLinkLimit, async (req, res) => {
    const suppressed = await suppressReviewRequest(String(req.params.token));
    res.setHeader("Cache-Control", "private, no-store");
    if (!suppressed) return res.status(404).send("Preference link not found.");
    return res
      .status(200)
      .send(html("<p>This review request has been suppressed. No order or support access is affected.</p>"));
  });
}
