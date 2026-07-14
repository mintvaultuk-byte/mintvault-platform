/**
 * Vault Quest Action Reference — action-category rotation (Phase B).
 *
 * Root cause context (see server/routes/vault-quest-admin.ts collectReferenceImages):
 * Action Reference *replacement* was feeding the currently-approved Action pose back
 * to the generator as a reference image, so the model reproduced it — repeated
 * Replace clicks produced the same running/leaping pose. Part of the fix is to stop
 * defaulting to the same action: an explicit, rotating category is chosen (or the
 * founder picks one) and injected into the prompt, and on an Auto choice the existing
 * approved action's category is excluded so the next one is deliberately different.
 *
 * This module is the PURE, shared, independently-testable half: the canonical
 * category list (used by both the client dropdown and the server prompt builder) and
 * a deterministic chooser. No network, no DOM, no Node APIs — safe on both sides.
 */

export interface VqActionCategory {
  /** Stable machine value stored on the candidate + audit record. */
  value: string;
  /** Founder-facing dropdown label. */
  label: string;
  /** Prompt fragment injected into the generation prompt describing the action. */
  prompt: string;
}

/** The 12 canonical action categories. Order is the rotation order used by Auto. */
export const VQ_ACTION_CATEGORIES: readonly VqActionCategory[] = [
  { value: "sprinting", label: "Sprinting", prompt: "sprinting at full speed, legs extended mid-stride, body low and driving forward with clear motion" },
  { value: "leaping_up", label: "Leaping upward", prompt: "leaping powerfully upward, body stretched and rising, limbs pushing off, clearly airborne and ascending" },
  { value: "landing", label: "Landing", prompt: "landing from a jump, weight absorbed low on braced legs, body compressed on impact, dust/energy of the landing implied" },
  { value: "dodging", label: "Dodging sideways", prompt: "dodging sharply sideways, torso twisted away, weight shifted laterally, an evasive off-balance sidestep" },
  { value: "defensive", label: "Defensive stance", prompt: "in a crouched defensive stance, low and coiled, braced and guarding, weight back and ready to react" },
  { value: "charging_attack", label: "Charging an attack", prompt: "charging up an attack, body wound and tensed with gathering energy, a clear pre-strike windup" },
  { value: "roaring", label: "Roaring", prompt: "roaring with head raised and mouth open, chest out and body drawn up, a commanding vocal display" },
  { value: "twisting", label: "Twisting mid-air", prompt: "twisting mid-air, body rotated along its length, limbs and tail spiralling, an acrobatic aerial turn" },
  { value: "looking_back", label: "Looking back while moving", prompt: "moving in one direction while looking back over the shoulder, head turned opposite to the direction of travel" },
  { value: "casting", label: "Casting an ability", prompt: "casting an elemental ability, one or both limbs extended channelling energy, an active spell-casting gesture" },
  { value: "bracing", label: "Bracing against impact", prompt: "bracing against an incoming impact, feet planted wide and dug in, body leaning into the force, arms/limbs shielding" },
  { value: "celebrating", label: "Celebrating", prompt: "celebrating a victory, an exuberant triumphant pose, head up and limbs thrown out in a joyful, energetic gesture" },
] as const;

/** The dropdown options the founder sees: Auto first, then every category. */
export const VQ_ACTION_CATEGORY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "auto", label: "Auto — choose a different action" },
  ...VQ_ACTION_CATEGORIES.map((c) => ({ value: c.value, label: c.label })),
];

/** Look a category up by value; undefined for "auto"/unknown. */
export function findActionCategory(value: string | null | undefined): VqActionCategory | undefined {
  if (!value) return undefined;
  return VQ_ACTION_CATEGORIES.find((c) => c.value === value);
}

const isRealCategory = (value: string | null | undefined): value is string =>
  !!value && VQ_ACTION_CATEGORIES.some((c) => c.value === value);

/**
 * Deterministically choose the action category for a generation.
 *
 * - An explicit, valid `requested` category is honoured verbatim (the founder chose it).
 * - Otherwise ("auto" / blank / unknown), pick from the canonical list, EXCLUDING the
 *   existing approved action's category (so a replacement is deliberately different),
 *   rotating by `attempt` so a retry lands on yet another category. Deterministic
 *   (no Math.random) so it is trivially unit-testable and reproducible.
 *
 * Never returns the excluded category on an Auto choice (unless every category is
 * excluded, which cannot happen with a single exclusion and 12 categories).
 */
export function chooseActionCategory(opts: {
  requested?: string | null;
  excludeCategory?: string | null;
  /** 1-based attempt number — a retry rotates to the next eligible category. */
  attempt?: number;
}): VqActionCategory {
  if (isRealCategory(opts.requested)) return findActionCategory(opts.requested)!;
  const attempt = Number.isInteger(opts.attempt) && (opts.attempt as number) > 0 ? (opts.attempt as number) : 1;
  const eligible = VQ_ACTION_CATEGORIES.filter((c) => c.value !== opts.excludeCategory);
  const pool = eligible.length > 0 ? eligible : VQ_ACTION_CATEGORIES;
  // (attempt-1) offset so attempt 1 → first eligible, attempt 2 → next, wrapping.
  return pool[(attempt - 1) % pool.length];
}
