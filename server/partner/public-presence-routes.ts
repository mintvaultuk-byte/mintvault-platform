import type { Express } from "express";
import rateLimit from "express-rate-limit";
import {
  getPublicPartnerLocation,
  isPublicPartnerDirectoryEnabled,
  isValidPublicPartnerRef,
  listPublicPartnerLocations,
} from "./public-presence-service";

const publicPartnerReadLimit = rateLimit({
  windowMs: 60_000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: { error: "Too many Partner searches. Please try again shortly." },
  keyGenerator: (req) => req.ip ?? req.socket.remoteAddress ?? "unknown",
});

function noStore(res: { setHeader(name: string, value: string): void }): void {
  // Publication revocation must be visible immediately; do not let a CDN keep
  // an ACTIVE response after a Partner/location has been suspended.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function registerPublicPartnerPresenceRoutes(app: Express): void {
  app.get("/api/public/partners", publicPartnerReadLimit, async (req, res) => {
    noStore(res);
    if (!(await isPublicPartnerDirectoryEnabled())) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const search = typeof req.query.search === "string" ? req.query.search : "";
    if (search.length > 80) {
      res.status(400).json({ error: "Search must be 80 characters or fewer." });
      return;
    }
    const locations = await listPublicPartnerLocations({ search, limit: 100 });
    res.json({ locations });
  });

  app.get("/api/public/partners/:publicRef", publicPartnerReadLimit, async (req, res) => {
    noStore(res);
    const publicRef = String(req.params.publicRef ?? "");
    // Invalid, unknown, unpublished and inactive all have the same response.
    if (!isValidPublicPartnerRef(publicRef)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const location = await getPublicPartnerLocation(publicRef);
    if (!location) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ location });
  });
}
