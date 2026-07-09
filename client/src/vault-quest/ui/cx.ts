// Tiny classnames joiner — local so the vault-quest/ UI stays dependency-free
// and liftable (no import from MintVault utils).
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
