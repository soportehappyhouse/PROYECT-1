import type { Clip, Job, Project } from "@studio/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiPacksTab } from "@/components/dashboard/AiPacksTab";
import { GpuIndicator } from "@/components/dashboard/GpuIndicator";
import { PackRequiredDialog } from "@/components/dashboard/PackRequiredDialog";
import { SilencesDialog } from "@/components/edit/SilencesDialog";
import { SocialReview } from "@/components/panels/SocialReview";
import { Ruler } from "@/components/timeline/Ruler";
import { sceneSnapTimes, scenesLookup } from "@/hooks/use-scene-markers";
import { toast } from "sonner";
import { handleFinished } from "@/hooks/use-job-events";
import { hasGpuFallback, perfEstimates } from "@/lib/ai";
import type { PackInfo, SilenceCut } from "@/lib/ai-types";
import { aiApi, packInfoFromBody } from "@/lib/api";
import { waitForJob } from "@/lib/job-runner";
import { cutsInClip, keepRanges, selectionTotals, setKindSelected } from "@/lib/cuts";
import { nextPublish, projectPublish } from "@/lib/publish";
import { clipSceneTimes, sceneMarkers, splitClipAtTimes } from "@/lib/scenes";
import { clipEnd } from "@/lib/timeline";
import { useJobsStore } from "@/stores/jobs-store";
import { usePacksStore, runWithPack } from "@/stores/packs-store";
import {
  createEmptyProject,
  loadLocalProject,
  persistLocalProject,
  useProjectStore,
} from "@/stores/project-store";
import { useScenesStore } from "@/stores/scenes-store";
import { useSilencesStore } from "@/stores/silences-store";
import { DEFAULT_PUBLISH } from "@/lib/ai-types";

/** Sprint 1 (web): packs, GPU, silences review, scenes, social review. The api is mocked. */

type Handler = (
  path: string,
  method: string,
  body: unknown,
) => { status?: number; json?: unknown } | "offline" | undefined;

function mockFetch(handler: Handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const res = handler(url.pathname, method, body);
    if (res === "offline") throw new TypeError("Failed to fetch");
    if (!res)
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "x" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    return new Response(res.json === undefined ? null : JSON.stringify(res.json), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const PACKS: PackInfo[] = [
  {
    id: "core",
    name_es: "Base",
    size_bytes: 300e6,
    installed: true,
    partial: false,
    required_by: ["transcribir", "tts"],
    license: "MIT",
    description_es: "",
    files: [],
  },
  {
    id: "whisper-turbo",
    name_es: "Whisper turbo",
    size_bytes: 1.6e9,
    installed: false,
    partial: true,
    required_by: ["transcribir"],
    license: "MIT",
    description_es: "",
    files: [],
  },
  {
    id: "scenes",
    name_es: "Detección de escenas",
    description_es: "PySceneDetect",
    size_bytes: 50e6,
    installed: false,
    partial: false,
    required_by: ["escenas"],
    license: "BSD-3-Clause",
    files: [],
  },
];

/** What the api answers (apps/api PackRequiredError.body). */
const PACK_409 = {
  status: 409,
  json: {
    error: "PACK_REQUIRED",
    packId: "scenes",
    name_es: "Detección de escenas",
    size_bytes: 50e6,
    message: "Falta el paquete de IA «Detección de escenas»",
  },
};

const clip = (p: Partial<Clip> & Pick<Clip, "id" | "trackId" | "start" | "out">): Clip => ({
  in: 0,
  speed: 1,
  volume: 1,
  opacity: 1,
  voiceEffects: [],
  ...p,
});

function loadWithVideo(c: Partial<Clip> = {}): Project {
  const p = createEmptyProject("Sprint 1");
  const video = p.tracks.find((t) => t.kind === "video")!;
  video.clips = [clip({ id: "v1", trackId: video.id, start: 0, out: 20, assetId: "a1", ...c })];
  useProjectStore.getState().loadProject(p);
  return p;
}

const job = (id: string, status: Job["status"], extra: Partial<Job> = {}): Job => ({
  id,
  type: "packs.download" as Job["type"],
  status,
  progress: 0,
  payload: {},
  createdAt: new Date().toISOString(),
  ...extra,
});

beforeEach(() => {
  vi.restoreAllMocks();
  useProjectStore.getState().loadProject(createEmptyProject("Sprint 1"));
  useJobsStore.setState({ jobs: {}, intents: {}, handled: {}, connection: "live" });
  usePacksStore.setState({
    packs: [],
    status: "idle",
    error: undefined,
    downloads: {},
    downloadErrors: {},
    request: undefined,
    retries: {},
  });
  useScenesStore.setState({ byAsset: {}, visible: true });
  useSilencesStore.setState({ clipId: undefined });
});

describe("«Paquete requerido» (409 PACK_REQUIRED)", () => {
  it("opens on any 409 PACK_REQUIRED with name, size and license", async () => {
    mockFetch((path) => {
      if (path === "/api/ai/analyze/scenes") return PACK_409;
      if (path === "/api/ai/packs") return { json: PACKS };
      return undefined;
    });
    render(<PackRequiredDialog />);
    await act(async () => {
      await aiApi.analyzeScenes("a1").catch(() => undefined);
    });
    const dialog = await screen.findByRole("dialog", { name: "Paquete requerido" });
    expect(dialog.textContent).toContain("Detección de escenas");
    expect(dialog.textContent).toContain("48 MB");
    await waitFor(() => expect(dialog.textContent).toContain("Licencia: BSD-3-Clause"));
    expect(screen.getByRole("button", { name: /Descargar/ })).toBeTruthy();
  });

  it("downloads with progress and re-runs the original action when it finishes", async () => {
    let installed = false;
    mockFetch((path, method) => {
      if (path === "/api/ai/analyze/scenes")
        return installed ? { json: { scenes: [{ start: 0, end: 4 }] } } : PACK_409;
      if (path === "/api/ai/packs") return { json: PACKS };
      if (path === "/api/ai/packs/scenes/download" && method === "POST")
        return { json: { jobId: "dl1" } };
      if (path === "/api/jobs/dl1")
        return { json: job("dl1", installed ? "succeeded" : "running") };
      return undefined;
    });
    const action = vi.fn(() => aiApi.analyzeScenes("a1"));
    render(<PackRequiredDialog />);
    let first: unknown = "pending";
    await act(async () => {
      first = await runWithPack(action);
    });
    expect(first).toBeUndefined();
    fireEvent.click(await screen.findByRole("button", { name: /Descargar/ }));
    await waitFor(() => expect(usePacksStore.getState().downloads.scenes).toBe("dl1"));
    act(() =>
      useJobsStore.getState().applyEvent({ jobId: "dl1", status: "running", progress: 0.4 }),
    );
    expect(await screen.findByText(/40 %/)).toBeTruthy();

    installed = true;
    act(() =>
      useJobsStore.getState().applyEvent({ jobId: "dl1", status: "succeeded", progress: 1 }),
    );
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("reads the pack from ApiError details too, and from a failed job's result", async () => {
    expect(
      packInfoFromBody({
        error: { code: "PACK_REQUIRED", message: "x", details: { packId: "p" } },
      }),
    ).toEqual({ packId: "p" });
    mockFetch((path) =>
      path === "/api/jobs/j9"
        ? { json: job("j9", "failed", { error: "Falta", result: PACK_409.json }) }
        : path === "/api/ai/packs"
          ? { json: PACKS }
          : undefined,
    );
    render(<PackRequiredDialog />);
    const action = () => waitForJob("j9", "analyze.silences");
    await act(async () => {
      await runWithPack(action);
    });
    expect(await screen.findByRole("dialog", { name: "Paquete requerido" })).toBeTruthy();
    expect(usePacksStore.getState().retries.scenes).toBeTypeOf("function");
  });

  it("shows the offline error with «Reintentar»", async () => {
    mockFetch((path) => {
      if (path === "/api/ai/packs/scenes/download") return "offline";
      if (path === "/api/ai/packs") return { json: PACKS };
      return undefined;
    });
    usePacksStore.getState().openRequest({ packId: "scenes", name_es: "Detección de escenas" });
    render(<PackRequiredDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Descargar/ }));
    expect(await screen.findByText(/Sin conexión con la API local/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reintentar/ })).toBeTruthy();
  });
});

describe("Ajustes → Paquetes de IA", () => {
  it("lists packs with their state, size, users and the download queue", async () => {
    mockFetch((path) => (path === "/api/ai/packs" ? { json: PACKS } : undefined));
    useJobsStore.setState({
      jobs: {
        j1: job("j1", "running", { progress: 0.5, createdAt: "2026-10-05T10:00:00Z" }),
        j2: job("j2", "queued", { createdAt: "2026-10-05T10:00:01Z" }),
      },
    });
    usePacksStore.setState({ downloads: { "whisper-turbo": "j1", scenes: "j2" } });
    render(<AiPacksTab />);
    const rows = await screen.findAllByTestId("pack-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Instalado");
    expect(rows[0]!.textContent).toContain("Verificar");
    expect(rows[0]!.textContent).toContain("Transcribir, Texto a voz");
    expect(rows[1]!.textContent).toContain("Incompleto");
    expect(rows[1]!.textContent).toContain("50 %");
    expect(rows[2]!.textContent).toContain("Falta");
    expect(rows[2]!.textContent).toContain("En cola (2.º)");
    expect(screen.getByTestId("pack-queue").textContent).toContain("1 en curso, 1 en espera");
    expect(screen.getByText(/Todavía no se midió/)).toBeTruthy();
  });

  it("derives time estimates from the performance test", () => {
    const est = perfEstimates({
      gpu: "RTX 4050",
      whisper_turbo_s_per_min: 2.5,
      piper_s_per_100chars: 0.3,
      rvc_s_per_min: 12,
      scenes_fps: 300,
      cpu_fallback_ok: true,
      ran_at: "2026-10-05T10:00:00Z",
    });
    expect(est.map((e) => [e.label, e.seconds])).toEqual([
      ["Transcribir 10 min de audio", 25],
      ["Locución de 1000 caracteres (Piper)", 3],
      ["Convertir 1 min de voz con RVC", 12],
      ["Detectar escenas en 10 min a 30 fps", 60],
    ]);
  });
});

describe("Aviso gpu_fallback_cpu", () => {
  it("a finished job whose result has warnings gpu_fallback_cpu shows a warning toast", async () => {
    expect(hasGpuFallback({ warnings: ["gpu_fallback_cpu"] })).toBe(true);
    expect(hasGpuFallback({ warnings: [] })).toBe(false);
    expect(hasGpuFallback(null)).toBe(false);
    const job: Job = {
      id: "jw1",
      type: "audio.denoise",
      status: "succeeded",
      progress: 1,
      payload: { assetId: "a1" },
      result: { assetId: "a2", path: "renders/jw1.wav", warnings: ["gpu_fallback_cpu"] },
      createdAt: "2026-10-05T10:00:00Z",
    };
    mockFetch((path) => (path === "/api/jobs/jw1" ? { json: job } : { json: [] }));
    const warn = vi.spyOn(toast, "warning");
    await handleFinished(job);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("se usó la CPU"),
      expect.objectContaining({ description: expect.stringContaining("memoria libre") }),
    );
  });
});

describe("Indicador de GPU", () => {
  it("shows GPU, free VRAM and the resident model", async () => {
    mockFetch((path) =>
      path === "/api/ai/gpu"
        ? {
            json: {
              cuda: true,
              gpu_name: "RTX 4050",
              vram_total_mb: 6144,
              vram_free_mb: 3277,
              resident_model: "whisper-turbo",
              mode: "gpu",
              sysmem_fallback: false,
            },
          }
        : undefined,
    );
    render(<GpuIndicator />);
    const btn = await screen.findByRole("button", { name: /GPU · 3,2 GB libres/ });
    expect(btn.textContent).toContain("whisper-turbo");
  });
});

describe("Quitar silencios y muletillas", () => {
  const cuts: SilenceCut[] = [
    { start: 1, end: 2.5, kind: "silence" }, // starts before clip.in = 2
    { start: 4, end: 4.4, kind: "filler", text: "eh" },
    { start: 4.2, end: 5, kind: "silence" }, // overlaps the filler
    { start: 30, end: 31, kind: "silence" }, // after clip.out
  ];
  const c = { start: 10, in: 2, out: 12, speed: 1 };

  it("maps cuts to the timeline and totals the selection (overlaps once)", () => {
    const tl = cutsInClip(c, cuts);
    expect(tl.map((x) => [x.index, x.start, x.end])).toEqual([
      [0, 10, 10.5],
      [1, 12, 12.4],
      [2, 12.2, 13],
    ]);
    const all = new Set(tl.map((x) => x.index));
    expect(selectionTotals(tl, all)).toMatchObject({
      selected: 3,
      total: 3,
      silences: 2,
      fillers: 1,
      removedSec: 1.5,
    });
    const noFillers = setKindSelected(tl, all, "filler", false);
    expect([...noFillers].sort()).toEqual([0, 2]);
    expect(selectionTotals(tl, noFillers).removedSec).toBe(1.3);
    expect(keepRanges(c, tl)).toEqual([
      { start: 10.5, end: 12 },
      { start: 13, end: 20 },
    ]);
  });

  it("maps through speed: 2× clip halves the timeline duration", () => {
    const tl = cutsInClip({ start: 0, in: 0, out: 10, speed: 2 }, [
      { start: 2, end: 3, kind: "silence" },
    ]);
    expect(tl[0]).toMatchObject({ start: 1, end: 1.5, duration: 0.5 });
  });

  it("applies locally as one undo step when the api has no apply-cuts", () => {
    loadWithVideo();
    const removed = useProjectStore.getState().applyCutsLocally("v1", [
      { start: 2, end: 3 },
      { start: 10, end: 12 },
    ]);
    expect(removed).toBeCloseTo(3);
    const clips = useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!.clips;
    expect(clips).toHaveLength(3);
    expect(clipEnd(clips[2]!)).toBeCloseTo(17);
    useProjectStore.getState().undo();
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!.clips,
    ).toHaveLength(1);
  });

  it("reviews the cuts in the dialog and applies the selected ones (local fallback)", async () => {
    loadWithVideo({ in: 0, out: 20 });
    mockFetch((path, method) => {
      if (path.startsWith("/api/projects/") && method === "PUT")
        return { json: useProjectStore.getState().project };
      if (path === "/api/ai/analyze/silences")
        return { json: { cuts: cuts.slice(0, 3), total_removed_s: 2.2 } };
      return undefined; // apply-cuts: 404 -> local edit
    });
    render(<SilencesDialog />);
    act(() => useSilencesStore.getState().open("v1"));
    fireEvent.click(screen.getByRole("button", { name: /Analizar/ }));
    const rows = await screen.findAllByTestId("cut-row");
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain("muletilla");
    expect(rows[1]!.textContent).toContain("«eh»");
    expect(screen.getByTestId("silences-totals").textContent).toContain("3 de 3 cortes");
    fireEvent.click(screen.getByRole("checkbox", { name: "Cortar 00:01.00" }));
    expect(screen.getByTestId("silences-totals").textContent).toContain("2 de 3 cortes");
    fireEvent.click(screen.getByRole("button", { name: /Aplicar 2 cortes/ }));
    await waitFor(() => expect(useSilencesStore.getState().clipId).toBeUndefined());
    const clips = useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!.clips;
    expect(clipEnd(clips[clips.length - 1]!)).toBeCloseTo(19);
    expect(useProjectStore.getState().past.length).toBe(1);
  });
});

describe("Revisión para redes (project.publish)", () => {
  it("turns the AI label on when the video becomes AI content for social media", () => {
    let p = nextPublish(DEFAULT_PUBLISH, { flags: { aiVoice: true } });
    expect(p.aiLabel).toBe(false); // not for social yet
    p = nextPublish(p, { forSocial: true });
    expect(p.aiLabel).toBe(true);
    expect(p.aiLabelText).toBe("Contenido alterado con IA");
    p = nextPublish(p, { aiLabel: false });
    p = nextPublish(p, { flags: { aiFace: true } });
    expect(p.aiLabel).toBe(false); // the user's choice stays
  });

  it("persists in the project (local storage round trip) and the UI shows the warnings", () => {
    render(<SocialReview />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Voy a subirlo a redes" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Música con derechos/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Voz generada o clonada/ }));
    expect(screen.getByText(/no será monetizable/)).toBeTruthy();
    const label = screen.getByRole("textbox", { name: "Texto de la etiqueta" });
    fireEvent.change(label, { target: { value: "Voz hecha con IA" } });

    const project = useProjectStore.getState().project;
    expect(projectPublish(project)).toMatchObject({
      forSocial: true,
      aiLabel: true,
      aiLabelText: "Voz hecha con IA",
      flags: { music: true, aiVoice: true, aiFace: false },
    });
    expect(useProjectStore.getState().saveState).toBe("dirty");
    persistLocalProject(project);
    expect(projectPublish(loadLocalProject())).toEqual(projectPublish(project));
  });
});

describe("Marcadores de escena", () => {
  const scenes = [
    { start: 0, end: 4 },
    { start: 4, end: 9 },
    { start: 9, end: 15 },
    { start: 15, end: 30 },
  ];

  it("maps scene starts inside the trimmed clip to timeline markers", () => {
    expect(clipSceneTimes({ start: 100, in: 3, out: 16, speed: 1 }, scenes)).toEqual([
      101, 106, 112,
    ]);
    const p = loadWithVideo({ in: 3, out: 16, start: 100 });
    expect(sceneMarkers(p, () => scenes).map((m) => m.time)).toEqual([101, 106, 112]);
  });

  it("splits the clip at the markers in one undo step", () => {
    const pieces = splitClipAtTimes(
      clip({ id: "x", trackId: "t", start: 0, out: 20 }),
      [9, 4, 15, 25],
    );
    expect(pieces.map((c) => [c.start, c.in, c.out])).toEqual([
      [0, 0, 4],
      [4, 4, 9],
      [9, 9, 15],
      [15, 15, 20],
    ]);
    loadWithVideo();
    expect(useProjectStore.getState().splitAtTimes("v1", [4, 9, 15])).toBe(3);
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!.clips,
    ).toHaveLength(4);
    useProjectStore.getState().undo();
    expect(
      useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!.clips,
    ).toHaveLength(1);
  });

  it("draws markers on the ruler and snaps to them only while shown", () => {
    loadWithVideo();
    useScenesStore.getState().setScenes("a1", scenes);
    expect(scenesLookup()("a1")).toHaveLength(4);
    expect(sceneSnapTimes()).toEqual([4, 9, 15]);
    render(
      <Ruler
        zoom={10}
        duration={30}
        onSeek={() => undefined}
        markers={[{ time: 4, clipId: "v1" }]}
      />,
    );
    expect(screen.getAllByTestId("scene-marker")).toHaveLength(1);
    useScenesStore.getState().toggleVisible();
    expect(sceneSnapTimes()).toEqual([]);
  });
});
