import { createHash, createHmac } from "node:crypto";

// Scrubbing and re-signing for captured Forgejo webhook deliveries. The container's
// real origin and the docker-internal DNS name aren't secrets but aren't fixture
// hostnames either, so both get rewritten to `.test` names. That changes the body's
// bytes, which invalidates the original signature headers, so every signature is
// recomputed here against the scrubbed bytes and the fixed fixture secret.

export const FIXTURE_WEBHOOK_SECRET = "forty-two-is-not-a-secret";

/** Replace the container's real origin and container-only hostname with fixture ones. */
export function scrubText(text, forgejoOrigin) {
  return (
    text
      .split(forgejoOrigin)
      .join("https://git.example.test")
      .replaceAll(/http:\/\/host\.containers\.internal(?::\d+)?/gu, "https://hub.example.test")
      // The `http(s)://localhost:PORT` spelling above is caught by the `forgejoOrigin`
      // split, but Forgejo's `ssh_url` carries `ssh://git@localhost/...` with no port,
      // which never matches that exact string. Rewrite it to the same fixture host.
      .replaceAll(/ssh:\/\/git@localhost(?::\d+)?\//gu, "ssh://git@git.example.test/")
      .replaceAll("@example.test.local", "@example.test")
      .replaceAll("@noreply.localhost", "@example.test")
  );
}

/** Recompute every signature header Forgejo sends, over the scrubbed body. */
export function resignHeaders(headers, scrubbedBody, secret = FIXTURE_WEBHOOK_SECRET) {
  const sha256 = createHmac("sha256", secret).update(scrubbedBody).digest("hex");
  const sha1 = createHmac("sha1", secret).update(scrubbedBody).digest("hex");
  const next = { ...headers };
  if ("x-forgejo-signature" in next) next["x-forgejo-signature"] = sha256;
  if ("x-gitea-signature" in next) next["x-gitea-signature"] = sha256;
  if ("x-gogs-signature" in next) next["x-gogs-signature"] = sha256;
  if ("x-hub-signature-256" in next) next["x-hub-signature-256"] = `sha256=${sha256}`;
  if ("x-hub-signature" in next) next["x-hub-signature"] = `sha1=${sha1}`;
  if ("content-length" in next) next["content-length"] = String(Buffer.byteLength(scrubbedBody));
  return next;
}

/** Keep only the headers a fixture reader or the webhook verifier could plausibly want. */
export function relevantHeaders(headers) {
  const kept = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^x-(forgejo|gitea|gogs|github|hub)-/u.test(key) || key === "content-type") {
      kept[key] = value;
    }
  }
  return kept;
}

export function hashSignature(signature) {
  return createHash("sha256").update(signature).digest("hex");
}
