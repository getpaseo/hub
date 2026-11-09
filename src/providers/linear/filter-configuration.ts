import { z } from "zod";
import type { CompiledTriggerFilter } from "../../config/compiler.js";
import { optionalNonEmptyListFilter, optionalNonEmptyTextFilter } from "../configuration.js";

export const filterFields = {
  project: optionalNonEmptyTextFilter,
  states: optionalNonEmptyListFilter,
  labels: optionalNonEmptyListFilter,
  exclude_labels: optionalNonEmptyListFilter,
  assignees: optionalNonEmptyListFilter,
};
const schema = z.object(filterFields);
export function nativeFilters(value: CompiledTriggerFilter) {
  return { ...value, ...schema.parse(value) };
}

export function projectLegacyFilters(value: Readonly<Record<string, unknown>>) {
  return schema.parse(value);
}
