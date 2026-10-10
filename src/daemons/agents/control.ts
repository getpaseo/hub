import { z } from "zod";
import type { AgentConnection } from "./index.js";
import { HubExecutionAgentSnapshotSchema } from "../../hub/protocol.js";

// Deliberate projections: never expose provider persistence handles or runtime credentials.
export const AgentDetailsSchema = z.object({
  id: z.string(),
  workspaceId: z.string().optional(),
  status: HubExecutionAgentSnapshotSchema.shape.status,
  provider: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  currentModeId: z.string().nullable().optional(),
  activeTurn: z.unknown().optional(),
  pendingPermissions: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.string(),
        title: z.string().optional(),
      }),
    )
    .optional(),
  lastError: z.string().optional(),
  attentionReason: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  archivedAt: z.string().nullable().optional(),
});
const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  prevCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export const AgentDirectorySchema = z.object({
  entries: z.array(z.object({ agent: AgentDetailsSchema })),
  pageInfo: PageInfoSchema,
});
const ProjectSchema = z.object({
  projectId: z.string(),
  projectDisplayName: z.string(),
  projectRootPath: z.string(),
  projectKind: z.string().optional(),
});
export const WorkspaceDirectorySchema = z.object({
  entries: z.array(
    ProjectSchema.extend({
      id: z.string(),
      name: z.string(),
      workspaceDirectory: z.string().optional(),
      worktreeSlug: z.string().optional(),
      workspaceKind: z.string().optional(),
      status: z.string().optional(),
    }),
  ),
  emptyProjects: z.array(ProjectSchema).optional(),
  pageInfo: PageInfoSchema,
});
export const TimelineCursorSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});
export const AgentActivitySchema = z.object({
  agentId: z.string(),
  agent: AgentDetailsSchema.nullable(),
  direction: z.enum(["tail", "before", "after"]),
  epoch: z.string(),
  reset: z.boolean(),
  staleCursor: z.boolean(),
  gap: z.boolean(),
  startCursor: TimelineCursorSchema.nullable(),
  endCursor: TimelineCursorSchema.nullable(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
  entries: z.array(
    z.object({
      provider: z.string(),
      timestamp: z.string(),
      seqStart: z.number(),
      seqEnd: z.number(),
      item: z.record(z.string(), z.unknown()),
      turnId: z.string().optional(),
    }),
  ),
});
export interface DirectoryPage {
  limit: number;
  cursor?: string;
}
export interface ActivityQuery {
  direction: "tail" | "before" | "after";
  limit: number;
  cursor?: z.infer<typeof TimelineCursorSchema>;
}
export interface AgentControlConnection extends AgentConnection {
  details(agentId: string): Promise<z.infer<typeof AgentDetailsSchema>>;
  directory(
    page: DirectoryPage,
    includeArchived: boolean,
  ): Promise<z.infer<typeof AgentDirectorySchema>>;
  workspaces(page: DirectoryPage): Promise<z.infer<typeof WorkspaceDirectorySchema>>;
  activity(agentId: string, query: ActivityQuery): Promise<z.infer<typeof AgentActivitySchema>>;
  message(
    agentId: string,
    messageId: string,
    text: string,
    behavior: "steer" | "interrupt",
  ): Promise<void>;
  archiveAgent(agentId: string): Promise<void>;
  archiveWorkspace(workspaceId: string): Promise<void>;
}
