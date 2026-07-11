/**
 * Phase 7C — pure Higgsfield status classification (P6-R3-01). No network/secrets.
 * The live wiring (typed throws in higgsfield.ts, artworkErrorResponse switch on
 * .kind, the admin status surface) is Category A/B and deferred to a staging-
 * verifiable change; this locks the classification the wiring will use.
 */
import { describe, it, expect } from "vitest";
import {
  classifyHiggsfieldStatus,
  deriveHiggsfieldStatus,
  httpForHiggsfieldStatus,
  HiggsfieldError,
} from "../server/vault-quest/ai/provider-status";

describe("classifyHiggsfieldStatus", () => {
  it("maps auth / credits / rate / provider / unknown", () => {
    expect(classifyHiggsfieldStatus(401)).toBe("auth_expired");
    expect(classifyHiggsfieldStatus(403)).toBe("auth_expired");
    expect(classifyHiggsfieldStatus(402)).toBe("insufficient_credits");
    expect(classifyHiggsfieldStatus(429)).toBe("rate_limited");
    expect(classifyHiggsfieldStatus(500)).toBe("provider_unavailable");
    expect(classifyHiggsfieldStatus(503)).toBe("provider_unavailable");
    expect(classifyHiggsfieldStatus(418)).toBe("unknown");
    expect(classifyHiggsfieldStatus(null)).toBe("unknown");
  });
});

describe("deriveHiggsfieldStatus — never claims connected from config alone", () => {
  it("no key → not_configured", () => {
    expect(deriveHiggsfieldStatus({ connected: false })).toBe("not_configured");
  });
  it("key present but no call yet → configured_but_unverified (NOT connected — the bug fix)", () => {
    expect(deriveHiggsfieldStatus({ connected: true })).toBe("configured_but_unverified");
    expect(deriveHiggsfieldStatus({ connected: true }, null)).toBe("configured_but_unverified");
  });
  it("last call ok → connected", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: true })).toBe("connected");
  });
  it("expired token (last 401) → authentication_invalid_or_expired", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "auth_expired" })).toBe("authentication_invalid_or_expired");
  });
  it("provider 5xx/rate → provider_unavailable", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "provider_unavailable" })).toBe("provider_unavailable");
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "rate_limited" })).toBe("provider_unavailable");
  });
  it("out of credits still means the credential works → connected", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "insufficient_credits" })).toBe("connected");
  });
});

describe("httpForHiggsfieldStatus", () => {
  it("200 for healthy/unverified, 503 for not-configured/auth/unavailable", () => {
    expect(httpForHiggsfieldStatus("connected")).toBe(200);
    expect(httpForHiggsfieldStatus("configured_but_unverified")).toBe(200);
    expect(httpForHiggsfieldStatus("not_configured")).toBe(503);
    expect(httpForHiggsfieldStatus("authentication_invalid_or_expired")).toBe(503);
    expect(httpForHiggsfieldStatus("provider_unavailable")).toBe(503);
  });
});

describe("HiggsfieldError", () => {
  it("carries the typed kind and status", () => {
    const e = new HiggsfieldError("auth_expired", "token expired", 401);
    expect(e.kind).toBe("auth_expired");
    expect(e.httpStatus).toBe(401);
    expect(e).toBeInstanceOf(Error);
  });
});
