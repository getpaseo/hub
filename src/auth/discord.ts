export interface DiscordOperatorAuth {
  token: string;
  clientId?: string;
}

export function readDiscordOperatorAuth(): DiscordOperatorAuth | undefined {
  const token = process.env["DISCORD_BOT_TOKEN"];
  const clientId = process.env["DISCORD_CLIENT_ID"];

  if (token === undefined || token.length === 0) {
    return undefined;
  }

  return {
    token,
    ...(clientId === undefined || clientId.length === 0 ? {} : { clientId }),
  };
}
