/*
 * Fast smoke proof for the owner-independent payment/top-up load simulator. The full acceptance
 * pass runs 5k/10k/20k payment workflows with a 20k hostile/replay burst; this keeps the simulator
 * itself pinned in the ordinary scanner suite.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("payment credit load simulator passes deterministic zero-credit/top-up and hostile webhook smoke", () => {
  const script = path.join(__dirname, "..", "scripts", "payment-credit-load-sim.js");
  const result = spawnSync(
    process.execPath,
    [script, "--workflows=300", "--burst=700", "--zero-credit-attempts=30", "--seed=77"],
    { encoding: "utf8" }
  );
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PAYMENT_CREDIT_LOAD_SIM PASS/);
  assert.match(result.stdout, /workflows=300\/300/);
  assert.match(result.stdout, /burst_events=700\/700/);
  assert.match(result.stdout, /new_before_topup_rejected=300/);
  assert.match(result.stdout, /new_after_topup_accepted=300/);
});
