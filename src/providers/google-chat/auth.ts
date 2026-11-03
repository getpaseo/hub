import { createPrivateKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";

export const CHAT_BOT_SCOPE = "https://www.googleapis.com/auth/chat.bot" as const;
export const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub" as const;
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token" as const;

const TOKEN_REFRESH_SKEW_MS = 60_000;
const ASSERTION_LIFETIME_SECONDS = 3_600;

const ServiceAccountJsonSchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string().trim().min(1),
  private_key_id: z.string().trim().min(1).optional(),
  private_key: z.string().min(1),
  client_email: z.string().trim().email(),
  token_uri: z.string().trim().url().optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
});

const TokenErrorResponseSchema = z
  .object({
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

export interface GoogleServiceAccountCredentials {
  type: "service_account";
  projectId: string;
  privateKeyId?: string;
  privateKey: string;
  clientEmail: string;
  tokenUri: string;
}

export class GoogleServiceAccountValidationError extends Error {
  readonly code = "invalidInput";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleServiceAccountValidationError";
  }
}

export class GoogleAccessTokenError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(
    message: string,
    options?: {
      code?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GoogleAccessTokenError";
    this.code = options?.code ?? "upstreamUnavailable";
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

export interface GoogleAccessTokenSource {
  readonly projectId: string;
  readonly clientEmail: string;
  getAccessToken(): Promise<string>;
}

export interface CreateGoogleAccessTokenSourceOptions {
  credentials: GoogleServiceAccountCredentials;
  scopes: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  tokenEndpoint?: string;
}

interface CachedAccessToken {
  accessToken: string;
  refreshAfterMs: number;
}

export function parseGoogleServiceAccountJson(raw: string): GoogleServiceAccountCredentials {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    throw new GoogleServiceAccountValidationError("Service account JSON must be valid JSON.", {
      cause,
    });
  }

  const parsed = ServiceAccountJsonSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new GoogleServiceAccountValidationError(
      "Service account JSON must contain type, project_id, client_email, and private_key.",
    );
  }

  const normalizedKey = normalizePrivateKeyPem(parsed.data.private_key);
  try {
    const keyObject = createPrivateKey(normalizedKey);
    if (keyObject.asymmetricKeyType !== "rsa") {
      throw new GoogleServiceAccountValidationError(
        "Service account private_key must be an RSA key.",
      );
    }
  } catch (cause) {
    if (cause instanceof GoogleServiceAccountValidationError) {
      throw cause;
    }
    throw new GoogleServiceAccountValidationError(
      "Service account private_key is not a valid PEM-encoded RSA key.",
      { cause },
    );
  }

  return {
    type: "service_account",
    projectId: parsed.data.project_id,
    privateKey: normalizedKey,
    clientEmail: parsed.data.client_email,
    tokenUri: GOOGLE_OAUTH_TOKEN_URL,
    ...(parsed.data.private_key_id === undefined
      ? {}
      : { privateKeyId: parsed.data.private_key_id }),
  };
}

export function createGoogleAccessTokenSource(
  options: CreateGoogleAccessTokenSourceOptions,
): GoogleAccessTokenSource {
  if (options.scopes.length === 0) {
    throw new GoogleServiceAccountValidationError("At least one OAuth scope is required.");
  }
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_OAUTH_TOKEN_URL;
  const scopeClaim = options.scopes.join(" ");

  let cached: CachedAccessToken | undefined;
  let inFlight: Promise<string> | undefined;

  const refresh = async (): Promise<string> => {
    const nowMs = now();
    const issuedAt = Math.floor(nowMs / 1_000);
    const assertion = jwt.sign(
      {
        iss: options.credentials.clientEmail,
        sub: options.credentials.clientEmail,
        scope: scopeClaim,
        aud: tokenEndpoint,
        iat: issuedAt,
        exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      },
      options.credentials.privateKey,
      {
        algorithm: "RS256",
        ...(options.credentials.privateKeyId === undefined
          ? {}
          : { keyid: options.credentials.privateKeyId }),
      },
    );

    const response = await requestAccessToken(fetchFn, tokenEndpoint, assertion);
    const body = await parseTokenResponse(response);
    const ttlMs = body.expires_in * 1_000;
    const refreshLeadMs = Math.min(TOKEN_REFRESH_SKEW_MS, Math.floor(ttlMs / 2));
    cached = {
      accessToken: body.access_token,
      refreshAfterMs: nowMs + Math.max(1_000, ttlMs - refreshLeadMs),
    };
    return body.access_token;
  };

  return {
    projectId: options.credentials.projectId,
    clientEmail: options.credentials.clientEmail,
    async getAccessToken(): Promise<string> {
      if (cached !== undefined && now() < cached.refreshAfterMs) {
        return cached.accessToken;
      }
      if (inFlight !== undefined) {
        return inFlight;
      }
      const pending = refresh().finally(() => {
        if (inFlight === pending) {
          inFlight = undefined;
        }
      });
      inFlight = pending;
      return pending;
    },
  };
}

function normalizePrivateKeyPem(privateKey: string): string {
  const trimmed = privateKey.trim();
  return trimmed.includes("\\n") && !trimmed.includes("\n")
    ? trimmed.replaceAll("\\n", "\n")
    : trimmed;
}

async function requestAccessToken(
  fetchFn: typeof fetch,
  tokenEndpoint: string,
  assertion: string,
): Promise<Response> {
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  try {
    return await fetchFn(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (cause) {
    throw new GoogleAccessTokenError("Failed to reach Google OAuth token endpoint.", {
      code: "network",
      cause,
    });
  }
}

async function parseTokenResponse(
  response: Response,
): Promise<z.infer<typeof TokenResponseSchema>> {
  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (cause) {
    throw new GoogleAccessTokenError(
      `Google OAuth token endpoint returned non-JSON HTTP ${String(response.status)}.`,
      { code: classifyTokenHttpStatus(response.status), status: response.status, cause },
    );
  }

  if (!response.ok) {
    const parsedError = TokenErrorResponseSchema.safeParse(rawBody);
    const errorCode = parsedError.success ? parsedError.data.error : undefined;
    const description = parsedError.success ? parsedError.data.error_description : undefined;
    throw new GoogleAccessTokenError(
      description ??
        `Google OAuth token exchange failed (${errorCode ?? String(response.status)}).`,
      {
        code: classifyOAuthError(response.status, errorCode),
        status: response.status,
      },
    );
  }

  const parsed = TokenResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new GoogleAccessTokenError("Google OAuth token endpoint returned an invalid payload.", {
      code: "invalidResponse",
    });
  }
  return parsed.data;
}

function classifyOAuthError(status: number, oauthError: string | undefined): string {
  if (
    oauthError === "invalid_grant" ||
    oauthError === "invalid_client" ||
    oauthError === "unauthorized_client" ||
    status === 400 ||
    status === 401
  ) {
    return "credentialsRejected";
  }
  return classifyTokenHttpStatus(status);
}

function classifyTokenHttpStatus(status: number): string {
  if (status === 403) return "permissionMissing";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "upstreamUnavailable";
  return "credentialsRejected";
}
