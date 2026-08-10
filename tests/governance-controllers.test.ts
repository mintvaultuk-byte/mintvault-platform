/**
 * governance-controllers.test.ts — the two permanent controllers must stay loadable.
 *
 * ── WHY THIS IS A TEST AND NOT A README LINE ────────────────────────────────────────────────
 * Governance that lives only in prose is governance that survives exactly until someone tidies a
 * file. Both controllers are installed as POINTERS from the agent entry points to canonical
 * documents, so there are three independent ways to silently lose them: delete a canonical file,
 * delete a pointer, or rename one so the link dangles. None of those breaks a build on its own.
 *
 * This suite makes each of them RED.
 *
 * It also pins the PRECEDENCE sentence. The controllers instruct an agent to keep going and to
 * stop asking — which is exactly the shape of instruction that could be mis-read as permission to
 * skip an owner approval. Both documents and both entry points state, in writing, that they never
 * authorise touching protected MVGS maths, deploying, applying migrations to a live host,
 * destructive data operations, force pushes, or skipping an owner approval. If that sentence is
 * ever edited away, the controllers stop being safe and this suite says so.
 *
 * Deliberately NOT asserted: the full prose of either controller. Pinning wording would make every
 * clarifying edit a test failure, and would train people to update the pin without reading. What
 * is pinned is the LOAD PATH and the SAFETY CARVE-OUT — the two things whose absence changes what
 * an agent is allowed to do.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const exists = (p: string) => existsSync(join(process.cwd(), p));

const GRAPH = "docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md";
const NOBS = "docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md";
/** Every entry point an agent may start from. Add one here when a new agent joins the repo. */
const ENTRY_POINTS = ["CLAUDE.md", "AGENTS.md"] as const;

describe("permanent governance controllers", () => {
  it("both canonical controller files exist and are substantive", () => {
    for (const f of [GRAPH, NOBS]) {
      expect(exists(f), `${f} is missing — the pointers in the entry points now dangle`).toBe(true);
      // A stub would satisfy `existsSync` while carrying no governance at all.
      expect(read(f).length, `${f} is too short to be the real controller`).toBeGreaterThan(2000);
    }
  });

  it.each(ENTRY_POINTS)("%s loads BOTH controllers by their canonical path", (entry) => {
    const s = read(entry);
    expect(s, `${entry} does not reference ${GRAPH}`).toContain(GRAPH);
    expect(s, `${entry} does not reference ${NOBS}`).toContain(NOBS);
  });

  it.each(ENTRY_POINTS)("%s puts the controllers NEAR THE TOP, where they will be read", (entry) => {
    // A pointer buried at line 600 of a long instruction file is a pointer an agent may never
    // reach before it starts work. Both must appear in the opening section.
    const head = read(entry).split("\n").slice(0, 60).join("\n");
    expect(head, `${entry}: the GRAPH controller is not in the first 60 lines`).toContain(GRAPH);
    expect(head, `${entry}: the NO-BULLSHIT controller is not in the first 60 lines`).toContain(NOBS);
  });

  it("there is exactly ONE canonical copy of each controller — no divergent duplicates", () => {
    // The entry points must POINT at the canonical files, never restate them. Two copies drift,
    // and then two agents work to two different standards on the same branch.
    for (const entry of ENTRY_POINTS) {
      const s = read(entry);
      expect(
        s.includes("## CORE MODEL") && s.includes("## THE REQUIRED LOOPS"),
        `${entry} appears to inline the GRAPH controller rather than link it`,
      ).toBe(false);
      expect(
        s.includes("## THE ONLY VALID STOP CONDITIONS"),
        `${entry} appears to inline the NO-BULLSHIT controller rather than link it`,
      ).toBe(false);
    }
  });

  /**
   * THE SAFETY CARVE-OUT. This is the assertion that matters most: it is what stops a controller
   * telling an agent "do not stop, keep going" from being read as authorisation.
   */
  it.each([GRAPH, NOBS, ...ENTRY_POINTS])("%s states that the controllers authorise nothing dangerous", (f) => {
    const s = read(f).toLowerCase();
    for (const phrase of ["protected mvgs maths", "force push", "owner approval"]) {
      expect(s, `${f} no longer states the carve-out for "${phrase}"`).toContain(phrase);
    }
    // And the precedence direction must be explicit, not merely implied.
    expect(
      /authoritative/.test(s) && /(supplement|does not replace|never overrides|win any conflict)/.test(s),
      `${f} no longer states that the existing governance remains authoritative`,
    ).toBe(true);
  });

  it("the pre-existing Golden Rules and protected-grading governance are still present", () => {
    const claude = read("CLAUDE.md");
    // Installing controllers must never be the change that quietly removes what was already there.
    expect(claude).toContain("GOLDEN RULES");
    expect(claude).toMatch(/Never run destructive database commands/i);
    expect(claude).toMatch(/Never change the grading system logic/i);
    expect(claude).toMatch(/Never modify the Stripe webhook or payment flow/i);
    expect(claude).toMatch(/Never push to production or deploy/i);
    const agents = read("AGENTS.md");
    expect(agents).toMatch(/protected MVGS grading maths/i);
    expect(agents).toMatch(/Never.*deploy to production or staging/i);
  });

  it("the GRAPH controller carries its eight loops and its ground-truth order", () => {
    const s = read(GRAPH);
    for (const loop of [
      "BUILD LOOP",
      "BEHAVIOURAL VERIFICATION LOOP",
      "MUTATION / ADVERSARIAL LOOP",
      "HELD-OUT EVALUATION LOOP",
      "DRIFT LOOP",
      "RELEASE / CANARY LOOP",
      "ROLLBACK / CONTAINMENT LOOP",
      "OWNER / GROUND-TRUTH LOOP",
    ]) {
      expect(s, `the GRAPH controller lost its ${loop}`).toContain(loop);
    }
    // The single sentence the whole document exists for.
    expect(s).toMatch(/No single self-improvement or review loop may certify itself/i);
    // And the anti-Goodhart anchor that keeps a metric honest.
    expect(s).toMatch(/GROUND-TRUTH ORDER/);
    expect(s).toMatch(/Never make production conform to an invented test schema/i);
  });
});
