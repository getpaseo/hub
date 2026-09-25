import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Real Forgejo webhook deliveries, captured by scripts/capture-forgejo-fixtures.mjs
 * and re-signed against this fixed secret. action-run-failure/success.json are
 * hand-built from the Go structs instead, since this tool has no Actions runner.
 */
export const FORGEJO_FIXTURE_SECRET = "forty-two-is-not-a-secret";

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

const CapturedDeliverySchema = z.object({
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

export interface ForgejoDeliveryFixture {
  headers: Record<string, string>;
  body: string;
  payload: unknown;
}

/** Load a captured delivery by its file name (without `.json`). */
export function loadForgejoDelivery(name: string): ForgejoDeliveryFixture {
  const raw = readFileSync(path.join(FIXTURES_DIR, `${name}.json`), "utf8");
  const fixture = CapturedDeliverySchema.parse(JSON.parse(raw));
  return { ...fixture, payload: JSON.parse(fixture.body) };
}

/** Load a saved plain API response (timeline, hook creation, ...) by file name. */
export function loadForgejoApiFixture(name: string): unknown {
  const raw = readFileSync(path.join(FIXTURES_DIR, "api", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

/** Build the exact Request the Forgejo webhook endpoint would see for a captured
 * delivery. Every fixture is already signed against FORGEJO_FIXTURE_SECRET. */
export function forgejoRequest(name: string, connectionId: string): Request {
  const fixture = loadForgejoDelivery(name);
  return new Request(`https://hub.example.test/api/integrations/forgejo/events/${connectionId}`, {
    method: "POST",
    headers: new Headers(fixture.headers),
    body: fixture.body,
  });
}
