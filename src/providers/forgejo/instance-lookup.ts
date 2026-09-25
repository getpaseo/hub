import { isIP } from "node:net";
import { lookup as nodeDnsLookup } from "node:dns";
import { promisify } from "node:util";
import type { LookupFunction } from "node:net";
import {
  assertDialable,
  narrowAddressFamily,
  stripHostnameBrackets,
  type ForgejoAllowedPrivateHosts,
} from "./instance-guard.js";

// resolves one instance hostname, checks it against instance-guard's refused ranges, and
// hands back the single address to dial. runs on every connection attempt through the
// agent, not just the first, so a dns record that changes after a connection is stored
// still gets checked again here and a later rebind can't bypass it.

const dnsLookup = promisify(nodeDnsLookup);

// defaults to dns.lookup, injectable so tests can fake a hostname resolving to an
// arbitrary address without a real dns query
export type RawForgejoLookup = (hostname: string) => Promise<{ address: string; family: number }>;

const defaultLookup: RawForgejoLookup = (hostname) => dnsLookup(hostname);

interface VettedAddress {
  address: string;
  family: 4 | 6;
}

// net.isIP/dns.lookup report family as a plain number, not the narrower literal type
// this module works with; turns an undocumented value into a loud failure
function addressFamily(value: number): 4 | 6 {
  const family = narrowAddressFamily(value);
  if (family === undefined) throw new Error(`unexpected address family: ${value}`);
  return family;
}

async function resolveVettedAddress(
  hostname: string,
  allowlist: ForgejoAllowedPrivateHosts,
  lookup: RawForgejoLookup,
): Promise<VettedAddress> {
  const bare = stripHostnameBrackets(hostname);
  const literalFamily = isIP(bare);
  let resolved: VettedAddress;
  if (literalFamily !== 0) {
    resolved = { address: bare, family: addressFamily(literalFamily) };
  } else {
    const answer = await lookup(bare);
    resolved = { address: answer.address, family: addressFamily(answer.family) };
  }
  assertDialable(bare, resolved.address, allowlist);
  return resolved;
}

// net.connect calls a custom lookup with options.all set when autoSelectFamily applies
// (default since node 20), expecting an array back; handles both forms
export function createForgejoLookup(
  allowlist: ForgejoAllowedPrivateHosts,
  lookup: RawForgejoLookup = defaultLookup,
): LookupFunction {
  return (hostname, options, callback) => {
    const wantsAll =
      typeof options === "object" && options !== null && "all" in options && options.all === true;
    void answerLookup(hostname, allowlist, lookup, wantsAll, callback);
  };
}

async function answerLookup(
  hostname: string,
  allowlist: ForgejoAllowedPrivateHosts,
  lookup: RawForgejoLookup,
  wantsAll: boolean,
  callback: Parameters<LookupFunction>[2],
): Promise<void> {
  try {
    const vetted = await resolveVettedAddress(hostname, allowlist, lookup);
    if (wantsAll) {
      callback(null, [{ address: vetted.address, family: vetted.family }]);
    } else {
      callback(null, vetted.address, vetted.family);
    }
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)), "");
  }
}
