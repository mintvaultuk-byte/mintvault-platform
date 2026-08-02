/**
 * Project Control — environment identity must fail CLOSED.
 *
 * These tests exist because the two resolvers this module replaced both derived a deployed
 * environment's name from `NODE_ENV`. Every Fly machine sets `NODE_ENV=production`, staging
 * included, so staging labelled its evidence "production" — and a laptop with no `NODE_ENV` at all
 * resolved "local", which is what the seed's production blockade checked against.
 *
 * The assertions below are deliberately about the DANGEROUS directions, not the happy path:
 * a wrong answer here is not a broken screen, it is a confident lie about which estate a fact
 * came from.
 */
import { describe, it, expect } from "vitest";
import {
  evidenceAppliesTo,
  isDeployedEnvironment,
  isEnvironmentKnown,
  mayWriteLabelledEvidence,
  resolveProjectControlEnvironment,
  seedApplyRefusal,
} from "@shared/project-control-environment";

const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

describe("resolveProjectControlEnvironment", () => {
  it("takes PROJECT_CONTROL_ENV as the authority for a deployed environment", () => {
    expect(resolveProjectControlEnvironment(env({ PROJECT_CONTROL_ENV: "staging" }))).toBe("staging");
    expect(resolveProjectControlEnvironment(env({ PROJECT_CONTROL_ENV: "production" }))).toBe("production");
    expect(resolveProjectControlEnvironment(env({ PROJECT_CONTROL_ENV: "local" }))).toBe("local");
  });

  it("normalises case and surrounding whitespace on the explicit value", () => {
    expect(resolveProjectControlEnvironment(env({ PROJECT_CONTROL_ENV: "  Staging \n" }))).toBe("staging");
  });

  /**
   * ENV1 — the staging-labelled-as-production defect, asserted directly.
   *
   * This is the exact configuration of the `mintvault-v2` (staging) Fly app today: NODE_ENV is
   * `production` in fly.v2.toml and the Dockerfile, and PROJECT_CONTROL_ENV is set nowhere. The old
   * resolver answered "production" here.
   */
  it("NEVER names a deployed environment from NODE_ENV — a staging machine is not production", () => {
    expect(resolveProjectControlEnvironment(env({ NODE_ENV: "production" }))).toBe("unknown");
    expect(resolveProjectControlEnvironment(env({ NODE_ENV: "production" }))).not.toBe("production");
    expect(resolveProjectControlEnvironment(env({ NODE_ENV: "production" }))).not.toBe("staging");
  });

  it("treats an unrecognised explicit value as unknown rather than guessing which estate it meant", () => {
    for (const value of ["prod", "stg", "production-eu", "preview", "PRODUCTION_EU"]) {
      expect(resolveProjectControlEnvironment(env({ PROJECT_CONTROL_ENV: value }))).toBe("unknown");
    }
  });

  it("does not let a typo'd explicit value fall back to NODE_ENV", () => {
    expect(
      resolveProjectControlEnvironment(env({ PROJECT_CONTROL_ENV: "prod", NODE_ENV: "production" }))
    ).toBe("unknown");
  });

  it("accepts NODE_ENV only as proof that we are NOT deployed", () => {
    expect(resolveProjectControlEnvironment(env({ NODE_ENV: "test" }))).toBe("local");
    expect(resolveProjectControlEnvironment(env({ NODE_ENV: "development" }))).toBe("local");
  });

  it("answers unknown when there is nothing to go on at all", () => {
    expect(resolveProjectControlEnvironment(env({}))).toBe("unknown");
    expect(resolveProjectControlEnvironment(env({ PROJECT_CONTROL_ENV: "   " }))).toBe("unknown");
  });
});

describe("unknown is a refusal, not a default", () => {
  it("refuses to label evidence", () => {
    expect(mayWriteLabelledEvidence("unknown")).toBe(false);
    expect(mayWriteLabelledEvidence("staging")).toBe(true);
  });

  it("reports unknown as not-known and not-deployed", () => {
    expect(isEnvironmentKnown("unknown")).toBe(false);
    expect(isDeployedEnvironment("unknown")).toBe(false);
    expect(isDeployedEnvironment("local")).toBe(false);
    expect(isDeployedEnvironment("staging")).toBe(true);
  });

  /**
   * The guard must not be a `!== "unknown"` test. Untyped callers — test fixtures, a JSON body, a
   * stale build — can hand over `undefined` or a string we never defined, and every one of those is
   * "not literally the word unknown".
   */
  it("treats undefined, null and off-canon strings as unknown", () => {
    for (const value of [undefined, null, "", "prod", "PRODUCTION", 42 as unknown as string]) {
      expect(isEnvironmentKnown(value as string | undefined)).toBe(false);
    }
  });
});

describe("evidenceAppliesTo", () => {
  /** ENV2 — staging evidence must never answer a question asked about production. */
  it("refuses staging evidence for a production question", () => {
    expect(evidenceAppliesTo("staging", "production")).toBe(false);
    expect(evidenceAppliesTo("production", "staging")).toBe(false);
  });

  it("matches only exactly, and never matches an unknown on either side", () => {
    expect(evidenceAppliesTo("production", "production")).toBe(true);
    expect(evidenceAppliesTo("staging", "staging")).toBe(true);
    expect(evidenceAppliesTo(null, "production")).toBe(false);
    expect(evidenceAppliesTo("", "production")).toBe(false);
    expect(evidenceAppliesTo("unknown", "production")).toBe(false);
    expect(evidenceAppliesTo("production", "unknown")).toBe(false);
  });

  it("is case- and whitespace-insensitive on the stored label only", () => {
    expect(evidenceAppliesTo(" Production ", "production")).toBe(true);
  });
});

describe("seedApplyRefusal", () => {
  it("refuses an unknown environment — the laptop-pointed-at-production case", () => {
    expect(seedApplyRefusal("unknown", false)).toBe("unknown_environment");
    expect(seedApplyRefusal(undefined, false)).toBe("unknown_environment");
    expect(seedApplyRefusal("prod", false)).toBe("unknown_environment");
  });

  it("refuses an unknown environment EVEN WITH the production override", () => {
    // The override authorises writing to production. It does not authorise writing to an estate
    // nobody has identified.
    expect(seedApplyRefusal("unknown", true)).toBe("unknown_environment");
  });

  it("blocks production unless the separate owner authorisation is present", () => {
    expect(seedApplyRefusal("production", false)).toBe("production_blocked");
    expect(seedApplyRefusal("production", true)).toBeNull();
  });

  it("permits staging and local", () => {
    expect(seedApplyRefusal("staging", false)).toBeNull();
    expect(seedApplyRefusal("local", false)).toBeNull();
  });
});
