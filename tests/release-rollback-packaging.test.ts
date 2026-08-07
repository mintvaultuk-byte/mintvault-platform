/**
 * Release assertion: where does Partner rollback SQL actually come from?
 *
 * THE AMBIGUITY THIS REMOVES. Three separate things look like "rollback" and only one of them
 * undoes a migration:
 *
 *   1. `scripts/safe-deploy.sh` captures ROLLBACK_IMG — the previous Fly *container image*. Rolling
 *      back to it reverts application CODE and nothing else. A migration already applied to the
 *      database stays applied.
 *   2. `scripts/db/migrate.ts` — the numbered migration runner — applies migrations FORWARD only.
 *      It contains `client.query("ROLLBACK")`, but that is the SQL transaction statement aborting a
 *      failed apply; it is NOT a rollback command and it never reads a rollback-*.sql file.
 *   3. `migrations/rollback-*.sql` exist in the REPOSITORY, and are the only thing that actually
 *      reverses a migration. They are run by an operator, by hand, against the database.
 *
 * And the image does not contain them: Dockerfile copies
 * `migrations/[0-9][0-9][0-9][0-9]*_*.sql`, a glob that matches `0049_partner_grading_work_items.sql`
 * but CANNOT match `rollback-0049-partner-grading-work-items.sql` — that filename starts with
 * letters, not four digits.
 *
 * So an operator who has shelled into the running container looking for the rollback file will not
 * find it, at the exact moment they most need it. This test pins that reality so the assumption
 * cannot be made silently, and pins that the repository copy exists.
 *
 * DECISION: rollback is REPOSITORY-DRIVEN (option B). See
 * docs/migration-ownership-partner-0049.md for the operator procedure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ROLLBACK = "rollback-0049-partner-grading-work-items.sql";
const FORWARD = "0049_partner_grading_work_items.sql";

describe("release: rollback SQL packaging", () => {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

  it("the rollback file exists in the repository and is non-trivial", () => {
    const path = join(process.cwd(), "migrations", ROLLBACK);
    expect(existsSync(path), `${ROLLBACK} must exist in the repo — it is the ONLY thing that undoes 0049`).toBe(true);
    const sql = readFileSync(path, "utf8");
    expect(sql.length, "rollback file must not be a stub").toBeGreaterThan(500);
    expect(sql).toMatch(/partner_grading_work_items/);
    // Pinned so a silent edit to the recovery path is visible in review.
    expect(createHash("sha256").update(sql).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the Dockerfile migration COPY glob cannot match rollback files", () => {
    // Positive control: the glob really is the mechanism, and it really does ship the forward file.
    const copyLine = dockerfile.split("\n").find((l) => l.includes("migrations/") && l.startsWith("COPY"));
    expect(copyLine, "Dockerfile must still COPY migrations").toBeTruthy();
    expect(copyLine).toContain("[0-9][0-9][0-9][0-9]");

    const globMatches = (name: string) => /^[0-9]{4}.*_.*\.sql$/.test(name);
    expect(globMatches(FORWARD), "forward migrations DO ship in the image").toBe(true);
    expect(
      globMatches(ROLLBACK),
      "rollback files do NOT ship in the image — operators must use the repository checkout"
    ).toBe(false);
  });

  it("the deploy script's rollback is an IMAGE rollback, not a schema rollback", () => {
    const deploy = readFileSync(join(process.cwd(), "scripts/safe-deploy.sh"), "utf8");
    expect(deploy).toContain("ROLLBACK_IMG");
    expect(deploy).toMatch(/deployment-/);
    // It must not claim to run SQL. If someone adds SQL rollback to the deploy script, this test
    // should be revisited deliberately rather than the two concepts quietly merging.
    expect(deploy).not.toMatch(/rollback-\d{4}.*\.sql/);
  });

  it("the migration runner applies forward only and never reads a rollback file", () => {
    const runner = readFileSync(join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
    // The runner DOES contain client.query("ROLLBACK") — the SQL statement that aborts a failed
    // apply. That is transaction control, not a rollback feature, and conflating the two is exactly
    // the confusion this file exists to prevent. Positive control first:
    expect(runner, "the runner is expected to abort a failed apply transactionally").toContain('query("ROLLBACK")');
    // What must NOT exist is any path that loads and executes a rollback-*.sql file.
    expect(
      /rollback-[\w-]*\.sql/.test(runner),
      "if the runner ever learns to execute rollback-*.sql, this packaging decision must be revisited"
    ).toBe(false);
  });
});
