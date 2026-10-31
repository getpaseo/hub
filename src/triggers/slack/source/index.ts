import type { SlackProviderApplicationConfiguration } from "../../../provider-applications/index.js";
import type { TriggerSource } from "../../index.js";
import { createSlackWebhookSource } from "../webhook.js";
import type { SlackEventIntakeOptions } from "./internal/intake.js";
import {
  createSlackSocketSource,
  type SlackDeliveryStatus,
  type SlackIntakeHealth,
  type SlackSocketTuning,
} from "./internal/socket.js";

export interface SlackEventSource extends TriggerSource {
  request?: (request: Request) => Promise<Response>;
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
  intake(): SlackIntakeHealth;
}

export interface CreateSlackEventSourceOptions {
  configuration: SlackProviderApplicationConfiguration;
  accept: SlackEventIntakeOptions["accept"];
  socket?: SlackSocketTuning;
}

export function createSlackEventSource(options: CreateSlackEventSourceOptions): SlackEventSource {
  if (options.configuration.transport === "webhook") {
    const webhook = createSlackWebhookSource({
      appId: options.configuration.appId,
      signingSecret: options.configuration.signingSecret,
      accept: (input) => options.accept(input),
    });
    return {
      start: (handler) => webhook.start(handler),
      stop: () => webhook.stop(),
      request: (request) => webhook.handle(request),
      status: () => ({ state: "stopped" }),
      retry: () => Promise.resolve(),
      intake: () => ({ transport: "webhook" }),
    };
  }
  const socket = createSlackSocketSource({
    appId: options.configuration.appId,
    appToken: options.configuration.appToken,
    accept: (input) => options.accept(input),
    ...options.socket,
  });
  return socket;
}

export type { SlackDeliveryStatus, SlackIntakeHealth } from "./internal/socket.js";
