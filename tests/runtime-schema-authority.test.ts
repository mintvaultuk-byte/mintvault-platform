import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listMigrationFiles } from "../scripts/db/migrate";

const ROOT = join(import.meta.dirname, "..");
const SERVER = join(ROOT, "server");
const DDL =
  /\b(?:ALTER\s+(?:TABLE|TYPE|INDEX|VIEW)|CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|TYPE|INDEX|SCHEMA|TRIGGER|FUNCTION|VIEW|MATERIALIZED\s+VIEW|EXTENSION|POLICY)|DROP\s+(?:TABLE|TYPE|INDEX|SCHEMA|TRIGGER|FUNCTION|VIEW|MATERIALIZED\s+VIEW|POLICY))\b/i;

const RETIRED_RUNTIME_SCHEMA_WRITERS = new Set([
  "recordLabelArtworkV424Audit",
  "migrateServiceTiersV213",
  "addRevealWrapColumn",
  "seedEstimateCreditsTable",
  "seedAdminCredits",
  "createAiGradeCorrectionsTable",
  "createAiOverrideAuditTable",
  "createEstimateFreeUsesTable",
  "createEbayPriceCacheTable",
  "seedTierCapacityTable",
  "migratePromotionsSchema",
  "migratePaymentIdempotencySchema",
  "migrateGraderSchema",
  "migrateGraderCertSchema",
  "migratePerOperatorSchema",
  "migrateStaffCapabilitiesSchema",
  "migrateScanSchema",
  "migrateAccountSchema",
  "migrateMarketplaceSchema",
  "ensurePerfIndexes",
  "ensureCertDurabilitySchema",
  "ensureImageEvidenceSchema",
  "ensureScannerCaptureSchema",
  "backfillReferenceNumbers",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

function parsed(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function namedFunctionBody(path: string, name: string): string {
  const file = parsed(path);
  let body: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) body = node.body.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (body === null) throw new Error(`Could not find function ${name} in ${relative(ROOT, path)}`);
  return body;
}

describe("numbered migrations are the only reachable schema authority", () => {
  it("discovers the convergence migration through the shipped runner", () => {
    const migration = listMigrationFiles().find(
      (candidate) => candidate.filename === "0115_runtime_schema_convergence.sql"
    );
    expect(migration).toBeDefined();
    expect(migration?.sql).toMatch(/archived_to_b2_at/);
    expect(migration?.sql).toMatch(/centering_outer_front/);
    expect(migration?.sql).toMatch(/stripe_webhook_events/);
    expect(migration?.sql).toMatch(/marketplace_listings/);
    expect(migration?.sql).toMatch(/reference_number_backfill/);
  });

  it("does not call any retired schema writer or boot-time reference backfill", () => {
    const calls: string[] = [];
    for (const path of sourceFiles(SERVER)) {
      const file = parsed(path);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          if (RETIRED_RUNTIME_SCHEMA_WRITERS.has(node.expression.text)) {
            calls.push(`${relative(ROOT, path)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(calls).toEqual([]);
  }, 30_000);

  it("keeps application registration and the stolen route registrar DDL-free", () => {
    expect(namedFunctionBody(join(SERVER, "routes.ts"), "registerRoutes")).not.toMatch(DDL);
    const stolen = readFileSync(join(SERVER, "routes", "stolen.ts"), "utf8");
    expect(namedFunctionBody(join(SERVER, "routes", "stolen.ts"), "registerStolenRoutes")).not.toMatch(DDL);
    expect(stolen).toMatch(/export function registerStolenRoutes\(app: Express\): void/);
  }, 30_000);

  it("contains no executable schema-DDL string anywhere under server", () => {
    const violations: string[] = [];
    for (const path of sourceFiles(SERVER)) {
      const file = parsed(path);
      const visit = (node: ts.Node): void => {
        if (
          (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
          DDL.test(node.getText(file))
        ) {
          violations.push(
            `${relative(ROOT, path)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(violations).toEqual([]);
  }, 30_000);

  it("rejects direct schema DDL inside every Express route callback", () => {
    const violations: string[] = [];
    const routeMethods = new Set(["all", "delete", "get", "head", "options", "patch", "post", "put"]);
    for (const path of sourceFiles(SERVER)) {
      const file = parsed(path);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          routeMethods.has(node.expression.name.text)
        ) {
          for (const argument of node.arguments) {
            if (
              (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
              DDL.test(argument.getText(file))
            ) {
              violations.push(
                `${relative(ROOT, path)}:${file.getLineAndCharacterOfPosition(argument.getStart(file)).line + 1}`
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(violations).toEqual([]);
  }, 30_000);
});
