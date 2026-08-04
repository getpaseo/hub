import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { InstanceAuthPolicy } from "./instance-policy.js";
import { normalizeEmail } from "./instance-policy.js";

const signupEmailBody = z.object({ email: z.string().email() }).passthrough();
const INVITATION_LOCK_PREFIX = "paseo:invitation:";

export function invitationLockName(invitationId: string): string {
  return `${INVITATION_LOCK_PREFIX}${invitationId}`;
}

export class RegistrationAdmission {
  constructor(
    private readonly pool: Pool,
    private readonly policy: InstanceAuthPolicy,
  ) {}

  async handleSignUp(
    request: Request,
    action: (request: Request) => Promise<Response>,
  ): Promise<Response> {
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return Response.json({ error: "invalid_signup" }, { status: 400 });
    }
    const body = signupEmailBody.safeParse(
      await request
        .clone()
        .json()
        .catch(() => undefined),
    );
    if (!body.success) return Response.json({ error: "invalid_signup" }, { status: 400 });
    const invitationId =
      new URL(request.url).searchParams.get("invitation") ??
      (typeof body.data["invitation"] === "string" ? body.data["invitation"] : undefined);
    return this.withAdmission(body.data.email, invitationId, async () => {
      const sanitizedBody = Object.fromEntries(
        Object.entries(body.data).filter(([key]) => key !== "invitation"),
      );
      return action(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(sanitizedBody),
        }),
      );
    });
  }

  async withAdmission<T>(
    email: string,
    invitationId: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.policy.registrationMode === "open") return action();
    if (invitationId === undefined) throw new RegistrationAdmissionError();
    const client = await this.pool.connect();
    const lockKey = invitationLockName(invitationId);
    try {
      await client.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
      if (!(await this.isAdmittedWithClient(client, email, invitationId))) {
        throw new RegistrationAdmissionError();
      }
      const existingUser = await client.query(
        `select 1 from "user" where lower(email) = $1 limit 1`,
        [normalizeEmail(email)],
      );
      if (existingUser.rowCount !== 0) throw new RegistrationAdmissionError();
      return await action();
    } finally {
      await client
        .query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }

  async lockInvitation(client: PoolClient, invitationId: string): Promise<void> {
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      invitationLockName(invitationId),
    ]);
  }

  private async isAdmittedWithClient(
    client: PoolClient,
    email: string,
    invitationId: string,
  ): Promise<boolean> {
    if (this.policy.registrationMode === "disabled") return false;
    const result = await client.query(
      `select 1 from invitation
       where id = $1 and status = 'pending' and expires_at > now()
         and lower(email) = $2`,
      [invitationId, normalizeEmail(email)],
    );
    return result.rowCount === 1;
  }
}

export class RegistrationAdmissionError extends Error {
  constructor() {
    super("registration is not available");
    this.name = "RegistrationAdmissionError";
  }
}
