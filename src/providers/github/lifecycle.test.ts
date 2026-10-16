import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Octokit } from "octokit";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "../../db/runtime/index.js";
import { createDatabase } from "../../db/pg.js";
import { createGitHubRegistration } from "./index.js";

it("learns all 143 repositories from an installation webhook without enumerated repositories", async () => {
  await fixture(async ({ github, send, drain, database }) => {
    github.repositories = Array.from({ length: 143 }, (_, index) => repository(index + 1));
    assert.equal((await send("installation", "created", "created")).status, 200);
    await drain();
    assert.equal((await database.listGitHubRepositories("org")).length, 143);
    assert.deepEqual(github.pages, [1, 2]);
  });
});

it("replaces added, removed, renamed and empty repository selections from current GitHub evidence", async () => {
  await fixture(async ({ github, send, drain, database }) => {
    github.repositories = [repository(1), repository(2)];
    await send("installation", "created", "created");
    await drain();
    const original = (await database.listGitHubRepositories("org")).find(
      (item) => item.repositoryId === 2,
    )!;
    github.repositories = [
      { id: 2, full_name: "acme/renamed", default_branch: "next" },
      repository(3),
    ];
    await send("installation_repositories", "added", "added", {
      repositories_added: [{ id: 3, full_name: "acme/repo-3" }],
      repositories_removed: [{ id: 1, full_name: "acme/repo-1" }],
    });
    await drain();
    const updated = await database.listGitHubRepositories("org");
    assert.deepEqual(
      updated.map((item) => item.repositoryId).sort((a, b) => a - b),
      [2, 3],
    );
    assert.deepEqual(
      updated.find((item) => item.repositoryId === 2),
      { ...original, fullName: "acme/renamed", defaultBranch: "next" },
    );
    github.repositories = [];
    await send("installation_repositories", "removed", "removed", {
      repositories_removed: [
        { id: 2, full_name: "acme/renamed" },
        { id: 3, full_name: "acme/repo-3" },
      ],
    });
    await drain();
    assert.deepEqual(await database.listGitHubRepositories("org"), []);
  });
});

it("keeps the previous complete snapshot on page failure and resumes the durable receipt after restart", async () => {
  await fixture(async ({ github, send, drain, database, runtime, registration, register }) => {
    github.repositories = [repository(500)];
    await send("installation", "created", "created");
    await drain();
    github.repositories = Array.from({ length: 143 }, (_, index) => repository(index + 1));
    github.login = "renamed";
    github.failurePage = 2;
    assert.equal((await send("installation_repositories", "added", "failed-page")).status, 200);
    await drain();
    assert.deepEqual(
      (await database.listGitHubRepositories("org")).map((item) => item.repositoryId),
      [500],
    );
    assert.equal((await database.findGitHubConnection(42))?.accountLogin, "acme");
    const pending = await runtime.query(
      `select * from github_installation_syncs where retry_at is not null`,
    );
    assert.equal(pending.rows.length, 1);
    const requests = github.pages.length;
    await send("installation_repositories", "added", "failed-page");
    await drain();
    assert.equal(github.pages.length, requests);
    await registration.sources[0]!.stop();
    github.failurePage = undefined;
    await runtime.query(
      `update github_installation_syncs set retry_at = now() where retry_at is not null`,
    );
    const restarted = register();
    await restarted.sources[0]!.start(async () => undefined);
    await restarted.sources[0]!.stop();
    assert.equal((await database.listGitHubRepositories("org")).length, 143);
    assert.equal((await database.findGitHubConnection(42))?.accountLogin, "renamed");
    assert.equal(
      (await runtime.query(`select * from github_installation_syncs where retry_at is not null`))
        .rows.length,
      0,
    );
    assert.equal(
      (
        await runtime.query(
          `select * from provider_event_receipts where delivery_id = 'failed-page'`,
        )
      ).rows.length,
      1,
    );
  });
});

it("acknowledges a durably accepted webhook while the GitHub request is still blocked", async () => {
  await fixture(async ({ github, send, drain, runtime, database }) => {
    const gate = deferred();
    github.wait = gate.promise;
    github.repositories = [repository(1)];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        send("installation", "created", "slow"),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("webhook waited for GitHub")), 1000);
        }),
      ]);
      assert.equal(response.status, 200);
      assert.equal(
        (await runtime.query(`select * from github_installation_syncs where retry_at is not null`))
          .rows.length,
        1,
      );
      assert.deepEqual(await database.listGitHubRepositories("org"), []);
    } finally {
      clearTimeout(timeout);
      gate.resolve();
      await drain();
    }
    assert.equal((await database.listGitHubRepositories("org")).length, 1);
  });
});

it("does not apply a receipt for a disconnected binding to a replacement connection", async () => {
  await fixture(async ({ database, runtime }) => {
    const claim = await database.claimGitHubLifecycleReceipt({
      installationId: 42,
      deliveryId: "old-binding",
      signatureHash: "old",
      source: "github.installation",
      payload: {},
      receivedAt: new Date(),
    });
    assert.equal(claim.status, "claimed");
    if (claim.status !== "claimed") throw new Error("receipt unavailable");
    await runtime.query(`delete from github_connections where installation_id = 42`);
    await runtime.query(
      `insert into github_connections (organization_id, installation_id, slug, account_id, account_login, account_type, status) values ('org', 42, 'new', '1', 'new', 'Organization', 'active')`,
    );
    await database.applyGitHubInstallationSync(claim, { status: "absent", removeBinding: true });
    assert.equal((await database.findGitHubConnection(42))?.accountLogin, "new");
  });
});

function repository(id: number) {
  return { id, full_name: `acme/repo-${id}`, default_branch: "main" };
}

class GitHubTransport {
  repositories = [repository(1)];
  login = "acme";
  failurePage: number | undefined;
  wait: Promise<void> | undefined;
  pages: number[] = [];
  readonly octokit = new Octokit({
    request: {
      retries: 0,
      fetch: async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input);
        assert.equal(url.pathname, "/installation/repositories");
        const page = Number(url.searchParams.get("page"));
        assert.equal(url.searchParams.get("per_page"), "100");
        this.pages.push(page);
        await this.wait;
        if (page === this.failurePage)
          return Response.json({ message: "unavailable" }, { status: 422 });
        return Response.json({
          repositories: this.repositories.slice((page - 1) * 100, page * 100),
        });
      },
    },
  });
  readonly auth = {
    getInstallation: async () => ({
      id: 42,
      account: { id: 1, login: this.login, type: "Organization" },
    }),
    createInstallationOctokit: async () => this.octokit,
    getInstallationToken: async () => "token",
    mintInstallationToken: async () => ({ token: "token", expiresAt: Date.now() + 3600000 }),
    mintInstallationAccessToken: async () => ({ token: "token", expiresAt: Date.now() + 3600000 }),
    getAppBotIdentity: async () => ({ id: 1, login: "hub[bot]" }),
    revokeInstallationToken: async () => undefined,
  };
}

async function fixture(run: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const context = await createFixture();
  try {
    await run(context);
  } finally {
    await context.drain();
    await context.database.close();
    await rm(context.directory, { recursive: true, force: true });
  }
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "github-lifecycle-"));
  const { runtime, locks } = await embeddedDatabaseRuntime(directory);
  await runtime.migrate();
  const database = createDatabase(runtime, locks);
  await runtime.query(`insert into organization (id, name, slug) values ('org', 'Org', 'org')`);
  await runtime.query(
    `insert into github_connections (organization_id, installation_id, slug, account_id, account_login, account_type, status) values ('org', 42, 'acme', '1', 'acme', 'Organization', 'active')`,
  );
  const github = new GitHubTransport();
  const register = () =>
    createGitHubRegistration({
      database,
      auth: null,
      applicationBaseUrl: "https://hub.test",
      publicBaseUrl: "https://hub.test",
      configuration: {
        appId: "42",
        appSlug: "hub",
        clientId: "client",
        clientSecret: "secret",
        privateKey: "unused",
        webhookSecret: "secret",
      },
      appAuth: github.auth,
    });
  const registration = register();
  const drain = () => registration.sources[0]!.stop();
  const send = (
    event: string,
    action: string,
    delivery: string,
    selection: Record<string, unknown> = {},
  ) => {
    const body = JSON.stringify({
      action,
      installation: { id: 42, repository_selection: "all" },
      ...selection,
    });
    return registration.requests[0]!.handle(
      new Request("https://hub.test/webhook", {
        method: "POST",
        body,
        headers: {
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
        },
      }),
    );
  };
  return { directory, runtime, database, github, register, registration, drain, send };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
