export type HotFolderUploadSide = "front" | "back";

/** Reject malformed multipart fields instead of coercing every typo to `back`. */
export function parseHotFolderUploadSide(raw: unknown): HotFolderUploadSide | null {
  if (raw === undefined || raw === null || raw === "") return "front";
  return raw === "front" || raw === "back" ? raw : null;
}
