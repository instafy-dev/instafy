import type { QueryClient, QueryFilters } from "@tanstack/react-query";

/**
 * Invalidates queries on a change signal without cancelling a fetch in
 * flight. With `cancelRefetch: false` React Query joins that fetch instead of
 * starting a new one, and its success clears the invalidation, but it may
 * have read the data before the change. So when one was in flight, fetch once
 * more after it settles; signals that arrive meanwhile share that one fetch.
 */
export async function invalidateAfterInFlight(
  queryClient: QueryClient,
  filters: QueryFilters,
): Promise<void> {
  const inFlight = queryClient.isFetching(filters) > 0;
  await queryClient.invalidateQueries(filters, { cancelRefetch: false });
  if (inFlight) {
    await queryClient.invalidateQueries(filters, { cancelRefetch: false });
  }
}
