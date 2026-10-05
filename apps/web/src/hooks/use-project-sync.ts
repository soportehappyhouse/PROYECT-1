"use client";

import type { Project } from "@studio/shared";
import { useEffect } from "react";
import { api, ApiRequestError, isNotImplemented, isOffline } from "@/lib/api";
import { loadLocalProject, persistLocalProject, useProjectStore } from "@/stores/project-store";

const SAVE_DEBOUNCE_MS = 1500;

/** 501 (module in development) and api down both mean "kept in this browser only". */
function failureState(err: unknown): "local" | "error" {
  return isNotImplemented(err) || isOffline(err) ? "local" : "error";
}

/** Save the current project to the api (falls back to local-only when the module is 501). */
export async function saveProjectNow(): Promise<void> {
  const store = useProjectStore.getState();
  const project = store.project;
  persistLocalProject(project);
  store.setSaveState("saving");
  try {
    await api.saveProject(project);
    useProjectStore.getState().setSaveState("saved");
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      try {
        await createRemote(project);
        useProjectStore.getState().setSaveState("saved");
        return;
      } catch (inner) {
        useProjectStore.getState().setSaveState(failureState(inner));
        return;
      }
    }
    useProjectStore.getState().setSaveState(failureState(err));
  }
}

/** The api assigns ids on POST: create it there and move the local timeline over. */
async function createRemote(local: Project): Promise<void> {
  const created = await api.createProject({ name: local.name, settings: local.settings });
  // Adopt the api identity right away (keeps edits made while the request was in flight).
  const state = useProjectStore.getState();
  useProjectStore.setState({
    project: { ...state.project, id: created.id, createdAt: created.createdAt },
  });
  persistLocalProject(useProjectStore.getState().project);
  await api.saveProject(useProjectStore.getState().project);
}

/** Restore the local project, reconcile with the api and autosave changes. */
export function useProjectSync(): void {
  useEffect(() => {
    let disposed = false;
    const local = loadLocalProject();
    useProjectStore.getState().loadProject(local);

    void (async () => {
      try {
        const remote = await api.getProject(local.id);
        if (disposed) return;
        if (Date.parse(remote.updatedAt) > Date.parse(local.updatedAt)) {
          useProjectStore.getState().loadProject(remote);
        }
        useProjectStore.getState().setSaveState("saved");
      } catch (err) {
        if (disposed) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          // Never saved on this api: create it there (the api assigns the id).
          useProjectStore.getState().setSaveState("saving");
          try {
            await createRemote(useProjectStore.getState().project);
            useProjectStore.getState().setSaveState("saved");
          } catch (inner) {
            useProjectStore.getState().setSaveState(failureState(inner));
          }
        } else {
          useProjectStore.getState().setSaveState(failureState(err));
        }
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useProjectStore.subscribe((state, prev) => {
      if (state.project === prev.project) return;
      persistLocalProject(state.project);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void saveProjectNow(), SAVE_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
