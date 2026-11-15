import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { GitHubAuth } from "../auth/github.js";
import type { GitHubInstallation } from "../auth/github-events.js";
import { createGitHubConnectionClient } from "../providers/github/client.js";

/**
 * GitHub, as far as a Hub connection can observe it: the browser pages a person walks through
 * (authorize, install, configure) and the API Hub calls with the user access token those pages
 * produce. Every test that connects GitHub talks to this one model, so a behavior the model gets
 * right is right everywhere, and a behavior it gets wrong is wrong where someone will notice.
 *
 * The behaviors that matter, each taken from GitHub's documentation:
 *
 * - The authorize page asks once. After a person has authorized the App, GitHub redirects
 *   straight back with a code.
 * - The install page offers an account that already has the App as "Configure". Configuring
 *   changes nothing Hub can see and never sends the browser back to Hub. This is what stranded
 *   people whose App was already installed.
 * - A member who is not an owner can only request an installation; GitHub then returns to the
 *   setup URL with `setup_action=request` and no installation id.
 * - `GET /user/installations` lists every installation the person can access, including an
 *   organization's installation when they are only a member.
 * - The App requests no organization permissions, so `GET /user/memberships/orgs/{org}` answers
 *   403 and asks for `members=read`, whatever the person's role.
 * - GraphQL's `organization(login:) { viewerCanAdminister }` answers through the user token with
 *   no permission: true for an owner, false for a plain member and for someone outside the
 *   organization. An organization that does not exist resolves to null with a NOT_FOUND error.
 */
export interface FakeGitHubOptions {
  /** Where the browser reaches these pages, for example `http://127.0.0.1:4000/e2e/github`. */
  webBaseUrl: string;
  /** The Hub origin GitHub sends the browser back to, from the App's registered URLs. */
  hubOrigin: (request: Request) => string;
  appSlug?: string;
  clientId?: string;
  clientSecret?: string;
  /** Extra organizations `octo` owns, each with the App installed, for paging through lists. */
  extraOrganizations?: number;
}

export type FakeGitHubCommand =
  | { op: "signIn"; login: string }
  /** Installs the App on an account as if someone had done it on GitHub before Hub was involved. */
  | { op: "install"; account: string }
  | { op: "uninstall"; account: string }
  /** An owner suspending, or unsuspending, the App on an account. */
  | { op: "suspend"; account: string; suspended: boolean }
  /** GitHub's GraphQL API failing with a server error, or recovering. */
  | { op: "graphqlOutage"; down: boolean };

interface Account {
  id: number;
  login: string;
  type: "User" | "Organization";
  /** Fixed per account so test expectations can name the installation. */
  installationId: number;
}

interface Installation {
  id: number;
  account: Account;
  permissions: Record<string, string>;
  suspendedAt: string | null;
}

interface PendingCode {
  login: string;
  redirectUri: string;
  challenge: string;
}

/** What the App requests: repository permissions only. */
const APP_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  issues: "write",
  pull_requests: "write",
} as const;

const NAMED_ACCOUNTS: readonly Account[] = [
  { id: 501, login: "octo", type: "User", installationId: 77 },
  { id: 502, login: "mona", type: "User", installationId: 78 },
  { id: 420, login: "acme-inc", type: "Organization", installationId: 42 },
  { id: 840, login: "orbit-inc", type: "Organization", installationId: 84 },
];

export class FakeGitHub {
  private readonly accounts: Account[] = [...NAMED_ACCOUNTS];
  /** Organization roles per person. `octo` owns both organizations; `mona` is a plain member. */
  private readonly roles: Record<string, Record<string, "admin" | "member">> = {
    octo: { "acme-inc": "admin", "orbit-inc": "admin" },
    mona: { "acme-inc": "member" },
  };
  private readonly installations = new Map<number, Installation>();
  /** The path GitHub's pages are served under, taken from `webBaseUrl`. */
  private readonly prefix: string;
  private readonly authorized = new Set<string>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<string, string>();
  private signedIn = "octo";
  private graphqlDown = false;
  private readonly appSlug: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  /** API paths Hub requested, in order, for tests that assert what Hub asked GitHub. */
  readonly apiRequests: string[] = [];

  constructor(private readonly options: FakeGitHubOptions) {
    this.appSlug = options.appSlug ?? "paseo";
    this.clientId = options.clientId ?? "client";
    this.clientSecret = options.clientSecret ?? "secret";
    this.prefix = new URL(options.webBaseUrl).pathname.replace(/\/$/u, "");
    for (let index = 1; index <= (options.extraOrganizations ?? 0); index += 1) {
      const account: Account = {
        id: 10_000 + index,
        login: `extra-${index}`,
        type: "Organization",
        installationId: 10_000 + index,
      };
      this.accounts.push(account);
      this.roles["octo"]![account.login] = "admin";
      this.install(account);
    }
  }

  /** Base URLs to give the production client so its requests land here. */
  clientUrls(): { webBaseUrl: string; apiBaseUrl: string } {
    return { webBaseUrl: this.options.webBaseUrl, apiBaseUrl: API_BASE_URL };
  }

  command(command: FakeGitHubCommand): void {
    if (command.op === "signIn") {
      if (!(command.login in this.roles)) throw new Error(`unknown GitHub user: ${command.login}`);
      this.signedIn = command.login;
      return;
    }
    if (command.op === "graphqlOutage") {
      this.graphqlDown = command.down;
      return;
    }
    const account = this.accountNamed(command.account);
    if (command.op === "uninstall") {
      this.installations.delete(account.installationId);
      return;
    }
    if (command.op === "suspend") {
      const installation = this.installations.get(account.installationId);
      if (installation === undefined) throw new Error(`${account.login} has no installation`);
      installation.suspendedAt = command.suspended ? new Date().toISOString() : null;
      return;
    }
    this.install(account);
  }

  /** Answers the requests the production client sends: the token exchange and the REST API. */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/login/oauth/access_token") && request.method === "POST") {
      return this.exchange(await request.json());
    }
    if (url.origin !== API_BASE_URL) throw new Error(`unexpected GitHub request: ${request.url}`);
    this.apiRequests.push(url.pathname);
    const login = this.tokens.get(
      (request.headers.get("authorization") ?? "").replace(/^Bearer /u, ""),
    );
    if (login === undefined) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/graphql" && request.method === "POST") {
      return this.graphql(login, await request.json());
    }
    return this.api(login, url);
  };

  /**
   * The signed-in person pressing Authorize on GitHub's authorize page. Returns where GitHub sends
   * the browser: Hub's callback with a code.
   */
  authorize(authorizationUrl: string): URL {
    const accept = new URL(authorizationUrl);
    accept.pathname = `${this.prefix}/login/oauth/authorize/accept`;
    return redirectOf(this.page(new Request(accept)));
  }

  /**
   * The signed-in person pressing Install (or Request, for a non-owner) next to an account on
   * GitHub's install page. Returns where GitHub sends the browser: Hub's setup URL.
   */
  installFrom(installationUrl: string, account: string): URL {
    const install = new URL(installationUrl);
    install.pathname = `${this.prefix}/apps/${this.appSlug}/installations/new/install`;
    install.searchParams.set("account", account);
    return redirectOf(this.page(new Request(install)));
  }

  /** The browser pages. Returns undefined for anything that is not GitHub's. */
  page(request: Request): Response | undefined {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${this.prefix}/`)) return undefined;
    const path = url.pathname.slice(this.prefix.length);
    if (path === "/login/oauth/authorize") return this.authorizePage(url, false);
    if (path === "/login/oauth/authorize/accept") return this.authorizePage(url, true);
    if (path === `/apps/${this.appSlug}/installations/new`) return this.installPage(url);
    if (path === `/apps/${this.appSlug}/installations/new/install`) {
      return this.installOn(request, url);
    }
    const settings = /^\/settings\/installations\/(\d+)$/u.exec(path);
    if (settings !== null) return this.settingsPage(Number(settings[1]));
    return html("Not found", "<p>This GitHub page does not exist.</p>", 404);
  }

  /** The App's own view of an installation, as `GET /app/installations/{id}` returns it. */
  readonly appAuth: GitHubAuth = {
    getInstallation: (installationId) => {
      const installation = this.installations.get(installationId);
      return Promise.resolve(installation === undefined ? undefined : this.json(installation));
    },
    getInstallationToken: (installationId) =>
      Promise.resolve(`installation-token-${installationId}`),
    mintInstallationToken: (installationId) =>
      Promise.resolve({
        token: `installation-token-${installationId}`,
        expiresAt: Date.now() + 3600_000,
      }),
    mintInstallationAccessToken: (input) =>
      Promise.resolve({
        token: `execution-token-${input.installationId}-${input.repositories.join(",")}`,
        expiresAt: Date.now() + 3600_000,
      }),
    getAppBotIdentity: () => Promise.resolve({ id: 12345, login: `${this.appSlug}[bot]` }),
    revokeInstallationToken: () => Promise.resolve(),
    createInstallationOctokit: () => Promise.reject(new Error("unused by the fake GitHub")),
  };

  private install(account: Account): Installation {
    const installation: Installation = {
      id: account.installationId,
      account,
      permissions: { ...APP_PERMISSIONS },
      suspendedAt: null,
    };
    this.installations.set(installation.id, installation);
    return installation;
  }

  private authorizePage(url: URL, accepted: boolean): Response {
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    if (
      url.searchParams.get("client_id") !== this.clientId ||
      redirectUri === null ||
      state === null ||
      challenge === null ||
      url.searchParams.get("code_challenge_method") !== "S256"
    ) {
      return html("Authorization failed", "<p>The authorization request is invalid.</p>", 400);
    }
    if (accepted) this.authorized.add(this.signedIn);
    if (this.authorized.has(this.signedIn)) {
      const code = randomBytes(16).toString("hex");
      this.codes.set(code, { login: this.signedIn, redirectUri, challenge });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      return Response.redirect(back.toString(), 302);
    }
    const accept = new URL(url);
    accept.pathname = `${this.prefix}/login/oauth/authorize/accept`;
    const cancel = new URL(redirectUri);
    cancel.searchParams.set("error", "access_denied");
    cancel.searchParams.set("state", state);
    return html(
      `Authorize ${this.appSlug}`,
      `<p>Signed in to GitHub as ${this.signedIn}.</p>
       <p><a href="${escape(relative(accept))}">Authorize ${this.appSlug}</a></p>
       <p><a href="${escape(cancel.toString())}">Cancel</a></p>`,
    );
  }

  private installPage(url: URL): Response {
    const state = url.searchParams.get("state") ?? "";
    const items = this.accountsFor(this.signedIn).map((account) => {
      const installation = this.installations.get(account.installationId);
      if (installation !== undefined) {
        return `<li aria-label="${account.login}">${account.login} — installed
          <a href="${this.prefix}/settings/installations/${installation.id}">Configure ${account.login}</a></li>`;
      }
      const target = new URL(`${this.prefix}/apps/${this.appSlug}/installations/new/install`, url);
      target.searchParams.set("account", account.login);
      target.searchParams.set("state", state);
      const verb = this.canInstall(this.signedIn, account) ? "Install on" : "Request for";
      return `<li aria-label="${account.login}">${account.login}
        <a href="${escape(relative(target))}">${verb} ${account.login}</a></li>`;
    });
    return html(
      `Install ${this.appSlug}`,
      `<p>Where do you want to install ${this.appSlug}?</p><ul aria-label="Accounts">${items.join("")}</ul>`,
    );
  }

  private installOn(request: Request, url: URL): Response {
    const account = this.accountNamed(url.searchParams.get("account") ?? "");
    const setup = new URL("/api/integrations/github/setup", this.options.hubOrigin(request));
    const state = url.searchParams.get("state");
    if (state !== null && state.length > 0) setup.searchParams.set("state", state);
    if (this.installations.has(account.installationId)) {
      return html("Already installed", `<p>${account.login} already has this App.</p>`, 409);
    }
    if (!this.canInstall(this.signedIn, account)) {
      setup.searchParams.set("setup_action", "request");
      return Response.redirect(setup.toString(), 302);
    }
    const installation = this.install(account);
    setup.searchParams.set("installation_id", String(installation.id));
    setup.searchParams.set("setup_action", "install");
    return Response.redirect(setup.toString(), 302);
  }

  private settingsPage(installationId: number): Response {
    const installation = this.installations.get(installationId);
    if (installation === undefined) return html("Not found", "<p>No such installation.</p>", 404);
    return html(
      `Configure ${this.appSlug} on ${installation.account.login}`,
      `<p>${this.appSlug} is installed on ${installation.account.login}.</p>`,
    );
  }

  private exchange(body: unknown): Response {
    const field = (name: string): unknown =>
      typeof body === "object" && body !== null ? Reflect.get(body, name) : undefined;
    const code = field("code");
    const pending = typeof code === "string" ? this.codes.get(code) : undefined;
    if (typeof code === "string") this.codes.delete(code);
    const verifier = field("code_verifier");
    if (
      field("client_id") !== this.clientId ||
      field("client_secret") !== this.clientSecret ||
      pending === undefined ||
      field("redirect_uri") !== pending.redirectUri ||
      typeof verifier !== "string" ||
      createHash("sha256").update(verifier).digest("base64url") !== pending.challenge
    ) {
      // GitHub reports a failed exchange in a successful response.
      return Response.json({ error: "bad_verification_code" });
    }
    const token = `ghu_${randomBytes(16).toString("hex")}`;
    this.tokens.set(token, pending.login);
    return Response.json({ access_token: token, token_type: "bearer", scope: "" });
  }

  private api(login: string, url: URL): Response {
    const user = this.accountNamed(login);
    if (url.pathname === "/user") return Response.json({ id: user.id, login: user.login });
    if (url.pathname === "/user/installations") {
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      const visible = [...this.installations.values()].filter((installation) =>
        this.accountsFor(login).includes(installation.account),
      );
      return Response.json({
        total_count: visible.length,
        installations: visible
          .slice((page - 1) * perPage, page * perPage)
          .map((installation) => this.json(installation)),
      });
    }
    if (/^\/user\/memberships\/orgs\/[^/]+$/u.test(url.pathname)) {
      return Response.json(
        { message: "Resource not accessible by integration", status: "403" },
        { status: 403, headers: { "x-accepted-github-permissions": "members=read" } },
      );
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }

  /** The one query Hub sends: whether the person administers an organization. */
  private graphql(login: string, body: unknown): Response {
    if (this.graphqlDown) {
      return Response.json({ message: "Server Error" }, { status: 502 });
    }
    const parsed = GRAPHQL_REQUEST.safeParse(body);
    if (
      !parsed.success ||
      !/organization\(login: \$login\)\s*\{\s*viewerCanAdminister\s*\}/u.test(parsed.data.query)
    ) {
      throw new Error(`unexpected GitHub GraphQL request: ${JSON.stringify(body)}`);
    }
    const organization = this.accounts.find(
      (account) => account.type === "Organization" && account.login === parsed.data.variables.login,
    );
    if (organization === undefined) {
      return Response.json({
        data: { organization: null },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["organization"],
            message: `Could not resolve to an Organization with the login of '${parsed.data.variables.login}'.`,
          },
        ],
      });
    }
    return Response.json({
      data: {
        organization: { viewerCanAdminister: this.roles[login]?.[organization.login] === "admin" },
      },
    });
  }

  private accountNamed(login: string): Account {
    const account = this.accounts.find((candidate) => candidate.login === login);
    if (account === undefined) throw new Error(`unknown GitHub account: ${login}`);
    return account;
  }

  private accountsFor(login: string): Account[] {
    return [
      this.accountNamed(login),
      ...Object.keys(this.roles[login] ?? {}).map((organization) =>
        this.accountNamed(organization),
      ),
    ];
  }

  private canInstall(login: string, account: Account): boolean {
    return account.type === "User"
      ? account.login === login
      : this.roles[login]?.[account.login] === "admin";
  }

  private json(installation: Installation): GitHubInstallation {
    return {
      id: installation.id,
      account: {
        id: installation.account.id,
        login: installation.account.login,
        type: installation.account.type,
      },
      target_type: installation.account.type,
      app_slug: this.appSlug,
      permissions: { ...installation.permissions },
      suspended_at: installation.suspendedAt,
      html_url: `${this.options.webBaseUrl}/settings/installations/${installation.id}`,
    };
  }
}

const API_BASE_URL = "https://api.github.test";
const GRAPHQL_REQUEST = z.object({
  query: z.string(),
  variables: z.object({ login: z.string() }),
});

function redirectOf(response: Response | undefined): URL {
  const location = response?.headers.get("location");
  if (location === null || location === undefined) {
    throw new Error(`GitHub did not redirect: ${response?.status ?? "no page"}`);
  }
  return new URL(location);
}

function relative(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function html(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><title>${title} · GitHub</title></head><body><header>GitHub</header><main><h1>${title}</h1>${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** The production connection client, pointed at this fake. */
export function fakeGitHubConnectionClient(github: FakeGitHub, publicBaseUrl: string) {
  return createGitHubConnectionClient({
    publicBaseUrl,
    appSlug: "paseo",
    clientId: "client",
    clientSecret: "secret",
    appAuth: github.appAuth,
    fetch: github.fetch,
    ...github.clientUrls(),
  });
}
