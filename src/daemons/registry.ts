import { DaemonAgents } from "./agents/index.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { Logger } from "pino";
import type { Database, DaemonRecord } from "../db/types.js";
import { reportFailure, type FailureKind } from "../failures/index.js";
import { logger as defaultLogger } from "../logger.js";
import {
  HubExecutionAgentValidateRequestSchema,
  HubExecutionAgentValidateResponseSchema,
  GetProvidersSnapshotRequestSchema,
  GetProvidersSnapshotResponseSchema,
  RefreshProvidersSnapshotRequestSchema,
  RefreshProvidersSnapshotResponseSchema,
  ProjectListRequestSchema,
  ProjectListResponseSchema,
  HubExecutionOutboundSchema,
  HubDaemonHelloSchema,
  HubDaemonServerInfoEnvelopeSchema,
} from "../hub/protocol.js";
import type { DaemonConnection, DaemonProject } from "./protocol.js";
import type { HubProviderSnapshot } from "../hub/protocol.js";

interface PendingAgentValidationRequest {
  kind: "agent-validation";
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(value: { valid: true } | { valid: false; issues: readonly AgentValidationIssue[] }): void;
  reject(error: Error): void;
}
interface PendingProviderSnapshotRequest {
  kind: "provider-snapshot";
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(value: HubProviderSnapshot): void;
  reject(error: Error): void;
}
interface PendingProviderRefreshRequest {
  kind: "provider-refresh";
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
}
interface PendingProjectListRequest {
  kind: "project-list";
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(value: readonly DaemonProject[]): void;
  reject(error: Error): void;
}
interface AgentValidationIssue {
  path: readonly (string | number)[];
  message: string;
}
type PendingRequest =
  | PendingAgentValidationRequest
  | PendingProviderSnapshotRequest
  | PendingProviderRefreshRequest
  | PendingProjectListRequest;

type PendingRequestInput =
  | Omit<PendingAgentValidationRequest, "timer">
  | Omit<PendingProviderSnapshotRequest, "timer">
  | Omit<PendingProviderRefreshRequest, "timer">
  | Omit<PendingProjectListRequest, "timer">;

/**
 * How long Hub waits for optional project suggestions before expiring the request.
 * Provider discovery and refresh operations can legitimately run up to 120s on the daemon, so
 * this short deadline applies only to project listing.
 */
const DEFAULT_PROJECT_LIST_TIMEOUT_MS = 15_000;

/**
 * How a daemon says it will not list its projects for Hub: one that predates sharing them
 * refuses the session, and one that predates the request does not know its name. Neither is a
 * failure to report; the daemon offers no projects.
 */
const PROJECT_LIST_WITHHELD = new Set(["access_denied", "unknown_schema"]);
interface ActiveSocket {
  agents: DaemonAgents;
  generation: number;
  socket: WebSocket;
  daemon: DaemonRecord;
  ready: boolean;
  presenceReady: Promise<void>;
  providerSnapshotSupported: boolean;
  sessionProtocol: DaemonSessionProtocol;
}

export type DaemonSessionProtocol = "legacy" | "session-v1";

const DAEMON_SESSION_PROTOCOL_HEADER = "x-paseo-session-protocol";
const DAEMON_SESSION_PROTOCOL_VERSION = "1";

type DaemonConnectedHandler = (daemon: DaemonRecord) => void | Promise<void>;
type DaemonRevokedHandler = (daemon: DaemonRecord) => void | Promise<void>;

export class ActiveDaemonRegistry {
  private readonly active = new Map<string, ActiveSocket>();
  private readonly pendingByDaemon = new Map<string, Map<string, PendingRequest>>();
  private readonly connectedHandlers = new Set<DaemonConnectedHandler>();
  private readonly revokedHandlers = new Set<DaemonRevokedHandler>();
  private readonly presenceWrites = new Set<Promise<void>>();
  private generation = 0;

  constructor(
    private readonly database: Pick<Database, "setDaemonPresence" | "touchDaemon">,
    private readonly clock: DaemonClock = systemDaemonClock,
    private readonly failureLogger: Pick<Logger, "warn" | "error"> = defaultLogger,
    private readonly projectListTimeoutMs: number = DEFAULT_PROJECT_LIST_TIMEOUT_MS,
  ) {}

  accept(
    daemon: DaemonRecord,
    socket: WebSocket,
    sessionProtocol: DaemonSessionProtocol = "session-v1",
  ): void {
    const previous = this.active.get(daemon.id);
    if (previous) this.rejectGeneration(daemon.id, previous.generation);
    const active: ActiveSocket = {
      agents: new DaemonAgents(
        (frame) => socket.send(frame),
        () => this.clock.nowDate(),
        (error, operation) => this.report(error, operation, daemon.id),
      ),
      generation: ++this.generation,
      socket,
      daemon,
      ready: false,
      presenceReady: Promise.resolve(),
      providerSnapshotSupported: false,
      sessionProtocol,
    };
    this.active.set(daemon.id, active);
    previous?.agents.close();
    previous?.socket.close(4001, "replaced");
    socket.on("message", (data) => this.receive(active, readText(data)));
    socket.on("error", (error) => {
      // A peer that sends a malformed control frame (e.g. an invalid close
      // status code) makes the `ws` receiver emit `error` on this socket.
      // Node's EventEmitter rethrows unlistened `error` events as an
      // uncaught exception, which without this listener kills the whole
      // Hub process over one bad daemon connection. Report and let the
      // subsequent `close` event drive the normal offline-presence cleanup.
      this.report(error, "daemon.socket.error", daemon.id, "network");
    });
    socket.on("close", () => {
      active.agents.close();
      if (this.active.get(daemon.id)?.generation === active.generation) {
        this.active.delete(daemon.id);
        this.rejectGeneration(daemon.id, active.generation);
        const write = active.presenceReady.then(() =>
          this.database.setDaemonPresence(daemon.id, "offline"),
        );
        this.presenceWrites.add(write);
        void write.then(
          () => this.presenceWrites.delete(write),
          (error: unknown) => {
            this.report(error, "daemon.presence.offline", daemon.id);
          },
        );
      }
    });
    if (sessionProtocol === "legacy") {
      this.markReady(active);
    } else {
      socket.send(
        JSON.stringify(
          HubDaemonHelloSchema.parse({
            type: "hello",
            clientId: `hub:${daemon.id}`,
            clientType: "hub",
            // Hidden runs need idle updates before Hub can archive them and resume the conversation.
            capabilities: {
              all_providers: true,
              selective_agent_timeline: true,
              background_agents: true,
            },
            protocolVersion: 1,
          }),
        ),
      );
    }
  }

  onConnected(handler: DaemonConnectedHandler): () => void {
    this.connectedHandlers.add(handler);
    return () => this.connectedHandlers.delete(handler);
  }

  onRevoked(handler: DaemonRevokedHandler): () => void {
    this.revokedHandlers.add(handler);
    return () => this.revokedHandlers.delete(handler);
  }

  connection(daemonId: string): DaemonConnection | undefined {
    const active = this.active.get(daemonId);
    if (!active?.ready || !active.daemon.permissions.includes("hub.execute")) return undefined;
    return {
      agents: this.active.get(daemonId)!.agents,
      getProviderSnapshot: (options) => this.getProviderSnapshot(daemonId, options),
      refreshProviderSnapshot: (options) => this.refreshProviderSnapshot(daemonId, options),
      listProjects: () => this.listProjects(daemonId),
      validateAgentConfiguration: (agent, options) =>
        this.validateAgentConfiguration(daemonId, agent, options),
    };
  }

  private validateAgentConfiguration(
    daemonId: string,
    agent: import("../config/compiler.js").CompiledAgent,
    options: { cwd: string },
  ): Promise<{ valid: true } | { valid: false; issues: readonly AgentValidationIssue[] }> {
    const active = this.active.get(daemonId);
    if (!active?.ready) return Promise.reject(new Error("daemon_not_connected"));
    if (!active.daemon.permissions.includes("hub.execute")) {
      return Promise.reject(new Error("daemon_execution_not_allowed"));
    }
    const requestId = randomUUID();
    const request = HubExecutionAgentValidateRequestSchema.parse({
      type: "hub.execution.agent.validate.request",
      requestId,
      cwd: options.cwd,
      provider: agent.provider,
      model: agent.model,
      modeId: agent.mode,
      thinkingOptionId: agent.thinkingOptionId,
      providerOptions: agent.options,
    });
    return new Promise((resolve, reject) => {
      this.registerPending(daemonId, requestId, {
        kind: "agent-validation",
        generation: active.generation,
        resolve,
        reject,
      });
      active.socket.send(JSON.stringify({ type: "session", message: request }));
    });
  }

  updatePermissions(daemon: DaemonRecord): void {
    const active = this.active.get(daemon.id);
    if (active) active.daemon = daemon;
  }

  async revoke(daemon: DaemonRecord): Promise<void> {
    try {
      await Promise.all(Array.from(this.revokedHandlers, async (handler) => handler(daemon)));
    } finally {
      this.active.get(daemon.id)?.socket.close(4403, "revoked");
    }
  }

  async stop(): Promise<void> {
    const activeDaemons = Array.from(this.active.values());
    const sockets = activeDaemons.map(
      (active) =>
        new Promise<void>((resolve) => {
          if (active.socket.readyState === WebSocket.CLOSED) return resolve();
          active.socket.once("close", () => resolve());
          active.socket.close(1001, "server shutdown");
        }),
    );
    await Promise.all(sockets);
    await Promise.all(this.presenceWrites);
    for (const [daemonId, pending] of this.pendingByDaemon) {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("daemon disconnected"));
      }
      this.pendingByDaemon.delete(daemonId);
    }
  }

  private getProviderSnapshot(
    daemonId: string,
    options: { cwd?: string },
  ): Promise<HubProviderSnapshot> {
    const active = this.requireProviderSnapshotConnection(daemonId);
    const requestId = randomUUID();
    const request = GetProvidersSnapshotRequestSchema.parse({
      type: "get_providers_snapshot_request",
      requestId,
      cwd: options.cwd,
    });
    return new Promise((resolve, reject) => {
      this.registerPending(daemonId, requestId, {
        kind: "provider-snapshot",
        generation: active.generation,
        resolve,
        reject,
      });
      active.socket.send(JSON.stringify({ type: "session", message: request }));
    });
  }

  private refreshProviderSnapshot(
    daemonId: string,
    options: { cwd?: string; providers?: string[] },
  ): Promise<void> {
    const active = this.requireProviderSnapshotConnection(daemonId);
    const requestId = randomUUID();
    const request = RefreshProvidersSnapshotRequestSchema.parse({
      type: "refresh_providers_snapshot_request",
      requestId,
      cwd: options.cwd,
      providers: options.providers,
    });
    return new Promise((resolve, reject) => {
      this.registerPending(daemonId, requestId, {
        kind: "provider-refresh",
        generation: active.generation,
        resolve,
        reject,
      });
      active.socket.send(JSON.stringify({ type: "session", message: request }));
    });
  }

  private listProjects(daemonId: string): Promise<readonly DaemonProject[]> {
    const active = this.active.get(daemonId);
    if (!active?.ready) return Promise.reject(new Error("daemon_not_connected"));
    // A legacy session never said which requests it serves, and may not answer one it does not.
    if (active.sessionProtocol === "legacy") return Promise.resolve([]);
    const requestId = randomUUID();
    const request = ProjectListRequestSchema.parse({ type: "project.list.request", requestId });
    return new Promise((resolve, reject) => {
      this.registerPending(
        daemonId,
        requestId,
        {
          kind: "project-list",
          generation: active.generation,
          resolve,
          reject,
        },
        this.projectListTimeoutMs,
      );
      active.socket.send(JSON.stringify({ type: "session", message: request }));
    });
  }

  private requireProviderSnapshotConnection(daemonId: string): ActiveSocket {
    const active = this.active.get(daemonId);
    if (!active?.ready) throw new Error("daemon_not_connected");
    if (!active.providerSnapshotSupported) throw new Error("daemon_provider_snapshot_unsupported");
    return active;
  }

  private receive(active: ActiveSocket, raw: string): void {
    if (this.active.get(active.daemon.id)?.generation !== active.generation) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      this.report(error, "daemon.websocket.message.parse", active.daemon.id, "validation");
      active.socket.close(4400, "invalid daemon message");
      return;
    }
    if (active.agents.receive(value)) return;
    const serverInfo = HubDaemonServerInfoEnvelopeSchema.safeParse(value);
    if (serverInfo.success) {
      this.acceptServerInfo(
        active,
        serverInfo.data.message.payload.permissions,
        serverInfo.data.message.payload.features?.providersSnapshot === true,
      );
      return;
    }
    const envelope = HubExecutionOutboundSchema.safeParse(value);
    if (!envelope.success) return;
    const message = envelope.data.message;
    if (message.type === "rpc_error") return this.receiveRpcError(active, message.payload);
    const validated = HubExecutionAgentValidateResponseSchema.safeParse(message);
    if (validated.success) return this.receiveAgentValidation(active, validated.data);
    const providerSnapshot = GetProvidersSnapshotResponseSchema.safeParse(message);
    if (providerSnapshot.success)
      return this.receiveProviderSnapshot(active, providerSnapshot.data);
    const providerRefresh = RefreshProvidersSnapshotResponseSchema.safeParse(message);
    if (providerRefresh.success) return this.receiveProviderRefresh(active, providerRefresh.data);
    const projectList = ProjectListResponseSchema.safeParse(message);
    if (projectList.success) return this.receiveProjectList(active, projectList.data);
  }

  private acceptServerInfo(
    active: ActiveSocket,
    permissions: readonly string[],
    providerSnapshotSupported = false,
  ): void {
    if (!samePermissions(permissions, active.daemon.permissions)) {
      active.socket.close(4403, "daemon session permissions do not match enrollment");
      return;
    }
    active.providerSnapshotSupported = providerSnapshotSupported;
    this.markReady(active);
  }

  private markReady(active: ActiveSocket): void {
    if (active.ready) return;
    active.ready = true;
    const write = Promise.all([
      this.database.touchDaemon(active.daemon.id),
      this.database.setDaemonPresence(active.daemon.id, "connected"),
    ]).then(
      () => undefined,
      (error: unknown) => this.report(error, "daemon.presence.connected", active.daemon.id),
    );
    active.presenceReady = write;
    this.presenceWrites.add(write);
    void write.then(() => {
      this.presenceWrites.delete(write);
      for (const handler of this.connectedHandlers) {
        this.observeHandler(
          () => handler(active.daemon),
          "daemon.connected.handler",
          active.daemon.id,
        );
      }
      return undefined;
    });
  }

  private observeHandler(
    handler: () => void | Promise<void>,
    operation: string,
    daemonId: string,
    kind?: FailureKind,
    executionId?: string,
  ): void {
    void Promise.resolve()
      .then(handler)
      .catch((error: unknown) => this.report(error, operation, daemonId, kind, executionId));
  }

  private report(
    error: unknown,
    operation: string,
    daemonId: string,
    kind?: FailureKind,
    executionId?: string,
  ): void {
    reportFailure(
      error,
      {
        operation,
        component: "daemons",
        daemonId,
        ...(executionId === undefined ? {} : { executionId }),
      },
      { logger: this.failureLogger, ...(kind === undefined ? {} : { kind }) },
    );
  }

  private receiveAgentValidation(
    active: ActiveSocket,
    response: z.infer<typeof HubExecutionAgentValidateResponseSchema>,
  ): void {
    const pending = this.takePending(active, response.payload.requestId, "agent-validation");
    if (!pending) return;
    if (response.payload.error !== null) {
      pending.reject(new Error(response.payload.error));
      return;
    }
    pending.resolve(
      response.payload.valid ? { valid: true } : { valid: false, issues: response.payload.issues },
    );
  }

  private receiveProviderSnapshot(
    active: ActiveSocket,
    response: z.infer<typeof GetProvidersSnapshotResponseSchema>,
  ): void {
    const pending = this.takePending(active, response.payload.requestId, "provider-snapshot");
    if (!pending) return;
    pending.resolve(response.payload);
  }

  private receiveProviderRefresh(
    active: ActiveSocket,
    response: z.infer<typeof RefreshProvidersSnapshotResponseSchema>,
  ): void {
    const pending = this.takePending(active, response.payload.requestId, "provider-refresh");
    if (!pending) return;
    if (!response.payload.acknowledged) {
      pending.reject(new Error("daemon provider refresh was not acknowledged"));
      return;
    }
    pending.resolve();
  }

  private receiveProjectList(
    active: ActiveSocket,
    response: z.infer<typeof ProjectListResponseSchema>,
  ): void {
    const pending = this.takePending(active, response.payload.requestId, "project-list");
    if (!pending) return;
    pending.resolve(
      response.payload.projects.map((project) => ({
        id: project.projectId,
        name: project.projectCustomName ?? project.projectDisplayName,
        rootPath: project.projectRootPath,
      })),
    );
  }

  private receiveRpcError(
    active: ActiveSocket,
    payload: { requestId: string; error: string; code?: string | undefined },
  ): void {
    const requests = this.pendingFor(active.daemon.id);
    const pending = requests.get(payload.requestId);
    if (pending?.generation !== active.generation) return;
    clearTimeout(pending.timer);
    requests.delete(payload.requestId);
    if (
      pending.kind === "project-list" &&
      payload.code !== undefined &&
      PROJECT_LIST_WITHHELD.has(payload.code)
    ) {
      pending.resolve([]);
      return;
    }
    pending.reject(new Error(payload.error));
  }

  private registerPending(
    daemonId: string,
    requestId: string,
    request: PendingRequestInput,
    timeoutMs?: number,
  ): void {
    const requests = this.pendingFor(daemonId);
    if (timeoutMs === undefined) {
      requests.set(requestId, request);
      return;
    }
    const timer = setTimeout(() => {
      const current = requests.get(requestId);
      if (current?.generation !== request.generation) return;
      requests.delete(requestId);
      current.reject(new Error("daemon_request_timeout"));
    }, timeoutMs);
    timer.unref?.();
    requests.set(requestId, { ...request, timer });
  }

  private takePending<K extends PendingRequest["kind"]>(
    active: ActiveSocket,
    requestId: string,
    kind: K,
  ): Extract<PendingRequest, { kind: K }> | undefined {
    const requests = this.pendingFor(active.daemon.id);
    const pending = requests.get(requestId);
    if (!pending || pending.kind !== kind || pending.generation !== active.generation) {
      return undefined;
    }
    clearTimeout(pending.timer);
    requests.delete(requestId);
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- narrowed by pending.kind === kind
    return pending as Extract<PendingRequest, { kind: K }>;
  }

  private pendingFor(daemonId: string): Map<string, PendingRequest> {
    const existing = this.pendingByDaemon.get(daemonId);
    if (existing) return existing;
    const pending = new Map<string, PendingRequest>();
    this.pendingByDaemon.set(daemonId, pending);
    return pending;
  }

  private rejectGeneration(daemonId: string, generation: number): void {
    const pending = this.pendingFor(daemonId);
    for (const [requestId, request] of pending) {
      if (request.generation !== generation) continue;
      clearTimeout(request.timer);
      pending.delete(requestId);
      request.reject(new Error("daemon disconnected"));
    }
  }
}

function samePermissions(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && expected.every((permission) => actual.includes(permission))
  );
}

export function createDaemonUpgradeHandler(
  database: Pick<Database, "findDaemonById">,
  registry: ActiveDaemonRegistry,
) {
  const server = new WebSocketServer({ noServer: true });
  server.on("headers", (headers, request) => {
    if (request.headers[DAEMON_SESSION_PROTOCOL_HEADER] === DAEMON_SESSION_PROTOCOL_VERSION) {
      headers.push(`${DAEMON_SESSION_PROTOCOL_HEADER}: ${DAEMON_SESSION_PROTOCOL_VERSION}`);
    }
  });
  return async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/daemons/socket") {
      socket.destroy();
      return;
    }
    const daemonId = request.headers["x-paseo-daemon-id"];
    const credential = bearer(request.headers.authorization);
    if (typeof daemonId !== "string" || !credential) return rejectUpgrade(socket, 401);
    const daemon = await database.findDaemonById(daemonId);
    if (
      !daemon ||
      daemon.status !== "active" ||
      !matchesVerifier(credential, daemon.credentialVerifier)
    )
      return rejectUpgrade(socket, 403);
    const sessionProtocol =
      request.headers[DAEMON_SESSION_PROTOCOL_HEADER] === DAEMON_SESSION_PROTOCOL_VERSION
        ? "session-v1"
        : "legacy";
    server.handleUpgrade(request, socket, head, (webSocket) =>
      registry.accept(daemon, webSocket, sessionProtocol),
    );
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
function matchesVerifier(value: string, verifier: string): boolean {
  const actual = Buffer.from(hash(value));
  const expected = Buffer.from(verifier);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function bearer(value: string | undefined): string | undefined {
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function readText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}

export interface DaemonClock {
  nowDate(): Date;
}

const systemDaemonClock: DaemonClock = {
  nowDate: () => new Date(),
};
