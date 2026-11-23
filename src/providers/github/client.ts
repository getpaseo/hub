import { z } from "zod";
import type { GitHubAuth } from "../../auth/github.js";

export interface GitHubInstallationIdentity {
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
}

export type GitHubInstallationEvidence =
  | { status: "present"; identity: GitHubInstallationIdentity }
  | { status: "absent" };

/**
 * Whether the person who authorized can bind an installation to Hub. Only an owner can: the
 * person themself for a personal account, someone who administers the organization for an
 * organization.
 */
export type GitHubOwnership = { status: "owner" } | { status: "notOwner" };

export interface GitHubUserInstallation {
  identity: GitHubInstallationIdentity;
  ownership: GitHubOwnership;
}

export interface GitHubConnectionClient {
  /** GitHub's page for installing the App on another account. */
  installationUrl(state: string): string;
  authorizationUrl(input: { state: string; challenge: string }): string;
  /**
   * Exchanges an authorization code for the person's token and lists every installation of this
   * App they can see, with whether they own each account. Undefined when GitHub refuses the code.
   */
  userInstallations(input: {
    code: string;
    verifier: string;
  }): Promise<readonly GitHubUserInstallation[] | undefined>;
  getInstallation(installationId: number): Promise<GitHubInstallationEvidence>;
}

const userSchema = z.object({ id: z.number().int().positive() });
/**
 * GitHub answers whether the person administers an organization through the user token with no
 * App permission. REST's `/user/memberships/orgs/{org}` needs Members: read, which Hub's App does
 * not request. A missing organization resolves to null.
 */
const ADMINISTRATION_QUERY =
  "query($login: String!) { organization(login: $login) { viewerCanAdminister } }";
const administrationSchema = z.object({
  data: z
    .object({ organization: z.object({ viewerCanAdminister: z.boolean() }).nullable() })
    .nullable()
    .optional(),
});
/** GitHub answers a refused code with a successful response carrying `error`. */
const tokenSchema = z.object({ access_token: z.string().min(1).optional() }).passthrough();
const installationSchema = z
  .object({
    id: z.number().int().positive(),
    suspended_at: z.string().nullable().optional(),
    account: z
      .object({ id: z.union([z.number(), z.string()]), login: z.string(), type: z.string() })
      .passthrough(),
  })
  .passthrough();
const userInstallationsSchema = z
  .object({ installations: z.array(installationSchema) })
  .passthrough();

const PAGE_SIZE = 100;

export function createGitHubConnectionClient(input: {
  publicBaseUrl: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  appAuth: GitHubAuth;
  fetch?: typeof fetch;
  /** GitHub's web and API hosts. Only tests point these anywhere else. */
  webBaseUrl?: string;
  apiBaseUrl?: string;
}): GitHubConnectionClient {
  const request = input.fetch ?? fetch;
  const web = (path: string) => githubUrl(input.webBaseUrl ?? "https://github.com", path);
  const api = (path: string) => githubUrl(input.apiBaseUrl ?? "https://api.github.com", path);
  const callback = new URL("/api/integrations/github/callback", input.publicBaseUrl).toString();
  return {
    installationUrl(state) {
      const url = web(`/apps/${input.appSlug}/installations/new`);
      url.searchParams.set("state", state);
      return url.toString();
    },
    authorizationUrl({ state, challenge }) {
      const url = web("/login/oauth/authorize");
      url.searchParams.set("client_id", input.clientId);
      url.searchParams.set("redirect_uri", callback);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async userInstallations({ code, verifier }) {
      const exchanged = await request(web("/login/oauth/access_token"), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code,
          redirect_uri: callback,
          code_verifier: verifier,
        }),
      });
      if (!exchanged.ok) throw new Error(`github oauth exchange failed: ${exchanged.status}`);
      const token = tokenSchema.parse(await exchanged.json());
      if (token.access_token === undefined) return undefined;
      const user = new GitHubUser(request, api, token.access_token);
      const installations = await user.installations();
      return Promise.all(
        installations.map(async (installation) => ({
          identity: identityOf(installation),
          ownership: await user.ownership(installation),
        })),
      );
    },
    async getInstallation(installationId) {
      const identity = await readInstallation(input.appAuth, installationId);
      return identity === undefined ? { status: "absent" } : { status: "present", identity };
    },
  };
}

type GitHubInstallationPayload = z.infer<typeof installationSchema>;

function identityOf(installation: z.infer<typeof installationSchema>): GitHubInstallationIdentity {
  return {
    installationId: installation.id,
    accountId: String(installation.account.id),
    accountLogin: installation.account.login,
    accountType: installation.account.type,
    status: installation.suspended_at == null ? "active" : "suspended",
  };
}

/** GitHub as one person sees it, through their user access token. */
class GitHubUser {
  private id: Promise<string> | undefined;

  constructor(
    private readonly request: typeof fetch,
    private readonly api: (path: string) => URL,
    private readonly token: string,
  ) {}

  async installations(): Promise<GitHubInstallationPayload[]> {
    const listed: GitHubInstallationPayload[] = [];
    for (let page = 1; ; page += 1) {
      const url = this.api("/user/installations");
      url.searchParams.set("per_page", String(PAGE_SIZE));
      url.searchParams.set("page", String(page));
      const response = await this.get(url);
      if (!response.ok) throw new Error(`github user installations failed: ${response.status}`);
      const { installations } = userInstallationsSchema.parse(await response.json());
      listed.push(...installations);
      if (installations.length < PAGE_SIZE) return listed;
    }
  }

  async ownership(installation: GitHubInstallationPayload): Promise<GitHubOwnership> {
    const { account } = installation;
    if (account.type === "User") {
      return (await this.userId()) === String(account.id)
        ? { status: "owner" }
        : { status: "notOwner" };
    }
    if (account.type !== "Organization") return { status: "notOwner" };
    return (await this.administers(account.login)) ? { status: "owner" } : { status: "notOwner" };
  }

  /** Throws when GitHub gives no answer, so an outage never reads as "not an owner". */
  private async administers(organization: string): Promise<boolean> {
    const response = await this.request(this.api("/graphql"), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: ADMINISTRATION_QUERY, variables: { login: organization } }),
    });
    if (!response.ok) {
      throw new Error(`github organization administration failed: ${response.status}`);
    }
    const { data } = administrationSchema.parse(await response.json());
    if (data === undefined || data === null) {
      throw new Error("github organization administration failed: no data");
    }
    return data.organization?.viewerCanAdminister === true;
  }

  private userId(): Promise<string> {
    this.id ??= this.get(this.api("/user")).then(async (response) => {
      if (!response.ok) throw new Error(`github authenticated user failed: ${response.status}`);
      return String(userSchema.parse(await response.json()).id);
    });
    return this.id;
  }

  private get(url: URL): Promise<Response> {
    return this.request(url, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}` },
    });
  }
}

async function readInstallation(
  appAuth: GitHubAuth,
  installationId: number,
): Promise<GitHubInstallationIdentity | undefined> {
  const installation = await appAuth.getInstallation(installationId);
  return installation === undefined
    ? undefined
    : identityOf(installationSchema.parse(installation));
}

/** Joins a path onto a base that may carry its own path prefix. */
function githubUrl(base: string, path: string): URL {
  return new URL(`${base.replace(/\/$/u, "")}${path}`);
}
