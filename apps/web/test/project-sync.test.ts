import { describe, expect, it, vi } from "vitest";
import { onPageHide, saveDebounceMs } from "@/hooks/use-project-sync";
import { flushProjectOnHide, KEEPALIVE_MAX_BYTES } from "@/lib/api-projects";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

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
