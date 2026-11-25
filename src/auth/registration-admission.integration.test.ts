import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPostgresQueryRuntime } from "../db/test-utils/runtime.js";
import {
  createDatabase,
  testDatabaseLocks,
  testDatabaseRuntime,
} from "../db/test-utils/runtime.js";
import { createAuthServer, type AuthServer } from "./server.js";
import { composeEntitlements } from "./entitlements.js";
import type { SocialSignIn } from "./social-sign-in.js";
import { z } from "zod";

describe("registration policy boundary", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("closes both raw and server-function signup when registration is disabled", async () => {
    const { auth, url } = await startAuth("disabled");
    const raw = await rawSignUp(auth, "closed@example.test");
    assert.equal(raw.status, 403);
    assert.deepEqual(await raw.json(), { error: "registration_closed" });
    await assert.rejects(
      auth.signUpEmail!(
        { name: "Closed", email: "closed-function@example.test", password: "long-password-123" },
        originHeaders(),
      ),
    );
    assert.equal(await userCount(url), 0);
    await auth.close();
  }, 120_000);

  it("rejects form-encoded raw signup before Better Auth in closed modes", async () => {
    const disabled = await startAuth("disabled");
    const disabledForm = await rawFormSignUp(disabled.auth, "form-disabled@example.test");
    assert.equal(disabledForm.status, 400);
    assert.equal(await userCount(disabled.url), 0);
    await disabled.auth.close();

    const inviteOnly = await startAuth("invite_only");
    const inviteForm = await rawFormSignUp(inviteOnly.auth, "form-invite@example.test");
    assert.equal(inviteForm.status, 400);
    assert.equal(await userCount(inviteOnly.url), 0);
    await inviteOnly.auth.close();
  }, 120_000);

  it("requires the invitation capability and admits both entry points only for a live email match", async () => {
    const { auth, url } = await startAuth("invite_only");
    const invitation = await seedInvitation(url, "invited@example.test", "pending");
    assert.equal((await rawSignUp(auth, "uninvited@example.test", invitation)).status, 403);
    assert.equal((await rawSignUp(auth, "invited@example.test", "wrong-id")).status, 403);
    const admitted = await rawSignUp(auth, "invited@example.test", invitation);
    assert.equal(admitted.status, 200);
    const secondInvitation = await seedInvitation(url, "function@example.test", "pending");
    await auth.signUpEmail!(
      { name: "Function", email: "function@example.test", password: "long-password-123" },
      originHeaders(),
      secondInvitation,
    );
    assert.equal(await userCount(url), 4);
    await auth.close();
  }, 120_000);

  it("rejects expired, canceled, and reused invitation credentials", async () => {
    const { auth, url } = await startAuth("invite_only");
    const expired = await seedInvitation(url, "expired@example.test", "pending", true);
    const canceled = await seedInvitation(url, "canceled@example.test", "canceled");
    assert.equal((await rawSignUp(auth, "expired@example.test", expired)).status, 403);
    assert.equal((await rawSignUp(auth, "canceled@example.test", canceled)).status, 403);
    const reused = await seedInvitation(url, "reused@example.test", "pending");
    assert.equal((await rawSignUp(auth, "reused@example.test", reused)).status, 200);
    assert.equal((await rawSignUp(auth, "reused@example.test", reused)).status, 403);
    await auth.close();
  }, 120_000);

  it("serializes concurrent signups for one invitation at the public boundary", async () => {
    const { auth, url } = await startAuth("invite_only");
    const invitation = await seedInvitation(url, "racing@example.test", "pending");
    const responses = await Promise.all([
      rawSignUp(auth, "racing@example.test", invitation),
      rawSignUp(auth, "racing@example.test", invitation),
    ]);
    assert.deepEqual(
      responses.map(({ status }) => status).sort((left, right) => left - right),
      [200, 403],
    );
    assert.equal(await userCount(url), 2);
    await auth.close();
  }, 120_000);

  it("admits raw and server-function signup in open mode", async () => {
    const { auth } = await startAuth("open");
    assert.equal((await rawSignUp(auth, "raw-open@example.test")).status, 200);
    await auth.signUpEmail!(
      { name: "Open", email: "function-open@example.test", password: "long-password-123" },
      originHeaders(),
    );
    await auth.close();
  }, 120_000);

  it("admits Google sign-up in open mode and links an existing account only once its email is verified", async () => {
    const { auth, url } = await startAuth("open", SOCIAL_SIGN_IN);
    assert.equal((await googleSignIn(auth, "new-google@example.test")).status, 200);
    assert.equal((await googleSignIn(auth, "new-google@example.test")).status, 200);
    assert.equal(await userCount(url), 1);

    assert.equal((await rawSignUp(auth, "password@example.test")).status, 200);
    const unverified = await googleSignIn(auth, "password@example.test");
    assert.equal(unverified.status, 401);
    assert.equal(await failureMessage(unverified), "account not linked");
    await verifyEmail(url, "password@example.test");
    assert.equal((await googleSignIn(auth, "password@example.test")).status, 200);
    assert.deepEqual(await accountProviders(url, "password@example.test"), [
      "credential",
      "google",
    ]);
    assert.equal(await userCount(url), 2);
    await auth.close();
  }, 120_000);

  it("refuses new social accounts when registration is disabled and still signs existing people in", async () => {
    const { auth, url } = await startAuth("disabled", SOCIAL_SIGN_IN);
    const closed = await googleSignIn(auth, "stranger@example.test");
    assert.equal(closed.status, 401);
    assert.equal(await failureMessage(closed), "registration closed");
    assert.equal(await userCount(url), 0);

    await seedUser(url, "existing@example.test");
    assert.equal((await googleSignIn(auth, "existing@example.test")).status, 200);
    assert.deepEqual(await accountProviders(url, "existing@example.test"), ["google"]);
    await auth.close();
  }, 120_000);

  it("admits a social sign-up on an invite-only Hub only through a live invitation for that email", async () => {
    const { auth, url } = await startAuth("invite_only", SOCIAL_SIGN_IN);
    const invitation = await seedInvitation(url, "invited-google@example.test", "pending");
    const returnPath = `/?invitation=${invitation}`;
    assert.equal((await googleSignIn(auth, "invited-google@example.test")).status, 401);
    assert.equal((await googleSignIn(auth, "other@example.test", returnPath)).status, 401);
    assert.equal(
      (await googleSignIn(auth, "invited-google@example.test", "/?invitation=x")).status,
      401,
    );
    assert.equal(await userCount(url), 1);
    assert.equal((await googleSignIn(auth, "invited-google@example.test", returnPath)).status, 200);
    assert.equal(await userCount(url), 2);
    await auth.close();
  }, 120_000);

  it("sends a social sign-in back to the same-origin page it started from", async () => {
    const { auth } = await startAuth("open", SOCIAL_SIGN_IN);
    const returnPath = "/cli-login?code=ABCD-EFGH";
    const started = await socialSignIn(auth, "github", returnPath);
    assert.equal(started.status, 200);
    const authorization = new URL(z.object({ url: z.string() }).parse(await started.json()).url);
    assert.equal(authorization.origin, "https://github.com");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      "http://localhost:3000/api/auth/callback/github",
    );
    const callback = new URL("http://localhost:3000/api/auth/callback/github");
    callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
    callback.searchParams.set("error", "access_denied");
    const returned = await auth.handle(
      new Request(callback, { headers: { cookie: requestCookies(started) } }),
    );
    assert.equal(returned.status, 302);
    assert.equal(returned.headers.get("location"), `${returnPath}&error=access_denied`);

    for (const elsewhere of [
      "https://elsewhere.example/",
      "//elsewhere.example/",
      "/\\elsewhere.example/",
      "javascript:alert(1)",
    ]) {
      assert.equal((await socialSignIn(auth, "github", elsewhere)).status, 400, elsewhere);
    }
    await auth.close();
  }, 120_000);

  it("keeps social routes closed for providers this Hub has not configured", async () => {
    const closed = await startAuth("open");
    assert.equal((await socialSignIn(closed.auth, "google", "/")).status, 404);
    for (const provider of ["google", "github"]) {
      const callback = await closed.auth.handle(
        new Request(`http://localhost:3000/api/auth/callback/${provider}?state=x&code=y`),
      );
      assert.equal(callback.status, 404);
    }
    await closed.auth.close();

    const githubOnly = await startAuth("open", { github: SOCIAL_SIGN_IN.github! });
    assert.equal((await socialSignIn(githubOnly.auth, "google", "/")).status, 404);
    const googleCallback = await githubOnly.auth.handle(
      new Request("http://localhost:3000/api/auth/callback/google?state=x&code=y"),
    );
    assert.equal(googleCallback.status, 404);
    await githubOnly.auth.close();
  }, 120_000);

  async function startAuth(
    registrationMode: "open" | "invite_only" | "disabled",
    providers?: SocialSignIn,
  ) {
    const url = await isolatedDatabaseUrl(postgres.getConnectionUri(), registrationMode);
    const database = await createDatabase(url);
    const entitlements = composeEntitlements(database, testDatabaseRuntime(database));
    const auth = createAuthServer({
      database: testDatabaseRuntime(database),
      locks: testDatabaseLocks(database),
      entitlements: entitlements.service,
      secret: "registration-policy-secret-at-least-32-characters",
      baseURL: "http://localhost:3000",
      policy: { registrationMode, organizationCreation: "disabled", bootstrap: undefined },
      ...(providers === undefined ? {} : { socialSignIn: providers }),
    });
    return {
      auth: {
        ...auth,
        close: async () => {
          await auth.close();
          await entitlements.close();
          await database.close();
        },
      },
      url,
    };
  }
});

async function rawSignUp(auth: AuthServer, email: string, invitation?: string): Promise<Response> {
  const url = new URL("http://localhost:3000/api/auth/sign-up/email");
  if (invitation !== undefined) url.searchParams.set("invitation", invitation);
  return auth.handle(
    new Request(url, {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ name: "Policy User", email, password: "long-password-123" }),
    }),
  );
}

/**
 * Google and GitHub both configured. Google signs in through its ID-token flow, which never
 * leaves the process: the token stands for the identity it asserts.
 */
const SOCIAL_SIGN_IN: SocialSignIn = {
  google: {
    clientId: "google-client",
    clientSecret: "google-secret",
    verifyIdToken: () => Promise.resolve(true),
    getUserInfo: (tokens) =>
      Promise.resolve({ user: googleIdentity.parse(JSON.parse(tokens.idToken ?? "{}")), data: {} }),
  },
  github: { clientId: "github-client", clientSecret: "github-secret" },
};

const googleIdentity = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
});
type GoogleIdentity = z.infer<typeof googleIdentity>;

async function failureMessage(response: Response): Promise<string> {
  return z.object({ message: z.string() }).parse(await response.json()).message;
}

async function googleSignIn(auth: AuthServer, email: string, returnPath = "/"): Promise<Response> {
  const identity: GoogleIdentity = {
    id: `google-${email}`,
    email,
    name: "Google User",
    emailVerified: true,
  };
  return auth.handle(
    new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: returnPath,
        idToken: { token: JSON.stringify(identity) },
      }),
    }),
  );
}

async function socialSignIn(
  auth: AuthServer,
  provider: string,
  returnPath: string,
): Promise<Response> {
  return auth.handle(
    new Request("http://localhost:3000/api/auth/sign-in/social", {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        callbackURL: returnPath,
        errorCallbackURL: returnPath,
        disableRedirect: true,
      }),
    }),
  );
}

function requestCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function seedUser(url: string, email: string): Promise<void> {
  const client = await createPostgresQueryRuntime(url);
  await client.query(
    `insert into "user" (id, name, email, email_verified) values ($1, 'Existing', $2, true)`,
    [randomUUID(), email],
  );
  await client.close();
}

async function verifyEmail(url: string, email: string): Promise<void> {
  const client = await createPostgresQueryRuntime(url);
  await client.query(`update "user" set email_verified = true where email = $1`, [email]);
  await client.close();
}

async function accountProviders(url: string, email: string): Promise<string[]> {
  const client = await createPostgresQueryRuntime(url);
  const result = await client.query<{ provider_id: string }>(
    `select account.provider_id from account
     join "user" on "user".id = account.user_id
     where "user".email = $1 order by account.provider_id`,
    [email],
  );
  await client.close();
  return result.rows.map((row) => row.provider_id);
}

async function rawFormSignUp(auth: AuthServer, email: string): Promise<Response> {
  return auth.handle(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        name: "Form User",
        email,
        password: "long-password-123",
      }),
    }),
  );
}

async function seedInvitation(
  url: string,
  email: string,
  status: "pending" | "canceled",
  expired = false,
): Promise<string> {
  const client = await createPostgresQueryRuntime(url);

  const id = randomUUID();
  const organizationId = `org-${id}`;
  const userId = `user-${id}`;
  await client.query(`insert into organization (id, name, slug) values ($1, 'Invites', $1)`, [
    organizationId,
  ]);
  await client.query(
    `insert into "user" (id, name, email, email_verified) values ($1, 'Inviter', $2, true)`,
    [userId, `inviter-${id}@example.test`],
  );
  await client.query(
    `insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [`member-${id}`, organizationId, userId],
  );
  await client.query(
    `insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
     values ($1, $2, $3, 'member', $4, $5, $6)`,
    [
      id,
      organizationId,
      email,
      status,
      expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 86_400_000),
      userId,
    ],
  );
  await client.close();
  return id;
}

async function userCount(url: string): Promise<number> {
  const client = await createPostgresQueryRuntime(url);

  const result = await client.query<{ count: number }>(
    `select count(*)::integer as count from "user"`,
  );
  await client.close();
  return result.rows[0]!.count;
}

async function isolatedDatabaseUrl(baseUrl: string, name: string): Promise<string> {
  const base = new URL(baseUrl);
  base.pathname = "/postgres";
  const admin = await createPostgresQueryRuntime(base.toString());

  const databaseName = `${name}_${randomUUID().slice(0, 8)}`;
  await admin.query(`create database "${databaseName}"`);
  await admin.close();
  base.pathname = `/${databaseName}`;
  return base.toString();
}

function originHeaders(): Headers {
  return new Headers({ origin: "http://localhost:3000" });
}
