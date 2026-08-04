import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { DaemonRecord } from "../../db/types.js";
import type { HubExecutionAgentSnapshot } from "../../hub/protocol.js";
import type { DaemonAgentSnapshot, DaemonConnection, DaemonEvent } from "../protocol.js";
import { ActiveDaemonRegistry } from "../registry.js";

const SessionRequestSchema = z.object({
  type: z.literal("session"),
  message: z.object({
    type: z.string(),
    requestId: z.string(),
    executionId: z.string(),
    action: z.enum(["interrupt", "archive"]).optional(),
  }),
});

interface PendingRequest<T> {
  promise: Promise<T>;
  request: z.infer<typeof SessionRequestSchema>["message"];
}

export class DaemonRegistryHarness {
  private readonly presence = new DaemonPresence();
  private readonly registry = new ActiveDaemonRegistry(this.presence);
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private readonly clients: WebSocket[] = [];
  private socket: RegistrySocket | undefined;
  private readonly daemon = daemonRecord();
  private shutdown: Promise<void> | undefined;
  private didShutdown = false;

  static async start(): Promise<DaemonRegistryHarness> {
    const harness = new DaemonRegistryHarness();
    await harness.serverListening();
    await harness.replaceConnection();
    return harness;
  }

  async pendingCreate(executionId: string): Promise<PendingRequest<DaemonAgentSnapshot>> {
    const connection = this.connection();
    const promise = connection.createAgent({
      executionId,
      provider: "opencode",
      mode: "full-access",
      cwd: "/workspace",
      prompt: "Do the work",
      env: {},
    });
    void promise.catch(() => undefined);
    return {
      promise,
      request: await this.currentSocket().next("hub.execution.agent.create.request"),
    };
  }

  async pendingControl(
    executionId: string,
    action: "interrupt" | "archive",
  ): Promise<PendingRequest<void>> {
    const promise = this.connection().controlExecution({ executionId, action });
    void promise.catch(() => undefined);
    return {
      promise,
      request: await this.currentSocket().next("hub.execution.control.request"),
    };
  }

  respondControl(
    pending: PendingRequest<void>,
    overrides: { executionId?: string; action?: "interrupt" | "archive" } = {},
  ): void {
    this.currentSocket().send({
      type: "hub.execution.control.response",
      payload: {
        requestId: pending.request.requestId,
        executionId: overrides.executionId ?? pending.request.executionId,
        action: overrides.action ?? pending.request.action,
        success: true,
        error: null,
      },
    });
  }

  async requestSettled(request: Promise<void>): Promise<boolean> {
    let settled = false;
    void request.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    return settled;
  }

  async replaceConnection(): Promise<{ supersededClosed: boolean }> {
    const superseded = this.socket;
    const address = this.server.address();
    if (typeof address === "string" || address === null) throw new Error("Registry has no address");
    const accepted = new Promise<WebSocket>((resolve) => this.server.once("connection", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const serverSocket = await accepted;
    this.registry.accept(this.daemon, serverSocket);
    this.clients.push(client);
    this.socket = new RegistrySocket(client);
    return { supersededClosed: superseded?.closed ?? false };
  }

  async completeCreate(executionId: string, agentId: string): Promise<DaemonAgentSnapshot> {
    const pending = await this.pendingCreate(executionId);
    this.currentSocket().send({
      type: "hub.execution.agent.create.response",
      payload: {
        requestId: pending.request.requestId,
        executionId,
        agentId,
        agent: null,
        success: true,
        error: null,
      },
    });
    return pending.promise;
  }

  async reportAgentStatus(
    executionId: string,
    status: HubExecutionAgentSnapshot["status"],
  ): Promise<DaemonEvent> {
    const event = new Promise<DaemonEvent>((resolve) => {
      const unsubscribe = this.connection().on((value) => {
        unsubscribe();
        resolve(value);
      });
    });
    const agentId = `agent-${executionId}`;
    this.currentSocket().send({
      type: "hub.execution.agent.update",
      payload: { executionId, agentId, agent: agentSnapshot(agentId, status) },
    });
    return event;
  }

  async stop(): Promise<void> {
    await this.registry.stop();
    for (const client of this.clients) client.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  holdOfflinePresence(): void {
    this.presence.hold();
  }

  beginStop(): void {
    this.shutdown = this.stop().then(() => {
      this.didShutdown = true;
      return undefined;
    });
  }

  offlinePresenceBegins(): Promise<void> {
    return this.presence.waitUntilWriting();
  }

  async shutdownCompleted(): Promise<boolean> {
    await new Promise((resolve) => setImmediate(resolve));
    return this.didShutdown;
  }

  persistOfflinePresence(): void {
    this.presence.persist();
  }

  async shutdownCompletes(): Promise<void> {
    if (!this.shutdown) throw new Error("Shutdown has not begun");
    await this.shutdown;
  }

  private connection(): DaemonConnection {
    const connection = this.registry.connection(this.daemon.id);
    if (!connection) throw new Error("Daemon is not connected");
    return connection;
  }

  private currentSocket(): RegistrySocket {
    if (!this.socket) throw new Error("Daemon socket is unavailable");
    return this.socket;
  }

  private serverListening(): Promise<void> {
    if (this.server.address() !== null) return Promise.resolve();
    return new Promise((resolve) => this.server.once("listening", resolve));
  }
}

class DaemonPresence {
  private writes = 0;
  private writing: Promise<void> | undefined;
  private resolveWriting: (() => void) | undefined;
  private persistence: Promise<void> | undefined;
  private resolvePersistence: (() => void) | undefined;

  hold(): void {
    this.writing = new Promise<void>((resolve) => {
      this.resolveWriting = resolve;
    });
    this.persistence = new Promise<void>((resolve) => {
      this.resolvePersistence = resolve;
    });
  }

  async setDaemonPresence(_id: string, _presence: "offline" | "connected"): Promise<void> {
    this.writes += 1;
    if (this.writes !== 1) return;
    this.resolveWriting?.();
    await this.persistence;
  }

  async waitUntilWriting(): Promise<void> {
    if (!this.writing) throw new Error("Offline presence is not held");
    await this.writing;
  }

  persist(): void {
    this.resolvePersistence?.();
  }
}

class RegistrySocket {
  private readonly messages: Array<z.infer<typeof SessionRequestSchema>["message"]> = [];
  private waiter: (() => void) | undefined;
  private didClose = false;

  constructor(private readonly socket: WebSocket) {
    socket.once("close", () => {
      this.didClose = true;
    });
    socket.on("message", (data) => {
      this.messages.push(SessionRequestSchema.parse(JSON.parse(readText(data))).message);
      this.waiter?.();
      this.waiter = undefined;
    });
  }

  get closed(): boolean {
    return this.didClose;
  }

  async next(type: string): Promise<z.infer<typeof SessionRequestSchema>["message"]> {
    while (!this.messages.some((message) => message.type === type)) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    const index = this.messages.findIndex((message) => message.type === type);
    return this.messages.splice(index, 1)[0]!;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify({ type: "session", message }));
  }
}

function daemonRecord(): DaemonRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    slug: "replacement-daemon",
    machineId: randomUUID(),
    serverId: randomUUID(),
    daemonPublicKey: "public-key",
    credentialVerifier: "verifier",
    scopes: ["hub.execution.*"],
    displayName: "Replacement daemon",
    approvedByUserId: null,
    registeredByApiKeyId: null,
    registrationMethod: "operator",
    status: "active",
    presence: "connected",
    connectedAt: now,
    disconnectedAt: null,
    lastSeenAt: now,
    createdAt: now,
  };
}

function agentSnapshot(
  id: string,
  status: HubExecutionAgentSnapshot["status"],
): HubExecutionAgentSnapshot {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id,
    provider: "opencode",
    cwd: "/workspace",
    model: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUserMessageAt: null,
    status,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
  };
}

function readText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}
