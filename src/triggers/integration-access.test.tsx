import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";
import type { TriggerSnapshot } from "./functions.js";
import {
  addIntegrationAccess,
  configuredIntegrationProviders,
  hasIntegrationAccessError,
  IntegrationAccess,
  removeIntegrationAccess,
} from "./integration-access.js";

const NOOP = () => {};
const NO_ERRORS: TriggerFieldErrors = {};

const BASE_FORM: TriggerFormValue = {
  name: "daily-digest",
  enabled: true,
  event: "schedule.tick",
  connection: "",
  allowedUsers: "*",
  qualifiers: {},
  daemon: "office",
  cwd: "/workspace/acme",
  agent: "codex/gpt-5.4",
  mode: "full-access",
  thinkingOptionId: "low",
  providerOptions: "",
  continuationMode: "new",
  continuationKey: "",
  maxRuntime: "2h",
  idleTimeout: "10m",
  githubConnection: "",
  githubRepositories: "",
  githubPermissions: "",
  githubDuration: "1h",
  tools: {},
  prompt: "Summarize activity.",
};

const ALL_CONFIGURED_FORM: TriggerFormValue = {
  ...BASE_FORM,
  githubConnection: "acme-github",
  githubRepositories: "acme/hub",
  githubPermissions: '{"contents":"write"}',
  tools: {
    slack: { connection: "company-slack", actions: ["post"], channels: "C12345" },
    discord: { connection: "company-discord", actions: ["read"], channels: "1234567890" },
  },
};

const INVALID_SLACK_FORM: TriggerFormValue = {
  ...BASE_FORM,
  tools: {
    slack: { connection: "company-slack", actions: [], channels: "bad" },
  },
};

const INVALID_SLACK_ERRORS: TriggerFieldErrors = {
  "tools.slack.channels": "Use a Slack channel ID.",
  "tools.slack.actions": "Too small.",
};

const CONNECTIONS: TriggerSnapshot["connections"] = [
  { id: "gh-1", provider: "github", slug: "acme-github", label: "Acme GitHub" },
  { id: "sl-1", provider: "slack", slug: "company-slack", label: "Acme Slack" },
  { id: "dc-1", provider: "discord", slug: "company-discord", label: "Acme Discord" },
];

describe("integration access model", () => {
  test("lists configured providers in canonical order", () => {
    expect(configuredIntegrationProviders(BASE_FORM)).toEqual([]);
    const configured: TriggerFormValue = {
      ...BASE_FORM,
      githubConnection: "acme-github",
      tools: {
        discord: { connection: "company-discord", actions: ["read"], channels: "1234567890" },
        slack: { connection: "company-slack", actions: ["post"], channels: "C12345" },
      },
    };
    expect(configuredIntegrationProviders(configured)).toEqual(["github", "slack", "discord"]);
  });

  test("auto-selects a single connection when adding an integration and leaves ambiguous choices empty", () => {
    const withGitHub = addIntegrationAccess(BASE_FORM, "github", CONNECTIONS);
    expect(withGitHub.githubConnection).toBe("acme-github");
    expect(withGitHub.githubDuration).toBe("1h");

    const withSlack = addIntegrationAccess(BASE_FORM, "slack", CONNECTIONS);
    expect(withSlack.tools.slack).toEqual({
      connection: "company-slack",
      actions: [],
      channels: "",
    });

    const multipleSlack: TriggerSnapshot["connections"] = [
      ...CONNECTIONS,
      { id: "sl-2", provider: "slack", slug: "ops-slack", label: "Ops Slack" },
    ];
    const ambiguous = addIntegrationAccess(BASE_FORM, "slack", multipleSlack);
    expect(ambiguous.tools.slack?.connection).toBe("");
  });

  test("removes an integration grant and resets only its fields", () => {
    const configured: TriggerFormValue = {
      ...BASE_FORM,
      githubConnection: "acme-github",
      githubRepositories: "acme/hub",
      githubPermissions: '{"contents":"write"}',
      githubDuration: "30m",
      tools: {
        slack: { connection: "company-slack", actions: ["post"], channels: "C12345" },
        discord: { connection: "company-discord", actions: ["read"], channels: "1234567890" },
      },
    };

    const withoutGitHub = removeIntegrationAccess(configured, "github");
    expect(withoutGitHub.githubConnection).toBe("");
    expect(withoutGitHub.githubRepositories).toBe("");
    expect(withoutGitHub.githubPermissions).toBe("");
    expect(withoutGitHub.githubDuration).toBe("1h");
    expect(withoutGitHub.tools).toEqual(configured.tools);

    const withoutSlack = removeIntegrationAccess(configured, "slack");
    expect(withoutSlack.tools.slack).toBeUndefined();
    expect(withoutSlack.tools.discord).toEqual(configured.tools.discord);
    expect(withoutSlack.githubConnection).toBe("acme-github");
  });

  test("detects errors across GitHub and integration tool fields", () => {
    expect(hasIntegrationAccessError({})).toBe(false);
    expect(hasIntegrationAccessError({ prompt: "Instructions are required." })).toBe(false);
    expect(hasIntegrationAccessError({ githubPermissions: "Invalid JSON." })).toBe(true);
    expect(hasIntegrationAccessError({ "tools.slack.channels": "Use a Slack channel ID." })).toBe(
      true,
    );
    expect(hasIntegrationAccessError({ "tools.discord.actions": "Too small." })).toBe(true);
  });
});

describe("integration access rendering", () => {
  test("renders a collapsed empty state with an add action when no integrations are granted", () => {
    const markup = renderToStaticMarkup(
      <IntegrationAccess
        form={BASE_FORM}
        connections={CONNECTIONS}
        errors={NO_ERRORS}
        onChange={NOOP}
      />,
    );
    expect(markup).toContain("Integration access");
    expect(markup).toContain("No integrations granted for this run.");
    expect(markup).toContain("Add integration");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("configured");
  });

  test("renders GitHub, Slack, and Discord under one expanded section and hides add when all are present", () => {
    const markup = renderToStaticMarkup(
      <IntegrationAccess
        form={ALL_CONFIGURED_FORM}
        connections={CONNECTIONS}
        errors={NO_ERRORS}
        onChange={NOOP}
      />,
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("3 configured");
    expect(markup).toContain('aria-labelledby="trigger-access-github-heading"');
    expect(markup).toContain('aria-labelledby="trigger-access-slack-heading"');
    expect(markup).toContain('aria-labelledby="trigger-access-discord-heading"');
    expect(markup).toContain('aria-label="Remove GitHub"');
    expect(markup).toContain('aria-label="Remove Slack"');
    expect(markup).toContain('aria-label="Remove Discord"');
    expect(markup).not.toContain("Add integration");
  });

  test("auto-expands and surfaces inline validation errors", () => {
    const markup = renderToStaticMarkup(
      <IntegrationAccess
        form={INVALID_SLACK_FORM}
        connections={CONNECTIONS}
        errors={INVALID_SLACK_ERRORS}
        onChange={NOOP}
      />,
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Use a Slack channel ID.");
    expect(markup).toContain("Select at least one permission.");
  });
});
