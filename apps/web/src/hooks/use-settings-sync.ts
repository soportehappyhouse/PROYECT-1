"use client";

import { useEffect } from "react";
import { api, isNotImplemented } from "@/lib/api";
import {
  persistSettingsToLocalStorage,
  pickPersisted,
  toApiSettings,
  useSettingsStore,
} from "@/stores/settings-store";

const PUT_DEBOUNCE_MS = 1000;

/** localStorage for instant load + GET/PUT /api/settings as the durable copy. */
export function useSettingsSync(): void {
  useEffect(() => {
    const stopLocal = persistSettingsToLocalStorage();
    const store = useSettingsStore;
    let disposed = false;
    let remoteWritable = true;

    void api
      .getSettings()
      .then((remote) => {
        if (disposed) return;
        store.getState().mergeRemote(remote);
        store.getState().setSyncState("synced");
      })
      .catch((err: unknown) => {
        store.getState().setSyncState(isNotImplemented(err) ? "local" : "error");
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = JSON.stringify(pickPersisted(store.getState()));
    const unsubscribe = store.subscribe((state) => {
      const next = JSON.stringify(pickPersisted(state));
      if (next === last || !remoteWritable) return;
      last = next;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void api
          .putSettings(toApiSettings(store.getState()))
          .then(() => store.getState().setSyncState("synced"))
          .catch((err: unknown) => {
            if (isNotImplemented(err)) {
              // PUT not implemented yet: stay local-only for this session.
              remoteWritable = false;
              store.getState().setSyncState("local");
            } else store.getState().setSyncState("error");
          });
      }, PUT_DEBOUNCE_MS);
    });

    return () => {
      disposed = true;
      stopLocal();
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
