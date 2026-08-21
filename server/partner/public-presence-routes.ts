import type { Express } from "express";
import rateLimit from "express-rate-limit";
import {
  getPublicPartnerLocation,
  getPublicPartnerDirectoryState,
  isValidPublicPartnerRef,
  listPublicPartnerLocations,
  PublicPartnerPresenceUnavailableError,
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

function unavailable(res: import("express").Response): void {
  res.setHeader("Retry-After", "60");
  res.status(503).json({ error: "Partner discovery is temporarily unavailable." });
}

export function registerPublicPartnerPresenceRoutes(app: Express): void {
  app.get("/api/public/partners", publicPartnerReadLimit, async (req, res) => {
    noStore(res);
    try {
      const search = typeof req.query.search === "string" ? req.query.search : "";
      if (search.length > 80) {
        res.status(400).json({ error: "Search must be 80 characters or fewer." });
        return;
      }
      const locations = await listPublicPartnerLocations({ search, limit: 100 });
      // The list query already applies the global switch. Only an empty result
      // needs one extra lookup to distinguish a live empty/no-match directory
      // from a genuinely disabled route; populated requests retain the fixed
      // three-call projection budget.
      if (locations.length === 0 && (await getPublicPartnerDirectoryState()) !== "ENABLED") {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ locations });
    } catch (err) {
      if (err instanceof PublicPartnerPresenceUnavailableError) {
        unavailable(res);
        return;
      }
      throw err;
    }
  });

  app.get("/api/public/partners/:publicRef", publicPartnerReadLimit, async (req, res) => {
    noStore(res);
    const publicRef = String(req.params.publicRef ?? "");
    // Invalid, unknown, unpublished and inactive all have the same response.
    if (!isValidPublicPartnerRef(publicRef)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const location = await getPublicPartnerLocation(publicRef);
      if (!location) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.json({ location });
    } catch (err) {
      if (err instanceof PublicPartnerPresenceUnavailableError) {
        unavailable(res);
        return;
      }
      throw err;
    }
  });
}
