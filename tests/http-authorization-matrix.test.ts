import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
// SCANNER_API_TOKEN + dummy DB env are set in tests/helpers/test-env.ts, imported
// first by the harness below. The scanner token literal here matches that value.
import { buildAuthHarness, startHarness, httpRequest, type HarnessServer } from "./helpers/auth-harness";
import { extractRouteRegistrations } from "./helpers/extract-routes";

let srv: HarnessServer;

beforeAll(async () => {
  srv = await startHarness(buildAuthHarness());
});
afterAll(async () => {
  await srv?.close();
});

// ── session principals (what a real login would have produced) ────────────────
const ROLE = {
  anonymous: undefined as Record<string, unknown> | undefined,
  legacyCustomer: { customerEmail: "cust@example.com" },
  unifiedUser: { userId: "user-uuid-1", userEmail: "u@example.com" },
  grader: { isGrader: true, graderId: "grader-uuid-1", graderEmail: "g@example.com" },
  staffGrade: { isStaff: true, staffId: "staff-uuid-1", capGrade: true },
  staffScan: { isStaff: true, staffId: "staff-uuid-1", capScan: true },
  staffPrint: { isStaff: true, staffId: "staff-uuid-1", capPrint: true },
  staffNoCaps: { isStaff: true, staffId: "staff-uuid-1" },
  admin: { isAdmin: true, adminEmail: "admin@example.com" },
};

interface CallOpts {
  session?: Record<string, unknown>;
  origin?: string;
  referer?: string;
  xff?: string;
  scannerToken?: string;
  graderProxyHeader?: boolean;
  fixture?: unknown;
  fixtureAssignment?: unknown;
  body?: string | Buffer;
  contentType?: string;
}

function call(method: string, p: string, o: CallOpts = {}) {
  const headers: Record<string, string> = {};
  if (o.session) headers["x-test-session"] = JSON.stringify(o.session);
  if (o.origin) headers["Origin"] = o.origin;
  if (o.referer) headers["Referer"] = o.referer;
  if (o.xff) headers["X-Forwarded-For"] = o.xff;
  if (o.scannerToken) headers["X-Scanner-Token"] = o.scannerToken;
  if (o.graderProxyHeader) headers["x-grader-proxy"] = "true"; // forge attempt
  if (o.fixture !== undefined) headers["x-fixture-submission"] = JSON.stringify(o.fixture);
  if (o.fixtureAssignment !== undefined) headers["x-fixture-assignment"] = JSON.stringify(o.fixtureAssignment);
  if (o.body !== undefined) headers["Content-Type"] = o.contentType ?? "application/json";
  return httpRequest(srv.port, method, p, { headers, body: o.body });
}

const sameOrigin = () => `http://127.0.0.1:${srv.port}`;

// ─────────────────────────────────────────────────────────────────────────────
describe("requireAdmin — role enforcement + grader dual-role denial", () => {
  it("admin → 200", async () => {
    const r = await call("GET", "/api/admin/ping", { session: ROLE.admin });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("admin");
  });
  it("anonymous → 401", async () => {
    expect((await call("GET", "/api/admin/ping")).status).toBe(401);
  });
  it("grader → 403 (explicit role denial, NOT 401)", async () => {
    const r = await call("GET", "/api/admin/ping", { session: ROLE.grader });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/graders cannot access admin/i);
  });
  it("staff / customer / user → 401", async () => {
    for (const s of [ROLE.staffGrade, ROLE.legacyCustomer, ROLE.unifiedUser]) {
      expect((await call("GET", "/api/admin/ping", { session: s })).status).toBe(401);
    }
  });
});

describe("requireAuth (unified user)", () => {
  it("unified user → 200; everyone without userId → 401", async () => {
    expect((await call("GET", "/api/auth/me", { session: ROLE.unifiedUser })).status).toBe(200);
    const anon = await call("GET", "/api/auth/me");
    expect(anon.status).toBe(401);
    expect(anon.json.error).toBe("auth_required");
    expect((await call("GET", "/api/auth/me", { session: ROLE.admin })).status).toBe(401);
    expect((await call("GET", "/api/auth/me", { session: ROLE.legacyCustomer })).status).toBe(401);
  });
});

describe("requireCustomer (legacy customer)", () => {
  it("legacy customer → 200; anonymous + non-customer → 401", async () => {
    expect((await call("GET", "/api/customer/ping", { session: ROLE.legacyCustomer })).status).toBe(200);
    expect((await call("GET", "/api/customer/ping")).status).toBe(401);
    expect((await call("GET", "/api/customer/ping", { session: ROLE.unifiedUser })).status).toBe(401);
  });
});

describe("requireGrader / requireStaff — mutually exclusive with admin", () => {
  it("grader → 200 on grader; admin is NOT a grader (401)", async () => {
    expect((await call("GET", "/api/grader/ping", { session: ROLE.grader })).status).toBe(200);
    expect((await call("GET", "/api/grader/ping", { session: ROLE.admin })).status).toBe(401);
    expect((await call("GET", "/api/grader/ping")).status).toBe(401);
  });
  it("staff → 200 on staff; admin is NOT staff (401)", async () => {
    expect((await call("GET", "/api/staff/ping", { session: ROLE.staffGrade })).status).toBe(200);
    expect((await call("GET", "/api/staff/ping", { session: ROLE.admin })).status).toBe(401);
    expect((await call("GET", "/api/staff/ping")).status).toBe(401);
  });
});

describe("staff capability flags (can_grade / can_scan / can_print)", () => {
  const cases: Array<[string, keyof typeof ROLE]> = [
    ["/api/staff/grade", "staffGrade"],
    ["/api/staff/scan", "staffScan"],
    ["/api/staff/print", "staffPrint"],
  ];
  it("each capability route allows only the matching capability", async () => {
    for (const [path, holder] of cases) {
      expect((await call("GET", path, { session: ROLE[holder] })).status).toBe(200);
      // staff WITHOUT the capability → 403
      const other = holder === "staffGrade" ? ROLE.staffScan : ROLE.staffGrade;
      const r = await call("GET", path, { session: other });
      expect(r.status).toBe(403);
      expect(r.json.error).toMatch(/missing '.*' capability/);
      // no-capability staff → 403; anonymous → 401; admin → 401
      expect((await call("GET", path, { session: ROLE.staffNoCaps })).status).toBe(403);
      expect((await call("GET", path)).status).toBe(401);
      expect((await call("GET", path, { session: ROLE.admin })).status).toBe(401);
    }
  });
});

describe("scanner token — requireScannerOrAdmin + CSRF exemption", () => {
  const TOKEN = "test-scanner-token-value-1234567890";
  it("valid scanner token → 200 even cross-origin (CSRF-exempt)", async () => {
    const r = await call("POST", "/api/scan-ingest/ping", { scannerToken: TOKEN, origin: "http://evil.example" });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("scanner");
  });
  it("admin cookie (no token) → 200; invalid/none → 401; grader → 403", async () => {
    expect((await call("POST", "/api/scan-ingest/ping", { session: ROLE.admin })).status).toBe(200);
    expect((await call("POST", "/api/scan-ingest/ping", { scannerToken: "wrong" })).status).toBe(401);
    expect((await call("POST", "/api/scan-ingest/ping")).status).toBe(401);
    expect((await call("POST", "/api/scan-ingest/ping", { session: ROLE.grader })).status).toBe(403);
  });
});

describe("CSRF same-origin / cross-origin / no-Origin", () => {
  it("cross-origin POST → 403", async () => {
    const r = await call("POST", "/api/test/csrf", { origin: "http://evil.example" });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/cross-origin/i);
  });
  it("same-origin POST → 200", async () => {
    expect((await call("POST", "/api/test/csrf", { origin: sameOrigin() })).status).toBe(200);
  });
  it("no-Origin POST → 200 (non-browser client; absence can't be forged)", async () => {
    expect((await call("POST", "/api/test/csrf")).status).toBe(200);
  });
  it("cross-origin via Referer mismatch → 403", async () => {
    const r = await call("POST", "/api/test/csrf", { referer: "http://evil.example/x" });
    expect(r.status).toBe(403);
  });
  it("safe GET is never CSRF-blocked even cross-origin", async () => {
    expect((await call("GET", "/api/admin/ping", { session: ROLE.admin, origin: "http://evil.example" })).status).toBe(
      200
    );
  });
});

describe("Stripe webhook — raw body + CSRF/path exemption", () => {
  it("cross-origin POST reaches the raw-body handler (not 403)", async () => {
    const r = await call("POST", "/api/stripe/webhook", {
      origin: "http://evil.example",
      body: Buffer.from('{"id":"evt_test"}'),
      contentType: "application/json",
    });
    expect(r.status).toBe(200);
    expect(r.json.rawBody).toBe(true); // received as a Buffer, not JSON-parsed
    expect(r.json.len).toBeGreaterThan(0);
  });
});

describe("customer document download — BOLA/IDOR (real authorizeSubmissionDownload)", () => {
  const ownedByEmail = { customer_email: "cust@example.com", status: "ready" };
  it("owner (by email) → 200", async () => {
    const r = await call("POST", "/api/customer/submissions/s1/doc", {
      session: ROLE.legacyCustomer,
      fixture: ownedByEmail,
    });
    expect(r.status).toBe(200);
  });
  it("DIFFERENT customer → 404 (indistinguishable from missing)", async () => {
    const r = await call("POST", "/api/customer/submissions/s1/doc", {
      session: { customerEmail: "attacker@example.com" },
      fixture: ownedByEmail,
    });
    expect(r.status).toBe(404);
  });
  it("owned but draft → 400", async () => {
    const r = await call("POST", "/api/customer/submissions/s1/doc", {
      session: ROLE.legacyCustomer,
      fixture: { customer_email: "cust@example.com", status: "draft" },
    });
    expect(r.status).toBe(400);
  });
  it("owner by unified userId → 200", async () => {
    const r = await call("POST", "/api/customer/submissions/s1/doc", {
      session: ROLE.unifiedUser, // has customerEmail? no — requireCustomer needs customerEmail
      fixture: { user_id: "user-uuid-1", status: "ready" },
    });
    // unifiedUser has no customerEmail → requireCustomer blocks first (401)
    expect(r.status).toBe(401);
  });
  it("customer session + userId ownership → 200", async () => {
    const r = await call("POST", "/api/customer/submissions/s1/doc", {
      session: { customerEmail: "someone@example.com", userId: "user-uuid-1" },
      fixture: { user_id: "user-uuid-1", customer_email: "different@example.com", status: "ready" },
    });
    expect(r.status).toBe(200); // matched on userId even though email differs
  });
  it("missing submission → 404; no customer session → 401", async () => {
    expect(
      (await call("POST", "/api/customer/submissions/s1/doc", { session: ROLE.legacyCustomer, fixture: null })).status
    ).toBe(404);
    expect((await call("POST", "/api/customer/submissions/s1/doc", { fixture: ownedByEmail })).status).toBe(401);
  });
});

describe("admin reprint endpoint — guarded; legacy reprint endpoint absent", () => {
  it("reprint path requires admin (grader → 403, anon → 401, admin → 200)", async () => {
    expect((await call("POST", "/api/admin/print-batch/reprint", { session: ROLE.admin })).status).toBe(200);
    expect((await call("POST", "/api/admin/print-batch/reprint", { session: ROLE.grader })).status).toBe(403);
    expect((await call("POST", "/api/admin/print-batch/reprint")).status).toBe(401);
  });
  it("the ONLY reprint route is POST /api/admin/print-batch/reprint (no legacy /api/admin/reprint)", () => {
    const regs = extractRouteRegistrations();
    const reprint = regs.filter((r) => r.path.includes("reprint")).map((r) => r.key);
    expect(reprint).toEqual(["POST /api/admin/print-batch/reprint"]);
    expect(regs.some((r) => r.path === "/api/admin/reprint")).toBe(false);
  });
});

describe("generic correlated 5xx + safe logging (real two-layer wiring)", () => {
  it("thrown handler: final handler emits {message}, interceptor collapses to {error,requestId}; no leak", async () => {
    const r = await call("GET", "/api/boom");
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "Internal Server Error", requestId: expect.any(String) });
    expect(r.headers["x-request-id"]).toBeTruthy();
    expect(r.json.requestId).toBe(r.headers["x-request-id"]);
    for (const leak of ["postgres://", "pw@", "token=", "sk_live", "a@b.com"]) {
      expect(r.text).not.toContain(leak);
    }
  });
  it("a handler returning a RAW 5xx body with secrets → interceptor scrubs it directly", async () => {
    const r = await call("GET", "/api/raw5xx");
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "Internal Server Error", requestId: expect.any(String) });
    for (const leak of ["postgres://", "token=", "sk_live", "a@b.com", "secret"]) {
      expect(r.text).not.toContain(leak);
    }
  });
});

describe("grader→admin __graderProxy escalation — in-app only, not client-forgeable", () => {
  it("the verified in-app proxy flag lets a grader request reach an admin handler", async () => {
    const r = await call("GET", "/api/_harness/grader-proxy", { session: ROLE.grader });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("admin-via-grader-proxy");
  });
  it("a client CANNOT forge __graderProxy via query / header / body — requireAdmin still denies", async () => {
    // query string
    expect((await call("GET", "/api/admin/ping?__graderProxy=true", { session: ROLE.grader })).status).toBe(403);
    // forged header
    expect((await call("GET", "/api/admin/ping", { session: ROLE.grader, graderProxyHeader: true })).status).toBe(403);
    // forged body on the reprint route (no-Origin → CSRF passes; guard still denies)
    const r = await call("POST", "/api/admin/print-batch/reprint", {
      session: ROLE.grader,
      body: JSON.stringify({ __graderProxy: true }),
    });
    expect(r.status).toBe(403);
    // anonymous forging → 401, not bypassed
    expect((await call("GET", "/api/admin/ping?__graderProxy=true")).status).toBe(401);
  });
});

describe("grader per-object ownership — BOLA (representative of authorizeGraderCert)", () => {
  const mine = { assignedGraderId: "grader-uuid-1", gradingStatus: "assigned" };
  it("assigned to THIS grader + not approved → 200", async () => {
    expect(
      (await call("POST", "/api/grader/cert/42/act", { session: ROLE.grader, fixtureAssignment: mine })).status
    ).toBe(200);
  });
  it("assigned to ANOTHER grader → 403 (cannot touch a cert that isn't yours)", async () => {
    const r = await call("POST", "/api/grader/cert/42/act", {
      session: ROLE.grader,
      fixtureAssignment: { assignedGraderId: "grader-uuid-OTHER", gradingStatus: "assigned" },
    });
    expect(r.status).toBe(403);
  });
  it("already approved → 403; no assignment → 404; non-grader → 401", async () => {
    expect(
      (
        await call("POST", "/api/grader/cert/42/act", {
          session: ROLE.grader,
          fixtureAssignment: { assignedGraderId: "grader-uuid-1", gradingStatus: "approved" },
        })
      ).status
    ).toBe(403);
    expect((await call("POST", "/api/grader/cert/42/act", { session: ROLE.grader })).status).toBe(404);
    expect((await call("POST", "/api/grader/cert/42/act", { session: ROLE.admin })).status).toBe(401);
  });
  it("the REAL grader/scan ownership gates exist and are wired (static check)", () => {
    // authorizeGraderCert is DB-bound (getCertAssignment) + module-private, so it
    // can't run in a DB-less harness; confirm it's defined AND used as a gate, and
    // that authorizeScanCert (server/staff.ts) is the scanner equivalent.
    const grader = fs.readFileSync(path.join(process.cwd(), "server/routes/grader.ts"), "utf8");
    expect(/function authorizeGraderCert\(/.test(grader)).toBe(true);
    expect((grader.match(/authorizeGraderCert\(/g) || []).length).toBeGreaterThan(1); // def + ≥1 call site
    const staff = fs.readFileSync(path.join(process.cwd(), "server/staff.ts"), "utf8");
    expect(/function authorizeScanCert\(/.test(staff)).toBe(true);
  });
});

describe("trusted-proxy rate limiting (representative config)", () => {
  it("limits per X-Forwarded-For: 6th request from one IP → 429; a different IP is a fresh bucket", async () => {
    const ip = "203.0.113.7";
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await call("GET", "/api/rl/ping", { xff: ip })).status;
    expect(last).toBe(200);
    expect((await call("GET", "/api/rl/ping", { xff: ip })).status).toBe(429);
    // different forwarded IP → not limited
    expect((await call("GET", "/api/rl/ping", { xff: "203.0.113.99" })).status).toBe(200);
  });
});

describe("upload MIME + size limits (representative config)", () => {
  function multipart(filename: string, content: Buffer, contentType: string) {
    const boundary = "----mvtestboundary0987654321";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return { body: Buffer.concat([head, content, tail]), ct: `multipart/form-data; boundary=${boundary}` };
  }
  it("accepts an allowed image type", async () => {
    const m = multipart("card.png", Buffer.from("not-a-real-png-but-allowed-ext"), "image/png");
    const r = await call("POST", "/api/upload/ping", { body: m.body, contentType: m.ct });
    expect(r.status).toBe(200);
    expect(r.json.hasFile).toBe(true);
  });
  it("rejects a disallowed MIME/extension → 400", async () => {
    const m = multipart("evil.txt", Buffer.from("hello"), "text/plain");
    const r = await call("POST", "/api/upload/ping", { body: m.body, contentType: m.ct });
    expect(r.status).toBe(400);
  });
  it("rejects an over-size upload → 400", async () => {
    const m = multipart("big.png", Buffer.alloc(4096, 1), "image/png"); // 4KB > 1KB cap
    const r = await call("POST", "/api/upload/tiny", { body: m.body, contentType: m.ct });
    expect(r.status).toBe(400);
  });
});
