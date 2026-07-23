import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../server/db", () => ({
  db: { execute: runtime.execute },
}));

const originalFlag = process.env.SUPER_ADMIN_PROJECT_CONTROL_ENABLED;

async function enabledFor(environmentValue: string | undefined, result: unknown): Promise<boolean> {
  if (environmentValue === undefined) delete process.env.SUPER_ADMIN_PROJECT_CONTROL_ENABLED;
  else process.env.SUPER_ADMIN_PROJECT_CONTROL_ENABLED = environmentValue;
  runtime.execute.mockReset();
  runtime.execute.mockImplementation(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  vi.resetModules();
  const { isProjectControlEnabled } = await import("../server/project-control/service");
  return isProjectControlEnabled();
}

afterEach(() => {
  if (originalFlag === undefined) delete process.env.SUPER_ADMIN_PROJECT_CONTROL_ENABLED;
  else process.env.SUPER_ADMIN_PROJECT_CONTROL_ENABLED = originalFlag;
});

describe("Project Control fail-closed feature gate", () => {
  it("rejects missing, false, and malformed environment values before a runtime override can be read", async () => {
    expect(await enabledFor(undefined, { rows: [{ enabled: true }] })).toBe(false);
    expect(await enabledFor("false", { rows: [{ enabled: true }] })).toBe(false);
    expect(await enabledFor("TRUE", { rows: [{ enabled: true }] })).toBe(false);
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("requires an available database override and allows only explicit true", async () => {
    expect(await enabledFor("true", { rows: [] })).toBe(true);
    expect(await enabledFor("true", { rows: [{ enabled: false }] })).toBe(false);
    expect(await enabledFor("true", { rows: [{ enabled: true }] })).toBe(true);
    expect(await enabledFor("true", new Error("database unavailable"))).toBe(false);
  });
});
