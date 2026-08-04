import pino from "pino";

const SECRET_KEY_PATTERN = /(token|secret|password|auth|key|signature)/i;
const GITHUB_TOKEN_PATTERN = /\b(?:gho|ghp|ghu|ghs)_[A-Za-z0-9_]+\b|\bgithub_pat_[A-Za-z0-9_]+\b/g;
const JWT_PATTERN = /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
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

  redacted = redacted.replace(JWT_PATTERN, (match) => (match.length > 100 ? REDACTED : match));

  return redacted;
}

export const logger = createLogger();
