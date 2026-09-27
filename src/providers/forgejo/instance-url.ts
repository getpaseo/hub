// split out of client.ts since these are pure string/url utilities several files need
// without pulling in the whole api client

// built by hand: new URL(path, base) resolves an absolute path against the origin
// and would silently drop a subpath like /forge
export function apiUrl(instanceBaseUrl: string, path: string): string {
  return `${normalizeInstanceBaseUrl(instanceBaseUrl)}/api/v1${path}`;
}

// trailing slashes stripped so the stored value and the built url agree
export function normalizeInstanceBaseUrl(instanceBaseUrl: string): string {
  return instanceBaseUrl.replace(/\/+$/u, "");
}

// only validates shape, not reachability. http is accepted since a lan or tunnel
// instance often has no certificate in front of it. a private or link-local host is a
// separate question decided at request time by guarded-fetch.ts / instance-guard.ts,
// which is what turns a typed address into 400 instance_address_blocked instead of an
// ssrf, not this function
export function readInstanceBaseUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  // not parsed.href: a bare "?" or "#" parses to empty search/hash but href still
  // carries the punctuation
  return normalizeInstanceBaseUrl(parsed.origin + parsed.pathname);
}
