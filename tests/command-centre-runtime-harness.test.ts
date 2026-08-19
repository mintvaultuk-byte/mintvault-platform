import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTRE_RUNTIME_DB_PREFIX,
  assertDisposableRuntimeDatabaseUrl,
  requireRuntimeCredential,
} from "../scripts/command-centre-runtime-harness";

describe("Command Centre rendered-runtime harness safety", () => {
  it("accepts only a loopback URL with the dedicated disposable database prefix", () => {
    const url = assertDisposableRuntimeDatabaseUrl(
      `postgresql://tester@127.0.0.1:5432/${COMMAND_CENTRE_RUNTIME_DB_PREFIX}safe`
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
    expect(harness).toContain(
      "await verifyCommandCentreRuntime(port, commandCentreEnabled, runtimeAdminPassword, runtimeAdminPin)"
    );
    expect(harness).not.toContain('SUPER_ADMIN_COMMAND_CENTRE_ENABLED: commandCentreEnabled ? "true" : "false"');
  });

  it("fails closed when no disposable-runtime credential fixture is supplied", () => {
    expect(() => requireRuntimeCredential("MINTVAULT_COMMAND_CENTRE_RUNTIME_MISSING_TEST_SECRET")).toThrow();
  });

  it.each([
    { argument: [] as string[], signal: "SIGINT" as const },
    { argument: ["--feature-off"], signal: "SIGTERM" as const },
  ])(
    "awaits $signal cleanup with feature arguments $argument",
    async ({ argument, signal }) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/command-centre-runtime-harness.ts", ...argument],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MINTVAULT_COMMAND_CENTRE_RUNTIME_AUDIT: "1",
            MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PASSWORD: "synthetic-runtime-password-1",
            MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PIN: "synthetic-runtime-pin-1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        output += String(chunk);
      });
      const deadline = Date.now() + 60_000;
      while (!output.includes("COMMAND_CENTRE_RUNTIME_READY=") && child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(output, "harness never reached READY").toContain("COMMAND_CENTRE_RUNTIME_READY=");
      child.kill(signal);
      const exited = await Promise.race([
        once(child, "exit").then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
      ]);
      if (!exited) child.kill("SIGKILL");
      expect(exited, "harness did not finish awaited cleanup").toBe(true);
      expect(child.exitCode).toBe(0);

      const role = process.env.USER;
      expect(role).toMatch(/^[a-z_][a-z0-9_]*$/i);
      const admin = new Client({ connectionString: `postgresql://${role}@127.0.0.1:5432/postgres` });
      await admin.connect();
      try {
        const residue = await admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
          [`${COMMAND_CENTRE_RUNTIME_DB_PREFIX}%`]
        );
        expect(residue.rows).toEqual([]);
      } finally {
        await admin.end();
      }
    },
    120_000
  );

  it("cleans the database and exits nonzero when the READY child dies unexpectedly", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/command-centre-runtime-harness.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MINTVAULT_COMMAND_CENTRE_RUNTIME_AUDIT: "1",
        MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PASSWORD: "synthetic-runtime-password-1",
        MINTVAULT_COMMAND_CENTRE_RUNTIME_ADMIN_PIN: "synthetic-runtime-pin-1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    const deadline = Date.now() + 60_000;
    while (!output.includes("COMMAND_CENTRE_RUNTIME_CHILD_PID=") && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const childPid = Number(output.match(/COMMAND_CENTRE_RUNTIME_CHILD_PID=(\d+)/)?.[1]);
    expect(childPid, output).toBeGreaterThan(0);
    process.kill(childPid, "SIGKILL");

    const exited = await Promise.race([
      once(child, "exit").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);
    if (!exited) child.kill("SIGKILL");
    expect(exited, output).toBe(true);
    expect(child.exitCode, output).toBe(1);
    expect(output).toContain("child exited unexpectedly");

    const role = process.env.USER;
    expect(role).toMatch(/^[a-z_][a-z0-9_]*$/i);
    const admin = new Client({ connectionString: `postgresql://${role}@127.0.0.1:5432/postgres` });
    await admin.connect();
    try {
      const residue = await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
        [`${COMMAND_CENTRE_RUNTIME_DB_PREFIX}%`]
      );
      expect(residue.rows).toEqual([]);
    } finally {
      await admin.end();
    }
  }, 120_000);
});
