import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const DEFAULT_ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export interface UrlSafetyCheckResult {
  ok: boolean;
  reason?: string;
}

function parsePortList(value: string | undefined): Set<number> | null {
  if (!value) return null;
  const ports = value
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isInteger(v) && v > 0 && v < 65536);
  return ports.length ? new Set(ports) : null;
}

function allowedPorts(): Set<number> {
  return parsePortList(process.env["WEB_IMPORT_ALLOWED_PORTS"]) ??
    DEFAULT_ALLOWED_PORTS;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  // loopback 127.0.0.0/8
  if (a === 127) return true;
  // private 10.0.0.0/8
  if (a === 10) return true;
  // private 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // private 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // link-local 169.254.0.0/16 (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // multicast/reserved 224+
  if (a >= 224) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  // unique local fc00::/7
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // link-local fe80::/10
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  // IPv4-mapped ::ffff:x.x.x.x — extract and re-check
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateIP(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // unparseable IP → reject conservatively
}

/**
 * Validates a URL is safe to fetch from the server:
 * - Only http/https protocols
 * - Port must be in the allowlist
 * - Hostname must resolve to a public IP (blocks SSRF to loopback,
 *   RFC1918, link-local, cloud metadata, etc.)
 */
export async function assertUrlSafe(input: string): Promise<UrlSafetyCheckResult> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported-protocol" };
  }

  const port = url.port
    ? parseInt(url.port, 10)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (!allowedPorts().has(port)) {
    return { ok: false, reason: "port-not-allowed" };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) return { ok: false, reason: "private-ip" };
    return { ok: true };
  }

  // Block any hostname that explicitly names localhost variants
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower === "metadata.google.internal") {
    return { ok: false, reason: "private-host" };
  }

  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "dns-lookup-failed" };
  }

  if (records.length === 0) {
    return { ok: false, reason: "no-dns-records" };
  }

  for (const r of records) {
    if (isPrivateIP(r.address)) {
      return { ok: false, reason: "resolves-to-private-ip" };
    }
  }

  return { ok: true };
}
