/**
 * FEATURE-FLAG EVIDENCE — behavioural proof.
 *
 * The property under test is a distinction that is easy to lose and expensive to lose: an ABSENT
 * flag and a flag explicitly set to false both mean "off today", but they answer different
 * questions. Absent means nobody decided; false means somebody did. A release checklist needs to
 * know which, so the two must never collapse into one "disabled".
 */
import { describe, it, expect } from "vitest";
import { collectFlagEvidence, TRACKED_FLAGS } from "../server/project-control/flag-evidence";

const EMPTY = {} as NodeJS.ProcessEnv;

describe("flag evidence — absent is not the same as disabled", () => {
  it("an ABSENT flag reports 'absent', and says no decision has been made", () => {
    const pc = collectFlagEvidence(EMPTY).find((f) => f.name === "SUPER_ADMIN_PROJECT_CONTROL_ENABLED")!;
    expect(pc.state).toBe("absent");
    expect(pc.note).toMatch(/not the same as being switched off deliberately/i);
  });

  it("an EXPLICIT false reports 'disabled_explicit', and says somebody decided", () => {
    const env = { SUPER_ADMIN_PROJECT_CONTROL_ENABLED: "false" } as NodeJS.ProcessEnv;
    const pc = collectFlagEvidence(env).find((f) => f.name === "SUPER_ADMIN_PROJECT_CONTROL_ENABLED")!;
    expect(pc.state).toBe("disabled_explicit");
    expect(pc.note).toMatch(/somebody made this decision/i);
  });

  it("the two states are distinguishable — the whole point of the module", () => {
    const absent = collectFlagEvidence(EMPTY).find((f) => f.name === "TRANSFER_FLOW_LIVE")!;
    const off = collectFlagEvidence({ TRANSFER_FLOW_LIVE: "false" } as NodeJS.ProcessEnv).find(
      (f) => f.name === "TRANSFER_FLOW_LIVE"
    )!;
    expect(absent.state).not.toBe(off.state);
  });

  it("an empty string reads as absent, not as configured", () => {
    const f = collectFlagEvidence({ LEGAL_PAGES_LIVE: "   " } as NodeJS.ProcessEnv).find(
      (x) => x.name === "LEGAL_PAGES_LIVE"
    )!;
    expect(f.state).toBe("absent");
  });
});

describe("flag evidence — affirmatives and configured values", () => {
  it("recognises the affirmative vocabulary", () => {
    for (const yes of ["true", "1", "yes", "on", "enabled", "TRUE", " On "]) {
      const f = collectFlagEvidence({ TRANSFER_FLOW_LIVE: yes } as NodeJS.ProcessEnv).find(
        (x) => x.name === "TRANSFER_FLOW_LIVE"
      )!;
      expect(f.state, `"${yes}" should enable`).toBe("enabled");
    }
  });

  it("a credential-shaped variable counts as configured WITHOUT reading its value", () => {
    const secret = "postgres://user:pa55w0rd@host/db";
    const all = collectFlagEvidence({ PARTNER_DATABASE_URL: secret } as NodeJS.ProcessEnv);
    const f = all.find((x) => x.name === "PARTNER_DATABASE_URL")!;

    expect(f.state).toBe("enabled");
    expect(
      JSON.stringify(all),
      "a flag report must never carry the value of the variable it reports on"
    ).not.toContain("pa55w0rd");
    expect(JSON.stringify(all)).not.toContain(secret);
  });
});

describe("flag evidence — the report is complete and bounded", () => {
  it("reports EVERY tracked flag, including the absent ones", () => {
    const evidence = collectFlagEvidence(EMPTY);
    expect(evidence).toHaveLength(TRACKED_FLAGS.length);
    // Omitting absent flags would hide the most operationally interesting state.
    expect(evidence.every((f) => f.state === "absent")).toBe(true);
  });

  it("does NOT enumerate the environment — unrelated secret names must not leak", () => {
    const env = {
      SUPER_ADMIN_PROJECT_CONTROL_ENABLED: "true",
      STRIPE_SECRET_KEY: "sk_live_should_never_be_named",
      R2_SECRET_ACCESS_KEY: "also_secret",
    } as NodeJS.ProcessEnv;

    const text = JSON.stringify(collectFlagEvidence(env));
    expect(text, "scanning process.env would disclose unrelated secret NAMES").not.toContain("STRIPE_SECRET_KEY");
    expect(text).not.toContain("R2_SECRET_ACCESS_KEY");
    expect(text).not.toContain("sk_live_should_never_be_named");
  });

  it("every tracked flag explains what it gates", () => {
    for (const f of collectFlagEvidence(EMPTY)) {
      expect(f.gates.length, `${f.name} has no explanation`).toBeGreaterThan(10);
      expect(f.source).toBe("environment");
    }
  });
});
