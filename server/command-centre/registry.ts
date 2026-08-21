import { z } from "zod";
import {
  COMMAND_CENTRE_CONTRACT_VERSION,
  COMMAND_CENTRE_DEPARTMENTS,
  COMMAND_CENTRE_KPI_IDS,
  COMMAND_CENTRE_REGISTRY,
  COMMAND_CENTRE_SOURCE_IDS,
  type CommandCentreDescriptor,
} from "../../shared/command-centre";

const departmentIds = new Set<string>(
  COMMAND_CENTRE_DEPARTMENTS.map((department) => department.id),
);
const kpiIds = new Set<string>(COMMAND_CENTRE_KPI_IDS);
const sourceIds = new Set<string>(COMMAND_CENTRE_SOURCE_IDS);
const allowedAdminTabs = new Set([
  "submissions",
  "scans",
  "certs",
  "print-queue",
  "transfers",
]);

const descriptorCommonSchema = z
  .object({
    id: z.string().regex(/^[a-z]+(?:[.-][a-z0-9]+)+$/).max(120),
    version: z.literal(COMMAND_CENTRE_CONTRACT_VERSION),
    displayName: z.string().min(1).max(120),
    departmentId: z.string().min(1).max(80),
    outcome: z.string().min(1).max(300),
    visibility: z.literal("SUPER_ADMIN_ONLY"),
    canonicalSourceRefs: z.array(z.string().min(1).max(120)).min(1).max(12),
    kpiIds: z.array(z.string().min(1).max(120)).max(12),
    safeInternalLinks: z.array(z.string().min(1).max(240)).min(1).max(2),
    status: z.enum(["ACTIVE", "DEFERRED"]),
  })
  .strict();

const capabilitySchema = descriptorCommonSchema
  .extend({
    kind: z.literal("CAPABILITY"),
    automation: z.literal("HUMAN"),
  })
  .strict();

const policySchema = descriptorCommonSchema
  .extend({
    kind: z.literal("POLICY"),
    automation: z.literal("SYSTEM_DETERMINISTIC"),
  })
  .strict();

const registrySchema = z
  .array(z.discriminatedUnion("kind", [capabilitySchema, policySchema]))
  .min(1)
  .max(13);

export type ValidatedCommandCentreRegistry = readonly CommandCentreDescriptor[];

export function validateCommandCentreRegistry(
  candidate: unknown,
): ValidatedCommandCentreRegistry {
  const parsed = registrySchema.parse(candidate);
  const identifiers = new Set<string>();
  let activeEntries = 0;
  let policyEntries = 0;

  for (const descriptor of parsed) {
    if (identifiers.has(descriptor.id)) {
      throw new Error("Command Centre registry contains a duplicate identifier");
    }
    identifiers.add(descriptor.id);

    if (!departmentIds.has(descriptor.departmentId)) {
      throw new Error("Command Centre registry references an unknown department");
    }

    if (descriptor.status === "ACTIVE") {
      activeEntries += 1;
    }

    if (descriptor.kind === "POLICY") {
      policyEntries += 1;
    }

    for (const sourceId of descriptor.canonicalSourceRefs) {
      if (!sourceIds.has(sourceId)) {
        throw new Error("Command Centre registry references an unknown source");
      }
    }

    for (const kpiId of descriptor.kpiIds) {
      if (!kpiIds.has(kpiId)) {
        throw new Error("Command Centre registry references an unknown KPI");
      }
    }

    for (const link of descriptor.safeInternalLinks) {
      if (!isSafeInternalLinkTemplate(link)) {
        throw new Error("Command Centre registry contains an unsafe internal link");
      }
    }
  }

  if (activeEntries !== 13) {
    throw new Error("Command Centre V1 must contain exactly 13 active entries");
  }

  if (policyEntries !== 1) {
    throw new Error("Command Centre V1 must contain exactly one deterministic policy");
  }

  return Object.freeze(
    parsed.map((descriptor) =>
      Object.freeze({
        ...descriptor,
        canonicalSourceRefs: Object.freeze([...descriptor.canonicalSourceRefs]),
        kpiIds: Object.freeze([...descriptor.kpiIds]),
        safeInternalLinks: Object.freeze([...descriptor.safeInternalLinks]),
      }),
    ),
  ) as ValidatedCommandCentreRegistry;
}

export function isSafeInternalLinkTemplate(link: string): boolean {
  if (!link.startsWith("/admin") || link.startsWith("//") || link.includes("#")) {
    return false;
  }

  const [path, ...queryParts] = link.split("?");
  if (queryParts.length > 1 || !path || path.includes("\\")) {
    return false;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return false;
  }

  if (
    decodedPath.includes("..") ||
    !/^\/admin(?:\/(?:[a-z0-9-]+|\{partnerId\}))*$/.test(decodedPath)
  ) {
    return false;
  }

  const query = queryParts[0];
  if (query === undefined) {
    return true;
  }

  const parameters = new URLSearchParams(query);
  const entries = [...parameters.entries()];
  return (
    entries.length === 1 &&
    entries[0][0] === "tab" &&
    allowedAdminTabs.has(entries[0][1])
  );
}

export function serialiseCommandCentreRegistryForBrowser(
  registry: ValidatedCommandCentreRegistry = commandCentreRegistry,
): readonly CommandCentreDescriptor[] {
  return registry.map((descriptor): CommandCentreDescriptor => {
    const common = {
      id: descriptor.id,
      version: descriptor.version,
      displayName: descriptor.displayName,
      departmentId: descriptor.departmentId,
      outcome: descriptor.outcome,
      visibility: descriptor.visibility,
      canonicalSourceRefs: [...descriptor.canonicalSourceRefs],
      kpiIds: [...descriptor.kpiIds],
      // Templates describe server policy but cannot be a browser control until
      // a specific, authorised canonical record has resolved every placeholder.
      safeInternalLinks: descriptor.safeInternalLinks.filter((link) => !link.includes("{")),
      status: descriptor.status,
    };

    if (descriptor.kind === "CAPABILITY") {
      return {
        ...common,
        kind: "CAPABILITY",
        automation: "HUMAN",
      };
    }

    return {
      ...common,
      kind: "POLICY",
      automation: "SYSTEM_DETERMINISTIC",
    };
  });
}

// Importing this module validates the code-owned registry before server startup.
export const commandCentreRegistry = validateCommandCentreRegistry(
  COMMAND_CENTRE_REGISTRY,
);
