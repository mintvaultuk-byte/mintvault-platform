import fs from "node:fs";
import path from "node:path";

/**
 * Static extractor for Express route registrations. Reads the route source
 * files as text and pulls out every `app.<method>("...")` / `router.<method>("...")`
 * call. Deliberately source-based (no `import` of the server) so it needs no
 * database, no env, and cannot trip the boot-time migrations that
 * `registerRoutes()` fires (server/routes.ts).
 *
 * Used by tests/route-inventory.test.ts as the route-uniqueness safety net.
 */

export interface RouteRegistration {
  method: string; // upper-case HTTP verb, e.g. "GET"
  path: string; // the literal path string, e.g. "/api/admin/stats"
  key: string; // "GET /api/admin/stats"
  file: string; // repo-relative source file
}

// Matches `app.get("/x"`, `router.post('/y'`, `app.all(`/z`` — verb + first
// string-literal argument. Dynamically-built paths (template interpolation,
// variables) are intentionally skipped: they are not part of the duplicate
// surface we are guarding.
const ROUTE_REGEX = /\b(?:app|router)\.(get|post|put|patch|delete|all)\(\s*[`"']([^`"']+)[`"']/g;

/** The set of source files that register routes (monolith + modular + nested). */
export function routeSourceFiles(root = process.cwd()): string[] {
  const files: string[] = [path.join(root, "server/routes.ts")];
  for (const dir of ["server/routes", "server/routes/admin"]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith(".ts")) files.push(path.join(abs, f));
    }
  }
  return files.filter((f) => fs.existsSync(f));
}

export function extractRouteRegistrations(root = process.cwd()): RouteRegistration[] {
  const regs: RouteRegistration[] = [];
  for (const file of routeSourceFiles(root)) {
    const src = fs.readFileSync(file, "utf8");
    ROUTE_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ROUTE_REGEX.exec(src))) {
      const method = m[1].toUpperCase();
      const p = m[2];
      regs.push({ method, path: p, key: `${method} ${p}`, file: path.relative(root, file) });
    }
  }
  return regs;
}

/** Map of method+path -> registration count, restricted to keys seen >1 time. */
export function duplicateRouteKeys(regs: RouteRegistration[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of regs) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  return new Map([...counts].filter(([, c]) => c > 1));
}
