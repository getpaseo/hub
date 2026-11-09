import { z } from "zod";
const configuration = z.array(
  z.object({ slug: z.string(), organizationName: z.string() }).strict(),
);
export const resourceSchemas = { configuration };
