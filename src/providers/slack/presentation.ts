import { identitySchema } from "./application-configuration.js";
export const glyph = {
  viewBox: "0 0 16 16",
  paths: [
    "M3.38 9.88A1.69 1.69 0 1 1 1.69 8.2h1.69v1.69Zm.85 0a1.69 1.69 0 1 1 3.38 0v4.23a1.69 1.69 0 1 1-3.38 0V9.88Zm1.69-6.76a1.69 1.69 0 1 1 1.69-1.69v1.69H5.92Zm0 .85a1.69 1.69 0 1 1 0 3.38H1.69a1.69 1.69 0 1 1 0-3.38h4.23Zm6.76 1.69a1.69 1.69 0 1 1 1.69 1.69h-1.69V5.66Zm-.85 0a1.69 1.69 0 1 1-3.38 0V1.43a1.69 1.69 0 1 1 3.38 0v4.23Zm-1.69 6.76a1.69 1.69 0 1 1-1.69 1.69v-1.69h1.69Zm0-.85a1.69 1.69 0 1 1 0-3.38h4.23a1.69 1.69 0 1 1 0 3.38h-4.23Z",
  ],
};
export const runHint = "Mention the bot in a channel it can see.";
export function identityLabel(value: unknown): string {
  const identity = identitySchema.parse(value);
  return identity.name;
}
