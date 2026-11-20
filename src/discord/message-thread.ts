import { RESTJSONErrorCodes } from "discord-api-types/v10";

export async function resolveDiscordMessageThread<T, Created>(input: {
  hasThread: boolean;
  readThread: () => Promise<T>;
  createThread: () => Promise<Created>;
}): Promise<T | Created> {
  if (input.hasThread) return input.readThread();
  try {
    return await input.createThread();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage
    ) {
      return input.readThread();
    }
    throw error;
  }
}
