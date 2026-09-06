import { COMPONENT_READINESS_MANIFESTS } from "../../config/components";
export { COMPONENT_READINESS_MANIFESTS } from "../../config/components";

interface OrderedName {
  readonly name: string;
  readonly order: number;
}
interface OrderedTrigger extends OrderedName {
  readonly relation: string;
}
export type ReadinessMigrationEstate = "main" | "vault-quest";
interface OrderedMigration extends OrderedName {
  readonly estate?: ReadinessMigrationEstate;
}

export interface ComponentReadinessManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly owner: string;
  readonly releaseMode: "required" | "optional-disabled";
  readonly runtimeState: "enabled" | "disabled";
  readonly sourceRoots: readonly string[];
  readonly requirements: {
    readonly migrations: readonly OrderedMigration[];
    readonly relations: readonly OrderedName[];
    readonly triggers: readonly OrderedTrigger[];
    readonly environment: readonly OrderedName[];
    readonly runtimeSignals: readonly OrderedName[];
  };
}

export interface CompiledComponentReadinessRegistry {
  readonly componentIds: readonly string[];
  readonly runtimeComponentIds: readonly string[];
  readonly requiredMigrations: readonly string[];
  readonly requiredMigrationRequirements: readonly Readonly<{ estate: ReadinessMigrationEstate; name: string }>[];
  readonly requiredRelations: readonly string[];
  readonly requiredTriggers: readonly string[];
  readonly requiredTriggerRelations: readonly string[];
  readonly requiredEnvironment: readonly string[];
  readonly runtimeSignals: Readonly<Record<string, string>>;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MIGRATION_PATTERN = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;
const RELATION_PATTERN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const SIGNAL_PATTERN = /^[a-z_][a-z0-9_]*$/;

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function validateOrdered(
  values: unknown,
  label: string,
  pattern: RegExp,
  relationRequired = false,
  estateAllowed = false
): asserts values is readonly (OrderedName | OrderedTrigger)[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  for (const value of values) {
    const candidate = value as Partial<OrderedTrigger & OrderedMigration> | null;
    if (
      !candidate ||
      typeof candidate.name !== "string" ||
      !pattern.test(candidate.name) ||
      !Number.isSafeInteger(candidate.order) ||
      (candidate.order as number) < 0
    ) {
      throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
    }
    if (relationRequired && (typeof candidate.relation !== "string" || !RELATION_PATTERN.test(candidate.relation))) {
      throw new Error(`invalid ${label} relation: ${String(candidate.relation)}`);
    }
    const hasEstate = Object.hasOwn(candidate, "estate");
    if (estateAllowed && hasEstate && candidate.estate !== "main" && candidate.estate !== "vault-quest") {
      throw new Error(`invalid ${label} estate: ${String(candidate.estate)}`);
    }
    assertExactKeys(
      candidate,
      relationRequired
        ? ["name", "order", "relation"]
        : estateAllowed && hasEstate
          ? ["name", "order", "estate"]
          : ["name", "order"],
      label
    );
  }
}

function validateManifest(value: unknown): asserts value is ComponentReadinessManifest {
  if (!value || typeof value !== "object") throw new Error("component manifest must be an object");
  const manifest = value as Partial<ComponentReadinessManifest>;
  assertExactKeys(
    manifest,
    ["schemaVersion", "id", "owner", "releaseMode", "runtimeState", "sourceRoots", "requirements"],
    "component manifest"
  );
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported component schema: ${String(manifest.schemaVersion)}`);
  if (typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id))
    throw new Error(`invalid component id: ${String(manifest.id)}`);
  if (typeof manifest.owner !== "string" || !ID_PATTERN.test(manifest.owner))
    throw new Error(`invalid component owner: ${String(manifest.owner)}`);
  if (manifest.releaseMode !== "required" && manifest.releaseMode !== "optional-disabled")
    throw new Error(`invalid release mode for ${manifest.id}`);
  if (manifest.runtimeState !== "enabled" && manifest.runtimeState !== "disabled")
    throw new Error(`invalid runtime state for ${manifest.id}`);
  if (manifest.releaseMode === "required" && manifest.runtimeState !== "enabled") {
    throw new Error(`${manifest.id} required component must be runtime enabled`);
  }
  if (manifest.releaseMode === "optional-disabled" && manifest.runtimeState !== "disabled") {
    throw new Error(`${manifest.id} optional-disabled component must be runtime disabled`);
  }
  if (
    !Array.isArray(manifest.sourceRoots) ||
    manifest.sourceRoots.length === 0 ||
    manifest.sourceRoots.some((root) => typeof root !== "string" || !/^(?:server|client\/src|scripts)\//.test(root))
  ) {
    throw new Error(`invalid source roots for ${manifest.id}`);
  }
  assertUnique(manifest.sourceRoots, `${manifest.id} source root`);
  if (!manifest.requirements || typeof manifest.requirements !== "object")
    throw new Error(`${manifest.id} requirements must be an object`);
  assertExactKeys(
    manifest.requirements,
    ["migrations", "relations", "triggers", "environment", "runtimeSignals"],
    `${manifest.id} requirements`
  );
  validateOrdered(manifest.requirements.migrations, `${manifest.id} migration`, MIGRATION_PATTERN, false, true);
  validateOrdered(manifest.requirements.relations, `${manifest.id} relation`, RELATION_PATTERN);
  validateOrdered(manifest.requirements.triggers, `${manifest.id} trigger`, SIGNAL_PATTERN, true);
  validateOrdered(manifest.requirements.environment, `${manifest.id} environment name`, ENV_PATTERN);
  validateOrdered(manifest.requirements.runtimeSignals, `${manifest.id} runtime signal`, SIGNAL_PATTERN);
}

function flatten(
  manifests: readonly ComponentReadinessManifest[],
  key: "migrations" | "relations" | "triggers" | "environment" | "runtimeSignals"
): readonly (OrderedName | OrderedTrigger)[] {
  const values = manifests.flatMap((manifest) => [...manifest.requirements[key]]);
  assertUnique(
    values.map((value) =>
      key === "migrations" ? `${(value as OrderedMigration).estate ?? "main"}:${value.name}` : value.name
    ),
    `required ${key}`
  );
  assertUnique(
    values.map((value) => String(value.order)),
    `required ${key} order`
  );
  const ordered = values.sort((a, b) => a.order - b.order);
  ordered.forEach((value, index) => {
    if (value.order !== index) throw new Error(`required ${key} order gap: expected ${index}, received ${value.order}`);
  });
  return ordered;
}

/** Compile manifests without reading the filesystem or contacting a dependency. */
export function compileComponentReadinessRegistry(manifests: readonly unknown[]): CompiledComponentReadinessRegistry {
  for (const manifest of manifests) validateManifest(manifest);
  const validated = manifests as readonly ComponentReadinessManifest[];
  assertUnique(
    validated.map((manifest) => manifest.id),
    "component id"
  );
  const required = validated.filter((manifest) => manifest.releaseMode === "required");
  const migrations = flatten(required, "migrations") as readonly OrderedMigration[];
  const relations = flatten(required, "relations");
  const triggers = flatten(required, "triggers") as readonly OrderedTrigger[];
  const environment = flatten(required, "environment");
  const runtimeSignals = flatten(required, "runtimeSignals");
  return Object.freeze({
    componentIds: Object.freeze(required.map((manifest) => manifest.id).sort()),
    runtimeComponentIds: Object.freeze(
      validated
        .filter((manifest) => manifest.runtimeState === "enabled")
        .map((manifest) => manifest.id)
        .sort()
    ),
    // Compatibility projection for the existing public.schema_migrations query.
    // Other estates must never be looked up in that journal by filename alone.
    requiredMigrations: Object.freeze(
      migrations.filter((value) => (value.estate ?? "main") === "main").map((value) => value.name)
    ),
    requiredMigrationRequirements: Object.freeze(
      migrations.map((value) => Object.freeze({ estate: value.estate ?? "main", name: value.name }))
    ),
    requiredRelations: Object.freeze(relations.map((value) => value.name)),
    requiredTriggers: Object.freeze(triggers.map((value) => value.name)),
    requiredTriggerRelations: Object.freeze(triggers.map((value) => value.relation)),
    requiredEnvironment: Object.freeze(environment.map((value) => value.name)),
    runtimeSignals: Object.freeze(Object.fromEntries(runtimeSignals.map((value) => [value.name, value.name]))),
  });
}

export const COMPONENT_READINESS_REGISTRY = compileComponentReadinessRegistry(COMPONENT_READINESS_MANIFESTS);

export function isComponentAvailable(componentId: string): boolean {
  return COMPONENT_READINESS_REGISTRY.runtimeComponentIds.includes(componentId);
}
