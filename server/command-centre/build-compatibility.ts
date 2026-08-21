/**
 * This direct property access is deliberately compiled by script/build.ts.
 * The production server must agree with the client artifact even though the
 * builder-stage environment is not present in the final container.
 */
export const COMMAND_CENTRE_CANONICAL_PARTNER_DESTINATIONS_COMPILED =
  process.env.VITE_PARTNER_NETWORK_CONSOLIDATION === "true";

export function isCommandCentreBuildCompatible(environment?: NodeJS.ProcessEnv): boolean {
  const nodeEnvironment = environment?.NODE_ENV ?? process.env.NODE_ENV;
  const canonicalDestinations = environment
    ? environment.VITE_PARTNER_NETWORK_CONSOLIDATION === "true"
    : COMMAND_CENTRE_CANONICAL_PARTNER_DESTINATIONS_COMPILED;
  return nodeEnvironment !== "production" || canonicalDestinations;
}
