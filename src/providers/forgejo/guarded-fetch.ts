import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { createForgejoLookup, type RawForgejoLookup } from "./instance-lookup.js";
import {
  assertDialable,
  stripHostnameBrackets,
  type ForgejoAllowedPrivateHosts,
} from "./instance-guard.js";

// pairs an undici Agent whose dns resolution is the guarded lookup with undici's own
// fetch, not node's global one: the Agent's connect.lookup option is read by undici's
// connector internals, so both have to come from the same undici build. a literal IP in
// the url needs its own check before the Agent ever gets involved, since net.connect
// skips a custom lookup entirely when the host is already a valid IP, so this wrapper
// checks a literal IP itself before dialing.
export function createGuardedForgejoFetch(
  allowlist: ForgejoAllowedPrivateHosts,
  lookup?: RawForgejoLookup,
): typeof fetch {
  const dispatcher = new Agent({ connect: { lookup: createForgejoLookup(allowlist, lookup) } });
  const guarded = async (url: string, init: RequestInit): Promise<Response> => {
    const hostname = stripHostnameBrackets(new URL(url).hostname);
    if (isIP(hostname) !== 0) {
      assertDialable(hostname, hostname, allowlist);
    }
    // undici's fetch types are declared against its own lib, not lib.dom, but describe
    // the same wire behaviour this file and client.ts rely on; the cast is just the seam
    // between the two type declarations
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return undiciFetch(url, { ...init, dispatcher } as never) as unknown as Promise<Response>;
  };
  // guarded's signature is narrower than typeof fetch only because every real caller
  // here supplies a plain url string
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return guarded as unknown as typeof fetch;
}
