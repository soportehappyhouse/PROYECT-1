import type {
  AgentPlanRecord,
  Job,
  MediaAsset,
  StyleAnalysisRecord,
  StyleApplyResponse,
  StylePreset,
  StylePresetDraft,
} from "@studio/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackRequiredDialog } from "@/components/dashboard/PackRequiredDialog";
import { PANEL_COMPONENTS } from "@/components/panels";
import { presetSummary, StylePanel } from "@/components/panels/StylePanel";
import { PANELS } from "@/lib/layout";
import { useAgentStore } from "@/stores/agent-store";
import { JOB_TYPE_LABELS, useJobsStore } from "@/stores/jobs-store";
import { useMediaStore } from "@/stores/media-store";
import { usePacksStore } from "@/stores/packs-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { CONSOLE_PASTE_EVENT, claudeStylePrompt, useStyleStore } from "@/stores/style-store";

/** Sprint 3b (web): «Perfil de estilo» panel. The api is mocked. */

type Reply = { status?: number; json?: unknown } | undefined;
type Handler = (path: string, method: string, body: unknown) => Reply;
interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    const project = useProjectStore.getState().project;
    const res =
      handler(url.pathname, method, body) ??
      (url.pathname === `/api/projects/${project.id}`
        ? { json: method === "PUT" ? body : project }
        : url.pathname === "/api/style/presets" && method === "GET"
          ? { json: [] }
          : undefined);
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
  return calls;
}

const VIDEO: MediaAsset = {
  id: "v1",
  kind: "video",
  name: "referencia.mp4",
  path: "media/v1.mp4",
  sizeBytes: 10,
  durationSec: 30,
  createdAt: "2026-10-06T10:00:00.000Z",
};

const RECORD: StyleAnalysisRecord = {
  id: "an1",
  name: "Perfil de estilo · referencia.mp4",
  path: "renders/style/j1/analysis.json",
  sourceAssetId: "v1",
  createdAt: "2026-10-06T10:01:00.000Z",
  analysis: {
    version: 1,
    duration_s: 30,
    fps: 30,
    canvas: { w: 1080, h: 1920, aspect: "9:16" },
    scenes: [
      { start: 0, end: 2 },
      { start: 2, end: 30 },
    ],
    scenes_method: "ffmpeg",
    shot_stats: {
      count: 15,
      mean_s: 2,
      median_s: 1.8,
      cuts_per_min: 28,
      histogram: [
        { max_s: 1, count: 2 },
        { max_s: 2, count: 10 },
        { max_s: null, count: 3 },
      ],
    },
    motion: {
      zoom_events: [{ t: 4, kind: "punch_in", scale: 1.2 }],
      pan_estimate: { moving_ratio: 0.1, mean_speed: 0.01, level: "static" },
    },
    audio: {
      has_audio: true,
      loudness_lufs: -14,
      speech_ratio: 0.8,
      music_detected: true,
      silence_ratio: 0.05,
    },
    text_on_screen: [{ t: 0.5, text: "RECETA FÁCIL", bbox: [0.1, 0.1, 0.8, 0.1] }],
    contact_sheet_path: "renders/style/j1/contact_sheet.png",
    thumbnails: [],
    warnings: [],
  },
};

const DRAFT: StylePresetDraft = {
  name: "Reels de cocina",
  canvas: "9:16",
  cut_rhythm: { target_shot_s: 1.8, remove_silences: true, min_silence_ms: 300 },
  captions: { style: "reels", animated: true, position: "center" },
  titles: { template: "title-card", params: { title: "RECETA FÁCIL" } },
  transitions: { type: "cut" },
  music: { duck: true, volume_db: -16 },
  export_preset: "reels-tiktok",
  notes_es: "Cortes rápidos.",
};

const job = (id: string, type: Job["type"], result: unknown, status: Job["status"] = "succeeded") =>
  ({
    id,
    type,
    status,
    progress: 1,
    payload: {},
    result,
    createdAt: "2026-10-06T10:00:00.000Z",
  }) as Job;

const initialStyle = useStyleStore.getState();
const initialAgent = useAgentStore.getState();

beforeEach(() => {
  useStyleStore.setState({ ...initialStyle, presets: [], presetsLoad: "idle" });
  useAgentStore.setState({ ...initialAgent, plans: [], undone: {} });
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
  useMediaStore.setState({ assets: { v1: VIDEO }, order: ["v1"], status: "ready" });
  useProjectStore.getState().loadProject(createEmptyProject("Demo"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function pickReference() {
  await act(async () => {
    fireEvent.change(screen.getByRole("combobox", { name: "Video de referencia" }), {
      target: { value: "v1" },
    });
  });
}

describe("Panel Perfil de estilo", () => {
  it("is a registered dockview panel and job types have labels", () => {
    expect(PANELS.find((p) => p.id === "style")?.title).toBe("Perfil de estilo");
    expect(PANEL_COMPONENTS.style).toBe(StylePanel);
    expect(JOB_TYPE_LABELS["style.analyze"]).toMatch(/analizar/);
    expect(JOB_TYPE_LABELS["style.infer"]).toMatch(/modelo local/);
  });

  it("Analizar → progress → contact sheet, shot stats, audio and OCR text", async () => {
    const calls = mockFetch((path, method) => {
      if (path === "/api/style/analyses" && method === "GET") return { json: [] };
      if (path === "/api/style/analyze") return { status: 202, json: { jobId: "j1" } };
      if (path === "/api/jobs/j1")
        return {
          json: job("j1", "style.analyze", {
            analysisId: "an1",
            path: RECORD.path,
            contactSheetPath: RECORD.analysis.contact_sheet_path,
            analysis: RECORD.analysis,
          }),
        };
      if (path === "/api/style/analyses/an1") return { json: RECORD };
      return undefined;
    });
    render(<StylePanel />);
    await pickReference();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Analizar/ }));
    });
    expect(calls.find((c) => c.path === "/api/style/analyze")?.body).toEqual({ assetId: "v1" });
    act(() =>
      useJobsStore
        .getState()
        .upsertJob({ ...job("j1", "style.analyze", undefined, "running"), progress: 0.4 }),
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    act(() => useJobsStore.getState().upsertJob(job("j1", "style.analyze", undefined)));
    const view = await screen.findByTestId("style-analysis");
    const img = within(view).getByRole("img");
    expect(img.getAttribute("src")).toContain("/files/renders/style/j1/contact_sheet.png");
    expect(view.textContent).toContain("15 · mediana 1,8 s");
    expect(view.textContent).toContain("28,0 cortes/min");
    expect(view.textContent).toContain("-14 LUFS");
    expect(view.textContent).toContain("80 %");
    expect(view.textContent).toContain("1 zoom (1 de golpe)");
    expect(view.textContent).toContain("«RECETA FÁCIL»");
  });

  it("Deducir con Consola Claude dispatches studio:console:paste with paths + save tool", async () => {
    mockFetch((path) => (path === "/api/style/analyses" ? { json: [RECORD] } : undefined));
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener(CONSOLE_PASTE_EVENT, listener);
    try {
      render(<StylePanel />);
      await pickReference();
      await screen.findByTestId("style-analysis"); // previous analysis of the same video
      fireEvent.click(screen.getByRole("button", { name: /Deducir con Consola Claude/ }));
    } finally {
      window.removeEventListener(CONSOLE_PASTE_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    const text = seen[0]!;
    expect(text).toContain("storage/renders/style/j1/contact_sheet.png");
    expect(text).toContain("storage/renders/style/j1/analysis.json");
    expect(text).toContain("studio_style_save_preset");
    expect(text).toContain('analysisId: "an1"');
    expect(text).toContain("«referencia.mp4»");
    expect(claudeStylePrompt(RECORD)).toContain("15 planos (mediana 1.8 s");
  });

  it("Deducir con modelo local: 409 PACK_REQUIRED opens the pack dialog (console hint)", async () => {
    mockFetch((path) => {
      if (path === "/api/style/analyses") return { json: [RECORD] };
      if (path === "/api/style/infer")
        return {
          status: 409,
          json: {
            error: "PACK_REQUIRED",
            packId: "vision-llm",
            name_es: "Modelo de visión local (Ollama + Qwen2.5-VL 3B)",
            size_bytes: 3_200_000_000,
            message: "Falta el modelo de visión local, o usá la Consola Claude.",
          },
        };
      if (path === "/api/ai/packs") return { json: [] };
      return undefined;
    });
    render(
      <>
        <StylePanel />
        <PackRequiredDialog />
      </>,
    );
    await pickReference();
    await screen.findByTestId("style-analysis");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Deducir con modelo local/ }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Paquete requerido" });
    expect(dialog.textContent).toContain("Modelo de visión local");
    expect(usePacksStore.getState().retries["vision-llm"]).toBeTypeOf("function");
  });

  it("local inference fills the form; saving posts the preset with its source", async () => {
    const calls = mockFetch((path, method, body) => {
      if (path === "/api/style/analyses") return { json: [RECORD] };
      if (path === "/api/style/infer") return { status: 202, json: { jobId: "j2" } };
      if (path === "/api/jobs/j2")
        return {
          json: job("j2", "style.infer", { analysisId: "an1", preset: DRAFT, warnings: [] }),
        };
      if (path === "/api/style/presets" && method === "POST")
        return { status: 201, json: { ...(body as object), id: "p1" } };
      return undefined;
    });
    render(<StylePanel />);
    await pickReference();
    await screen.findByTestId("style-analysis");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Deducir con modelo local/ }));
    });
    act(() => useJobsStore.getState().upsertJob(job("j2", "style.infer", undefined)));
    const form = await screen.findByRole("form", { name: "Perfil de estilo" });
    expect(within(form).getByDisplayValue("Reels de cocina")).toBeTruthy();
    expect(screen.getByText(/Deducido: modelo local/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Nombre"), {
      target: { value: "Cocina rápida" },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Guardar perfil" }));
    });
    const saved = calls.find((c) => c.path === "/api/style/presets" && c.method === "POST");
    expect(saved?.body).toMatchObject({
      name: "Cocina rápida",
      canvas: "9:16",
      source: { via: "local-llm", analysisId: "an1", assetId: "v1" },
    });
    const item = await screen.findByTestId("style-preset");
    expect(item.textContent).toContain("Cocina rápida");
    expect(item.textContent).toContain("modelo local");
  });

  it("manual preset: invalid values are refused before reaching the api", async () => {
    const calls = mockFetch(() => undefined);
    render(<StylePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Nuevo a mano/ }));
    const form = screen.getByRole("form", { name: "Perfil de estilo" });
    fireEvent.change(within(form).getByLabelText("Nombre"), { target: { value: " " } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Guardar perfil" }));
    });
    expect(calls.some((c) => c.path === "/api/style/presets" && c.method === "POST")).toBe(false);
    expect(screen.getByRole("form", { name: "Perfil de estilo" })).toBeTruthy();
  });

  it("Aplicar a este proyecto → plan proposed in the Asistente", async () => {
    const preset: StylePreset = { ...DRAFT, id: "p1", source: { via: "claude" } };
    const record = {
      id: "plan9",
      projectId: useProjectStore.getState().project.id,
      command: "Aplicar el perfil de estilo «Reels de cocina»",
      status: "proposed",
      created_at: "2026-10-06T10:00:00.000Z",
      ok: true,
      plan: {
        version: 1,
        summary_es: "Aplico el estilo «Reels de cocina»: lienzo 9:16, exportar con reels-tiktok.",
        ops: [
          { op: "set_canvas", preset: "9:16" },
          { op: "export", preset: "reels-tiktok", confirm: true },
        ],
      },
      resolved: [
        { op: "set_canvas", preset: "9:16" },
        { op: "export", preset: "reels-tiktok", confirm: true },
      ],
      preview_es: ["Lienzo 1080×1920", "Exportar con «Reels / TikTok»"],
      risks: ["La exportación escribe un archivo nuevo"],
      unresolved: [],
      errors: [],
      route: "deterministic",
      warnings: [],
    } as AgentPlanRecord;
    const res: StyleApplyResponse = {
      planId: "plan9",
      preview_es: record.preview_es,
      risks: record.risks,
      unresolved: [],
      notes_es: [],
      plan: record,
    };
    const calls = mockFetch((path, method) => {
      if (path === "/api/style/presets" && method === "GET") return { json: [preset] };
      if (path === "/api/style/presets/p1/apply") return { status: 201, json: res };
      return undefined;
    });
    render(<StylePanel />);
    const item = await screen.findByTestId("style-preset");
    expect(item.textContent).toContain("Consola Claude");
    await act(async () => {
      fireEvent.click(within(item).getByRole("button", { name: /Aplicar a este proyecto/ }));
    });
    const apply = calls.find((c) => c.path === "/api/style/presets/p1/apply");
    expect(apply?.body).toEqual({ projectId: useProjectStore.getState().project.id });
    // the project is saved first (the api compiles against it)
    const put = calls.findIndex((c) => c.method === "PUT");
    expect(put).toBeGreaterThanOrEqual(0);
    expect(put).toBeLessThan(calls.indexOf(apply!));
    await waitFor(() => expect(useAgentStore.getState().draft?.record.id).toBe("plan9"));
    expect(useAgentStore.getState().plans[0]?.id).toBe("plan9");
  });

  it("summarizes presets in one line", () => {
    expect(presetSummary(DRAFT)).toBe(
      "9:16 · plano ~1,8 s · silencios ≥ 300 ms · subtítulos reels animados · música -16 dB · → reels-tiktok",
    );
  });
});
