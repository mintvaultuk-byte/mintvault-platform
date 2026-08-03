/**
 * MERGE-LOSS SENTINELS — psp/partner-rbac-hybrid <- origin/main reconciliation, 2026-08-03.
 *
 * Seven files conflicted in that merge. In every one of them BOTH sides contributed live,
 * shipping behaviour, so the correct resolution was a union and the realistic failure mode was
 * silently dropping one side. The partner DB matrix cannot see that class of mistake: it never
 * imports server/partner/routes.ts, client/src/lib/partner-api.ts or the Portal pages at all.
 *
 * These tests exist to fail loudly if a future rebase, revert or re-resolution deletes either
 * side. They are deliberately dependency-free — no database, no env gate, no conditional skip —
 * so they run on every CI job unconditionally and cannot degrade into a silent no-op.
 *
 * Every read below uses readFileSync WITHOUT a try/catch. That is intentional: a swallowed read
 * failure would turn a "not.toContain" assertion into a proof over an empty string, which is the
 * exact vacuity class this file is meant to guard against. A missing file must throw.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf8");

/**
 * Strip block and line comments. Mutation testing showed that asserting a code token against the
 * raw source is unsound here: the explanatory comments in these very files quote the tokens they
 * describe (e.g. "...context"), so a mutant that deleted the real code still matched the prose and
 * survived. Code-level assertions below therefore run against the comment-free source.
 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const routes = read("server", "partner", "routes.ts");
const partnerApi = read("client", "src", "lib", "partner-api.ts");
const securityPage = read("client", "src", "pages", "partner", "security.tsx");
const serverRoutes = read("server", "routes.ts");
const ci = read(".github", "workflows", "ci.yml");
const schemaParity = read("tests", "partner-schema-parity.test.ts");
const rlsSuite = read("tests", "partner-rls-isolation.test.ts");
const submissionWorkflow = read("tests", "partner-submission-workflow.test.ts");
const creditReservation = read("tests", "partner-credit-reservation-service.test.ts");

/** No resolved file may still carry a conflict marker. */
describe("no unresolved merge conflict survives in the partner surface", () => {
  it("none of the seven conflicted files contains a conflict marker", () => {
    const files: Array<[string, string]> = [
      ["server/partner/routes.ts", routes],
      ["client/src/lib/partner-api.ts", partnerApi],
      ["client/src/pages/partner/security.tsx", securityPage],
      ["tests/partner-schema-parity.test.ts", schemaParity],
      ["tests/partner-rls-isolation.test.ts", rlsSuite],
      ["tests/partner-submission-workflow.test.ts", submissionWorkflow],
      ["tests/partner-credit-reservation-service.test.ts", creditReservation],
    ];
    for (const [name, src] of files) {
      expect(src.length, `${name} read as empty — a vacuous assertion would follow`).toBeGreaterThan(0);
      for (const marker of ["<<<<<<<", ">>>>>>>", "||||||| "]) {
        expect(src.includes(marker), `${name} still contains a '${marker}' conflict marker`).toBe(false);
      }
    }
  });
});

/** Conflict 1 — server/partner/routes.ts. */
describe("GET /api/partner/session keeps BOTH sides of the conflict", () => {
  const code = stripComments(routes);
  const session = code.slice(code.indexOf('r.get("/session"'), code.indexOf('r.get("/credits"'));

  it("still spreads this branch's portal context into the session payload", () => {
    expect(session).toContain("getPartnerPortalContext(req.partner)");
    expect(session).toContain("...context");
  });

  it("still returns origin/main's four MFA-posture fields", () => {
    for (const field of [
      "mfaRequired: status.required",
      "mfaEnrolled: status.enrolled",
      "mfaEnrolmentRequired: status.enrolmentRequired",
      "recoveryCodesRemaining: status.recoveryCodesRemaining",
    ]) {
      expect(session, `origin/main's '${field}' was lost from GET /session`).toContain(field);
    }
  });

  it("orders the MFA fields AFTER the context spread so posture cannot be overridden", () => {
    expect(session.indexOf("...context")).toBeLessThan(session.indexOf("mfaRequired: status.required"));
  });

  it("keeps all three routes this branch added, each behind an auth gate", () => {
    const routesCode = stripComments(routes);
    for (const [route, gate] of [
      ['r.get("/credits"', 'requirePartnerCapability("partner.credits.view")'],
      ['r.get("/sessions"', "requirePartnerAuth"],
      ['r.post("/sessions/:id/revoke"', "requirePartnerAuth"],
    ]) {
      expect(routesCode, `route ${route} was lost`).toContain(route);
      const decl = routesCode.slice(routesCode.indexOf(route), routesCode.indexOf(route) + 160);
      expect(decl, `route ${route} lost its authorization gate`).toContain(gate);
    }
  });

  it("keeps origin/main's current-factor requirement on recovery-code regeneration", () => {
    expect(routes).toContain('r.post("/mfa/recovery-codes/regenerate"');
  });
});

/** Route mounting — a union resolution must not register the portal twice. */
describe("the partner portal is mounted exactly once in production", () => {
  it("server/routes.ts calls mountPartnerPortal exactly once", () => {
    expect(serverRoutes.match(/mountPartnerPortal\(/g) ?? []).toHaveLength(1);
  });

  it("the public router is still registered BEFORE the portal router", () => {
    const pub = serverRoutes.indexOf("registerPartnerPublicRoutes(app)");
    const portal = serverRoutes.indexOf("mountPartnerPortal(app)");
    expect(pub).toBeGreaterThan(-1);
    expect(portal).toBeGreaterThan(-1);
    expect(pub, "the shadowing invariant that keeps public login ahead of routes.ts was inverted").toBeLessThan(portal);
  });

  it("no partner route path is registered twice inside server/partner/routes.ts", () => {
    const paths = [...routes.matchAll(/\br\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(paths.length).toBeGreaterThan(10);
    expect(paths, `duplicate route registration: ${paths.filter((p, i) => paths.indexOf(p) !== i).join(", ")}`).toEqual(
      [...new Set(paths)]
    );
  });
});

/** Conflict 2 — client/src/lib/partner-api.ts, and the client/server path contract. */
describe("PartnerSessionInfo keeps BOTH field families", () => {
  it("keeps this branch's shop-identity fields", () => {
    for (const f of ["organisationName?", "tradingName?", "displayName?", "role?", "locationName?"]) {
      expect(partnerApi, `identity field '${f}' was lost`).toContain(f);
    }
  });

  it("keeps origin/main's MFA fields", () => {
    for (const f of ["mfaEnrolled?", "mfaEnrolmentRequired?", "recoveryCodesRemaining?"]) {
      expect(partnerApi, `MFA field '${f}' was lost`).toContain(f);
    }
  });

  it("every /api/partner path the client calls is served by a real partner route", () => {
    const clientPaths = [...partnerApi.matchAll(/"\/api\/partner(\/[^"$`]*)?"/g)]
      .map((m) => (m[1] ?? "").replace(/\/$/, ""))
      .filter((p) => p.length > 0);
    expect(clientPaths.length).toBeGreaterThan(10);

    const serverSide = routes + read("server", "partner", "public-routes.ts");
    const submissionRoutes = read("server", "partner", "submission-routes.ts");
    const customerRoutes = read("server", "partner", "customer-routes.ts");
    const dashboardRoutes = read("server", "partner", "dashboard-routes.ts");
    const all = serverSide + submissionRoutes + customerRoutes + dashboardRoutes;

    const registered = new Set(
      [...all.matchAll(/\br\.(?:get|post|patch|put|delete)\(\s*"([^"]+)"/g)].map((m) => m[1].replace(/\/$/, ""))
    );

    const missing = clientPaths.filter((p) => !registered.has(p));
    expect(missing, `client calls partner paths with no server route: ${missing.join(", ")}`).toEqual([]);
  });
});

/** Conflict 3 — client/src/pages/partner/security.tsx. */
describe("the Portal security page keeps BOTH sides' controls", () => {
  it("keeps this branch's active-sessions list and per-session revoke", () => {
    expect(securityPage).toContain("partnerSessions.list()");
    expect(securityPage).toContain("partnerSessions.revoke(sessionId)");
    expect(securityPage).toContain("async function revokeSession(");
  });

  it("keeps origin/main's two-step verification card and recovery-code regeneration", () => {
    expect(securityPage).toContain('import { PartnerMfaEnrolment } from "@/components/partner/partner-mfa-enrolment";');
    expect(securityPage).toMatch(/<PartnerMfaEnrolment[\s/>]/);
    expect(securityPage).toContain("partnerMfa.regenerateRecoveryCodes(");
    expect(securityPage).toContain("function askForPassword(");
    expect(securityPage).toContain("async function handlePasswordSubmit(");
    expect(securityPage).toContain("async function handleEnrolmentComplete(");
  });

  it("imports every symbol both sides need, from one import each", () => {
    expect(securityPage).toMatch(/import \{[^}]*partnerMfa[^}]*partnerSessions[^}]*\} from "@\/lib\/partner-api";/s);
    expect(securityPage).toContain("const { session, refresh } = usePartnerSession();");
    expect(securityPage).toContain("const qc = useQueryClient();");
  });
});

/** Conflict 4 — tests/partner-submission-workflow.test.ts. */
describe("the submission-workflow suite keeps BOTH sides' setup", () => {
  it("keeps this branch's realistic-role, fixture and G6D migration setup", () => {
    expect(submissionWorkflow).toContain("provisionRealisticRoles(admin)");
    expect(submissionWorkflow).toContain("seedMintVaultTables()");
    expect(submissionWorkflow).toContain("PARTNER_MIGRATIONS_WITH_G6D");
  });

  it("keeps origin/main's cluster-unique login role and never reintroduces the shared name", () => {
    expect(submissionWorkflow).toContain("CREATE ROLE partner_app_test_rt");
    // Only SQL role statements matter here; prose may still name the retired role to explain why
    // it was retired. A bare `partner_app_test` in CREATE/DROP/GRANT would reintroduce the
    // cluster-wide collision that origin/main deliberately fixed.
    const roleStatements = submissionWorkflow.match(/(?:CREATE|DROP) ROLE (?:IF EXISTS )?\S+|GRANT \S+ TO \S+/g) ?? [];
    expect(roleStatements.length).toBeGreaterThan(0);
    expect(roleStatements.filter((s) => /\bpartner_app_test\b/.test(s))).toEqual([]);
  });

  it("that role name matches PARTNER_RT_RUNTIME in the CI workflow", () => {
    const url = ci.match(/PARTNER_RT_RUNTIME:\s*\S*?:\/\/([^:]+):/);
    expect(url, "PARTNER_RT_RUNTIME is not set in .github/workflows/ci.yml").not.toBeNull();
    expect(submissionWorkflow).toContain(`CREATE ROLE ${url![1]}`);
  });
});

/** Conflict 5 — tests/partner-credit-reservation-service.test.ts. */
describe("the credit-reservation rollback guard keeps a superset of both sides", () => {
  it("uses the numeric journal predicate that subsumes main's per-filename deletes", () => {
    expect(creditReservation).toContain("substring(filename FROM '^([0-9]+)_')::integer > 17");
  });

  it("does not regress to naming individual migrations, which rots at the next one", () => {
    expect(creditReservation).not.toContain("filename = '0035_partner_certificate_origin.sql'");
    expect(creditReservation).not.toContain("filename = '0034_partner_rbac_seed.sql'");
  });
});

/** Conflict 6 — tests/partner-schema-parity.test.ts, the migration inventory tripwire. */
describe("the migration inventory pin keeps BOTH sides' migrations", () => {
  it("lists origin/main's 0035 and this branch's 0041/0042/0043", () => {
    for (const m of [
      "0035_partner_certificate_origin.sql",
      "0041_partner_submission_credit_lifecycle.sql",
      "0042_partner_per_card_credit_settlement.sql",
      "0043_partner_credit_hold_per_card.sql",
    ]) {
      expect(schemaParity, `migration ${m} was dropped from the inventory pin`).toContain(m);
    }
  });

  it("lists them in lexical order, as the sorted directory listing requires", () => {
    const order = ["0035_partner", "0041_partner", "0042_partner", "0043_partner"].map((m) =>
      schemaParity.indexOf(`"${m}`)
    );
    expect(order.every((v) => v > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

/** Conflict 7 — tests/partner-rls-isolation.test.ts, the two-suite split. */
describe("the RLS proof keeps BOTH harnesses", () => {
  const rlsCode = stripComments(rlsSuite);

  it("keeps this branch's self-provisioned restricted-LOGIN suite", () => {
    expect(rlsSuite).toContain('describe("Partner RLS tenant isolation (real PostgreSQL, restricted runtime role)"');
    expect(rlsCode).toContain("startPostgres17(");
    expect(rlsCode).toContain("async function assertRlsHarness(");
    expect(rlsSuite).toContain("NOSUPERUSER NOBYPASSRLS");
    expect(rlsSuite).toContain("set_config('app.tenant_id', $1, true)");
  });

  it("keeps origin/main's PARTNER_RLS_DB adversarial suite and its CI wiring guard", () => {
    expect(rlsSuite).toContain('describe("Partner RLS isolation coverage is wired up"');
    expect(rlsSuite).toContain('(isLocal ? describe : describe.skip)("Partner RLS tenant isolation (disposable DB)"');
    expect(rlsSuite).toContain("set_config('app.tenant_id', $1, false)");
    expect(rlsCode).toContain("async function asPartner(");
  });

  it("does not shadow the global URL constructor, which suite 1 needs", () => {
    expect(rlsCode).not.toMatch(/^const URL\s*=/m);
    expect(rlsCode).toContain("new URL(cluster.url)");
  });

  it("keeps the tenant-hop and money-immutability proofs main contributed", () => {
    expect(rlsSuite).toContain("tenant-hop is refused");
    expect(rlsSuite).toContain("the credit ledger is immutable even to the table OWNER");
  });

  it("keeps the per-card holds table in this branch's money-path sweep", () => {
    expect(rlsSuite).toContain("partner_submission_credit_holds");
  });
});
