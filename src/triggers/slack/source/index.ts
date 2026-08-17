import type { ProviderEventAcceptance } from "../../../db/types.js";
import type { SlackProviderApplicationConfiguration } from "../../../provider-applications/index.js";
import type { ProviderEventDropReasonCode } from "../../drop-reason.js";
import type { TriggerSource } from "../../index.js";
import { createSlackWebhookSource } from "../webhook.js";
import {
  createSlackSocketSource,
  type SlackDeliveryStatus,
  type SlackSocketSourceOptions,
} from "./internal/socket.js";

export interface SlackEventSource {
  source: TriggerSource;
  request?: (request: Request) => Promise<Response>;
  ready(): Promise<void>;
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
}

export interface CreateSlackEventSourceOptions {
  configuration: SlackProviderApplicationConfiguration;
  configurationVersion: number;
  accept(input: {
    teamId: string;
    deliveryId: string;
    signatureHash: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
  socket?: Pick<
    SlackSocketSourceOptions,
    | "apiUrl"
    | "fetch"
    | "webSocket"
    | "now"
    | "random"
    | "readinessTimeoutMs"
    | "connectTimeoutMs"
    | "helloTimeoutMs"
    | "shutdownTimeoutMs"
  >;
}

export function createSlackEventSource(options: CreateSlackEventSourceOptions): SlackEventSource {
  if (options.configuration.transport === "webhook") {
    const webhook = createSlackWebhookSource({
      appId: options.configuration.appId,
      signingSecret: options.configuration.signingSecret,
      accept: (input) => options.accept(input),
    });
    return {
      source: webhook,
      request: (request) => webhook.handle(request),
      ready: () => Promise.resolve(),
      status: () => ({ state: "stopped" }),
      retry: () => Promise.resolve(),
    };
  }
  const socket = createSlackSocketSource({
    appId: options.configuration.appId,
    appToken: options.configuration.appToken,
    configurationVersion: options.configurationVersion,
    accept: (input) => options.accept(input),
    ...options.socket,
  });
  return {
    source: socket,
    ready: () => socket.ready(),
    status: () => socket.status(),
    retry: () => socket.retry(),
  };
}

export type { SlackDeliveryStatus } from "./internal/socket.js";
