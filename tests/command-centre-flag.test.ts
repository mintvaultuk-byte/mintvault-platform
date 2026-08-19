import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveGlobalFlag = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: {
    getUserByEmail: vi.fn(async () => ({
      id: "command-centre-super-admin",
      email: "mintvaultuk@gmail.com",
      credentialVersion: 1,
      deletedAt: null,
    })),
  },
}));

vi.mock("../server/account-auth", () => ({
  verifyPassword: vi.fn(async () => true),
}));
vi.mock("../server/partner/flags", () => ({
  resolveGlobalFlag,
}));

import { COMMAND_CENTRE_FLAG_ENV, isCommandCentreEnabled } from "../server/command-centre/flag";
import { isCommandCentreBuildCompatible, requireCommandCentreEnabled } from "../server/command-centre/auth";
import { requireSuperAdmin } from "../server/auth";

describe("Command Centre availability flag", () => {
  const originalValue = process.env[COMMAND_CENTRE_FLAG_ENV];
  const originalSuperAdminEmails = process.env.SUPER_ADMIN_EMAILS;

  afterEach(() => {
    resolveGlobalFlag.mockReset();
    if (originalValue === undefined) {
      delete process.env[COMMAND_CENTRE_FLAG_ENV];
    } else {
      process.env[COMMAND_CENTRE_FLAG_ENV] = originalValue;
    }

    if (originalSuperAdminEmails === undefined) {
      delete process.env.SUPER_ADMIN_EMAILS;
    } else {
      process.env.SUPER_ADMIN_EMAILS = originalSuperAdminEmails;
    }
  });

  it.each(["true", "TRUE", "1", "yes", "on", "enabled"])("enables only explicit affirmative value %s", (value) => {
    expect(isCommandCentreEnabled({ [COMMAND_CENTRE_FLAG_ENV]: value })).toBe(true);
  });

  it.each([undefined, "", "false", "0", "no", "disabled", "anything"])(
    "keeps the Command Centre disabled for %s",
    (value) => {
      expect(isCommandCentreEnabled({ [COMMAND_CENTRE_FLAG_ENV]: value })).toBe(false);
    }
  );

  it("fails a production artifact closed unless canonical Partner destinations were compiled", () => {
    expect(
      isCommandCentreBuildCompatible({ NODE_ENV: "production", VITE_PARTNER_NETWORK_CONSOLIDATION: "false" })
    ).toBe(false);
    expect(isCommandCentreBuildCompatible({ NODE_ENV: "production", VITE_PARTNER_NETWORK_CONSOLIDATION: "true" })).toBe(
      true
    );
    expect(isCommandCentreBuildCompatible({ NODE_ENV: "test" })).toBe(true);
  });

  it.each([true, false])("bakes canonical Partner compatibility into the server artifact (%s)", async (enabled) => {
    const source = readFileSync(resolve(process.cwd(), "server/command-centre/build-compatibility.ts"), "utf8");
    const built = await transform(source, {
      loader: "ts",
      format: "cjs",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.VITE_PARTNER_NETWORK_CONSOLIDATION": JSON.stringify(String(enabled)),
      },
    });
    const artifact = { exports: {} as Record<string, unknown> };
    new Function("module", "exports", built.code)(artifact, artifact.exports);
    const compatible = artifact.exports.isCommandCentreBuildCompatible as (environment?: NodeJS.ProcessEnv) => boolean;
    expect(compatible()).toBe(enabled);
  });

  it("pins canonical Partner destinations in both the exact staging rollout and restore commands", () => {
    const taskDir = resolve(
      process.cwd(),
      ".claude/controlled-code-lead/tasks/command-centre-v1-overnight-assurance-20260819"
    );
    for (const file of ["rollout.md", "rollback.md"]) {
      const source = readFileSync(resolve(taskDir, file), "utf8");
      expect(source, `${file} must compile canonical Command Centre Partner destinations`).toContain(
        "safe-deploy.sh staging --yes --partner-network-consolidation true"
      );
    }
  });

  it("returns a generic 404 without reaching a disabled route handler", async () => {
    resolveGlobalFlag.mockResolvedValue(false);

    const application: Express = express();
    let handlerCalls = 0;
    application.get("/command-test", requireCommandCentreEnabled, (_request, response) => {
      handlerCalls += 1;
      response.status(200).json({ reached: true });
    });

    const server = await start(application);

    try {
      const baseUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
      const response = await fetch(baseUrl + "/command-test");

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Not found" });
      expect(handlerCalls).toBe(0);
    } finally {
      await stop(server);
    }
  });

  it("composes the flag guard before the existing Super Admin boundary", async () => {
    resolveGlobalFlag.mockResolvedValue(false);
    process.env.SUPER_ADMIN_EMAILS = "mintvaultuk@gmail.com";

    const disabled = await runBoundary({
      session: {
        isAdmin: true,
        adminEmail: "mintvaultuk@gmail.com",
        credentialVersion: 1,
        authenticatedAt: Date.now(),
      },
    });
    expect(disabled).toEqual({ statusCode: 404, reached: false });

    resolveGlobalFlag.mockResolvedValue(true);

    const cases: Array<{
      name: string;
      request: Record<string, unknown>;
      statusCode: number | null;
      reached: boolean;
    }> = [
      {
        name: "anonymous",
        request: {},
        statusCode: 401,
        reached: false,
      },
      {
        name: "customer",
        request: { session: { isCustomer: true } },
        statusCode: 401,
        reached: false,
      },
      {
        name: "Partner",
        request: { session: { partnerUserId: "partner-session" } },
        statusCode: 401,
        reached: false,
      },
      {
        name: "staff",
        request: { session: { isStaff: true } },
        statusCode: 401,
        reached: false,
      },
      {
        name: "grader",
        request: { session: { isGrader: true } },
        statusCode: 403,
        reached: false,
      },
      {
        name: "ordinary admin",
        request: {
          session: {
            isAdmin: true,
            adminEmail: "ordinary-admin@example.com",
            credentialVersion: 1,
            authenticatedAt: Date.now(),
          },
        },
        statusCode: 403,
        reached: false,
      },
      {
        name: "Super Admin",
        request: {
          session: {
            isAdmin: true,
            adminEmail: "mintvaultuk@gmail.com",
            credentialVersion: 1,
            authenticatedAt: Date.now(),
          },
        },
        statusCode: null,
        reached: true,
      },
    ];

    for (const testCase of cases) {
      await expect(runBoundary(testCase.request)).resolves.toEqual({
        statusCode: testCase.statusCode,
        reached: testCase.reached,
      });
    }
  });
});

function start(application: Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = application.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function runBoundary(request: Record<string, unknown>): Promise<{
  statusCode: number | null;
  reached: boolean;
}> {
  const response = {
    statusCode: null as number | null,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json() {
      return response;
    },
  };
  let passedFlag = false;
  let reached = false;

  await requireCommandCentreEnabled(request as never, response as never, () => {
    passedFlag = true;
  });

  if (!passedFlag) {
    return { statusCode: response.statusCode, reached };
  }

  await requireSuperAdmin(request as never, response as never, () => {
    reached = true;
  });

  return { statusCode: response.statusCode, reached };
}
