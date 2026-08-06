import { z } from "zod";

const storedValidationErrorsSchema = z.object({
  formErrors: z.array(z.string()),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
});

export type ConfigurationValidationErrors = z.infer<typeof storedValidationErrorsSchema>;

export function configurationValidationErrors(error: z.ZodError): ConfigurationValidationErrors {
  const flattened = z.flattenError(error);
  return {
    formErrors: flattened.formErrors,
    fieldErrors: flattened.fieldErrors,
  };
}

export function configurationValidationMessages(errors: unknown): string[] {
  const parsed = storedValidationErrorsSchema.safeParse(errors);
  if (!parsed.success) return ["Configuration validation failed."];
  const messages = [
    ...parsed.data.formErrors,
    ...Object.entries(parsed.data.fieldErrors ?? {}).flatMap(([field, failures]) =>
      failures.map((failure) => `${field}: ${failure}`),
    ),
  ].map(sentenceCase);
  return messages.length === 0 ? ["Configuration validation failed."] : messages;
}

function sentenceCase(message: string): string {
  return message.length === 0 ? message : `${message[0]!.toUpperCase()}${message.slice(1)}`;
}
