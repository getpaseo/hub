import { useQuery, type QueryKey } from "@tanstack/react-query";
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
  refetchInterval?: number;
}): Snapshot<T> & { refetch: () => void; isFetching: boolean } {
  const query = useQuery({
    ...options,
    queryFn: async () => {
      const result = await options.queryFn();
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
