import { z } from "zod";

// This is an authored template, not the rendered key. Runtime enforces the 512-character bound.
// Never normalize it: leading/trailing whitespace can be part of an existing workspace identity.
export const WorkspaceAffinityKeySchema = z
  .string()
  .min(1)
  .refine((key) => key.trim().length > 0, "workspace affinity key must not be blank");

export const WorkspaceAffinitySchema = z.object({ key: WorkspaceAffinityKeySchema }).strict();
