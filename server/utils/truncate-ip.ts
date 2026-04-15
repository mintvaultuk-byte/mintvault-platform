/**
 * Truncate IP addresses for proportionate logging per ICO guidance.
 * IPv4: replaces last octet with "x" → "192.168.1.x"
 * IPv6: keeps first 4 groups → "2001:db8:85a3::"
 */
export function truncateIp(ip: string | undefined | null): string {
  if (!ip) return "unknown";
  const cleaned = ip.replace(/^::ffff:/, ""); // strip IPv4-mapped prefix

  if (cleaned.includes(":")) {
    // IPv6 — keep first 4 groups
    const groups = cleaned.split(":");
    return groups.slice(0, 4).join(":") + "::";
  }
  // IPv4 — replace last octet
  const parts = cleaned.split(".");
  if (parts.length === 4) {
    parts[3] = "x";
    return parts.join(".");
  }
  return "unknown";
}
