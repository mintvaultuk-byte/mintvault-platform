import type { NextFunction, Request, Response } from "express";
import { isCommandCentreEnabledRuntime } from "./flag";

/**
 * Keep disabled Command Centre routes undiscoverable before any auth work.
 * Route-specific Super Admin authorization remains in the canonical auth
 * middleware and is deliberately not duplicated here.
 */
export async function requireCommandCentreEnabled(
  _request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (!(await isCommandCentreEnabledRuntime())) {
    response.status(404).json({ error: "Not found" });
    return;
  }

  next();
}
