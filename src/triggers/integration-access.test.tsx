import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  mergeTriggerForm,
  projectTriggerForm,
  type TriggerFieldErrors,
  type TriggerFormValue,
} from "./configuration/editor.js";
import type { TriggerSnapshot } from "./functions.js";
import {
  activeIntegrationProviders,
  addIntegrationAccess,
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
  audience: "everyone",
  allowedUsers: "",
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
  test("lists granted providers in canonical order", () => {
    expect(activeIntegrationProviders(BASE_FORM)).toEqual([]);
    const granted: TriggerFormValue = {
      ...BASE_FORM,
      githubConnection: "acme-github",
      tools: {
        discord: { connection: "company-discord", actions: ["read"], channels: "1234567890" },
        slack: { connection: "company-slack", actions: ["post"], channels: "C12345" },
      },
    };
    expect(activeIntegrationProviders(granted)).toEqual(["github", "slack", "discord"]);
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
    expect(activeIntegrationProviders(ambiguous)).toEqual(["slack"]);

    const multipleGitHub: TriggerSnapshot["connections"] = [
      ...CONNECTIONS,
      { id: "gh-2", provider: "github", slug: "ops-github", label: "Ops GitHub" },
    ];
    const ambiguousGitHub = addIntegrationAccess(BASE_FORM, "github", multipleGitHub);
    expect(ambiguousGitHub.githubEnabled).toBe(true);
    expect(ambiguousGitHub.githubConnection).toBe("");
    expect(activeIntegrationProviders(ambiguousGitHub)).toEqual(["github"]);
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
    expect(withoutGitHub.githubEnabled).toBeUndefined();
    expect(withoutGitHub.githubConnection).toBe("");
    expect(withoutGitHub.githubRepositories).toBe("");
    expect(withoutGitHub.githubPermissions).toBe("");
    expect(withoutGitHub.githubDuration).toBe("");
    expect(withoutGitHub.tools).toEqual(configured.tools);

    const withoutSlack = removeIntegrationAccess(configured, "slack");
    expect(withoutSlack.tools.slack).toBeUndefined();
    expect(withoutSlack.tools.discord).toEqual(configured.tools.discord);
    expect(withoutSlack.githubConnection).toBe("acme-github");
  });

  test("adding and removing a draft GitHub grant restores the exact projected form and YAML", () => {
    const anchoredYaml = `name: anchored-run
enabled: true
on:
  manual.run: {}
run:
  target:
    daemon: office
    cwd: /workspace/acme
  agent:
    provider: codex
    model: gpt-5.4
    mode: full-access
  continuation:
    key: &shared daily
    mode: key
  title: *shared
  prompt: Run daily check.
`;
    const projected = projectTriggerForm(anchoredYaml);
    expect(projected.status).toBe("editable");
    if (projected.status !== "editable") throw new Error(projected.reason);
    const added = addIntegrationAccess(projected.value, "github", []);
    const canceled = removeIntegrationAccess(added, "github");
    expect(mergeTriggerForm(anchoredYaml, canceled)).toEqual({ status: "ok", yaml: anchoredYaml });
  });
});

describe("integration access rendering", () => {
  test("says nothing is granted and offers to add an integration", () => {
    const markup = renderToStaticMarkup(
      <IntegrationAccess
        form={BASE_FORM}
        connections={CONNECTIONS}
        errors={NO_ERRORS}
        onChange={NOOP}
      />,
    );
    expect(markup).toContain("No integrations granted");
    expect(markup).toContain("Add integration");
  });

  test("renders every granted integration and hides add when all are present", () => {
    const markup = renderToStaticMarkup(
      <IntegrationAccess
        form={ALL_CONFIGURED_FORM}
        connections={CONNECTIONS}
        errors={NO_ERRORS}
        onChange={NOOP}
      />,
    );
    expect(markup).toContain('aria-labelledby="trigger-access-github-heading"');
    expect(markup).toContain('aria-labelledby="trigger-access-slack-heading"');
    expect(markup).toContain('aria-labelledby="trigger-access-discord-heading"');
    expect(markup).toContain('aria-label="Remove GitHub"');
    expect(markup).toContain('aria-label="Remove Slack"');
    expect(markup).toContain('aria-label="Remove Discord"');
    expect(markup).not.toContain("Add integration");
  });

  test("surfaces inline validation errors", () => {
    const markup = renderToStaticMarkup(
      <IntegrationAccess
        form={INVALID_SLACK_FORM}
        connections={CONNECTIONS}
        errors={INVALID_SLACK_ERRORS}
        onChange={NOOP}
      />,
    );
    expect(markup).toContain("Use a Slack channel ID.");
    expect(markup).toContain("Select at least one permission");
  });
});
