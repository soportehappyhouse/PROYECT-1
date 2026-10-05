import type { Clip, MediaAsset, Project, TtsVoiceInfo } from "@studio/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "@/components/dashboard/actions";
import { MediaPanel } from "@/components/panels/MediaPanel";
import { PreviewPanel } from "@/components/panels/PreviewPanel";
import { VoicePanel } from "@/components/panels/VoicePanel";
import { Button } from "@/components/ui/button";
import { api, ApiRequestError } from "@/lib/api";
import { canvasForVideo, orientationMismatch } from "@/lib/canvas-fit";
import { defaultShortcutMap, SHORTCUT_ACTIONS } from "@/lib/shortcuts";
import { cutClip, speechRanges } from "@/lib/silences";
import { isMotionRenderAsset, trackKindForAsset } from "@/lib/timeline";
import { useMediaStore } from "@/stores/media-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Regression tests for docs/trabajo/feedback-usuario-2026-10-05.md (web side). */

const video: MediaAsset = {
  id: "vid",
  kind: "video",
  name: "whatsapp.mp4",
  path: "media/vid.mp4",
  sizeBytes: 1,
  durationSec: 26.5,
  width: 478,
  height: 850,
  createdAt: new Date().toISOString(),
};
const render1: MediaAsset = {
  ...video,
  id: "ren",
  name: "Motion · title-card",
  path: "renders/job.webm",
  hasAlpha: true,
  durationSec: 5,
  width: 1920,
  height: 1080,
};

const clip = (p: Partial<Clip> & Pick<Clip, "id" | "trackId" | "start" | "out">): Clip => ({
  in: 0,
  speed: 1,
  volume: 1,
  opacity: 1,
  voiceEffects: [],
  ...p,
});

function load(patch: (p: Project) => void) {
  const p = createEmptyProject("Feedback");
  patch(p);
  useProjectStore.getState().loadProject(p);
}

beforeEach(() => {
  vi.restoreAllMocks();
  useProjectStore.getState().loadProject(createEmptyProject("Feedback"));
  useMediaStore.setState({
    assets: { vid: video, ren: render1 },
    order: ["vid", "ren"],
    status: "ready",
  });
});

describe("feedback 8: keyboard", () => {
  it("binds Space, J/K/L, Home and End by default (listed in the shortcuts dialog)", () => {
    const map = defaultShortcutMap();
    expect(map["playback.toggle"]).toBe("Space");
    expect(map["playback.shuttleBack"]).toBe("J");
    expect(map["playback.pause"]).toBe("K");
    expect(map["playback.shuttleForward"]).toBe("L");
    expect(map["playback.toStart"]).toBe("Home");
    expect(map["playback.toEnd"]).toBe("End");
    expect(SHORTCUT_ACTIONS.filter((a) => a.group === "Reproducción")).toHaveLength(8);
  });

  it("J/K/L shuttle: L plays and doubles, J plays backwards, K stops", () => {
    runAction("playback.shuttleForward");
    expect(useProjectStore.getState()).toMatchObject({ playing: true, playbackRate: 1 });
    runAction("playback.shuttleForward");
    expect(useProjectStore.getState().playbackRate).toBe(2);
    runAction("playback.shuttleBack");
    expect(useProjectStore.getState().playbackRate).toBe(-1);
    runAction("playback.pause");
    expect(useProjectStore.getState()).toMatchObject({ playing: false, playbackRate: 1 });
    runAction("playback.toggle");
    expect(useProjectStore.getState().playing).toBe(true);
  });
});

describe("feedback 9: tooltips", () => {
  it("shows action + shortcut on hover of an icon button", async () => {
    vi.useFakeTimers();
    render(
      <Button size="icon-sm" aria-label="Cortar en el cursor" shortcut="timeline.split">
        x
      </Button>,
    );
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Cortar en el cursor" }));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("tooltip").textContent).toBe("Cortar en el cursor (S)");
    fireEvent.pointerLeave(screen.getByRole("button", { name: "Cortar en el cursor" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
    vi.useRealTimers();
  });
});

describe("feedback 2/4: preview subtitles", () => {
  const withSubs = (animated: boolean) =>
    load((p) => {
      const v = p.tracks.find((t) => t.kind === "video")!;
      v.clips = [clip({ id: "v", trackId: v.id, assetId: "vid", start: 0, out: 26.5 })];
      p.subtitles = [{ start: 0, end: 3, text: "Hola desde WhatsApp" }];
      if (animated) {
        const m = p.tracks.find((t) => t.kind === "motion")!;
        m.clips = [
          clip({
            id: "m",
            trackId: m.id,
            start: 0,
            out: 3,
            renderedAssetId: "ren",
            motion: {
              schemaVersion: 1,
              template: "animated-captions",
              props: {},
              durationSec: 3,
              fps: 30,
              width: 1920,
              height: 1080,
              format: "webm-vp9-alpha",
              includeAudio: false,
            },
          }),
        ];
      }
    });

  it("draws the segment once, inside the pillarboxed video", () => {
    withSubs(false);
    useProjectStore.getState().setPlayhead(1);
    render(<PreviewPanel />);
    const text = screen.getByText("Hola desde WhatsApp");
    const box = text.closest("div")!;
    // 478×850 in 1920×1080 → 31.6 % wide, starting at 34.2 %
    expect(parseFloat(box.style.left)).toBeCloseTo(34.2, 0);
    expect(parseFloat(box.style.width)).toBeCloseTo(31.6, 0);
  });

  it("does not draw it under an animated-captions clip (no duplicates)", () => {
    withSubs(true);
    useProjectStore.getState().setPlayhead(1);
    render(<PreviewPanel />);
    expect(screen.queryByText("Hola desde WhatsApp")).toBeNull();
    // even when «Quemar subtítulos» is forced on, like the export
    act(() => useProjectStore.getState().setBurnSubtitles(true));
    expect(screen.queryByText("Hola desde WhatsApp")).toBeNull();
  });
});

describe("feedback 1/12: motion renders", () => {
  it("are recognised and go to Motion tracks", () => {
    expect(isMotionRenderAsset(render1)).toBe(true);
    expect(trackKindForAsset(render1)).toBe("motion");
    expect(trackKindForAsset(video)).toBe("video");
  });

  it("show a «Render» badge instead of «Sin proxy» and no proxy button", () => {
    render(<MediaPanel />);
    expect(screen.getByText(/^Render/)).toBeTruthy();
    expect(screen.getAllByText("Sin proxy")).toHaveLength(1); // only the real video
    expect(screen.getAllByRole("button", { name: "Generar proxy" })).toHaveLength(1);
  });
});

describe("feedback 11: deleting media in use", () => {
  it("offers «Quitar del timeline y borrar» and retries with force", async () => {
    load((p) => {
      const v = p.tracks.find((t) => t.kind === "video")!;
      v.clips = [clip({ id: "v", trackId: v.id, assetId: "vid", start: 0, out: 5 })];
    });
    const del = vi
      .spyOn(api, "deleteMedia")
      .mockRejectedValueOnce(
        new ApiRequestError(409, {
          error: { code: "MEDIA_IN_USE", message: "«whatsapp.mp4» se usa en el proyecto «X»." },
        }),
      )
      .mockResolvedValueOnce(undefined);
    vi.spyOn(api, "saveProject").mockImplementation(async (x) => x);
    render(<MediaPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar whatsapp.mp4" }));
    await screen.findByRole("dialog", { name: "Medio en uso" });
    fireEvent.click(screen.getByRole("button", { name: /Quitar del timeline y borrar/ }));
    await waitFor(() => expect(del).toHaveBeenLastCalledWith("vid", true));
    expect(useProjectStore.getState().project.tracks.flatMap((t) => t.clips)).toHaveLength(0);
    expect(useMediaStore.getState().assets.vid).toBeUndefined();
  });
});

describe("feedback 6: TTS voice downloads", () => {
  const voices: TtsVoiceInfo[] = [
    {
      provider: "piper",
      id: "es_AR-daniela-high",
      name: "Daniela",
      language: "es-AR",
      installed: true,
    },
  ];

  it("lists every catalog voice with «Descargar» and installs one", async () => {
    vi.spyOn(api, "config").mockResolvedValue({ providers: {} } as never);
    const list = vi.spyOn(api, "ttsVoices").mockResolvedValue(voices);
    vi.spyOn(api, "modelDownloadProgress").mockResolvedValue({ bytes: 0, active: true });
    const dl = vi.spyOn(api, "downloadModel").mockResolvedValue({
      kind: "piper",
      id: "es_MX-claude-high",
      files: [{ path: "piper/es_MX-claude-high.onnx", sizeBytes: 1, skipped: false }],
    });
    render(<VoicePanel />);
    await screen.findByText("Claude (Mexico)");
    expect(screen.getAllByRole("button", { name: /Descargar/ })).toHaveLength(7);
    expect(screen.getByText("Instalada")).toBeTruthy();
    const row = screen.getByText("Claude (Mexico)").closest("li")!;
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() =>
      expect(dl).toHaveBeenCalledWith({ kind: "piper", id: "es_MX-claude-high" }),
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2)); // reloaded after install
  });

  it("explains offline / 403 / checksum failures", async () => {
    vi.spyOn(api, "config").mockResolvedValue({ providers: {} } as never);
    vi.spyOn(api, "ttsVoices").mockResolvedValue(voices);
    vi.spyOn(api, "modelDownloadProgress").mockResolvedValue({ bytes: 0, active: false });
    const { downloadErrorMessage } = await import("@/components/panels/VoicePanel");
    const err = (code: string, message: string, status = 502) =>
      new ApiRequestError(status, { error: { code, message } });
    expect(downloadErrorMessage(err("DOWNLOAD_OFFLINE", "sin red"))).toMatch(/Sin conexión/);
    expect(downloadErrorMessage(err("DOWNLOAD_FORBIDDEN", "Hugging Face rechazó (403)"))).toMatch(
      /403/,
    );
    expect(downloadErrorMessage(err("DOWNLOAD_CHECKSUM", "checksum"))).toMatch(/checksum/);
    expect(downloadErrorMessage(err("WORKERS_UNAVAILABLE", "x", 503))).toMatch(/start\.ps1/);
  });
});

describe("feedback 4: canvas fit", () => {
  it("suggests and computes a canvas for a vertical clip", () => {
    expect(orientationMismatch({ width: 1920, height: 1080 }, video)).toBe(true);
    expect(orientationMismatch({ width: 1080, height: 1920 }, video)).toBe(false);
    expect(canvasForVideo({ width: 478, height: 850 })).toEqual({ width: 1080, height: 1920 });
    expect(canvasForVideo({ width: 3840, height: 2160 })).toEqual({ width: 3840, height: 2160 });
  });
});

describe("feedback 10: quitar silencios", () => {
  const subs = [
    {
      start: 0,
      end: 6,
      text: "hola mundo",
      words: [
        { start: 0.5, end: 1, word: " hola" },
        { start: 4, end: 4.5, word: " mundo" },
      ],
    },
  ];

  it("keeps speech ranges and packs them (ripple)", () => {
    const ranges = speechRanges(subs, 0, 10, 0.6, 0);
    expect(ranges).toEqual([
      { start: 0.5, end: 1 },
      { start: 4, end: 4.5 },
    ]);
    const c = clip({ id: "c", trackId: "t", assetId: "vid", start: 0, out: 10 });
    const { pieces, removed, map } = cutClip(c, ranges);
    expect(pieces.map((p) => [p.start, p.in, p.out])).toEqual([
      [0, 0.5, 1],
      [0.5, 4, 4.5],
    ]);
    expect(removed).toBe(9);
    expect(map(4.25)).toBeCloseTo(0.75);
    expect(map(2)).toBeUndefined();
  });

  it("cuts the selected clip in the store and moves the subtitles", () => {
    load((p) => {
      const v = p.tracks.find((t) => t.kind === "video")!;
      v.clips = [
        clip({ id: "c", trackId: v.id, assetId: "vid", start: 0, out: 10 }),
        clip({ id: "after", trackId: v.id, assetId: "vid", start: 10, out: 2 }),
      ];
      p.subtitles = subs;
    });
    const removed = useProjectStore.getState().removeSilences("c", 0.6);
    expect(removed).toBeGreaterThan(8);
    const st = useProjectStore.getState().project;
    const v = st.tracks.find((t) => t.kind === "video")!;
    expect(v.clips).toHaveLength(3);
    expect(v.clips.at(-1)!.id).toBe("after");
    expect(v.clips.at(-1)!.start).toBeCloseTo(10 - removed);
    expect(st.subtitles[0]!.words!.map((w) => +w.start.toFixed(2))).toEqual([0.08, 0.74]);
  });
});

describe("feedback 1: render link survives a lost UI intent", () => {
  it("applies result.linkedClip when the job has no setMotionRender intent", async () => {
    const { handleFinished } = await import("@/hooks/use-job-events");
    const { useJobsStore } = await import("@/stores/jobs-store");
    load((p) => {
      const m = p.tracks.find((t) => t.kind === "motion")!;
      m.clips = [clip({ id: "mc", trackId: m.id, start: 0, out: 3 })];
    });
    const projectId = useProjectStore.getState().project.id;
    const job = {
      id: "j-render",
      type: "motion.render" as const,
      status: "succeeded" as const,
      progress: 1,
      payload: {},
      createdAt: new Date().toISOString(),
      result: { assetId: "ren", path: "renders/job.webm", linkedClip: { projectId, clipId: "mc" } },
    };
    useJobsStore.setState({ jobs: { [job.id]: job }, intents: {}, handled: {} });
    vi.spyOn(api, "getJob").mockResolvedValue(job);
    await handleFinished(job);
    const c = useProjectStore.getState().project.tracks.flatMap((t) => t.clips)[0]!;
    expect(c.renderedAssetId).toBe("ren");
  });
});
