import { describe, expect, it, vi } from "vitest";

const resolveGlobalFlag = vi.fn();
vi.mock("../server/partner/flags", () => ({ resolveGlobalFlag }));

describe("Command Centre canonical Pilot Flag", () => {
  it("uses the existing global Pilot Flag read path and fails closed on a source error", async () => {
    const { COMMAND_CENTRE_PILOT_FLAG, isCommandCentreEnabledRuntime } = await import("../server/command-centre/flag");

    resolveGlobalFlag.mockResolvedValueOnce(true);
    await expect(isCommandCentreEnabledRuntime()).resolves.toBe(true);
    expect(resolveGlobalFlag).toHaveBeenLastCalledWith(COMMAND_CENTRE_PILOT_FLAG);

    resolveGlobalFlag.mockResolvedValueOnce(false);
    await expect(isCommandCentreEnabledRuntime()).resolves.toBe(false);

    resolveGlobalFlag.mockRejectedValueOnce(new Error("Pilot Flag source unavailable"));
    await expect(isCommandCentreEnabledRuntime()).resolves.toBe(false);
  });

  it("registers the one Command Centre control in the established Super Admin Pilot Flags catalog", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("server/partner/flags.ts", "utf8"));
    expect(source).toContain('"super_admin_command_centre_enabled"');
  });
});
