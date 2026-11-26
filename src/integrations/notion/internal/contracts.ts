import { z } from "zod";
import type { IntegrationToolFormDraft } from "../../browser-contracts.js";

export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_MAX_TARGETS = 50;
export const NOTION_MAX_HOPS = 6;
export const NOTION_TOOL_ACTIONS = ["read", "comment", "write"] as const;

export type NotionToolAction = (typeof NOTION_TOOL_ACTIONS)[number];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DASHED_UUID_PATTERN =
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/iu;
const COMPACT_UUID_PATTERN = /^([0-9a-f]{32})$/iu;
const TRAILING_COMPACT_UUID_PATTERN = /([0-9a-f]{32})$/iu;
const TRAILING_DASHED_UUID_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

function formatDashedUuid(hex32: string): string {
  const lower = hex32.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20, 32)}`;
}

function normalizeBareUuid(value: string): string | undefined {
  const trimmed = value.trim();
  const dashed = DASHED_UUID_PATTERN.exec(trimmed);
  if (dashed !== null) return trimmed.toLowerCase();
  const compact = COMPACT_UUID_PATTERN.exec(trimmed);
  if (compact !== null) return formatDashedUuid(compact[1]!);
  return undefined;
}

function isNotionHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "notion.so" ||
    lower.endsWith(".notion.so") ||
    lower === "notion.site" ||
    lower.endsWith(".notion.site")
  );
}

function extractTrailingUuid(segment: string): string | undefined {
  const dashed = TRAILING_DASHED_UUID_PATTERN.exec(segment);
  if (dashed !== null) return dashed[1]!.toLowerCase();
  const compact = TRAILING_COMPACT_UUID_PATTERN.exec(segment);
  if (compact !== null) return formatDashedUuid(compact[1]!);
  return undefined;
}

/**
 * Normalizes a Notion UUID (with or without dashes) or a pasted Notion URL into canonical
 * lowercase `8-4-4-4-12` UUID form. Returns `undefined` when the input is not a valid Notion ID
 * or URL.
 */
export function normalizeNotionUuid(input: string): string | undefined {
  const bare = normalizeBareUuid(input);
  if (bare !== undefined) return bare;

  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !isNotionHostname(parsed.hostname)
  ) {
    return undefined;
  }

  // Side-peek URLs carry the focused page ID in `?p=<id>` while the path holds the parent database.
  const peekParam = parsed.searchParams.get("p");
  if (peekParam !== null) {
    const peekUuid = normalizeBareUuid(peekParam);
    if (peekUuid !== undefined) return peekUuid;
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined) return undefined;
  return extractTrailingUuid(decodeURIComponent(last));
}

export const NotionConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: z.literal("notion"),
    mode: z.literal("internal"),
    apiToken: z.string().trim().min(1),
  }),
  z.object({
    provider: z.literal("notion"),
    mode: z.literal("oauth"),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().trim().min(1),
  }),
]);

export type NotionConfig = z.infer<typeof NotionConfigSchema>;

export const NotionIdentitySchema = z.object({
  provider: z.literal("notion"),
  id: z.string().min(1),
  name: z.string().min(1),
});

export type NotionIdentity = z.infer<typeof NotionIdentitySchema>;

export const NotionTargetIdSchema = z
  .string()
  .trim()
  .min(1, "Enter a Notion ID or URL")
  .refine((value) => normalizeNotionUuid(value) !== undefined, "Use a valid Notion ID or URL");

export const NotionToolGrantSchema = z
  .strictObject({
    connection: z.string().regex(SLUG_PATTERN, "Use an integration slug"),
    actions: z
      .array(z.enum(NOTION_TOOL_ACTIONS))
      .min(1, "Select at least one Notion permission")
      .max(NOTION_TOOL_ACTIONS.length),
    data_sources: z.array(NotionTargetIdSchema).min(1).optional(),
    pages: z.array(NotionTargetIdSchema).min(1).optional(),
  })
  .superRefine((grant, ctx) => {
    const total = (grant.data_sources?.length ?? 0) + (grant.pages?.length ?? 0);
    if (total === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["data_sources"],
        message: "Provide at least one Notion data source or page",
      });
    } else if (total > NOTION_MAX_TARGETS) {
      ctx.addIssue({
        code: "custom",
        path: ["data_sources"],
        message: `At most ${NOTION_MAX_TARGETS} Notion targets may be granted`,
      });
    }
  });

export type NotionToolGrant = z.infer<typeof NotionToolGrantSchema>;

function normalizeIdList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const normalized = [
    ...new Set(
      values
        .map((value) => normalizeNotionUuid(value))
        .filter((value): value is string => value !== undefined),
    ),
  ].toSorted();
  return normalized.length === 0 ? undefined : normalized;
}

export function normalizeNotionToolGrant(grant: NotionToolGrant): NotionToolGrant {
  const dataSources = normalizeIdList(grant.data_sources);
  const pages = normalizeIdList(grant.pages);
  return {
    connection: grant.connection,
    actions: NOTION_TOOL_ACTIONS.filter((action) => grant.actions.includes(action)),
    ...(dataSources === undefined ? {} : { data_sources: dataSources }),
    ...(pages === undefined ? {} : { pages }),
  };
}

const DraftGrantParseSchema = z.object({
  connection: z.string().optional(),
  actions: z.array(z.string()).optional(),
  data_sources: z.array(z.string()).optional(),
  pages: z.array(z.string()).optional(),
});

export function splitNotionTargetList(raw: string): string[] {
  return raw
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function notionDraftFromGrant(grant: unknown): IntegrationToolFormDraft {
  const parsed = DraftGrantParseSchema.safeParse(grant);
  const record = parsed.success ? parsed.data : {};
  return {
    enabled: true,
    connection: record.connection ?? "",
    actions: record.actions ?? [],
    fields: {
      data_sources: (record.data_sources ?? []).join(", "),
      pages: (record.pages ?? []).join(", "),
    },
  };
}

export function notionDraftToGrant(
  draft: IntegrationToolFormDraft,
): Readonly<Record<string, unknown>> {
  const dataSources = splitNotionTargetList(draft.fields["data_sources"] ?? "");
  const pages = splitNotionTargetList(draft.fields["pages"] ?? "");
  return {
    connection: draft.connection,
    actions: draft.actions,
    ...(dataSources.length === 0 ? {} : { data_sources: dataSources }),
    ...(pages.length === 0 ? {} : { pages }),
  };
}

export function validateNotionToolDraft(draft: IntegrationToolFormDraft): readonly string[] {
  const errors: string[] = [];
  if (draft.connection.trim().length === 0) {
    errors.push("Choose a Notion connection");
  }
  if (draft.actions.length === 0) {
    errors.push("Select at least one Notion permission");
  }
  const dataSources = splitNotionTargetList(draft.fields["data_sources"] ?? "");
  const pages = splitNotionTargetList(draft.fields["pages"] ?? "");
  const total = dataSources.length + pages.length;
  if (total === 0) {
    errors.push("Provide at least one Notion data source or page");
  } else if (total > NOTION_MAX_TARGETS) {
    errors.push(`At most ${NOTION_MAX_TARGETS} Notion targets may be granted`);
  }
  for (const target of [...dataSources, ...pages]) {
    if (normalizeNotionUuid(target) === undefined) {
      errors.push("Use a valid Notion ID or URL");
      break;
    }
  }
  return errors;
}

export const NotionCredentialsSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("internal"),
    accessToken: z.string().min(1),
  }),
  z.object({
    mode: z.literal("oauth"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).nullable().optional(),
    accessTokenExpiresAt: z.string().nullable().optional(),
    botId: z.string().min(1),
    workspaceId: z.string().min(1),
    ownerUserId: z.string().min(1).optional(),
  }),
]);

export type NotionCredentials = z.infer<typeof NotionCredentialsSchema>;

export const NotionConnectionMetadataSchema = z.object({
  mode: z.enum(["internal", "oauth"]),
  botId: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  ownerUserId: z.string().min(1).optional(),
});

export type NotionConnectionMetadata = z.infer<typeof NotionConnectionMetadataSchema>;
