import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "@/components/panels/InspectorPanel";
import { useClipDoubleClick } from "@/hooks/use-design";
import { useProjectStore } from "@/stores/project-store";
import { motionApi, setupMotionProject, stubObjectUrls } from "./design-helpers";

describe("Motion form inside Propiedades (H13)", () => {
  beforeEach(() => stubObjectUrls());
  afterEach(() => vi.restoreAllMocks());

  it("shows the template form in Spanish with «Avanzado» folded and a still preview", async () => {
    const clip = setupMotionProject();
    const calls = motionApi();
    useProjectStore.getState().selectClip(clip.id);
    render(<InspectorPanel />);
    const section = await screen.findByTestId("inspector-motion");
    expect(screen.getAllByText("Rótulo").length).toBeGreaterThan(0);
    const style = await screen.findByRole("combobox", { name: /Estilo/ });
    const labels = [...(style as HTMLSelectElement).options].map((o) => o.textContent);
    expect(labels).toEqual(["Barra", "Caja", "Subrayado", "Dividido"]);
    const position = screen.getByRole("combobox", { name: /Posición/ }) as HTMLSelectElement;
    expect([...position.options].map((o) => o.textContent)).toContain("Abajo a la izquierda");
    // Advanced (margins, durations, format) folded.
    const adv = section.querySelector("details")!;
    expect(adv.open).toBe(false);
    expect(adv.textContent).toMatch(/Margen/);
    expect(adv.textContent).toMatch(/Formato/);
    // Token-backed props say «Del kit».
    expect(screen.getAllByText("Del kit").length).toBeGreaterThan(0);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/motion/still")).toBe(true), {
      timeout: 3000,
    });
    const still = calls.find((c) => c.path === "/api/motion/still")!;
    expect(still.body).toMatchObject({ template: "lower-third", props: { name: "Luis" } });
    // No full render happened.
    expect(calls.some((c) => c.path === "/api/motion/render")).toBe(false);
  });

  it("editing a field updates the clip (render becomes stale) without rendering", async () => {
    const clip = setupMotionProject();
    const calls = motionApi();
    useProjectStore.getState().selectClip(clip.id);
    render(<InspectorPanel />);
    const style = await screen.findByRole("combobox", { name: /Estilo/ });
    fireEvent.change(style, { target: { value: "box" } });
    const updated = useProjectStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clip.id)!;
    expect(updated.motion!.props.style).toBe("box");
    expect(updated.renderedAssetId).toBeUndefined();
    expect(calls.some((c) => c.path === "/api/motion/render")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Renderizar ahora/ }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/motion/render")).toBe(true));
  });

  it("double-click on a timeline clip opens it", () => {
    const opened: string[] = [];
    function Probe() {
      useClipDoubleClick((id) => opened.push(id));
      return (
        <div data-clip-id="clp_x">
          <span>clip</span>
        </div>
      );
    }
    render(<Probe />);
    fireEvent.doubleClick(screen.getByText("clip"));
    expect(opened).toEqual(["clp_x"]);
  });
});
