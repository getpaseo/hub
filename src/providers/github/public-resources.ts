import { z } from "zod";
const configuration = z.array(
  z
    .object({
      slug: z.string(),
      accountLogin: z.string(),
      accountType: z.string(),
      repositories: z.array(z.string()),
    })
    .strict(),
);
export const resourceSchemas = { configuration, setup: configuration };
