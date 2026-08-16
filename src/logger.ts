import pino from "pino";

const SECRET_KEY_PATTERN =
  /(?:^|[_-])(?:token|secret|password|auth|authorization|key|signature)(?:$|[_-])|(?:Token|Secret|Password|Auth|Authorization|Key|Signature)(?:Header|Value)?$/iu;
const GITHUB_TOKEN_PATTERN = /\b(?:gho|ghp|ghu|ghs)_[A-Za-z0-9_]+\b|\bgithub_pat_[A-Za-z0-9_]+\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const DISCORD_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]+\b/g;
const STRIPE_SECRET_PATTERN = /\b(?:sk_(?:live|test)|rk_(?:live|test)|whsec)_[A-Za-z0-9_]+\b/g;
const AUTHORIZATION_PATTERN = /\b(?:Bearer|Basic|Bot)\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;
const REDACTED = "[Redacted]";

const PINO_REDACT_PATHS = [
  "*.token",
  "*.secret",
  "*.password",
  "*.auth",
  "*.key",
  "*.signature",
  "token",
  "secret",
  "password",
  "auth",
  "key",
  "signature",
  "req.headers.authorization",
  "headers.authorization",
];

export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const isDevelopment = process.env["NODE_ENV"] !== "production";
  const options: pino.LoggerOptions = {
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: {
      paths: PINO_REDACT_PATHS,
      censor: REDACTED,
    },
    formatters: {
      log(object) {
        return redactObject(object);
      },
    },
    serializers: {
      err: serializeError,
    },
  };

  if (destination !== undefined) {
    return pino(options, destination);
  }

  if (isDevelopment) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    });
  }

  return pino(options);
}

export function redact(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY_PATTERN.test(key)) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value instanceof Error || value instanceof Date) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    return redactObject(value);
  }

  return value;
}

function redactObject(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey),
    ]),
  );
}

function redactString(value: string): string {
  let redacted = value.replace(GITHUB_TOKEN_PATTERN, REDACTED);

  redacted = redacted.replace(JWT_PATTERN, REDACTED);
  redacted = redacted.replace(DISCORD_TOKEN_PATTERN, REDACTED);
  redacted = redacted.replace(SLACK_TOKEN_PATTERN, REDACTED);
  redacted = redacted.replace(STRIPE_SECRET_PATTERN, REDACTED);
  redacted = redacted.replace(AUTHORIZATION_PATTERN, REDACTED);
  redacted = redacted.replace(PRIVATE_KEY_PATTERN, REDACTED);

  return redacted;
}

function serializeError(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) return { type: "NonError", message: "non-Error failure" };
  return {
    type: value.name,
    message: redactString(value.message),
    ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
    ...(value.cause === undefined ? {} : { cause: serializeError(value.cause) }),
  };
}

export const logger = createLogger();
