import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export type HotFolderAdminAuthority = (req: Request, res: Response, next: NextFunction) => unknown;

function constantTimeTokenMatch(candidate: string, expected: string): boolean {
  const candidateDigest = crypto.createHash("sha256").update(candidate).digest();
  const expectedDigest = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

/**
 * Authenticate the legacy hot-folder uploader before multer buffers its body.
 * A browser Admin session and the dedicated watcher Bearer token retain their
 * existing authority; malformed, missing, or unconfigured token state refuses.
 */
export function createHotFolderUploadAuth(environment: NodeJS.ProcessEnv, adminAuthority: HotFolderAdminAuthority) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestSession = req.session as { isAdmin?: boolean } | undefined;
    if (requestSession?.isAdmin === true) {
      // Reuse the canonical live users-row, credential-version, deletion and
      // absolute-expiry authority. A cached cookie flag is never sufficient.
      void adminAuthority(req, res, next);
      return;
    }

    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+([^\s]+)$/i.exec(header.trim()) : null;
    const expected = environment.MINTVAULT_ADMIN_TOKEN?.trim() ?? "";
    if (!match || !expected || !constantTimeTokenMatch(match[1], expected)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
