import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTRE_RUNTIME_DB_PREFIX,
  assertDisposableRuntimeDatabaseUrl,
  requireRuntimeCredential,
} from "../scripts/command-centre-runtime-harness";

describe("Command Centre rendered-runtime harness safety", () => {
  it("accepts only a loopback URL with the dedicated disposable database prefix", () => {
    const url = assertDisposableRuntimeDatabaseUrl(
      `postgresql://tester@127.0.0.1:5432/${COMMAND_CENTRE_RUNTIME_DB_PREFIX}safe`,
    );
    expect(url.hostname).toBe("127.0.0.1");
  });

  it.each([
    "postgresql://tester@ep-remote.neon.tech:5432/mintvault_command_centre_runtime_safe",
    "postgresql://tester@127.0.0.1:5432/mintvault_test",
    "https://127.0.0.1/mintvault_command_centre_runtime_safe",
  ])("fails closed for unsafe runtime database %s", (unsafeUrl) => {
    expect(() => assertDisposableRuntimeDatabaseUrl(unsafeUrl)).toThrow();
  });

  it("keeps the loopback session transport exception test-only", () => {
    const server = readFileSync("server/index.ts", "utf8");
    expect(server).toContain('ssl: process.env.NODE_ENV === "test" ? false : { rejectUnauthorized: false }');
  });

  it("uses the existing server kill switch for the optional flag-off audit", () => {
    const harness = readFileSync("scripts/command-centre-runtime-harness.ts", "utf8");
    expect(harness).toContain('const commandCentreEnabled = !process.argv.includes("--feature-off")');
    expect(harness).toContain("CREATE TABLE IF NOT EXISTS partner_feature_flags");
    expect(harness).toContain("COMMAND_CENTRE_PILOT_FLAG, commandCentreEnabled");
    expect(harness).toContain("await verifyCommandCentreRuntime(port, commandCentreEnabled, runtimeAdminPassword, runtimeAdminPin)");
    expect(harness).not.toContain('SUPER_ADMIN_COMMAND_CENTRE_ENABLED: commandCentreEnabled ? "true" : "false"');
  });

  it("fails closed when no disposable-runtime credential fixture is supplied", () => {
    expect(() => requireRuntimeCredential("MINTVAULT_COMMAND_CENTRE_RUNTIME_MISSING_TEST_SECRET")).toThrow();
  });
});
