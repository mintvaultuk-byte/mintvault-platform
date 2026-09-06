/**
 * Incident-specific Canon LiDE 400 geometry repair for mintvault-v2 STAGING.
 *
 * DRY-RUN BY DEFAULT. This command accepts no station, tenant, account, hardware,
 * calibration or coordinate arguments. `--apply` appends the one proved 0,0
 * calibration and repoints the exact station. `--rollback` is available only
 * while every forward/rollback provenance and quiescence check still matches.
 */
import { runApprovedStagingCanonGeometryRepair } from "../../server/partner/staging-canon-geometry-repair";

async function main(): Promise<void> {
  const known = new Set(["--apply", "--rollback"]);
  const unknown = process.argv.slice(2).filter((arg) => !known.has(arg));
  if (unknown.length > 0 || (process.argv.includes("--apply") && process.argv.includes("--rollback"))) {
    throw new Error("Usage: repair-canon-lide400-geometry.cjs [--apply | --rollback]");
  }
  const mode = process.argv.includes("--apply")
    ? "apply"
    : process.argv.includes("--rollback")
      ? "rollback"
      : "inspect";
  const result = await runApprovedStagingCanonGeometryRepair(mode);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (mode === "inspect") {
    process.stdout.write("DRY-RUN complete — nothing was written.\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
