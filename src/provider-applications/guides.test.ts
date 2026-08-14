import assert from "node:assert/strict";
import { test } from "vitest";
import { load } from "js-yaml";
import { z } from "zod";
import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import {
  PROVIDER_GUIDES,
  guideFor,
  guideUrl,
  identityLabel,
  isSecureOrigin,
  slackManifest,
  statusPresentation,
} from "./guides.js";

const ORIGIN = "https://hub.example.com";
const manifestSchema = z.object({
  oauth_config: z.object({
    redirect_urls: z.array(z.string()),
    scopes: z.object({ bot: z.array(z.string()) }),
  }),
  settings: z.object({ event_subscriptions: z.object({ request_url: z.string() }) }),
});

test("the Slack manifest asks for exactly the scopes Hub checks installations against", () => {
  const manifest = manifestSchema.parse(load(slackManifest(ORIGIN)));
  assert.deepEqual(manifest.oauth_config.scopes.bot, [...SLACK_REQUIRED_BOT_SCOPES]);
  assert.deepEqual(manifest.oauth_config.redirect_urls, [
    `${ORIGIN}/api/integrations/slack/callback`,
  ]);
  assert.equal(
    manifest.settings.event_subscriptions.request_url,
    `${ORIGIN}/api/integrations/slack/events`,
  );
});

test("generated URLs are built from the resolved callback origin", () => {
  const github = guideFor("github");
  assert.deepEqual(
    github.urls.map((url) => guideUrl(ORIGIN, url.path)),
    [
      ORIGIN,
      `${ORIGIN}/api/integrations/github/callback`,
      `${ORIGIN}/api/integrations/github/setup`,
      `${ORIGIN}/webhook`,
    ],
  );
  assert.equal(
    guideUrl(ORIGIN, guideFor("discord").urls[0]!.path),
    `${ORIGIN}/api/integrations/discord/callback`,
  );
});

test("only a connection paints the surface green", () => {
  assert.equal(statusPresentation("notConfigured").tone, "neutral");
  assert.equal(statusPresentation("verified").tone, "neutral");
  assert.equal(statusPresentation("managedByEnvironment").tone, "neutral");
  assert.equal(statusPresentation("actionNeeded").tone, "warning");
  assert.equal(statusPresentation("connected").tone, "success");
  assert.deepEqual(
    PROVIDER_GUIDES.map(() => statusPresentation("verified").label),
    ["Verified", "Verified", "Verified"],
  );
});

test("status labels are the agreed vocabulary and nothing else", () => {
  assert.deepEqual(
    (
      ["notConfigured", "verified", "connected", "actionNeeded", "managedByEnvironment"] as const
    ).map((status) => statusPresentation(status).label),
    ["Not set up", "Verified", "Connected", "Action needed", "Managed by environment"],
  );
});

test("Slack alone blocks on a plain-HTTP origin; the others explain and carry on", () => {
  assert.equal(guideFor("slack").requiresHttps, true);
  assert.equal(guideFor("github").requiresHttps, false);
  assert.equal(guideFor("discord").requiresHttps, false);
  assert.equal(isSecureOrigin("http://localhost:3000"), false);
  assert.equal(isSecureOrigin(ORIGIN), true);
  assert.equal(guideFor("discord").insecureOriginNotice("http://localhost:3000").tone, "default");
  assert.equal(guideFor("slack").insecureOriginNotice("http://localhost:3000").tone, "warning");
});

test("only Discord has no inbound events to wait for", () => {
  assert.deepEqual(
    PROVIDER_GUIDES.map((guide) => [guide.provider, guide.receivesEvents]),
    [
      ["github", true],
      ["slack", true],
      ["discord", false],
    ],
  );
});

test("Slack has one action because its save is its install", () => {
  const slack = guideFor("slack");
  assert.equal(slack.savingContinues, true);
  assert.equal(slack.actions.save, "Save and continue to Slack");
  assert.equal(slack.actions.connect, "Add to a Slack workspace");
  assert.equal(slack.verifiedMessage, undefined);
  assert.equal(guideFor("github").actions.save, "Verify and save");
  assert.equal(guideFor("github").actions.connect, "Install on GitHub");
});

test("every field the boundary needs is asked for, in the portal's own words", () => {
  assert.deepEqual(
    guideFor("github").fields.map((field) => [field.name, field.label]),
    [
      ["appId", "App ID"],
      ["appSlug", "App slug"],
      ["clientId", "Client ID"],
      ["clientSecret", "Client secret"],
      ["privateKey", "Private key"],
      ["webhookSecret", "Webhook secret"],
    ],
  );
  assert.deepEqual(
    guideFor("slack").fields.map((field) => field.label),
    ["App ID", "Client ID", "Client Secret", "Signing Secret"],
  );
  assert.deepEqual(
    guideFor("discord").fields.map((field) => field.label),
    ["Application ID", "Client Secret", "Bot token"],
  );
});

test("only non-secret identifiers can be echoed back into the form", () => {
  const secrets = PROVIDER_GUIDES.flatMap((guide) =>
    guide.fields.filter((field) => field.kind !== "text"),
  );
  assert.ok(secrets.length > 0);
  for (const field of secrets) assert.equal(field.identifier, undefined);
});

test("identity lines name the app the operator created", () => {
  assert.equal(
    identityLabel({ provider: "github", id: "42", name: "Paseo Hub", ownerLogin: "acme-inc" }),
    "Paseo Hub · owned by acme-inc",
  );
  assert.equal(
    identityLabel({ provider: "discord", id: "900", name: "Paseo" }),
    "Paseo · application 900",
  );
});

test("no guide leaks Paseo's internal vocabulary into operator-facing copy", () => {
  const forbidden = [
    "runtime configuration",
    "database",
    "persistence",
    "migration",
    "registration",
    "hot reload",
    "configuration version",
    "latch",
    "factory",
    "project",
    "environment variable",
  ];
  const phrases: string[] = [];
  for (const guide of PROVIDER_GUIDES) {
    phrases.push(
      guide.summary,
      guide.note ?? "",
      guide.saveHint ?? "",
      guide.verifiedMessage ?? "",
      guide.insecureOriginNotice("http://localhost:3000").message,
    );
    for (const step of guide.steps) {
      for (const segment of step.segments) phrases.push(segment.value);
    }
    for (const field of guide.fields) {
      phrases.push(field.label, field.description ?? "", field.required);
    }
  }
  const copy = phrases.join(" ").toLowerCase();
  for (const term of forbidden) assert.ok(!copy.includes(term), `copy mentions "${term}"`);
});
