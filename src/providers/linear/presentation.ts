import { identitySchema } from "./application-configuration.js";
export const glyph = {
  viewBox: "0 0 16 16",
  paths: [
    "M2.15 13.85 13.85 2.15A6.77 6.77 0 0 0 2.15 13.85Zm.9-5.2 5.6-5.6a4.8 4.8 0 0 1 4.3-.9l-8.99 8.99a4.8 4.8 0 0 1-.9-2.49Zm4.3 4.3 5.6-5.6a4.8 4.8 0 0 1-.9 4.3l-1.2 1.2a4.8 4.8 0 0 1-2.5.1Z",
  ],
};
export const runHint = "Update an issue in the connected Linear workspace.";
export function identityLabel(value: unknown): string {
  const identity = identitySchema.parse(value);
  return identity.name;
}
