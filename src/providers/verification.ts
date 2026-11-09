import { ProviderVerificationError } from "../provider-applications/index.js";
export async function fixedRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await request(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new ProviderVerificationError(timeout ? "timeout" : "network", undefined, {
      cause: safeTransportCause(error),
    });
  }
}

function safeTransportCause(error: unknown): Error {
  if (!(error instanceof Error)) return new Error("provider transport failed");
  const diagnostic = new Error("provider transport failed");
  diagnostic.name = error.name;
  const frames = error.stack?.split("\n").slice(1).join("\n");
  if (frames !== undefined && frames.length > 0) {
    diagnostic.stack = `${diagnostic.name}: ${diagnostic.message}\n${frames}`;
  }
  const code: unknown = Reflect.get(error, "code");
  if (typeof code === "string" && /^[A-Z0-9_]+$/u.test(code)) {
    Object.assign(diagnostic, { code });
  }
  return diagnostic;
}

export function rejectFailedResponse(response: Response): void {
  if (response.ok) return;
  if (response.status === 429) throw new ProviderVerificationError("rateLimited", response.status);
  throw new ProviderVerificationError("upstreamUnavailable", response.status);
}

export async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
