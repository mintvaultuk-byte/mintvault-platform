/**
 * CLI shim so safe-deploy.sh can use the tested decision table in live-ancestry.ts.
 *
 * The real git/network calls live HERE and nowhere else; the decision itself is a
 * pure function so it can be exhaustively tested. Exit 0 = allow, 1 = block.
 *
 *   tsx scripts/deploy/check-live-ancestry.ts \
 *     --live <sha|-> --candidate <sha> --target prod [--reconciled-from <sha>] [--allow-unknown-live]
 */
import { execFileSync } from "node:child_process";
import { evaluateLiveAncestry, type DeployTarget } from "./live-ancestry";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** `-` (or empty) is how the shell tells us /api/version could not be read. */
const rawLive = arg("live");
const liveSha = !rawLive || rawLive === "-" ? null : rawLive;
const candidateSha = arg("candidate");
const target = (arg("target") ?? "prod") as DeployTarget;

if (!candidateSha) {
  console.error("check-live-ancestry: --candidate is required");
  process.exit(2);
}

const verdict = evaluateLiveAncestry({
  liveSha,
  candidateSha,
  target,
  reconciledFrom: arg("reconciled-from"),
  allowUnknownLive: has("allow-unknown-live"),
  isAncestor: (ancestor, descendant) => {
    try {
      // Exit 0 = is an ancestor, 1 = is not. Anything else (unknown object) throws
      // and is treated as "not an ancestor", which fails CLOSED: an unresolvable
      // live SHA must never be allowed to look like a contained one.
      execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
});

if (verdict.ok) {
  console.log(`✔ LIVE-ANCESTRY [${verdict.code}]: ${verdict.message}`);
  process.exit(0);
}
console.error(`🚫 BLOCKED [${verdict.code}]\n   ${verdict.message}`);
process.exit(1);
