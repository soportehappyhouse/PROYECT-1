import type { Job, MediaAsset, Project, StemsResult } from "@studio/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StemsSection } from "@/components/panels/VoicePanel";
import { CPU_PREFLIGHT_MESSAGE } from "@/lib/gpu-preflight";
import { jobTypeLabel, useJobsStore } from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { usePacksStore } from "@/stores/packs-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { stemsSummary, useStemsStore } from "@/stores/stems-store";

/** Sprint 3b §C (web): «Separar audio» in Voz y audio. The api is mocked. */

type Reply = { status?: number; json?: unknown } | undefined;
const calls: { method: string; path: string; body: unknown }[] = [];

function mockFetch(handler: (path: string, method: string, body: unknown) => Reply) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, body });
    const res = handler(url.pathname, method, body);
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

const ASSET: MediaAsset = {
  id: "a1",
  kind: "video",
  name: "Entrevista",
  path: "media/a1.mp4",
  mimeType: "video/mp4",
  sizeBytes: 1,
  durationSec: 10,
  hasAudio: true,
  hasVideo: true,
  createdAt: new Date().toISOString(),
} as MediaAsset;

function setupProject(): Project {
  const base = createEmptyProject("Stems");
  const video = base.tracks.find((t) => t.kind === "video")!;
  const project: Project = {
    ...base,
    tracks: base.tracks.map((t) =>
      t.id === video.id
        ? {
            ...t,
            clips: [
              {
                id: "c1",
                trackId: t.id,
                assetId: "a1",
                start: 1,
                in: 0,
                out: 8,
                speed: 1,
                volume: 1,
                opacity: 1,
                voiceEffects: [],
              },
            ],
          }
        : t,
    ),
  };
  useProjectStore.getState().loadProject(project);
  useProjectStore.getState().selectClip("c1");
  return project;
}

/** The project as the api leaves it after the separation. */
function separated(p: Project): Project {
  const video = p.tracks.find((t) => t.kind === "video")!;
  const audio = (id: string, name: string, assetId: string) => ({
    id,
    kind: "audio" as const,
    name,
    muted: false,
    locked: false,
    hidden: false,
    clips: [
      {
        id: `${id}-c`,
        trackId: id,
        assetId,
        start: 1,
        in: 0,
        out: 8,
        speed: 1,
        volume: 1,
        opacity: 1,
        voiceEffects: [],
      },
    ],
  });
  return {
    ...p,
    tracks: [
      { ...video, clips: video.clips.map((c) => ({ ...c, volume: 0 })) },
      audio("tv", "Voz", "s-v"),
      audio("tm", "Música", "s-m"),
      ...p.tracks.filter((t) => t.id !== video.id),
    ],
  };
}

const RESULT: StemsResult = {
  mode: "two",
  sourceAssetId: "a1",
  stems: [
    { name: "vocals", label: "Voz", assetId: "s-v", path: "renders/x-vocals.wav", trackId: "tv" },
    { name: "no_vocals", label: "Música", assetId: "s-m", path: "renders/x-no.wav", trackId: "tm" },
  ],
  sampleRate: 44100,
  device: "cpu",
  sourceClipId: "c1",
  previousVolume: 1,
  undoSnapshotId: "snap1",
};

function finishedJob(result: unknown): Job {
  return {
    id: "j1",
    type: "audio.stems",
    status: "succeeded",
    progress: 1,
    payload: {},
    result,
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
  useJobsStore.setState({ jobs: {}, intents: {}, handled: {}, connection: "live" });
  useStemsStore.setState({ mode: "two", run: undefined, undoConflict: undefined });
  useMediaStore.setState({ assets: { a1: ASSET }, order: ["a1"], status: "ready" });
  usePacksStore.setState({ request: undefined, retries: {} });
});

describe("Separar audio (stems)", () => {
  it("labels the job and summarizes the result", () => {
    expect(jobTypeLabel("audio.stems")).toBe("Separar audio (stems)");
    expect(stemsSummary(RESULT)).toBe(
      "Pistas nuevas: «Voz», «Música». El clip original quedó silenciado.",
    );
    expect(stemsSummary({ stems: RESULT.stems })).toMatch(/^Audios nuevos en Media/);
  });

  it("runs on the selected clip (CPU warning, 4 stems), adopts the tracks and undoes", async () => {
    const original = setupProject();
    const after = separated(original);
    const warn = vi.spyOn(toast, "warning");
    const success = vi.spyOn(toast, "success");
    mockFetch((path, method) => {
      if (path === `/api/projects/${original.id}` && method === "PUT") return { json: original };
      if (path === `/api/projects/${original.id}`) return { json: after };
      if (path === "/api/ai/gpu")
        return { json: { cuda: false, mode: "cpu", vram_free_mb: null, resident_model: null } };
      if (path === "/api/audio/stems") {
        setTimeout(() => useJobsStore.getState().upsertJob(finishedJob(RESULT)), 5);
        return { status: 202, json: { jobId: "j1" } };
      }
      if (path === "/api/jobs/j1") return { json: finishedJob(RESULT) };
      if (path === "/api/media") return { json: [ASSET] };
      if (path === "/api/audio/stems/undo") return { json: { project: original } };
      return undefined;
    });
    render(<StemsSection />);
    fireEvent.change(screen.getByLabelText("Modo de separación"), { target: { value: "four" } });
    fireEvent.click(screen.getByRole("button", { name: /Separar audio/ }));
    await screen.findByTestId("stems-result");
    expect(warn).toHaveBeenCalledWith(CPU_PREFLIGHT_MESSAGE, expect.anything());
    const post = calls.find((c) => c.path === "/api/audio/stems");
    expect(post?.body).toEqual({ clipId: "c1", mode: "four", target: { projectId: original.id } });
    expect(useProjectStore.getState().project.tracks.map((t) => t.name)).toContain("Música");
    expect(success).toHaveBeenCalledWith("Audio separado", expect.anything());

    fireEvent.click(screen.getByRole("button", { name: /Deshacer separación/ }));
    await screen.findByText("Separación deshecha.");
    expect(calls.find((c) => c.path === "/api/audio/stems/undo")?.body).toEqual({
      undoSnapshotId: "snap1",
    });
    const names = useProjectStore.getState().project.tracks.map((t) => t.name);
    expect(names).not.toContain("Música");
  });

  it("PACK_REQUIRED opens the pack dialog; nothing stays running", async () => {
    setupProject();
    mockFetch((path, method) => {
      if (path.startsWith("/api/projects/") && method === "PUT")
        return { json: useProjectStore.getState().project };
      if (path === "/api/ai/gpu") return { json: { cuda: true, mode: "gpu", vram_free_mb: 5000 } };
      if (path === "/api/audio/stems")
        return {
          status: 409,
          json: {
            error: "PACK_REQUIRED",
            packId: "stems",
            name_es: "Separar audio (Demucs htdemucs)",
            size_bytes: 86e6,
          },
        };
      return undefined;
    });
    await useStemsStore.getState().separate("c1");
    expect(usePacksStore.getState().request?.info.packId).toBe("stems");
    expect(usePacksStore.getState().retries.stems).toBeTypeOf("function");
    expect(useStemsStore.getState().run).toBeUndefined();
  });

  it("an undo after later edits asks before restoring (force)", async () => {
    const original = setupProject();
    useStemsStore.setState({
      run: { clipId: "c1", mode: "two", status: "done", jobId: "j1", result: RESULT },
    });
    mockFetch((path, _m, body) => {
      if (path === "/api/audio/stems/undo")
        return (body as { force?: boolean }).force
          ? { json: { project: original } }
          : {
              status: 409,
              json: { error: { code: "PROJECT_CHANGED", message: "El proyecto cambió" } },
            };
      if (path === "/api/media") return { json: [ASSET] };
      return undefined;
    });
    render(<StemsSection />);
    fireEvent.click(screen.getByRole("button", { name: /Deshacer separación/ }));
    await screen.findByText("El proyecto cambió");
    fireEvent.click(screen.getByRole("button", { name: "Deshacer igual" }));
    await waitFor(() => expect(useStemsStore.getState().run?.status).toBe("undone"));
    expect(calls.filter((c) => c.path === "/api/audio/stems/undo").at(-1)?.body).toEqual({
      undoSnapshotId: "snap1",
      force: true,
    });
  });
});
