import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPublicImageProcessingAdmission } from "../server/lib/public-image-processing-admission";

const source = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

function routeBlock(text: string, route: string, nextRoute?: string): string {
  const start = text.indexOf(`"${route}"`);
  if (start < 0) throw new Error(`missing route ${route}`);
  const end = nextRoute ? text.indexOf(`"${nextRoute}"`, start + route.length) : text.length;
  return text.slice(start, end < 0 ? text.length : end);
}

function responseDouble() {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
    status: (code: number) => typeof response;
    json: (body: unknown) => typeof response;
    setHeader: (name: string, value: string) => void;
  };
  response.statusCode = 200;
  response.body = null;
  response.headers = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = String(value);
  };
  return response;
}

describe("public abuse and body-admission boundaries", () => {
  it("mounts a shared fail-closed store on every unauthenticated account mail, credential, and token mutation", () => {
    const index = source("server/index.ts");
    const mailMount = index.slice(
      index.indexOf('for (const path of [\n  "/api/auth/signup"'),
      index.indexOf("for (const path of [\n", index.indexOf('"/api/auth/signup"') + 1)
    );
    for (const route of [
      "/api/auth/signup",
      "/api/auth/forgot-password",
      "/api/auth/magic-link",
      "/api/customer/magic-link",
      "/api/auth/pin/forgot",
    ]) {
      expect(mailMount, `POST ${route}`).toContain(`"${route}"`);
    }
    expect(mailMount).toContain("app.post(path, authMailRateLimit)");

    const credentialMount = index.slice(
      index.indexOf('for (const path of ["/api/auth/login"'),
      index.indexOf('app.get("/api/customer/verify/:token"')
    );
    for (const route of ["/api/auth/login", "/api/auth/reset-password", "/api/auth/pin/login", "/api/auth/pin/setup"]) {
      expect(credentialMount, `POST ${route}`).toContain(`"${route}"`);
    }
    expect(credentialMount).toContain("app.post(path, authCredentialRateLimit)");

    for (const route of [
      "/api/customer/verify/:token",
      "/api/auth/magic-link/verify",
      "/auth/pin/reset/:token",
      "/api/auth/verify-email",
    ]) {
      expect(index, `GET ${route}`).toContain(`app.get("${route}", authTokenConsumeRateLimit)`);
    }
    expect(index).not.toMatch(/app\.use\(["']\/api\/(?:auth|customer)/);
    expect(source("server/lib/public-auth-rate-limit.ts")).toContain("passOnStoreError: false");
  });

  it("keeps public paid/image work behind fleet quota and process admission before multer", () => {
    const preGrade = source("server/routes/pre-grade.ts");
    for (const [route, next] of [
      ["/api/pre-grade", "/api/pre-grade/preview"],
      ["/api/pre-grade/preview", undefined],
    ] as const) {
      const block = routeBlock(preGrade, route, next);
      expect(block.indexOf("RateLimit"), route).toBeGreaterThanOrEqual(0);
      expect(block.indexOf("publicImageProcessingAdmission.middleware"), route).toBeGreaterThan(
        block.indexOf("RateLimit")
      );
      expect(block.search(/preGradeUpload\.(?:fields|single)/), route).toBeGreaterThan(
        block.indexOf("publicImageProcessingAdmission.middleware")
      );
    }
    expect(preGrade).toContain('namespace: "pre_grade_ai"');
    expect(preGrade).toContain('namespace: "pre_grade_preview"');

    const routes = source("server/routes.ts");
    const estimate = routeBlock(routes, "/api/tools/estimate", "/api/tools/value");
    expect(estimate.indexOf("estimateRateLimit")).toBeGreaterThanOrEqual(0);
    expect(estimate.indexOf("publicImageProcessingAdmission.middleware")).toBeGreaterThan(
      estimate.indexOf("estimateRateLimit")
    );
    expect(estimate.indexOf('toolsUpload.single("image")')).toBeGreaterThan(
      estimate.indexOf("publicImageProcessingAdmission.middleware")
    );
    expect(estimate.indexOf("consumeEstimateCredit(")).toBeGreaterThan(estimate.indexOf('toolsUpload.single("image")'));
  });

  it("shares one process admission budget and releases it exactly once", () => {
    const admission = createPublicImageProcessingAdmission(1);
    const first = responseDouble();
    const firstNext = vi.fn();
    admission.middleware({} as never, first as never, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();

    const second = responseDouble();
    const secondNext = vi.fn();
    admission.middleware({} as never, second as never, secondNext);
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.statusCode).toBe(503);
    expect(second.headers["retry-after"]).toBe("5");
    expect(admission.stats()).toEqual({ active: 1, max: 1, rejected: 1 });

    first.emit("finish");
    first.emit("close");
    expect(admission.stats()).toEqual({ active: 0, max: 1, rejected: 1 });
  });

  it("uses Express's resolved peer address and bans leftmost XFF parsing in security keys and audits", () => {
    for (const filename of [
      "server/routes.ts",
      "server/routes/auth.ts",
      "server/routes/public.ts",
      "server/routes/submissions.ts",
      "server/showroom.ts",
      "server/lib/rate-limiters.ts",
    ]) {
      expect(source(filename), filename).not.toMatch(/x-forwarded-for/i);
    }
    expect(source("server/lib/public-auth-rate-limit.ts")).toContain("req.ip || req.socket.remoteAddress");
    expect(source("server/lib/shared-public-rate-limit.ts")).toContain("req.ip || req.socket.remoteAddress");
  });

  it("uses independent shared namespaces for every public mail or persistence abuse surface", () => {
    const publicRoutes = source("server/routes/public.ts");
    for (const namespace of ["waitlist", "contact_mail", "partner_application_mail", "mvgs_interest"]) {
      expect(publicRoutes).toContain(`namespace: "${namespace}"`);
    }
    expect(publicRoutes).not.toMatch(
      /const (?:waitlist|contact|partnerApplication|mvgsInterest)RateLimit = rateLimit\(/
    );

    const store = source("server/lib/public-auth-rate-limit-store-pg.ts");
    expect(store).toContain("LIMIT 5000");
    expect(store).toContain("WHERE reset_at <= now()");
    expect(store).toContain("private bucket(key: string)");
    expect(source("server/lib/shared-public-rate-limit.ts")).toContain(
      "keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket.remoteAddress"
    );
  });

  it("does not put submitted addresses or secret fingerprints in operational logs", () => {
    const publicRoutes = source("server/routes/public.ts");
    expect(publicRoutes).not.toMatch(/\[contact\][^\n]*\$\{email\}/);

    const estimate = routeBlock(source("server/routes.ts"), "/api/tools/estimate", "/api/tools/value");
    expect(estimate).not.toMatch(/ANTHROPIC_API_KEY present|apiKey\?\.length|apiKey\.length/);
  });
});
