/** Answers a request whose method the route does not serve, naming the ones it does. */
export function methodNotAllowed(allow: string): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: allow } });
}
