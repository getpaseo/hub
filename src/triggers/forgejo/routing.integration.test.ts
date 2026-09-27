import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, createPostgresQueryRuntime } from "../../db/test-utils/runtime.js";
import type { Database, DurableProviderEvent } from "../../db/types.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../../test-utils/project-configuration.js";
import { ProjectConfigurationStore } from "../../configuration/store.js";
import { OrganizationTriggerStore } from "../store.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import { FORGEJO_FIXTURE_SECRET, forgejoRequest } from "../fixtures/forgejo/index.js";
import { createForgejoTriggerProvider } from "./provider.js";
import { createForgejoWebhookSource } from "./webhook.js";

/**
 * End to end: a Forgejo trigger saved through the organization trigger store reaches
 * project_trigger_routes, a real captured delivery lands on that route through the
 * webhook endpoint, and the trigger provider match grants the automatic forgejo.reply
 * output.
 */
describe("Forgejo trigger routing, end to end on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(`
      insert into organization (id, name, slug)
      values ('forgejo-routing-org', 'Forgejo Routing', 'forgejo-routing');
      insert into forgejo_connections
        (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
         access_token, account_login, account_id, instance_flavor, instance_version)
      values
        ('60000000-0000-4000-8000-000000000001', 'forgejo-routing-org', 'acme-forgejo',
         'https://git.example.test', 'git.example.test', '${FORGEJO_FIXTURE_SECRET}',
         'forgejo-access-token', 'acme-bot', 999, 'forgejo', '16.0.5+gitea-1.22.0');
    `);
    await client.close();
    await enrollTestDaemon(database, "forgejo-routing-org");
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  it("routes a real issue comment delivery to the project and allows forgejo.reply", async () => {
    const trigger = await new OrganizationTriggerStore(database, "forgejo-routing-org").save({
      yaml: forgejoTriggerYaml,
      userId: null,
    });

    const project = await database.findProjectById(trigger.runtimeProjectId);
    assert.ok(project?.activeConfigurationRevisionId, "expected an active revision");

    const dispatched: DurableProviderEvent[] = [];
    const webhook = createForgejoWebhookSource({
      findConnection: async (connectionId) => {
        const connection = await database.findForgejoConnection(connectionId);
        return connection === undefined
          ? undefined
          : {
              id: connection.id,
              webhookSecret: connection.webhookSecret,
              accountId: connection.accountId,
              credentials: {
                instanceBaseUrl: connection.instanceBaseUrl,
                accessToken: connection.accessToken,
              },
            };
      },
      accept: (input) => database.acceptForgejoEvent(input),
    });
    await webhook.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await webhook.handle(
      forgejoRequest("issue-comment-created", "60000000-0000-4000-8000-000000000001"),
    );

    assert.equal(response.status, 200);
    assert.equal(dispatched.length, 1);
    const event = dispatched[0]!;
    assert.equal(event.projectId, trigger.runtimeProjectId);
    assert.equal(event.organizationId, "forgejo-routing-org");

    const provider = createForgejoTriggerProvider({
      configurationStoreForProject: (projectId) =>
        new ProjectConfigurationStore(database, projectId),
      reactions: {
        createReaction: () => Promise.reject(new Error("not used in this test")),
        deleteReaction: () => Promise.reject(new Error("not used in this test")),
      },
    });
    const match = (await provider.match(event))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected an accepted match");
    assert.equal(match.outputContext.provider, "forgejo");
    assert.equal(match.outputContext.repository, "acme/widgets");
    // Keyed on repositoryId, not the renameable "owner/name" string; see provider.ts.
    assert.equal(
      match.conversation?.key,
      JSON.stringify(["forgejo", "60000000-0000-4000-8000-000000000001", 1, 1]),
    );

    const revision = await new ProjectConfigurationStore(
      database,
      trigger.runtimeProjectId,
    ).getRevision(event.configurationRevisionId);
    const compiledTrigger = revision?.configuration.triggers.find(
      ({ name }) => name === match.triggerName,
    );
    assert.deepEqual(compiledTrigger?.steps[0]?.allowOutputs, [
      { type: "forgejo.reply", required: false },
    ]);
  }, 120_000);
});

const forgejoTriggerYaml = `name: forgejo-triage
enabled: true
on:
  forgejo.issue_comment_created:
    connection: acme-forgejo
    filters:
      from_users: [zaphod]
run:
  target:
    daemon: ${TEST_DAEMON_SLUG}
    cwd: /workspace
  agent:
    provider: test
    mode: full-access
  max_runtime: 30m
  idle_timeout: 5m
  prompt: Triage the comment
`;
