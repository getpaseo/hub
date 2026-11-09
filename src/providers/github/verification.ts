import jwt from "jsonwebtoken";
import { z } from "zod";
import type {
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
} from "../../provider-applications/index.js";
import { ProviderVerificationError } from "../../provider-applications/index.js";
import { fixedRequest, rejectFailedResponse, safeJson } from "../verification.js";
const githubIdentitySchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});
export async function verifyGitHub(
  configuration: Extract<ProviderApplicationConfiguration, { provider: "github" }>,
  request: typeof fetch,
  now: () => number,
  timeoutMs: number,
): Promise<ProviderApplicationIdentity> {
  let token: string;
  try {
    const nowSeconds = Math.floor(now() / 1000);
    token = jwt.sign(
      { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: configuration.appId },
      configuration.privateKey,
      { algorithm: "RS256" },
    );
  } catch {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "privateKey",
    });
  }
  const response = await fixedRequest(
    request,
    "https://api.github.com/app",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
    timeoutMs,
  );
  if (response.status === 401 || response.status === 403) {
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "privateKey",
    });
  }
  rejectFailedResponse(response);
  const body = await safeJson(response);
  if (body === undefined) throw new ProviderVerificationError("invalidResponse", response.status);
  const parsed = githubIdentitySchema.safeParse(body);
  if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
  // The key authenticated an App, just not the one the operator named. That is a different
  // problem from a key GitHub refused, and it gets a different answer.
  if (String(parsed.data.id) !== configuration.appId) {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "identityMismatch",
    });
  }
  return {
    provider: "github",
    id: String(parsed.data.id),
    name: parsed.data.name,
    ownerLogin: parsed.data.owner.login,
  };
}
