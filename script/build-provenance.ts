const GIT_SHA_PATTERN = /^[a-f0-9]{7,40}$/i;

function normalizedGitSha(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return GIT_SHA_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

export interface BuildProvenanceInput {
  checkoutSha?: string | null;
  environmentSha?: string | null;
  production: boolean;
}

/**
 * Resolve the source identity embedded into a build artifact.
 *
 * A developer checkout can identify itself from Git. A Docker production build
 * deliberately excludes `.git`, so it must receive a valid GIT_SHA build arg.
 * Refusing the latter prevents `/api/version` from silently serving `unknown`.
 */
export function resolveBuildGitSha({ checkoutSha, environmentSha, production }: BuildProvenanceInput): string {
  const sha = normalizedGitSha(checkoutSha) ?? normalizedGitSha(environmentSha);
  if (sha) return sha;
  if (production) {
    throw new Error(
      "Production build provenance is required: pass a 7–40 character hexadecimal GIT_SHA build argument"
    );
  }
  return "unknown";
}
