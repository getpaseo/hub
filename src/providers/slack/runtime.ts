import type { SlackDeliveryStatus } from "../../triggers/slack/source/index.js";
import { ProviderRuntimeDefinition, type ActiveProviderRuntime } from "../active-runtime.js";
import type { ProviderRegistration } from "../registration.js";
export interface SlackRegistration extends ProviderRegistration {
  slackDelivery?: { status(): SlackDeliveryStatus; retry(): Promise<void> };
}
export const slackRuntime = new ProviderRuntimeDefinition<SlackRegistration>(
  "slack",
  isSlackRegistration,
);
export function slackDelivery(runtime: ActiveProviderRuntime): {
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
} {
  return {
    status: () =>
      runtime.read(
        slackRuntime,
        (registration) => registration?.slackDelivery?.status() ?? { state: "stopped" },
      ),
    retry: () =>
      runtime.use(
        slackRuntime,
        (registration) => registration?.slackDelivery?.retry() ?? Promise.resolve(),
      ),
  };
}

function isSlackRegistration(
  registration: ProviderRegistration,
): registration is SlackRegistration {
  if (!("slackDelivery" in registration) || registration.slackDelivery === undefined) return true;
  const delivery = registration.slackDelivery;
  return (
    typeof delivery === "object" &&
    delivery !== null &&
    "status" in delivery &&
    typeof delivery.status === "function" &&
    "retry" in delivery &&
    typeof delivery.retry === "function"
  );
}
