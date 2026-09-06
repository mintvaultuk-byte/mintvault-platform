import type { RequestHandler } from "express";

export const RETIRED_SCAN_INGEST_RESPONSE = {
  error: "Unbound scanner ingest is retired. Arm a certificate-side capture session before scanning.",
} as const;

/**
 * This handler must be mounted as the sole route handler. In particular, no
 * authentication, body parser, or multipart middleware may precede the 410:
 * the retired endpoint has no successful caller and must consume no upload.
 */
export const refuseRetiredScanIngest: RequestHandler = (_req, res) => {
  res.status(410).json(RETIRED_SCAN_INGEST_RESPONSE);
};
