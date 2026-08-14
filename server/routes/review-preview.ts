/**
 * Registers the two overlapping Pending Review route families in declaration
 * order. The label-preview route is intentionally first: Express would
 * otherwise interpret `certificates/label/preview` as the generic
 * `certificates/:id/:action` proxy (`id = "label"`, `action = "preview"`).
 *
 * Keeping this ordering beside the registrations makes the authority boundary
 * explicit and gives the routing regression test a small production-equivalent
 * surface to exercise without booting every application route.
 */
import type { Express } from "express";
import { registerLabelPreviewRoutes } from "./admin/label-preview";
import { registerGraderRoutes } from "./grader";

export function registerReviewPreviewRoutes(app: Express): void {
  registerLabelPreviewRoutes(app);
  registerGraderRoutes(app);
}
