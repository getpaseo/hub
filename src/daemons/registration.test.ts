import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import type { OrganizationAccessValue } from "../auth/organization-access.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { ActiveDaemonRegistry } from "./registry.js";
import { DaemonRegistration, enrollDaemon, normalizeUserCode } from "./registration.js";

const registrationRequestSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  expiresAt: z.string(),
  interval: z.number(),
});
const registrationPollSchema = z.object({
  status: z.string(),
  interval: z.number(),
  enrollmentToken: z.string().optional(),
});
const daemonListSchema = z.object({
  daemons: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      registrationMethod: z.string(),
      status: z.string(),
    }),
  ),
  canManage: z.boolean(),
});

describe("daemon registration", () => {
  it("approves and enrolls one named daemon into the active organization", async () => {
    const hub = new RegistrationJourney();
    const request = await hub.request("Studio Mac");

    const daemonId = await hub.approveAndEnroll(request, "Build Studio");

    assert.deepEqual(await hub.daemons(), {
      daemons: [
        {
          id: daemonId,
          displayName: "Build Studio",
          registrationMethod: "device",
          status: "active",
        },
      ],
      canManage: true,
    });
  });

  it("keeps denial and expiry terminal without organization residue", async () => {
    const denied = new RegistrationJourney();
    const deniedRequest = await denied.request("Denied Mac");
    await denied.deny(deniedRequest.userCode);

    const expired = new RegistrationJourney();
    const expiredRequest = await expired.request("Expired Mac");
    expired.advance(601);

    assert.equal(await denied.pollStatus(deniedRequest.deviceCode), "denied");
    assert.equal(await expired.pollStatus(expiredRequest.deviceCode), "expired");
    assert.deepEqual((await denied.daemons()).daemons, []);
    assert.deepEqual((await expired.daemons()).daemons, []);
  });

  it("normalizes human codes, slows early polling, and bounds public issuance", async () => {
    const hub = new RegistrationJourney();
    const request = await hub.request("Studio Mac");

    const first = await hub.poll(request.deviceCode);
    const second = await hub.poll(request.deviceCode);
    const statuses = await hub.requestStatuses(5);

    assert.equal(
      normalizeUserCode(` ${request.userCode.toLowerCase()} `),
      request.userCode.replaceAll("-", ""),
    );
    assert.deepEqual(
      [first.status, `${second.status}:${second.interval}`],
      ["pending", "slow_down:10"],
    );
    assert.deepEqual(statuses, [201, 201, 201, 201, 429]);
  });

  it("materializes one retry-safe enrollment authority after approval", async () => {
    const hub = new RegistrationJourney();
    const request = await hub.request("Studio Mac");
    await hub.approve(request.userCode, "Build Studio");
    hub.advance(5);

    const first = await hub.poll(request.deviceCode);
    hub.advance(first.interval);
    const replay = await hub.poll(request.deviceCode);
    const daemonId = randomUUID();
    const enrolled = await hub.enroll(first.enrollmentToken!, daemonId);
    const duplicate = await hub.enroll(replay.enrollmentToken!, randomUUID());

    assert.equal(first.enrollmentToken, replay.enrollmentToken);
    assert.equal(enrolled.status, 200);
    assert.equal(duplicate.status, 401);
  });

  it("conceals foreign daemons and denies member mutations", async () => {
    const database = createMemoryDatabase({
      organizationIds: ["acme", "orbit"],
      memberships: [
        membership("acme", "owner"),
        membership("acme", "member"),
        membership("orbit", "owner"),
      ],
    });
    const owner = new RegistrationJourney(database, access("acme", "owner"));
    const member = new RegistrationJourney(database, access("acme", "member"));
    const foreign = new RegistrationJourney(database, access("orbit", "owner"));
    const request = await owner.request("Studio Mac");
    const daemonId = await owner.approveAndEnroll(request, "Build Studio");

    const memberRename = await member.rename(daemonId, "Nope");
    const foreignRename = await foreign.rename(daemonId, "Nope");

    assert.equal(memberRename.status, 403);
    assert.equal(foreignRename.status, 404);
    assert.deepEqual((await foreign.daemons()).daemons, []);
    assert.equal((await member.daemons()).canManage, false);
  });
});

class RegistrationJourney {
  private now = new Date("2026-07-18T12:00:00.000Z");
  private readonly database: Database;
  private readonly registration: DaemonRegistration;

  constructor(
    database?: Database,
    private readonly organizationAccess: OrganizationAccessValue = access("acme", "owner"),
  ) {
    this.database =
      database ??
      createMemoryDatabase({
        organizationIds: ["acme"],
        memberships: [
          membership(organizationAccess.organization.id, organizationAccess.membership.role),
        ],
        now: () => this.now,
      });
    this.registration = new DaemonRegistration({
      database: this.database,
      activeDaemons: new ActiveDaemonRegistry(this.database),
      publicBaseUrl: "https://hub.paseo.test",
      access: {
        resolveOrganizationAccess: async () => organizationAccess,
        resolveAccount: async () => ({
          session: { ...organizationAccess.session, activeOrganizationId: null },
          account: organizationAccess.account,
        }),
        rejectCookieMutation: () => undefined,
      },
    });
  }

  async request(displayName: string) {
    const response = await this.registration.start(
      post("/api/device-authorizations/", { displayName }),
    );
    assert.equal(response.status, 201);
    return registrationRequestSchema.parse(await response.json());
  }

  async requestStatuses(count: number): Promise<number[]> {
    const statuses: number[] = [];
    for (let index = 0; index < count; index++) {
      statuses.push(
        (
          await this.registration.start(
            post("/api/device-authorizations/", { displayName: `Daemon ${index}` }),
          )
        ).status,
      );
    }
    return statuses;
  }

  async approveAndEnroll(
    request: { deviceCode: string; userCode: string },
    displayName: string,
  ): Promise<string> {
    await this.approve(request.userCode, displayName);
    this.advance(5);
    const poll = await this.poll(request.deviceCode);
    const daemonId = randomUUID();
    const response = await this.enroll(poll.enrollmentToken!, daemonId);
    assert.equal(response.status, 200);
    return daemonId;
  }

  async approve(userCode: string, displayName: string): Promise<void> {
    const response = await this.registration.decide(
      post("/api/device-authorizations/decision", {
        userCode,
        displayName,
        organizationId: this.organizationAccess.organization.id,
        decision: "approve",
      }),
    );
    assert.equal(response.status, 200);
  }

  async deny(userCode: string): Promise<void> {
    const response = await this.registration.decide(
      post("/api/device-authorizations/decision", {
        userCode,
        decision: "deny",
      }),
    );
    assert.equal(response.status, 200);
  }

  async poll(deviceCode: string) {
    const response = await this.registration.poll(
      post("/api/device-authorizations/poll", { deviceCode }),
    );
    assert.equal(response.status, 200);
    return registrationPollSchema.parse(await response.json());
  }

  async pollStatus(deviceCode: string): Promise<string> {
    return (await this.poll(deviceCode)).status;
  }

  async enroll(token: string, daemonId: string): Promise<Response> {
    return enrollDaemon(
      post(
        "/api/daemons/enroll",
        {
          daemonId,
          idempotencyKey: randomUUID(),
          serverId: "server-1",
          daemonPublicKey: "public-key",
          credentialVerifier: "credential-verifier",
        },
        { authorization: `Bearer ${token}` },
      ),
      this.database,
      "https://hub.paseo.test",
      { nowDate: () => this.now },
    );
  }

  async daemons() {
    const response = await this.registration.list(
      new Request(
        `https://hub.paseo.test/api/organization/daemons/?organizationSlug=${this.organizationAccess.organization.id}`,
      ),
    );
    assert.equal(response.status, 200);
    return daemonListSchema.parse(await response.json());
  }

  rename(daemonId: string, displayName: string): Promise<Response> {
    return this.registration.rename(
      post(
        `/api/organization/daemons/${daemonId}/rename?organizationSlug=${this.organizationAccess.organization.id}`,
        { displayName },
      ),
      daemonId,
    );
  }

  advance(seconds: number): void {
    this.now = new Date(this.now.getTime() + seconds * 1_000);
  }
}

function membership(organizationId: string, role: "owner" | "admin" | "member") {
  return {
    userId: `user-${organizationId}-${role}`,
    organizationId,
    organizationName: organizationId === "acme" ? "Acme" : "Orbit",
    organizationSlug: organizationId,
    membershipId: `member-${organizationId}-${role}`,
    role,
  } as const;
}

function access(
  organizationId: string,
  role: "owner" | "admin" | "member",
): OrganizationAccessValue {
  return {
    session: { id: `session-${organizationId}-${role}` },
    account: { id: `user-${organizationId}-${role}`, name: "Alice", email: "alice@example.com" },
    organization: { id: organizationId, name: organizationId === "acme" ? "Acme" : "Orbit" },
    membership: { id: `member-${organizationId}-${role}`, role },
    capabilities: {
      view: true,
      manageResources: role !== "member",
      manageMembers: role !== "member",
      manageOwners: role === "owner",
    },
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://hub.paseo.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
