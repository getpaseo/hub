import { z } from "zod";
import { optionalNonEmptyTextFilter } from "../configuration.js";

export const filterFields = { workspace: optionalNonEmptyTextFilter };

const schema = z.object(filterFields);

export function projectLegacyFilters(value: Readonly<Record<string, unknown>>) {
  return schema.parse(value);
}
