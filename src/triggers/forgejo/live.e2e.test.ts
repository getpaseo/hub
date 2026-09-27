import assert from "node:assert/strict";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { AuthServer } from "../../auth/server.js";
import { ProjectConfigurationStore } from "../../configuration/store.js";
import { createDatabase, createPostgresQueryRuntime } from "../../db/test-utils/runtime.js";
import type { Database, DurableProviderEvent } from "../../db/types.js";
import { createFetchServer } from "../../http/node-server.js";
import { createForgejoApiClient } from "../../providers/forgejo/client.js";
import { createForgejoRegistration } from "../../providers/forgejo/index.js";
import { parseAllowedPrivateHosts } from "../../providers/forgejo/instance-guard.js";
import { enrollTestDaemon, TEST_DAEMON_SLUG } from "../../test-utils/project-configuration.js";
import {
  createForgejoInstanceUser,
  forgejoRawApiClient,
  freePort,
  mintForgejoToken,
  sleep,
  startForgejoContainer,
  stopForgejoContainer,
  waitForForgejoReady,
  type ForgejoRawResponse,
} from "../../test-utils/forgejo-live-instance.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import type { TriggerProviderMatch } from "../index.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import { OrganizationTriggerStore } from "../store.js";
import { createForgejoReactionClient, createForgejoTriggerProvider } from "./provider.js";
import type { ForgejoOutputContext, ForgejoTriggerContext } from "./provider.js";

/** Explicit aliases, not inferred: oxlint's type checker doesn't fully resolve
 * createForgejoTriggerProvider's generic return through .match() and falls back to
 * any, even though tsgo resolves it cleanly. */
type ForgejoTriggerProvider = ReturnType<typeof createForgejoTriggerProvider>;
type ForgejoMatch = TriggerProviderMatch<ForgejoTriggerContext, ForgejoOutputContext>;
type ForgejoMatchResult = readonly ForgejoMatch[] | ProviderEventDropReasonCode;

/**
 * Drives a real Forgejo instance and a real Postgres end to end. Opt-in and skipped by
 * default: RUN_FORGEJO_LIVE=1 npx vitest run src/triggers/forgejo/live.e2e.test.ts
 * (needs podman machine running). acme/widgets is an org repo, so step (b) subscribes
 * at user scope only to exercise that action's idempotency; the org-scope subscribe
 * alongside it is what actually delivers events for the rest of the scenario.
 */
const describeForgejoLive = process.env["RUN_FORGEJO_LIVE"] === "1" ? describe : describe.skip;

// Suffixed with this run's pid: two concurrent runs (a local one plus CI, or two
// worktrees) sharing a docker/podman host would otherwise collide on the container name.
const CONTAINER_NAME = `cc-forgejo-live-${process.pid}`;
const IMAGE = "codeberg.org/forgejo/forgejo:16";
const TRILLIAN = {
  username: "trillian",
  password: "PoemsAreBad42!Q",
  email: "trillian@example.test",
};
const ZAPHOD = {
  username: "zaphod",
  password: "TwoHeadsAreBetter1!Q",
  email: "zaphod@example.test",
};
const HUB_ORG_ID = "forgejo-live-org";
const HUB_ORG_SLUG = "forgejo-live";
const HUB_USER_ID = "forgejo-live-user";
const HUB_SESSION_ID = "forgejo-live-session";
const HUB_MEMBERSHIP_ID = "forgejo-live-membership";

describeForgejoLive("Forgejo live end to end", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;
  let forgejoBaseUrl: string;
  let server: Server;
  let trillian: (method: string, path: string, body?: unknown) => Promise<ForgejoRawResponse>;
  let zaphod: (method: string, path: string, body?: unknown) => Promise<ForgejoRawResponse>;
  let trillianToken: string;
  let forgejoRegistration: ReturnType<typeof createForgejoRegistration>;
  let apiClient: ReturnType<typeof createForgejoApiClient>;
  const acceptedEvents: DurableProviderEvent[] = [];
  // incremented once handle() resolves, not when the request arrives.
  let handledCount = 0;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(`
      insert into organization (id, name, slug)
      values ('${HUB_ORG_ID}', 'Forgejo Live', '${HUB_ORG_SLUG}');
      insert into "user" (id, name, email, email_verified)
      values ('${HUB_USER_ID}', 'Trillian McMillan', 'trillian-hub@example.test', true);
      insert into session (id, token, user_id, active_organization_id, expires_at)
      values ('${HUB_SESSION_ID}', 'forgejo-live-token', '${HUB_USER_ID}', '${HUB_ORG_ID}',
              now() + interval '1 hour');
      insert into member (id, organization_id, user_id, role)
      values ('${HUB_MEMBERSHIP_ID}', '${HUB_ORG_ID}', '${HUB_USER_ID}', 'owner');
    `);
    await client.close();
    await enrollTestDaemon(database, HUB_ORG_ID);

    const forgejoPort = await freePort();
    const capturePort = await freePort();
    forgejoBaseUrl = `http://127.0.0.1:${forgejoPort}`;
    const applicationBaseUrl = `http://host.containers.internal:${capturePort}`;

    startForgejoContainer(CONTAINER_NAME, IMAGE, forgejoPort);
    await waitForForgejoReady(forgejoBaseUrl);
    createForgejoInstanceUser(
      CONTAINER_NAME,
      TRILLIAN.username,
      TRILLIAN.password,
      TRILLIAN.email,
      {
        admin: true,
      },
    );
    createForgejoInstanceUser(CONTAINER_NAME, ZAPHOD.username, ZAPHOD.password, ZAPHOD.email);
    trillianToken = await mintForgejoToken(forgejoBaseUrl, TRILLIAN);
    const zaphodToken = await mintForgejoToken(forgejoBaseUrl, ZAPHOD);
    trillian = forgejoRawApiClient(forgejoBaseUrl, trillianToken);
    zaphod = forgejoRawApiClient(forgejoBaseUrl, zaphodToken);

    await trillian("POST", "/api/v1/orgs", { username: "acme" });
    await trillian("POST", "/api/v1/orgs/acme/repos", { name: "widgets", auto_init: true });
    await trillian("POST", "/api/v1/repos/acme/widgets/labels", { name: "bug", color: "ee0701" });
    await trillian("POST", "/api/v1/repos/acme/widgets/labels", {
      name: "triage",
      color: "fbca04",
    });
    await trillian("PUT", "/api/v1/repos/acme/widgets/collaborators/zaphod", {
      permission: "write",
    });

    // the SSRF guard refuses a loopback instance by default; passed explicitly here
    // instead of through the env var so it stays untouched for other tests.
    apiClient = createForgejoApiClient({
      allowedPrivateHosts: parseAllowedPrivateHosts("127.0.0.1"),
    });
    const registration = createForgejoRegistration({
      database,
      auth: fakeAuth(),
      applicationBaseUrl,
      apiClient,
    });
    const webhookRequest = registration.requests.find(
      (request) => request.name === "forgejo.events",
    );
    if (webhookRequest === undefined)
      throw new Error("forgejo registration has no webhook request");
    const webhookSource = registration.sources[0];
    if (webhookSource === undefined) throw new Error("forgejo registration has no webhook source");
    await webhookSource.start((event) => {
      acceptedEvents.push(event);
      return Promise.resolve();
    });

    server = createFetchServer(async (request) => {
      const response = await webhookRequest.handle(request);
      handledCount++;
      return response;
    });
    await new Promise<void>((resolve) => server.listen(capturePort, "0.0.0.0", () => resolve()));

    forgejoRegistration = registration;
  }, 180_000);

  afterAll(async () => {
    // each step catches its own failure so one throwing doesn't skip the rest, in
    // case beforeAll died partway through and left a resource undefined.
    const failures: unknown[] = [];
    await teardownStep(failures, () => (server === undefined ? undefined : closeServer(server)));
    await teardownStep(failures, () => stopForgejoContainer(CONTAINER_NAME));
    await teardownStep(failures, () => database?.close());
    await teardownStep(failures, () => postgres?.stop());
    await teardownStep(failures, () => {
      const remaining = execFileSync(
        "podman",
        ["ps", "-a", "--filter", `name=${CONTAINER_NAME}`, "--format", "{{.Names}}"],
        { encoding: "utf8" },
      ).trim();
      assert.equal(remaining, "", "forgejo live container should be gone after teardown");
    });
    if (failures.length > 0)
      throw new AggregateError(failures, "forgejo live teardown had failures");
  }, 120_000);

  it("connects, subscribes, routes, replies, dedupes, reviews, requests a review, merges and disconnects", async () => {
    const create = requiredAction(forgejoRegistration.connection.actions, "create");
    const subscribe = requiredAction(forgejoRegistration.connection.actions, "subscribe");
    const disconnect = requiredAction(forgejoRegistration.connection.actions, "disconnect");

    // a. connect, through the real `create` action, and save the org trigger config.
    const created = CreateResponseSchema.parse(
      await (
        await create(
          hubRequest("POST", "/connections/create", {
            instanceBaseUrl: forgejoBaseUrl,
            accessToken: trillianToken,
          }),
        )
      ).json(),
    );
    const connectionId = created.connection.id;
    const webhookUrl = created.connection.webhookUrl;

    const trigger = await new OrganizationTriggerStore(database, HUB_ORG_ID).save({
      yaml: triggerYaml(created.connection.slug),
      userId: null,
    });

    // b. subscribe: user scope plus org scope, see the module doc above.
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await subscribe(subscribeRequest(connectionId, { scope: "user" }));
      assert.equal(response.status, 200);
    }
    const userHooks = HookListSchema.parse((await trillian("GET", "/api/v1/user/hooks")).body);
    assert.equal(userHooks.filter((hook) => hook.config?.url === webhookUrl).length, 1);

    const orgSubscribe = await subscribe(
      subscribeRequest(connectionId, { scope: "org", org: "acme" }),
    );
    assert.equal(orgSubscribe.status, 200);
    const orgHooks = HookListSchema.parse((await trillian("GET", "/api/v1/orgs/acme/hooks")).body);
    assert.equal(orgHooks.filter((hook) => hook.config?.url === webhookUrl).length, 1);

    const project = await database.findProjectById(trigger.runtimeProjectId);
    if (
      project?.activeConfigurationRevisionId === undefined ||
      project.activeConfigurationRevisionId === null
    ) {
      throw new Error("expected an active revision");
    }
    const revision = await new ProjectConfigurationStore(database, project.id).getRevision(
      project.activeConfigurationRevisionId,
    );
    if (revision === undefined) throw new Error("expected an active revision");
    const triggerNameByOn = new Map(revision.configuration.triggers.map((t) => [t.on, t.name]));
    // built directly here so .match() comes back typed instead of duck-typed through
    // the registration's generic factory signature.
    const provider: ForgejoTriggerProvider = createForgejoTriggerProvider({
      configurationStoreForProject: (projectId) =>
        new ProjectConfigurationStore(database, projectId),
      reactions: createForgejoReactionClient({
        api: apiClient,
        credentialsForConnection: async (forConnectionId) => {
          const connection = await database.findForgejoConnection(forConnectionId);
          if (connection === undefined) {
            throw new Error(`forgejo connection is unavailable: ${forConnectionId}`);
          }
          return {
            instanceBaseUrl: connection.instanceBaseUrl,
            accessToken: connection.accessToken,
          };
        },
      }),
    });

    // c. zaphod comments "@paseo hi" on a fresh issue: accepted and routed.
    const issue = await trillian("POST", "/api/v1/repos/acme/widgets/issues", {
      title: "Improbability drive stalls",
      body: "on cold mornings",
    });
    const issueNumber = IssueSchema.parse(issue.body).number;
    const beforeComment = acceptedEvents.length;
    await zaphod("POST", `/api/v1/repos/acme/widgets/issues/${issueNumber}/comments`, {
      body: "@paseo hi",
    });
    // waits for the comment body itself, since the issue-creation delivery can still
    // be in flight and satisfy a bare length check first.
    await waitUntil(() => findCommentEvent(acceptedEvents.slice(beforeComment)) !== undefined);
    const commentEvent = findCommentEvent(acceptedEvents.slice(beforeComment));
    if (commentEvent === undefined) throw new Error("expected the @paseo comment delivery");
    const matches: ForgejoMatchResult = await provider.match(commentEvent);
    if (typeof matches === "string") throw new Error(`expected matches, got ${matches}`);
    const commentMatch: ForgejoMatch | undefined = matches.find(
      (match) => match.triggerName === triggerNameByOn.get("forgejo.issue_comment_created"),
    );
    if (!isAcceptedTriggerProviderMatch(commentMatch))
      throw new Error("expected an accepted match");
    const replyContext = commentMatch.outputContext;
    assert.equal(replyContext.repository, "acme/widgets");
    assert.equal(replyContext.issueNumber, issueNumber);

    // d. run the forgejo.reply executor: the comment lands on Forgejo, and its own echo
    // is dropped before routing, since it posts with trillian's own token and trillian
    // is this connection's account.
    const replyExecutor = forgejoRegistration.outputs.find(
      (output) => output.type === "forgejo.reply",
    );
    if (replyExecutor === undefined) throw new Error("expected a forgejo.reply output");
    const handledBeforeReply = handledCount;
    const acceptedBeforeReply = acceptedEvents.length;
    await replyExecutor.execute({
      agentExecutionId: "live-e2e-execution",
      toolType: "forgejo.reply",
      args: { content: "@paseo pong" },
      outputContext: replyContext,
    });
    const comments = CommentListSchema.parse(
      (await trillian("GET", `/api/v1/repos/acme/widgets/issues/${issueNumber}/comments`)).body,
    );
    assert.ok(comments.some((comment) => comment.body === "@paseo pong"));
    // handledCount only increments after handle() resolves, so this observes the loop
    // guard having actually run, not an in-flight request still racing.
    await waitUntil(() => handledCount > handledBeforeReply);
    assert.equal(acceptedEvents.length, acceptedBeforeReply);

    // e. add "bug" then "triage" in quick succession: exactly one issue_label_added
    // match for "bug" in total, however the two deliveries race.
    const beforeLabels = acceptedEvents.length;
    const handledBeforeLabels = handledCount;
    await zaphod("POST", `/api/v1/repos/acme/widgets/issues/${issueNumber}/labels`, {
      labels: ["bug"],
    });
    await zaphod("POST", `/api/v1/repos/acme/widgets/issues/${issueNumber}/labels`, {
      labels: ["triage"],
    });
    await waitUntil(() => acceptedEvents.length >= beforeLabels + 2);
    // both handled, not just accepted: the race over timeline claims only settles
    // once handle() resolves for each.
    await waitUntil(() => handledCount >= handledBeforeLabels + 2);
    const labelMatches = await matchCount(
      provider,
      acceptedEvents.slice(beforeLabels),
      triggerNameByOn.get("forgejo.issue_label_added"),
    );
    assert.equal(labelMatches, 1);

    // f. assign zaphod: issue_assigned matches once. From zaphod, not trillian: any
    // write trillian performs is dropped before routing, since trillian is this
    // connection's own account.
    const beforeAssign = acceptedEvents.length;
    await zaphod("PATCH", `/api/v1/repos/acme/widgets/issues/${issueNumber}`, {
      assignees: ["zaphod"],
    });
    await waitUntil(() => hasSource(acceptedEvents.slice(beforeAssign), "forgejo.issues"));
    const assignMatches = await matchCount(
      provider,
      acceptedEvents.slice(beforeAssign),
      triggerNameByOn.get("forgejo.issue_assigned"),
    );
    assert.equal(assignMatches, 1);

    // g. a second, repo-level hook pointed at the same url and secret: one comment,
    // two raw deliveries. Dedupes by signatureHash to the same receipt. The webhook
    // layer still calls every handler on each accepted delivery, replay included (an
    // intentional at-least-once contract); the real dedupe guard against a doubled
    // side effect is the trigger run's own conflict-do-nothing insert one layer down.
    // So this step checks receipt-level dedupe, not the handler-call count.
    await trillian("POST", "/api/v1/repos/acme/widgets/hooks", {
      type: "forgejo",
      active: true,
      config: { url: webhookUrl, content_type: "json", secret: created.connection.webhookSecret },
      events: ["issue_comment"],
    });
    const handledBeforeDouble = handledCount;
    const acceptedBeforeDouble = acceptedEvents.length;
    await zaphod("POST", `/api/v1/repos/acme/widgets/issues/${issueNumber}/comments`, {
      body: "@paseo dedupe check",
    });
    await waitUntil(() => handledCount >= handledBeforeDouble + 2);
    const doubled = acceptedEvents.slice(acceptedBeforeDouble);
    assert.ok(doubled.length >= 1, "expected at least one hook to dispatch its delivery");
    const receiptIds = new Set(doubled.map((event) => event.providerEventReceiptId));
    assert.equal(
      receiptIds.size,
      1,
      "expected the two hooks' deliveries of the same comment to dedupe to one receipt",
    );

    // h. a review approve by zaphod on a PR fires forgejo.pull_request_review.
    await trillian("POST", "/api/v1/repos/acme/widgets/contents/live.txt", {
      message: "add file",
      branch: "main",
      new_branch: "feature/live-e2e",
      content: Buffer.from("42\n").toString("base64"),
    });
    const pr = PullRequestSchema.parse(
      (
        await trillian("POST", "/api/v1/repos/acme/widgets/pulls", {
          head: "feature/live-e2e",
          base: "main",
          title: "Live e2e PR",
          body: "testing",
        })
      ).body,
    );
    const beforeReview = acceptedEvents.length;
    await zaphod("POST", `/api/v1/repos/acme/widgets/pulls/${pr.number}/reviews`, {
      event: "APPROVED",
      body: "lgtm",
    });
    // the content commit and PR creation just before this can still have their own
    // deliveries in flight, so a bare length check could resolve on those instead.
    await waitUntil(() =>
      hasSource(acceptedEvents.slice(beforeReview), "forgejo.pull_request_review"),
    );
    const reviewMatches = await matchCount(
      provider,
      acceptedEvents.slice(beforeReview),
      triggerNameByOn.get("forgejo.pull_request_review"),
    );
    assert.equal(reviewMatches, 1);

    // i. zaphod opens a second PR and requests review from trillian: a new PR since
    // the reviewer can't be the PR's own poster, and posted by zaphod since trillian's
    // own deliveries are dropped by the loop guard.
    await zaphod("POST", "/api/v1/repos/acme/widgets/contents/review-request.txt", {
      message: "add file for review request",
      branch: "main",
      new_branch: "feature/review-request",
      content: Buffer.from("6\n").toString("base64"),
    });
    const reviewRequestPr = PullRequestSchema.parse(
      (
        await zaphod("POST", "/api/v1/repos/acme/widgets/pulls", {
          head: "feature/review-request",
          base: "main",
          title: "Needs a reviewer",
          body: "testing",
        })
      ).body,
    );
    const beforeReviewRequest = acceptedEvents.length;
    await zaphod(
      "POST",
      `/api/v1/repos/acme/widgets/pulls/${reviewRequestPr.number}/requested_reviewers`,
      { reviewers: ["trillian"] },
    );
    await waitUntil(() =>
      hasSource(acceptedEvents.slice(beforeReviewRequest), "forgejo.pull_request"),
    );
    const reviewRequestMatches = await matchCount(
      provider,
      acceptedEvents.slice(beforeReviewRequest),
      triggerNameByOn.get("forgejo.pull_request_review_requested"),
    );
    assert.equal(reviewRequestMatches, 1);

    // j. merge that same PR, from zaphod again. Mergeability is checked in the
    // background after the branch settles, so a merge attempted right away can still
    // answer 405 for a moment. Retry instead of treating it as a real failure.
    const beforeMerge = acceptedEvents.length;
    for (let attempt = 1; ; attempt++) {
      try {
        await zaphod("POST", `/api/v1/repos/acme/widgets/pulls/${reviewRequestPr.number}/merge`, {
          Do: "merge",
        });
        break;
      } catch (error) {
        if (attempt >= 20 || !String(error).includes("405")) throw error;
        await sleep(500);
      }
    }
    await waitUntil(() => hasSource(acceptedEvents.slice(beforeMerge), "forgejo.pull_request"));
    const mergeMatches = await matchCount(
      provider,
      acceptedEvents.slice(beforeMerge),
      triggerNameByOn.get("forgejo.pull_request_merged"),
    );
    assert.equal(mergeMatches, 1);

    // k. a push to a branch matched by a branches filter, and a differently named
    // branch that must not match. Both from zaphod, not trillian, so the "must not
    // fire" half is down to the branches filter, not the loop guard.
    const beforeMatchingPush = acceptedEvents.length;
    await zaphod("POST", "/api/v1/repos/acme/widgets/contents/branch-filter-match.txt", {
      message: "branch filter match",
      branch: "main",
      new_branch: "feature/branch-filter-match",
      content: Buffer.from("1\n").toString("base64"),
    });
    await waitUntil(() => hasSource(acceptedEvents.slice(beforeMatchingPush), "forgejo.push"));
    const matchingPushMatches = await matchCount(
      provider,
      acceptedEvents.slice(beforeMatchingPush),
      triggerNameByOn.get("forgejo.push"),
    );
    assert.equal(matchingPushMatches, 1);

    const beforeNonMatchingPush = acceptedEvents.length;
    await zaphod("POST", "/api/v1/repos/acme/widgets/contents/branch-filter-no-match.txt", {
      message: "branch filter no match",
      branch: "main",
      new_branch: "feature/branch-filter-no-match",
      content: Buffer.from("2\n").toString("base64"),
    });
    await waitUntil(() => hasSource(acceptedEvents.slice(beforeNonMatchingPush), "forgejo.push"));
    const nonMatchingPushMatches = await matchCount(
      provider,
      acceptedEvents.slice(beforeNonMatchingPush),
      triggerNameByOn.get("forgejo.push"),
    );
    assert.equal(nonMatchingPushMatches, 0);

    // l. disconnect: the user hook is deleted on the instance, the row is gone.
    const disconnected = DisconnectResponseSchema.parse(
      await (await disconnect(disconnectRequest(connectionId))).json(),
    );
    assert.equal(disconnected.disconnected, true);
    const hooksAfterDisconnect = HookListSchema.parse(
      (await trillian("GET", "/api/v1/user/hooks")).body,
    );
    assert.equal(hooksAfterDisconnect.filter((hook) => hook.config?.url === webhookUrl).length, 0);
    assert.equal(await database.findForgejoConnection(connectionId), undefined);
  }, 180_000);
});

function fakeAuth(): AuthServer {
  return {
    handle: () => Promise.reject(new Error("not used in this test")),
    resources: () => Promise.reject(new Error("not used in this test")),
    resolveOrganizationAccess: () => Promise.reject(new Error("not used in this test")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: HUB_SESSION_ID, activeOrganizationId: HUB_ORG_ID },
        account: { id: HUB_USER_ID, name: "Trillian McMillan", email: "trillian-hub@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}

function hubRequest(method: string, path: string, body?: unknown): Request {
  const url = new URL(`http://hub.local${path}`);
  url.searchParams.set("organizationSlug", HUB_ORG_SLUG);
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function subscribeRequest(
  connectionId: string,
  body: { scope: "user" } | { scope: "org"; org: string },
): Request {
  const url = new URL("http://hub.local/connections/subscribe");
  url.searchParams.set("organizationSlug", HUB_ORG_SLUG);
  url.searchParams.set("connectionId", connectionId);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function disconnectRequest(connectionId: string): Request {
  const url = new URL("http://hub.local/connections/disconnect");
  url.searchParams.set("organizationSlug", HUB_ORG_SLUG);
  url.searchParams.set("connectionId", connectionId);
  return new Request(url, { method: "POST" });
}

/** actions is a Record<string, ...>, so a bare index read carries | undefined. Resolve
 * once and fail loudly, not !. */
function requiredAction(
  actions: Readonly<Record<string, (request: Request) => Promise<Response>>>,
  name: string,
): (request: Request) => Promise<Response> {
  const action = actions[name];
  if (action === undefined) throw new Error(`forgejo registration has no "${name}" action`);
  return action;
}

async function matchCount(
  provider: ForgejoTriggerProvider,
  events: readonly DurableProviderEvent[],
  triggerName: string | undefined,
): Promise<number> {
  if (triggerName === undefined) throw new Error("expected a compiled trigger name");
  let count = 0;
  for (const event of events) {
    const matches: ForgejoMatchResult = await provider.match(event);
    if (typeof matches === "string") continue;
    for (const match of matches) {
      if (match.triggerName === triggerName && isAcceptedTriggerProviderMatch(match)) count++;
    }
  }
  return count;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Runs one teardown step, pushing whatever it throws onto failures instead of
 * stopping the steps written after it. */
async function teardownStep(failures: unknown[], step: () => unknown): Promise<void> {
  try {
    await step();
  } catch (error) {
    failures.push(error);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(200);
  }
  throw new Error("timed out waiting for condition");
}

// event.payload is the whole NormalizedForgejoEvent, not the raw Forgejo body; the
// real webhook body is one level down at .payload.
function commentBodyOf(event: DurableProviderEvent): string | undefined {
  return NormalizedEventPayloadSchema.safeParse(event.payload).data?.payload.comment?.body;
}

function findCommentEvent(
  events: readonly DurableProviderEvent[],
): DurableProviderEvent | undefined {
  return events.find((event) => commentBodyOf(event) === "@paseo hi");
}

/** An unrelated delivery can still be in flight when a step captures its "before"
 * length, so wait for the specific source this step cares about instead. */
function hasSource(events: readonly DurableProviderEvent[], source: string): boolean {
  return events.some((event) => event.source === source);
}

const NormalizedEventPayloadSchema = z
  .object({
    payload: z
      .object({ comment: z.object({ body: z.string().optional() }).passthrough().optional() })
      .passthrough(),
  })
  .passthrough();
const HookListSchema = z.array(
  z
    .object({ config: z.object({ url: z.string().optional() }).passthrough().optional() })
    .passthrough(),
);
const IssueSchema = z.object({ number: z.number() }).passthrough();
const PullRequestSchema = z.object({ number: z.number() }).passthrough();
const CommentListSchema = z.array(z.object({ body: z.string() }).passthrough());
const CreateResponseSchema = z.object({
  connection: z.object({
    id: z.string(),
    slug: z.string(),
    webhookSecret: z.string(),
    webhookUrl: z.string(),
  }),
});
const DisconnectResponseSchema = z.object({ disconnected: z.boolean() });

function triggerYaml(connectionSlug: string): string {
  return `name: forgejo-live
enabled: true
on:
  forgejo.issue_comment_created:
    connection: ${connectionSlug}
    filters:
      from_users: ["*"]
      contains: "@paseo"
  forgejo.issue_label_added:
    connection: ${connectionSlug}
    filters:
      from_users: ["*"]
      label: bug
  forgejo.issue_assigned:
    connection: ${connectionSlug}
    filters:
      from_users: ["*"]
      assignees: [zaphod]
  forgejo.pull_request_review:
    connection: ${connectionSlug}
    filters:
      from_users: ["*"]
  forgejo.pull_request_review_requested:
    connection: ${connectionSlug}
    filters:
      from_users: ["*"]
      reviewers: [trillian]
  forgejo.pull_request_merged:
    connection: ${connectionSlug}
    filters:
      from_users: ["*"]
  forgejo.push:
    connection: ${connectionSlug}
    filters:
      from_users: ["*"]
      branches: ["feature/branch-filter-match"]
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
}
