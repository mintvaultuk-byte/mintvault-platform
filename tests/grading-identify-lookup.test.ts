/**
 * Grading identify / TCGdex lookup robustness.
 *
 * Two production problems:
 *   1. "Identify failed — Failed to fetch": a raw transport error (the request
 *      never reached Express because the server was down). Must become a
 *      structured, actionable message; other failures (auth/provider/invalid/
 *      no-match/server) must be distinguished from a legitimate zero-result.
 *   2. Collector numbers with prefixes/slashes (Hoothoot TG12/TG30, SV114/SV122,
 *      GG44/GG70, RC29/RC32) must be accepted and parsed WITHOUT stripping the
 *      TG/SV/GG/RC/promo prefix.
 *
 * Pure helpers are unit-tested directly; UI wiring is checked by source
 * assertion (the admin form is auth-gated). No provider calls, no DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { classifyLookupError } from "../client/src/lib/lookup-errors";
import { COLLECTOR_NUMBER_RE, parseCollectorNumber } from "../server/services/collector-number";

const FORM = readFileSync(join(process.cwd(), "client/src/components/certificate-form.tsx"), "utf8");

describe("structured, actionable lookup errors (spec 4-5)", () => {
  it("a transport failure (fetch TypeError / 'Failed to fetch') is network — never shown raw", () => {
    const a = classifyLookupError({ thrown: new TypeError("Failed to fetch") });
    expect(a.kind).toBe("network");
    expect(a.message).not.toBe("Failed to fetch");
    expect(a.message.toLowerCase()).toMatch(/server|connection|reach/);
    expect(a.message.toLowerCase()).toContain("manually"); // manual fallback advertised
    // Also matches non-TypeError network strings (Firefox/Safari wording).
    expect(classifyLookupError({ thrown: new Error("NetworkError when attempting to fetch resource") }).kind).toBe("network");
    expect(classifyLookupError({ thrown: new Error("Load failed") }).kind).toBe("network");
  });
  it("HTTP statuses map to distinct, actionable kinds", () => {
    expect(classifyLookupError({ status: 401 }).kind).toBe("auth");
    expect(classifyLookupError({ status: 403 }).kind).toBe("auth");
    expect(classifyLookupError({ status: 503 }).kind).toBe("provider");
    expect(classifyLookupError({ status: 400, body: { error: "Invalid card number format" } }).kind).toBe("invalid");
    expect(classifyLookupError({ status: 404 }).kind).toBe("not_found");
    expect(classifyLookupError({ status: 500 }).kind).toBe("server");
    expect(classifyLookupError({ status: 502 }).kind).toBe("server");
  });
  it("a provider/invalid message can carry the server's specific reason", () => {
    expect(classifyLookupError({ status: 400, body: { error: "Invalid set code format" } }).message).toContain("Invalid set code format");
    expect(classifyLookupError({ status: 503, body: { error: "Card lookup is disabled" } }).message).toContain("disabled");
  });
});

describe("collector numbers keep prefixes & slashes (spec: TG/SV/GG/RC)", () => {
  it("the accepted-format regex allows prefixed / slashed / long / promo numbers", () => {
    for (const n of ["TG12/TG30", "SV114/SV122", "GG44/GG70", "RC29/RC32", "001/198", "037/091", "4/102", "SWSH284", "SVP-114", "SV107"]) {
      expect(COLLECTOR_NUMBER_RE.test(n), n).toBe(true);
    }
    // still rejects junk / over-length / whitespace / separators that could break URLs.
    for (const bad of ["", "A".repeat(17), "12 34", "a;b", "<script>", "1,2"]) {
      expect(COLLECTOR_NUMBER_RE.test(bad), bad).toBe(false);
    }
  });
  it("Hoothoot TG12/TG30 parses with the TG prefix KEPT and total 30", () => {
    expect(parseCollectorNumber("TG12/TG30")).toEqual({ localKey: "TG12", total: 30 });
  });
  it("other prefixed subsets parse without stripping the prefix", () => {
    expect(parseCollectorNumber("SV114/SV122")).toEqual({ localKey: "SV114", total: 122 });
    expect(parseCollectorNumber("GG44/GG70")).toEqual({ localKey: "GG44", total: 70 });
    expect(parseCollectorNumber("RC29/RC32")).toEqual({ localKey: "RC29", total: 32 });
    // prefixes are never dropped
    for (const key of ["TG12", "SV114", "GG44", "RC29"]) {
      expect(parseCollectorNumber(`${key}/X`).localKey).toBe(key);
    }
  });
  it("plain numbers still work: leading zeros ignored for matching, total parsed", () => {
    expect(parseCollectorNumber("037/091")).toEqual({ localKey: "37", total: 91 });
    expect(parseCollectorNumber("4/102")).toEqual({ localKey: "4", total: 102 });
    expect(parseCollectorNumber("SV107")).toEqual({ localKey: "SV107", total: null }); // no total segment
  });
});

describe("runIdentify surfaces classified errors, not raw 'Failed to fetch' (spec 1,4,5,8)", () => {
  it("transport + non-2xx are routed through classifyLookupError", () => {
    const fn = FORM.slice(FORM.indexOf("async function runIdentify"), FORM.indexOf("async function runTcgdexPrefill"));
    expect(fn).toContain("classifyLookupError({ thrown: netErr })"); // fetch() rejection = transport
    expect(fn).toContain("classifyLookupError({ status: res.status, body: data })"); // non-2xx
    // the old raw pattern is gone.
    expect(fn).not.toContain('throw new Error(data.error || "Identify failed")');
    expect(fn).not.toContain('description: e.message'); // no raw browser message in the toast
  });
  it("a genuine zero-result is a distinct, non-error path (not a transport failure)", () => {
    const fn = FORM.slice(FORM.indexOf("async function runIdentify"), FORM.indexOf("async function runTcgdexPrefill"));
    expect(fn).toContain("No confident match");
    expect(fn).toContain("setIdentifyResult(null)");
  });
});

describe("existing vs proposed vs accepted — stale data never shown as a result (spec 7,9,10)", () => {
  it("the panel result summary renders the PROPOSED result, not raw form values", () => {
    // The verify chips come from identifyResult (the proposal), gated on it.
    expect(FORM).toMatch(/\{identifyResult \?/);
    const summary = FORM.slice(FORM.indexOf('data-testid="ai-identify-summary"'), FORM.indexOf('data-testid="ai-existing-details"'));
    expect(summary).toContain("identifyResult.name");
    expect(summary).toContain("Proposed");
  });
  it("existing certificate details are shown separately and clearly labelled (not as a new result)", () => {
    expect(FORM).toContain('data-testid="ai-existing-details"');
    expect(FORM).toContain("Existing certificate details");
    expect(FORM).toContain("not a new result");
  });
  it("Accept is the ONLY place a proposed result overwrites populated fields", () => {
    const accept = FORM.slice(FORM.indexOf('data-testid="button-accept-identify"') - 1600, FORM.indexOf('data-testid="button-accept-identify"'));
    expect(accept).toContain("if (identifyResult)");
    expect(accept).toContain("cardName: identifyResult.name");
    // identify itself only fills blanks (never clobbers) — no unconditional overwrite.
    const fn = FORM.slice(FORM.indexOf("async function runIdentify"), FORM.indexOf("async function runTcgdexPrefill"));
    expect(fn).toContain("Fill BLANK fields only");
    expect(fn).not.toMatch(/const overwrite = /);
  });
});

describe("TCG search distinguishes provider failure from zero-result; manual fallback preserved", () => {
  it("search sets a structured tcgError and shows it distinctly from 'No cards found'", () => {
    expect(FORM).toContain("setTcgError(");
    expect(FORM).toContain('data-testid="tcg-search-error"');
    // a legitimate empty result set is NOT flagged as an error.
    expect(FORM).toContain("an empty list here is a real zero-result, not an error");
  });
  it("manual entry remains available regardless of provider state", () => {
    expect(FORM).toContain('data-testid="manual-card-editor"');
    expect(FORM).toContain('"Hide manual" : "Manual"');
    expect(FORM).toContain("const showManualEditor = manualMode");
  });
});

describe("protected Stage-3 / grading / schema / migration untouched", () => {
  const PROTECTED =
    /components\/grading\/|mvgs|scoring|centering|pristine|defect|grader\.ts|grading-prompt|labels\.ts|certificate-document|cert-id|shared\/schema\.ts|^migrations\//;
  // Non-protected files this branch (layout fix + identify fix) legitimately touches.
  const ALLOWED = new Set([
    "client/src/components/grading-workflow/CardPreviewPanel.tsx",
    "client/src/components/certificate-form.tsx",
    "client/src/components/admin/admin-shell.tsx",
    "client/src/pages/admin-dashboard.tsx",
    "client/src/lib/lookup-errors.ts",
    "server/routes/admin-config.ts",
    "server/services/tcgdex-set-resolve.ts",
    "server/services/collector-number.ts",
    "server/vite.ts",
  ]);
  const base = ["origin/main", "main"].find((r) => {
    try {
      execSync(`git rev-parse --verify ${r}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
  const changed = base
    ? execSync(`git diff --name-only ${base}...HEAD`, { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    : [];

  it("no protected grading/schema/migration file changed", () => {
    if (!base) return;
    for (const f of changed) expect(f, f).not.toMatch(PROTECTED);
  });
  it("every non-test change is a known non-protected file (no server/routes.ts, storage, etc.)", () => {
    if (!base) return;
    for (const f of changed.filter((f) => !f.startsWith("tests/"))) {
      expect(ALLOWED.has(f), `unexpected file: ${f}`).toBe(true);
    }
  });
});
