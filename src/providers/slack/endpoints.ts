import { slackSocketSchema } from "./application-configuration.js";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../../contract/respond.js";
import { respondWithFailure } from "../../failures/index.js";
import type { ProviderApplicationSaveResult } from "../../provider-applications/index.js";
import { providerApplicationSaveFailure } from "../../provider-applications/save-failure.js";
import { getApplication } from "../../server/runtime.js";
import { configureSlackSocket, retrySlackSocket } from "./application-capability.js";
export const configureSlackSocketHandler = async ({
  data,
}: {
  data: z.infer<typeof slackSocketSchema>;
}): Promise<Result<ProviderApplicationSaveResult>> => {
  try {
    const capability = (await getApplication()).providerApplications;
    if (capability === null) throw new Error("unavailable");
    return respondOk(
      await configureSlackSocket(capability, getRequest(), {
        appToken: data.appToken,
        botToken: data.botToken,
        ...(data.expectedVersion === undefined ? {} : { expectedVersion: data.expectedVersion }),
      }),
    );
  } catch (error) {
    return providerApplicationSaveFailure("slack", error, [data.appToken, data.botToken]);
  }
};
export const retrySlackSocketHandler = async (): Promise<Result<void>> => {
  try {
    const capability = (await getApplication()).providerApplications;
    if (capability === null) throw new Error("unavailable");
    await retrySlackSocket(capability, getRequest());
    return respondOk(undefined);
  } catch (error) {
    return respondWithFailure(
      error,
      { operation: "slack.socket.retry", component: "provider_applications", provider: "slack" },
      {
        fallback: "Hub couldn't retry Slack. Sign in as the instance operator, then try again.",
      },
    );
  }
};
