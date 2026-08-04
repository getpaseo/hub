import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { DaemonRegistration } from "../daemons/registration.js";
import { ActiveDaemonRegistry } from "../daemons/registry.js";
import { createFetchServer } from "./node-server.js";

describe("device issuance client address", () => {
  it("uses the socket peer regardless of caller-supplied proxy headers or user agents", async () => {
    const hub = await DeviceIssuanceServer.start();

    try {
      const statuses = [];
      for (let index = 0; index < 6; index += 1) {
        statuses.push(
          await hub.request({
            "cf-connecting-ip": `198.51.100.${index + 1}`,
            "x-forwarded-for": `203.0.113.${index + 1}`,
            "x-paseo-client-address": `192.0.2.${index + 1}`,
            "x-real-ip": `192.0.2.${index + 10}`,
            "user-agent": `rotating-agent-${index}`,
          }),
        );
      }

      assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
    } finally {
      await hub.close();
    }
  });

  it("uses only the configured valid single-IP header", async () => {
    const hub = await DeviceIssuanceServer.start("fly-client-ip");

    try {
      const statuses = [];
      for (let index = 0; index < 6; index += 1) {
        statuses.push(
          await hub.request({
            "fly-client-ip": "198.51.100.20",
            "x-forwarded-for": `203.0.113.${index + 1}`,
            "x-paseo-client-address": `192.0.2.${index + 1}`,
            "user-agent": `rotating-agent-${index}`,
          }),
        );
      }
      statuses.push(await hub.request({ "fly-client-ip": "198.51.100.21" }));

      assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 201]);
    } finally {
      await hub.close();
    }
  });

  it("falls back to the socket peer when the configured header is missing or invalid", async () => {
    const hub = await DeviceIssuanceServer.start("fly-client-ip");
    const headers = [
      {},
      { "fly-client-ip": "not-an-ip" },
      { "fly-client-ip": "198.51.100.1, 198.51.100.2" },
      { "fly-client-ip": "198.51.100.999" },
      { "fly-client-ip": "[2001:db8::1]" },
      { "x-paseo-client-address": "203.0.113.50" },
    ];

    try {
      const statuses = [];
      for (const requestHeaders of headers) statuses.push(await hub.request(requestHeaders));

      assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
    } finally {
      await hub.close();
    }
  });
});

class DeviceIssuanceServer {
  private constructor(
    private readonly origin: string,
    private readonly server: ReturnType<typeof createFetchServer>,
  ) {}

  static async start(trustedClientIpHeader?: string): Promise<DeviceIssuanceServer> {
    const database = createMemoryDatabase({ organizationIds: ["acme"] });
    const registration = new DaemonRegistration({
      database,
      activeDaemons: new ActiveDaemonRegistry(database),
      publicBaseUrl: "https://hub.paseo.test",
    });
    const server = createFetchServer(
      (request) => registration.start(request),
      trustedClientIpHeader === undefined ? {} : { trustedClientIpHeader },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("device issuance server did not bind a TCP address");
    }
    return new DeviceIssuanceServer(`http://127.0.0.1:${address.port}`, server);
  }

  async request(headers: Record<string, string>): Promise<number> {
    const response = await fetch(`${this.origin}/api/device-authorizations/`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ displayName: "Build daemon" }),
    });
    await response.body?.cancel();
    return response.status;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
