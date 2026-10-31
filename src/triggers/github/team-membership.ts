import { GITHUB_APP_PERMISSION_VOCABULARY } from "../../config/github-authority.js";
import { logger } from "../../logger.js";
import { z } from "zod";

const TeamMembershipSchema = z.object({ state: z.enum(["active", "pending"]) }).passthrough();

export interface GitHubTeamMembershipClient {
  isActiveMember(input: GitHubTeamMembershipCheck): Promise<boolean>;
}

export interface GitHubTeamMembershipCheck {
  installationId: number;
  organization: string;
  teamSlug: string;
  username: string;
}

export interface GitHubTeamMembershipAuth {
  createInstallationOctokit(installationId: number): Promise<GitHubTeamMembershipOctokit>;
}

interface GitHubTeamMembershipOctokit {
  request(
    route: "GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
    parameters: {
      org: string;
      team_slug: string;
      username: string;
      headers: { "x-github-api-version": string };
    },
  ): Promise<{ data: unknown }>;
}

export function createGitHubTeamMembershipClient(
  auth: GitHubTeamMembershipAuth,
): GitHubTeamMembershipClient {
  return {
    async isActiveMember(input) {
      try {
        const octokit = await auth.createInstallationOctokit(input.installationId);
        const response = await octokit.request(
          "GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
          {
            org: input.organization,
            team_slug: input.teamSlug,
            username: input.username,
            headers: {
              "x-github-api-version": GITHUB_APP_PERMISSION_VOCABULARY.apiVersion,
            },
          },
        );
        return TeamMembershipSchema.parse(response.data).state === "active";
      } catch (error) {
        if (hasHttpStatus(error, 404)) return false;
        logger.warn(
          {
            err: error,
            installationId: input.installationId,
            organization: input.organization,
            teamSlug: input.teamSlug,
            username: input.username,
          },
          hasHttpStatus(error, 403)
            ? "GitHub team trigger filter access was denied; denying trigger"
            : "GitHub team trigger filter check failed; denying trigger",
        );
        return false;
      }
    },
  };
}

function hasHttpStatus(error: unknown, status: number): boolean {
  if (error === null || typeof error !== "object") return false;
  return Reflect.get(error, "status") === status;
}
