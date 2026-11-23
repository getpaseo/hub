import { z } from "zod";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { DaemonRecord } from "../db/types.js";
import { HubDaemonHelloSchema } from "../hub/protocol.js";
import { createLogger } from "../logger.js";
import { assertOneFailure, FailureLogStream } from "../test-utils/failure-logs.js";
import { DaemonResponseLostError } from "./protocol.js";
import { ActiveDaemonRegistry, createDaemonUpgradeHandler } from "./registry.js";
import { DaemonRegistryHarness } from "./test-utils/daemon-registry-harness.js";

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}

describe("daemon socket protocol negotiation", () => {
  it.each([
    {
      offered: true,
      expectedProtocol: "1",
      expectsHello: true,
      expectsReady: false,
    },
    {
      offered: false,
      expectedProtocol: undefined,
      expectsHello: false,
      expectsReady: true,
    },
  ])(
    "negotiates the standard session only when offered=$offered",
    async ({ offered, expectedProtocol, expectsHello, expectsReady }) => {
      const secret = "daemon-secret";
      const now = new Date();
      const daemon: DaemonRecord = {
        id: randomUUID(),
        slug: "negotiation-daemon",
        machineId: randomUUID(),
        serverId: randomUUID(),
        daemonPublicKey: "public-key",
        credentialVerifier: createHash("sha256").update(secret).digest("base64url"),
        permissions: ["hub.execute"],
        registeredByApiKeyId: null,
        registeredByCliCredentialId: null,
        status: "active",
        presence: "offline",
        connectedAt: null,
        disconnectedAt: null,
        lastSeenAt: now,
        createdAt: now,
      };
      const registry = new ActiveDaemonRegistry({
        touchDaemon: async () => undefined,
        setDaemonPresence: async () => undefined,
      });
      const server = createServer();
      const handleUpgrade = createDaemonUpgradeHandler(
        { findDaemonById: async () => daemon },
        registry,
      );
      server.on("upgrade", (request, socket, head) => {
        void handleUpgrade(request, socket, head);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address !== "string");
      const messages: string[] = [];
      let negotiatedProtocol: string | string[] | undefined;
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/daemons/socket`, {
        headers: {
          authorization: `Bearer ${secret}`,
          "x-paseo-daemon-id": daemon.id,
          ...(offered ? { "x-paseo-session-protocol": "1" } : {}),
        },
      });
      client.on("upgrade", (response) => {
        negotiatedProtocol = response.headers["x-paseo-session-protocol"];
      });
      client.on("message", (data: RawData) => {
        messages.push(rawDataToText(data));
      });
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      const isHello = (message: string) =>
        HubDaemonHelloSchema.safeParse(JSON.parse(message)).success;
      if (expectsHello) {
        // The hello crosses the socket after the client's open event, so wait for it to arrive.
        await vi.waitFor(() => assert(messages.some(isHello)), { timeout: 5_000 });
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      assert.equal(negotiatedProtocol, expectedProtocol);
      assert.equal(messages.some(isHello), expectsHello);
      assert.equal(registry.connection(daemon.id) !== undefined, expectsReady);

      client.close();
      await new Promise<void>((resolve) => client.once("close", () => resolve()));
      await registry.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );
});

describe("daemon socket generations", () => {
  it("does not expose a physical socket until standard session bootstrap completes", async () => {
    await daemon.replaceConnection(false);

    assert.equal(daemon.connected(), false);
    await daemon.completeServerInfo();

    assert.equal(daemon.connected(), true);
  });

  it("rejects a session whose effective permissions differ from enrollment", async () => {
    await daemon.replaceConnection(false);
    await daemon.completeServerInfo([]);

    await daemon.waitUntilCurrentClosed();
    assert.equal(daemon.connected(), false);
  });

  it("keeps a legacy daemon connected without sending the standard hello", async () => {
    await daemon.replaceConnection(false, "legacy");

    assert.equal(daemon.connected(), true);
  });

  let daemon: DaemonRegistryHarness;
  let stream: FailureLogStream;

  beforeEach(async () => {
    stream = new FailureLogStream();
    daemon = await DaemonRegistryHarness.start(createLogger(stream));
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it("rejects superseded requests before close and keeps the replacement usable", async () => {
    const oldCreate = await daemon.pendingCreate("old-create");

    const replacement = await daemon.replaceConnection();

    assert.equal(replacement.supersededClosed, false);
    await assert.rejects(oldCreate.promise, {
      name: DaemonResponseLostError.name,
      message: "daemon response was lost",
    });
    assert.deepEqual(await daemon.completeCreate("new-create", "agent-new"), {
      id: "agent-new",
      workspaceId: "workspace-agent-new",
      status: "idle",
    });
  });

  it("forwards opaque provider options without a Hub tool policy", async () => {
    const pending = await daemon.pendingCreate("contract-create");

    assert.deepEqual(
      z.record(z.string(), z.unknown()).parse(pending.request["config"])["providerOptions"],
      {
        permission: { edit: "ask", bash: "deny" },
      },
    );
    assert.deepEqual(
      z.record(z.string(), z.unknown()).parse(pending.request["config"])["toolPolicy"],
      undefined,
    );
  });

  it("delegates provider, model, mode, and structured option validation to the daemon", async () => {
    const pending = await daemon.pendingAgentValidation("/workspace");

    // The daemon resolves the provider catalog of the directory the agent will run in (#209).
    assert.equal(pending.request["cwd"], "/workspace");
    assert.equal(pending.request["provider"], "definitely-not-installed");
    assert.equal(pending.request["model"], "imaginary-model");
    assert.equal(pending.request["modeId"], "imaginary-mode");
    assert.deepEqual(pending.request["providerOptions"], { nonsense: true });
    daemon.respondAgentValidation(pending);

    assert.deepEqual(await pending.promise, {
      valid: false,
      issues: [
        { path: ["provider"], message: "provider is unavailable" },
        {
          path: ["options", "nonsense"],
          message: "unrecognized provider option",
        },
      ],
    });
  });

  it("reads and refreshes provider capabilities through the Hub execution session", async () => {
    const refresh = await daemon.pendingProviderRefresh();
    assert.deepEqual(
      { cwd: refresh.request["cwd"], providers: refresh.request["providers"] },
      { cwd: "/workspace", providers: ["codex"] },
    );
    daemon.respondProviderRefresh(refresh);
    await refresh.promise;

    const snapshot = await daemon.pendingProviderSnapshot();
    daemon.respondProviderSnapshot(snapshot);

    assert.deepEqual((await snapshot.promise).entries, [
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
    ]);
  });

  it("lists the projects the daemon has open", async () => {
    const projects = await daemon.pendingProjectList();
    daemon.respondProjectList(projects, [
      {
        projectId: "project-1",
        projectDisplayName: "hub",
        projectCustomName: "Paseo Hub",
        projectRootPath: "/home/dev/hub",
        projectKind: "git",
      },
      {
        projectId: "project-2",
        projectDisplayName: "notes",
        projectCustomName: null,
        projectRootPath: "/home/dev/notes",
        projectKind: "a-kind-added-later",
      },
    ]);

    assert.deepEqual(await projects.promise, [
      { id: "project-1", name: "Paseo Hub", rootPath: "/home/dev/hub" },
      { id: "project-2", name: "notes", rootPath: "/home/dev/notes" },
    ]);
  });

  it.each(["access_denied", "unknown_schema"])(
    "reads a daemon that answers the project list with %s as offering no projects",
    async (code) => {
      const projects = await daemon.pendingProjectList();
      daemon.rejectRequest(projects, code);

      assert.deepEqual(await projects.promise, []);
    },
  );

  it("still fails the project list when the daemon breaks while answering it", async () => {
    const projects = await daemon.pendingProjectList();
    daemon.rejectRequest(projects, "handler_error");

    await assert.rejects(projects.promise, /daemon refused/u);
  });

  it("asks a legacy daemon for nothing and offers no projects", async () => {
    await daemon.replaceConnection(false, "legacy");

    assert.deepEqual(await daemon.listProjects(), []);
  });

  it("expires unanswered project list requests without interrupting slow provider refreshes", async () => {
    const timed = await DaemonRegistryHarness.start(createLogger(stream), 50);
    try {
      const refresh = await timed.pendingProviderRefresh();
      const unanswered = await timed.pendingProjectList();

      await assert.rejects(unanswered.promise, /daemon_request_timeout/u);

      // Provider discovery can run much longer than project suggestions; the refresh still settles.
      assert.equal(await timed.requestSettled(refresh.promise), false);
      timed.respondProviderRefresh(refresh);
      await refresh.promise;

      const answered = await timed.pendingProjectList();
      timed.respondProjectList(answered, [
        {
          projectId: "project-1",
          projectDisplayName: "hub",
          projectCustomName: null,
          projectRootPath: "/home/dev/hub",
          projectKind: "git",
        },
      ]);
      assert.deepEqual(await answered.promise, [
        { id: "project-1", name: "hub", rootPath: "/home/dev/hub" },
      ]);
    } finally {
      await timed.stop();
    }
  });

  it("waits for offline presence before shutdown completes", async () => {
    daemon.holdOfflinePresence();

    daemon.beginStop();
    await daemon.offlinePresenceBegins();

    assert.equal(await daemon.shutdownCompleted(), false);
    daemon.persistOfflinePresence();
    await daemon.shutdownCompletes();
  });

  it("logs an offline-presence storage rejection exactly once", async () => {
    const canary = "offline-presence-secret-7e12";
    daemon.failOfflinePresence(new Error(canary));
    await daemon.disconnectCurrent();
    await vi.waitFor(() => assert.equal(stream.records().length, 1));
    await assert.rejects(daemon.stop(), { message: canary });

    assertOneFailure(stream, {
      operation: "daemon.presence.offline",
      component: "daemons",
      canary,
    });
  });

  it("logs a connected recovery rejection without blocking later handlers", async () => {
    const canary = "connected-recovery-secret-32f1";
    let laterHandlerRan = false;
    daemon.onConnected(() => Promise.reject(new Error(canary)));
    daemon.onConnected(() => {
      laterHandlerRan = true;
    });
    await daemon.replaceConnection();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(laterHandlerRan, true);
    assertOneFailure(stream, {
      operation: "daemon.connected.handler",
      component: "daemons",
      canary,
    });
  });

  it("closes malformed WebSocket JSON intentionally and logs no payload", async () => {
    const canary = "malformed-websocket-secret-a83f";
    daemon.sendRaw(`not-json-${canary}`);
    await daemon.waitUntilCurrentClosed();
    await new Promise((resolve) => setImmediate(resolve));

    assertOneFailure(stream, {
      operation: "daemon.websocket.message.parse",
      component: "daemons",
      failureKind: "validation",
      level: 40,
      canary,
    });
  });

  it("pairs ordinary control acknowledgements by request", async () => {
    const pending = await daemon.pendingControl("execution-1", "archive");

    daemon.respondControl(pending, { requestId: "request-stale" });
    assert.equal(await daemon.requestSettled(pending.promise), false);
    daemon.respondControl(pending);

    await pending.promise;
  });

  it("rejects execution-control acknowledgements from a superseded generation", async () => {
    const pending = await daemon.pendingControl("execution-1", "interrupt");

    await daemon.replaceConnection();

    await assert.rejects(pending.promise, DaemonResponseLostError);
  });

  it("survives an invalid WebSocket close code instead of crashing the process", async () => {
    // Real production crash: a peer sending a close frame with a code the
    // protocol forbids on the wire (1006 is reserved and must never be
    // sent) makes `ws`'s Receiver emit `error` on the server socket. With
    // no `error` listener, Node rethrows it as an uncaught exception and
    // kills the whole Hub process. If `accept()` regresses, this test
    // crashes the worker instead of merely failing an assertion.
    daemon.sendInvalidClose(1006);
    await daemon.waitUntilCurrentClosed();
    await new Promise((resolve) => setImmediate(resolve));

    assertOneFailure(stream, {
      operation: "daemon.socket.error",
      component: "daemons",
      failureKind: "network",
      canary: "invalid-close-code-1006-never-logged",
    });
  });
});
