import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { field, list, readJson, record, text } from "./contract-test-read.js";

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "contract-fixtures");

export interface ForgejoContractDelivery {
  name: string;
  file: string;
  event: string;
  eventType: string;
  action: string | null;
  semantic: string | null;
  incompleteLabelSignal: boolean;
  incompleteReviewSignal: boolean;
  headers: Record<string, unknown>;
  raw: string;
  payload: unknown;
}

export interface ForgejoContractFixtures {
  secret: string;
  origin: string;
  deliveries: readonly ForgejoContractDelivery[];
  hydration: Readonly<Record<string, unknown>>;
}

export async function loadForgejoContractFixtures(
  root = fixturesRoot,
): Promise<ForgejoContractFixtures> {
  const manifest = record(await readJson(join(root, "manifest.json")), "manifest");
  const hydrationFiles = record(field(manifest, "hydration"), "hydration");
  const hydration: Record<string, unknown> = {};
  for (const key of Object.keys(hydrationFiles)) {
    hydration[key] = await readJson(join(root, text(hydrationFiles[key], key)));
  }
  const deliveries = await Promise.all(
    list(field(manifest, "deliveries"), "deliveries").map(async (entry) => {
      const named = record(entry, "delivery");
      const name = text(field(named, "name"), "name");
      const file = text(field(named, "file"), "file");
      const fixture = record(await readJson(join(root, file)), name);
      const action = field(named, "action");
      const semantic = field(named, "semantic");
      return {
        name,
        file,
        event: text(field(named, "event"), "event"),
        eventType: text(field(named, "eventType"), "eventType"),
        action: action === null ? null : text(action, "action"),
        semantic: semantic === null ? null : text(semantic, "semantic"),
        incompleteLabelSignal: field(named, "incompleteLabelSignal") === true,
        incompleteReviewSignal: field(named, "incompleteReviewSignal") === true,
        headers: record(field(fixture, "headers"), `${name} headers`),
        raw: text(field(fixture, "raw"), `${name} raw`),
        payload: field(fixture, "payload"),
      };
    }),
  );
  return {
    secret: text(field(manifest, "secret"), "secret"),
    origin: text(field(manifest, "origin"), "origin"),
    deliveries,
    hydration,
  };
}

export function deliveryByName(
  fixtures: ForgejoContractFixtures,
  name: string,
): ForgejoContractDelivery {
  const found = fixtures.deliveries.find((delivery) => delivery.name === name);
  if (found === undefined) throw new Error(`unknown Forgejo delivery ${name}`);
  return found;
}
