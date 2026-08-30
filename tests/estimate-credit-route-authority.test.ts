import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const routes = readFileSync(join(ROOT, "server/routes.ts"), "utf8");
const sharedRateLimit = readFileSync(join(ROOT, "server/lib/shared-public-rate-limit.ts"), "utf8");
const webhooks = readFileSync(join(ROOT, "server/webhookHandlers.ts"), "utf8");

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`could not isolate source between ${start} and ${end}`);
  return source.slice(from, to);
}

describe("estimate-credit route ownership authority", () => {
  it("requires an authenticated, database-verified account for checkout", () => {
    const checkout = between(
      routes,
      'app.post("/api/tools/estimate/checkout"',
      "// POST /api/tools/estimate  (multipart"
    );
    expect(checkout).toMatch(/if \(!sessionUserId\) return res\.status\(401\)/);
    expect(checkout).toMatch(/email_verified IS TRUE/);
    expect(checkout).toMatch(/buildEstimateCheckoutMetadata\(\{ sessionUserId, email/);
    expect(checkout).not.toMatch(/req\.body\.email/);
    expect(checkout).not.toMatch(/req\.headers\.origin/);
    expect(checkout).not.toMatch(/payment=success&email/);
  });

  it("does not accept public email text as paid-spend, balance, or admin authority", () => {
    const surface = between(
      routes,
      "// GET /api/tools/estimate/credits",
      "// ── Target-bound scanner capture sessions"
    );
    expect(surface).not.toMatch(/req\.query\.email/);
    expect(surface).not.toMatch(/bodyEmail/);
    expect(surface).not.toMatch(/ADMIN_FREE_EMAIL/);
    expect(surface).toMatch(/isAdmin === true[\s\S]+adminEmail/);
    const estimateRoute = between(
      routes,
      'app.post(\n    "/api/tools/estimate"',
      "// ── Target-bound scanner capture sessions"
    );
    expect(estimateRoute).toMatch(/estimateAnonymousIpHash\(req\)/);
    expect(estimateRoute).not.toMatch(/x-forwarded-for/);
    expect(estimateRoute).toMatch(/settleEstimateCreditReservation\(creditReservationId, "refund"\)/);
    expect(estimateRoute).toMatch(/settleEstimateCreditReservation\(creditReservationId, "commit"\)/);

    expect(estimateRoute).toMatch(
      /estimateRateLimit,[\s\S]+publicImageProcessingAdmission\.middleware,[\s\S]+toolsUpload\.single/
    );
    expect(routes).toContain('namespace: "credit_estimate"');
    expect(sharedRateLimit).toContain("req.ip || req.socket.remoteAddress");
    expect(sharedRateLimit).not.toMatch(/x-mv-admin-email|ADMIN_FREE_EMAIL/);
  });

  it("fulfils paid estimate credits only to a bound live user row", () => {
    const fulfilment = between(
      webhooks,
      "export async function fulfilEstimateCreditsPurchase",
      "export class WebhookHandlers"
    );
    expect(fulfilment).toMatch(/if \(!userId \|\|/);
    expect(fulfilment).toMatch(/UPDATE users[\s\S]+deleted_at IS NULL[\s\S]+RETURNING id/);
    expect(fulfilment).not.toMatch(/INSERT INTO estimate_credits/);
    expect(fulfilment).toMatch(/session\.payment_status !== "paid"/);
  });
});
