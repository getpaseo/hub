import { ProviderApplicationError } from "../../provider-applications/index.js";
export function activationError(error: unknown): Error | undefined {
  const gateway = discordGatewayFailure(error);
  return gateway === undefined
    ? undefined
    : new ProviderApplicationError(gateway.code, discordGatewayContext(gateway.failure), {
        cause: error,
      });
}
function discordGatewayContext(failure: string): string {
  return `discordGateway${failure[0]?.toUpperCase()}${failure.slice(1)}`;
}

function discordGatewayFailure(error: unknown):
  | {
      code: "credentialsRejected" | "permissionMissing" | "internal";
      failure: string;
    }
  | undefined {
  if (!(error instanceof Error) || error.name !== "DiscordGatewayError") return undefined;
  const code: unknown = Reflect.get(error, "code");
  const failure: unknown = Reflect.get(error, "gatewayFailure");
  if (
    (code !== "credentialsRejected" && code !== "permissionMissing" && code !== "internal") ||
    typeof failure !== "string"
  ) {
    return undefined;
  }
  return { code, failure };
}
