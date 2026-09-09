import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { AgentSnapshot } from "../agents/index.js";
import type { Logger } from "pino";
import type { DaemonRecord } from "../../db/types.js";
import type { DaemonConnection } from "../protocol.js";
import { ActiveDaemonRegistry } from "../registry.js";

const SessionRequestSchema = z.object({
  type: z.literal("session"),
  message: z
    .object({
      type: z.string(),
      requestId: z.string(),
      executionId: z.string().optional(),
      action: z.enum(["interrupt", "archive"]).optional(),
    })
    .passthrough(),
});

interface PendingRequest<T> {
  promise: Promise<T>;
  request: z.infer<typeof SessionRequestSchema>["message"];
}

/** Shape of the internal fields `ws` leaves untyped but always populates. */
interface WebSocketInternals {
  _socket: { write(data: Buffer): void };
}

export class DaemonRegistryHarness {
  private readonly presence = new DaemonPresence();
  private readonly registry: ActiveDaemonRegistry;
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private readonly clients: WebSocket[] = [];
  private socket: RegistrySocket | undefined;
  private readonly daemon = daemonRecord();
  private shutdown: Promise<void> | undefined;
  private didShutdown = false;
  private stopped = false;

  constructor(logger?: Pick<Logger, "warn" | "error">) {
    this.registry = new ActiveDaemonRegistry(this.presence, undefined, logger);
  }

  static async start(logger?: Pick<Logger, "warn" | "error">): Promise<DaemonRegistryHarness> {
    const harness = new DaemonRegistryHarness(logger);
    await harness.serverListening();
    await harness.replaceConnection();
    return harness;
  }

  async pendingCreate(executionId: string): Promise<PendingRequest<AgentSnapshot>> {
    const connection = this.connection();
    const promise = connection.agents.create(executionId, {
      provider: "opencode",
      mode: "full-access",
      cwd: "/workspace",
      env: {},
      providerOptions: { permission: { edit: "ask", bash: "deny" } },
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
      },
    });
    void promise.catch(() => undefined);
    return {
      promise,
      request: await this.currentSocket().next("create_agent_request"),
    };
  }

  async pendingControl(
    executionId: string,
    action: "interrupt" | "archive",
  ): Promise<PendingRequest<void>> {
    const promise = this.connection().agents.control(
      `agent-${executionId}`,
      `workspace-${executionId}`,
      action,
    );
    void promise.catch(() => undefined);
    return {
      promise,
      request: await this.currentSocket().next(
        action === "archive" ? "archive_workspace_request" : "cancel_agent_request",
      ),
    };
  }

  async pendingAgentValidation() {
    const promise = this.registry.validateAgentConfiguration(this.daemon.id, {
      provider: "definitely-not-installed",
      model: "imaginary-model",
      mode: "imaginary-mode",
      options: { nonsense: true },
    });
    void promise.catch(() => undefined);
    return {
      promise,
      request: await this.currentSocket().next("hub.execution.agent.validate.request"),
    };
  }

  async pendingProviderSnapshot(cwd = "/workspace") {
    const promise = this.connection().getProviderSnapshot({ cwd });
    void promise.catch(() => undefined);
    return {
      promise,
      request: await this.currentSocket().next("get_providers_snapshot_request"),
    };
  }

  async pendingProviderRefresh(cwd = "/workspace") {
    const promise = this.connection().refreshProviderSnapshot({ cwd, providers: ["codex"] });
    void promise.catch(() => undefined);
    return {
      promise,
      request: await this.currentSocket().next("refresh_providers_snapshot_request"),
    };
  }

  respondProviderSnapshot(
    pending: Awaited<ReturnType<DaemonRegistryHarness["pendingProviderSnapshot"]>>,
  ): void {
    this.currentSocket().send({
      type: "get_providers_snapshot_response",
      payload: {
        requestId: pending.request.requestId,
        cwd: pending.request["cwd"],
        entries: [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            models: [
              {
                provider: "codex",
                id: "gpt-5.4",
                label: "GPT-5.4",
                thinkingOptions: [{ id: "xhigh", label: "Extra high" }],
              },
            ],
            modes: [{ id: "full-access", label: "Full access" }],
          },
        ],
        generatedAt: new Date().toISOString(),
      },
    });
  }

  respondProviderRefresh(
    pending: Awaited<ReturnType<DaemonRegistryHarness["pendingProviderRefresh"]>>,
  ): void {
    this.currentSocket().send({
      type: "refresh_providers_snapshot_response",
      payload: { requestId: pending.request.requestId, acknowledged: true },
    });
  }

  respondAgentValidation(
    pending: Awaited<ReturnType<DaemonRegistryHarness["pendingAgentValidation"]>>,
  ): void {
    this.currentSocket().send({
      type: "hub.execution.agent.validate.response",
      payload: {
        requestId: pending.request.requestId,
        valid: false,
        issues: [
          { path: ["provider"], message: "provider is unavailable" },
          { path: ["options", "nonsense"], message: "unrecognized provider option" },
        ],
        error: null,
      },
    });
  }

  respondControl(pending: PendingRequest<void>, overrides: { requestId?: string } = {}): void {
    this.currentSocket().send({
      type:
        pending.request.type === "archive_workspace_request"
          ? "archive_workspace_response"
          : "cancel_agent_response",
      payload: {
        requestId: overrides.requestId ?? pending.request.requestId,
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

  async replaceConnection(
    completeHello = true,
    sessionProtocol: "legacy" | "session-v1" = "session-v1",
  ): Promise<{ supersededClosed: boolean }> {
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
    const registrySocket = new RegistrySocket(
      client,
      completeHello ? this.daemon.permissions : null,
    );
    let ready: Promise<void> | null = null;
    let unsubscribeReady: () => void = () => undefined;
    if (completeHello) {
      let resolveReady!: () => void;
      ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      unsubscribeReady = this.registry.onConnected(() => resolveReady());
    }
    this.registry.accept(this.daemon, serverSocket, sessionProtocol);
    if (ready) await ready;
    unsubscribeReady();
    this.clients.push(client);
    this.socket = registrySocket;
    return { supersededClosed: superseded?.closed ?? false };
  }

  connected(): boolean {
    return this.registry.connection(this.daemon.id) !== undefined;
  }

  async completeServerInfo(
    permissions: readonly string[] = this.daemon.permissions,
  ): Promise<void> {
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const unsubscribe = this.registry.onConnected(() => resolveReady());
    this.currentSocket().sendServerInfo(permissions);
    if (sameStringSet(permissions, this.daemon.permissions)) await ready;
    unsubscribe();
  }

  onConnected(handler: (daemon: DaemonRecord) => void | Promise<void>): () => void {
    return this.registry.onConnected(handler);
  }

  failOfflinePresence(error: Error): void {
    this.presence.failNext(error);
  }

  async disconnectCurrent(): Promise<void> {
    const socket = this.currentSocket();
    socket.close();
    await socket.waitUntilClosed();
    await new Promise((resolve) => setImmediate(resolve));
  }

  sendRaw(value: string): void {
    this.currentSocket().sendRaw(value);
  }

  sendInvalidClose(code: number): void {
    this.currentSocket().sendInvalidClose(code);
  }

  waitUntilCurrentClosed(): Promise<void> {
    return this.currentSocket().waitUntilClosed();
  }

  async completeCreate(executionId: string, agentId: string): Promise<AgentSnapshot> {
    const pending = await this.pendingCreate(executionId);
    this.currentSocket().send({
      type: "status",
      payload: {
        status: "agent_created",
        requestId: pending.request.requestId,
        agent: { id: agentId, workspaceId: `workspace-${agentId}`, status: "idle" },
      },
    });
    return pending.promise;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.registry.stop();
    } finally {
      for (const client of this.clients) client.terminate();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
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
  private holdOffline = false;
  private writing: Promise<void> | undefined;
  private resolveWriting: (() => void) | undefined;
  private persistence: Promise<void> | undefined;
  private resolvePersistence: (() => void) | undefined;
  private nextFailure: Error | undefined;

  failNext(error: Error): void {
    this.nextFailure = error;
  }

  hold(): void {
    this.holdOffline = true;
    this.writing = new Promise<void>((resolve) => {
      this.resolveWriting = resolve;
    });
    this.persistence = new Promise<void>((resolve) => {
      this.resolvePersistence = resolve;
    });
  }

  async setDaemonPresence(_id: string, _presence: "offline" | "connected"): Promise<void> {
    if (this.nextFailure !== undefined) {
      const error = this.nextFailure;
      this.nextFailure = undefined;
      throw error;
    }
    if (_presence !== "offline" || !this.holdOffline) return;
    this.holdOffline = false;
    this.resolveWriting?.();
    await this.persistence;
  }

  async touchDaemon(_id: string): Promise<void> {}

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

  constructor(
    private readonly socket: WebSocket,
    private readonly helloPermissions: readonly string[] | null,
  ) {
    socket.once("close", () => {
      this.didClose = true;
    });
    socket.on("message", (data) => {
      const value = JSON.parse(readText(data)) as unknown;
      if (isHubHello(value)) {
        if (this.helloPermissions) this.sendServerInfo(this.helloPermissions);
        return;
      }
      this.messages.push(SessionRequestSchema.parse(value).message);
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

  sendServerInfo(permissions: readonly string[]): void {
    this.send({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "test-daemon",
        permissions,
        features: { providersSnapshot: true, hubAgentRpc: true, agentRequestReceipts: true },
      },
    });
  }

  sendRaw(value: string): void {
    this.socket.send(value);
  }

  /**
   * Writes a raw WebSocket close control frame directly onto the
   * underlying TCP socket, bypassing `ws`'s own `close()` validation so a
   * status code the protocol forbids on the wire (e.g. 1006, reserved for
   * abnormal closure and never legally sent) reaches the server's
   * `Receiver`, reproducing WS_ERR_INVALID_CLOSE_CODE.
   */
  sendInvalidClose(code: number): void {
    // `ws` does not type its internal `_socket`, but every `ws` WebSocket
    // instance exposes the underlying net.Socket at runtime once open.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- `ws` leaves `_socket` untyped
    const internals = this.socket as unknown as WebSocketInternals;
    const tcpSocket = internals._socket;
    const mask = Buffer.alloc(4);
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    const maskedPayload = Buffer.alloc(2);
    for (let i = 0; i < 2; i += 1) maskedPayload[i] = payload[i]! ^ mask[i]!;
    tcpSocket.write(Buffer.concat([Buffer.from([0x88, 0x82]), mask, maskedPayload]));
  }

  close(): void {
    this.socket.close();
  }

  async waitUntilClosed(): Promise<void> {
    if (this.didClose) return;
    await new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
  }
}

function isHubHello(value: unknown): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === "hello";
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
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
    permissions: ["hub.execute"],
    registeredByApiKeyId: null,
    registeredByCliCredentialId: null,
    status: "active",
    presence: "connected",
    connectedAt: now,
    disconnectedAt: null,
    lastSeenAt: now,
    createdAt: now,
  };
}

function readText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}
