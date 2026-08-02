/**
 * Project Control — the single source of environment identity.
 *
 * THE PROBLEM
 *
 * Project Control's entire value is that it says what is TRUE about a specific environment.
 * "Migration 0039 is applied" is a useless sentence until you know applied WHERE. Every piece of
 * evidence the dashboard stores is therefore labelled with an environment name, and every gate it
 * evaluates is scoped to one.
 *
 * The two resolvers this module replaces both derived that label from `NODE_ENV` when
 * `PROJECT_CONTROL_ENV` was unset:
 *
 *   migration-scan.ts   NODE_ENV === "production" -> "production", else "local"
 *   probe-persistence.ts PROJECT_CONTROL_ENV || NODE_ENV || "unknown"
 *
 * `NODE_ENV` is set to `production` on EVERY deployed Fly machine, staging included, because that
 * is what it means — "run the optimised build", not "this is the production estate". So a staging
 * deployment with no `PROJECT_CONTROL_ENV` labels its evidence `production`, and the dashboard then
 * reports staging's migrations, staging's flags and staging's deployed version as production fact.
 * That is the worst failure this system can have: it is confidently wrong about the environment
 * that matters most.
 *
 * The mirror-image failure is just as bad. A developer's laptop pointed at the production database
 * has no `PROJECT_CONTROL_ENV` and `NODE_ENV=development`, so the old resolver answered "local" —
 * and the seed apply blockade, which refuses only when the answer is exactly "production", let the
 * write through.
 *
 * THE RULE
 *
 * `PROJECT_CONTROL_ENV` is the ONLY authority for a deployed environment. `NODE_ENV` may never
 * name one. When identity cannot be established the answer is `unknown`, and `unknown` is a
 * refusal, not a default — it cannot label evidence and it cannot execute a seed.
 *
 * Fail-closed means the cost of a missing environment variable is a visibly unavailable dashboard.
 * Fail-open means the cost is a confidently mislabelled one. The first is a five-minute fix; the
 * second is a wrong decision taken on false evidence.
 *
 * Pure. No database, no network, no clock.
 */

export const PROJECT_CONTROL_ENVIRONMENTS = ["production", "staging", "local", "unknown"] as const;
export type ProjectControlEnvironment = (typeof PROJECT_CONTROL_ENVIRONMENTS)[number];

/** The environments that name real deployed estates. Evidence about these must be trustworthy. */
export const DEPLOYED_ENVIRONMENTS = ["production", "staging"] as const;

/**
 * `NODE_ENV` values that prove we are NOT on a deployed machine.
 *
 * This is deliberately an allowlist of the two values a local or CI process sets. Anything else —
 * `production` above all, but equally a typo or an unset variable — is not evidence of locality and
 * therefore resolves to `unknown`.
 */
const NON_DEPLOYED_NODE_ENVS = new Set(["test", "development"]);

/**
 * Resolve the environment this process is connected to.
 *
 * Returns `unknown` whenever identity cannot be established from `PROJECT_CONTROL_ENV` alone and
 * the process is not provably local. Callers must treat `unknown` as "refuse", never as a default.
 */
export function resolveProjectControlEnvironment(
  env: NodeJS.ProcessEnv = process.env
): ProjectControlEnvironment {
  const explicit = (env.PROJECT_CONTROL_ENV ?? "").trim().toLowerCase();
  if (explicit === "production" || explicit === "staging" || explicit === "local") return explicit;

  // An explicit value we do not recognise is a configuration error, not a hint. Guessing which
  // estate "prod" or "stg" meant is exactly the kind of inference this module exists to forbid.
  if (explicit.length > 0) return "unknown";

  // No explicit identity. `NODE_ENV` may prove we are NOT deployed, but it may never NAME a
  // deployed environment — every Fly machine sets it to `production`, staging included.
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (NON_DEPLOYED_NODE_ENVS.has(nodeEnv)) return "local";

  return "unknown";
}

/**
 * True when this process knows which estate it is talking about.
 *
 * Deliberately validates against the canonical list rather than testing `!== "unknown"`. A caller
 * in untyped territory — a test fixture, a JSON body, a stale build — can hand us `undefined` or a
 * string we never defined, and "not literally the word unknown" would wave all of those through.
 * Anything we do not recognise is unknown by definition.
 */
export function isEnvironmentKnown(environment: ProjectControlEnvironment | string | undefined | null): boolean {
  if (typeof environment !== "string") return false;
  return environment === "production" || environment === "staging" || environment === "local";
}

/** True when this environment names a real deployed estate (production or staging). */
export function isDeployedEnvironment(environment: ProjectControlEnvironment): boolean {
  return (DEPLOYED_ENVIRONMENTS as readonly string[]).includes(environment);
}

/**
 * May evidence be persisted under this environment label?
 *
 * No. An `unknown` environment cannot write a labelled row, because there is no label that would
 * be true. Writing it as "local" would be a lie about a deployed machine; writing it as
 * "production" would be a lie about a laptop. The honest outcome is that the write does not happen
 * and the dashboard shows the evidence as unavailable.
 */
export function mayWriteLabelledEvidence(environment: ProjectControlEnvironment): boolean {
  return isEnvironmentKnown(environment);
}

/**
 * Does evidence recorded in `evidenceEnvironment` speak to a question asked about `targetEnvironment`?
 *
 * Only an exact match counts. Staging evidence never proves a production gate, and evidence with
 * an unknown label proves nothing about anywhere.
 */
export function evidenceAppliesTo(
  evidenceEnvironment: string | null | undefined,
  targetEnvironment: ProjectControlEnvironment
): boolean {
  if (!isEnvironmentKnown(targetEnvironment)) return false;
  const label = (evidenceEnvironment ?? "").trim().toLowerCase();
  if (label.length === 0 || label === "unknown") return false;
  return label === targetEnvironment;
}

/** Why a seed apply was refused on environment grounds, or `null` when the environment permits it. */
export type SeedEnvironmentRefusal = "unknown_environment" | "production_blocked" | null;

/**
 * Decide whether a seed apply may proceed in this environment.
 *
 * Two refusals, both fail-closed:
 *
 *   `unknown_environment`  we cannot tell which estate this is, so we cannot tell whether the
 *                          production blockade applies. Refusing is the only safe answer — the old
 *                          code answered "local" here and let a laptop pointed at production write.
 *   `production_blocked`   this IS production, and rewriting production's programme structure
 *                          requires a separate, deliberately awkward owner authorisation that is
 *                          not the Project Control feature flag.
 */
export function seedApplyRefusal(
  environment: ProjectControlEnvironment | string | undefined | null,
  productionOverride: boolean
): SeedEnvironmentRefusal {
  if (!isEnvironmentKnown(environment)) return "unknown_environment";
  if (environment === "production" && productionOverride !== true) return "production_blocked";
  return null;
}
