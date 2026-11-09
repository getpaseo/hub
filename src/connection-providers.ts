export const CONNECTION_PROVIDERS = ["github", "slack", "discord", "linear"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];
export function isConnectionProvider(value: string | undefined): value is ConnectionProvider {
  return CONNECTION_PROVIDERS.some((provider) => provider === value);
}
