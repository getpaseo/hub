import { keepPreviousData, useQuery, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Result } from "../contract/respond.js";

/** A read has content, is awaiting its first answer, or could not obtain an answer. */
export type Snapshot<T> =
  | { status: "pending"; data: undefined; error: null }
  | { status: "error"; data: undefined; error: string | null }
  | { status: "success"; data: T; error: null };

class SnapshotFailure extends Error {}

/**
 * Server Result failures belong to the query's error channel, never its data cache. React Query
 * retains the last successful value and retries a failed read twice. A background failure does
 * not take existing content away; an initial failure keeps the server's message and reference.
 * Query keys still own identity: another organization or resource starts with its own snapshot.
 */
export function useSnapshotQuery<T>(options: {
  queryKey: QueryKey;
  queryFn: () => Promise<Result<T>>;
  enabled?: boolean;
  /** A fixed period, or one decided from the current answer: poll an empty list until it fills. */
  refetchInterval?: number | ((data: T | undefined) => number | false);
  /**
   * Keep showing the previous key's answer while the next one loads. For a list whose key is its
   * filters: the rows stay put while a new filter loads instead of flashing back to a skeleton.
   */
  keepPrevious?: boolean;
}): Snapshot<T> & { refetch: () => void; isFetching: boolean } {
  const { keepPrevious = false, refetchInterval, ...read } = options;
  const query = useQuery({
    ...read,
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
    ...(refetchInterval === undefined
      ? {}
      : {
          refetchInterval:
            typeof refetchInterval === "number"
              ? refetchInterval
              : (current: { state: { data: T | undefined } }) =>
                  refetchInterval(current.state.data),
        }),
    queryFn: async () => {
      const result = await read.queryFn();
      if (result.status === "error") throw new SnapshotFailure(result.error.message);
      return result.data;
    },
    retry: 2,
  });
  const reload = query.refetch;
  const refetch = useCallback(() => {
    void reload();
  }, [reload]);
  if (query.data !== undefined)
    return {
      status: "success",
      data: query.data,
      error: null,
      refetch,
      isFetching: query.isFetching,
    };
  if (query.isPending)
    return {
      status: "pending",
      data: undefined,
      error: null,
      refetch,
      isFetching: query.isFetching,
    };
  return {
    status: "error",
    data: undefined,
    error: query.error instanceof SnapshotFailure ? query.error.message : null,
    refetch,
    isFetching: query.isFetching,
  };
}
