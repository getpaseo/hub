import assert from "node:assert/strict";
import type { GitHubAuth } from "../auth/github.js";
import type { GitHubInstallation } from "../auth/github-events.js";

export class GitHubProviderPort implements GitHubAuth {
  readonly userInstallationPages: number[] = [];
  private readonly installation: GitHubInstallation | undefined;
  private readonly appFailure: Error | undefined;

  constructor(options: {
    installation?: GitHubInstallation | undefined;
    appFailure?: Error | undefined;
    membership?: { role: string; state: string; status?: number };
    userId?: number;
  }) {
    this.installation = options.installation;
    this.appFailure = options.appFailure;
    this.membership = options.membership ?? { role: "admin", state: "active" };
    this.userId = options.userId ?? 501;
  }

  private readonly membership: { role: string; state: string; status?: number };
  private readonly userId: number;

  options() {
    return {
      publicBaseUrl: "https://hub.example.test",
      appSlug: "paseo",
      clientId: "client",
      clientSecret: "secret",
      appAuth: this,
      fetch: this.request,
    };
  }

  getInstallation(): Promise<GitHubInstallation | undefined> {
    if (this.appFailure !== undefined) return Promise.reject(this.appFailure);
    return Promise.resolve(this.installation);
  }

  getInstallationToken(): Promise<string> {
    return Promise.reject(new Error("unused"));
  }

  mintInstallationToken(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  mintInstallationAccessToken(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  getAppBotIdentity(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  revokeInstallationToken(): Promise<void> {
    return Promise.resolve();
  }

  createInstallationOctokit(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  private readonly request: typeof fetch = (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/login/oauth/access_token") {
      return Promise.resolve(Response.json({ access_token: "user-token" }));
    }
    if (url.pathname === "/user") return Promise.resolve(Response.json({ id: this.userId }));
    if (url.pathname === "/user/memberships/orgs/acme") {
      return Promise.resolve(
        Response.json(this.membership, { status: this.membership.status ?? 200 }),
      );
    }
    assert.equal(url.pathname, "/user/installations");
    const page = Number(url.searchParams.get("page"));
    this.userInstallationPages.push(page);
    const installations =
      page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 142 }];
    return Promise.resolve(Response.json({ installations }));
  };
}

export function githubInstallation(id: number): GitHubInstallation {
  return {
    id,
    account: { id: 501, login: "acme", type: "Organization" },
    suspended_at: null,
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  return new URL(input instanceof Request ? input.url : input);
}
