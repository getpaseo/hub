import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import { DatabaseUnavailableError } from "../../db/errors.js";
import type { ProviderEventAcceptance } from "../../db/types.js";
import type { ExternalTrigger } from "../index.js";
import {
  createMemoryInboundQueue,
  type InboundQueue,
  type MemoryInboundQueueOptions,
} from "../../inbound/index.js";
import {
  createWebhookSource,
  GITHUB_WEBHOOK_EVENT,
  type WebhookEndpoint,
  type WebhookSourceOptions,
  hashWebhookSignature,
  normalizeWebhookEvent,
  verifySignature,
} from "./webhook.js";

const SECRET = "test-secret";

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const payload = JSON.stringify(createWebhookPayload());
    const signature = createSignature(payload);

    assert.equal(verifySignature(SECRET, payload, signature), true);
  });

  it("returns false for a tampered payload", () => {
    const payload = JSON.stringify(createWebhookPayload());
    const signature = createSignature(payload);
    const tamperedPayload = JSON.stringify({
      ...createWebhookPayload(),
      action: "closed",
    });

    assert.equal(verifySignature(SECRET, tamperedPayload, signature), false);
  });
});

describe("hashWebhookSignature", () => {
  it("returns the same hash for the same GitHub signature", () => {
    const payload = JSON.stringify(createWebhookPayload());
    const signature = createSignature(payload);

    assert.equal(hashWebhookSignature(signature), hashWebhookSignature(signature));
  });
});

describe("normalizeWebhookEvent", () => {
  it("produces a normalized webhook event stamped with when it was received", () => {
    const body = createWebhookPayload();
    const receivedAt = new Date("2026-11-26T10:00:00.000Z");
    const event = normalizeWebhookEvent({
      body,
      deliveryId: "delivery-123",
      eventType: "issue_comment",
      receivedAt,
    });

    assert.notEqual(event, undefined);
    assert.equal(event!.id, "delivery-123");
    assert.equal(event!.type, "issue_comment");
    assert.equal(event!.repo, "acme/widgets");
    assert.equal(event!.repositoryId, 9001);
    assert.equal(event!.installationId, 42);
    assert.equal(event!.payload, body);
    assert.equal(event!.createdAt, "2026-11-26T10:00:00.000Z");
  });

  it("returns undefined for events without repository", () => {
    const event = normalizeWebhookEvent({
      body: { action: "completed" },
      deliveryId: "ping-123",
      eventType: "ping",
      receivedAt: new Date(),
    });

    assert.equal(event, undefined);
  });
});

describe("GitHub webhook", () => {
  it("requires an installation id after authenticating the signed body", async () => {
    const github = new GitHubWebhook();
    assert.equal(await github.deliver("missing-installation", { action: "ping" }), 400);
    assert.equal(github.inbound.stats().totals.processed, 0);
  });

  it("durably drops an authentic unsupported delivery before dispatch", async () => {
    const dropped: string[] = [];
    const github = new GitHubWebhook({
      accept: async (input) => {
        dropped.push(input.dropReason ?? "");
        return {
          status: "dropped",
          receiptId: input.deliveryId,
          reason: input.dropReason!,
        };
      },
    });
    assert.equal(
      await github.deliver("unsupported", { action: "ping", installation: { id: 42 } }),
      200,
    );
    assert.deepEqual(dropped, ["no_trigger_for_source"]);
  });

  it("drops a delivery whose repository the payload schema cannot read", async () => {
    const dropped: string[] = [];
    const github = new GitHubWebhook({
      accept: async (input) => {
        dropped.push(input.dropReason ?? "");
        return { status: "dropped", receiptId: input.deliveryId, reason: input.dropReason! };
      },
    });
    assert.equal(
      await github.deliver("null-repository", {
        action: "created",
        installation: { id: 42 },
        repository: null,
      }),
      200,
    );
    assert.deepEqual(dropped, ["no_trigger_for_source"]);
  });

  it("records a durable outcome when a bound delivery has no handler", async () => {
    const dropped: string[] = [];
    const github = new GitHubWebhook({
      accept: async (input) => {
        dropped.push(input.dropReason ?? "");
        return {
          status: "dropped",
          receiptId: input.deliveryId,
          reason: input.dropReason!,
        };
      },
    });

    assert.equal(await github.deliver("no-handler"), 200);
    assert.deepEqual(dropped, ["configuration_unavailable"]);
  });

  it("syncs a configuration-source push even when runtime trigger routing drops it", async () => {
    const synchronized: Array<{
      installationId: number;
      repositoryId: number;
      deliveryId: string;
    }> = [];
    const acceptedDeliveries: Array<{ source: string; deliveryId: string }> = [];
    const github = new GitHubWebhook({
      accept: async (input) => {
        acceptedDeliveries.push({ source: input.source, deliveryId: input.deliveryId });
        return {
          status: "dropped" as const,
          receiptId: "receipt-config-only",
          reason: "no_project_route",
        };
      },
      synchronizePush: async (input) => {
        synchronized.push({
          installationId: input.installationId,
          repositoryId: input.repositoryId,
          deliveryId: input.deliveryId,
        });
      },
    });

    assert.equal(
      await github.deliver(
        "config-only-push",
        {
          ...createWebhookPayload(),
          ref: "refs/heads/main",
          after: "commit-config-only",
          sender: { login: "paseo" },
        },
        "push",
      ),
      200,
    );
    assert.deepEqual(synchronized, [
      { installationId: 42, repositoryId: 9001, deliveryId: "config-only-push" },
    ]);
    assert.deepEqual(acceptedDeliveries, [
      { source: "github.push", deliveryId: "config-only-push" },
    ]);
  });

  it("rejects declared and streamed oversized bodies before full buffering", async () => {
    const github = new OversizedGitHubWebhook(new GitHubWebhook().endpoint);

    assert.equal(await github.deliverDeclared(), 413);
    assert.deepEqual(await github.deliverStalled(), { status: 413, canceled: true });
  });

  it("answers 200 while storage is unavailable and accepts the delivery once it is back", async () => {
    const receivedAt: Date[] = [];
    const github = new GitHubWebhook({
      accept: (input) => {
        receivedAt.push(input.receivedAt);
        return receivedAt.length === 1
          ? Promise.reject(new DatabaseUnavailableError())
          : Promise.resolve(accepted(input));
      },
    });
    await github.record();

    assert.equal(await github.deliver("database-unavailable"), 200);

    assert.deepEqual(github.receivedIds(), ["database-unavailable"]);
    assert.equal(receivedAt.length, 2);
    // The receipt keeps the time the delivery was verified, not the time of the retry.
    assert.equal(receivedAt[1]!.getTime(), receivedAt[0]!.getTime());
  });

  it("answers 503 when the inbound queue is full", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const github = new GitHubWebhook(
      {
        accept: async (input) => {
          await held;
          return accepted(input);
        },
      },
      { maxItems: 1 },
    );

    assert.equal(await github.handle("first"), 200);
    assert.equal(await github.handle("second"), 503);
    release?.();
    await github.inbound.idle();
  });

  it("does not dispatch duplicate delivery ids", async () => {
    const github = GitHubWebhook.deduplicating();
    await github.record();

    await github.deliver("delivery-123");
    await github.deliver("delivery-123");

    assert.deepEqual(github.receivedIds(), ["delivery-123"]);
  });

  it("fans out one delivery to independent consumers", async () => {
    const github = new GitHubWebhook();
    await github.addConsumer("first");
    await github.addConsumer("second");

    assert.equal(await github.deliver("delivery-fanout"), 200);
    assert.deepEqual(github.receivedSources(), [
      "first:github.issue_comment",
      "second:github.issue_comment",
    ]);
  });
});

/** A webhook source wired to a real inbound queue, the way the GitHub registration wires it. */
class GitHubWebhook {
  readonly inbound: InboundQueue;
  readonly endpoint: WebhookEndpoint;
  private readonly deliveries: ExternalTrigger[] = [];

  constructor(
    options: Partial<Omit<WebhookSourceOptions, "inbound">> = {},
    queue: MemoryInboundQueueOptions = {},
  ) {
    this.inbound = createMemoryInboundQueue({ retry: { initialMs: 10, maxMs: 10 }, ...queue });
    this.endpoint = createWebhookSource(SECRET, {
      accept: (input) => Promise.resolve(accepted(input)),
      applyLifecycle: () => Promise.resolve(),
      ...options,
      inbound: this.inbound,
    });
    this.inbound.start({ [GITHUB_WEBHOOK_EVENT]: (event) => this.endpoint.process(event) });
  }

  /** Answers like the receipt store: a delivery id it has seen is a duplicate. */
  static deduplicating(): GitHubWebhook {
    const deliveries = new Set<string>();
    return new GitHubWebhook({
      accept(input) {
        if (deliveries.has(input.deliveryId)) {
          return Promise.resolve({
            status: "duplicate",
            triggerIds: [`trigger-${input.deliveryId}`],
            receiptId: input.deliveryId,
          });
        }
        deliveries.add(input.deliveryId);
        return Promise.resolve(accepted(input));
      },
    });
  }

  async record(): Promise<void> {
    await this.endpoint.start(async (event) => {
      this.deliveries.push(event);
    });
  }

  async addConsumer(name: string): Promise<void> {
    await this.endpoint.start(async (event) => {
      this.deliveries.push({ ...event, source: `${name}:${event.source}` });
    });
  }

  /** Sends a signed delivery and waits until the queue has processed it. */
  async deliver(
    deliveryId: string,
    payload: unknown = createWebhookPayload(),
    eventType = "issue_comment",
  ): Promise<number> {
    const status = await this.handle(deliveryId, payload, eventType);
    await this.inbound.idle();
    return status;
  }

  async handle(
    deliveryId: string,
    payload: unknown = createWebhookPayload(),
    eventType = "issue_comment",
  ): Promise<number> {
    const body = JSON.stringify(payload);
    const response = await this.endpoint.handle(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: createHeaders(createSignature(body), deliveryId, eventType),
        body,
      }),
    );
    return response.status;
  }

  receivedIds(): string[] {
    return this.deliveries.map((delivery) => delivery.deliveryId);
  }

  receivedSources(): string[] {
    return this.deliveries.map((delivery) => delivery.source);
  }
}

class OversizedGitHubWebhook {
  private canceled = false;

  constructor(private readonly endpoint: WebhookEndpoint) {}

  async deliverDeclared(): Promise<number> {
    const response = await this.endpoint.handle(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          ...Object.fromEntries(createHeaders("sha256=invalid", "declared")),
          "content-length": "1048577",
        },
        body: "{}",
      }),
    );
    return response.status;
  }

  async deliverStalled(): Promise<{ status: number; canceled: boolean }> {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        chunks += 1;
        if (chunks <= 2) controller.enqueue(new Uint8Array(600_000));
      },
      cancel: () => {
        this.canceled = true;
      },
    });
    interface StreamingRequestInit extends RequestInit {
      duplex: "half";
    }
    const requestInit = {
      method: "POST",
      headers: createHeaders("sha256=invalid", "streamed"),
      body,
      duplex: "half",
    } satisfies StreamingRequestInit;
    const request = new Request("http://localhost/webhook", requestInit);
    const response = await this.endpoint.handle(request);
    return { status: response.status, canceled: this.canceled };
  }
}

function accepted(input: {
  deliveryId: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
}): ProviderEventAcceptance {
  return {
    status: "accepted",
    receiptId: `receipt-${input.deliveryId}`,
    events: [
      {
        providerEventReceiptId: `trigger-${input.deliveryId}`,
        organizationId: "org_1",
        projectId: "project-1",
        configurationRevisionId: "11111111-1111-4111-8111-111111111133",
        deliveryId: input.deliveryId,
        source: input.source,
        payload: input.payload,
        receivedAt: input.receivedAt,
        connectionId: "github-connection",
        resourceId: "9001",
      },
    ],
  };
}

function createWebhookPayload(options: { installationId?: number } = {}): {
  action: string;
  installation: { id: number };
  repository: { id: number; full_name: string };
} {
  return {
    action: "created",
    installation: {
      id: options.installationId ?? 42,
    },
    repository: {
      id: 9001,
      full_name: "acme/widgets",
    },
  };
}

function createSignature(payload: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(payload).digest("hex");
}

function createHeaders(
  signature: string,
  deliveryId: string,
  eventType = "issue_comment",
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "X-GitHub-Delivery": deliveryId,
    "X-GitHub-Event": eventType,
    "X-Hub-Signature-256": signature,
  });
}
