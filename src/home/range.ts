import type { ActivityRange } from "../activity/query-contract.js";

/**
 * The windows Home reads its figures over. Each one is an Activity range too, so a figure links
 * to the runs it counts with the same `range` in the URL.
 */
export const HOME_RANGES = ["24h", "7d", "30d"] as const satisfies readonly ActivityRange[];
export type HomeRange = (typeof HOME_RANGES)[number];

/** Home's URL as written: the default week is omitted, like Activity's. */
export interface HomeSearch {
  range?: Exclude<HomeRange, "7d">;
}

export function parseHomeSearch(raw: Readonly<Record<string, unknown>>): HomeSearch {
  const range = raw["range"];
  return range === "24h" || range === "30d" ? { range } : {};
}

export function homeRange(search: HomeSearch): HomeRange {
  return search.range ?? "7d";
}

export function isHomeRange(value: string): value is HomeRange {
  return HOME_RANGES.some((range) => range === value);
}
