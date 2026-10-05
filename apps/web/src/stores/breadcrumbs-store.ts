import type { BreadcrumbCategory, UiBreadcrumb } from "@studio/shared";
import { create } from "zustand";

/** Ring buffer size: the last N user actions travel with every error report. */
export const MAX_BREADCRUMBS = 50;
/** Repeated events with the same key inside this window replace the previous one (drags). */
const COALESCE_MS = 1500;
const MAX_MESSAGE = 300;

interface StoredBreadcrumb extends UiBreadcrumb {
  key?: string;
}

interface BreadcrumbsState {
  crumbs: StoredBreadcrumb[];
  add: (
    category: BreadcrumbCategory,
    message: string,
    data?: Record<string, unknown>,
    key?: string,
  ) => void;
  clear: () => void;
}

export const useBreadcrumbsStore = create<BreadcrumbsState>()((set, get) => ({
  crumbs: [],
  add: (category, message, data, key) => {
    const now = Date.now();
    const crumb: StoredBreadcrumb = {
      at: new Date(now).toISOString(),
      category,
      message: message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message,
      ...(data && { data }),
      ...(key && { key }),
    };
    const crumbs = get().crumbs;
    const last = crumbs[crumbs.length - 1];
    const coalesce = key && last?.key === key && now - Date.parse(last.at) < COALESCE_MS;
    const next = coalesce ? [...crumbs.slice(0, -1), crumb] : [...crumbs, crumb];
    set({ crumbs: next.length > MAX_BREADCRUMBS ? next.slice(-MAX_BREADCRUMBS) : next });
  },
  clear: () => set({ crumbs: [] }),
}));

/**
 * Record a user action / event for error reports (panel opened, clip moved, job started, api
 * error...). Never throws: breadcrumbs must not break the feature that records them.
 */
export function addBreadcrumb(
  category: BreadcrumbCategory,
  message: string,
  data?: Record<string, unknown>,
  key?: string,
): void {
  try {
    useBreadcrumbsStore.getState().add(category, message, data, key);
  } catch {
    // ignore
  }
}

/** Breadcrumbs as sent to the api (without the internal coalescing key). */
export function getBreadcrumbs(): UiBreadcrumb[] {
  return useBreadcrumbsStore.getState().crumbs.map(({ key: _key, ...c }) => c);
}
