import { createPublicKey, type JsonWebKey, type KeyObject } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";

export const GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs" as const;

const DEFAULT_JWKS_CACHE_MS = 5 * 60 * 1_000;
const MIN_JWKS_REFRESH_INTERVAL_MS = 10_000;
const CLOCK_TOLERANCE_SECONDS = 30;
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const CLASSIC_CHAT_ISSUER_EMAIL = "chat@system.gserviceaccount.com";
const ADDON_CHAT_ISSUER_EMAIL_PATTERN =
  /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/u;

const JwkEntrySchema = z
  .object({
    kid: z.string().min(1),
    kty: z.literal("RSA"),
    n: z.string().min(1),
    e: z.string().min(1),
  })
  .passthrough();

const JwksPayloadSchema = z.object({
  keys: z.array(JwkEntrySchema).min(1),
});

const VerifiedClaimsSchema = z
  .object({
    iss: z.string().min(1),
    email: z.string().min(1),
    email_verified: z.boolean().optional(),
  })
  .passthrough();

export interface VerifiedGoogleChatOidcClaims {
  issuer: string;
  email: string;
  subject?: string;
}

export class GoogleChatOidcVerificationError extends Error {
  readonly code = "unauthorized";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleChatOidcVerificationError";
  }
}

export interface GoogleChatOidcVerifier {
  verifyAuthorizationHeader(
    authorizationHeader: string | null,
  ): Promise<VerifiedGoogleChatOidcClaims>;
  verifyBearerToken(token: string): Promise<VerifiedGoogleChatOidcClaims>;
}

export interface CreateGoogleChatOidcVerifierOptions {
  expectedAudience: string;
  certsUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface CachedJwks {
  keysById: ReadonlyMap<string, KeyObject>;
  fetchedAtMs: number;
  expiresAtMs: number;
}

export function createGoogleChatOidcVerifier(
  options: CreateGoogleChatOidcVerifierOptions,
): GoogleChatOidcVerifier {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const certsUrl = options.certsUrl ?? GOOGLE_OIDC_JWKS_URL;

  let cached: CachedJwks | undefined;
  let inFlight: Promise<CachedJwks> | undefined;

  const loadJwks = async (forceRefresh: boolean): Promise<CachedJwks> => {
    const nowMs = now();
    if (!forceRefresh && cached !== undefined && nowMs < cached.expiresAtMs) {
      return cached;
    }
    if (
      forceRefresh &&
      cached !== undefined &&
      nowMs - cached.fetchedAtMs < MIN_JWKS_REFRESH_INTERVAL_MS
    ) {
      return cached;
    }
    if (inFlight !== undefined) {
      return inFlight;
    }
    const pending = fetchGoogleJwks(fetchFn, certsUrl, now())
      .then((next) => {
        cached = next;
        return next;
      })
      .finally(() => {
        if (inFlight === pending) {
          inFlight = undefined;
        }
      });
    inFlight = pending;
    return pending;
  };

  const resolveKey = async (kid: string): Promise<KeyObject> => {
    const initial = await loadJwks(false);
    const existing = initial.keysById.get(kid);
    if (existing !== undefined) {
      return existing;
    }
    const refreshed = await loadJwks(true);
    const afterRefresh = refreshed.keysById.get(kid);
    if (afterRefresh === undefined) {
      throw new GoogleChatOidcVerificationError("Unknown Google OIDC signing key id.");
    }
    return afterRefresh;
  };

  const verifyBearerToken = async (token: string): Promise<VerifiedGoogleChatOidcClaims> => {
    const decoded = jwt.decode(token, { complete: true });
    if (decoded === null || typeof decoded !== "object") {
      throw new GoogleChatOidcVerificationError("Malformed Google Chat bearer token.");
    }
    if (decoded.header.alg !== "RS256" || typeof decoded.header.kid !== "string") {
      throw new GoogleChatOidcVerificationError("Unsupported Google Chat JWT signing header.");
    }

    const publicKey = await resolveKey(decoded.header.kid);
    const verifiedPayload = verifyJwtSignature(
      token,
      publicKey,
      options.expectedAudience,
      Math.floor(now() / 1_000),
    );
    return validateGoogleChatClaims(verifiedPayload);
  };

  return {
    async verifyAuthorizationHeader(authorizationHeader) {
      const token = extractBearerToken(authorizationHeader);
      return verifyBearerToken(token);
    },
    verifyBearerToken,
  };
}

export function extractBearerToken(authorizationHeader: string | null): string {
  if (authorizationHeader === null) {
    throw new GoogleChatOidcVerificationError("Missing Authorization header.");
  }
  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(\S+)$/iu.exec(trimmed);
  const token = match?.[1];
  if (token === undefined || token.length === 0) {
    throw new GoogleChatOidcVerificationError("Authorization header must be a Bearer token.");
  }
  return token;
}

function verifyJwtSignature(
  token: string,
  publicKey: KeyObject,
  expectedAudience: string,
  clockTimestamp: number,
): unknown {
  try {
    return jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      audience: expectedAudience,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      clockTimestamp,
    });
  } catch (cause) {
    throw new GoogleChatOidcVerificationError(
      "Google Chat OIDC token signature or audience verification failed.",
      { cause },
    );
  }
}

function validateGoogleChatClaims(payload: unknown): VerifiedGoogleChatOidcClaims {
  const parsed = VerifiedClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GoogleChatOidcVerificationError("Google Chat OIDC token is missing required claims.");
  }
  if (!GOOGLE_ISSUERS.has(parsed.data.iss)) {
    throw new GoogleChatOidcVerificationError("Unexpected Google Chat OIDC token issuer.");
  }
  if (parsed.data.email_verified !== true) {
    throw new GoogleChatOidcVerificationError("Google Chat OIDC email claim is not verified.");
  }
  if (!isAuthorizedGoogleChatServiceAccount(parsed.data.email)) {
    throw new GoogleChatOidcVerificationError("Unexpected Google Chat sender service account.");
  }
  const sub = parsed.data["sub"];
  return {
    issuer: parsed.data.iss,
    email: parsed.data.email,
    ...(typeof sub === "string" && sub.length > 0 ? { subject: sub } : {}),
  };
}

export function isAuthorizedGoogleChatServiceAccount(email: string): boolean {
  return email === CLASSIC_CHAT_ISSUER_EMAIL || ADDON_CHAT_ISSUER_EMAIL_PATTERN.test(email);
}

async function fetchGoogleJwks(
  fetchFn: typeof fetch,
  certsUrl: string,
  nowMs: number,
): Promise<CachedJwks> {
  let response: Response;
  try {
    response = await fetchFn(certsUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new GoogleChatOidcVerificationError("Failed to fetch Google OIDC certificates.", {
      cause,
    });
  }
  if (!response.ok) {
    throw new GoogleChatOidcVerificationError(
      `Google OIDC certificates endpoint returned HTTP ${String(response.status)}.`,
    );
  }
  const raw: unknown = await response.json();
  const parsed = JwksPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleChatOidcVerificationError("Invalid Google OIDC JWKS payload.");
  }

  const keysById = new Map<string, KeyObject>();
  for (const key of parsed.data.keys) {
    const jwk: JsonWebKey = {
      kty: key.kty,
      n: key.n,
      e: key.e,
    };
    keysById.set(key.kid, createPublicKey({ key: jwk, format: "jwk" }));
  }

  const maxAgeMs = parseCacheControlMaxAgeMs(response.headers.get("cache-control"));
  return {
    keysById,
    fetchedAtMs: nowMs,
    expiresAtMs: nowMs + (maxAgeMs ?? DEFAULT_JWKS_CACHE_MS),
  };
}

function parseCacheControlMaxAgeMs(cacheControl: string | null): number | undefined {
  if (cacheControl === null) return undefined;
  const match = /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl);
  const secondsText = match?.[1];
  if (secondsText === undefined) return undefined;
  const seconds = Number(secondsText);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  return seconds * 1_000;
}
