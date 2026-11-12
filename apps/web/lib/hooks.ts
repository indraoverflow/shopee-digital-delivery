"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";

/**
 * A deliberately small data hook: fetch, keep the last good value, expose a
 * refresh. The console is a set of list pages, so a cache with invalidation
 * would cost more than it explains.
 */
export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

export function useApi<T>(path: string | null, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    api
      .get<T>(path, controller.signal)
      .then((result) => {
        if (!alive.current) return;
        setData(result);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!alive.current || controller.signal.aborted) return;
        if (caught instanceof ApiError) setError(caught);
        else setError(new ApiError(0, "NETWORK", "Tidak dapat menghubungi server"));
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });

    return () => controller.abort();
  }, [path, tick, ...deps]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, refresh };
}
