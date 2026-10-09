import { describe, expect, it, vi } from "vitest";
import { onPageHide, saveDebounceMs } from "@/hooks/use-project-sync";
import { toast } from "sonner";
import { flushProjectOnHide, KEEPALIVE_MAX_BYTES, serializeProject } from "@/lib/api-projects";
import {
  createEmptyProject,
  persistLocalProject,
  resetLocalQuotaWarning,
  useProjectStore,
} from "@/stores/project-store";

/** Sprint 5 (M2, H22): unsaved edits leave with the page (`pagehide` + keepalive). */
describe("pagehide flush", () => {
  it("PUTs the project with keepalive when there are pending changes", () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const project = createEmptyProject("Cerrar enseguida");
    expect(flushProjectOnHide(project, fetchMock as unknown as typeof fetch)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/api/projects/${project.id}$`));
    expect(init).toMatchObject({ method: "PUT", keepalive: true });
    expect(JSON.parse(init.body as string).name).toBe("Cerrar enseguida");
  });

  it("skips bodies over 64 KB (the short debounce covers them)", () => {
    const fetchMock = vi.fn();
    const big = createEmptyProject("x".repeat(10));
    big.subtitles = Array.from({ length: 2000 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: "una línea de subtítulo bastante larga para llenar el proyecto",
    }));
    expect(JSON.stringify(big).length).toBeGreaterThan(KEEPALIVE_MAX_BYTES);
    expect(flushProjectOnHide(big, fetchMock as unknown as typeof fetch)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveDebounceMs(big)).toBe(300);
    expect(saveDebounceMs(createEmptyProject())).toBe(1500);
  });

  it("onPageHide only flushes dirty projects", () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    useProjectStore.getState().loadProject(createEmptyProject("Limpio"));
    expect(onPageHide()).toBe(false);
    useProjectStore.getState().addTextClip();
    expect(useProjectStore.getState().saveState).toBe("dirty");
    expect(onPageHide()).toBe(true);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects/"),
      expect.objectContaining({ keepalive: true, method: "PUT" }),
    );
    spy.mockRestore();
  });
});

describe("serialized size and local copy (audit D6)", () => {
  it("measures UTF-8 bytes (Blob.size), not string length", () => {
    const p = createEmptyProject("ñ");
    // ~37 000 UTF-16 chars (under 64 KB) but ~74 000 bytes once encoded (ñ = 2, 🎬 = 4).
    p.subtitles = [{ start: 0, end: 1, text: "ñ".repeat(25_000) + "🎬".repeat(6_000) }];
    const json = JSON.stringify(p);
    expect(json.length).toBeLessThan(KEEPALIVE_MAX_BYTES);
    expect(serializeProject(p).bytes).toBeGreaterThan(KEEPALIVE_MAX_BYTES);
    expect(flushProjectOnHide(p, vi.fn() as unknown as typeof fetch)).toBe(false);
    expect(saveDebounceMs(p)).toBe(300);
  });

  it("stringifies each project version once", () => {
    const p = createEmptyProject("cache");
    const spy = vi.spyOn(JSON, "stringify");
    const a = serializeProject(p);
    saveDebounceMs(p);
    flushProjectOnHide(
      p,
      vi.fn(() => Promise.resolve(new Response(null))) as unknown as typeof fetch,
    );
    expect(serializeProject(p)).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("warns once when the browser storage is full", () => {
    resetLocalQuotaWarning();
    const warn = vi.spyOn(toast, "warning").mockImplementation(() => 1);
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      expect(persistLocalProject(createEmptyProject("uno"))).toBe(false);
      expect(persistLocalProject(createEmptyProject("dos"))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/espacio/);
      // Other failures (storage blocked) stay silent.
      set.mockImplementation(() => {
        throw new DOMException("no", "SecurityError");
      });
      resetLocalQuotaWarning();
      expect(persistLocalProject(createEmptyProject("tres"))).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      set.mockRestore();
      expect(persistLocalProject(createEmptyProject("cuatro"))).toBe(true);
    } finally {
      set.mockRestore();
      warn.mockRestore();
    }
  });
});
