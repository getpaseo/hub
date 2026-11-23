import { DiscordAPIError, HTTPError, type REST } from "discord.js";
import type { z } from "zod";
import { IntegrationHttpError, IntegrationToolError } from "./http.js";

export function discordHttp(rest: REST, signal: AbortSignal) {
  return async <T>(path: string, schema: z.ZodType<T>, body?: object): Promise<T> => {
    signal.throwIfAborted();
    const url = new URL(path, "https://discord.com");
    const route = `/${url.pathname.slice(1)}` as const;
    const query = url.searchParams;
    const operation =
      body === undefined
        ? rest.get(route, { query, signal })
        : rest.post(route, { query, signal, body });
    // The SDK cancels HTTP and queued requests with the signal. Bound the wait here too,
    // since a rate-limit delay already in progress can outlive the signal.
    let onAbort: () => void = () => {};
    const timeout = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new IntegrationToolError("The Discord request timed out."));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return schema.parse(await Promise.race([operation, timeout]));
    } catch (error) {
      if (error instanceof DiscordAPIError) {
        const code = typeof error.code === "number" ? error.code : undefined;
        throw new IntegrationHttpError(error.status, code);
      }
      if (error instanceof HTTPError) throw new IntegrationHttpError(error.status);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
}
