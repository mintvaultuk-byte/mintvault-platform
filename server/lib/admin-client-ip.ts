import type { Request } from "express";
import { isIP } from "node:net";

const UNRESOLVED_ADMIN_CLIENT_IP = "admin-client-ip-unresolved";

function scalarHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0].trim() : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes(",") ? trimmed : null;
}

/**
 * Return one stable textual representation for an IP address. IPv4-mapped IPv6 is folded back to
 * IPv4 so a direct/local socket and an allowlist entry cannot disagree only because Node exposed
 * the same address in a different family notation.
 */
export function canonicalAdminIp(value: string | undefined | null): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.includes("%") || candidate.includes(",")) return null;

  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family !== 6) return null;

  let canonical: string;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    canonical = hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }

  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const upper = Number.parseInt(mapped[1], 16);
  const lower = Number.parseInt(mapped[2], 16);
  return `${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`;
}

function isPrivateIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isFlyRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.FLY_APP_NAME || env.FLY_MACHINE_ID);
}

/**
 * Resolve the network identity used only by protected Admin controls.
 *
 * Fly's public HTTP service overwrites Fly-Client-IP and Fly-Forwarded-Port at its edge, then
 * reaches this IPv4-bound service from a private IPv4 peer. X-Forwarded-For is intentionally not
 * consulted: Fly preserves caller-supplied entries in that header. Requiring both the private
 * proxy peer and Fly's overwritten headers also prevents a process on the Machine from forging an
 * edge request over localhost.
 *
 * Outside Fly (local development and direct tests), only the socket peer is authoritative. This
 * keeps direct requests working without making Express's global trust-proxy setting part of the
 * Admin security boundary.
 */
export function resolveAdminClientIp(req: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  const socketIp = canonicalAdminIp(req.socket.remoteAddress);
  if (!isFlyRuntime(env)) return socketIp;

  if (!socketIp || !isPrivateIpv4(socketIp)) return null;

  const forwardedPort = scalarHeader(req, "fly-forwarded-port");
  if (!forwardedPort || !/^\d{1,5}$/.test(forwardedPort)) return null;
  const port = Number(forwardedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  return canonicalAdminIp(scalarHeader(req, "fly-client-ip"));
}

/** One shared fail-closed key prevents an unresolvable request from gaining fresh rate buckets. */
export function adminClientIpRateLimitKey(req: Request): string {
  return resolveAdminClientIp(req) ?? UNRESOLVED_ADMIN_CLIENT_IP;
}
