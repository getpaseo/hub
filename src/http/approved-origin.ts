import { Buffer } from "node:buffer";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";

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

export function pinnedAddressLookup(
  expectedHostname: string,
  addresses: readonly string[],
): LookupFunction {
  const entries: LookupAddress[] = addresses.map((address) => ({
    address,
    family: isIP(address) === 6 ? 6 : 4,
  }));
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      callback(lookupFailure("Forgejo origin hostname drifted"), "", 0);
      return;
    }
    const first = entries[0];
    if (first === undefined) {
      callback(lookupFailure("Forgejo origin did not resolve"), "", 0);
      return;
    }
    if (options.all === true) {
      callback(null, entries);
      return;
    }
    callback(null, first.address, first.family);
  };
}

export async function fetchPinnedHttps(
  url: string,
  init: RequestInit,
  origin: CanonicalHttpsOrigin,
  addresses: readonly string[],
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== origin.hostname) {
    throw new ApprovedOriginError("origin_drift", "Forgejo origin drifted");
  }
  return await requestPinnedHttps(parsed, init, origin, addresses);
}

export function rejectRedirectStatus(status: number): void {
  if (status >= 300 && status < 400) {
    throw new ApprovedOriginError("unsafe_redirect", "Forgejo responses must not redirect");
  }
}

function requestPinnedHttps(
  parsed: URL,
  init: RequestInit,
  origin: CanonicalHttpsOrigin,
  addresses: readonly string[],
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: parsed.hostname,
        port: origin.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: requestMethod(init.method),
        headers: requestHeaders(init.headers),
        servername: origin.hostname,
        lookup: pinnedAddressLookup(origin.hostname, addresses),
      },
      (incoming) => {
        void collectIncoming(incoming).then(
          (body) =>
            resolve(
              new Response(Uint8Array.from(body), {
                status: incoming.statusCode ?? 0,
                headers: incomingResponseHeaders(incoming),
              }),
            ),
          reject,
        );
      },
    );
    request.on("error", reject);
    attachAbort(init.signal ?? undefined, request, reject);
    if (typeof init.body === "string") request.write(init.body);
    request.end();
  });
}

function requestMethod(method: RequestInit["method"]): string {
  if (typeof method === "string" && method.length > 0) return method.toUpperCase();
  return "GET";
}

function requestHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const resolved = new Headers(headers);
  const record: Record<string, string> = {};
  resolved.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function collectIncoming(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    incoming.on("end", () => resolve(Buffer.concat(chunks)));
    incoming.on("error", reject);
  });
}

function incomingResponseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

function attachAbort(
  signal: AbortSignal | undefined,
  request: ReturnType<typeof https.request>,
  reject: (error: unknown) => void,
): void {
  if (signal === undefined) return;
  const abort = () => {
    request.destroy();
    reject(signal.reason ?? new ApprovedOriginError("origin_drift", "Forgejo request aborted"));
  };
  if (signal.aborted) {
    abort();
    return;
  }
  signal.addEventListener("abort", abort, { once: true });
}

function lookupFailure(message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = "ENOTFOUND";
  return error;
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
