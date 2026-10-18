import type { ServiceState } from "@studio/shared";
import { create } from "zustand";
import { fetchHealth } from "@/lib/api-jobs";
import { useBreadcrumbsStore } from "./breadcrumbs-store";

/**
 * Sprint 5 (M1, H4): one source of truth for «is Studio / the local AI running?». Polls
 * GET /api/health every 5 s while something is down and every 15 s when all is up; a network error
 * means the api is down. Any api answer `WORKERS_UNAVAILABLE` (seen through the breadcrumbs that
 * lib/api.ts records for every failed request) marks the workers down at once and re-checks.
 * Drives the single ServiceBanner and useAiAvailability().
 */

export const POLL_DOWN_MS = 5_000;
export const POLL_UP_MS = 15_000;

interface ServiceStatusState extends ServiceState {
  /** CUDA seen by the workers (undefined = unknown). */
  cuda?: boolean;
  /** Last successful or failed check (ISO). */
  checkedAt?: string;
  /** A check is in flight. */
  checking: boolean;
  /** Re-check now (button «Reintentar»). */
  check: () => Promise<void>;
  /** An api call answered WORKERS_UNAVAILABLE. */
  reportWorkersDown: () => void;
  /** An api call could not reach the api at all. */
  reportApiUnreachable: () => void;
  /** Tests: set the state by hand. */
  set: (s: Partial<ServiceState & { cuda?: boolean }>) => void;
}

const now = () => new Date().toISOString();

export const useServiceStatusStore = create<ServiceStatusState>()((set, get) => {
  const update = (api: ServiceState["api"], workers: ServiceState["workers"], cuda?: boolean) => {
    const prev = get();
    const changed = prev.api !== api || prev.workers !== workers;
    set({
      api,
      workers,
      ...(changed && { since: now() }),
      ...(cuda !== undefined && { cuda }),
      checkedAt: now(),
    });
  };
  return {
    api: "up",
    workers: "unknown",
    since: now(),
    checking: false,
    check: async () => {
      if (get().checking) return;
      set({ checking: true });
      try {
        const health = await fetchHealth();
        update("up", health.workers.reachable ? "up" : "down", health.workers.cuda);
      } catch (err) {
        // An HTTP answer (even an error) means the api runs; only a network failure is «down».
        const status = (err as { status?: unknown } | undefined)?.status;
        if (typeof status === "number" && status > 0) update("up", "unknown");
        else update("down", "unknown");
      } finally {
        set({ checking: false });
        schedule();
      }
    },
    reportWorkersDown: () => {
      if (get().workers !== "down") update(get().api, "down");
      schedule(1000);
    },
    reportApiUnreachable: () => {
      schedule(500);
    },
    set: (s) => set({ ...s, since: now() }),
  };
});

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let users = 0;
let stopWatching: (() => void) | undefined;

/** Next check: soon when something is down, slower when all is up. */
function schedule(ms?: number): void {
  if (!started) return;
  if (timer) clearTimeout(timer);
  const s = useServiceStatusStore.getState();
  const down = s.api === "down" || s.workers === "down";
  timer = setTimeout(
    () => void useServiceStatusStore.getState().check(),
    ms ?? (down ? POLL_DOWN_MS : POLL_UP_MS),
  );
}

/**
 * Start polling and watching failed api calls (reference counted: every hook/component that needs
 * the status calls it in an effect and runs the returned function on unmount).
 */
export function startServiceStatus(): () => void {
  users++;
  if (!started) {
    started = true;
    stopWatching = watchFailedCalls();
    void useServiceStatusStore.getState().check();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users = Math.max(0, users - 1);
    if (users > 0) return;
    started = false;
    stopWatching?.();
    stopWatching = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

function watchFailedCalls(): () => void {
  let last = useBreadcrumbsStore.getState().crumbs.at(-1);
  return useBreadcrumbsStore.subscribe((state) => {
    const crumbs = state.crumbs;
    // New crumbs = after the last one seen (the buffer is a ring: compare by identity; a
    // coalesced crumb replaces the last one, then only that one is new).
    const idx = last ? crumbs.lastIndexOf(last) : -1;
    const from = idx >= 0 ? idx + 1 : last ? Math.max(0, crumbs.length - 1) : 0;
    const fresh = crumbs.slice(from);
    last = crumbs.at(-1);
    for (const c of fresh) {
      if (c.category !== "api") continue;
      const data = c.data as { code?: unknown; status?: unknown } | undefined;
      if (data?.code === "WORKERS_UNAVAILABLE")
        useServiceStatusStore.getState().reportWorkersDown();
      else if (data?.status === 0) useServiceStatusStore.getState().reportApiUnreachable();
    }
  });
}

/** What the single banner says (undefined = all up). */
export function serviceBannerKind(
  s: Pick<ServiceState, "api" | "workers">,
): "api" | "workers" | undefined {
  if (s.api === "down") return "api";
  if (s.workers === "down") return "workers";
  return undefined;
}
