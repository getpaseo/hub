import { z } from "zod";
import { GITHUB_APP_PERMISSION_VOCABULARY } from "../config/github-authority.js";

export const GITHUB_MANIFEST_CALLBACK_PATH = "/api/integrations/github/manifest/callback";

export const GITHUB_MANIFEST_PERMISSIONS = {
  contents: "write",
  issues: "write",
  pull_requests: "write",
  metadata: "read",
} as const;

export const GITHUB_MANIFEST_EVENTS = [
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
] as const;

export interface GitHubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: readonly string[];
  setup_url: string;
  setup_on_update: true;
  public: false;
  default_permissions: typeof GITHUB_MANIFEST_PERMISSIONS;
  hook_attributes?: { url: string; active: true };
  default_events?: typeof GITHUB_MANIFEST_EVENTS;
}

export interface GitHubManifestRegistration {
  action: string;
  state: string;
  manifest: GitHubAppManifest;
}

export interface GitHubManifestConversion {
  appId: string;
  appSlug: string;
  name: string;
  ownerLogin: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  webhookSecret?: string;
}

export interface GitHubManifestClient {
  convert(code: string): Promise<GitHubManifestConversion>;
}

const conversionSchema = z.looseObject({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  name: z.string().min(1),
  owner: z.looseObject({ login: z.string().min(1) }),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().min(1).nullable(),
  pem: z.string().min(1),
});

export function createGitHubAppManifest(origin: string): GitHubAppManifest {
  const secure = new URL(origin).protocol === "https:";
  return {
    name: "Paseo Hub",
    url: origin,
    redirect_url: new URL(GITHUB_MANIFEST_CALLBACK_PATH, origin).toString(),
    callback_urls: [new URL("/api/integrations/github/callback", origin).toString()],
    setup_url: new URL("/api/integrations/github/setup", origin).toString(),
    setup_on_update: true,
    public: false,
    default_permissions: GITHUB_MANIFEST_PERMISSIONS,
    ...(secure
      ? {
          hook_attributes: { url: new URL("/webhook", origin).toString(), active: true as const },
          default_events: GITHUB_MANIFEST_EVENTS,
        }
      : {}),
  };
}

export function githubManifestRegistrationAction(organization?: string): string {
  if (organization === undefined || organization === "") {
    return "https://github.com/settings/apps/new";
  }
  return `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
}

export function createGitHubManifestClient(
  options: {
    fetch?: typeof fetch;
    apiBaseUrl?: string;
  } = {},
): GitHubManifestClient {
  const request = options.fetch ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  return {
    async convert(code) {
      const response = await request(
        new URL(`/app-manifests/${encodeURIComponent(code)}/conversions`, apiBaseUrl),
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_APP_PERMISSION_VOCABULARY.apiVersion,
          },
        },
      );
      if (!response.ok) throw new GitHubManifestConversionError(response.status);
      const parsed = conversionSchema.safeParse(await response.json());
      if (!parsed.success) throw new GitHubManifestConversionError(502);
      return {
        appId: String(parsed.data.id),
        appSlug: parsed.data.slug,
        name: parsed.data.name,
        ownerLogin: parsed.data.owner.login,
        clientId: parsed.data.client_id,
        clientSecret: parsed.data.client_secret,
        privateKey: parsed.data.pem,
        ...(parsed.data.webhook_secret === null
          ? {}
          : { webhookSecret: parsed.data.webhook_secret }),
      };
    },
  };
}

export class GitHubManifestConversionError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub manifest conversion failed with HTTP ${status}`);
    this.name = "GitHubManifestConversionError";
    this.status = status;
  }
}
