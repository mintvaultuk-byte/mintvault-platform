/**
 * Vault Quest AI generators (Phases 2-4). Each builds a guard-railed prompt, calls
 * the text provider, parses strict JSON, screens every suggestion through the
 * guardrails, and returns PREVIEW-ONLY suggestions. Nothing is saved or applied
 * here — the route records an audit row and the client requires a manual Apply.
 */
import { getTextProvider } from "./provider";
import { guardInput, guardOutput } from "./guardrails";

export interface CardContext {
  name?: string;
  cardType?: string;
  element?: string;
  stageNumber?: string | number;
  familyName?: string;
  previousStage?: string;
  rarity?: string;
  health?: string | number;
  guard?: string | number;
  shift?: string | number;
  attack1Name?: string;
  attack1Damage?: string | number;
  attack2Name?: string;
  vulnerability?: string;
}

export interface Suggestion {
  text: string; // display string
  reason?: string;
  pronunciation?: string;
  warning?: string; // similarity / style warnings (soft)
  fields?: Record<string, unknown>; // structured values to Apply (stats, attack, family names…)
}

export interface GenResult {
  suggestions: Suggestion[];
  provider: string;
  model: string;
  promptSummary: string;
  dropped: number; // suggestions removed by guardrails
  note?: string;
}

export type GenKind = "name" | "family-names" | "gameplay" | "flavour" | "artwork-prompt";

// The locked VQ lexicon the model must stay inside.
const LEXICON = `Vault Quest lexicon (MANDATORY): use Health, Guard, Shift, Core (energy), Ascend (evolve), Vulnerability. NEVER use HP, Weakness, Resistance, Retreat, or any Pokémon/Yu-Gi-Oh/Magic/Lorcana/Digimon/One Piece term. Attacks are free unless a Core cost is printed. Family-friendly, readable by a child.`;
const NAME_RULES = `Names must be SHORT (one word preferred, max two), invented and evocative, easy to say. FORBIDDEN: medieval words (guardian, sentinel, warden, knight, vault, sword, shield, castle, realm, throne, etc.); the specific words Guardian/Sentinel/Warden/Knight/Vault; copying or near-copying Pokémon/Yu-Gi-Oh/Magic/Lorcana/Digimon/One Piece names; any trademarked name.`;
const STAGE_SCALE = `Stage 1 (Baby) is weakest, Stage 2 (Teen) stronger, Stage 3 (Final) strongest. Baseline stats: S1 Health 5 / Guard 0 / Shift 0; S2 8 / 1 / 1; S3 12 / 3 / 2. Keep numbers small and whole.`;

function ctxLine(c: CardContext): string {
  const parts = [
    c.name && `name "${c.name}"`,
    c.cardType && `type ${c.cardType}`,
    c.element && `element ${c.element}`,
    c.stageNumber && `stage ${c.stageNumber}`,
    c.familyName && `family "${c.familyName}"`,
    c.previousStage && `evolves from "${c.previousStage}"`,
    c.rarity && `rarity ${c.rarity}`,
    (c.health || c.guard || c.shift) && `stats H${c.health ?? "?"}/G${c.guard ?? "?"}/S${c.shift ?? "?"}`,
    c.attack1Name && `attack1 "${c.attack1Name}"`,
    c.vulnerability && `vulnerable to ${c.vulnerability}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "(no data yet)";
}

function parseJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  const lastCurly = s.lastIndexOf("}");
  const lastSquare = s.lastIndexOf("]");
  const end = Math.max(lastCurly, lastSquare);
  if (end >= 0) s = s.slice(0, end + 1);
  return JSON.parse(s);
}

interface PromptSpec {
  system: string;
  user: string;
  maxTokens: number;
  // turn parsed JSON into raw suggestions before guardrails
  extract: (parsed: unknown) => Suggestion[];
}

function nameSpec(ctx: CardContext, mode: string, n: number): PromptSpec {
  const modeInstruction: Record<string, string> = {
    generate: `Generate ${n} name ideas.`,
    alternatives: `Generate ${n} alternative names.`,
    improve: `Improve the current name; give ${n} refined variants.`,
    cuter: `Make the name cuter / more adorable; give ${n} options.`,
    powerful: `Make the name more powerful / imposing (still family-friendly); give ${n} options.`,
    "less-medieval": `Make the name less medieval and more modern/mascot; give ${n} options.`,
    mascot: `Make the name more mascot-style (playful, brandable); give ${n} options.`,
    stage1: `Suggest ${n} Stage 1 (Baby) names — cute, small.`,
    stage2: `Suggest ${n} Stage 2 (Teen) names — evolving.`,
    stage3: `Suggest ${n} Stage 3 (Final) names — strongest.`,
  };
  return {
    system: `You name creatures for Vault Quest, a family-friendly collectible card game. ${NAME_RULES} Reply with STRICT JSON only.`,
    user: `Card context: ${ctxLine(ctx)}.\n${modeInstruction[mode] ?? modeInstruction.generate}\nReturn JSON: {"suggestions":[{"name":"...","reason":"short why","pronunciation":"PRO-nun-see-AY-shun","warning":"only if close to a famous/trademarked name, else empty"}]}`,
    maxTokens: 900,
    extract: (p) => ((p as { suggestions?: { name?: string; reason?: string; pronunciation?: string; warning?: string }[] }).suggestions ?? [])
      .filter((s) => s?.name)
      .map((s) => ({ text: String(s.name), reason: s.reason, pronunciation: s.pronunciation, warning: s.warning || undefined, fields: { name: String(s.name) } })),
  };
}

function familyNamesSpec(ctx: CardContext, n: number): PromptSpec {
  return {
    system: `You name three-stage evolution families for Vault Quest. ${NAME_RULES} The three names should sound related (shared root/theme) but distinct. Reply with STRICT JSON only.`,
    user: `Family context: ${ctxLine(ctx)}.\nGenerate ${n} full family name sets (Baby → Teen → Final).\nReturn JSON: {"suggestions":[{"stage1":"...","stage2":"...","stage3":"...","reason":"short why"}]}`,
    maxTokens: 900,
    extract: (p) => ((p as { suggestions?: { stage1?: string; stage2?: string; stage3?: string; reason?: string }[] }).suggestions ?? [])
      .filter((s) => s?.stage1 && s?.stage2 && s?.stage3)
      .map((s) => ({ text: `${s.stage1} → ${s.stage2} → ${s.stage3}`, reason: s.reason, fields: { stage1: s.stage1, stage2: s.stage2, stage3: s.stage3 } })),
  };
}

function gameplaySpec(ctx: CardContext, mode: string): PromptSpec {
  const base = `Card context: ${ctxLine(ctx)}. ${LEXICON} ${STAGE_SCALE}`;
  const specs: Record<string, { instr: string; shape: string }> = {
    attack1: { instr: "Design attack 1.", shape: `{"suggestions":[{"attack1Name":"...","attack1Cost":0,"attack1Damage":2,"attack1Effect":"optional short effect","reason":"..."}]}` },
    attack2: { instr: "Design attack 2.", shape: `{"suggestions":[{"attack2Name":"...","attack2Cost":1,"attack2Damage":3,"attack2Effect":"optional short effect","reason":"..."}]}` },
    "balanced-pair": { instr: "Design a balanced pair of attacks (a cheap one and a stronger one).", shape: `{"suggestions":[{"attack1Name":"...","attack1Cost":0,"attack1Damage":2,"attack1Effect":"","attack2Name":"...","attack2Cost":2,"attack2Damage":4,"attack2Effect":"","reason":"..."}]}` },
    weaker: { instr: "Rebalance this card WEAKER (lower stats/damage) while staying fun.", shape: `{"suggestions":[{"health":4,"guard":0,"shift":0,"attack1Damage":1,"reason":"..."}]}` },
    stronger: { instr: "Rebalance this card STRONGER (within its stage) while staying fair.", shape: `{"suggestions":[{"health":10,"guard":2,"shift":1,"attack1Damage":3,"reason":"..."}]}` },
    "suggest-stats": { instr: "Suggest Health / Guard / Shift for this stage.", shape: `{"suggestions":[{"health":5,"guard":0,"shift":0,"reason":"..."}]}` },
    "suggest-core": { instr: "Suggest Core costs for the attacks (0 unless it should cost).", shape: `{"suggestions":[{"attack1Cost":0,"attack2Cost":1,"reason":"..."}]}` },
    "suggest-vulnerability": { instr: "Suggest a Vulnerability element that makes thematic sense.", shape: `{"suggestions":[{"vulnerability":"...","reason":"..."}]}` },
  };
  const s = specs[mode] ?? specs.attack1;
  return {
    system: `You design balanced gameplay for Vault Quest creatures. ${LEXICON} Numbers only where asked; keep them small and whole. Reply with STRICT JSON only.`,
    user: `${base}\n${s.instr}\nReturn JSON: ${s.shape}`,
    maxTokens: 900,
    extract: (p) => ((p as { suggestions?: Record<string, unknown>[] }).suggestions ?? []).map((row) => {
      const reason = typeof row.reason === "string" ? row.reason : undefined;
      const fields = { ...row };
      delete (fields as Record<string, unknown>).reason;
      const summary = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(" · ");
      return { text: summary || "(gameplay)", reason, fields };
    }),
  };
}

function flavourSpec(ctx: CardContext, mode: string, n: number): PromptSpec {
  const modeInstr: Record<string, string> = {
    generate: `Write ${n} short flavour texts (1 sentence each).`,
    simpler: `Rewrite the flavour simpler / clearer; give ${n} options.`,
    "child-readable": `Rewrite the flavour so a young child can read it; give ${n} options.`,
  };
  return {
    system: `You write short, charming flavour text for Vault Quest cards. ${LEXICON} One sentence, evocative, no game mechanics. Reply with STRICT JSON only.`,
    user: `Card context: ${ctxLine(ctx)}.\n${modeInstr[mode] ?? modeInstr.generate}\nReturn JSON: {"suggestions":[{"text":"...","reason":"short why"}]}`,
    maxTokens: 700,
    extract: (p) => ((p as { suggestions?: { text?: string; reason?: string }[] }).suggestions ?? [])
      .filter((s) => s?.text)
      .map((s) => ({ text: String(s.text), reason: s.reason, fields: { flavour: String(s.text) } })),
  };
}

function artworkSpec(ctx: CardContext, mode: string): PromptSpec {
  const modeInstr: Record<string, string> = {
    main: "the main creature portrait",
    "prev-portrait": "a small portrait of the PREVIOUS evolution stage",
    "family-sheet": "a family sheet showing all three evolution stages side by side",
    variant: "a premium variant illustration (more dramatic lighting/pose)",
    "fsr-scene": "a full-scene FSR illustration (creature in an environment)",
    cleaner: "a cleaner, simpler version of the artwork",
    "more-mascot": "a more mascot-like, friendly, rounded version",
    "less-pokemon": "a version with a more original silhouette and less familiar monster-battler styling",
  };
  return {
    system: `You write image-generation prompts for ORIGINAL creature ARTWORK ONLY for Vault Quest. The prompt must describe artwork only — NEVER a card layout, frame, border, text, logo, stat box, or any symbol. Explicitly forbid copying famous franchise styles or characters. The image must have a clean or transparent background suitable for dropping into a fixed art window. Reply with STRICT JSON only.`,
    user: `Card context: ${ctxLine(ctx)}.\nWrite one detailed artwork prompt for ${modeInstr[mode] ?? modeInstr.main}. Include: creature name, family, element, stage, personality, pose, background, colour palette, art direction. End with: "original character, no text, no card layout, no logos, artwork only, clean/transparent background". \nReturn JSON: {"suggestions":[{"text":"the full prompt","reason":"short note"}]}`,
    maxTokens: 800,
    extract: (p) => ((p as { suggestions?: { text?: string; reason?: string }[] }).suggestions ?? [])
      .filter((s) => s?.text)
      .map((s) => ({ text: String(s.text), reason: s.reason, fields: { prompt: String(s.text) } })),
  };
}

function specFor(kind: GenKind, ctx: CardContext, mode: string, n: number): PromptSpec {
  switch (kind) {
    case "name": return nameSpec(ctx, mode, n);
    case "family-names": return familyNamesSpec(ctx, n);
    case "gameplay": return gameplaySpec(ctx, mode);
    case "flavour": return flavourSpec(ctx, mode, n);
    case "artwork-prompt": return artworkSpec(ctx, mode);
  }
}

export async function runGenerator(kind: GenKind, mode: string, ctx: CardContext, n = 6): Promise<GenResult> {
  const provider = getTextProvider();
  if (!provider) {
    return { suggestions: [], provider: "none", model: "none", promptSummary: "", dropped: 0, note: "Provider not connected — set ANTHROPIC_API_KEY." };
  }
  const spec = specFor(kind, ctx, mode, Math.max(1, Math.min(n, 10)));

  // Guard only admin-entered card context before spending a token. The trusted
  // system prompt intentionally contains negative examples ("never use ..."),
  // which must not trip the user-input guard.
  const inGuard = guardInput(JSON.stringify(ctx));
  if (!inGuard.ok) {
    return { suggestions: [], provider: provider.id, model: provider.model, promptSummary: spec.user, dropped: 0, note: `Blocked: ${inGuard.violations.join("; ")}` };
  }

  const raw = await provider.complete(spec.system, spec.user, spec.maxTokens);
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch {
    return { suggestions: [], provider: provider.id, model: provider.model, promptSummary: spec.user, dropped: 0, note: "AI returned malformed output — try Regenerate." };
  }

  const rawSuggestions = spec.extract(parsed);
  const kept: Suggestion[] = [];
  let dropped = 0;
  for (const s of rawSuggestions) {
    const screenText = [s.text, s.reason, JSON.stringify(s.fields ?? {})].join(" ");
    const g = guardOutput(kind, screenText);
    if (g.hard.length) { dropped++; continue; } // never show IP / banned-term / layout violations
    const soft = [s.warning, ...g.soft].filter(Boolean).join("; ");
    kept.push({ ...s, warning: soft || undefined });
  }

  return {
    suggestions: kept,
    provider: provider.id,
    model: provider.model,
    promptSummary: spec.user,
    dropped,
    note: kept.length === 0 ? (dropped > 0 ? "All suggestions failed guardrails — try Regenerate." : "No suggestions returned.") : undefined,
  };
}
