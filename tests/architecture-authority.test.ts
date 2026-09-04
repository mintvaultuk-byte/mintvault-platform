import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  COMPONENT_READINESS_MANIFESTS,
  COMPONENT_READINESS_REGISTRY,
  compileComponentReadinessRegistry,
  isComponentAvailable,
} from "../server/lib/component-readiness-registry";
import {
  REQUIRED_PRODUCTION_ENVIRONMENT,
  REQUIRED_RELEASE_MIGRATIONS,
  REQUIRED_RELEASE_RELATIONS,
  REQUIRED_RELEASE_TRIGGER_RELATIONS,
  REQUIRED_RELEASE_TRIGGERS,
} from "../server/readiness";

const write = (root: string, path: string, source: string) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
};

async function architectureModule() {
  return import("../scripts/architecture/check-architecture.mjs");
}

const miniaturePolicy = {
  schemaVersion: 2,
  snapshot: "snapshot.json",
  componentIndex: "config/components/index.ts",
  legacyAuthority: "legacy-authority.json",
  applicationRoots: [{ file: "server/routes.ts", context: "<module>", receiver: "app" }],
  componentAuthorities: [{ id: "core", owner: "core-owner", sourceRoots: ["server/child.ts"] }],
  scanRoots: ["server", "client/src", "shared", "migrations", "config/components"],
  ownerRules: [
    { prefix: "server/routes.ts", owner: "server-owner" },
    { prefix: "server/lib/component-readiness-registry.ts", owner: "component-owner" },
    { prefix: "server/readiness.ts", owner: "component-owner" },
    { prefix: "client/src/App.tsx", owner: "client-owner" },
    { prefix: "shared/schema.ts", owner: "shared-owner" },
    { prefix: "migrations/", owner: "migration-owner" },
    { prefix: "config/components/", owner: "component-owner" },
  ],
  forbiddenRuntimeImports: [
    { fromPrefix: "shared/", toPrefix: "server/" },
    { fromPrefix: "client/src/", toPrefix: "server/" },
    { fromPrefix: "server/leaf/", toExact: "server/routes" },
  ],
  runtimeImportExceptions: [] as Array<{ source: string; target: string; kind: string; finding: string }>,
};

const manifest = (migration = "0001_core.sql", extra = "") =>
  `export const CORE={schemaVersion:1,id:"core",owner:"core-owner",releaseMode:"required",` +
  `runtimeState:"enabled",sourceRoots:["server/child.ts"],requirements:{migrations:[{name:"${migration}",order:0}],` +
  `relations:[],triggers:[],environment:[],runtimeSignals:[]}${extra}} as const;\n`;

function goldenWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "mintvault-architecture-"));
  write(
    root,
    "server/routes.ts",
    'import express from "express"; import { childRouter } from "./child"; const app=express(); app.use("/api", childRouter());\n'
  );
  write(
    root,
    "server/child.ts",
    'import {Router} from "express"; export function childRouter(){const r=Router(); const base="/cards"; r.get(`${base}/:id`, handler); return r;}\n'
  );
  write(
    root,
    "client/src/App.tsx",
    'const Cards=lazy(()=>import("./Cards")); const app=<Route path="/cards" component={Cards}/>;\n'
  );
  write(root, "shared/schema.ts", 'export const cards = pgTable("cards", {});\n');
  write(root, "migrations/0001_core.sql", "CREATE TABLE cards(id integer);\n");
  write(root, "config/components/core.ts", manifest());
  write(
    root,
    "config/components/index.ts",
    'import { CORE } from "./core"; export const COMPONENT_READINESS_MANIFESTS=[CORE];\n'
  );
  write(
    root,
    "server/lib/component-readiness-registry.ts",
    'import { COMPONENT_READINESS_MANIFESTS } from "../../config/components"; function compileComponentReadinessRegistry(x: unknown[]){return x;} export const COMPONENT_READINESS_REGISTRY=compileComponentReadinessRegistry(COMPONENT_READINESS_MANIFESTS);\n'
  );
  write(root, "server/readiness.ts", "export const ready=true;\n");
  return root;
}

describe("component readiness authority", () => {
  it("preserves every legacy readiness projection exactly and in order", () => {
    expect([...REQUIRED_RELEASE_MIGRATIONS]).toEqual([
      "0077_partner_credential_lifecycle_hardening.sql",
      "0088_nfc_binding_integrity.sql",
      "0089_partner_shared_rate_limit_buckets.sql",
      "0090_lineage_convergence_scanner.sql",
      "0114_certificate_identity_authority.sql",
      "0115_runtime_schema_convergence.sql",
      "0116_nfc_physical_lock_integrity.sql",
      "0117_grading_payment_fulfilment_outbox.sql",
      "0118_nfc_lock_intent_reconciliation.sql",
      "0119_session_store_authority.sql",
      "0120_customer_notification_outbox.sql",
      "0121_main_runtime_role_authority.sql",
      "0122_object_write_intent_reconciliation.sql",
      "0022_print_workflow_lifecycle.sql",
    ]);
    expect([...REQUIRED_RELEASE_RELATIONS]).toEqual([
      "public.schema_migrations",
      "public.certificates",
      "public.cert_counter",
      "public.submissions",
      "public.partner_organisations",
      "public.scanner_processing_jobs",
      "public.certificate_image_evidence",
      "public.scanner_capture_sessions",
      "public.scanner_evidence_staging",
      "public.partner_rate_limit_buckets",
      "public.public_rate_limit_buckets",
      "public.estimate_credit_reservations",
      "public.grading_payment_fulfilments",
      "public.session",
      "public.customer_notification_outbox",
      "public.object_write_operations",
      "public.object_write_items",
      "public.print_batches",
      "public.print_events",
      "public.label_prints",
      "public.label_overrides",
      "public.reprint_log",
      "public.audit_log",
    ]);
    expect(REQUIRED_RELEASE_TRIGGERS.map((name, index) => [name, REQUIRED_RELEASE_TRIGGER_RELATIONS[index]])).toEqual([
      ["trg_certificate_number_immutable", "public.certificates"],
      ["trg_cert_counter_identity_guard", "public.cert_counter"],
      ["trg_cert_counter_refuse_truncate", "public.cert_counter"],
      ["trg_nfc_locked_binding_immutable", "public.certificates"],
      ["trg_nfc_lock_intent_guards_binding", "public.certificates"],
      ["trg_object_write_operation_guard", "public.object_write_operations"],
      ["trg_object_write_item_guard", "public.object_write_items"],
    ]);
    expect([...REQUIRED_PRODUCTION_ENVIRONMENT]).toEqual([
      "STRIPE_ENV",
      "STRIPE_SECRET_KEY",
      "STRIPE_PUBLISHABLE_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "SESSION_SECRET",
      "SIGNED_URL_SECRET",
      "APP_URL",
      "R2_ENDPOINT",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_NAME",
      "B2_ENDPOINT",
      "B2_KEY_ID",
      "B2_APPLICATION_KEY",
      "B2_BUCKET",
      "RESEND_API_KEY",
      "RESEND_DOMAIN_VERIFIED",
      "CUSTOMER_NOTIFICATION_ENC_KEY_VERSION",
      "PARTNER_ADMIN_DATABASE_URL",
    ]);
  });

  it("uses one canonical index and keeps disabled components out of runtime and readiness", () => {
    const discovered = readdirSync("config/components")
      .filter((name) => name.endsWith(".ts") && name !== "index.ts")
      .sort();
    expect(COMPONENT_READINESS_MANIFESTS).toHaveLength(discovered.length);
    expect(COMPONENT_READINESS_REGISTRY.runtimeComponentIds).toEqual(COMPONENT_READINESS_REGISTRY.componentIds);
    const disabled = {
      schemaVersion: 1,
      id: "future",
      owner: "future-owner",
      releaseMode: "optional-disabled",
      runtimeState: "disabled",
      sourceRoots: ["server/future/"],
      requirements: {
        migrations: [{ name: "9999_future.sql", order: 0 }],
        relations: [],
        triggers: [],
        environment: [],
        runtimeSignals: [],
      },
    } as const;
    const compiled = compileComponentReadinessRegistry([...COMPONENT_READINESS_MANIFESTS, disabled]);
    expect(compiled.componentIds).not.toContain("future");
    expect(compiled.runtimeComponentIds).not.toContain("future");
    expect(compiled.requiredMigrations).not.toContain("9999_future.sql");
    expect(isComponentAvailable("future")).toBe(false);
  });

  it("fails closed on malformed, duplicate, extra, disabled-enabled, and non-contiguous authority", () => {
    const base = structuredClone(COMPONENT_READINESS_MANIFESTS[0]) as Record<string, unknown>;
    expect(() => compileComponentReadinessRegistry([{ ...base, id: "Bad Id" }])).toThrow(/invalid component id/);
    expect(() => compileComponentReadinessRegistry([base, base])).toThrow(/duplicate component id/);
    expect(() => compileComponentReadinessRegistry([{ ...base, surprise: true }])).toThrow(/keys must be exactly/);
    expect(() =>
      compileComponentReadinessRegistry([{ ...base, releaseMode: "optional-disabled", runtimeState: "enabled" }])
    ).toThrow(/runtime disabled/);
    expect(() =>
      compileComponentReadinessRegistry([{ ...base, releaseMode: "required", runtimeState: "disabled" }])
    ).toThrow(/runtime enabled/);
    const gap = structuredClone(COMPONENT_READINESS_MANIFESTS) as unknown as Array<Record<string, unknown>>;
    const requirements = gap[0].requirements as { migrations: Array<{ order: number }> };
    requirements.migrations[0].order = 99;
    expect(() => compileComponentReadinessRegistry(gap)).toThrow(/order gap/);
  });
});

describe("architecture topology authority", () => {
  it("matches the reviewed real-repository snapshot and complete authority categories", () => {
    const result = spawnSync(process.execPath, ["scripts/architecture/check-architecture.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const snapshot = JSON.parse(readFileSync("scripts/architecture/generated/architecture-authority.json", "utf8"));
    expect(snapshot.violations).toEqual([]);
    for (const category of [
      "server-route",
      "route-mount",
      "client-route",
      "table",
      "table-access",
      "object-writer",
      "provider-adapter",
      "job",
      "migration",
      "migration-lineage",
      "component",
      "layer-exception",
      "role-authority",
      "session-principal",
      "pricing-authority",
      "timer",
    ])
      expect(snapshot.counts[category]).toBeGreaterThan(0);
    expect(snapshot.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "server-route", effectivePath: "/api/partner/session" }),
        expect.objectContaining({
          category: "client-route",
          id: "/partner/grading",
          component: "PartnerGradingPage",
          wrappers: expect.arrayContaining(["PartnerRouteGuard"]),
          requiredPermissions: ["partner.cards.assess"],
          componentGuardChains: expect.arrayContaining([
            expect.objectContaining({
              component: "PartnerGradingPage",
              guards: expect.arrayContaining([
                expect.objectContaining({
                  component: "PartnerRouteGuard",
                  importTarget: "client/src/components/partner/partner-route-guard.tsx",
                }),
              ]),
            }),
          ]),
        }),
        expect.objectContaining({
          category: "server-route",
          effectivePath: "/api/super-admin/growth/summary",
          actor: "super-admin",
        }),
        expect.objectContaining({ category: "table", id: "public.session" }),
        expect.objectContaining({ category: "object-writer", effect: "direct-put-r2" }),
        expect.objectContaining({
          category: "object-writer",
          id: "DeleteObjectsCommand",
          effect: "bulk-delete-s3",
          source: expect.stringContaining("scripts/upload-share-backgrounds-v2.ts:"),
        }),
        expect.objectContaining({
          category: "object-writer",
          effect: "retention-put-s3",
          source: expect.stringContaining("server/b2.ts:"),
        }),
        expect.objectContaining({
          category: "provider-adapter",
          id: expect.stringContaining("stripe:stripe.accounts.create"),
        }),
        expect.objectContaining({
          category: "provider-adapter",
          id: expect.stringContaining("openai:client.embeddings.create"),
        }),
        expect.objectContaining({
          category: "table-access",
          source: expect.stringContaining("server/lib/public-auth-rate-limit-store-pg.ts:"),
        }),
        expect.objectContaining({
          category: "table-access",
          source: expect.stringContaining("server/jobs/weekly-reel.ts:"),
        }),
        expect.objectContaining({
          category: "table-access",
          source: expect.stringContaining("server/print-workflow.ts:"),
        }),
        expect.objectContaining({
          category: "role-authority",
          id: "role:customer",
          source: expect.stringContaining("shared/schema.ts:"),
        }),
        expect.objectContaining({
          category: "pricing-authority",
          id: expect.stringContaining("£19"),
          source: expect.stringContaining("client/src/data/guides.ts:"),
        }),
        expect.objectContaining({
          category: "session-principal",
          id: 'cache-key:["/api/partner/session"]',
          principalBinding: "principal-not-declared-in-key",
        }),
        expect.objectContaining({
          category: "pricing-authority",
          pricingKind: "currency-bearing-jsx-expression",
          expression: "tier.max_value_gbp.toLocaleString()",
          source: expect.stringContaining("client/src/pages/admin-pricing.tsx:"),
        }),
        expect.objectContaining({
          category: "pricing-authority",
          pricingKind: "currency-bearing-jsx-expression",
          expression: expect.stringContaining("tier.price_per_card"),
          source: expect.stringContaining("client/src/pages/admin-pricing.tsx:"),
        }),
        expect.objectContaining({
          category: "server-route",
          id: "PUT /api/admin/certificates/:id/attach-images",
          delegatedCommands: expect.arrayContaining([
            "server/scan-ingest-service.ts#uploadImagesToCert",
            "server/lib/object-write-coordinator.ts#createPoolTransactionRunner",
          ]),
          providerEffects: expect.arrayContaining(["object-writer:ObjectWriteCoordinator"]),
        }),
        expect.objectContaining({
          category: "server-route",
          id: "POST /api/admin/certificates/:id/reprocess-images",
          delegatedCommands: expect.arrayContaining([
            "server/scan-ingest-service.ts#reprocessCurrentCertificateImages",
          ]),
          providerEffects: expect.arrayContaining(["object-writer:ObjectWriteCoordinator"]),
        }),
        expect.objectContaining({
          category: "server-route",
          id: "GET /api/staff/tcgdex-lookup",
          delegatedCommands: expect.arrayContaining(["server/services/tcgdex.ts#lookupCard"]),
        }),
      ])
    );
    for (const section of [
      "overview",
      "staff",
      "wallet",
      "submissions",
      "quality",
      "devices",
      "corrections",
      "security",
    ]) {
      expect(snapshot.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "server-route",
            id: `GET /api/super-admin/partner-dashboard/partners/:partnerId/${section}`,
            actor: "super-admin",
          }),
        ])
      );
    }
    const projectControlRoutes = snapshot.records.filter(
      (record: { category: string; source: string }) =>
        record.category === "server-route" && record.source.startsWith("server/routes/admin/project-control.ts:")
    );
    expect(projectControlRoutes).toHaveLength(25);
    expect(
      projectControlRoutes.every(
        (record: { actor: string; capabilities: string[] }) =>
          record.actor === "super-admin" && record.capabilities.includes("requireSuperAdmin")
      )
    ).toBe(true);
    const attachImages = snapshot.records.find(
      (record: { category: string; id: string }) =>
        record.category === "server-route" && record.id === "PUT /api/admin/certificates/:id/attach-images"
    );
    expect(attachImages).toBeTruthy();
    const attachMiddleware = (attachImages as { routeLocalMiddleware: string[] }).routeLocalMiddleware;
    expect(attachMiddleware.indexOf("requireAdmin")).toBeLessThan(
      attachMiddleware.findIndex((item) => item.includes("attachImagesUpload"))
    );
    expect(snapshot.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "provider-adapter",
          id: "fetch:https://graph.facebook.com",
          source: expect.stringContaining("server/lib/meta-publisher.ts:"),
          urlAuthority: expect.stringContaining("https://graph.facebook.com/v19.0"),
        }),
      ])
    );
  }, 30_000);

  it("flattens ordinary registrar calls from the real root and rejects uncalled registrars", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    write(root, "server/child.ts", "export const child = true;\n");
    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); function registerA(app){app.get("/a",handler);} function registerB(app){app.get("/b",handler);} registerB(app); registerA(app);\n'
    );
    const snapshot = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(snapshot.violations).toEqual([]);
    const route = (id: string) =>
      snapshot.records.find(
        (record: { category: string; id: string }) => record.category === "server-route" && record.id === id
      );
    expect(route("GET /b")?.registrationOrder).toEqual([0, 0]);
    expect(route("GET /a")?.registrationOrder).toEqual([1, 0]);

    write(
      root,
      "server/routes.ts",
      `${readFileSync(join(root, "server/routes.ts"), "utf8")} function registerDeadRoutes(app){app.get("/never-mounted",handler);}\n`
    );
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNREACHABLE_SERVER_ROUTE" })])
    );

    const deadFactory = goldenWorkspace();
    write(
      deadFactory,
      "server/routes.ts",
      `${readFileSync(join(deadFactory, "server/routes.ts"), "utf8")} function createDead(){const dead=express();dead.get("/dead-factory",handler);}\n`
    );
    expect(buildArchitectureSnapshot(deadFactory, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNREACHABLE_SERVER_ROUTE", target: expect.stringContaining("/dead-factory") }),
      ])
    );

    const parameterizedPath = goldenWorkspace();
    write(parameterizedPath, "server/child.ts", "export const child=true;\n");
    write(
      parameterizedPath,
      "server/routes.ts",
      'import express from "express"; const app=express(); function registerDynamic(app,path){app.get(path,handler);} registerDynamic(app,"/actual");\n'
    );
    const parameterized = buildArchitectureSnapshot(parameterizedPath, miniaturePolicy);
    expect(parameterized.violations).toEqual([]);
    expect(parameterized.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "server-route", id: "GET /actual" })])
    );

    const untypedReceiver = goldenWorkspace();
    write(untypedReceiver, "server/child.ts", 'export function attach(server){server.get("/hidden",handler);}\n');
    write(
      untypedReceiver,
      "server/routes.ts",
      'import express from "express"; import {attach} from "./child"; const app=express(); attach(app);\n'
    );
    const propagated = buildArchitectureSnapshot(untypedReceiver, miniaturePolicy);
    expect(propagated.violations).toEqual([]);
    expect(propagated.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "server-route", id: "GET /hidden" })])
    );
  });

  it("binds protected client leaves to dominating guards and exact guard imports", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    write(root, "client/src/secure.tsx", "export function PartnerRouteGuard(p){return p.children;}\n");
    write(root, "client/src/noop.tsx", "export function PartnerRouteGuard(p){return p.children;}\n");
    write(root, "client/src/Page.tsx", "export default function Page(){return null;}\n");
    write(
      root,
      "client/src/App.tsx",
      'import {PartnerRouteGuard} from "./secure"; import Page from "./Page"; const app=<Route path="/partner/secure"><PartnerRouteGuard requiredPermission="partner.cards.assess"><Page/></PartnerRouteGuard></Route>;\n'
    );
    const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(baseline.violations).toEqual([]);
    expect(baseline.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "client-route",
          id: "/partner/secure",
          componentGuardChains: [
            expect.objectContaining({
              component: "Page",
              guards: [
                expect.objectContaining({
                  component: "PartnerRouteGuard",
                  importTarget: "client/src/secure.tsx",
                }),
              ],
            }),
          ],
        }),
      ])
    );

    write(
      root,
      "client/src/App.tsx",
      'import {PartnerRouteGuard} from "./secure"; import Page from "./Page"; const app=<Route path="/partner/secure"><div><PartnerRouteGuard><span/></PartnerRouteGuard><Page/></div></Route>;\n'
    );
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNGUARDED_PARTNER_CLIENT_ROUTE" })])
    );

    write(
      root,
      "client/src/App.tsx",
      'import {PartnerRouteGuard} from "./noop"; import Page from "./Page"; const app=<Route path="/partner/secure"><PartnerRouteGuard requiredPermission="partner.cards.assess"><Page/></PartnerRouteGuard></Route>;\n'
    );
    const rewired = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(rewired.violations).toEqual([]);
    expect(compareSnapshot(baseline, rewired).ok).toBe(false);
  });

  it("resolves bounded templates and composes reachable router mounts", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const snapshot = buildArchitectureSnapshot(goldenWorkspace(), miniaturePolicy);
    expect(snapshot.violations).toEqual([]);
    expect(snapshot.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "server-route", id: "GET /api/cards/:id", mountChain: expect.any(Array) }),
        expect.objectContaining({
          category: "client-route",
          id: "/cards",
          component: "Cards",
          componentImports: ["./Cards"],
        }),
      ])
    );
  });

  it("records middleware order and propagates application guards into routed actors", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    write(root, "server/child.ts", "export const child=true;\n");
    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); app.use(requireAdmin); app.get("/guarded",handler);\n'
    );
    const guarded = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(guarded.violations).toEqual([]);
    expect(guarded.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "route-middleware", middleware: "requireAdmin" }),
        expect.objectContaining({ category: "server-route", id: "GET /guarded", actor: "admin" }),
      ])
    );
    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); app.get("/guarded",handler); app.use(requireAdmin);\n'
    );
    const moved = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(moved.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "server-route", id: "GET /guarded", actor: "public-or-handler-enforced" }),
      ])
    );
    expect(compareSnapshot(guarded, moved).ok).toBe(false);

    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); const gated=[requireSuperAdmin,readLimit] as const; app.get("/guarded",...gated,handler);\n'
    );
    const spreadGuarded = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(spreadGuarded.violations).toEqual([]);
    expect(spreadGuarded.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "GET /guarded",
          actor: "super-admin",
          capabilities: expect.arrayContaining(["requireSuperAdmin"]),
        }),
      ])
    );
    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); const gated=[requireAdmin,readLimit] as const; app.get("/guarded",...gated,handler);\n'
    );
    expect(compareSnapshot(spreadGuarded, buildArchitectureSnapshot(root, miniaturePolicy)).ok).toBe(false);

    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); app.post("/upload",requireAdmin,upload.single("file"),handler);\n'
    );
    const authBeforeUpload = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(authBeforeUpload.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "POST /upload",
          routeLocalMiddleware: ["requireAdmin", 'upload.single("file")', "handler"],
        }),
      ])
    );
    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); app.post("/upload",upload.single("file"),requireAdmin,handler);\n'
    );
    expect(compareSnapshot(authBeforeUpload, buildArchitectureSnapshot(root, miniaturePolicy)).ok).toBe(false);
  });

  it("resolves root, router, and parameter receiver aliases instead of hiding routes", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    write(root, "server/child.ts", "export const child=true;\n");
    write(
      root,
      "server/routes.ts",
      'import express from "express"; const app=express(); const api=app; const v1=api; v1.post("/hidden",requireAdmin,handler);\n'
    );
    const snapshot = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(snapshot.violations).toEqual([]);
    expect(snapshot.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "server-route", id: "POST /hidden", actor: "admin" }),
      ])
    );
  });

  it("rejects every newly unowned executable surface even if a snapshot is refreshed", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const cases = [
      [
        "server/unowned-route.ts",
        'import express from "express"; const app=express(); app.post("/drift", handler);\n',
        "server-route",
      ],
      ["server/unowned-table.ts", 'const x=pgTable("drift_table",{});\n', "table"],
      ["server/unowned-writer.ts", 'uploadToR2("drift", body);\n', "object-writer"],
      ["server/unowned-job.ts", "scheduleJob(work);\n", "job"],
      ["server/unowned-provider.ts", 'fetch(`${host}/publish`, {method:"POST"});\n', "provider-adapter"],
    ];
    for (const [path, source, category] of cases) {
      const root = goldenWorkspace();
      const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
      write(root, path, source);
      const casePolicy = structuredClone(miniaturePolicy);
      if (category === "server-route") {
        casePolicy.applicationRoots.push({ file: path, context: "<module>", receiver: "app" });
      }
      const mutated = buildArchitectureSnapshot(root, casePolicy);
      expect(mutated.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "UNOWNED_TOPOLOGY", target: expect.stringContaining(`${category}|`) }),
        ])
      );
      expect(compareSnapshot(baseline, mutated).reason).toBe("violations");
    }
  });

  it("detects component index drift, malformed manifests, and disabled executable topology", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const missingIndex = goldenWorkspace();
    write(missingIndex, "config/components/future.ts", manifest());
    expect(buildArchitectureSnapshot(missingIndex, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPONENT_INDEX_DRIFT" })])
    );

    const malformed = goldenWorkspace();
    write(malformed, "config/components/core.ts", manifest("0001_core.sql", ",surprise:true"));
    expect(buildArchitectureSnapshot(malformed, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MALFORMED_COMPONENT_MANIFEST" })])
    );

    const requiredDisabled = goldenWorkspace();
    write(
      requiredDisabled,
      "config/components/core.ts",
      manifest().replace(
        'releaseMode:"required",runtimeState:"enabled"',
        'releaseMode:"required",runtimeState:"disabled"'
      )
    );
    expect(buildArchitectureSnapshot(requiredDisabled, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MALFORMED_COMPONENT_MANIFEST" })])
    );

    const disabled = goldenWorkspace();
    write(
      disabled,
      "config/components/core.ts",
      manifest().replace(
        'releaseMode:"required",runtimeState:"enabled"',
        'releaseMode:"optional-disabled",runtimeState:"disabled"'
      )
    );
    expect(buildArchitectureSnapshot(disabled, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DISABLED_COMPONENT_TOPOLOGY" })])
    );

    const omittedArrayMember = goldenWorkspace();
    write(
      omittedArrayMember,
      "config/components/index.ts",
      'import { CORE } from "./core"; export const COMPONENT_READINESS_MANIFESTS=[];\n'
    );
    expect(buildArchitectureSnapshot(omittedArrayMember, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPONENT_INDEX_DRIFT" })])
    );

    const runtimeSubstitution = goldenWorkspace();
    write(
      runtimeSubstitution,
      "server/lib/component-readiness-registry.ts",
      'import { COMPONENT_READINESS_MANIFESTS } from "../../config/components"; function compileComponentReadinessRegistry(x: unknown[]){return x;} export const COMPONENT_READINESS_REGISTRY=compileComponentReadinessRegistry([{...COMPONENT_READINESS_MANIFESTS[0]}]);\n'
    );
    expect(buildArchitectureSnapshot(runtimeSubstitution, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPONENT_RUNTIME_INDEX_DRIFT" })])
    );

    const wrongRoot = goldenWorkspace();
    write(wrongRoot, "config/components/core.ts", manifest().replace("server/child.ts", "server/routes.ts"));
    expect(buildArchitectureSnapshot(wrongRoot, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPONENT_AUTHORITY_DRIFT" })])
    );

    const executableManifest = goldenWorkspace();
    write(executableManifest, "config/components/core.ts", `import "../../server/child"; ${manifest()} doWork();\n`);
    expect(buildArchitectureSnapshot(executableManifest, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPONENT_MANIFEST_NOT_DATA_ONLY" })])
    );

    const disabledEffects = goldenWorkspace();
    write(
      disabledEffects,
      "config/components/core.ts",
      manifest().replace(
        'releaseMode:"required",runtimeState:"enabled"',
        'releaseMode:"optional-disabled",runtimeState:"disabled"'
      )
    );
    write(
      disabledEffects,
      "server/child.ts",
      'fetch(`${host}/publish`,{method:"POST"}); uploadCreateOnlyToR2("x",body);\n'
    );
    expect(buildArchitectureSnapshot(disabledEffects, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DISABLED_COMPONENT_TOPOLOGY",
          target: expect.stringContaining("provider-adapter"),
        }),
        expect.objectContaining({
          code: "DISABLED_COMPONENT_TOPOLOGY",
          target: expect.stringContaining("object-writer"),
        }),
      ])
    );

    const disabledImport = goldenWorkspace();
    const disabledPolicy = structuredClone(miniaturePolicy);
    disabledPolicy.componentAuthorities.push({
      id: "future",
      owner: "future-owner",
      sourceRoots: ["client/src/pages/future/"],
    });
    write(
      disabledImport,
      "config/components/future.ts",
      'export const FUTURE={schemaVersion:1,id:"future",owner:"future-owner",releaseMode:"optional-disabled",runtimeState:"disabled",sourceRoots:["client/src/pages/future/"],requirements:{migrations:[],relations:[],triggers:[],environment:[],runtimeSignals:[]}} as const;\n'
    );
    write(
      disabledImport,
      "config/components/index.ts",
      'import { CORE } from "./core"; import { FUTURE } from "./future"; export const COMPONENT_READINESS_MANIFESTS=[CORE,FUTURE];\n'
    );
    write(disabledImport, "client/src/pages/future/Future.tsx", "export default function Future(){return null;}\n");
    write(
      disabledImport,
      "client/src/App.tsx",
      'const FuturePage=lazy(()=>import("./pages/future/Future")); const app=<Route path="/future" component={FuturePage}/>;\n'
    );
    expect(buildArchitectureSnapshot(disabledImport, disabledPolicy).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DISABLED_COMPONENT_TOPOLOGY",
          target: expect.stringContaining("client-route"),
        }),
      ])
    );

    const disabledServerPolicy = structuredClone(miniaturePolicy);
    disabledServerPolicy.componentAuthorities.push({
      id: "future",
      owner: "future-owner",
      sourceRoots: ["server/future.ts"],
    });
    for (const [kind, rootSource] of [
      [
        "static",
        'import express from "express"; import {run} from "./future"; const app=express(); app.get("/live",()=>run());\n',
      ],
      [
        "dynamic",
        'import express from "express"; const app=express(); app.get("/live",async()=>{const {run}=await import("./future"); return run();});\n',
      ],
    ] as const) {
      const disabledServer = goldenWorkspace();
      write(
        disabledServer,
        "config/components/future.ts",
        'export const FUTURE={schemaVersion:1,id:"future",owner:"future-owner",releaseMode:"optional-disabled",runtimeState:"disabled",sourceRoots:["server/future.ts"],requirements:{migrations:[],relations:[],triggers:[],environment:[],runtimeSignals:[]}} as const;\n'
      );
      write(
        disabledServer,
        "config/components/index.ts",
        'import { CORE } from "./core"; import { FUTURE } from "./future"; export const COMPONENT_READINESS_MANIFESTS=[CORE,FUTURE];\n'
      );
      write(disabledServer, "server/future.ts", "export function run(){return 1;}\n");
      write(disabledServer, "server/routes.ts", rootSource);
      expect(buildArchitectureSnapshot(disabledServer, disabledServerPolicy).violations, kind).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "DISABLED_COMPONENT_RUNTIME_EDGE",
            target: expect.stringContaining(
              `future:${kind === "static" ? "import" : "dynamic-import"}:server/future.ts`
            ),
          }),
        ])
      );
    }
  });

  it("records constant/helper SQL, excludes CTE aliases, and isolates route-local provider effects", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); const SQL="INSERT INTO cards(id) VALUES (1)"; function rows(client, query){return client.query(query);} rows(db, SQL); executor.execute(sql`UPDATE cards SET id=2`); executor.query(`SELECT * FROM information_schema.columns`); executor.query(`SELECT CASE WHEN actual IS DISTINCT FROM required.expected_type THEN 1 END FROM cards`); executor.query(`INSERT INTO cards(id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id=2`); executor.query(`SELECT * FROM unnest(items) JOIN LATERAL expand(items) ON true`); queryable.query(`WITH expected(column) AS MATERIALIZED (SELECT id FROM cards), stale AS NOT MATERIALIZED (SELECT column FROM expected) SELECT * FROM stale`); const results=[]; results.push(1); for(const result of results){executor.execute(sql`INSERT INTO reel_card_approvals(id) VALUES (1)`);} r.get("/pay",async(_req,res)=>{await stripe.paymentIntents.create({}); await uploadCreateOnlyToR2("x",body); res.end();}); r.get("/health",(_req,res)=>res.end()); return r;}\n'
    );
    const snapshot = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(snapshot.violations).toEqual([]);
    const accesses = snapshot.records.filter((record: { category: string }) => record.category === "table-access");
    expect(accesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "write:public.cards", access: "sql-helper" }),
        expect.objectContaining({ id: "read:public.cards" }),
        expect.objectContaining({ id: "write:public.cards", access: "sql" }),
        expect.objectContaining({ id: "write:public.reel_card_approvals", access: "sql" }),
        expect.objectContaining({ id: "read:information_schema.columns", access: "sql" }),
      ])
    );
    expect(accesses.some((record: { id: string }) => record.id.includes("public.a"))).toBe(false);
    expect(accesses.some((record: { id: string }) => record.id.includes("public.expected"))).toBe(false);
    expect(accesses.some((record: { id: string }) => record.id.includes("public.stale"))).toBe(false);
    expect(accesses.some((record: { id: string }) => record.id.includes("public.information_schema"))).toBe(false);
    expect(accesses.some((record: { id: string }) => record.id.includes("required.expected_type"))).toBe(false);
    expect(accesses.some((record: { id: string }) => record.id === "write:public.set")).toBe(false);
    expect(accesses.some((record: { id: string }) => record.id === "read:public.lateral")).toBe(false);
    expect(accesses.some((record: { id: string }) => record.id === "read:public.unnest")).toBe(false);
    const pay = snapshot.records.find(
      (record: { category: string; id: string }) => record.category === "server-route" && record.id === "GET /api/pay"
    );
    const health = snapshot.records.find(
      (record: { category: string; id: string }) =>
        record.category === "server-route" && record.id === "GET /api/health"
    );
    expect(pay?.providerEffects.join(" ")).toMatch(/stripe:|object-writer/);
    expect(health?.providerEffects).toEqual(["delegated-or-none"]);
  });

  it("connects routes to imported provider helpers instead of hiding delegated effects", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const policy = structuredClone(miniaturePolicy);
    policy.ownerRules.push({ prefix: "server/provider.ts", owner: "provider-owner" });
    write(root, "server/child.ts", "export const child=true;\n");
    write(root, "server/provider.ts", "export async function charge(){await stripe.accounts.create({});}\n");
    write(
      root,
      "server/routes.ts",
      'import express from "express"; import {charge} from "./provider"; const app=express(); app.post("/pay",async()=>{});\n'
    );
    const baseline = buildArchitectureSnapshot(root, policy);
    expect(baseline.violations).toEqual([]);
    write(
      root,
      "server/routes.ts",
      'import express from "express"; import {charge} from "./provider"; const app=express(); app.post("/pay",async()=>{await charge();});\n'
    );
    const delegated = buildArchitectureSnapshot(root, policy);
    expect(delegated.violations).toEqual([]);
    expect(delegated.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "POST /pay",
          delegatedCommands: ["server/provider.ts#charge"],
          providerEffects: expect.arrayContaining([expect.stringContaining("stripe.accounts.create")]),
        }),
      ])
    );
    expect(compareSnapshot(baseline, delegated).ok).toBe(false);

    write(
      root,
      "server/routes.ts",
      'import express from "express"; import * as gateway from "./provider"; const app=express(); app.post("/pay",async()=>{await gateway.charge();});\n'
    );
    const namespaceDelegated = buildArchitectureSnapshot(root, policy);
    expect(namespaceDelegated.violations).toEqual([]);
    expect(namespaceDelegated.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "POST /pay",
          delegatedCommands: ["server/provider.ts#charge"],
          providerEffects: expect.arrayContaining([expect.stringContaining("stripe.accounts.create")]),
        }),
      ])
    );

    write(
      root,
      "server/routes.ts",
      'import express from "express"; const {charge:dispatch}=await import("./provider"); const app=express(); app.post("/pay",async()=>{});\n'
    );
    const dynamicBaseline = buildArchitectureSnapshot(root, policy);
    write(
      root,
      "server/routes.ts",
      'import express from "express"; const {charge:dispatch}=await import("./provider"); const app=express(); app.post("/pay",async()=>{await dispatch();});\n'
    );
    const dynamicDelegated = buildArchitectureSnapshot(root, policy);
    expect(dynamicDelegated.violations).toEqual([]);
    expect(dynamicDelegated.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "POST /pay",
          delegatedCommands: ["server/provider.ts#charge"],
          providerEffects: expect.arrayContaining([expect.stringContaining("stripe.accounts.create")]),
        }),
      ])
    );
    expect(compareSnapshot(dynamicBaseline, dynamicDelegated).ok).toBe(false);
  });

  it("connects routes to imported service-object methods and destructive bulk object commands", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const policy = structuredClone(miniaturePolicy);
    policy.ownerRules.push({ prefix: "server/provider.ts", owner: "provider-owner" });
    write(root, "server/child.ts", "export const child=true;\n");
    write(
      root,
      "server/provider.ts",
      "export const gateway={async charge(){await stripe.accounts.create({}); new DeleteObjectsCommand({});}};\n"
    );
    write(
      root,
      "server/routes.ts",
      'import express from "express"; import {gateway} from "./provider"; const app=express(); app.post("/pay",async()=>{});\n'
    );
    const baseline = buildArchitectureSnapshot(root, policy);
    expect(baseline.violations).toEqual([]);
    write(
      root,
      "server/routes.ts",
      'import express from "express"; import {gateway} from "./provider"; const app=express(); app.post("/pay",async()=>{await gateway.charge();});\n'
    );
    const delegated = buildArchitectureSnapshot(root, policy);
    expect(delegated.violations).toEqual([]);
    expect(delegated.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "POST /pay",
          delegatedCommands: ["server/provider.ts#gateway.charge"],
          providerEffects: expect.arrayContaining([
            expect.stringContaining("stripe.accounts.create"),
            expect.stringContaining("DeleteObjectsCommand"),
          ]),
        }),
      ])
    );
    expect(compareSnapshot(baseline, delegated).ok).toBe(false);

    write(
      root,
      "server/provider.ts",
      "class Gateway{async charge(){await stripe.accounts.create({}); new DeleteObjectsCommand({});}} export const gateway=new Gateway();\n"
    );
    const constructed = buildArchitectureSnapshot(root, policy);
    expect(constructed.violations).toEqual([]);
    expect(constructed.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "POST /pay",
          delegatedCommands: ["server/provider.ts#Gateway.charge"],
          providerEffects: expect.arrayContaining([
            expect.stringContaining("stripe.accounts.create"),
            expect.stringContaining("DeleteObjectsCommand"),
          ]),
        }),
      ])
    );

    write(
      root,
      "server/provider.ts",
      "class Gateway{async noop(){} async send(){await stripe.accounts.create({}); new PutObjectCommand({});} async charge(){await this.noop();}} export const gateway=new Gateway();\n"
    );
    const thisBaseline = buildArchitectureSnapshot(root, policy);
    const baselineRoute = thisBaseline.records.find(
      (record: { category: string; id: string }) => record.category === "server-route" && record.id === "POST /pay"
    );
    expect(baselineRoute?.providerEffects).toEqual(["delegated-or-none"]);
    write(
      root,
      "server/provider.ts",
      "class Gateway{async noop(){} async send(){await stripe.accounts.create({}); new PutObjectCommand({});} async charge(){await this.send();}} export const gateway=new Gateway();\n"
    );
    const thisCandidate = buildArchitectureSnapshot(root, policy);
    expect(thisCandidate.violations).toEqual([]);
    expect(thisCandidate.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "server-route",
          id: "POST /pay",
          delegatedCommands: expect.arrayContaining([
            "server/provider.ts#Gateway.charge",
            "server/provider.ts#Gateway.send",
          ]),
          providerEffects: expect.arrayContaining([
            expect.stringContaining("stripe.accounts.create"),
            expect.stringContaining("PutObjectCommand"),
          ]),
        }),
      ])
    );
    expect(compareSnapshot(thisBaseline, thisCandidate).ok).toBe(false);
  });

  it("keeps same-name dynamic import bindings scoped to their lexical handlers", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const policy = structuredClone(miniaturePolicy);
    policy.ownerRules.push(
      { prefix: "server/a.ts", owner: "provider-owner" },
      { prefix: "server/b.ts", owner: "provider-owner" }
    );
    write(root, "server/child.ts", "export const child=true;\n");
    write(root, "server/a.ts", "export async function run(){return true;}\n");
    write(root, "server/b.ts", "export async function run(){await stripe.accounts.create({});}\n");
    const baselineSource =
      'import express from "express"; const app=express(); app.get("/a",async()=>{const {run}=await import("./a"); await run();}); app.get("/b",async()=>{const {run}=await import("./b"); await run();});\n';
    write(root, "server/routes.ts", baselineSource);
    const baseline = buildArchitectureSnapshot(root, policy);
    expect(baseline.violations).toEqual([]);
    const route = (id: string) =>
      baseline.records.find(
        (record: { category: string; id: string }) => record.category === "server-route" && record.id === id
      );
    expect(route("GET /a")?.delegatedCommands).toEqual(["server/a.ts#run"]);
    expect(route("GET /a")?.providerEffects).toEqual(["delegated-or-none"]);
    expect(route("GET /b")?.delegatedCommands).toEqual(["server/b.ts#run"]);
    expect(route("GET /b")?.providerEffects.join(" ")).toMatch(/stripe\.accounts\.create/);

    write(root, "server/routes.ts", baselineSource.replace('import("./a")', 'import("./b")'));
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, policy)).ok).toBe(false);
  });

  it("binds HTTP provider records to method, timeout signal, idempotency, and options authority", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); r.post("/publish",async()=>{await fetch("https://provider.example/publish",{method:"POST",signal:controller.signal,headers:{"Idempotency-Key":key}});}); return r;}\n'
    );
    const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(baseline.violations).toEqual([]);
    expect(baseline.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "provider-adapter",
          id: "fetch:https://provider.example",
          urlAuthority: "https://provider.example/publish",
          httpMethod: "POST",
          timeoutSignal: "controller.signal",
          idempotencyEvidence: "declared-header",
        }),
      ])
    );
    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); r.post("/publish",async()=>{await fetch("https://provider.example/publish",{method:"GET",headers:{}});}); return r;}\n'
    );
    const weakened = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(weakened.violations).toEqual([]);
    expect(weakened.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "provider-adapter",
          id: "fetch:https://provider.example",
          httpMethod: "GET",
          timeoutSignal: "not-declared",
          idempotencyEvidence: "not-declared",
        }),
      ])
    );
    expect(compareSnapshot(baseline, weakened).ok).toBe(false);

    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); r.post("/publish",async()=>{await fetch("https://provider.example/delete",{method:"POST",signal:controller.signal,headers:{"Idempotency-Key":key}});}); return r;}\n'
    );
    const changedEndpoint = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(changedEndpoint.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "provider-adapter",
          id: "fetch:https://provider.example",
          urlAuthority: "https://provider.example/delete",
        }),
      ])
    );
    expect(compareSnapshot(baseline, changedEndpoint).ok).toBe(false);

    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); const method="POST"; r.post("/publish",async()=>{await fetch("https://provider.example/publish",{method,headers:{"Idempotency-Key":key}});}); return r;}\n'
    );
    const shorthand = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(shorthand.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "provider-adapter", httpMethod: "POST" })])
    );

    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); r.post("/publish",async()=>{await fetch("https://provider.example/publish",{method:"POST",...init});}); return r;}\n'
    );
    const laterSpread = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(laterSpread.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "provider-adapter", httpMethod: "unclassified" })])
    );

    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); r.post("/publish",async()=>{await fetch("https://provider.example/publish",{...init,method:"POST"});}); return r;}\n'
    );
    const finalMethod = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(finalMethod.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ category: "provider-adapter", httpMethod: "POST" })])
    );

    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); r.post("/publish",async()=>{await fetch("https://provider.example/publish",{...init,signal:controller.signal});}); return r;}\n'
    );
    const spreadHeaders = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(spreadHeaders.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "provider-adapter",
          httpMethod: "unclassified",
          idempotencyEvidence: "unclassified",
        }),
      ])
    );

    write(
      root,
      "server/child.ts",
      'import {Router} from "express"; export function childRouter(){const r=Router(); r.post("/publish",async()=>{await fetch("https://provider.example/publish",{method:"POST",headers:buildHeaders()});}); return r;}\n'
    );
    const dynamicHeaders = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(dynamicHeaders.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "provider-adapter", idempotencyEvidence: "unclassified" }),
      ])
    );
  });

  it("rejects forbidden runtime imports and honors only exact, runtime-bearing exceptions", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    write(root, "server/leaf/new.ts", 'import { helper } from "../routes"; void helper;\n');
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "FORBIDDEN_RUNTIME_IMPORT" })])
    );
    write(root, "server/leaf/new.ts", 'import { type Helper } from "../routes"; type X=Helper;\n');
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual([]);
    write(root, "server/leaf/new.ts", 'export { type Helper } from "../routes";\n');
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual([]);
  });

  it("binds HTTP helper origins and request semantics to each reachable callsite", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const source = (origin: string, method: string) =>
      `import {Router} from "express"; const API_BASE="${origin}"; async function send(path,init){const url=\`${"${API_BASE}${path}"}\`; await fetch(url,init);} export function childRouter(){const r=Router(); r.post("/publish",async()=>send("/v2/publish",{method:"${method}",signal:controller.signal,headers:{"Idempotency-Key":key}})); return r;}\n`;
    write(root, "server/child.ts", source("https://provider.example", "POST"));
    const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(baseline.violations).toEqual([]);
    expect(baseline.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "provider-adapter",
          id: "fetch:https://provider.example",
          urlAuthority: "https://provider.example<dynamic:path>",
          callsiteAuthorities: expect.arrayContaining([
            expect.objectContaining({
              urlAuthority: "https://provider.example/v2/publish",
              httpMethod: "POST",
              timeoutSignal: "controller.signal",
              idempotencyEvidence: "declared-header",
            }),
          ]),
        }),
      ])
    );

    write(root, "server/child.ts", source("https://evil.example", "POST"));
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy)).ok).toBe(false);

    write(root, "server/child.ts", source("https://provider.example", "GET"));
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy)).ok).toBe(false);
  });

  it("checks migration checksums, duplicate numeric identity, and required shipped authority", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
    write(root, "migrations/0001_core.sql", "DROP TABLE cards;\n");
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy))).toMatchObject({
      ok: false,
      reason: "topology-drift",
    });
    write(root, `migrations/${"00001" + "_collision.sql"}`, "SELECT 1;\n");
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DUPLICATE_MIGRATION_NUMBER" })])
    );
    write(root, "config/components/core.ts", manifest("9999_missing.sql"));
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_REQUIRED_MIGRATION", target: "9999_missing.sql" }),
      ])
    );
  });

  it("binds lineage exclusions to exact shipped identities and convergence migrations", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const convergenceMigration = "0002" + "_convergence.sql";
    const historicalOccupant = "0001" + "_historical_occupant.sql";
    const leadingZeroOccupant = "00001" + "_historical_occupant.sql";
    const wrongIdentity = "0003" + "_wrong_identity.sql";
    write(root, `migrations/${convergenceMigration}`, "SELECT 1;\n");
    const declaration = {
      incoming: "0001_core.sql",
      occupant: historicalOccupant,
      supersededBy: convergenceMigration,
      reason: "The historical occupant is converged by the shipped follow-up migration.",
    };
    write(root, "migrations/lineage-exclusions.json", `${JSON.stringify([declaration], null, 2)}\n`);
    const valid = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(valid.violations).toEqual([]);
    expect(valid.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "migration-lineage",
          id: `0001_core.sql|${historicalOccupant}`,
          supersededBy: convergenceMigration,
        }),
      ])
    );

    write(
      root,
      "migrations/lineage-exclusions.json",
      `${JSON.stringify([{ ...declaration, occupant: leadingZeroOccupant }], null, 2)}\n`
    );
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MALFORMED_MIGRATION_LINEAGE" })])
    );

    write(
      root,
      "migrations/lineage-exclusions.json",
      `${JSON.stringify([{ ...declaration, occupant: wrongIdentity }], null, 2)}\n`
    );
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MALFORMED_MIGRATION_LINEAGE" })])
    );
  });

  it("requires every layer exception to be exercised once and backed by an open finding", async () => {
    const { buildArchitectureSnapshot } = await architectureModule();
    const policy = structuredClone(miniaturePolicy);
    policy.runtimeImportExceptions = [
      {
        source: "server/leaf/new.ts",
        target: "server/routes",
        kind: "import",
        finding: "ARCH-CYCLE-TEST",
      },
    ];
    const valid = goldenWorkspace();
    write(valid, "server/leaf/new.ts", 'import { helper } from "../routes"; void helper;\n');
    write(valid, "engineering/ISSUE_REGISTER.md", "| ARCH-CYCLE-TEST | HIGH | OPEN | bounded exception |\n");
    expect(buildArchitectureSnapshot(valid, policy).violations).toEqual([]);

    const stale = goldenWorkspace();
    write(stale, "engineering/ISSUE_REGISTER.md", "| ARCH-CYCLE-TEST | HIGH | OPEN | bounded exception |\n");
    expect(buildArchitectureSnapshot(stale, policy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "STALE_OR_DUPLICATE_LAYER_EXCEPTION" })])
    );

    const closed = goldenWorkspace();
    write(closed, "server/leaf/new.ts", 'import { helper } from "../routes"; void helper;\n');
    write(closed, "engineering/ISSUE_REGISTER.md", "| ARCH-CYCLE-TEST | HIGH | CLOSED | stale exception |\n");
    expect(buildArchitectureSnapshot(closed, policy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_LAYER_EXCEPTION_FINDING" })])
    );

    const contradictory = goldenWorkspace();
    write(contradictory, "server/leaf/new.ts", 'import { helper } from "../routes"; void helper;\n');
    write(contradictory, "engineering/ISSUE_REGISTER.md", "| ARCH-CYCLE-TEST | HIGH | CLOSED | canonical |\n");
    write(
      contradictory,
      ".claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/issue-register.md",
      "| ARCH-CYCLE-TEST | HIGH | OPEN | stale task copy |\n"
    );
    expect(buildArchitectureSnapshot(contradictory, policy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_LAYER_EXCEPTION_FINDING" })])
    );

    const substringPolicy = structuredClone(policy);
    substringPolicy.runtimeImportExceptions[0].finding = "ARCH";
    expect(buildArchitectureSnapshot(valid, substringPolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_LAYER_EXCEPTION_FINDING", target: "ARCH" })])
    );
  });

  it("rejects stale or shadowed legacy keys before an owner can be silently demoted", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
    const ownedRoute = baseline.records.find(
      (record: { category: string; source: string }) =>
        record.category === "server-route" && record.source.startsWith("server/child.ts:")
    );
    expect(ownedRoute).toBeTruthy();
    if (!ownedRoute) throw new Error("expected owned fixture route");
    write(
      root,
      "legacy-authority.json",
      `${JSON.stringify(
        {
          schemaVersion: 1,
          records: [
            {
              key: ownedRoute.key,
              finding: "ARCH-AUTHORITY-001",
              expiresWith: "the bounded-context repair that assigns explicit authority",
            },
          ],
        },
        null,
        2
      )}\n`
    );
    expect(buildArchitectureSnapshot(root, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "OBSOLETE_LEGACY_AUTHORITY", target: ownedRoute.key })])
    );

    write(root, "legacy-authority.json", '{"schemaVersion":1,"records":[]}\n');
    write(root, "server/unused.ts", "export const unused=true;\n");
    write(root, "config/components/core.ts", manifest().replace("server/child.ts", "server/unused.ts"));
    const demotedPolicy = structuredClone(miniaturePolicy);
    demotedPolicy.componentAuthorities[0].sourceRoots = ["server/unused.ts"];
    expect(buildArchitectureSnapshot(root, demotedPolicy).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNOWNED_TOPOLOGY", target: expect.stringContaining("server/child.ts") }),
      ])
    );

    const legacy = goldenWorkspace();
    write(legacy, "server/legacy.ts", 'fetch(`${host}/publish`,{method:"POST"});\n');
    const unowned = buildArchitectureSnapshot(legacy, miniaturePolicy).records.find(
      (record: { source: string; disposition: string }) =>
        record.source.startsWith("server/legacy.ts:") && record.disposition === "unowned"
    );
    expect(unowned).toBeTruthy();
    const validLegacy = {
      schemaVersion: 1,
      records: [
        {
          key: unowned.key,
          finding: "ARCH-AUTHORITY-001",
          expiresWith: "the bounded-context repair that assigns explicit authority",
        },
      ],
    };
    write(legacy, "engineering/ISSUE_REGISTER.md", "| ARCH-AUTHORITY-001 | HIGH | FIXED_WIP | active |\n");
    write(legacy, "legacy-authority.json", `${JSON.stringify(validLegacy)}\n`);
    const admitted = buildArchitectureSnapshot(legacy, miniaturePolicy);
    expect(admitted.violations).toEqual([]);
    write(
      legacy,
      "legacy-authority.json",
      `${JSON.stringify({ ...validLegacy, records: [{ ...validLegacy.records[0], expiresWith: "a later exact repair" }] })}\n`
    );
    expect(compareSnapshot(admitted, buildArchitectureSnapshot(legacy, miniaturePolicy)).ok).toBe(false);
    write(legacy, "engineering/ISSUE_REGISTER.md", "| ARCH-AUTHORITY-001 | HIGH | CLOSED | stale |\n");
    expect(buildArchitectureSnapshot(legacy, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_LEGACY_AUTHORITY_FINDING" })])
    );
    write(legacy, "engineering/ISSUE_REGISTER.md", "| ARCH-AUTHORITY-001 | HIGH | FIXED_WIP | active |\n");
    write(
      legacy,
      "legacy-authority.json",
      `${JSON.stringify({ schemaVersion: 999, records: [{ key: unowned.key }, { key: unowned.key }] })}\n`
    );
    expect(buildArchitectureSnapshot(legacy, miniaturePolicy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MALFORMED_LEGACY_AUTHORITY" })])
    );
  });

  it("inventories role, principal-cache, and pricing authorities as structural drift", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const authoritySource =
      'const PARTNER_ROLES=["OWNER"]; const role="customer"; const guide="From £19"; const unitPrice=1; const query={queryKey:["/api/cards"]}; const bound={queryKey:["/api/cards",userId]}; const staticUrl={queryKey:["/api/cards?tenantId=global"]}; const staticName={queryKey:["/api/cards","userId"]}; const staticObject={queryKey:["/api/cards",{userId:"global"}]}; const nested={queryKey:["/api/cards",session.user.id]}; const interpolated={queryKey:[`/api/cards/${tenantId}`]}; function View(){const scopedKey=["/api/cards",userId]; const local={queryKey:scopedKey}; return <span>£{tier.price_per_card}</span>;} const Cards=lazy(()=>import("./Cards")); const app=<Route path="/cards" component={Cards}/>;\n';
    write(root, "client/src/App.tsx", authoritySource);
    write(root, "server/child.ts", 'export interface SetLibraryActor { role: "admin" | "staff" }\n');
    const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
    expect(baseline.violations).toEqual([]);
    expect(baseline.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "role-authority", id: "role:OWNER" }),
        expect.objectContaining({ category: "role-authority", id: "role:customer" }),
        expect.objectContaining({ category: "role-authority", id: "role:admin", declaration: "role" }),
        expect.objectContaining({ category: "role-authority", id: "role:staff", declaration: "role" }),
        expect.objectContaining({ category: "session-principal", principalBinding: "principal-not-declared-in-key" }),
        expect.objectContaining({ category: "session-principal", principalBinding: "declared-in-key" }),
        expect.objectContaining({ category: "pricing-authority", id: "value:unitPrice" }),
        expect.objectContaining({ category: "pricing-authority", id: "literal:£19" }),
        expect.objectContaining({
          category: "pricing-authority",
          id: "projection:£:tier.price_per_card",
        }),
      ])
    );
    const cacheRecords = baseline.records.filter(
      (record: { category: string }) => record.category === "session-principal"
    );
    expect(cacheRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cache-key:["/api/cards?tenantId=global"]',
          principalBinding: "principal-not-declared-in-key",
        }),
        expect.objectContaining({
          id: 'cache-key:["/api/cards","userId"]',
          principalBinding: "principal-not-declared-in-key",
        }),
        expect.objectContaining({
          id: 'cache-key:["/api/cards",session.user.id]',
          principalBinding: "declared-in-key",
        }),
        expect.objectContaining({
          id: "cache-key:[`/api/cards/${tenantId}`]",
          principalBinding: "declared-in-key",
        }),
        expect.objectContaining({
          id: 'cache-key:["/api/cards",{userId:"global"}]',
          principalBinding: "principal-not-declared-in-key",
        }),
        expect.objectContaining({
          id: "cache-key:scopedKey",
          keyAuthority: '["/api/cards",userId]',
          principalBinding: "declared-in-key",
        }),
      ])
    );
    write(
      root,
      "client/src/App.tsx",
      authoritySource.replace('["/api/cards",userId]; const local', '["/api/cards"]; const local')
    );
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy))).toMatchObject({
      ok: false,
      reason: "topology-drift",
    });
    write(root, "client/src/App.tsx", authoritySource.replace("tier.price_per_card", "tier.max_value_gbp"));
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy))).toMatchObject({
      ok: false,
      reason: "topology-drift",
    });
    write(root, "client/src/App.tsx", authoritySource.replace('role="customer"', 'role="admin"').replace("£19", "£45"));
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy))).toMatchObject({
      ok: false,
      reason: "topology-drift",
    });
    write(root, "server/child.ts", 'export interface SetLibraryActor { role: "owner" | "grader" }\n');
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy))).toMatchObject({
      ok: false,
      reason: "topology-drift",
    });
  });

  it("binds Admin cache records to the public classifier and role-aware principal hash", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const policy = {
      ...structuredClone(miniaturePolicy),
      adminCacheAuthority: {
        file: "client/src/lib/queryClient.ts",
        classifier: "isAdminProtectedQueryKey",
        hash: "scopedQueryHash",
        publicKeySet: "PUBLIC_ADMIN_VIEW_QUERY_KEYS",
        principalFields: ["email", "isSuperAdmin"],
      },
    };
    const cacheAuthority = `const ADMIN_QUERY_HASH_PREFIX="admin-principal:";
const PUBLIC_ADMIN_VIEW_QUERY_KEYS=new Set(["/api/public"]);
const activeAdminPrincipal={email:"a",isSuperAdmin:true};
export function isAdminProtectedQueryKey(queryKey){
  const first=queryKey[0];
  if(first === "public") return false;
  if(typeof first === "string" && PUBLIC_ADMIN_VIEW_QUERY_KEYS.has(first)) return false;
  return true;
}
export function scopedQueryHash(queryKey){
  const queryHash=hashKey(queryKey);
  if(activeAdminPrincipal === null || !isAdminProtectedQueryKey(queryKey)) return queryHash;
  return \`${"${ADMIN_QUERY_HASH_PREFIX}"}${"${hashKey([activeAdminPrincipal.email, activeAdminPrincipal.isSuperAdmin])}"}:${"${queryHash}"}\`;
}
`;
    write(root, "client/src/lib/queryClient.ts", cacheAuthority);
    write(
      root,
      "client/src/App.tsx",
      'const publicQuery={queryKey:["/api/public"]}; const protectedQuery={queryKey:["/api/admin/private"]}; const prefixed={queryKey:["public","projection"]};\n'
    );

    const baseline = buildArchitectureSnapshot(root, policy);
    expect(baseline.violations).toEqual([]);
    expect(baseline.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cache-key:["/api/public"]',
          adminCacheScope: "explicit-public-shared",
          runtimePrincipalBinding: "none-public-shared",
          cacheClassificationAuthority:
            "client/src/lib/queryClient.ts#isAdminProtectedQueryKey",
          cacheHashAuthority: "client/src/lib/queryClient.ts#scopedQueryHash",
        }),
        expect.objectContaining({
          id: 'cache-key:["/api/admin/private"]',
          adminCacheScope: "principal-partitioned-when-admin-active",
          runtimePrincipalBinding: "email+isSuperAdmin",
        }),
        expect.objectContaining({
          id: 'cache-key:["public","projection"]',
          adminCacheScope: "explicit-public-shared",
        }),
      ])
    );

    write(
      root,
      "client/src/lib/queryClient.ts",
      cacheAuthority.replace(", activeAdminPrincipal.isSuperAdmin", "")
    );
    expect(buildArchitectureSnapshot(root, policy).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ADMIN_CACHE_AUTHORITY_DRIFT",
          target: expect.stringContaining("hash the complete Admin scope"),
        }),
      ])
    );

    write(
      root,
      "client/src/lib/queryClient.ts",
      cacheAuthority.replace('if(first === "public") return false;', 'first === "public";')
    );
    expect(buildArchitectureSnapshot(root, policy).violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ADMIN_CACHE_AUTHORITY_DRIFT",
          target: expect.stringContaining("control both public exceptions"),
        }),
      ])
    );

    write(
      root,
      "client/src/lib/queryClient.ts",
      cacheAuthority.replace('if(first === "public") return false;', 'if(first === "public") return true;')
    );
    expect(buildArchitectureSnapshot(root, policy).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "ADMIN_CACHE_AUTHORITY_DRIFT" })])
    );

    write(root, "client/src/lib/queryClient.ts", cacheAuthority.replace('"/api/public"', '"/api/other"'));
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, policy))).toMatchObject({
      ok: false,
      reason: "topology-drift",
    });
  });

  it("ignores line-only movement but prints structural additions and changes", async () => {
    const { buildArchitectureSnapshot, compareSnapshot } = await architectureModule();
    const root = goldenWorkspace();
    const baseline = buildArchitectureSnapshot(root, miniaturePolicy);
    write(root, "server/child.ts", `// line-only movement\n${readFileSync(join(root, "server/child.ts"), "utf8")}`);
    expect(compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy)).ok).toBe(true);
    write(
      root,
      "client/src/App.tsx",
      'const Other=lazy(()=>import("./Other")); const app=<Route path="/cards" component={Other}/>;\n'
    );
    const drift = compareSnapshot(baseline, buildArchitectureSnapshot(root, miniaturePolicy));
    expect(drift).toMatchObject({ ok: false, reason: "topology-drift" });
    expect((drift.details as { changed: string[] }).changed).not.toHaveLength(0);
  });
});
