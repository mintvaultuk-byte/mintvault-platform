import { describe, expect, it } from "vitest";
import { credentialVersionOf, redactSensitive } from "../server/lib/auth-security";

describe("auth security helpers", () => {
  it("redacts credential-shaped fields recursively", () => {
    expect(
      redactSensitive({
        ok: true,
        password: "never-log",
        nested: {
          pinHash: "hash",
          access_token: "token",
          safe: "visible",
        },
      })
    ).toEqual({
      ok: true,
      password: "[REDACTED]",
      nested: {
        pinHash: "[REDACTED]",
        access_token: "[REDACTED]",
        safe: "visible",
      },
    });
  });

  it("normalises credential_version fields from DB and drizzle rows", () => {
    expect(credentialVersionOf({ credentialVersion: 4 })).toBe(4);
    expect(credentialVersionOf({ credential_version: 5 })).toBe(5);
    expect(credentialVersionOf({ credential_version: 0 })).toBe(1);
    expect(credentialVersionOf({})).toBe(1);
  });
});
