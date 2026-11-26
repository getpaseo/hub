import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { triggerFormErrors, type TriggerFormValue } from "../../triggers/configuration/editor.js";
import { IntegrationAccess, addIntegrationAccess } from "../../triggers/integration-access.js";

const TEST_CONNECTIONS = [
  { id: "n-1", provider: "notion", slug: "eng-notion", label: "Eng Workspace" },
];
const noop = () => {};

const BASE_FORM: TriggerFormValue = {
  name: "notion-sync",
  enabled: true,
  event: "schedule.tick",
  connection: "",
  audience: "everyone",
  allowedUsers: "",
  qualifiers: {},
  daemon: "office",
  cwd: "/workspace/repo",
  agent: "codex/gpt-5.4",
  mode: "full-access",
  thinkingOptionId: "",
  providerOptions: "",
  continuationMode: "new",
  continuationKey: "",
  maxRuntime: "2h",
  idleTimeout: "10m",
  background: false,
  autoArchive: true,
  githubConnection: "",
  githubRepositories: "",
  githubPermissions: "",
  githubDuration: "",
  tools: {},
  prompt: "Sync Notion.",
};

describe("Notion browser UI surfaces", () => {
  it("renders Notion grant fields and surfaces permission/target errors in IntegrationAccess", () => {
    const withNotion = addIntegrationAccess(BASE_FORM, "notion", TEST_CONNECTIONS);
    assert.equal(withNotion.integrationTools?.["notion"]?.connection, "eng-notion");
    const errors = triggerFormErrors(withNotion, []);
    assert.equal(errors["tools.notion.actions"], "Select at least one Notion permission");
    assert.equal(
      errors["tools.notion.data_sources"],
      "Provide at least one Notion data source or page",
    );

    const markup = renderToStaticMarkup(
      <IntegrationAccess
        form={withNotion}
        connections={TEST_CONNECTIONS}
        errors={errors}
        onChange={noop}
      />,
    );
    assert.match(markup, /Databases or data sources/u);
    assert.match(markup, /Read pages and databases/u);
    assert.match(markup, /Select at least one Notion permission/u);
    assert.match(markup, /Provide at least one Notion data source or page/u);
  });
});
