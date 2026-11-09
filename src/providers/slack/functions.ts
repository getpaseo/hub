import { createServerFn } from "@tanstack/react-start";
import { slackSocketSchema } from "./application-configuration.js";

export const configureSlackSocketApplication = createServerFn({ method: "POST" })
  .validator(slackSocketSchema)
  .handler(async (context) => {
    const { configureSlackSocketHandler } = await import("./endpoints.js");
    return configureSlackSocketHandler(context);
  });
export const retrySlackSocketDelivery = createServerFn({ method: "POST" }).handler(async () => {
  const { retrySlackSocketHandler } = await import("./endpoints.js");
  return retrySlackSocketHandler();
});
