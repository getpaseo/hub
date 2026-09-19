import { z } from "zod";

const AgentStatusSchema = z.enum(["error", "initializing", "idle", "running", "closed"]);

type WireJsonValue =
  | string
  | number
  | boolean
  | null
  | WireJsonValue[]
  | { [key: string]: WireJsonValue };

const JsonValueSchema: z.ZodType<WireJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const ProviderSelectOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

const ProviderModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  isSelectable: z.boolean().optional(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
  contextWindowMaxTokens: z.number().optional(),
  thinkingOptions: z.array(ProviderSelectOptionSchema).optional(),
  defaultThinkingOptionId: z.string().optional(),
});

const ProviderModeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  colorTier: z.string().optional(),
});

const ProviderSnapshotEntrySchema = z.object({
  provider: z.string(),
  status: z.enum(["ready", "loading", "error", "unavailable"]),
  enabled: z.boolean().optional().default(true),
  source: z.enum(["builtin", "custom"]).optional(),
  error: z.string().optional(),
  models: z.array(ProviderModelSchema).optional(),
  modes: z.array(ProviderModeSchema).optional(),
  fetchedAt: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  defaultModeId: z.string().nullable().optional(),
});

export const HubExecutionAgentSnapshotSchema = z
  .object({
    id: z.string(),
    status: AgentStatusSchema,
  })
  .passthrough();

const HubTimelineItemSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    messageId: z.string().optional(),
    callId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export function isHubFinishExecutionToolName(name: string): boolean {
  return name === "hub.finish_execution" || name === "mcp__hub__finish_execution";
}

export const HubDaemonHelloSchema = z.object({
  type: z.literal("hello"),
  clientId: z.string(),
  clientType: z.literal("hub"),
  capabilities: z.record(z.string(), z.boolean()).optional(),
  protocolVersion: z.literal(1),
});

export const HubDaemonServerInfoEnvelopeSchema = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.literal("status"),
    payload: z
      .object({
        status: z.literal("server_info"),
        permissions: z.array(z.string()),
        features: z.object({ providersSnapshot: z.boolean().optional() }).optional(),
      })
      .passthrough(),
  }),
});

export const HubExecutionAgentStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("thread_started"),
      sessionId: z.string(),
      provider: z.string(),
    })
    .passthrough(),
  z.object({ type: z.literal("turn_started"), provider: z.string() }).passthrough(),
  z.object({ type: z.literal("turn_completed"), provider: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("turn_failed"),
      provider: z.string(),
      error: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("turn_canceled"),
      provider: z.string(),
      reason: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("timeline"),
      provider: z.string(),
      item: HubTimelineItemSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("permission_requested"),
      provider: z.string(),
      request: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("permission_resolved"),
      provider: z.string(),
      requestId: z.string(),
      resolution: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("attention_required"),
      provider: z.string(),
      reason: z.enum(["finished", "error", "permission"]),
      timestamp: z.string(),
      shouldNotify: z.boolean(),
    })
    .passthrough(),
]);

export const HubExecutionAgentValidateRequestSchema = z.object({
  type: z.literal("hub.execution.agent.validate.request"),
  requestId: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
  providerOptions: z.record(z.string(), JsonValueSchema).optional(),
});

export const HubExecutionAgentValidateResponseSchema = z.object({
  type: z.literal("hub.execution.agent.validate.response"),
  payload: z.object({
    requestId: z.string(),
    valid: z.boolean(),
    issues: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        message: z.string(),
      }),
    ),
    error: z.string().nullable(),
  }),
});

export const GetProvidersSnapshotRequestSchema = z.object({
  type: z.literal("get_providers_snapshot_request"),
  requestId: z.string(),
  cwd: z.string().optional(),
});

export const GetProvidersSnapshotResponseSchema = z.object({
  type: z.literal("get_providers_snapshot_response"),
  payload: z.object({
    requestId: z.string(),
    cwd: z.string().optional(),
    entries: z.array(ProviderSnapshotEntrySchema),
    generatedAt: z.string(),
  }),
});

export const RefreshProvidersSnapshotRequestSchema = z.object({
  type: z.literal("refresh_providers_snapshot_request"),
  requestId: z.string(),
  cwd: z.string().optional(),
  providers: z.array(z.string()).optional(),
});

export const RefreshProvidersSnapshotResponseSchema = z.object({
  type: z.literal("refresh_providers_snapshot_response"),
  payload: z.object({
    requestId: z.string(),
    acknowledged: z.boolean(),
  }),
});

export const HubExecutionControlActionSchema = z.enum(["interrupt", "archive"]);

const RpcErrorSchema = z.object({
  type: z.literal("rpc_error"),
  payload: z.object({
    requestId: z.string(),
    requestType: z.string().optional(),
    error: z.string(),
    code: z.string().optional(),
  }),
});

export const HubExecutionOutboundSchema = z.object({
  type: z.literal("session"),
  message: z.discriminatedUnion("type", [
    HubExecutionAgentValidateResponseSchema,
    GetProvidersSnapshotResponseSchema,
    RefreshProvidersSnapshotResponseSchema,
    RpcErrorSchema,
  ]),
});

export type HubExecutionAgentSnapshot = z.infer<typeof HubExecutionAgentSnapshotSchema>;
export type HubExecutionAgentStreamEvent = z.infer<typeof HubExecutionAgentStreamEventSchema>;
export type HubExecutionControlAction = z.infer<typeof HubExecutionControlActionSchema>;
export type HubProviderSnapshot = z.infer<typeof GetProvidersSnapshotResponseSchema>["payload"];
export type HubProviderSnapshotEntry = z.infer<typeof ProviderSnapshotEntrySchema>;
