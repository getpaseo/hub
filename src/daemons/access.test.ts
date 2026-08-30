import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import type { BrowserOrganizationAccess } from "../auth/browser-organization-access.js";
import { createMemoryDatabase } from "../db/memory.js";
import { DaemonRegistration } from "./registration.js";
import { ActiveDaemonRegistry } from "./registry.js";

const ORGANIZATION_ID = "org-acme";
const DAEMON_ID = "11111111-1111-4111-8111-111111111111";
const listingSchema = z.object({
  daemons: z.array(z.object({ id: z.string() })),
  grants: z.array(z.object({ memberId: z.string(), role: z.string() })),
  canManage: z.boolean(),
});

describe("daemon member access", () => {
  it("shows members only the daemon spaces granted to them", async () => {
    const database = createMemoryDatabase({
      memberships: [
        membership("user-owner", "member-owner", "owner"),
        membership("user-analyst", "member-analyst", "member"),
      ],
    });
    await enroll(database);
    const registry = new ActiveDaemonRegistry(database);
    const owner = new DaemonRegistration({
      database,
      activeDaemons: registry,
      access: browserAccess("user-owner"),
    });
    const analyst = new DaemonRegistration({
      database,
      activeDaemons: registry,
      access: browserAccess("user-analyst"),
    });

    assert.deepEqual((await listing(analyst)).daemons, []);
    const granted = await owner.grantAccess(
      request("POST", { memberId: "member-analyst", role: "operator" }),
      DAEMON_ID,
    );
    assert.equal(granted.status, 200);

    const visible = await listing(analyst);
    assert.equal(visible.canManage, false);
    assert.deepEqual(
      visible.daemons.map((daemon) => daemon.id),
      [DAEMON_ID],
    );
    assert.deepEqual(
      visible.grants.map((grant) => ({ memberId: grant.memberId, role: grant.role })),
      [{ memberId: "member-analyst", role: "operator" }],
    );

    const revoked = await owner.revokeAccess(
      request("POST", { memberId: "member-analyst" }),
      DAEMON_ID,
    );
    assert.equal(revoked.status, 204);
    assert.deepEqual((await listing(analyst)).daemons, []);
  });

  it("rejects a member outside the daemon organization", async () => {
    const database = createMemoryDatabase({
      memberships: [
        membership("user-owner", "member-owner", "owner"),
        {
          ...membership("user-other", "member-other", "member"),
          organizationId: "org-other",
          organizationName: "Other",
          organizationSlug: "other",
        },
      ],
    });
    await enroll(database);
    const owner = new DaemonRegistration({
      database,
      activeDaemons: new ActiveDaemonRegistry(database),
      access: browserAccess("user-owner"),
    });

    const response = await owner.grantAccess(
      request("POST", { memberId: "member-other", role: "viewer" }),
      DAEMON_ID,
    );
    assert.equal(response.status, 404);
    assert.deepEqual((await listing(owner)).grants, []);
  });
});

function membership(userId: string, membershipId: string, role: "owner" | "member") {
  return {
    userId,
    organizationId: ORGANIZATION_ID,
    organizationName: "Acme",
    organizationSlug: "acme",
    membershipId,
    role,
  } as const;
}

function browserAccess(userId: string): BrowserOrganizationAccess {
  return {
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: `session-${userId}`, activeOrganizationId: ORGANIZATION_ID },
        account: { id: userId, name: userId, email: `${userId}@example.test` },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
  };
}

async function enroll(database: ReturnType<typeof createMemoryDatabase>) {
  const verifier = `verifier-${randomUUID()}`;
  await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier,
    organizationId: ORGANIZATION_ID,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    consumedAt: null,
  });
  await database.enrollDaemon({
    tokenVerifier: verifier,
    daemonId: DAEMON_ID,
    idempotencyKey: randomUUID(),
    suggestedSlug: "research",
    serverId: "server-test",
    daemonPublicKey: "public-key",
    credentialVerifier: "credential-verifier",
    scopes: ["hub.execution.*"],
    now: new Date("2026-08-30T00:00:00.000Z"),
  });
}

function request(method: "GET" | "POST", body?: unknown): Request {
  const url = "https://hub.test/organization/daemons?organizationSlug=acme";
  if (method === "GET") return new Request(url);
  if (body === undefined) throw new Error("POST test request body is required");
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listing(registration: DaemonRegistration): Promise<{
  daemons: { id: string }[];
  grants: { memberId: string; role: string }[];
  canManage: boolean;
}> {
  const response = await registration.list(request("GET"));
  assert.equal(response.status, 200);
  return listingSchema.parse(await response.json());
}
