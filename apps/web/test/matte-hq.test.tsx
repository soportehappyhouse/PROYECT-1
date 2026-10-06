import type { Clip, Job, MediaAsset, Project } from "@studio/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matteOptions, samMaskFor, VisionDialogs } from "@/components/vision/VisionDialogs";
import { rvmHqFpsLabel } from "@/lib/ai";
import { useJobsStore } from "@/stores/jobs-store";
import { useMaskStore } from "@/stores/mask-store";
import { useMediaStore } from "@/stores/media-store";
import { usePacksStore } from "@/stores/packs-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { useVisionStore } from "@/stores/vision-store";

/** Sprint 3b «Quitar fondo» de calidad alta (web): selector, bordes, máscara SAM, antes/después. */

const now = new Date().toISOString();
const asset = (p: Partial<MediaAsset> & Pick<MediaAsset, "id" | "kind">): MediaAsset => ({
  name: p.id,
  path: `media/${p.id}`,
  sizeBytes: 1,
  createdAt: now,
  ...p,
});
const ASSETS: Record<string, MediaAsset> = {
  person: asset({ id: "person", kind: "video", name: "Persona", width: 1920, height: 1080 }),
  mask1: asset({ id: "mask1", kind: "mask", name: "Máscara · Persona", path: "masks/j1" }),
  alpha: asset({ id: "alpha", kind: "video", hasAlpha: true }),
};

function project(): Project {
  const p = createEmptyProject("HQ");
  const video = p.tracks[0]!;
  const c: Clip = {
    id: "v1",
    trackId: video.id,
    start: 0,
    in: 0,
    out: 5,
    speed: 1,
    volume: 1,
    opacity: 1,
    voiceEffects: [],
    assetId: "person",
  };
  video.clips = [c];
  return p;
}

const job = (id: string, status: Job["status"], extra: Partial<Job> = {}): Job =>
  ({
    id,
    type: "vision.matte",
    status,
    progress: status === "succeeded" ? 1 : 0,
    createdAt: now,
    updatedAt: now,
    payload: {},
    ...extra,
  }) as Job;

beforeEach(() => {
  useMediaStore.setState({ assets: { ...ASSETS }, order: Object.keys(ASSETS), status: "ready" });
  useProjectStore.getState().loadProject(project());
  useVisionStore.setState({ matteDialog: undefined, matteCompare: undefined, busy: {} });
  useMaskStore.setState({ assetId: undefined, result: undefined });
  usePacksStore.setState({ packs: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Quitar fondo: Rápido / Alta calidad", () => {
  it("«Alta calidad» sets the edge defaults, sends quality + refine + SAM mask, shows before/after", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      const method = (init?.method ?? "GET").toUpperCase();
      const reply = (status: number, json: unknown) =>
        new Response(JSON.stringify(json), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/api/ai/vision/matte" && method === "POST") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return reply(202, { jobId: "jm" });
      }
      if (url.pathname === "/api/jobs/jm")
        return reply(
          200,
          job("jm", "succeeded", {
            result: {
              assetId: "alpha",
              path: "renders/jm.webm",
              sourceAssetId: "person",
              quality: "high",
              previewComparePath: "renders/jm.compare.png",
              halo: { before: 20, after: 8 },
            },
          }),
        );
      if (url.pathname.startsWith("/api/projects")) return reply(200, project());
      return reply(200, {});
    });
    usePacksStore.setState({
      packs: [
        {
          id: "matting-hq",
          name_es: "Recorte de calidad alta",
          installed: false,
        } as never,
      ],
    });
    render(<VisionDialogs />);
    act(() => useVisionStore.getState().openMatte({ clipId: "v1" }));
    const feather = () => screen.getByLabelText("Suavizado de borde") as HTMLInputElement;
    const erode = () => screen.getByLabelText("Reducción de borde") as HTMLInputElement;
    const despill = () => screen.getByLabelText("Eliminar halos de color") as HTMLInputElement;
    const sam = () => screen.getByLabelText(/Usar máscara SAM si existe/) as HTMLInputElement;
    expect([feather().value, erode().value, despill().checked]).toEqual(["0", "0", false]);
    expect(sam().disabled).toBe(false); // «Máscara · Persona» exists in Medios
    fireEvent.change(screen.getByLabelText("Calidad del recorte"), { target: { value: "high" } });
    expect([feather().value, erode().value, despill().checked]).toEqual(["0.7", "1", true]);
    expect(screen.getByText(/Necesita el paquete «Recorte de calidad alta»/)).toBeTruthy();
    fireEvent.change(feather(), { target: { value: "1.5" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Quitar fondo" }));
      await vi.waitFor(() => expect(bodies).toHaveLength(1));
      await vi.waitFor(() => expect(useVisionStore.getState().busy.matte).toBe("jm"));
      useJobsStore.getState().upsertJob(job("jm", "succeeded"));
      await vi.waitFor(() => expect(useVisionStore.getState().matteCompare).toBeDefined());
    });
    expect(bodies[0]).toMatchObject({
      assetId: "person",
      model: "rvm",
      quality: "high",
      refine: { feather: 1.5, erode: 1, despill: true },
      maskAssetId: "mask1",
    });
    act(() => useVisionStore.getState().openMatte({ clipId: "v1" }));
    const img = screen.getByAltText("Comparación antes y después del recorte") as HTMLImageElement;
    expect(img.src).toContain("/files/renders/jm.compare.png");
    expect(screen.getByTestId("matte-compare").textContent).toContain("20,0 → 8,0 (−60 %)");
  });

  it("«Rápido» with the defaults keeps the sprint 2 request; mask lookup prefers the session", () => {
    const d = { erode: 0, feather: 0, despill: false };
    expect(matteOptions("fast", d)).toEqual({});
    expect(matteOptions("fast", { ...d, despill: true })).toEqual({
      refine: { erode: 0, feather: 0, despill: true },
    });
    expect(matteOptions("high", { erode: 1, feather: 0.7, despill: true }, "m")).toEqual({
      quality: "high",
      refine: { erode: 1, feather: 0.7, despill: true },
      maskAssetId: "m",
    });
    const a = ASSETS.person!;
    expect(samMaskFor(a, ASSETS, { assetId: "person", result: { maskAssetId: "live" } })).toBe(
      "live",
    );
    expect(samMaskFor(a, ASSETS, { assetId: "other" })).toBe("mask1");
    expect(samMaskFor({ id: "x", name: "Otro" }, ASSETS, {})).toBeUndefined();
  });

  it("perf table label «Recorte alta calidad ≈ X fps»", () => {
    expect(rvmHqFpsLabel({})).toBeUndefined();
    expect(
      rvmHqFpsLabel({ rvm_hq_steady_fps: 24.62, rvm_hq_startup_s: 6.21, rvm_hq_downsample: 0.375 }),
    ).toBe("≈ 24,6 fps sostenido (arranque 6,2 s) · reducción 0,375");
    expect(rvmHqFpsLabel({ rvm_hq_fps: 9 })).toBe("≈ 9,0 fps");
  });
});
