import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createDatabase } from "../db/pg.js";
import { composeEntitlements } from "./entitlements.js";
import { createAuthServer } from "./server.js";
import type { AccountMailer } from "./account-emails.js";
import { z } from "zod";
import type { AuthServer } from "./server.js";
import { isAPIError } from "better-auth/api";

const ORIGIN = "http://localhost:3000";

describe("verified account recovery boundary", () => {
  it("withholds a session until email verification and resets a password without enumeration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-account-recovery-"));
    const { runtime, locks } = await embeddedDatabaseRuntime(directory);
    await runtime.migrate();
    const database = createDatabase(runtime, locks);
    const entitlements = composeEntitlements(database, runtime);
    const mailer = new RecordingAccountMailer();
    const auth = createAuthServer({
      database: runtime,
      locks,
      entitlements: entitlements.service,
      secret: "account-recovery-secret-at-least-32-characters",
      baseURL: ORIGIN,
      policy: { registrationMode: "open", organizationCreation: "open", bootstrap: undefined },
      accountMailer: mailer,
    });
    try {
      const signup = await post(auth, "/api/auth/sign-up/email", {
        name: "Verified User",
        email: "verified@example.test",
        password: "original-password",
        callbackURL: `${ORIGIN}/?auth=email-verification`,
      });
      assert.equal(signup.status, 200);
      assert.equal(signup.headers.get("set-cookie"), null);
      assert.equal(mailer.verifications.length, 1);

      const unverifiedSignIn = await post(auth, "/api/auth/sign-in/email", {
        email: "verified@example.test",
        password: "original-password",
      });
      assert.equal(unverifiedSignIn.status, 403);
      assert.equal(errorResponse.parse(await unverifiedSignIn.json()).code, "EMAIL_NOT_VERIFIED");

      const verification = await auth.handle(new Request(mailer.verifications[0]!.url));
      assert.equal(verification.status, 302);
      assert.equal(verification.headers.get("location"), `${ORIGIN}/?auth=email-verification`);
      const verifiedCookie = requireSessionCookie(verification);
      const session = await auth.handle(
        new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: verifiedCookie } }),
      );
      assert.equal(session.status, 200);
      assert.equal(
        z.object({ user: z.object({ email: z.string() }) }).parse(await session.json()).user.email,
        "verified@example.test",
      );

      await auth.requestPasswordReset!("verified@example.test", originHeaders());
      await auth.requestPasswordReset!("missing@example.test", originHeaders());
      assert.equal(mailer.passwordResets.length, 1);

      const resetCallback = await auth.handle(new Request(mailer.passwordResets[0]!.url));
      assert.equal(resetCallback.status, 302);
      const resetLocation = new URL(assertNotNull(resetCallback.headers.get("location")));
      assert.equal(resetLocation.origin, ORIGIN);
      assert.equal(resetLocation.searchParams.get("auth"), "password-reset");
      const token = assertNotNull(resetLocation.searchParams.get("token"));
      await auth.resetPassword!({ token, newPassword: "replacement-password" }, originHeaders());

      const revoked = await auth.handle(
        new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie: verifiedCookie } }),
      );
      assert.equal(await revoked.text(), "null");
      assert.equal(
        (
          await post(auth, "/api/auth/sign-in/email", {
            email: "verified@example.test",
            password: "original-password",
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await post(auth, "/api/auth/sign-in/email", {
            email: "verified@example.test",
            password: "replacement-password",
          })
        ).status,
        200,
      );

      await assert.rejects(
        auth.resetPassword!({ token, newPassword: "another-password" }, originHeaders()),
        (error: unknown) => isAPIError(error) && error.body?.code === "INVALID_TOKEN",
      );
    } finally {
      await auth.close();
      await entitlements.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});

class RecordingAccountMailer implements AccountMailer {
  readonly verifications: { url: string }[] = [];
  readonly passwordResets: { url: string }[] = [];

  sendVerificationEmail(email: { url: string }): Promise<void> {
    this.verifications.push({ url: email.url });
    return Promise.resolve();
  }

  sendPasswordReset(email: { url: string }): Promise<void> {
    this.passwordResets.push({ url: email.url });
    return Promise.resolve();
  }
}

async function post(
  auth: AuthServer,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return auth.handle(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const errorResponse = z.object({ code: z.string() });

function originHeaders(): Headers {
  return new Headers({ origin: ORIGIN });
}

function requireSessionCookie(response: Response): string {
  const cookie = assertNotNull(response.headers.get("set-cookie"));
  return assertNotNull(cookie.match(/better-auth\.session_token=[^;]+/u)?.[0]);
}

function assertNotNull<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}
