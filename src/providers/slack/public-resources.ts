import { z } from "zod";
const configuration = z.array(z.object({ slug: z.string(), teamName: z.string() }).strict());
export const resourceSchemas = {
  configuration,
  setup: z.array(z.object({ teamId: z.string(), teamName: z.string() }).strict()),
};
