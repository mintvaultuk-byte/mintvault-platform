import type { Express, Request, Response, NextFunction } from "express";
import { requireSuperAdmin } from "../auth";
import { buildProjectControlSnapshot, isProjectControlEnabled } from "../project-control/service";

async function requireProjectControlFlag(_req: Request, res: Response, next: NextFunction) {
  const enabled = await isProjectControlEnabled();
  if (!enabled) {
    return res.status(403).json({
      error: "Project Control unavailable",
      requirementIds: ["MEGS-PCD-006", "MEGS-PCD-007"],
      state: "blocked",
    });
  }
  return next();
}

async function snapshotOrUnavailable(res: Response) {
  try {
    return await buildProjectControlSnapshot();
  } catch {
    res.status(503).json({ error: "Project Control temporarily unavailable", state: "unknown" });
    return null;
  }
}

export function registerProjectControlRoutes(app: Express): void {
  const guards = [requireSuperAdmin, requireProjectControlFlag];

  app.get("/api/super-admin/project-control/summary", guards, async (_req: Request, res: Response) => {
    const snapshot = await snapshotOrUnavailable(res);
    if (!snapshot) return;
    res.json(snapshot.summary);
  });

  app.get("/api/super-admin/project-control/requirements", guards, async (_req: Request, res: Response) => {
    const snapshot = await snapshotOrUnavailable(res);
    if (!snapshot) return;
    res.json({ requirements: snapshot.requirements, statuses: snapshot.statuses });
  });

  app.get("/api/super-admin/project-control/requirements/:id", guards, async (req: Request, res: Response) => {
    const snapshot = await snapshotOrUnavailable(res);
    if (!snapshot) return;
    const requirement = snapshot.requirements.find((item) => item.id === req.params.id);
    if (!requirement) return res.status(404).json({ error: "Requirement not found" });
    const status = snapshot.statuses.find((item) => item.requirementId === requirement.id);
    const evidence = snapshot.evidence.filter((item) => item.requirementIds.includes(requirement.id));
    res.json({ requirement, status, evidence });
  });

  app.get("/api/super-admin/project-control/evidence", guards, async (_req: Request, res: Response) => {
    const snapshot = await snapshotOrUnavailable(res);
    if (!snapshot) return;
    res.json({ evidence: snapshot.evidence });
  });

  app.get("/api/super-admin/project-control/risks", guards, async (_req: Request, res: Response) => {
    const snapshot = await snapshotOrUnavailable(res);
    if (!snapshot) return;
    res.json({
      recommendations: snapshot.summary.recommendations,
      blocked: snapshot.statuses.filter((status) => status.blocked),
      stale: snapshot.statuses.filter((status) => status.stale),
    });
  });

  app.get("/api/super-admin/project-control/continuation-prompt", guards, async (_req: Request, res: Response) => {
    const snapshot = await snapshotOrUnavailable(res);
    if (!snapshot) return;
    res.json(snapshot.prompt);
  });
}
