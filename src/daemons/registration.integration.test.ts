import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { z } from "zod";
import type { OrganizationAccessValue } from "../auth/organization-access.js";
import { createAuthServer, type AuthServer } from "../auth/server.js";
import type { InstanceAuthPolicy } from "../auth/instance-policy.js";
import { createHubApplication, type HubOperations, type HubRuntime } from "../app.js";
import { createDatabase } from "../db/pg.js";
import type { Database } from "../db/types.js";
import { INTERNAL_CLIENT_ADDRESS_HEADER } from "../http/client-address.js";
import { ActiveDaemonRegistry } from "./registry.js";
import { DaemonRegistration, enrollDaemon } from "./registration.js";

const startSchema = z.object({ deviceCode: z.string(), userCode: z.string() });
const pollSchema = z.object({
  status: z.string(),
  enrollmentToken: z.string().optional(),
});
const detailedStartSchema = z
  .object({
    deviceCode: z.string().min(32),
    userCode: z.string().min(1),
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url(),
    expiresAt: z.string().datetime(),
    interval: z.literal(5),
  })
  .strict();

describe("daemon registration PostgreSQL authority", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;
  let journey: PostgresRegistration;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(30_000)
      .start();
    database = await createDatabase(postgres.getConnectionUri());
    journey = new PostgresRegistration(database, postgres.getConnectionUri());
    await journey.seedAuthority();
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  it("allows only one concurrent terminal decision", async () => {
    const request = await journey.request("Decision Mac");

    const statuses = await journey.decideConcurrently(request.userCode);

    assert.deepEqual(
      statuses.sort((left, right) => left - right),
      [200, 404],
    );
  });

  it("rejects approval after the resolved membership becomes stale", async () => {
    const request = await journey.request("Stale Mac");

    await journey.removeMembership();
    const response = await journey.approve(request.userCode, "Stale Mac");
    await journey.restoreMembership();

    assert.equal(response.status, 403);
  });

  it("returns one retry-safe token and permits only one enrollment winner", async () => {
    const request = await journey.request("Studio Mac");
    assert.equal((await journey.approve(request.userCode, "Build Studio")).status, 200);

    const tokens = await journey.pollWithResponseLoss(request.deviceCode);
    const enrollments = await journey.enrollConcurrently(tokens[0]);

    assert.equal(tokens[0], tokens[1]);
    assert.deepEqual(
      enrollments.sort((left, right) => left - right),
      [200, 401],
    );
    assert.deepEqual(await journey.visibleDaemonNames("acme"), ["build-studio"]);
    assert.deepEqual(await journey.visibleDaemonNames("orbit"), []);
    const daemonId = await journey.onlyDaemonId();
    const rename = await journey.foreign().rename(daemonId, "Foreign rename");
    const revoke = await journey.foreign().revoke(daemonId);
    assert.equal(rename.status, 404);
    assert.equal(revoke.status, 404);
    assert.deepEqual(await journey.visibleDaemonNames("acme"), ["build-studio"]);
  });
});

describe("daemon registration authenticated application boundary", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;
  let auth: AuthServer;
  let hub: HubRuntime;
  let boundary: RegistrationBoundary;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine")
      .withStartupTimeout(30_000)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    database = await createDatabase(databaseUrl);
    auth = createAuthServer({
      databaseUrl,
      baseURL: "https://hub.paseo.test",
      secret: "phase-two-registration-auth-secret-at-least-32-characters",
      policy: {
        registrationMode: "open",
        organizationCreation: "open",
        bootstrap: undefined,
      } satisfies InstanceAuthPolicy,
    });
    const application = createHubApplication({
      database,
      browserOrganizationAccess: auth,
      publicBaseUrl: "https://hub.paseo.test",
    });
    hub = application.hub;
    boundary = new RegistrationBoundary(application.operations, database, databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await hub.stop();
    await auth.close();
    await database.close();
    await postgres.stop();
  }, 120_000);

  it("issues the exact public contract without tenant or secret spill", async () => {
    const team = await boundary.createTeam(auth, "contract");

    const request = await boundary.request("Contract Mac");
    const inspection = await team.owner.inspect(request.userCode);

    assert.equal(request.interval, 5);
    const expiresInMs = Date.parse(request.expiresAt) - Date.now();
    assert.ok(expiresInMs > 590_000);
    assert.ok(expiresInMs <= 600_000);
    assert.notEqual(request.deviceCode, request.userCode);
    assert.equal(JSON.stringify(request).includes(team.organizationId), false);
    assert.equal(JSON.stringify(await inspection.json()).includes(request.deviceCode), false);
  });

  it("uses current owner and admin authority while denying members and stale sessions", async () => {
    const team = await boundary.createTeam(auth, "authority");
    const adminRequest = await boundary.request("Admin Mac");
    const memberRequest = await boundary.request("Member Mac");
    const ownerRequest = await boundary.request("Owner Mac");
    const staleSessionRequest = await boundary.request("Stale session Mac");

    const admin = await team.admin.approve(adminRequest.userCode, "Admin Studio");
    const member = await team.member.approve(memberRequest.userCode, "Forbidden Studio");
    const owner = await team.owner.deny(ownerRequest.userCode);
    const replay = await team.owner.deny(ownerRequest.userCode);
    await boundary.expireSession(team.admin.email);
    const staleSession = await team.admin.approve(
      staleSessionRequest.userCode,
      "Expired session Studio",
    );

    assert.equal(admin.status, 200);
    assert.equal(member.status, 403);
    assert.equal(owner.status, 200);
    assert.equal(replay.status, 404);
    assert.equal(staleSession.status, 401);
  });

  it("commits only the organization shown to the approver", async () => {
    const team = await boundary.createTeam(auth, "consent");
    const request = await boundary.request("Consent Mac");
    const shownOrganizationId = await team.owner.inspectOrganization(request.userCode);
    await team.owner.createOrganization("Switched organization");

    const decision = await team.owner.approve(
      request.userCode,
      "Consent Studio",
      shownOrganizationId,
    );

    assert.equal(shownOrganizationId, team.organizationId);
    assert.equal(decision.status, 403);
    assert.equal(await boundary.pollStatus(request.deviceCode), "pending");
  });

  it("fails closed when a session or membership changes during approval", async () => {
    const team = await boundary.createTeam(auth, "concurrent-authority");
    const sessionRequest = await boundary.request("Session race Mac");
    const membershipRequest = await boundary.request("Membership race Mac");

    const staleSession = await boundary.removeSessionDuringApproval(
      team.owner,
      sessionRequest.userCode,
      team.organizationId,
    );
    const staleMembership = await boundary.downgradeMembershipDuringApproval(
      team.admin,
      membershipRequest.userCode,
      team.organizationId,
    );

    assert.equal(staleSession.status, 403);
    assert.equal(staleMembership.status, 403);
    assert.equal(await boundary.pollStatus(sessionRequest.deviceCode), "pending");
    assert.equal(await boundary.pollStatus(membershipRequest.deviceCode), "pending");
  });

  it("revalidates membership and conceals foreign and missing daemon management", async () => {
    const team = await boundary.createTeam(auth, "concealment");
    const staleMembershipRequest = await boundary.request("Stale membership Mac");
    await boundary.removeMembership(team.admin.email, team.organizationId);

    const staleMembership = await team.admin.approve(
      staleMembershipRequest.userCode,
      "Stale membership Studio",
    );
    const daemonId = await boundary.registerDaemon(team.owner, "Owned Studio");
    await team.owner.createOrganization("Foreign organization");

    assert.equal(staleMembership.status, 403);
    assert.deepEqual(await team.owner.daemonNames(), []);
    assert.equal((await team.owner.rename(daemonId, "Foreign rename")).status, 404);
    assert.equal((await team.owner.revoke(daemonId)).status, 404);
    assert.equal((await team.owner.rename(randomUUID(), "Missing rename")).status, 404);
  });

  it("serializes the PostgreSQL public issuance limit", async () => {
    const statuses = await boundary.requestConcurrently(6);

    assert.deepEqual(
      statuses.sort((left, right) => left - right),
      [201, 201, 201, 201, 201, 429],
    );
  });
});

class RegistrationBoundary {
  private requestNumber = 1;

  constructor(
    private readonly operations: HubOperations,
    private readonly database: Database,
    private readonly databaseUrl: string,
  ) {}

  async createTeam(auth: AuthServer, label: string) {
    const owner = await RegistrationAccount.signUp(
      auth,
      this.operations,
      this.database,
      `${label}-owner`,
    );
    const organizationId = await owner.createOrganization(`${label} organization`);
    const admin = await RegistrationAccount.signUp(
      auth,
      this.operations,
      this.database,
      `${label}-admin`,
    );
    const member = await RegistrationAccount.signUp(
      auth,
      this.operations,
      this.database,
      `${label}-member`,
    );
    await this.query(
      `insert into member (id, organization_id, user_id, role)
       select $1, $2, id, $3 from "user" where email = $4`,
      [randomUUID(), organizationId, "admin", admin.email],
    );
    await this.query(
      `insert into member (id, organization_id, user_id, role)
       select $1, $2, id, $3 from "user" where email = $4`,
      [randomUUID(), organizationId, "member", member.email],
    );
    const organizationSlug = owner.requireActiveOrganizationSlug();
    await admin.selectOrganization(organizationId, organizationSlug);
    await member.selectOrganization(organizationId, organizationSlug);
    return { owner, admin, member, organizationId };
  }

  async request(slug: string) {
    const response = await this.operations.handleDeviceAuthorizationStart(
      post(
        "/api/device-authorizations/",
        { slug },
        { [INTERNAL_CLIENT_ADDRESS_HEADER]: `2001:db8::${this.requestNumber++}` },
      ),
    );
    assert.equal(response.status, 201);
    return detailedStartSchema.parse(await response.json());
  }

  async requestConcurrently(count: number): Promise<number[]> {
    const responses = await Promise.all(
      Array.from({ length: count }, (_value, index) =>
        this.operations.handleDeviceAuthorizationStart(
          post(
            "/api/device-authorizations/",
            { slug: `Concurrent ${index}` },
            { [INTERNAL_CLIENT_ADDRESS_HEADER]: "198.51.100.42" },
          ),
        ),
      ),
    );
    return responses.map(({ status }) => status);
  }

  async registerDaemon(account: RegistrationAccount, slug: string): Promise<string> {
    const request = await this.request(slug);
    assert.equal((await account.approve(request.userCode, slug)).status, 200);
    await this.query(`update daemon_device_authorizations set next_poll_at = now()`);
    const poll = await this.operations.handleDeviceAuthorizationPoll(
      post("/api/device-authorizations/poll", { deviceCode: request.deviceCode }),
    );
    const token = pollSchema.parse(await poll.json()).enrollmentToken;
    assert.ok(token);
    const daemonId = randomUUID();
    const enrollment = await enrollDaemon(
      post(
        "/api/daemons/enroll",
        {
          daemonId,
          idempotencyKey: randomUUID(),
          serverId: "server-boundary",
          daemonPublicKey: "public-key",
          credentialVerifier: "credential-verifier",
        },
        { authorization: `Bearer ${token}` },
      ),
      account.database,
      "https://hub.paseo.test",
    );
    assert.equal(enrollment.status, 200);
    return daemonId;
  }

  async pollStatus(deviceCode: string): Promise<string> {
    await this.query(`update daemon_device_authorizations set next_poll_at = now()`);
    const response = await this.operations.handleDeviceAuthorizationPoll(
      post("/api/device-authorizations/poll", { deviceCode }),
    );
    return z.object({ status: z.string() }).parse(await response.json()).status;
  }

  removeSessionDuringApproval(
    account: RegistrationAccount,
    userCode: string,
    organizationId: string,
  ): Promise<Response> {
    return this.changeAuthorityDuringApproval(
      `select session.id from session
       join "user" on "user".id = session.user_id
       where "user".email = $1 and session.active_organization_id = $2
       for update of session`,
      `delete from session using "user"
       where session.user_id = "user".id and "user".email = $1
         and session.active_organization_id = $2`,
      account,
      userCode,
      organizationId,
    );
  }

  downgradeMembershipDuringApproval(
    account: RegistrationAccount,
    userCode: string,
    organizationId: string,
  ): Promise<Response> {
    return this.changeAuthorityDuringApproval(
      `select member.id from member
       join "user" on "user".id = member.user_id
       where "user".email = $1 and member.organization_id = $2 for update of member`,
      `update member set role = 'member' from "user"
       where member.user_id = "user".id and "user".email = $1
         and member.organization_id = $2`,
      account,
      userCode,
      organizationId,
    );
  }

  expireSession(email: string): Promise<void> {
    return this.query(
      `update session set expires_at = now() - interval '1 minute'
       from "user" where session.user_id = "user".id and "user".email = $1`,
      [email],
    );
  }

  removeMembership(email: string, organizationId: string): Promise<void> {
    return this.query(
      `delete from member using "user"
       where member.user_id = "user".id and "user".email = $1
         and member.organization_id = $2`,
      [email, organizationId],
    );
  }

  private async changeAuthorityDuringApproval(
    lock: string,
    transition: string,
    account: RegistrationAccount,
    userCode: string,
    organizationId: string,
  ): Promise<Response> {
    const blocker = new Client({ connectionString: this.databaseUrl });
    await blocker.connect();
    try {
      await blocker.query("begin");
      await blocker.query(lock, [account.email, organizationId]);
      const decision = account.approve(userCode, "Concurrent Studio", organizationId);
      await waitForAuthorityDecision(this.databaseUrl);
      await blocker.query(transition, [account.email, organizationId]);
      await blocker.query("commit");
      return await decision;
    } catch (error) {
      await blocker.query("rollback");
      throw error;
    } finally {
      await blocker.end();
    }
  }

  private async query(sql: string, values: unknown[] = []): Promise<void> {
    const client = new Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      await client.query(sql, values);
    } finally {
      await client.end();
    }
  }
}

class RegistrationAccount {
  private cookie = "";
  private activeOrganizationId: string | undefined;
  private activeOrganizationSlug: string | undefined;

  private constructor(
    private readonly auth: AuthServer,
    private readonly operations: HubOperations,
    readonly database: Database,
    readonly email: string,
  ) {}

  static async signUp(
    auth: AuthServer,
    operations: HubOperations,
    database: Database,
    label: string,
  ) {
    const email = `${label}-${randomUUID()}@example.test`;
    const account = new RegistrationAccount(auth, operations, database, email);
    const response = await account.authPost("/api/auth/sign-up/email", {
      name: label,
      email,
      password: "registration-boundary-password",
    });
    assert.equal(response.status, 200);
    account.cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    return account;
  }

  async createOrganization(name: string): Promise<string> {
    const response = await this.authPost("/api/auth/paseo/create-organization", { name });
    assert.equal(response.status, 201);
    const organization = z
      .object({ organizationId: z.string(), organizationSlug: z.string() })
      .parse(await response.json());
    const organizationId = organization.organizationId;
    this.activeOrganizationId = organizationId;
    this.activeOrganizationSlug = organization.organizationSlug;
    return organizationId;
  }

  async selectOrganization(organizationId: string, organizationSlug: string): Promise<void> {
    assert.equal(
      (await this.authPost("/api/auth/paseo/select-organization", { organizationId })).status,
      200,
    );
    this.activeOrganizationId = organizationId;
    this.activeOrganizationSlug = organizationSlug;
  }

  inspect(userCode: string): Promise<Response> {
    return this.operations.handleDeviceAuthorizationInspect(
      this.request("/api/device-authorizations/inspect", { userCode }),
    );
  }

  async inspectOrganization(userCode: string): Promise<string> {
    const response = await this.inspect(userCode);
    assert.equal(response.status, 200);
    return z.object({ organization: z.object({ id: z.string() }) }).parse(await response.json())
      .organization.id;
  }

  approve(
    userCode: string,
    slug: string,
    organizationId = this.requireActiveOrganization(),
  ): Promise<Response> {
    return this.operations.handleDeviceAuthorizationDecision(
      this.request("/api/device-authorizations/decision", {
        userCode,
        decision: "approve",
        slug,
        organizationId,
      }),
    );
  }

  deny(userCode: string): Promise<Response> {
    return this.operations.handleDeviceAuthorizationDecision(
      this.request("/api/device-authorizations/decision", { userCode, decision: "deny" }),
    );
  }

  async daemonNames(): Promise<string[]> {
    const organizationSlug = this.requireActiveOrganizationSlug();
    const response = await this.operations.handleOrganizationDaemons(
      new Request(
        `https://hub.paseo.test/api/organization/daemons/?organizationSlug=${organizationSlug}`,
        {
          headers: { cookie: this.cookie },
        },
      ),
    );
    return z
      .object({ daemons: z.array(z.object({ slug: z.string() })) })
      .parse(await response.json())
      .daemons.map(({ slug }) => slug);
  }

  rename(daemonId: string, slug: string): Promise<Response> {
    return this.operations.handleOrganizationDaemonRename(
      this.request(
        `/api/organization/daemons/${daemonId}/rename?organizationSlug=${this.requireActiveOrganizationSlug()}`,
        { slug },
      ),
      daemonId,
    );
  }

  revoke(daemonId: string): Promise<Response> {
    return this.operations.handleOrganizationDaemonRevocation(
      this.request(
        `/api/organization/daemons/${daemonId}/revoke?organizationSlug=${this.requireActiveOrganizationSlug()}`,
        {},
      ),
      daemonId,
    );
  }

  requireActiveOrganizationSlug(): string {
    if (this.activeOrganizationSlug === undefined) throw new Error("No active organization");
    return this.activeOrganizationSlug;
  }

  private requireActiveOrganization(): string {
    if (this.activeOrganizationId === undefined) throw new Error("No active organization");
    return this.activeOrganizationId;
  }

  private authPost(path: string, body: unknown): Promise<Response> {
    const request = this.request(path, body);
    if (path.startsWith("/api/auth/paseo/")) {
      assert.ok(this.auth.browserAccount !== undefined);
      return this.auth.browserAccount(request);
    }
    return this.auth.handle(request);
  }

  private request(path: string, body: unknown): Request {
    return new Request(`https://hub.paseo.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://hub.paseo.test",
        "sec-fetch-site": "same-origin",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  }
}

class PostgresRegistration {
  private readonly registry: ActiveDaemonRegistry;
  private readonly registration: DaemonRegistration;

  constructor(
    private readonly database: Database,
    private readonly databaseUrl: string,
    private readonly organizationAccess: OrganizationAccessValue = access("acme"),
  ) {
    this.registry = new ActiveDaemonRegistry(database);
    this.registration = new DaemonRegistration({
      database,
      activeDaemons: this.registry,
      publicBaseUrl: "https://hub.paseo.test",
      access: {
        resolveOrganizationAccess: async () => this.organizationAccess,
        resolveAccount: async () => ({
          session: { ...this.organizationAccess.session, activeOrganizationId: null },
          account: this.organizationAccess.account,
        }),
        rejectCookieMutation: () => undefined,
      },
    });
  }

  async seedAuthority(): Promise<void> {
    await this.query(`
      insert into "user" (id, name, email) values ('alice', 'Alice', 'alice@example.com');
      insert into organization (id, name, slug) values
        ('acme', 'Acme', 'acme'),
        ('orbit', 'Orbit', 'orbit');
      insert into member (id, organization_id, user_id, role)
        values ('member-acme', 'acme', 'alice', 'owner');
      insert into session (id, token, expires_at, user_id, active_organization_id)
        values ('session-acme', 'session-token', now() + interval '1 hour', 'alice', 'acme');
    `);
  }

  async request(slug: string) {
    const response = await this.registration.start(post("/api/device-authorizations/", { slug }));
    assert.equal(response.status, 201);
    return startSchema.parse(await response.json());
  }

  approve(userCode: string, slug: string): Promise<Response> {
    return this.registration.decide(
      post("/api/device-authorizations/decision", {
        userCode,
        slug,
        organizationId: this.organizationAccess.organization.id,
        decision: "approve",
      }),
    );
  }

  async decideConcurrently(userCode: string): Promise<number[]> {
    const responses = await Promise.all([
      this.approve(userCode, "Approved name"),
      this.registration.decide(
        post("/api/device-authorizations/decision", {
          userCode,
          decision: "deny",
        }),
      ),
    ]);
    return responses.map((response) => response.status);
  }

  async pollWithResponseLoss(deviceCode: string): Promise<[string, string]> {
    const first = await this.pollNow(deviceCode);
    const second = await this.pollNow(deviceCode);
    assert.equal(first.status, "approved");
    assert.equal(second.status, "approved");
    assert.ok(first.enrollmentToken);
    assert.ok(second.enrollmentToken);
    return [first.enrollmentToken, second.enrollmentToken];
  }

  async enrollConcurrently(token: string): Promise<number[]> {
    const responses = await Promise.all([
      this.enroll(token, randomUUID()),
      this.enroll(token, randomUUID()),
    ]);
    return responses.map((response) => response.status);
  }

  rename(daemonId: string, slug: string): Promise<Response> {
    return this.registration.rename(
      post(
        `/api/organization/daemons/${daemonId}/rename?organizationSlug=${this.organizationAccess.organization.id}`,
        { slug },
      ),
      daemonId,
    );
  }

  revoke(daemonId: string): Promise<Response> {
    return this.registration.revoke(
      post(
        `/api/organization/daemons/${daemonId}/revoke?organizationSlug=${this.organizationAccess.organization.id}`,
        {},
      ),
      daemonId,
    );
  }

  foreign(): PostgresRegistration {
    return new PostgresRegistration(this.database, this.databaseUrl, access("orbit"));
  }

  async removeMembership(): Promise<void> {
    await this.query(`delete from member where id = 'member-acme'`);
  }

  async restoreMembership(): Promise<void> {
    await this.query(
      `insert into member (id, organization_id, user_id, role)
       values ('member-acme', 'acme', 'alice', 'owner')`,
    );
  }

  async visibleDaemonNames(organizationId: string): Promise<string[]> {
    return (await this.database.listDaemonsForOrganization(organizationId)).map(
      (daemon) => daemon.slug,
    );
  }

  async onlyDaemonId(): Promise<string> {
    const daemons = await this.database.listDaemonsForOrganization("acme");
    assert.equal(daemons.length, 1);
    return daemons[0]!.id;
  }

  private async pollNow(deviceCode: string) {
    await this.query(
      `update daemon_device_authorizations set next_poll_at = now()
       where device_verifier is not null`,
    );
    const response = await this.registration.poll(
      post("/api/device-authorizations/poll", { deviceCode }),
    );
    return pollSchema.parse(await response.json());
  }

  private enroll(token: string, daemonId: string): Promise<Response> {
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
    );
  }

  private async query(sql: string): Promise<void> {
    const client = new Client({ connectionString: this.databaseUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }
}

function access(organizationId: "acme" | "orbit"): OrganizationAccessValue {
  return {
    session: { id: "session-acme" },
    account: { id: "alice", name: "Alice", email: "alice@example.com" },
    organization: { id: organizationId, name: organizationId === "acme" ? "Acme" : "Orbit" },
    membership: { id: "member-acme", role: "owner" },
    capabilities: { view: true, manageMembers: true, manageOwners: true, manageResources: true },
  };
}

async function waitForAuthorityDecision(databaseUrl: string): Promise<void> {
  const observer = new Client({ connectionString: databaseUrl });
  await observer.connect();
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await observer.query<{ blocked: boolean }>(
        `select exists (
           select 1 from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query like '%for update of session, member%'
         ) as blocked`,
      );
      if (result.rows[0]?.blocked === true) return;
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
  } finally {
    await observer.end();
  }
  throw new Error("Authorization decision did not reach the authority lock");
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://hub.paseo.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
