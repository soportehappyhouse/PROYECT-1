import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// jsdom lacks these browser APIs used by the dashboard.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Sprint 5 integration: AI buttons follow the service-status-store, which polls GET /api/health.
// jsdom has no api, so a failed poll would mark the api «down» mid-test and disable those buttons
// at random. Answer the health check as «all up»; every other request keeps the real fetch (tests
// that need another state spy on fetch themselves).
const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/\/api\/health(\?|$)/.test(url))
    return new Response(
      JSON.stringify({
        status: "ok",
        version: "test",
        ffmpeg: { available: true },
        workers: { reachable: true, url: "http://127.0.0.1:8001" },
        checkedAt: new Date().toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  if (!realFetch) throw new TypeError("fetch failed");
  return realFetch(input, init);
}) as typeof fetch;
