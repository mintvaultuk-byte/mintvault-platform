/**
 * Server-side re-export of the MVGS scoring engine.
 *
 * Real implementation lives in shared/mvgs-scoring.ts so the client can
 * import the same pure function (`@shared/mvgs-scoring`) for live
 * preview in the grading panel. This shim keeps existing server callers
 * (server/grade-mapping.ts, server/routes.ts on approve) working without
 * path changes.
 */

export {
  computeMvgsScore,
  mvgsGradeLabel,
} from "@shared/mvgs-scoring";
export type {
  MvgsInput,
  MvgsResult,
  MvgsDefect,
} from "@shared/mvgs-scoring";
