/**
 * Route → authorisation-gate extraction, for the authority guard over server/routes/grader.ts.
 *
 * ── WHY THIS EXISTS (hostile-review blind spot, 2026-08-07) ─────────────────────────────────
 * Both protected-diff guards key their protected-file matcher on `/server\/grader/`, which
 * matches `server/grader.ts` but NOT `server/routes/grader.ts`:
 *
 *     /server\/grader/.test("server/routes/grader.ts") === false
 *
 * PR #288 rewrote server/routes/grader.ts — five handlers re-gated requireAdmin →
 * requireSuperAdmin, a new /api/admin/graders/assign-partner endpoint, and partner mirroring
 * wired into approve/reject — and NO changed file in that PR matched `calcEngine` at all. The
 * guards saw nothing.
 *
 * ── WHY A ROUTE TABLE, NOT A FILE LOCK ─────────────────────────────────────────────────────
 * Adding `server/routes/grader.ts` to the existing `calcEngine` / `engine` regexes would make
 * EVERY edit to a 1,200-line HTTP layer require a founder signature — a blanket lock, which the
 * founder ruled out, and which is precisely the shape of guard the next engineer deletes.
 *
 * Instead the guard is scoped to what is actually authority-bearing in that file: which
 * middleware gates which route. That is derived from the CURRENT SOURCE rather than from a
 * diff, so it survives reformatting, reindentation and handler moves (PR #288 reindented four
 * handlers wholesale — a diff-shaped guard would have drowned in that), while a genuine
 * downgrade of a gate, or a new authority route landing ungated, fails immediately.
 *
 * Middleware names are read as CODE via the TypeScript parser, never by regex over text, so a
 * comment or a string containing "requireSuperAdmin" cannot fake a gate.
 */
import ts from "typescript";
import { stripToJs, stripNonCode } from "./strip-non-code";

export interface RouteRegistration {
  /** HTTP method as written: get / post / put / patch / delete / all / use. */
  method: string;
  /** The literal route path, or null if it was not a plain string literal. */
  path: string | null;
  /**
   * Middleware between the path and the final handler, rendered as source-ish names:
   * a bare identifier as `requireAdmin`, a call as `requireCapability("grade")`.
   */
  guards: string[];
  /** The final argument (the handler), reduced to executable JavaScript — no prose, no SQL text. */
  handlerCode: string;
  /**
   * The same handler in "guarded" form: executable JavaScript PLUS tagged-template (SQL) text,
   * unicode-decoded. Required to see a raw `sql\`UPDATE certificates SET grading_status = …\``
   * write, which the JS-only representation deliberately blanks. Never used for a signature
   * check — that separation is what keeps N5 closed.
   */
  handlerGuarded: string;
  /** 1-based line of the registration, for failure messages. */
  line: number;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

/** Render a middleware argument as a stable, comparable name. */
function guardName(arg: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isIdentifier(arg)) return arg.text;
  if (ts.isCallExpression(arg)) {
    const callee = arg.expression;
    const base = ts.isIdentifier(callee) ? callee.text : callee.getText(sf);
    return `${base}(${arg.arguments.map((a) => a.getText(sf)).join(", ")})`;
  }
  if (ts.isPropertyAccessExpression(arg)) return arg.getText(sf);
  return arg.getText(sf);
}

/**
 * Every `app.<method>(path, …middleware, handler)` registration in `source`.
 *
 * A registration with fewer than two arguments, or whose callee is not `<something>.<method>`
 * with a known HTTP method, is ignored — this reads route wiring, nothing else.
 */
export function routeRegistrations(source: string): RouteRegistration[] {
  const sf = ts.createSourceFile("__routes__.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: RouteRegistration[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const isApp = ts.isIdentifier(receiver) && (receiver.text === "app" || receiver.text === "router");
      if (isApp && HTTP_METHODS.has(method) && node.arguments.length >= 2) {
        const [pathArg, ...rest] = node.arguments;
        const handler = rest[rest.length - 1];
        const middleware = rest.slice(0, -1);
        out.push({
          method,
          path: ts.isStringLiteral(pathArg) || ts.isNoSubstitutionTemplateLiteral(pathArg) ? pathArg.text : null,
          guards: middleware.map((m) => guardName(m, sf)),
          // Reduced to executable JS so a comment or an error string mentioning an authority
          // helper cannot make a handler look authority-sensitive, or hide that it is.
          handlerCode: stripToJs(handler.getText(sf)),
          handlerGuarded: stripNonCode(handler.getText(sf)),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/**
 * The authority operations of the grading workflow. A route that CALLS one of these decides who
 * may approve, reject, author, assign or mirror a grade — so its gate is authority-bearing.
 *
 * Derived, not hard-coded per route: a NEW authority endpoint added later is caught by the same
 * rule, without anyone remembering to extend a list of paths.
 */
export const AUTHORITY_OPERATIONS = [
  "approveGraderCert",
  "rejectCertGrade",
  "adminReviewSaveDraft",
  "applyCertGradeDraft",
  "assignCerts",
  "reassignCerts",
  "unassignCerts",
  "assignPartnerCerts",
  "mirrorPartnerApproval",
  "mirrorPartnerRejection",
  "setGraderRate",
  "setGraderDailyTarget",
  "createGraderAccount",
] as const;

/** Authority operations a route's handler actually invokes (as CODE, not as text). */
export function authorityOperationsOf(route: RouteRegistration): string[] {
  return AUTHORITY_OPERATIONS.filter((op) => new RegExp(`\\b${op}\\s*\\(`).test(route.handlerCode));
}

/** True when this route decides grading authority and therefore must carry an approved gate. */
export function isAuthoritySensitive(route: RouteRegistration): boolean {
  return authorityOperationsOf(route).length > 0;
}

/** Stable key for pinning a route's expected gate. */
export const routeKey = (r: RouteRegistration): string => `${r.method.toUpperCase()} ${r.path ?? "<computed>"}`;
