import { z } from "zod";
import type { LinearConnectionRecord, UpdateLinearConnectionTokensInput } from "../../db/types.js";

/** The minimum authority required to read issues and leave an outcome on the issue. */
export const LINEAR_REQUIRED_SCOPES = ["read", "comments:create"] as const;

const LinearTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

const ViewerResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string().min(1),
      organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    }),
  }),
});

const GraphqlErrorSchema = z.object({
  errors: z
    .array(z.object({ message: z.string().min(1) }))
    .min(1)
    .optional(),
});

const IssueResponseSchema = z.object({
  data: z.object({
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string().min(1).optional(),
        title: z.string(),
        description: z.string().nullable().optional(),
        url: z.string().url().optional(),
        project: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        state: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        assignee: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        labels: z.object({ nodes: z.array(z.object({ id: z.string().min(1) })) }),
      })
      .nullable(),
  }),
});

const CommentResponseSchema = z.object({
  data: z.object({
    commentCreate: z.object({ success: z.literal(true) }),
  }),
});

export interface LinearInstallation {
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface LinearTokenRefresh {
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

export interface LinearConnectionClient {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<LinearInstallation>;
  refresh(refreshToken: string): Promise<LinearTokenRefresh>;
  revoke(accessToken: string): Promise<void>;
}

export interface LinearIssueDetails {
  id: string;
  identifier?: string;
  title: string;
  description: string | null;
  url?: string;
  projectId: string | null;
  stateId: string | null;
  assigneeId: string | null;
  labelIds: string[];
}

export interface LinearApiClient {
  readIssue(input: {
    linearOrganizationId: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined>;
  createComment(input: {
    linearOrganizationId: string;
    issueId: string;
    body: string;
  }): Promise<void>;
}

export function hasRequiredLinearScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return LINEAR_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

export function createLinearConnectionClient(options: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearConnectionClient {
  const request = options.fetch ?? fetch;
  const redirectUri = new URL(
    "/api/integrations/linear/callback",
    options.publicBaseUrl,
  ).toString();
  const now = options.now ?? (() => new Date());

  return {
    authorizationUrl(state) {
      const parameters = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: LINEAR_REQUIRED_SCOPES.join(","),
        state,
        // Keep workflow results visibly attributable to the installed Paseo application instead
        // of impersonating the administrator who completed the connection.
        actor: "app",
      });
      return `https://linear.app/oauth/authorize?${parameters.toString()}`;
    },
    async exchangeCode(code) {
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        },
        now,
      );
      const viewer = await readViewer(request, token.accessToken);
      return {
        linearOrganizationId: viewer.organization.id,
        linearOrganizationName: viewer.organization.name,
        appUserId: viewer.id,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        accessTokenExpiresAt: token.accessTokenExpiresAt ?? null,
        scopes: token.scopes,
      };
    },
    async refresh(refreshToken) {
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        now,
      );
      return {
        accessToken: token.accessToken,
        ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
        ...(token.accessTokenExpiresAt === undefined
          ? {}
          : { accessTokenExpiresAt: token.accessTokenExpiresAt }),
        scopes: token.scopes,
      };
    },
    async revoke(accessToken) {
      const response = await request("https://api.linear.app/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          token: accessToken,
        }),
      });
      if (!response.ok) throw new Error(`Linear revoke HTTP ${response.status}`);
    },
  };
}

/**
 * The API client always finds credentials through the external Linear organization ID. That ID is
 * part of signed webhook evidence and output context, while Hub organization IDs remain internal.
 */
export function createLinearApiClient(options: {
  connectionForLinearOrganization(
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined>;
  updateTokens(input: UpdateLinearConnectionTokensInput): Promise<void>;
  connectionClient: Pick<LinearConnectionClient, "refresh">;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearApiClient {
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const accessTokenFor = async (linearOrganizationId: string): Promise<string> => {
    const connection = await options.connectionForLinearOrganization(linearOrganizationId);
    if (connection === undefined) throw new Error("Linear connection unavailable");
    const expiresAt = connection.accessTokenExpiresAt;
    if (expiresAt === null || expiresAt.getTime() > now().getTime() + 60_000) {
      return connection.accessToken;
    }
    if (connection.refreshToken === null)
      throw new Error("Linear connection requires reauthorization");
    const refreshed = await options.connectionClient.refresh(connection.refreshToken);
    await options.updateTokens({ connectionId: connection.id, ...refreshed });
    return refreshed.accessToken;
  };

  return {
    async readIssue(input) {
      const result = IssueResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `query PaseoIssue($id: String!) {
            issue(id: $id) {
              id identifier title description url
              project { id }
              state { id }
              assignee { id }
              labels { nodes { id } }
            }
          }`,
          variables: { id: input.issueId },
        }),
      );
      const issue = result.data.issue;
      return issue === null
        ? undefined
        : {
            id: issue.id,
            ...(issue.identifier === undefined ? {} : { identifier: issue.identifier }),
            title: issue.title,
            description: issue.description ?? null,
            ...(issue.url === undefined ? {} : { url: issue.url }),
            projectId: issue.project?.id ?? null,
            stateId: issue.state?.id ?? null,
            assigneeId: issue.assignee?.id ?? null,
            labelIds: issue.labels.nodes.map(({ id }) => id),
          };
    },
    async createComment(input) {
      const result = CommentResponseSchema.parse(
        await graphql(request, await accessTokenFor(input.linearOrganizationId), {
          query: `mutation PaseoComment($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) { success }
          }`,
          variables: { issueId: input.issueId, body: input.body },
        }),
      );
      if (!result.data.commentCreate.success) throw new Error("Linear comment was not accepted");
    },
  };
}

async function exchangeToken(
  request: typeof fetch,
  options: Pick<Parameters<typeof createLinearConnectionClient>[0], "clientId" | "clientSecret">,
  values: Record<string, string>,
  now: () => Date,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  scopes: string[];
}> {
  const response = await request("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      ...values,
    }),
  });
  if (!response.ok) throw new Error(`Linear OAuth HTTP ${response.status}`);
  const token = LinearTokenResponseSchema.parse(await response.json());
  return {
    accessToken: token.access_token,
    ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
    ...(token.expires_in === undefined
      ? {}
      : { accessTokenExpiresAt: new Date(now().getTime() + token.expires_in * 1_000) }),
    scopes: parseLinearScopes(token.scope),
  };
}

async function readViewer(request: typeof fetch, accessToken: string) {
  const result = ViewerResponseSchema.parse(
    await graphql(request, accessToken, {
      query: `query PaseoViewer { viewer { id organization { id name } } }`,
      variables: {},
    }),
  );
  return result.data.viewer;
}

async function graphql(
  request: typeof fetch,
  accessToken: string,
  payload: { query: string; variables: Record<string, string> },
): Promise<unknown> {
  const response = await request("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
  const result: unknown = await response.json();
  const errors = GraphqlErrorSchema.safeParse(result);
  if (errors.success && errors.data.errors !== undefined) {
    throw new Error(`Linear GraphQL ${errors.data.errors[0]!.message}`);
  }
  return result;
}

function parseLinearScopes(scope: string | undefined): string[] {
  return [
    ...new Set(
      (scope ?? "")
        .split(/[\s,]+/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}
