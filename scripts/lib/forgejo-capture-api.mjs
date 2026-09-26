import { createServer } from "node:net";

/** Mint a personal access token for a freshly created user via HTTP basic auth. */
export async function mintToken(base, user) {
  const res = await fetch(`${base}/api/v1/users/${user.username}/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${user.username}:${user.password}`).toString("base64")}`,
    },
    body: JSON.stringify({
      name: "fixture-capture",
      scopes: ["write:repository", "write:issue", "write:user", "write:organization"],
    }),
  });
  if (!res.ok) throw new Error(`minting token for ${user.username} failed: ${res.status}`);
  const json = await res.json();
  return json.sha1;
}

/** A tiny token-authenticated JSON client, bound to one user. */
export function apiClient(base, token) {
  return async function call(method, urlPath, jsonBody) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { "content-type": "application/json", authorization: `token ${token}` },
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text.slice(0, 500)}`);
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
  };
}

/** Ask the OS for a free TCP port by binding to port 0 and reading it back. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
