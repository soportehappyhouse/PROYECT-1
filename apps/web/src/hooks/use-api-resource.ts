"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, isNotImplemented } from "@/lib/api";

export type ResourceStatus = "loading" | "ready" | "not-implemented" | "error";

export interface Resource<T> {
  data: T | undefined;
  status: ResourceStatus;
  error: string | undefined;
  reload: () => void;
}

/** Fetch once on mount (and on `reload`), mapping 501 to "not-implemented" instead of throwing. */
export function useApiResource<T>(fetcher: () => Promise<T>, key = ""): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [status, setStatus] = useState<ResourceStatus>("loading");
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let alive = true;
    setStatus((s) => (s === "ready" ? s : "loading"));
    fetcherRef
      .current()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setStatus("ready");
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setStatus(isNotImplemented(err) ? "not-implemented" : "error");
        setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [tick, key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, status, error, reload };
}
