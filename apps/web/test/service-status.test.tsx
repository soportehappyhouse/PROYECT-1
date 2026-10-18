import { API_DOWN_ES, WORKERS_DOWN_ES } from "@studio/shared";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceBanner } from "@/components/dashboard/ServiceBanner";
import { aiAvailability, OLLAMA_DOWN_ES, useAiAvailability } from "@/hooks/use-ai-availability";
import { addBreadcrumb } from "@/stores/breadcrumbs-store";
import {
  serviceBannerKind,
  startServiceStatus,
  useServiceStatusStore,
} from "@/stores/service-status-store";

/** Sprint 5 (M1, H4): service status store, the single banner and useAiAvailability. */

let health: "ok" | "workers-down" | "network" = "ok";

beforeEach(() => {
  health = "ok";
  useServiceStatusStore.setState({ api: "up", workers: "unknown", checking: false });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    if (health === "network") throw new TypeError("fetch failed");
    if (url.pathname === "/api/health")
      return new Response(
        JSON.stringify({
          status: health === "ok" ? "ok" : "degraded",
          version: "0.1.0",
          ffmpeg: { available: true },
          workers: { reachable: health === "ok", url: "http://127.0.0.1:8001" },
          checkedAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("service-status-store", () => {
  it("transitions up → workers down → api down → up", async () => {
    const s = useServiceStatusStore.getState();
    await s.check();
    expect(useServiceStatusStore.getState()).toMatchObject({ api: "up", workers: "up" });
    health = "workers-down";
    await s.check();
    expect(useServiceStatusStore.getState()).toMatchObject({ api: "up", workers: "down" });
    expect(serviceBannerKind(useServiceStatusStore.getState())).toBe("workers");
    health = "network";
    await s.check();
    expect(useServiceStatusStore.getState().api).toBe("down");
    expect(serviceBannerKind(useServiceStatusStore.getState())).toBe("api");
    health = "ok";
    await s.check();
    expect(serviceBannerKind(useServiceStatusStore.getState())).toBeUndefined();
  });

  it("an api answer WORKERS_UNAVAILABLE marks the workers down at once", () => {
    const stop = startServiceStatus();
    useServiceStatusStore.setState({ api: "up", workers: "up" });
    addBreadcrumb("api", "POST /api/x → 503", { status: 503, code: "WORKERS_UNAVAILABLE" });
    expect(useServiceStatusStore.getState().workers).toBe("down");
    stop();
  });
});

describe("ServiceBanner", () => {
  it("shows one banner with start.cmd and disappears when all is up", async () => {
    health = "workers-down";
    render(
      <>
        <ServiceBanner />
        <ServiceBanner />
      </>,
    );
    await act(async () => {
      await useServiceStatusStore.getState().check();
    });
    const banners = screen.getAllByTestId("service-banner");
    // Mounted twice by mistake → still the same text; the Dashboard mounts it once.
    expect(banners[0]!.textContent).toContain(WORKERS_DOWN_ES);
    expect(banners[0]!.textContent).toContain("scripts\\windows\\start.cmd");
    expect(banners[0]!.textContent).not.toMatch(/TypeError|ECONNREFUSED|start\.ps1/);
    await act(async () => {
      screen.getAllByRole("button", { name: /Cómo iniciarla/ })[0]!.click();
    });
    expect(screen.getByTestId("service-help").textContent).toContain("start.cmd");
    health = "ok";
    await act(async () => {
      await useServiceStatusStore.getState().check();
    });
    expect(screen.queryByTestId("service-banner")).toBeNull();
  });
});

describe("useAiAvailability", () => {
  it("rule: api down > workers down > ollama", () => {
    expect(aiAvailability("transcribe", { api: "down", workers: "up" })).toEqual({
      enabled: false,
      reason_es: API_DOWN_ES,
    });
    expect(aiAvailability("transcribe", { api: "up", workers: "down" })).toEqual({
      enabled: false,
      reason_es: WORKERS_DOWN_ES,
    });
    expect(aiAvailability("ollama", { api: "up", workers: "up", ollama: false })).toEqual({
      enabled: false,
      reason_es: OLLAMA_DOWN_ES,
    });
    expect(aiAvailability("workers", { api: "up", workers: "unknown" })).toEqual({ enabled: true });
  });

  it("disables a button with the reason as tooltip", async () => {
    health = "workers-down";
    function Probe() {
      const a = useAiAvailability("transcribe");
      return (
        <button type="button" disabled={!a.enabled} title={a.reason_es}>
          Transcribir
        </button>
      );
    }
    render(<Probe />);
    await act(async () => {
      await useServiceStatusStore.getState().check();
    });
    const button = screen.getByRole("button", { name: "Transcribir" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(WORKERS_DOWN_ES);
  });
});
