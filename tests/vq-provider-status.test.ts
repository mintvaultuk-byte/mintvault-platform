/**
 * Phase 7C + 10A D6 — pure Higgsfield status classification (7-state canonical model).
 * No network/secrets. The live wiring (typed throws, admin status surface) is Category C.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyHiggsfieldStatus,
  deriveHiggsfieldStatus,
  httpForHiggsfieldStatus,
  HiggsfieldError,
  recordHiggsfieldOutcome,
  getLastHiggsfieldOutcome,
  __resetHiggsfieldOutcomeForTests,
} from "../server/vault-quest/ai/provider-status";

describe("classifyHiggsfieldStatus", () => {
  it("maps auth / credits / rate / provider / unknown", () => {
    expect(classifyHiggsfieldStatus(401)).toBe("auth_expired");
    expect(classifyHiggsfieldStatus(403)).toBe("auth_expired");
    expect(classifyHiggsfieldStatus(402)).toBe("insufficient_credits");
    expect(classifyHiggsfieldStatus(429)).toBe("rate_limited");
    expect(classifyHiggsfieldStatus(500)).toBe("provider_unavailable");
    expect(classifyHiggsfieldStatus(418)).toBe("unknown");
    expect(classifyHiggsfieldStatus(null)).toBe("unknown");
  });
});

describe("deriveHiggsfieldStatus — 7-state model, never connected from config alone", () => {
  it("owner-disabled wins (highest precedence)", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: true }, { disabledByOwner: true })).toBe("disabled_by_owner");
  });
  it("no key → not_configured", () => {
    expect(deriveHiggsfieldStatus({ connected: false })).toBe("not_configured");
  });
  it("key present but no call yet → configured_unverified (NOT connected — the bug fix)", () => {
    expect(deriveHiggsfieldStatus({ connected: true })).toBe("configured_unverified");
  });
  it("last call ok → connected", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: true })).toBe("connected");
  });
  it("401 → authentication_invalid", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "auth_expired" })).toBe("authentication_invalid");
  });
  it("429 → rate_limited", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "rate_limited" })).toBe("rate_limited");
  });
  it("5xx → provider_unavailable", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "provider_unavailable" })).toBe("provider_unavailable");
  });
  it("out of credits still means the credential works → connected", () => {
    expect(deriveHiggsfieldStatus({ connected: true }, { ok: false, kind: "insufficient_credits" })).toBe("connected");
  });
});

describe("httpForHiggsfieldStatus — 7 states exhaustive", () => {
  it("maps each of the 7 states", () => {
    expect(httpForHiggsfieldStatus("connected")).toBe(200);
    expect(httpForHiggsfieldStatus("configured_unverified")).toBe(200);
    expect(httpForHiggsfieldStatus("rate_limited")).toBe(429);
    expect(httpForHiggsfieldStatus("not_configured")).toBe(503);
    expect(httpForHiggsfieldStatus("authentication_invalid")).toBe(503);
    expect(httpForHiggsfieldStatus("provider_unavailable")).toBe(503);
    expect(httpForHiggsfieldStatus("disabled_by_owner")).toBe(503);
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

describe("recordHiggsfieldOutcome / getLastHiggsfieldOutcome — Phase 10A-3 observation point", () => {
  beforeEach(() => __resetHiggsfieldOutcomeForTests());

  it("starts null (no call observed yet this process) → configured_unverified, never connected", () => {
    expect(getLastHiggsfieldOutcome()).toBeNull();
    expect(deriveHiggsfieldStatus({ connected: true }, getLastHiggsfieldOutcome())).toBe("configured_unverified");
  });

  it("a recorded success flips the derived status to connected", () => {
    recordHiggsfieldOutcome({ ok: true });
    expect(deriveHiggsfieldStatus({ connected: true }, getLastHiggsfieldOutcome())).toBe("connected");
  });

  it("a recorded auth failure flips the derived status to authentication_invalid — the bug this phase fixes: an expired token no longer shows green", () => {
    recordHiggsfieldOutcome({ ok: false, kind: "auth_expired" });
    expect(deriveHiggsfieldStatus({ connected: true }, getLastHiggsfieldOutcome())).toBe("authentication_invalid");
  });

  it("the latest call wins — a later success clears a prior failure, and vice versa", () => {
    recordHiggsfieldOutcome({ ok: false, kind: "provider_unavailable" });
    recordHiggsfieldOutcome({ ok: true });
    expect(getLastHiggsfieldOutcome()).toEqual({ ok: true });
  });
});
