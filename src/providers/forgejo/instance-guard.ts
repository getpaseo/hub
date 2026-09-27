import { BlockList, isIP } from "node:net";

// ssrf guard for an operator-supplied forgejo instance url. an org owner types the
// address and hub's server dials it, so on a shared hosted hub that's a way to reach
// cloud metadata, another tenant's container, or localhost on the hub host itself.
// every address hub connects to is checked against the ranges below unless the operator
// opted it back in. the per-connection enforcement lives in instance-lookup.ts.

export const FORGEJO_ALLOWED_PRIVATE_HOSTS_ENV = "FORGEJO_ALLOWED_PRIVATE_HOSTS";

// refused unless the operator opts a specific host or cidr back in: this network,
// loopback, rfc1918 private, link-local (incl. cloud metadata), unique local, cgnat,
// unspecified and multicast for both families, plus the IETF protocol assignments
// (192.0.0.0/24), benchmarking (198.18.0.0/15), the IPv4 documentation ranges, the
// limited-broadcast /4, and a handful of IPv6 ranges that embed or reach an address we'd
// otherwise miss: the deprecated IPv4-compatible range, the SIIT translated-address
// range, the NAT64 well-known prefixes, and 6to4. these are blocked wholesale rather
// than only for the addresses they embed, they're exotic enough nothing legitimate needs
// them. net.BlockList already unwraps the ordinary IPv4-mapped IPv6 form against the
// IPv4 rules, so only the SIIT form (one group deeper) needs its own rule here.
function buildBlockedRanges(): BlockList {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.0.0.0", 24, "ipv4");
  list.addSubnet("192.0.2.0", 24, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("198.18.0.0", 15, "ipv4");
  list.addSubnet("198.51.100.0", 24, "ipv4");
  list.addSubnet("203.0.113.0", 24, "ipv4");
  list.addSubnet("224.0.0.0", 4, "ipv4");
  list.addSubnet("240.0.0.0", 4, "ipv4");
  list.addSubnet("::", 96, "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("::ffff:0:0:0", 96, "ipv6");
  list.addSubnet("64:ff9b::", 96, "ipv6");
  list.addSubnet("64:ff9b:1::", 48, "ipv6");
  list.addSubnet("2002::", 16, "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  return list;
}

const BLOCKED_RANGES = buildBlockedRanges();

// the one place a raw family number gets narrowed at runtime, shared with
// instance-lookup.ts so the two never drift on what counts as a valid family
export function narrowAddressFamily(value: number): 4 | 6 | undefined {
  return value === 4 || value === 6 ? value : undefined;
}

export function addressFamilyName(address: string): "ipv4" | "ipv6" | undefined {
  const family = narrowAddressFamily(isIP(address));
  if (family === 4) return "ipv4";
  if (family === 6) return "ipv6";
  return undefined;
}

// an address that fails to parse as an IP at all is refused too, never guessed at
export function isBlockedAddress(address: string): boolean {
  const family = addressFamilyName(address);
  return family === undefined ? true : BLOCKED_RANGES.check(address, family);
}

// a URL's hostname keeps the brackets around a literal IPv6 address ([::1]); every
// address check needs the bare form instead
export function stripHostnameBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export interface ForgejoAllowedPrivateHosts {
  readonly hostnames: ReadonlySet<string>;
  readonly addresses: BlockList | undefined;
}

export const NO_ALLOWED_PRIVATE_HOSTS: ForgejoAllowedPrivateHosts = {
  hostnames: new Set(),
  addresses: undefined,
};

// comma-separated mix of hostnames and IPv4/IPv6 cidrs, a bare IP counts as a /32 or /128.
// throws on a malformed entry so a typo fails startup loudly instead of silently
// becoming a hostname nothing will ever match
export function parseAllowedPrivateHosts(value: string | undefined): ForgejoAllowedPrivateHosts {
  const hostnames = new Set<string>();
  let addresses: BlockList | undefined;
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const slash = entry.indexOf("/");
    if (slash === -1) {
      const family = addressFamilyName(entry);
      if (family === undefined) {
        hostnames.add(entry.toLowerCase());
        continue;
      }
      addresses ??= new BlockList();
      addresses.addSubnet(entry, family === "ipv4" ? 32 : 128, family);
      continue;
    }
    const base = entry.slice(0, slash);
    const prefixText = entry.slice(slash + 1);
    const family = addressFamilyName(base);
    if (family === undefined || !/^\d{1,3}$/u.test(prefixText)) {
      throw new Error(
        `${FORGEJO_ALLOWED_PRIVATE_HOSTS_ENV}: invalid entry "${entry}", expected a hostname or an IPv4/IPv6 CIDR`,
      );
    }
    const prefix = Number(prefixText);
    const maxPrefix = family === "ipv4" ? 32 : 128;
    if (prefix > maxPrefix) {
      throw new Error(
        `${FORGEJO_ALLOWED_PRIVATE_HOSTS_ENV}: invalid entry "${entry}", prefix exceeds ${maxPrefix} for ${family}`,
      );
    }
    addresses ??= new BlockList();
    addresses.addSubnet(base, prefix, family);
  }
  return { hostnames, addresses };
}

// calls straight into parseAllowedPrivateHosts, so a malformed override fails startup
// instead of silently allowing nothing
export function readAllowedPrivateHostsFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): ForgejoAllowedPrivateHosts {
  return parseAllowedPrivateHosts(environment[FORGEJO_ALLOWED_PRIVATE_HOSTS_ENV]);
}

export function isExceptedHostname(
  hostname: string,
  allowlist: ForgejoAllowedPrivateHosts,
): boolean {
  return allowlist.hostnames.has(hostname.toLowerCase());
}

export function isExceptedAddress(address: string, allowlist: ForgejoAllowedPrivateHosts): boolean {
  if (allowlist.addresses === undefined) return false;
  const family = addressFamilyName(address);
  return family !== undefined && allowlist.addresses.check(address, family);
}

// thrown when an instance host resolves to a refused address the operator hasn't
// excepted. surfaces through fetch wrapped in TypeError("fetch failed", { cause }),
// see unwrapForgejoInstanceBlockedError
export class ForgejoInstanceBlockedError extends Error {
  constructor(readonly hostname: string) {
    super(`forgejo instance host is not reachable from this hub: ${hostname}`);
    this.name = "ForgejoInstanceBlockedError";
  }
}

// the one blocked-and-not-excepted check every dial site makes before letting a
// connection through. throws instead of returning a boolean, since every caller's
// next step on a block is the same: refuse the dial
export function assertDialable(
  hostname: string,
  address: string,
  allowlist: ForgejoAllowedPrivateHosts,
): void {
  if (
    isBlockedAddress(address) &&
    !isExceptedHostname(hostname, allowlist) &&
    !isExceptedAddress(address, allowlist)
  ) {
    throw new ForgejoInstanceBlockedError(hostname);
  }
}

// finds the error at any depth of .cause chaining, node's fetch wraps a connector-level
// failure so the caller never sees the guard's own error directly
export function unwrapForgejoInstanceBlockedError(
  error: unknown,
): ForgejoInstanceBlockedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    if (current instanceof ForgejoInstanceBlockedError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}
