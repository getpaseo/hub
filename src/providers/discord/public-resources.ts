import { z } from "zod";
const configuration = z.array(z.object({ slug: z.string(), guildName: z.string() }).strict());
export const resourceSchemas = {
  configuration,
  setup: z.array(z.object({ guildId: z.string(), guildName: z.string() }).strict()),
};
