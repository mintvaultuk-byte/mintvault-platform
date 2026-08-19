/*
 * Fast smoke proof for the owner-independent scanner control-plane load simulator. The full pass is
 * run explicitly with 5k/10k workflows and a 20k burst; this test keeps the simulator itself pinned
 * in the ordinary scanner suite.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("control-plane load simulator passes a deterministic overlap/retry/stale-preview smoke run", () => {
  const script = path.join(__dirname, "..", "scripts", "control-plane-load-sim.js");
  const result = spawnSync(process.execPath, [
    script,
    "--workflows=250",
    "--burst=500",
    "--zero-credit-attempts=25",
    "--seed=42",
  ], { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SCANNER_CONTROL_PLANE_LOAD_SIM PASS/);
  assert.match(result.stdout, /workflows=250\/250/);
  assert.match(result.stdout, /burst_events=500\/500/);
});
