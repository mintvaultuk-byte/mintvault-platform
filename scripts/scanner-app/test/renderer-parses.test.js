/*
 * The renderer must PARSE. This is not a style check.
 *
 * WHY THIS EXISTS. Commit ae7d059c shipped `renderer/app.js` with a `const` that redeclared a
 * function parameter (`state`) at line 559. That is a PARSE-time error, not a runtime one: the
 * browser discards the entire <script> before executing a single statement. The window still
 * painted, because index.html's static markup is real HTML — so the app looked alive while every
 * listener, every render function and every IPC subscription was dead. Symptoms were
 * "Checking device…" forever, an empty Service & Diagnostics panel, and no capture-window UI:
 * three unrelated-looking faults from one dead file.
 *
 * It shipped green because 108 tests across six suites all exercise the MAIN process and the
 * server contract. Not one of them loaded the renderer. A test suite that cannot notice its own
 * UI failing to parse is not covering the UI.
 *
 * So: parse every first-party script the Electron app actually loads. This is the cheapest
 * possible gate — no DOM, no Electron, no window — and it would have caught ae7d059c in ~2 ms.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_ROOT = path.resolve(__dirname, "..");

/** Every first-party .js the app ships, excluding dependencies and this test tree. */
function firstPartyScripts(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test") continue;
      firstPartyScripts(full, found);
    } else if (entry.name.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

test("every first-party scanner script parses", () => {
  const scripts = firstPartyScripts(APP_ROOT);
  assert.ok(scripts.length > 0, "found no scripts to check — the walker is broken, not the app");

  const failures = [];
  for (const file of scripts) {
    const source = fs.readFileSync(file, "utf8");
    try {
      // Compile only. Never runs, so a script needing `window` or `require` is still checked.
      new vm.Script(source, { filename: file });
    } catch (error) {
      failures.push(`${path.relative(APP_ROOT, file)}: ${error.message}`);
    }
  }

  assert.deepStrictEqual(failures, [], `scripts failed to parse:\n${failures.join("\n")}`);
});

test("the renderer parses, specifically", () => {
  // Named separately so the failure reads as "the UI is dead", not "some file somewhere".
  const file = path.join(APP_ROOT, "renderer", "app.js");
  const source = fs.readFileSync(file, "utf8");
  assert.doesNotThrow(
    () => new vm.Script(source, { filename: file }),
    "renderer/app.js does not parse — the Scanner window will paint static HTML and do nothing"
  );
});

test("renderer only reads element handles that the els map defines", () => {
  /*
   * The second defect in the same commit: app.js:578 called `place(els.placementOuterBox, …)`,
   * but `placementOuterBox` was the one id present in index.html and absent from the els map.
   * `place()` sets `.hidden` unconditionally, so it threw TypeError on the FIRST placement
   * preview and aborted renderState before the capture-window sync. Latent behind the parse
   * error, and it would have surfaced the moment that was fixed.
   *
   * Parsing cannot catch that. Cross-check the two maps textually instead.
   */
  const appSource = fs.readFileSync(path.join(APP_ROOT, "renderer", "app.js"), "utf8");

  const defined = new Set();
  for (const match of appSource.matchAll(/(\w+):\s*document\.getElementById\("([^"]+)"\)/g)) {
    defined.add(match[1]);
  }
  assert.ok(defined.size > 0, "found no els map entries — the extraction regex is stale");

  const used = new Set();
  for (const match of appSource.matchAll(/\bels\.(\w+)/g)) {
    used.add(match[1]);
  }

  const undeclared = [...used].filter((name) => !defined.has(name)).sort();
  assert.deepStrictEqual(
    undeclared,
    [],
    `els.<name> read but never assigned from getElementById: ${undeclared.join(", ")}`
  );
});
