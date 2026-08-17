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

test("FIX MISSING IMAGES is a fourth PRIMARY action, not a diagnostics link", () => {
  /*
   * Recovering a card that is missing a side is normal shop work: it happens when a scan fails or
   * a station drops mid-card, which is exactly when an operator should not be hunting inside a
   * collapsed technical panel. It lived in Service & Diagnostics as a plain `.btn`.
   */
  const html = fs.readFileSync(path.join(APP_ROOT, "renderer", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(APP_ROOT, "renderer", "app.js"), "utf8");

  const grid = html.slice(html.indexOf('class="action-grid"'), html.indexOf("</div>", html.indexOf('class="action-grid"')));
  assert.ok(grid.includes('id="fixMissingImagesBtn"'), "FIX MISSING IMAGES must sit in the primary action grid");
  assert.ok(grid.includes("capture-primary"), "it must share the primary sizing of its siblings");

  // All four primary actions present, in one grid.
  for (const id of ["newCardBtn", "positioningPreviewBtn", "scanCardBtn", "fixMissingImagesBtn"]) {
    assert.ok(grid.includes(`id="${id}"`), `${id} must be one of the four primary actions`);
  }

  // The old diagnostics button is gone, and the handler is retargeted rather than duplicated.
  assert.ok(!html.includes('id="orphansBtn"'), "the diagnostics duplicate must be removed");
  assert.ok(app.includes('document.getElementById("fixMissingImagesBtn")'), "handler must bind the new id");

  // Not styled as destructive.
  assert.ok(!/id="fixMissingImagesBtn"[^>]*danger/.test(grid), "recovery is not a destructive action");
});

test("a refused capture-window save is visually distinct from a successful one", () => {
  const app = fs.readFileSync(path.join(APP_ROOT, "renderer", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(APP_ROOT, "renderer", "styles.css"), "utf8");
  // The success path sets the attribute via a ternary, so match the states rather than a literal call.
  assert.match(app, /setAttribute\("data-state", "refused"\)/, "a refusal must mark itself");
  assert.match(app, /"saved" : "refused"/, "a success must mark itself distinctly from a refusal");
  assert.match(css, /\[data-state="refused"\][\s\S]{0,80}color:\s*#b3261e/, "refusal must not render as ordinary grey text");
});
