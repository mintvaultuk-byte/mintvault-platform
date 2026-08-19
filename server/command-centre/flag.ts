import { resolveGlobalFlag } from "../partner/flags";

/** Legacy deployment default name. Runtime access is governed by the Pilot Flag below. */
export const COMMAND_CENTRE_FLAG_ENV = "SUPER_ADMIN_COMMAND_CENTRE_ENABLED";
export const COMMAND_CENTRE_PILOT_FLAG = "super_admin_command_centre_enabled";

const AFFIRMATIVE_VALUES = new Set(["true", "1", "yes", "on", "enabled"]);

/**
 * Command Centre is unavailable unless explicitly enabled.
 *
 * This intentionally accepts a small affirmative allow-list rather than using
 * JavaScript truthiness, so values such as "false" and "0" always keep the
 * feature off.
 */
export function isCommandCentreEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuredValue = environment[COMMAND_CENTRE_FLAG_ENV];

  return (
    typeof configuredValue === "string" &&
    AFFIRMATIVE_VALUES.has(configuredValue.trim().toLowerCase())
  );
}

/** Runtime resolver used by every live Command Centre entry point. */
export async function isCommandCentreEnabledRuntime(): Promise<boolean> {
  try {
    return await resolveGlobalFlag(COMMAND_CENTRE_PILOT_FLAG);
  } catch {
    return false;
  }
}
