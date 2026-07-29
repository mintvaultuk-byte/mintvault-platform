/**
 * Project Control — activation flag.
 *
 * REMEDIATION of hostile-review finding H9: the build had no feature flag at all, so the routes
 * were live the moment the code deployed. The superseded WIP (19aa73dd) DID have an
 * `isProjectControlEnabled()` gate; this carries that capability forward.
 *
 * FAIL CLOSED. Absent, empty, malformed, or anything other than an explicit affirmative reads as
 * DISABLED. There is no "default on", and no way for a missing environment variable to be
 * interpreted as permission.
 *
 * Activation is therefore separable from deployment: the code can ship dark and be switched on
 * afterwards, which is the whole point of shipping a control surface behind a flag.
 */

export const PROJECT_CONTROL_FLAG = "super_admin_project_control_enabled";

/** The environment variable carrying the flag (the flag name, upper-cased). */
export const PROJECT_CONTROL_FLAG_ENV = "SUPER_ADMIN_PROJECT_CONTROL_ENABLED";

/** Only these exact values enable the dashboard. Everything else disables it. */
const AFFIRMATIVE = new Set(["true", "1", "yes", "on", "enabled"]);

export function isProjectControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[PROJECT_CONTROL_FLAG_ENV];
  if (typeof raw !== "string") return false;
  return AFFIRMATIVE.has(raw.trim().toLowerCase());
}

/**
 * The disabled response body. Deliberately identical whether the flag is absent or explicitly
 * false, and it never echoes the flag's value — only its name, so an operator knows what to set.
 */
export function projectControlDisabledPayload(): { error: string; flag: string; enabled: false } {
  return {
    error:
      "Project Control is not enabled in this environment. It is off by default and must be switched on deliberately.",
    flag: PROJECT_CONTROL_FLAG,
    enabled: false,
  };
}
