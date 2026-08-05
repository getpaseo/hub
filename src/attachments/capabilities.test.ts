import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createDiscordAttachmentResolver } from "../triggers/discord/attachments.js";
import { createAttachmentCapabilityRegistry } from "./capabilities.js";

describe("attachment capability boundary", () => {
  it("streams a provider attachment only through an active execution capability", async () => {
    const database = createMemoryDatabase();
    const trigger = await database.insertTrigger({
      organizationId: "org-1",
      projectId: "project-1",
      source: "slack.mention",
      deliveryId: "delivery-1",
      payload: {},
      receivedAt: new Date(),
    });
    const executionId = randomUUID();
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      triggerId: trigger.trigger.id,
      triggerContext: { provider: "slack" },
      outputContext: { provider: "slack" },
      configurationRevisionId: randomUUID(),
    });
    const resolverCalls: unknown[] = [];
    const registry = createAttachmentCapabilityRegistry({
      database,
      publicBaseUrl: "https://hub.test",
      authoritySecret: "hub-secret",
      resolvers: {
        slack: async (input) => {
          resolverCalls.push(input);
          return new Response("exact bytes", {
            headers: { "content-type": "image/png", "content-length": "11" },
          });
        },
      },
    });
    const attachment = await registry.register({
      triggerId: trigger.trigger.id,
      organizationId: "org-1",
      connectionId: "connection-1",
      provider: "slack",
      sourceId: "F1",
      locator: { fileId: "F1" },
      filename: "pixel.png",
      contentType: "image/png",
      byteSize: 11,
    });

    const response = await registry.handle(
      new Request(registry.urlFor(attachment.id, executionId)),
      executionId,
      attachment.id,
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "exact bytes");
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-disposition") ?? "", /pixel\.png/u);
    assert.equal(resolverCalls.length, 1);
    assert.deepEqual(resolverCalls[0], {
      organizationId: "org-1",
      connectionId: "connection-1",
      locator: { fileId: "F1" },
    });
  });

  it("rejects invalid capabilities before contacting a provider", async () => {
    const database = createMemoryDatabase();
    const trigger = await database.insertTrigger({
      organizationId: "org-1",
      projectId: "project-1",
      source: "discord.mention",
      deliveryId: "delivery-1",
      connectionId: "connection-1",
      payload: {},
      receivedAt: new Date(),
    });
    const triggerOther = await database.insertTrigger({
      organizationId: "org-1",
      projectId: "project-1",
      source: "discord.mention",
      deliveryId: "delivery-2",
      connectionId: "connection-1",
      payload: {},
      receivedAt: new Date(),
    });
    const executionId = randomUUID();
    const otherExecutionId = randomUUID();
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      triggerId: trigger.trigger.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: randomUUID(),
    });
    await database.insertAgentExecution({
      id: otherExecutionId,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      triggerId: triggerOther.trigger.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: randomUUID(),
    });
    let nowMs = 1_700_000_000_000;
    let resolverCalls = 0;
    const registry = createAttachmentCapabilityRegistry({
      database,
      publicBaseUrl: "https://hub.test",
      authoritySecret: "hub-secret",
      now: () => new Date(nowMs),
      lifetimeSeconds: 10,
      resolvers: {
        discord: async () => {
          resolverCalls += 1;
          return new Response("must not be reached");
        },
      },
    });
    const attachment = await registry.register({
      triggerId: trigger.trigger.id,
      organizationId: "org-1",
      connectionId: "connection-1",
      provider: "discord",
      sourceId: "attachment-1",
      locator: { url: "https://cdn.discordapp.com/attachments/1/2/image.png" },
      filename: "image.png",
      contentType: "image/png",
      byteSize: 4,
    });

    const validUrl = new URL(registry.urlFor(attachment.id, executionId));
    const forgedUrl = new URL(validUrl);
    forgedUrl.searchParams.set("signature", `${validUrl.searchParams.get("signature")}forged`);
    const crossExecutionUrl = registry.urlFor(attachment.id, otherExecutionId);
    const ownershipMismatchUrl = registry.urlFor(attachment.id, executionId);
    const unknownUrl = registry.urlFor(randomUUID(), executionId);

    const expiredQueryUrl = new URL(validUrl);
    expiredQueryUrl.searchParams.set("expires", "1");
    assert.equal(
      (await registry.handle(new Request(expiredQueryUrl), executionId, attachment.id)).status,
      404,
    );
    assert.equal(
      (await registry.handle(new Request(forgedUrl), executionId, attachment.id)).status,
      404,
    );
    assert.equal(
      (await registry.handle(new Request(crossExecutionUrl), executionId, attachment.id)).status,
      404,
    );
    assert.equal(
      (await registry.handle(new Request(ownershipMismatchUrl), otherExecutionId, attachment.id))
        .status,
      404,
    );
    assert.equal(
      (await registry.handle(new Request(unknownUrl), executionId, randomUUID())).status,
      404,
    );

    nowMs += 11_000;
    assert.equal(
      (await registry.handle(new Request(validUrl), executionId, attachment.id)).status,
      404,
    );
    await database.transitionAgentExecution(executionId, "failed");
    assert.equal(
      (
        await registry.handle(
          new Request(registry.urlFor(attachment.id, executionId)),
          executionId,
          attachment.id,
        )
      ).status,
      404,
    );
    assert.equal(resolverCalls, 0);
  });

  it("uses the same Hub route for a Discord resolver and preserves streaming metadata", async () => {
    const database = createMemoryDatabase();
    const trigger = await database.insertTrigger({
      organizationId: "org-1",
      projectId: "project-1",
      source: "discord.mention",
      deliveryId: "discord-delivery",
      payload: {},
      receivedAt: new Date(),
    });
    const executionId = randomUUID();
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      triggerId: trigger.trigger.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: randomUUID(),
    });
    const resolver = createDiscordAttachmentResolver({
      fetch: async (input) => {
        assert.equal(requestUrl(input), "https://cdn.discordapp.com/attachments/1/2/file.bin");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("discord-"));
              controller.enqueue(new TextEncoder().encode("bytes"));
              controller.close();
            },
          }),
          { headers: { etag: '"discord-1"' } },
        );
      },
    });
    const registry = createAttachmentCapabilityRegistry({
      database,
      publicBaseUrl: "https://hub.test",
      authoritySecret: "hub-secret",
      resolvers: {
        discord: resolver,
      },
    });
    const attachment = await registry.register({
      triggerId: trigger.trigger.id,
      organizationId: "org-1",
      connectionId: "connection-1",
      provider: "discord",
      sourceId: "attachment-1",
      locator: { url: "https://cdn.discordapp.com/attachments/1/2/file.bin" },
      filename: "file.bin",
      contentType: "application/octet-stream",
      byteSize: 13,
    });

    const response = await registry.handle(
      new Request(registry.urlFor(attachment.id, executionId)),
      executionId,
      attachment.id,
    );

    assert.equal(await response.text(), "discord-bytes");
    assert.equal(response.headers.get("etag"), '"discord-1"');
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-length"), "13");
  });

  it("does not forward encoded upstream lengths", async () => {
    const database = createMemoryDatabase();
    const trigger = await database.insertTrigger({
      organizationId: "org-1",
      projectId: "project-1",
      source: "slack.mention",
      deliveryId: "encoded-delivery",
      payload: {},
      receivedAt: new Date(),
    });
    const executionId = randomUUID();
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      triggerId: trigger.trigger.id,
      triggerContext: {},
      outputContext: {},
      configurationRevisionId: randomUUID(),
    });
    const registry = createAttachmentCapabilityRegistry({
      database,
      publicBaseUrl: "https://hub.test",
      authoritySecret: "hub-secret",
      resolvers: {
        slack: async () =>
          new Response("decoded bytes", {
            headers: {
              "content-encoding": "gzip",
              "content-length": "123",
            },
          }),
      },
    });
    const attachment = await registry.register({
      triggerId: trigger.trigger.id,
      organizationId: "org-1",
      connectionId: "connection-1",
      provider: "slack",
      sourceId: "encoded-file",
      locator: { fileId: "encoded-file" },
      filename: "file.bin",
      contentType: "application/octet-stream",
      byteSize: 12,
    });

    const response = await registry.handle(
      new Request(registry.urlFor(attachment.id, executionId)),
      executionId,
      attachment.id,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), null);
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}
