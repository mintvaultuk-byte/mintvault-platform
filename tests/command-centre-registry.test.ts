import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COMMAND_CENTRE_DEPARTMENTS,
  COMMAND_CENTRE_REGISTRY,
} from "../shared/command-centre";
import {
  serialiseCommandCentreRegistryForBrowser,
  validateCommandCentreRegistry,
} from "../server/command-centre/registry";

const cloneRegistry = (): Record<string, unknown>[] =>
  JSON.parse(JSON.stringify(COMMAND_CENTRE_REGISTRY)) as Record<string, unknown>[];

describe("Command Centre V1 static registry", () => {
  it("contains exactly the locked 13 active entries across four departments", () => {
    const validated = validateCommandCentreRegistry(COMMAND_CENTRE_REGISTRY);

    expect(COMMAND_CENTRE_DEPARTMENTS).toHaveLength(4);
    expect(validated).toHaveLength(13);
    expect(validated.filter((descriptor) => descriptor.status === "ACTIVE")).toHaveLength(13);
    expect(validated.filter((descriptor) => descriptor.kind === "CAPABILITY")).toHaveLength(12);
    expect(validated.filter((descriptor) => descriptor.kind === "POLICY")).toHaveLength(1);
    expect(
      validated.find((descriptor) => descriptor.kind === "POLICY")?.automation,
    ).toBe("SYSTEM_DETERMINISTIC");
    expect(
      validated.filter((descriptor) => descriptor.kind === "CAPABILITY").every(
        (descriptor) => descriptor.automation === "HUMAN",
      ),
    ).toBe(true);
  });

  it("rejects duplicate IDs, malformed records and unknown references", () => {
    const duplicate = cloneRegistry();
    duplicate[1] = { ...duplicate[0] };
    expect(() => validateCommandCentreRegistry(duplicate)).toThrow("duplicate");

    const malformed = cloneRegistry();
    malformed[0].displayName = "";
    expect(() => validateCommandCentreRegistry(malformed)).toThrow();

    const unknownKpi = cloneRegistry();
    unknownKpi[0].kpiIds = ["not-a-locked-kpi"];
    expect(() => validateCommandCentreRegistry(unknownKpi)).toThrow("unknown KPI");

    const unknownSource = cloneRegistry();
    unknownSource[0].canonicalSourceRefs = ["not-a-locked-source"];
    expect(() => validateCommandCentreRegistry(unknownSource)).toThrow("unknown source");
  });

  it("rejects metadata that attempts to carry authority or executable fields", () => {
    const publicVisibility = cloneRegistry();
    publicVisibility[0].visibility = "PUBLIC";
    expect(() => validateCommandCentreRegistry(publicVisibility)).toThrow();

    const executableField = cloneRegistry();
    executableField[0].tool = "external-action";
    expect(() => validateCommandCentreRegistry(executableField)).toThrow();

    const permissionField = cloneRegistry();
    permissionField[0].permission = "requireAdmin";
    expect(() => validateCommandCentreRegistry(permissionField)).toThrow();
  });

  it("serialises only the reviewed static browser fields", () => {
    const browserRegistry = serialiseCommandCentreRegistryForBrowser();
    const expectedKeys = [
      "automation",
      "canonicalSourceRefs",
      "departmentId",
      "displayName",
      "id",
      "kind",
      "kpiIds",
      "outcome",
      "safeInternalLinks",
      "status",
      "version",
      "visibility",
    ];

    expect(browserRegistry).toHaveLength(13);
    for (const descriptor of browserRegistry) {
      expect(Object.keys(descriptor).sort()).toEqual(expectedKeys);
      expect(JSON.stringify(descriptor)).not.toMatch(
        /email|phone|token|secret|payment_intent|worktree|graphify|github/i,
      );
    }
  });

  it("is imported during server startup so malformed static metadata fails early", () => {
    const serverIndex = readFileSync(
      resolve(process.cwd(), "server/index.ts"),
      "utf8",
    );

    expect(serverIndex).toContain('import "./command-centre/registry";');
  });
});
