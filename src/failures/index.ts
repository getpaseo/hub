import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import { respondError, type Err } from "../contract/respond.js";
import { logger as defaultLogger } from "../logger.js";

export type FailureKind =
  | "validation"
  | "authentication"
  | "forbidden"
  | "notFound"
  | "credentialsRejected"
  | "permissionMissing"
  | "rateLimited"
  | "network"
  | "timeout"
  | "upstreamUnavailable"
  | "conflict"
  | "internal";

export interface FailureContext {
  operation: string;
  component: string;
  provider?: "github" | "slack" | "discord" | "stripe";
  requestId?: string;
  status?: number;
  organizationSlug?: string;
  projectSlug?: string;
  daemonId?: string;
  executionId?: string;
  method?: string;
  path?: string;
}

export interface FailureReport {
  kind: FailureKind;
  requestId: string;
}

interface FailureMessages {
  fallback: string;
  validation?: string;
  authentication?: string;
  forbidden?: string;
  notFound?: string;
  credentialsRejected?: string;
  permissionMissing?: string;
  rateLimited?: string;
  network?: string;
  timeout?: string;
  upstreamUnavailable?: string;
  conflict?: string;
  internal?: string;
}

interface ReportOptions {
  logger?: Pick<Logger, "warn" | "error">;
  kind?: FailureKind;
  status?: number;
}

interface RequestFailureState {
  reported: boolean;
}

const requestFailureState = new AsyncLocalStorage<RequestFailureState>();

export function runWithFailureTracking<T>(operation: () => T): T {
  return requestFailureState.run({ reported: false }, operation);
}

export function failureWasReported(): boolean {
  return requestFailureState.getStore()?.reported === true;
}

export function reportFailure(
  error: unknown,
  context: FailureContext,
  options: ReportOptions = {},
): FailureReport {
  const activeRequest = requestFailureState.getStore();
  if (activeRequest !== undefined) activeRequest.reported = true;
  const kind = options.kind ?? classifyFailure(error, options.status ?? context.status);
  const requestId = context.requestId ?? randomUUID();
  const record = {
    err: asError(error),
    failureKind: kind,
    requestId,
    ...context,
    ...(options.status === undefined ? {} : { status: options.status }),
  };
  const log = options.logger ?? defaultLogger;
  if (isExpected(kind)) log.warn(record, `${context.operation} failed`);
  else log.error(record, `${context.operation} failed`);
  return { kind, requestId };
}

export function respondWithFailure(
  error: unknown,
  context: FailureContext,
  messages: FailureMessages,
  options: ReportOptions = {},
): Err {
  const report = reportFailure(error, context, options);
  const message = messages[report.kind] ?? messages.fallback;
  return respondError({
    message: shouldCorrelate(report.kind) ? `${message} Reference: ${report.requestId}.` : message,
  });
}

export function classifyFailure(error: unknown, status?: number): FailureKind {
  const statusKind = classifyStatus(status);
  if (statusKind !== undefined) return statusKind;
  const code = errorProperty(error, "code") ?? errorProperty(error, "reason");
  const codeKind = code === undefined ? undefined : FAILURE_CODES.get(code);
  if (codeKind !== undefined) return codeKind;
  const name = error instanceof Error ? error.name : undefined;
  const nameKind = name === undefined ? undefined : classifyErrorName(name);
  if (nameKind !== undefined) return nameKind;
  const causeCode = errorCode(error instanceof Error ? error.cause : undefined);
  return causeCode === undefined ? "internal" : (TRANSPORT_CODES.get(causeCode) ?? "internal");
}

const FAILURE_CODES = new Map<string, FailureKind>([
  ["invalidInput", "validation"],
  ["invalidOrigin", "validation"],
  ["invalid_request", "validation"],
  ["authentication", "authentication"],
  ["unauthorized", "authentication"],
  ["forbidden", "forbidden"],
  ["notFound", "notFound"],
  ["not_found", "notFound"],
  ["credentialsRejected", "credentialsRejected"],
  ["permissionMissing", "permissionMissing"],
  ["rateLimited", "rateLimited"],
  ["network", "network"],
  ["unreachable", "network"],
  ["daemon_unreachable", "network"],
  ["timeout", "timeout"],
  ["upstreamUnavailable", "upstreamUnavailable"],
  ["invalidResponse", "upstreamUnavailable"],
  ["configurationConflict", "conflict"],
  ["identityConflict", "conflict"],
  ["conflict", "conflict"],
]);

const TRANSPORT_CODES = new Map<string, FailureKind>([
  ["ETIMEDOUT", "timeout"],
  ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
  ["UND_ERR_HEADERS_TIMEOUT", "timeout"],
  ["ENOTFOUND", "network"],
  ["EAI_AGAIN", "network"],
  ["ECONNREFUSED", "network"],
  ["ECONNRESET", "network"],
  ["CERT_HAS_EXPIRED", "network"],
]);

function classifyStatus(status: number | undefined): FailureKind | undefined {
  if (status === undefined || status < 400) return undefined;
  return (
    new Map<number, FailureKind>([
      [401, "authentication"],
      [403, "forbidden"],
      [404, "notFound"],
      [409, "conflict"],
      [429, "rateLimited"],
    ]).get(status) ?? (status >= 500 ? "internal" : "validation")
  );
}

function classifyErrorName(name: string): FailureKind | undefined {
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (name.includes("Forbidden") || name.includes("AccessDenied")) return "forbidden";
  if (name.includes("NotFound")) return "notFound";
  if (name.includes("Conflict")) return "conflict";
  return undefined;
}

function isExpected(kind: FailureKind): boolean {
  return [
    "validation",
    "authentication",
    "forbidden",
    "notFound",
    "credentialsRejected",
    "permissionMissing",
    "conflict",
  ].includes(kind);
}

function shouldCorrelate(kind: FailureKind): boolean {
  return ["network", "timeout", "rateLimited", "upstreamUnavailable", "internal"].includes(kind);
}

function errorProperty(error: unknown, property: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value: unknown = Reflect.get(error, property);
  return typeof value === "string" ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  return errorProperty(error, "code");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("non-Error failure");
}
