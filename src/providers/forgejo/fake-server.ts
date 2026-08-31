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
        payload: field(fixture, "payload") ?? field(fixture, "body"),
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

export interface ForgejoEventTableRow {
  name: string;
  rawFamily: string;
  semantic: string | null;
  signal: "incomplete_label" | "incomplete_review" | null;
}

export const FORGEJO_EVENT_TABLE: readonly ForgejoEventTableRow[] = [
  {
    name: "issues-opened",
    rawFamily: "forgejo.issues",
    semantic: "forgejo.issue_created",
    signal: null,
  },
  {
    name: "issue-comment-created",
    rawFamily: "forgejo.issue_comment",
    semantic: "forgejo.issue_comment_created",
    signal: null,
  },
  {
    name: "issue-label-updated",
    rawFamily: "forgejo.issues",
    semantic: "forgejo.issue_label_added",
    signal: "incomplete_label",
  },
  {
    name: "pull-request-opened",
    rawFamily: "forgejo.pull_request",
    semantic: "forgejo.pull_request_created",
    signal: null,
  },
  {
    name: "pull-request-comment-created",
    rawFamily: "forgejo.issue_comment",
    semantic: "forgejo.pull_request_comment_created",
    signal: null,
  },
  {
    name: "pull-request-label-updated",
    rawFamily: "forgejo.pull_request",
    semantic: "forgejo.pull_request_label_added",
    signal: "incomplete_label",
  },
  {
    name: "pull-request-review-submitted",
    rawFamily: "forgejo.pull_request_review",
    semantic: null,
    signal: "incomplete_review",
  },
  {
    name: "push-default-branch",
    rawFamily: "forgejo.push",
    semantic: null,
    signal: null,
  },
  { name: "push-any", rawFamily: "forgejo.push", semantic: null, signal: null },
];
