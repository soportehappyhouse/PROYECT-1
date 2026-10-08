import {
  DEFAULT_EXPORT_PRESETS,
  type AgentPlanRecord,
  type ExportJobResult,
  type Job,
} from "@studio/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExportPanel } from "@/components/panels/ExportPanel";
import { AssistantPanel } from "@/components/panels/AssistantPanel";
import { PlanChoices } from "@/components/panels/PlanChoices";
import { api } from "@/lib/api";
import { useAgentStore } from "@/stores/agent-store";
import { useExportPresetsStore } from "@/stores/export-presets-store";
import { useJobsStore } from "@/stores/jobs-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";

/** Sprint 5 (M3): Exportar «¿Dónde lo vas a publicar?», encuadre 9:16, resultado y PlanChoices. */

const now = "2026-10-08T00:00:00.000Z";

function exportJob(result: ExportJobResult, presetId = "reels-tiktok"): Job {
  return {
    id: "j-export",
    type: "project.export",
    status: "succeeded",
    progress: 1,
    payload: { presetId, projectId: useProjectStore.getState().project.id },
    projectId: useProjectStore.getState().project.id,
    result,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
  } as unknown as Job;
}

beforeEach(() => {
  const p = createEmptyProject("Horizontal");
  p.settings = { ...p.settings, width: 1920, height: 1080 };
  const video = p.tracks.find((t) => t.kind === "video")!;
  video.clips = [
    {
      id: "v1",
      trackId: video.id,
      assetId: "a1",
      start: 0,
      in: 0,
      out: 4,
      speed: 1,
      volume: 1,
      opacity: 1,
      voiceEffects: [],
    },
  ];
  useProjectStore.getState().loadProject(p);
  useExportPresetsStore.setState({
    presets: [...DEFAULT_EXPORT_PRESETS],
    source: "api",
    error: undefined,
  });
  useJobsStore.setState({ jobs: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("Exportar → Reels desde un video horizontal", () => {
  it("asks how to frame it before enabling Exportar and sends the choice", async () => {
    vi.spyOn(api, "saveProject").mockImplementation(async (x) => x);
    const exportProject = vi.spyOn(api, "exportProject").mockResolvedValue({ jobId: "j1" });
    render(<ExportPanel />);
    expect(screen.getByTestId("export-aspect-choice").textContent).toMatch(
      /El video es horizontal y «Reels \/ TikTok \(9:16\)» es 9:16/,
    );
    const button = screen.getByRole("button", { name: /^Exportar$/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId("export-blocked").textContent).toMatch(/Elegí cómo encuadrar/);

    // «Seguir la cara» without reframe keyframes: reframe first.
    fireEvent.click(screen.getByLabelText(/Seguir la cara/));
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("button", { name: /Abrir Reencuadrar/ })).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Recortar al centro/));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(exportProject).toHaveBeenCalled());
    expect(exportProject.mock.calls[0]![1]).toMatchObject({
      presetId: "reels-tiktok",
      aspectFit: "center",
      autoDuck: true,
    });
    expect(exportProject.mock.calls[0]![1]).not.toHaveProperty("normalizeLoudness");
  });

  it("YouTube 1080p on a 16:9 canvas needs no choice; Sonido offers −14 LUFS and roles", () => {
    render(<ExportPanel />);
    fireEvent.click(screen.getByTestId("export-dest-youtube-1080p"));
    expect(screen.queryByTestId("export-aspect-choice")).toBeNull();
    expect(screen.getByLabelText(/Normalizar a −14,0 LUFS/)).toBeTruthy();
    const role = screen.getByLabelText(/Rol de la pista/) as HTMLSelectElement;
    expect(role.value).toBe("");
    expect(role.options[0]!.textContent).toBe("Automático (Voz)");
    fireEvent.change(role, { target: { value: "music" } });
    const track = useProjectStore.getState().project.tracks.find((t) => t.kind === "video")!;
    expect(track.role).toBe("music");
  });

  it("result card: path, LUFS, Abrir carpeta; Revisión para redes shows Sonoridad and Formato", async () => {
    useJobsStore.setState({
      jobs: {
        "j-export": exportJob({
          path: "exports/reels-2026.mp4",
          durationS: 12.5,
          sizeBytes: 3_400_000,
          aspectFit: "blur",
          loudness: { input_i: -24, input_tp: -6, output_i: -14.04, output_tp: -1.3 },
        }),
      },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(<ExportPanel />);
    const card = screen.getByTestId("export-result");
    expect(card.textContent).toContain("exports/reels-2026.mp4");
    expect(card.textContent).toContain("−14,0 LUFS");
    expect(card.textContent).toContain("3,4 MB");
    fireEvent.click(screen.getByRole("button", { name: /Abrir carpeta/ }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/api/system/reveal");
    expect(fetchSpy.mock.calls[0]![1]?.body).toBe(
      JSON.stringify({ path: "exports/reels-2026.mp4" }),
    );
    const loud = screen.getByTestId("social-check-loudness");
    expect(loud.getAttribute("data-ok")).toBe("true");
    const format = screen.getByTestId("social-check-format");
    expect(format.getAttribute("data-ok")).toBe("false");
    expect(format.textContent).toMatch(/franjas borrosas/);
  });
});

describe("PlanChoices", () => {
  it("shows the question as buttons and loads the plan the api returns", async () => {
    const record = {
      id: "plan1",
      projectId: "p1",
      command: "Exportá para Reels",
      status: "proposed",
      created_at: now,
      model: null,
      route: "deterministic",
      latency_ms: 1,
      attempts: 1,
      warnings: [],
      ok: false,
      plan: { version: 1, summary_es: "Reels", ops: [{ op: "export", preset: "reels-tiktok" }] },
      resolved: [null],
      preview_es: ["Exportar"],
      risks: [],
      unresolved: ["Operación 1: El video es horizontal y Reels es vertical. ¿Cómo lo encuadro?"],
      errors: [],
      added: [],
      choices: [
        {
          id: "aspect",
          question_es: "El video es horizontal y Reels es vertical. ¿Cómo lo encuadro?",
          options: [
            { id: "reframe", label_es: "Seguir la cara (descarga «Reencuadre», 120 MB)" },
            { id: "center", label_es: "Recortar al centro" },
            { id: "blur", label_es: "Dejarlo entero con franjas borrosas" },
          ],
        },
      ],
    } as unknown as AgentPlanRecord;
    useAgentStore.getState().receivePlan(record);
    const answered = {
      ...record,
      ok: true,
      plan: {
        ...record.plan!,
        ops: [{ op: "export", preset: "reels-tiktok", aspect_fit: "center" }],
      },
      resolved: [{ op: "export", preset: "reels-tiktok", aspect_fit: "center", confirm: true }],
      unresolved: [],
      choices: [],
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(answered), { status: 200 }));
    render(<PlanChoices />);
    expect(screen.getByText(/¿Cómo lo encuadro\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Recortar al centro/ }));
    await waitFor(() => expect(useAgentStore.getState().draft?.record.choices).toEqual([]));
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/api/agent/plans/plan1/choose");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toEqual({
      choiceId: "aspect",
      optionId: "center",
    });
    expect(useAgentStore.getState().draft?.ops[0]).toMatchObject({ aspect_fit: "center" });
  });

  it("the Assistant shows the framing question once (buttons, not the unresolved line too)", () => {
    const question = "El video es horizontal y Reels es vertical. ¿Cómo lo encuadro?";
    useAgentStore.getState().receivePlan({
      id: "plan2",
      projectId: "p1",
      command: "Exportá para Reels",
      status: "proposed",
      created_at: now,
      model: null,
      route: "deterministic",
      latency_ms: 1,
      attempts: 1,
      warnings: [],
      ok: false,
      plan: { version: 1, summary_es: "Reels", ops: [{ op: "export", preset: "reels-tiktok" }] },
      resolved: [null],
      preview_es: ["Exportar"],
      risks: [],
      unresolved: [`Operación 1: ${question}`, "Operación 2: otra duda"],
      errors: [],
      added: [],
      choices: [
        {
          id: "aspect",
          question_es: question,
          options: [
            { id: "center", label_es: "Recortar al centro" },
            { id: "blur", label_es: "Dejarlo entero con franjas borrosas" },
          ],
        },
      ],
    } as unknown as AgentPlanRecord);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]", { status: 200 }));
    render(<AssistantPanel />);
    expect(screen.getAllByText(/¿Cómo lo encuadro\?/)).toHaveLength(1);
    expect(screen.getByText("Operación 2: otra duda")).toBeTruthy();
  });
});
