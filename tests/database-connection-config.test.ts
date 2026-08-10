import { describe, expect, it } from "vitest";
import { databaseSslConfig } from "../server/config";

describe("database TLS configuration", () => {
  it.each([
    "postgres://proof:proof@127.0.0.1:55434/mintvault_proof",
    "postgres://proof:proof@localhost:55434/mintvault_proof",
    "postgres://proof:proof@[::1]:55434/mintvault_proof",
  ])("does not require TLS for an exact loopback target: %s", (url) => {
    expect(databaseSslConfig(url)).toBe(false);
  });

  it("retains certificate-tolerant TLS for a remote target and malformed URL", () => {
    expect(databaseSslConfig("postgres://proof:proof@db.example.test/mintvault")).toEqual({
      rejectUnauthorized: false,
    });
    expect(databaseSslConfig("not a database URL")).toEqual({ rejectUnauthorized: false });
  });
});
