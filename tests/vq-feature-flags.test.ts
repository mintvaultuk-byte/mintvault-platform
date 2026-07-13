/**
 * Phase 7E — pure VQ emergency feature-flag precedence (env HARD-OFF > DB > default-on).
 * The DB-flag reader, route-guard mounting, and admin toggle UI are Category B/C/D;
 * this locks the evaluator + the 503 response shape.
 */
import { describe, it, expect } from "vitest";
import { vqFeatureState, vqDisabledResponse } from "../server/vault-quest/lib/vq-feature-state";

describe("vqFeatureState — precedence env hard-off > db > default-on", () => {
  it("1. nothing set → default-on (safe default)", () => {
    expect(vqFeatureState("generation", {}, {})).toMatchObject({ enabled: true, reason: "default_on" });
  });
  it("2. db off → disabled", () => {
    expect(vqFeatureState("generation", {}, { generation: false })).toMatchObject({ enabled: false, source: "db", reason: "db_flag_off" });
  });
  it("3. env hard-off → disabled", () => {
    expect(vqFeatureState("generation", { VQ_GENERATION_DISABLED: "true" }, {})).toMatchObject({ enabled: false, source: "env", reason: "env_hard_off" });
  });
  it("4. env HARD-OFF beats db-on (the key case)", () => {
    expect(vqFeatureState("generation", { VQ_GENERATION_DISABLED: "true" }, { generation: true })).toMatchObject({ enabled: false, reason: "env_hard_off" });
  });
  it("5. env unset falls through to db-on → enabled", () => {
    expect(vqFeatureState("generation", {}, { generation: true })).toMatchObject({ enabled: true, source: "db", reason: "db_flag_on" });
  });
  it("6. a falsey env var is NOT a hard-off; db governs", () => {
    expect(vqFeatureState("generation", { VQ_GENERATION_DISABLED: "false" }, { generation: false })).toMatchObject({ enabled: false, reason: "db_flag_off" });
  });
  it("7. readonly implies generation off, beats db-on", () => {
    expect(vqFeatureState("generation", { VQ_READONLY: "true" }, { generation: true })).toMatchObject({ enabled: false, reason: "env_readonly" });
  });
  it("8. provider-outage kills generation", () => {
    expect(vqFeatureState("generation", { VQ_PROVIDER_OUTAGE: "1" }, {})).toMatchObject({ enabled: false, reason: "env_provider_outage" });
  });
  it("9. readonly beats db-on for writes", () => {
    expect(vqFeatureState("writes", { VQ_READONLY: "true" }, { writes: true })).toMatchObject({ enabled: false, reason: "env_readonly" });
  });
  it("10. writes on by default", () => {
    expect(vqFeatureState("writes", {}, {})).toMatchObject({ enabled: true, reason: "default_on" });
  });
  it("11. writes maintenance via db", () => {
    expect(vqFeatureState("writes", {}, { writes: false })).toMatchObject({ enabled: false, reason: "db_flag_off" });
  });
  it("12. env beats db-on for exports", () => {
    expect(vqFeatureState("exports", { VQ_EXPORTS_DISABLED: "true" }, { exports: true })).toMatchObject({ enabled: false, reason: "env_hard_off" });
  });
  it("13. export runtime off via db", () => {
    expect(vqFeatureState("exports", {}, { exports: false })).toMatchObject({ enabled: false, reason: "db_flag_off" });
  });
  it("14. readonly does NOT disable read-only exports", () => {
    expect(vqFeatureState("exports", { VQ_READONLY: "true" }, {})).toMatchObject({ enabled: true, reason: "default_on" });
  });
  it("15. generation kill does not touch writes", () => {
    expect(vqFeatureState("writes", { VQ_GENERATION_DISABLED: "true" }, {})).toMatchObject({ enabled: true, reason: "default_on" });
  });
  it("16. truthy parse is case/format-insensitive", () => {
    expect(vqFeatureState("generation", { VQ_GENERATION_DISABLED: "YES" }, {})).toMatchObject({ enabled: false, reason: "env_hard_off" });
  });
});

describe("vqDisabledResponse — 503 maintenance, not 403", () => {
  it("returns 503 + Retry-After + reason", () => {
    const st = vqFeatureState("generation", { VQ_GENERATION_DISABLED: "true" }, {});
    const r = vqDisabledResponse("generation", st);
    expect(r.status).toBe(503);
    expect(r.retryAfterSeconds).toBe(120);
    expect(r.body).toMatchObject({ disabled: true, feature: "generation", reason: "env_hard_off" });
  });
});
