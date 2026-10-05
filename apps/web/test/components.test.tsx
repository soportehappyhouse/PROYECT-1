import { DEFAULT_EXPORT_PRESETS, EXTRA_EXPORT_PRESETS, type Job } from "@studio/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "@/components/panels/ExportPanel";
import { InspectorPanel } from "@/components/panels/InspectorPanel";
import { JobsPanel } from "@/components/panels/JobsPanel";
import { MotionPanel } from "@/components/panels/MotionPanel";
import { NotImplementedNotice } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useJobsStore } from "@/stores/jobs-store";
import { useExportPresetsStore } from "@/stores/export-presets-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

function job(partial: Partial<Job> & Pick<Job, "id" | "type" | "status">): Job {
  return { progress: 0, payload: {}, createdAt: new Date().toISOString(), ...partial };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useProjectStore.getState().loadProject(createEmptyProject("Demo"));
  useJobsStore.setState({ jobs: {}, intents: {}, handled: {}, connection: "live" });
});

describe("JobsPanel", () => {
  it("renders jobs with progress, errors and actions", () => {
    useJobsStore.setState({
      jobs: {
        a: job({
          id: "a",
          type: "project.export",
          status: "running",
          progress: 0.42,
          message: "Codificando",
        }),
        b: job({ id: "b", type: "voice.tts", status: "failed", error: "Piper no instalado" }),
        c: job({
          id: "c",
          type: "motion.render",
          status: "succeeded",
          result: { path: "renders/c.webm" },
        }),
      },
    });
    render(<JobsPanel />);
    expect(screen.getAllByTestId("job-row")).toHaveLength(3);
    expect(screen.getByText("Exportación")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Piper no instalado")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar trabajo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abrir resultado" })).toBeTruthy();
    expect(screen.getByText("En vivo")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Activos" }));
    expect(screen.getAllByTestId("job-row")).toHaveLength(1);
  });

  it("shows 'módulo en desarrollo' when the jobs stream is 501", () => {
    useJobsStore.setState({ connection: "not-implemented" });
    render(<JobsPanel />);
    expect(screen.getByText("Módulo en desarrollo")).toBeTruthy();
  });

  it("cancels a running job through the store", () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    useJobsStore.setState({
      cancel,
      jobs: { a: job({ id: "a", type: "voice.rvc", status: "queued" }) },
    });
    render(<JobsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar trabajo" }));
    expect(cancel).toHaveBeenCalledWith("a");
  });
});

describe("InspectorPanel", () => {
  it("shows project settings when nothing is selected", () => {
    render(<InspectorPanel />);
    expect(screen.getByDisplayValue("Demo")).toBeTruthy();
  });

  it("edits the selected text clip", () => {
    const clip = useProjectStore.getState().addTextClip({ text: "Hola", start: 0 });
    render(<InspectorPanel />);
    const textarea = screen.getByLabelText("Texto");
    fireEvent.change(textarea, { target: { value: "Adiós" } });
    const updated = useProjectStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clip.id);
    expect(updated?.text).toBe("Adiós");
  });
});

describe("NotImplementedNotice", () => {
  it("renders the Spanish notice", () => {
    render(<NotImplementedNotice what="La lista de voces" />);
    expect(screen.getByRole("status").textContent).toContain("Módulo en desarrollo");
  });
});

describe("media drop on the timeline", () => {
  it("adds the dropped asset at the pointer time on the target track", async () => {
    const { handleAssetDrop } = await import("@/components/dashboard/Dashboard");
    const track = useProjectStore.getState().project.tracks.find((t) => t.kind === "audio")!;
    const asset = {
      id: "a1",
      kind: "audio" as const,
      name: "boom.wav",
      path: "media/a1.wav",
      sizeBytes: 10,
      durationSec: 2,
      createdAt: new Date().toISOString(),
    };
    handleAssetDrop({
      active: {
        id: "asset:a1",
        data: { current: { type: "asset", asset } },
        rect: { current: { initial: null, translated: null } },
      },
      over: {
        id: `track:${track.id}`,
        rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 },
        disabled: false,
        data: { current: { trackId: track.id, kind: "audio", timeAt: (x: number) => x / 100 } },
      },
      activatorEvent: new MouseEvent("pointerdown", { clientX: 100 }),
      delta: { x: 250, y: 0 },
    });
    const clip = useProjectStore.getState().project.tracks.find((t) => t.id === track.id)!.clips[0];
    expect(clip).toMatchObject({ assetId: "a1", start: 3.5, out: 2 });
  });
});

describe("MotionPanel engines (B2)", () => {
  it("reads `ok` from /api/motion/engines and disables templates of a stub engine", async () => {
    vi.spyOn(api, "motionEngines").mockResolvedValue([
      { id: "remotion", displayName: "Remotion", ok: true },
      { id: "motion-canvas", displayName: "Motion Canvas", ok: false, reason: "no implementado" },
    ]);
    vi.spyOn(api, "motionTemplates").mockResolvedValue([
      {
        engine: "remotion",
        id: "title-card",
        name: "Título",
        defaultProps: {},
        defaultDurationSec: 3,
        supportsAlpha: true,
      },
      {
        engine: "motion-canvas",
        id: "hello-circle",
        name: "Círculo",
        defaultProps: {},
        defaultDurationSec: 2,
        supportsAlpha: false,
      },
    ]);
    render(<MotionPanel />);
    const stub = await screen.findByRole("option", { name: /Círculo · motion-canvas/ });
    await waitFor(() => expect((stub as HTMLOptionElement).disabled).toBe(true));
    expect(stub.textContent).toContain("(no disponible)");
    const ok = screen.getByRole("option", { name: /Título · remotion/ }) as HTMLOptionElement;
    expect(ok.disabled).toBe(false);
    expect(screen.getByText("Remotion").className).not.toBe(
      screen.getByText("Motion Canvas").className,
    );
  });
});

describe("ExportPanel presets (B5)", () => {
  it("starts on YouTube 1080p and shows GIF container/codec for the GIF preset", () => {
    const gifFirst = [...DEFAULT_EXPORT_PRESETS, ...EXTRA_EXPORT_PRESETS].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    useExportPresetsStore.setState({ presets: gifFirst, source: "api", error: undefined });
    render(<ExportPanel />);
    const preset = screen.getByLabelText("Preset de exportación") as HTMLSelectElement;
    expect(preset.value).toBe("youtube-1080p");
    fireEvent.change(preset, { target: { value: "gif-480" } });
    expect((screen.getByLabelText("Contenedor") as HTMLSelectElement).value).toBe("gif");
    expect((screen.getByLabelText("Códec de video") as HTMLSelectElement).value).toBe("gif");
  });
});

describe("ExportPanel burn subtitles (manual bug 2)", () => {
  it("defaults to not burning when an animated-captions clip exists and sends the flag", async () => {
    const p = createEmptyProject("Subs");
    p.subtitles = [{ start: 0, end: 2, text: "Hola" }];
    const motion = p.tracks.find((t) => t.kind === "motion")!;
    motion.clips = [
      {
        id: "m1",
        trackId: motion.id,
        start: 0,
        in: 0,
        out: 2,
        speed: 1,
        volume: 1,
        opacity: 1,
        voiceEffects: [],
        motion: {
          engine: "remotion",
          template: "animated-captions",
          props: {},
          durationSec: 2,
          fps: 30,
          width: 1920,
          height: 1080,
          format: "webm-vp9-alpha",
          includeAudio: false,
        },
      },
    ];
    useProjectStore.getState().loadProject(p);
    useExportPresetsStore.setState({
      presets: [...DEFAULT_EXPORT_PRESETS],
      source: "api",
      error: undefined,
    });
    vi.spyOn(api, "saveProject").mockImplementation(async (x) => x);
    const exportProject = vi.spyOn(api, "exportProject").mockResolvedValue({ jobId: "j1" });
    render(<ExportPanel />);
    const burn = screen.getByLabelText(/Quemar subtítulos/) as HTMLInputElement;
    expect(burn.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Exportar/ }));
    await waitFor(() => expect(exportProject).toHaveBeenCalled());
    expect(exportProject.mock.calls[0]![1]).toMatchObject({
      presetId: "youtube-1080p",
      burnSubtitles: false,
    });
    fireEvent.click(burn);
    expect(burn.checked).toBe(true);
    // Stored in the project (the preview reads it too); covered segments are still not doubled.
    expect(useProjectStore.getState().project.burnSubtitles).toBe(true);
    expect(screen.getByText("salvo bajo los animados")).toBeTruthy();
  });
});
