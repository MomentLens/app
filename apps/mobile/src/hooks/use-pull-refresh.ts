import { useState } from 'react';

// The spinner for a pull the user started, and for nothing else.
//
// Tying RefreshControl to a query's isRefetching showed the spinner for every background refetch
// too: coming back to the foreground, or the refetch after a create. On Android the spinner also
// stayed up after those, and the refresh view ignores a new pull while it believes one is running,
// so a pull sometimes did nothing.
export function usePullRefresh(refetch: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }

  return { refreshing, onRefresh: () => void onRefresh() };
}
