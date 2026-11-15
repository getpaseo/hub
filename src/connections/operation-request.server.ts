import { getRequest } from "@tanstack/react-start/server";

/**
 * The request a connection action receives from a server function: the browser's own headers,
 * so the session and origin checks see the person, with the operation's input in the query.
 */
export function connectionOperationRequest(
  method: "GET" | "POST",
  path: string,
  params: Readonly<Record<string, string>>,
): Request {
  const incoming = getRequest();
  const headers = new Headers(incoming.headers);
  headers.delete("content-length");
  const url = new URL(path, incoming.url);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return new Request(url, {
    method,
    headers,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
