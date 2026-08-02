/**
 * Project Control — feature-flag evidence.
 *
 * "Deployed" does not mean "on". Several release-critical surfaces in this codebase ship dark
 * behind a fail-closed flag, and the dashboard has to be able to say which — otherwise an operator
 * reads a green deployment row and concludes a feature is live when it is switched off.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO PRESERVE
 * ----------------------------------------------
 * A missing environment variable and a flag explicitly set to false are DIFFERENT evidence states,
 * even though both mean "off" today:
 *
 *   - ABSENT  — nobody has made a decision here. The remedy is "set it".
 *   - FALSE   — somebody decided, deliberately. The remedy is "change the decision".
 *
 * Collapsing them into one "disabled" hides whether a switch-off was intentional. That is exactly
 * the question a release checklist needs answered, so the two are kept apart.
 *
 * SAFETY: this reads flag NAMES and resolves them to a state. It never returns a value, and the
 * flags listed here are booleans by construction — no secret is readable through this surface.
 * Database-resolved flags (the partner set) are deliberately NOT read here; they live in another
 * database behind another gate, and a flag whose authority is a DB row must be reported by that
 * authority, not guessed at from the environment.
 */

/** How a flag's state was established, and whether anyone has actually decided. */
export const FLAG_STATES = ["enabled", "disabled_explicit", "absent", "unknown"] as const;
export type FlagState = (typeof FLAG_STATES)[number];

export interface FlagEvidence {
  /** The environment-variable name. Never its value. */
  name: string;
  /** What the flag gates, in plain English, so the dashboard need not hard-code copy. */
  gates: string;
  state: FlagState;
  /** Where the answer came from. `environment` here; DB-resolved flags report elsewhere. */
  source: "environment" | "database" | "unknown";
  observedAt: string;
  /** Operator-facing note. Explains the difference between absent and explicitly-off. */
  note: string;
}

/**
 * The flags Project Control reports on.
 *
 * Deliberately a fixed list rather than a scan of `process.env`: enumerating the environment would
 * leak the NAMES of unrelated secrets into a dashboard response, which is a disclosure this
 * module has no reason to make.
 */
export const TRACKED_FLAGS: ReadonlyArray<{ name: string; gates: string }> = Object.freeze([
  {
    name: "SUPER_ADMIN_PROJECT_CONTROL_ENABLED",
    gates: "This dashboard. Fail-closed: absent means every Project Control route 404s.",
  },
  {
    name: "PROJECT_CONTROL_GITHUB_TOKEN",
    gates: "Live GitHub repository evidence. Absent means repository status reads UNKNOWN.",
  },
  {
    name: "PROJECT_CONTROL_GITHUB_REPO",
    gates: "Which repository GitHub evidence is read from.",
  },
  { name: "TRANSFER_FLOW_LIVE", gates: "The v2 ownership-transfer flow." },
  { name: "PUBLIC_NAME_TOGGLE_LIVE", gates: "Owner display name on public certificate verification." },
  { name: "LEGAL_PAGES_LIVE", gates: "Public legal pages." },
  {
    name: "PARTNER_DATABASE_URL",
    gates: "The partner portal runtime. Absent means every /api/partner route 503s, fail-closed.",
  },
  {
    name: "PARTNER_MFA_ENC_KEY",
    gates: "Partner MFA. Set without it, PARTNER_DATABASE_URL is an incoherent config and the portal closes.",
  },
  { name: "SUPER_ADMIN_EMAILS", gates: "Super Admin membership. Absent falls back to the single ADMIN_EMAIL." },
]);

/** Values that count as an affirmative. Anything else that is present counts as an explicit no. */
const AFFIRMATIVE = new Set(["true", "1", "yes", "on", "enabled"]);

function classify(raw: string | undefined): { state: FlagState; note: string } {
  if (raw === undefined) {
    return {
      state: "absent",
      note: "Not set in this environment. Nobody has made a decision here — this is not the same as being switched off deliberately.",
    };
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") {
    return {
      state: "absent",
      note: "Set to an empty value, which reads as unset. Treat as no decision made.",
    };
  }
  if (AFFIRMATIVE.has(trimmed)) {
    return { state: "enabled", note: "Explicitly enabled in this environment." };
  }
  // A non-boolean value (a URL, a key) means the variable is PRESENT and therefore configured;
  // for the credential-shaped entries in the list that is the meaningful signal.
  if (trimmed === "false" || trimmed === "0" || trimmed === "no" || trimmed === "off") {
    return { state: "disabled_explicit", note: "Explicitly disabled. Somebody made this decision." };
  }
  return { state: "enabled", note: "Configured (a value is present). The value itself is never read or returned." };
}

/**
 * Read the tracked flags from the process environment.
 *
 * Returns evidence for EVERY tracked flag, including the absent ones — an absent flag is the most
 * operationally interesting state and omitting it would hide it.
 */
export function collectFlagEvidence(env: NodeJS.ProcessEnv = process.env): FlagEvidence[] {
  const observedAt = new Date().toISOString();
  return TRACKED_FLAGS.map(({ name, gates }) => {
    const { state, note } = classify(env[name]);
    return { name, gates, state, source: "environment" as const, observedAt, note };
  });
}
