import { isIP } from "node:net";
import { Resolver } from "node:dns/promises";

export type ApprovedOriginFailure =
  | "invalid_url"
  | "not_https"
  | "userinfo_present"
  | "non_origin_components"
  | "private_network_forbidden"
  | "origin_drift"
  | "unsafe_redirect";

export class ApprovedOriginError extends Error {
  readonly code: ApprovedOriginFailure;

  constructor(code: ApprovedOriginFailure, message: string) {
    super(message);
    this.name = "ApprovedOriginError";
    this.code = code;
  }
}

export interface DnsResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface CanonicalHttpsOrigin {
  origin: string;
  hostname: string;
  port: number;
  allowPrivateNetwork: boolean;
}

const BLOCKED_V4 = new Set(["169.254.169.254"]);
const BLOCKED_V6 = new Set(["fd00:ec2::254"]);

export function nodeDnsResolver(): DnsResolver {
  const resolver = new Resolver();
  return {
    async resolve(hostname) {
      if (isIP(hostname) !== 0) return [hostname];
      const [v4, v6] = await Promise.all([
        resolver.resolve4(hostname).catch(() => [] as string[]),
        resolver.resolve6(hostname).catch(() => [] as string[]),
      ]);
      return [...v4, ...v6];
    },
  };
}

export function canonicalizeHttpsOrigin(
  value: string,
  options: { allowPrivateNetwork: boolean },
): CanonicalHttpsOrigin {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApprovedOriginError("invalid_url", "Forgejo origin is not a URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ApprovedOriginError("not_https", "Forgejo origin must be https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ApprovedOriginError("userinfo_present", "Forgejo origin must not include userinfo");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ApprovedOriginError(
      "non_origin_components",
      "Forgejo origin must not include query or fragment",
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new ApprovedOriginError(
      "non_origin_components",
      "Forgejo origin must not include a path",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  const port = parsed.port === "" ? 443 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ApprovedOriginError("invalid_url", "Forgejo origin port is invalid");
  }
  const origin = port === 443 ? `https://${hostname}` : `https://${hostname}:${String(port)}`;
  return { origin, hostname, port, allowPrivateNetwork: options.allowPrivateNetwork };
}

export async function assertResolvedAddressesAllowed(
  origin: CanonicalHttpsOrigin,
  resolver: DnsResolver,
): Promise<readonly string[]> {
  const addresses = await resolver.resolve(origin.hostname);
  if (addresses.length === 0) {
    throw new ApprovedOriginError("origin_drift", "Forgejo origin did not resolve");
  }
  for (const address of addresses) {
    if (
      isBlockedAddress(address) ||
      (isPrivateOrLocalAddress(address) && !origin.allowPrivateNetwork)
    ) {
      throw new ApprovedOriginError(
        "private_network_forbidden",
        "Forgejo origin resolves to a disallowed address",
      );
    }
  }
  return addresses;
}

export function rejectRedirectStatus(status: number): void {
  if (status >= 300 && status < 400) {
    throw new ApprovedOriginError("unsafe_redirect", "Forgejo responses must not redirect");
  }
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return BLOCKED_V4.has(normalized) || BLOCKED_V6.has(normalized);
}

function isPrivateOrLocalAddress(address: string): boolean {
  if (address === "127.0.0.1" || address === "::1" || address === "0.0.0.0") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("10.")) return true;
  if (address.startsWith("192.168.")) return true;
  if (address.startsWith("169.254.")) return true;
  if (
    address.startsWith("::ffff:127.") ||
    address.startsWith("::ffff:10.") ||
    address.startsWith("::ffff:192.168.")
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (v4) {
    const second = Number(v4[2]);
    return v4[1] === "172" && second >= 16 && second <= 31;
  }
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}
