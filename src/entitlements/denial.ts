import { z } from "zod";

/**
 * The one transport-neutral shape an entitlement denial takes on the wire. Caps and meters
 * carry a numeric `limit`/`current`; flags carry null for both. Defined and parsed here once —
 * no protocol boundary defines its own copy or reshapes it per call site.
 *
 * This module imports nothing but zod, so both the server (producing the response) and the
 * browser bundle (parsing it) can share it without pulling server-only code into the client.
 */
export const entitlementDenialSchema = z
  .object({
    error: z.literal("entitlement_denied"),
    entitlement: z.string(),
    kind: z.enum(["cap", "meter", "flag"]),
    limit: z.number().nullable(),
    current: z.number().nullable(),
  })
  .strict();

export type EntitlementDenialPayload = z.infer<typeof entitlementDenialSchema>;

/** The HTTP boundary's single mapper: a denial payload becomes a 409. */
export function entitlementDenialResponse(denial: EntitlementDenialPayload): Response {
  return Response.json(denial, { status: 409 });
}

/** The single reader: recognize a denial payload, or `undefined` for anything else. */
export function parseEntitlementDenial(value: unknown): EntitlementDenialPayload | undefined {
  const parsed = entitlementDenialSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
