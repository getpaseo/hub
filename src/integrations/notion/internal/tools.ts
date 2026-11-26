import { z } from "zod";
import { IntegrationToolError } from "../../../integration-tools/http.js";
import type {
  IntegrationRuntimeContext,
  IntegrationToolsCapability,
  IntegrationToolSpec,
} from "../../contracts.js";
import { createNotionConnectionExecutor, NotionApiError } from "./client.js";
import {
  NOTION_MAX_HOPS,
  normalizeNotionToolGrant,
  normalizeNotionUuid,
  NotionConfigSchema,
  NotionToolGrantSchema,
  type NotionConfig,
  type NotionToolAction,
  type NotionToolGrant,
} from "./contracts.js";

const NOTION_OUT_OF_SCOPE_MESSAGE = "This Notion page is outside the trigger's granted scope.";
const NOTION_DATA_SOURCE_OUT_OF_SCOPE_MESSAGE =
  "This Notion data source is outside the trigger's granted scope.";
const NOTION_INVALID_ID_MESSAGE = "Invalid Notion page or database ID or URL.";

const NotionParentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("data_source_id"),
    data_source_id: z.string().min(1),
    database_id: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("database_id"),
    database_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("page_id"),
    page_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("block_id"),
    block_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("workspace"),
    workspace: z.boolean().optional(),
  }),
]);

const NotionPageSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().optional(),
    parent: NotionParentSchema,
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const NotionPatchedPageSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().optional(),
  })
  .passthrough();

type NotionPage = z.infer<typeof NotionPageSchema>;

const NotionBlockSchema = z
  .object({
    id: z.string().min(1),
    parent: NotionParentSchema,
  })
  .passthrough();

type NotionBlock = z.infer<typeof NotionBlockSchema>;

const NotionMarkdownSchema = z
  .object({
    markdown: z.string(),
    truncated: z.boolean().optional(),
    unknown_block_ids: z.array(z.string()).optional(),
  })
  .passthrough();

const NotionDatabaseSchema = z
  .object({
    id: z.string().min(1),
    data_sources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const NotionDataSourceSchema = z
  .object({
    id: z.string().min(1),
    title: z.array(z.object({ plain_text: z.string().optional() }).passthrough()).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const NotionQueryResponseSchema = z
  .object({
    results: z.array(z.record(z.string(), z.unknown())),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean().optional(),
  })
  .passthrough();

const NotionCommentsListSchema = z
  .object({
    results: z.array(z.record(z.string(), z.unknown())),
    next_cursor: z.string().nullable().optional(),
    has_more: z.boolean().optional(),
  })
  .passthrough();

const NotionCreatedCommentSchema = z
  .object({
    id: z.string().min(1),
    discussion_id: z.string().min(1).optional(),
    created_time: z.string().optional(),
  })
  .passthrough();

const NotionUpdateMarkdownResponseSchema = z
  .object({
    markdown: z.string().optional(),
    warnings: z.array(z.unknown()).optional(),
  })
  .passthrough();

const ListTargetsArgsSchema = z.strictObject({});

const ReadPageArgsSchema = z.strictObject({
  page: z.string().trim().min(1),
  include_comments: z.boolean().optional(),
});

const QueryDatabaseArgsSchema = z.strictObject({
  data_source: z.string().trim().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
  sorts: z.array(z.record(z.string(), z.unknown())).optional(),
  start_cursor: z.string().min(1).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
});

const CommentArgsSchema = z.strictObject({
  page: z.string().trim().min(1),
  markdown: z.string().trim().min(1),
  discussion_id: z.string().trim().min(1).optional(),
});

const ContentUpdateOpSchema = z.strictObject({
  old_str: z.string().min(1),
  new_str: z.string(),
  replace_all_matches: z.boolean().optional(),
});

const InsertContentOpSchema = z.strictObject({
  content: z.string().min(1),
  after: z.string().min(1).optional(),
});

const UpdatePageArgsSchema = z
  .strictObject({
    page: z.string().trim().min(1),
    properties: z.record(z.string(), z.unknown()).optional(),
    content_updates: z.array(ContentUpdateOpSchema).min(1).optional(),
    insert_content: InsertContentOpSchema.optional(),
  })
  .refine(
    (input) =>
      input.properties !== undefined ||
      input.content_updates !== undefined ||
      input.insert_content !== undefined,
    "Provide properties, content_updates, or insert_content to update.",
  )
  .refine(
    (input) => !(input.content_updates !== undefined && input.insert_content !== undefined),
    "Provide either content_updates or insert_content in a single call, not both.",
  );

const NOTION_TOOL_SPECS: readonly (IntegrationToolSpec & { readonly action: NotionToolAction })[] =
  [
    {
      action: "read",
      schema: ListTargetsArgsSchema,
      definition: {
        name: "notion_list_targets",
        description: "List the Notion data sources and root pages granted to this execution.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    {
      action: "read",
      schema: ReadPageArgsSchema,
      definition: {
        name: "notion_read_page",
        description:
          "Read a granted Notion page's properties, v2 Markdown content, and optionally unresolved comments.",
        inputSchema: {
          type: "object",
          properties: {
            page: {
              type: "string",
              description: "Notion page ID (UUID) or Notion page URL.",
            },
            include_comments: {
              type: "boolean",
              description: "When true, include unresolved page comments.",
            },
          },
          required: ["page"],
          additionalProperties: false,
        },
      },
    },
    {
      action: "read",
      schema: QueryDatabaseArgsSchema,
      definition: {
        name: "notion_query_database",
        description:
          "Query rows in a granted Notion data source or single-source database with optional filter, sorts, and cursor.",
        inputSchema: {
          type: "object",
          properties: {
            data_source: {
              type: "string",
              description: "Granted Notion data source ID, database ID, or Notion database URL.",
            },
            filter: {
              type: "object",
              description: "Optional Notion data source query filter object.",
            },
            sorts: {
              type: "array",
              items: { type: "object" },
              description: "Optional Notion sort objects.",
            },
            start_cursor: {
              type: "string",
              description: "Pagination cursor from a previous query.",
            },
            page_size: {
              type: "number",
              description: "Maximum rows to return (1-50, default 25).",
            },
          },
          required: ["data_source"],
          additionalProperties: false,
        },
      },
    },
    {
      action: "comment",
      schema: CommentArgsSchema,
      definition: {
        name: "notion_comment",
        description:
          "Post a comment on an in-scope Notion page or reply inside an existing discussion_id. Notion comments render inline-only Markdown (bold, italic, inline code, links; no headings, bullet lists, tables, or fenced code blocks).",
        inputSchema: {
          type: "object",
          properties: {
            page: {
              type: "string",
              description: "Granted Notion page ID (UUID) or Notion page URL.",
            },
            markdown: {
              type: "string",
              description: "Inline-only Markdown comment body (bold, italic, inline code, links).",
            },
            discussion_id: {
              type: "string",
              description: "Optional Notion discussion_id to reply within an existing thread.",
            },
          },
          required: ["page", "markdown"],
          additionalProperties: false,
        },
      },
    },
    {
      action: "write",
      schema: UpdatePageArgsSchema,
      definition: {
        name: "notion_update_page",
        description:
          "Update structured properties and/or apply targeted v2 Markdown search-replace or anchored insert edits on an in-scope Notion page.",
        inputSchema: {
          type: "object",
          properties: {
            page: {
              type: "string",
              description: "Granted Notion page ID (UUID) or Notion page URL.",
            },
            properties: {
              type: "object",
              description: "Notion page property updates object.",
            },
            content_updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  old_str: { type: "string" },
                  new_str: { type: "string" },
                  replace_all_matches: { type: "boolean" },
                },
                required: ["old_str", "new_str"],
                additionalProperties: false,
              },
              description: "Targeted Markdown search-and-replace operations.",
            },
            insert_content: {
              type: "object",
              properties: {
                content: { type: "string" },
                after: { type: "string" },
              },
              required: ["content"],
              additionalProperties: false,
              description: "Targeted Markdown insertion, optionally anchored after a snippet.",
            },
          },
          required: ["page"],
          additionalProperties: false,
        },
      },
    },
  ];

function requirePageUuid(raw: string): string {
  const normalized = normalizeNotionUuid(raw);
  if (normalized === undefined) {
    throw new IntegrationToolError(NOTION_INVALID_ID_MESSAGE);
  }
  return normalized;
}

function extractPageTitle(properties: Record<string, unknown> | undefined): string | null {
  if (properties === undefined) return null;
  for (const value of Object.values(properties)) {
    if (typeof value !== "object" || value === null) continue;
    if (Reflect.get(value, "type") !== "title") continue;
    const titleItems: unknown = Reflect.get(value, "title");
    if (!Array.isArray(titleItems)) continue;
    const text = titleItems
      .map((item) => {
        if (typeof item !== "object" || item === null) return undefined;
        const plain: unknown = Reflect.get(item, "plain_text");
        return typeof plain === "string" ? plain : undefined;
      })
      .filter((entry): entry is string => entry !== undefined)
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}

function extractRichTextPlain(
  items: readonly { plain_text?: string | undefined }[] | undefined,
): string | null {
  if (items === undefined || items.length === 0) return null;
  const text = items
    .map((item) => item.plain_text ?? "")
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

function mapNotionToolError(error: unknown, scopeMessage = NOTION_OUT_OF_SCOPE_MESSAGE): never {
  if (error instanceof IntegrationToolError) throw error;
  if (error instanceof NotionApiError) {
    if (error.status === 403 && error.code === "restricted_resource") {
      throw new IntegrationToolError(
        "The Notion connection lacks permission for this resource. Check the integration capabilities and page sharing.",
      );
    }
    if (error.status === 404) {
      throw new IntegrationToolError(scopeMessage);
    }
    if (error.status === 400 || error.status === 409) {
      throw new IntegrationToolError(`Notion rejected the request: ${error.message}`);
    }
    if (error.status === 429 || error.status === 529) {
      throw new IntegrationToolError("Notion rate limit reached. Retry shortly.");
    }
    throw new IntegrationToolError(`Notion request failed (HTTP ${error.status}).`);
  }
  throw error;
}

const MAX_COMMENT_VERIFY_PAGES = 20;

interface ScopedCallState {
  readonly organizationId: string;
  readonly grant: NotionToolGrant;
  readonly pageCache: Map<string, NotionPage>;
  readonly blockCache: Map<string, NotionBlock>;
  readonly resolvedDbCache: Map<string, string>;
}

const NotionCommentEntrySchema = z
  .object({
    discussion_id: z.string().min(1).optional(),
    parent: NotionParentSchema.optional(),
  })
  .passthrough();

export const notionToolsCapability: IntegrationToolsCapability<NotionConfig, NotionToolGrant> = {
  grantSchema: NotionToolGrantSchema,
  normalizeGrant: normalizeNotionToolGrant,
  tools: NOTION_TOOL_SPECS,
  outboundLinkActions: ["comment"],
  linkFormatHint: (url) => `For Notion use [Open in Paseo](${url}).`,
  createHandler(rawConfig, context: IntegrationRuntimeContext) {
    const config = NotionConfigSchema.parse(rawConfig);
    const executor = createNotionConnectionExecutor({
      database: context.database,
      config,
      identityId: context.identity.id,
      fetch: context.fetch,
      now: context.now,
    });

    async function fetchBlockCached(state: ScopedCallState, blockId: string): Promise<NotionBlock> {
      const existing = state.blockCache.get(blockId);
      if (existing !== undefined) return existing;
      const raw = await executor.request({
        organizationId: state.organizationId,
        connectionSlug: state.grant.connection,
        method: "GET",
        path: `/blocks/${blockId}`,
      });
      const parsed = NotionBlockSchema.parse(raw);
      state.blockCache.set(blockId, parsed);
      return parsed;
    }

    async function fetchPageCached(state: ScopedCallState, pageId: string): Promise<NotionPage> {
      const existing = state.pageCache.get(pageId);
      if (existing !== undefined) return existing;
      const raw = await executor.request({
        organizationId: state.organizationId,
        connectionSlug: state.grant.connection,
        method: "GET",
        path: `/pages/${pageId}`,
      });
      const parsed = NotionPageSchema.parse(raw);
      state.pageCache.set(pageId, parsed);
      return parsed;
    }

    async function resolveSingleDataSource(
      state: ScopedCallState,
      databaseId: string,
    ): Promise<string | undefined> {
      const cached = state.resolvedDbCache.get(databaseId);
      if (cached !== undefined) return cached;
      try {
        const raw = await executor.request({
          organizationId: state.organizationId,
          connectionSlug: state.grant.connection,
          method: "GET",
          path: `/databases/${databaseId}`,
        });
        const db = NotionDatabaseSchema.parse(raw);
        const sources = db.data_sources ?? [];
        if (sources.length === 1) {
          state.resolvedDbCache.set(databaseId, sources[0]!.id);
          return sources[0]!.id;
        }
        if (sources.length > 1) {
          throw new IntegrationToolError(
            `Notion database ${databaseId} has multiple data sources (${sources.map((s) => s.id).join(", ")}). Grant a specific data_source_id instead.`,
          );
        }
        return undefined;
      } catch (error) {
        if (error instanceof NotionApiError && error.status === 404) return undefined;
        throw error;
      }
    }

    async function isDataSourceIdGranted(
      state: ScopedCallState,
      candidateId: string,
      alternateDatabaseId?: string,
    ): Promise<boolean> {
      const granted = state.grant.data_sources ?? [];
      if (granted.length === 0) return false;
      const normalizedCandidate = normalizeNotionUuid(candidateId) ?? candidateId;
      if (granted.includes(normalizedCandidate)) return true;
      if (alternateDatabaseId !== undefined) {
        const normalizedDb = normalizeNotionUuid(alternateDatabaseId) ?? alternateDatabaseId;
        if (granted.includes(normalizedDb)) return true;
      }
      // If any granted target was pasted as a database_id, resolve it once (cached) to check match.
      for (const grantedTarget of granted) {
        const resolved = await resolveSingleDataSource(state, grantedTarget);
        if (resolved !== undefined) {
          const normalizedResolved = normalizeNotionUuid(resolved) ?? resolved;
          if (normalizedResolved === normalizedCandidate) return true;
        }
      }
      return false;
    }

    type ScopeCursor =
      | { readonly kind: "page"; readonly id: string }
      | { readonly kind: "block"; readonly id: string };

    async function stepParentScope(
      state: ScopedCallState,
      parent: z.infer<typeof NotionParentSchema>,
    ): Promise<{ readonly matched: boolean; readonly next?: ScopeCursor }> {
      if (parent.type === "data_source_id") {
        const matched = await isDataSourceIdGranted(
          state,
          parent.data_source_id,
          parent.database_id,
        );
        return { matched };
      }
      if (parent.type === "database_id") {
        const matched = await isDataSourceIdGranted(state, parent.database_id);
        return { matched };
      }
      if (parent.type === "page_id") {
        const parentPageId = normalizeNotionUuid(parent.page_id) ?? parent.page_id;
        if ((state.grant.pages ?? []).includes(parentPageId)) {
          return { matched: true };
        }
        return { matched: false, next: { kind: "page", id: parentPageId } };
      }
      if (parent.type === "block_id") {
        const parentBlockId = normalizeNotionUuid(parent.block_id) ?? parent.block_id;
        return { matched: false, next: { kind: "block", id: parentBlockId } };
      }
      return { matched: false };
    }

    async function ensurePageInScope(
      state: ScopedCallState,
      targetPageId: string,
    ): Promise<NotionPage> {
      const grantedPages = state.grant.pages ?? [];
      if (grantedPages.includes(targetPageId)) {
        return fetchPageCached(state, targetPageId);
      }

      const visited = new Set<string>();
      let cursor: ScopeCursor = { kind: "page", id: targetPageId };
      let targetPage: NotionPage | undefined;

      for (let hop = 0; hop < NOTION_MAX_HOPS; hop += 1) {
        const visitKey = `${cursor.kind}:${cursor.id}`;
        if (visited.has(visitKey)) break;
        visited.add(visitKey);

        let parent: z.infer<typeof NotionParentSchema>;
        try {
          if (cursor.kind === "page") {
            const page = await fetchPageCached(state, cursor.id);
            targetPage ??= page;
            parent = page.parent;
          } else {
            const block = await fetchBlockCached(state, cursor.id);
            parent = block.parent;
          }
        } catch (error) {
          mapNotionToolError(error, NOTION_OUT_OF_SCOPE_MESSAGE);
        }

        const step = await stepParentScope(state, parent);
        if (step.matched) return targetPage!;
        if (step.next === undefined) break;
        cursor = step.next;
      }

      throw new IntegrationToolError(NOTION_OUT_OF_SCOPE_MESSAGE);
    }

    async function resolveGrantedDataSource(
      state: ScopedCallState,
      targetId: string,
    ): Promise<string> {
      const granted = state.grant.data_sources ?? [];
      if (granted.includes(targetId)) {
        try {
          await executor.request({
            organizationId: state.organizationId,
            connectionSlug: state.grant.connection,
            method: "GET",
            path: `/data_sources/${targetId}`,
          });
          return targetId;
        } catch (error) {
          if (error instanceof NotionApiError && error.status === 404) {
            const resolved = await resolveSingleDataSource(state, targetId);
            if (resolved !== undefined) return resolved;
          }
          mapNotionToolError(error, NOTION_DATA_SOURCE_OUT_OF_SCOPE_MESSAGE);
        }
      }

      // Target might be a database_id whose single data_source_id is granted (or vice versa).
      const resolvedTarget = await resolveSingleDataSource(state, targetId);
      if (resolvedTarget !== undefined) {
        const normalizedResolved = normalizeNotionUuid(resolvedTarget) ?? resolvedTarget;
        if (await isDataSourceIdGranted(state, normalizedResolved, targetId)) {
          return normalizedResolved;
        }
      }

      throw new IntegrationToolError(NOTION_DATA_SOURCE_OUT_OF_SCOPE_MESSAGE);
    }

    async function executeReadPage(state: ScopedCallState, args: Record<string, unknown>) {
      const input = ReadPageArgsSchema.parse(args);
      const pageId = requirePageUuid(input.page);
      const page = await ensurePageInScope(state, pageId);
      const markdown = NotionMarkdownSchema.parse(
        await executor.request({
          organizationId: state.organizationId,
          connectionSlug: state.grant.connection,
          method: "GET",
          path: `/pages/${pageId}/markdown?markdown_version=v2`,
        }),
      );
      let comments: Record<string, unknown>[] | undefined;
      if (input.include_comments === true) {
        const listed = NotionCommentsListSchema.parse(
          await executor.request({
            organizationId: state.organizationId,
            connectionSlug: state.grant.connection,
            method: "GET",
            path: `/comments?block_id=${encodeURIComponent(pageId)}`,
          }),
        );
        comments = listed.results;
      }
      return {
        id: page.id,
        url: page.url ?? null,
        title: extractPageTitle(page.properties),
        properties: page.properties ?? {},
        markdown: markdown.markdown,
        truncated: markdown.truncated ?? false,
        unknown_block_ids: markdown.unknown_block_ids ?? [],
        ...(comments === undefined ? {} : { comments }),
      };
    }

    async function executeQueryDatabase(state: ScopedCallState, args: Record<string, unknown>) {
      const input = QueryDatabaseArgsSchema.parse(args);
      const requestedId = requirePageUuid(input.data_source);
      const dataSourceId = await resolveGrantedDataSource(state, requestedId);
      const schemaInfo = NotionDataSourceSchema.parse(
        await executor.request({
          organizationId: state.organizationId,
          connectionSlug: state.grant.connection,
          method: "GET",
          path: `/data_sources/${dataSourceId}`,
        }),
      );
      const queried = NotionQueryResponseSchema.parse(
        await executor.request({
          organizationId: state.organizationId,
          connectionSlug: state.grant.connection,
          method: "POST",
          path: `/data_sources/${dataSourceId}/query`,
          body: {
            ...(input.filter === undefined ? {} : { filter: input.filter }),
            ...(input.sorts === undefined ? {} : { sorts: input.sorts }),
            ...(input.start_cursor === undefined ? {} : { start_cursor: input.start_cursor }),
            page_size: input.page_size ?? 25,
          },
        }),
      );
      return {
        data_source: {
          id: schemaInfo.id,
          title: extractRichTextPlain(schemaInfo.title),
          properties: schemaInfo.properties ?? {},
        },
        results: queried.results.map((row) => {
          const rawProps = row["properties"];
          const properties =
            typeof rawProps === "object" && rawProps !== null && !Array.isArray(rawProps)
              ? Object.fromEntries(Object.entries(rawProps))
              : {};
          return {
            id: typeof row["id"] === "string" ? row["id"] : null,
            url: typeof row["url"] === "string" ? row["url"] : null,
            title: extractPageTitle(properties),
            properties,
          };
        }),
        next_cursor: queried.next_cursor ?? null,
        has_more: queried.has_more ?? false,
      };
    }

    async function verifyDiscussionBelongsToPage(
      state: ScopedCallState,
      pageId: string,
      discussionId: string,
    ): Promise<void> {
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_COMMENT_VERIFY_PAGES; pageIndex += 1) {
        const query = new URLSearchParams({ block_id: pageId });
        if (cursor !== undefined) query.set("start_cursor", cursor);
        const listed = NotionCommentsListSchema.parse(
          await executor.request({
            organizationId: state.organizationId,
            connectionSlug: state.grant.connection,
            method: "GET",
            path: `/comments?${query.toString()}`,
          }),
        );
        for (const rawEntry of listed.results) {
          const parsedEntry = NotionCommentEntrySchema.safeParse(rawEntry);
          if (!parsedEntry.success || parsedEntry.data.discussion_id !== discussionId) {
            continue;
          }
          const parent = parsedEntry.data.parent;
          if (parent === undefined) return;
          if (parent.type === "page_id") {
            const parentPageId = normalizeNotionUuid(parent.page_id) ?? parent.page_id;
            if (parentPageId === pageId) return;
          }
        }
        if (listed.has_more !== true || !listed.next_cursor) {
          break;
        }
        cursor = listed.next_cursor;
      }
      throw new IntegrationToolError(
        "The specified Notion discussion does not belong to the granted page.",
      );
    }

    async function executeComment(state: ScopedCallState, args: Record<string, unknown>) {
      const input = CommentArgsSchema.parse(args);
      const pageId = requirePageUuid(input.page);
      await ensurePageInScope(state, pageId);
      if (input.discussion_id !== undefined) {
        await verifyDiscussionBelongsToPage(state, pageId, input.discussion_id);
      }
      const created = NotionCreatedCommentSchema.parse(
        await executor.request({
          organizationId: state.organizationId,
          connectionSlug: state.grant.connection,
          method: "POST",
          path: "/comments",
          body:
            input.discussion_id === undefined
              ? { parent: { page_id: pageId }, markdown: input.markdown, markdown_version: "v2" }
              : {
                  discussion_id: input.discussion_id,
                  markdown: input.markdown,
                  markdown_version: "v2",
                },
        }),
      );
      return {
        id: created.id,
        discussion_id: created.discussion_id ?? input.discussion_id ?? null,
        created_time: created.created_time ?? null,
      };
    }

    async function patchPageMarkdown(
      state: ScopedCallState,
      pageId: string,
      input: z.infer<typeof UpdatePageArgsSchema>,
    ): Promise<{ updated: boolean; warnings?: unknown[] }> {
      let body: Record<string, unknown> | undefined;
      if (input.content_updates !== undefined) {
        body = {
          type: "update_content",
          update_content: { content_updates: input.content_updates },
        };
      } else if (input.insert_content !== undefined) {
        body = {
          type: "insert_content",
          insert_content: {
            content: input.insert_content.content,
            ...(input.insert_content.after === undefined
              ? {}
              : { after: input.insert_content.after }),
          },
        };
      }
      if (body === undefined) return { updated: false };
      const patched = NotionUpdateMarkdownResponseSchema.parse(
        await executor.request({
          organizationId: state.organizationId,
          connectionSlug: state.grant.connection,
          method: "PATCH",
          path: `/pages/${pageId}/markdown`,
          body,
        }),
      );
      return {
        updated: true,
        ...(patched.warnings !== undefined && patched.warnings.length > 0
          ? { warnings: patched.warnings }
          : {}),
      };
    }

    async function executeUpdatePage(state: ScopedCallState, args: Record<string, unknown>) {
      const input = UpdatePageArgsSchema.parse(args);
      const pageId = requirePageUuid(input.page);
      const page = await ensurePageInScope(state, pageId);
      let updatedUrl = page.url ?? null;
      let updatedProperties = false;

      if (input.properties !== undefined) {
        const patched = NotionPatchedPageSchema.parse(
          await executor.request({
            organizationId: state.organizationId,
            connectionSlug: state.grant.connection,
            method: "PATCH",
            path: `/pages/${pageId}`,
            body: { properties: input.properties },
          }),
        );
        updatedUrl = patched.url ?? updatedUrl;
        updatedProperties = true;
      }

      const mdResult = await patchPageMarkdown(state, pageId, input);
      return {
        id: pageId,
        url: updatedUrl,
        updated_properties: updatedProperties,
        markdown_updated: mdResult.updated,
        ...(mdResult.warnings === undefined ? {} : { warnings: mdResult.warnings }),
      };
    }

    return async ({ name, organizationId, grant: rawGrant, args }) => {
      const grant = normalizeNotionToolGrant(rawGrant);
      const spec = NOTION_TOOL_SPECS.find((item) => item.definition.name === name);
      if (spec === undefined) {
        throw new IntegrationToolError("Unknown Notion tool.");
      }
      if (!grant.actions.includes(spec.action)) {
        throw new IntegrationToolError(
          `The "${spec.action}" action is not granted for this Notion execution.`,
        );
      }

      const state: ScopedCallState = {
        organizationId,
        grant,
        pageCache: new Map(),
        blockCache: new Map(),
        resolvedDbCache: new Map(),
      };

      try {
        switch (name) {
          case "notion_list_targets":
            ListTargetsArgsSchema.parse(args);
            return {
              data_sources: (grant.data_sources ?? []).map((id) => ({ id })),
              pages: (grant.pages ?? []).map((id) => ({ id })),
            };
          case "notion_read_page":
            return await executeReadPage(state, args);
          case "notion_query_database":
            return await executeQueryDatabase(state, args);
          case "notion_comment":
            return await executeComment(state, args);
          case "notion_update_page":
            return await executeUpdatePage(state, args);
          default:
            throw new IntegrationToolError("Unknown Notion tool.");
        }
      } catch (error) {
        return mapNotionToolError(error);
      }
    };
  },
};
