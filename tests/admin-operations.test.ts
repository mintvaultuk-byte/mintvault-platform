import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import {
  escapeLikePattern,
  isEligibleOperationsSearchQuery,
  maskEmail,
  normaliseOperationsSearchQuery,
  operationsSearchPattern,
  OPERATIONS_RESULTS_PER_TYPE,
} from "../server/services/admin-operations";

// The registration and denial tests never issue a database query. Supplying a
// disposable-looking URL lets their module imports initialise without touching
// a real database when the test process has no local .env file.
process.env.MINTVAULT_DATABASE_URL ??= "postgres://mintvault:mintvault@127.0.0.1:65432/mintvault_test";

const { requireSuperAdmin } = await import("../server/auth");
const { registerAdminOperationsRoutes } = await import("../server/routes/admin-operations");

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

type RegisteredHandler = (...args: unknown[]) => unknown;
type RegisteredRoute = { path: string; handlers: RegisteredHandler[] };

function registeredOperationsRoutes(): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  registerAdminOperationsRoutes({
    get(path: string, ...handlers: RegisteredHandler[]) {
      routes.push({ path, handlers });
    },
  } as unknown as Express);
  return routes;
}

async function runMiddleware(session: Record<string, unknown> | undefined) {
  let statusCode = 200;
  let body: unknown;
  await requireSuperAdmin(
    { session } as unknown as Request,
    {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    } as unknown as Response,
    () => undefined
  );
  return { statusCode, body };
}

describe("Super Admin operations search helpers", () => {
  it("normalises and bounds malformed input before it reaches a query", () => {
    expect(normaliseOperationsSearchQuery("  Pikachu\n   Base  ")).toBe("Pikachu Base");
    expect(normaliseOperationsSearchQuery("x".repeat(100))).toHaveLength(80);
    expect(normaliseOperationsSearchQuery({ q: "nope" })).toBe("");
  });

  it("requires a useful search length, except for exact numeric identifiers", () => {
    expect(isEligibleOperationsSearchQuery("")).toBe(false);
    expect(isEligibleOperationsSearchQuery("M")).toBe(false);
    expect(isEligibleOperationsSearchQuery("42")).toBe(true);
    expect(isEligibleOperationsSearchQuery("MV42")).toBe(true);
  });

  it("escapes wildcard input while retaining parameter-safe search values", () => {
    expect(escapeLikePattern("100%_\\safe")).toBe("100\\%\\_\\\\safe");
    expect(operationsSearchPattern("100%_\\safe")).toBe("%100\\%\\_\\\\safe%");
  });

  it("masks customer and staff emails in result projections", () => {
    expect(maskEmail("person@example.test")).toBe("pe…@example.test");
    expect(maskEmail("a@example.test")).toBe("a…@example.test");
    expect(maskEmail(null)).toBeNull();
  });
});

describe("Super Admin operations route security", () => {
  const routes = registeredOperationsRoutes();

  it("registers both operational reads behind requireSuperAdmin", () => {
    expect(routes.map((route) => route.path)).toEqual([
      "/api/admin/operations/attention",
      "/api/admin/operations/search",
    ]);
    for (const route of routes) expect(route.handlers[0]).toBe(requireSuperAdmin);
  });

  it("denies unauthenticated and ordinary staff/grader sessions before any operation handler", async () => {
    const anonymous = await runMiddleware(undefined);
    expect(anonymous.statusCode).toBe(401);

    const grader = await runMiddleware({ isGrader: true });
    expect(grader.statusCode).toBe(403);
    expect(grader.body).toEqual({ error: "Forbidden: graders cannot access admin endpoints" });
  });

  it("rejects a malformed or too-short API search before a database query is attempted", async () => {
    const route = routes.find((candidate) => candidate.path.endsWith("/search"))!;
    let statusCode = 200;
    let body: unknown;
    await route.handlers[1](
      { query: { q: "x" } },
      {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(value: unknown) {
          body = value;
        },
      }
    );
    expect(statusCode).toBe(400);
    expect(body).toEqual({ error: "Enter at least two characters, or an exact numeric identifier." });
  });
});

describe("Super Admin operations implementation guardrails", () => {
  const routeSource = read("server/routes/admin-operations.ts");
  const clientSource = read("client/src/components/admin/operations-dashboard.tsx");

  it("keeps the new API read-only, parameterised, bounded, and private-note free", () => {
    expect(routeSource).toContain("requireSuperAdmin");
    expect(routeSource).toContain("operationsSearchPattern(query)");
    expect(routeSource).toContain("ESCAPE '\\\\'");
    expect(routeSource).toContain(`LIMIT \${OPERATIONS_RESULTS_PER_TYPE}`);
    expect(routeSource).not.toMatch(/app\.(post|put|patch|delete)\("\/api\/admin\/operations/);
    for (const privateField of ["private_notes", "password_hash", "pin_hash", "return_address", "phone"]) {
      expect(routeSource).not.toContain(privateField);
    }
  });

  it("keeps search debounced, cancellable, grouped, and keyboard accessible", () => {
    expect(clientSource).toContain("useDebouncedValue(query.trim())");
    expect(clientSource).toContain("signal");
    expect(clientSource).toContain('role="combobox"');
    expect(clientSource).toContain('role="listbox"');
    expect(clientSource).toContain("ArrowDown");
    expect(clientSource).toContain("Certificates");
    expect(clientSource).toContain("Submissions");
    expect(clientSource).toContain("Staff");
    expect(clientSource).toContain("Partners");
  });

  it("uses a fixed server-side per-type result cap", () => {
    expect(OPERATIONS_RESULTS_PER_TYPE).toBe(8);
  });
});
