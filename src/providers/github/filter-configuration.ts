import { z } from "zod";
import type { CompiledTriggerFilter } from "../../config/compiler.js";
import {
  optionalNonEmptyListFilter,
  optionalNonEmptyTextFilter,
  optionalTextFilter,
} from "../configuration.js";

export const filterFields = {
  exclude_contains: optionalTextFilter,
  label: optionalNonEmptyTextFilter,
  labels: optionalNonEmptyListFilter,
  repo: optionalNonEmptyTextFilter,
};
const schema = z.object(filterFields);
export function nativeFilters(value: CompiledTriggerFilter) {
  return { ...value, ...schema.parse(value) };
}

// Preserve the legacy converter's label/repository-only native projection.
export function projectLegacyFilters(value: Readonly<Record<string, unknown>>) {
  return schema.omit({ exclude_contains: true }).parse(value);
}
