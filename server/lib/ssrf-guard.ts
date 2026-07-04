import { lookup } from "dns/promises";
import net from "net";

/**
 * SSRF guard for server-side fetches of operator-supplied URLs (e.g. the
 * weekly-reel notification webhook). Blocks the classic pivot from a
 * compromised admin session to the cloud metadata endpoint / internal
 * services: requires https, and rejects any URL whose host is — or resolves
 * to — a private, loopback, link-local (incl. 169.254 metadata) or ULA
 * (incl. Fly's fdaa: 6PN) address.
 *
 * Residual gap: a DNS-rebind between this resolve and the actual fetch is not
 * closed here (that needs connecting to the pinned IP). Acceptable for an
 * admin-only, best-effort webhook — this stops every literal-IP and
 * hostname-to-metadata attack, which is the realistic threat.
 */

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP/Azure metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (incl. 192.0.0.192 alt metadata)
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true; // loopback / unspecified
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // ULA incl. Fly 6PN (fdaa:)
  if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true; // link-local
  if (s.startsWith("::ffff:")) return isPrivateIPv4(s.slice("::ffff:".length)); // IPv4-mapped
  return false;
}

function isPrivateIP(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v === 6) return isPrivateIPv6(ip);
  return true; // not a parseable IP — reject
}

/** Throws if `raw` is not a safe, public https URL. Returns the parsed URL. */
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid webhook URL");
  }
  if (u.protocol !== "https:") throw new Error("webhook URL must use https");
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip [] from IPv6 literals
  if (net.isIP(host) && isPrivateIP(host)) {
    throw new Error("webhook host is a private/internal address");
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("webhook host could not be resolved");
  }
  if (!addrs.length || addrs.some((a) => isPrivateIP(a.address))) {
    throw new Error("webhook host resolves to a private/internal address");
  }
  return u;
}
