import type { AgentPlanRecord, Job } from "@studio/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "@/components/dashboard/actions";
import { AssistantTab, modelOptions } from "@/components/dashboard/AssistantTab";
import { PackRequiredDialog } from "@/components/dashboard/PackRequiredDialog";
import { AssistantPanel } from "@/components/panels/AssistantPanel";
import { ReportDialog } from "@/components/report/ReportDialog";
import {
  appendAnswers,
  buildApplyRequest,
  composeSteps,
  confirmDestructiveLabel,
  destructiveIndexes,
  editableParams,
  navigateHistory,
  normalizeEvalResults,
  opRunStates,
  parseAgentTime,
  parseDraftedReport,
  pushHistory,
} from "@/lib/agent";
import { normalizePlanRecord } from "@/lib/agent-api";
import { isLlamaModel } from "@/lib/agent-types";
import { PANELS } from "@/lib/layout";
import { SHORTCUT_ACTIONS } from "@/lib/shortcuts";
import { useAgentStore } from "@/stores/agent-store";
import { JOB_TYPE_LABELS, jobLabel, useJobsStore } from "@/stores/jobs-store";
import { usePacksStore } from "@/stores/packs-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { openReport, useReportStore } from "@/stores/report-store";

/** Sprint 3 (web): local assistant panel, settings, bug report drafting. The api is mocked. */

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
    calls.push({ path: url.pathname, method, body });
    const project = useProjectStore.getState().project;
    const res =
      handler(url.pathname, method, body) ??
      (url.pathname === `/api/projects/${project.id}`
        ? { json: method === "PUT" ? body : project }
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

const READY = {
  workers: true,
  ollama: true,
  model: "qwen3:8b",
  models_installed: ["qwen3:8b", "llama3.1:8b"],
  ready: true,
  gpu_mode: "gpu",
  pack: { id: "agent-llm", installed: true },
};

function plan(p: Partial<AgentPlanRecord> = {}): AgentPlanRecord {
  return {
    id: "plan1",
    projectId: useProjectStore.getState().project.id,
    command: "Poné un título 'Hola' en el segundo 3, borrá el último clip y exportá",
    status: "proposed",
    created_at: "2026-10-05T10:00:00.000Z",
    ok: true,
    plan: {
      version: 1,
      summary_es: "Agrego un título, borro el último clip y exporto para TikTok.",
      ops: [
        { op: "add_text", text: "Hola", t: 3, duration_s: 3 },
        { op: "delete_clip", clip: { index: -1 } },
        { op: "export", preset: "reels-tiktok" },
      ],
    },
    resolved: [
      { op: "add_text", text: "Hola", t: 3, duration_s: 3 },
      { op: "delete_clip", clip: { id: "c9" } },
      { op: "export", preset: "reels-tiktok" },
    ],
    preview_es: [
      "Texto «Hola» en 00:03 durante 3 s",
      "Borrar el clip «toma-final.mp4»",
      "Exportar con «Reels / TikTok»",
    ],
    risks: ["Se borra un clip de la línea de tiempo", "La exportación escribe un archivo nuevo"],
    unresolved: [],
    errors: [],
    model: "qwen3:8b",
    route: "llm",
    latency_ms: 2450,
    warnings: [],
    ...p,
  };
}

const initialAgent = useAgentStore.getState();

beforeEach(() => {
  useAgentStore.setState({ ...initialAgent, commandHistory: [], plans: [], undone: {} });
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
  useReportStore.setState({ open: false, prefill: {}, result: undefined });
  useProjectStore.getState().loadProject(createEmptyProject("Demo"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function proposeFromPanel(command: string) {
  const input = screen.getByRole("textbox", { name: "Comando para el asistente" });
  fireEvent.change(input, { target: { value: command } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Proponer/ }));
  });
}

describe("Panel Asistente", () => {
  it("is a dockview panel with Ctrl+Shift+A and a palette entry", () => {
    expect(PANELS.find((p) => p.id === "assistant")?.title).toBe("Asistente");
    const action = SHORTCUT_ACTIONS.find((a) => a.id === "assistant.open");
    expect(action).toMatchObject({
      defaultKeys: "Ctrl+Shift+A",
      label: "Asistente: escribir un comando",
    });
    const before = useAgentStore.getState().focusTick;
    runAction("assistant.open");
    expect(useAgentStore.getState().focusTick).toBe(before + 1);
  });

  it("shows the 100 % local badge, model and latency, and renders the plan with risks", async () => {
    const calls = mockFetch((path, method) => {
      if (path === "/api/agent/status") return { json: READY };
      if (path === "/api/agent/plans") return { json: [] };
      if (path === "/api/agent/plan" && method === "POST") return { json: plan() };
      return undefined;
    });
    render(<AssistantPanel />);
    expect(await screen.findByText("Listo")).toBeTruthy();
    expect(screen.getByText(/100 % local/)).toBeTruthy();
    await proposeFromPanel("Poné un título 'Hola' en el segundo 3");

    const planBox = await screen.findByTestId("agent-plan");
    expect(planBox.textContent).toContain("Agrego un título, borro el último clip");
    expect(planBox.textContent).toContain("Texto «Hola» en 00:03 durante 3 s");
    expect(within(planBox).getByRole("alert").textContent).toContain("Se borra un clip");
    expect(screen.getAllByTestId("agent-op")).toHaveLength(3);
    expect(screen.getByText("Borra un clip")).toBeTruthy();
    expect(screen.getByText("Escribe un archivo")).toBeTruthy();
    expect(screen.getByTestId("assistant-status").textContent).toContain("2,5 s");

    const req = calls.find((c) => c.path === "/api/agent/plan")!;
    expect(req.body).toMatchObject({
      command: "Poné un título 'Hola' en el segundo 3",
      projectId: useProjectStore.getState().project.id,
      settings: { temperature: 0.2 },
    });
    // The project is saved first: the api summarizes the saved copy.
    expect(calls.findIndex((c) => c.method === "PUT")).toBeLessThan(
      calls.findIndex((c) => c.path === "/api/agent/plan"),
    );
    // History: the plan is listed with its status.
    expect(screen.getByRole("list", { name: "Historial de planes" }).textContent).toContain(
      "Propuesto",
    );
  });

  it("renders questions as a form and re-sends the command with the answers", async () => {
    const calls = mockFetch((path, method) => {
      if (path === "/api/agent/status") return { json: READY };
      if (path === "/api/agent/plan" && method === "POST")
        return {
          json: plan({
            command: "Cortá el clip",
            plan: {
              version: 1,
              summary_es: "Necesito saber qué clip cortar.",
              ops: [],
              questions: ["¿Qué clip querés cortar?"],
            },
            resolved: [],
            preview_es: [],
            risks: [],
          }),
        };
      return undefined;
    });
    render(<AssistantPanel />);
    await proposeFromPanel("Cortá el clip");
    const form = await screen.findByRole("form", { name: "Preguntas del asistente" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "el segundo" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: /Responder/ }));
    });
    const plans = calls.filter((c) => c.path === "/api/agent/plan");
    expect(plans).toHaveLength(2);
    expect((plans[1]!.body as { command: string }).command).toBe(
      "Cortá el clip. Respuestas: ¿Qué clip querés cortar? → el segundo",
    );
  });

  it("toggles ops and edits params inline → apply payload, progress per op, Deshacer todo", async () => {
    let jobDone = false;
    const calls = mockFetch((path, method) => {
      if (path === "/api/agent/status") return { json: READY };
      if (path === "/api/agent/plan" && method === "POST") return { json: plan() };
      if (path === "/api/agent/apply" && method === "POST") {
        // The api resolves the edited ops again and answers the stored record.
        const edited = plan();
        edited.plan!.ops[0] = { op: "add_text", text: "Chau", t: 4.5, duration_s: 3 };
        edited.preview_es = [
          "Agregar texto «Chau» en 4,5 s durante 3 s (abajo)",
          ...edited.preview_es.slice(1),
        ];
        return { json: { jobId: "ap1", plan: { ...edited, edited: true } } };
      }
      if (path === "/api/jobs/ap1")
        return {
          json: {
            id: "ap1",
            type: "agent.apply",
            status: jobDone ? "succeeded" : "running",
            progress: jobDone ? 1 : 0.5,
            payload: {},
            createdAt: new Date().toISOString(),
            ...(jobDone && { result: { applied: 2, undoSnapshotId: "snap1", steps: [] } }),
          } satisfies Job,
        };
      if (path === "/api/agent/plans/plan1/undo" && method === "POST")
        return {
          json: {
            project: useProjectStore.getState().project,
            plan: plan({ status: "proposed" }),
          },
        };
      return undefined;
    });
    render(<AssistantPanel />);
    await proposeFromPanel("Poné un título");
    await screen.findByTestId("agent-plan");

    // delete_clip and export start unchecked (destructive): only the text is checked.
    expect(
      (screen.getByRole("checkbox", { name: "Aplicar: Eliminar clip" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(screen.getByRole("button", { name: /Aplicar \(1\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Aplicar: Exportar" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Texto (Agregar texto)" }), {
      target: { value: "Chau" },
    });
    const at = screen.getByRole("textbox", { name: "En (Agregar texto)" });
    fireEvent.change(at, { target: { value: "4,5" } });
    fireEvent.blur(at);
    fireEvent.change(screen.getByRole("combobox", { name: "Preset (Exportar)" }), {
      target: { value: "youtube-shorts" },
    });
    // A checked export needs the separate confirmation before «Aplicar».
    const applyBtn = screen.getByRole("button", { name: /Aplicar \(2\)/ }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
    expect(screen.getByText("Requiere confirmación")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar exportación" }));
    expect(screen.getByText("Confirmada")).toBeTruthy();
    expect(applyBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Aplicar \(2\)/ }));
    });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/agent/apply")).toBe(true));
    const body = calls.find((c) => c.path === "/api/agent/apply")!.body as {
      planId: string;
      ops: number[];
      edited_ops: { text?: string; t?: unknown; preset?: string }[];
    };
    expect(body.planId).toBe("plan1");
    expect(body.ops).toEqual([0, 2]);
    expect((body as { confirmedIndexes?: number[] }).confirmedIndexes).toEqual([2]);
    expect(body.edited_ops[0]).toMatchObject({ op: "add_text", text: "Chau", t: 4.5 });
    expect(body.edited_ops[2]).toMatchObject({ op: "export", preset: "youtube-shorts" });
    expect(typeof (body as { cursor?: unknown }).cursor).toBe("number");
    // the re-resolved preview of the api replaces the old line
    expect(
      await screen.findByText("Agregar texto «Chau» en 4,5 s durante 3 s (abajo)"),
    ).toBeTruthy();
    expect(screen.queryByText("Texto «Hola» en 00:03 durante 3 s")).toBeNull();

    // Progress by SSE: op 1 done, op 3 running ("Paso 2/2").
    await waitFor(() => expect(useJobsStore.getState().jobs.ap1).toBeTruthy());
    act(() =>
      useJobsStore.getState().applyEvent({
        jobId: "ap1",
        status: "running",
        progress: 0.5,
        message: "Paso 2/2: exportando",
      }),
    );
    expect((await screen.findByTestId("agent-run")).textContent).toContain("Paso 2/2");
    expect(screen.getAllByLabelText("Hecha")).toHaveLength(1);

    jobDone = true;
    act(() =>
      useJobsStore.getState().applyEvent({ jobId: "ap1", status: "succeeded", progress: 1 }),
    );
    expect(await screen.findByText(/Listo: 2 operación/)).toBeTruthy();
    expect(screen.getAllByLabelText("Hecha")).toHaveLength(2);
    // The project edited by the api is read back as one local undo step.
    await waitFor(() => expect(useProjectStore.getState().past.length).toBe(1));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Deshacer todo/ }));
    });
    const undo = calls.find((c) => c.path === "/api/agent/plans/plan1/undo");
    expect(undo?.body).toEqual({ undoSnapshotId: "snap1" });
    expect(await screen.findByText("Plan deshecho.")).toBeTruthy();
    // Back to «proposed» on the api: it can be applied again; the history says «Deshecho».
    expect(screen.getByRole("button", { name: /Aplicar \(2\)/ })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Historial de planes" }).textContent).toContain(
      "Deshecho",
    );
  });

  it("checking delete + export asks «Confirmar borrado/exportación»; toggling again re-asks", async () => {
    mockFetch((path, method) => {
      if (path === "/api/agent/status") return { json: READY };
      if (path === "/api/agent/plan" && method === "POST") return { json: plan() };
      return undefined;
    });
    render(<AssistantPanel />);
    await proposeFromPanel("Poné un título");
    await screen.findByTestId("agent-plan");
    expect(screen.queryByRole("button", { name: /Confirmar/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Aplicar: Eliminar clip" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Aplicar: Exportar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar borrado/exportación" }));
    expect(useAgentStore.getState().draft!.confirmed).toEqual([1, 2]);
    // unchecking the export forgets the confirmation of the delete too
    fireEvent.click(screen.getByRole("checkbox", { name: "Aplicar: Exportar" }));
    expect(useAgentStore.getState().draft!.confirmed).toEqual([]);
    expect(screen.getByRole("button", { name: "Confirmar borrado" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Aplicar \(2\)/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("Deshacer todo after later edits: 409 PROJECT_CHANGED → «¿restaurar igual?» → force", async () => {
    let undoCalls = 0;
    const calls = mockFetch((path, method) => {
      if (path === "/api/agent/status") return { json: READY };
      if (path === "/api/agent/plans/plan1/undo" && method === "POST") {
        undoCalls++;
        if (undoCalls === 1)
          return {
            status: 409,
            json: {
              error: {
                code: "PROJECT_CHANGED",
                message: "El proyecto cambió después de aplicar el plan",
              },
            },
          };
        return {
          json: {
            project: useProjectStore.getState().project,
            plan: plan({ status: "proposed" }),
          },
        };
      }
      return undefined;
    });
    useAgentStore.getState().receivePlan(plan({ status: "applied", undoSnapshotId: "snap1" }));
    render(<AssistantPanel />);
    expect(screen.getByText(/Deshacer no borra los archivos exportados/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Deshacer todo/ }));
    });
    const dialog = await screen.findByTestId("agent-undo-conflict");
    expect(dialog.textContent).toContain("El proyecto cambió después; ¿restaurar igual?");
    expect(dialog.textContent).toContain("no se borran");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /Restaurar igual/ }));
    });
    const undos = calls.filter((c) => c.path === "/api/agent/plans/plan1/undo");
    expect(undos.map((c) => c.body)).toEqual([
      { undoSnapshotId: "snap1" },
      { undoSnapshotId: "snap1", force: true },
    ]);
    // the local edits are saved before asking the api (it compares the saved project)
    expect(calls.findIndex((c) => c.method === "PUT")).toBeLessThan(
      calls.findIndex((c) => c.path === "/api/agent/plans/plan1/undo"),
    );
    await waitFor(() => expect(screen.queryByTestId("agent-undo-conflict")).toBeNull());
    expect(useAgentStore.getState().undone.plan1).toBe(true);
  });

  it("shows «Cargando modelo…» while the first LLM call loads the model", async () => {
    mockFetch((path) => {
      if (path === "/api/agent/status") return { json: { ...READY, loaded: false } };
      return undefined;
    });
    render(<AssistantPanel />);
    await screen.findByText("Listo");
    act(() => useAgentStore.setState({ proposing: true }));
    expect(screen.getByText(/Cargando modelo… \(la primera vez/)).toBeTruthy();
    expect(screen.getByTestId("assistant-status").textContent).toContain("Cargando modelo…");
    // once the LLM answered, the model is in memory
    act(() => {
      useAgentStore.getState().receivePlan(plan());
      useAgentStore.setState({ proposing: false });
    });
    expect(useAgentStore.getState().status?.loaded).toBe(true);
    expect(screen.queryByText(/Cargando modelo/)).toBeNull();
  });

  it("Rechazar marks the plan rejected in the history", async () => {
    const calls = mockFetch((path, method) => {
      if (path === "/api/agent/plan" && method === "POST") return { json: plan() };
      if (path === "/api/agent/plans/plan1/reject") return { json: {} };
      return undefined;
    });
    render(<AssistantPanel />);
    await proposeFromPanel("Poné un título");
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Rechazar/ }));
    });
    expect(calls.some((c) => c.path === "/api/agent/plans/plan1/reject")).toBe(true);
    expect(screen.queryByTestId("agent-plan")).toBeNull();
    expect(screen.getByRole("list", { name: "Historial de planes" }).textContent).toContain(
      "Rechazado",
    );
  });

  it("walks the command history with ↑/↓", () => {
    useAgentStore.setState({ commandHistory: ["Cortá los silencios", "Exportá para TikTok"] });
    mockFetch(() => undefined);
    render(<AssistantPanel />);
    const input = screen.getByRole("textbox", { name: "Comando para el asistente" });
    fireEvent.change(input, { target: { value: "borrador" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((input as HTMLInputElement).value).toBe("Exportá para TikTok");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect((input as HTMLInputElement).value).toBe("Cortá los silencios");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect((input as HTMLInputElement).value).toBe("borrador");
    // Example chips fill the input.
    fireEvent.click(screen.getByRole("button", { name: "Subtítulos animados estilo Reels" }));
    expect((input as HTMLInputElement).value).toBe("Subtítulos animados estilo Reels");
  });

  it("PACK_REQUIRED agent-llm opens the pack dialog with the Ollama hint", async () => {
    mockFetch((path) => {
      if (path === "/api/agent/status") return { json: { ...READY, ollama: false, ready: false } };
      if (path === "/api/agent/plan")
        return {
          status: 409,
          json: {
            error: "PACK_REQUIRED",
            packId: "agent-llm",
            name_es: "Asistente local (qwen3:8b)",
            size_bytes: 5_200_000_000,
            message: "Instalá Ollama y descargá el modelo.",
          },
        };
      if (path === "/api/ai/packs") return { json: [] };
      return undefined;
    });
    render(
      <>
        <AssistantPanel />
        <PackRequiredDialog />
      </>,
    );
    await proposeFromPanel("Cortá los silencios");
    const dialog = await screen.findByRole("dialog", { name: "Paquete requerido" });
    expect(dialog.textContent).toContain("Asistente local (qwen3:8b)");
    const hint = await within(dialog).findByTestId("ollama-hint");
    await waitFor(() => expect(hint.textContent).toContain("winget install Ollama.Ollama"));
    expect(hint.textContent).toContain("Instalá Ollama y descargá el modelo.");
    expect(usePacksStore.getState().retries["agent-llm"]).toBeTypeOf("function");
    expect(screen.getByText("Falta Ollama")).toBeTruthy();
  });
});

describe("Ajustes → Asistente local", () => {
  it("lists default + installed models, saves the choice and sends it with the next plan", async () => {
    expect(modelOptions(["llama3.1:8b"], undefined)).toEqual([
      "qwen3:8b",
      "hermes3:8b",
      "llama3.1:8b",
    ]);
    const calls = mockFetch((path, method) => {
      if (path === "/api/agent/status") return { json: READY };
      if (path === "/api/agent/plan" && method === "POST") return { json: plan() };
      if (path === "/api/agent/eval" && method === "POST")
        return {
          json: {
            models: {
              "qwen3:8b": {
                schema_valid_rate: 0.98,
                semantic_rate: 0.92,
                semantic_rate_ops_only: 0.95,
                p50_latency_ms: 2300,
              },
              "llama3.1:8b": { schema_valid_rate: 0.9, semantic_rate: 0.81, p50_latency_ms: 800 },
            },
          },
        };
      return undefined;
    });
    render(<AssistantTab />);
    const select = (await screen.findByRole("combobox", {
      name: "Modelo del asistente",
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    expect(select.textContent).toContain("llama3.1:8b · instalado");
    expect(select.textContent).toContain("hermes3:8b · sin descargar");
    fireEvent.change(select, { target: { value: "hermes3:8b" } });
    fireEvent.change(screen.getByRole("slider", { name: "Temperatura" }), {
      target: { value: "0.5" },
    });
    expect(useAgentStore.getState().settings).toEqual({ model: "hermes3:8b", temperature: 0.5 });
    expect(JSON.parse(window.localStorage.getItem("studio.agent.v1")!)).toMatchObject({
      model: "hermes3:8b",
      temperature: 0.5,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Evaluar modelos/ }));
    });
    const table = await screen.findByTestId("agent-eval");
    expect(table.textContent).toContain("92 %");
    expect(table.textContent).toContain("Correcto (con ops)");
    expect(table.textContent).toContain("95 %");
    expect(table.textContent).toContain("2,3 s");
    expect(table.textContent).toContain("800 ms");
    expect(calls.find((c) => c.path === "/api/agent/eval" && c.method === "POST")?.body).toEqual({
      models: ["qwen3:8b", "llama3.1:8b"],
      dataset: "golden",
    });

    await act(async () => {
      await useAgentStore.getState().propose("Exportá para TikTok");
    });
    expect(calls.find((c) => c.path === "/api/agent/plan")?.body).toMatchObject({
      settings: { model: "hermes3:8b", temperature: 0.5 },
    });
  });

  it("shows «Built with Llama» only with a Llama-based model (hermes3)", async () => {
    mockFetch((path) => (path === "/api/agent/status" ? { json: READY } : undefined));
    render(<AssistantTab />);
    const select = await screen.findByRole("combobox", { name: "Modelo del asistente" });
    expect(screen.queryByTestId("built-with-llama")).toBeNull();
    fireEvent.change(select, { target: { value: "hermes3:8b" } });
    expect(screen.getByTestId("built-with-llama").textContent).toContain("Built with Llama");
    fireEvent.change(select, { target: { value: "qwen3:8b" } });
    expect(screen.queryByTestId("built-with-llama")).toBeNull();
    expect(isLlamaModel("hermes3:8b") && isLlamaModel("hermes3")).toBe(true);
    expect(isLlamaModel("qwen3:8b") || isLlamaModel(undefined)).toBe(false);
  });
});

describe("Reportar error → Redactar con IA", () => {
  it("fills título, pasos, esperado and pasó from /api/agent/bugreport, still editable", async () => {
    const calls = mockFetch((path) =>
      path === "/api/agent/bugreport"
        ? {
            json: {
              source: "llm",
              markdown_es: [
                "# La exportación 9:16 se corta al 40 %",
                "",
                "## Pasos",
                "1. Abrí el panel Exportar",
                "2. Elegí Reels / TikTok",
                "",
                "## Esperado",
                "Un MP4 vertical completo.",
                "",
                "## Qué pasó",
                "El trabajo falló al 40 %.",
              ].join("\n"),
            },
          }
        : undefined,
    );
    openReport({ source: "cabecera" });
    render(<ReportDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Redactar con IA/ }));
    });
    const title = screen.getByRole("textbox", { name: "Título" }) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("La exportación 9:16 se corta al 40 %"));
    const steps = screen.getByRole("textbox", {
      name: /Qué intentabas hacer/,
    }) as HTMLTextAreaElement;
    expect(steps.value).toContain("2. Elegí Reels / TikTok");
    expect(steps.value).toContain("Esperaba que: Un MP4 vertical completo.");
    expect(steps.value).toContain("Pero pasó: El trabajo falló al 40 %.");
    expect(screen.getByRole("status").textContent).toContain("nada salió de tu PC");
    const req = calls.find((c) => c.path === "/api/agent/bugreport")!.body as {
      steps_text: string;
      breadcrumbs: unknown[];
    };
    expect(req.steps_text).toBe("");
    expect(Array.isArray(req.breadcrumbs)).toBe(true);
    fireEvent.change(title, { target: { value: "Editado a mano" } });
    expect(title.value).toBe("Editado a mano");
  });

  it("shows why it could not draft (api down) and keeps the form", async () => {
    mockFetch(() => ({
      status: 503,
      json: { error: { code: "WORKERS_DOWN", message: "Los workers no responden" } },
    }));
    openReport({});
    render(<ReportDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Redactar con IA/ }));
    });
    expect((await screen.findByText(/No se pudo redactar con IA/)).textContent).toContain(
      "Los workers no responden",
    );
    expect(screen.getByRole("button", { name: /Generar reporte/ })).toBeTruthy();
  });
});

describe("Etiquetas de trabajos", () => {
  it("labels agent.apply, agent.eval and the agent-llm download", () => {
    expect(JOB_TYPE_LABELS["agent.apply"]).toBe("Asistente: aplicar plan");
    expect(JOB_TYPE_LABELS["agent.eval"]).toBe("Asistente: evaluar modelos");
    expect(jobLabel({ type: "packs.download", payload: { packId: "agent-llm" } })).toBe(
      "Descargar modelo del asistente (Ollama)",
    );
    expect(jobLabel({ type: "packs.download", payload: { packId: "scenes" } })).toBe(
      "Descargar paquete de IA",
    );
  });
});

describe("lib/agent", () => {
  it("builds the apply payload only with edited ops when something changed", () => {
    const ops = plan().plan!.ops;
    expect(buildApplyRequest("p", ops, ops, [true, false, true])).toEqual({
      planId: "p",
      ops: [0, 2],
    });
    // only confirmed indexes that are also applied are sent
    expect(buildApplyRequest("p", ops, ops, [true, false, true], undefined, [1, 2])).toEqual({
      planId: "p",
      ops: [0, 2],
      confirmedIndexes: [2],
    });
    expect(destructiveIndexes(ops, [true, true, true])).toEqual([1, 2]);
    expect(confirmDestructiveLabel(ops, [1])).toBe("Confirmar borrado");
    expect(confirmDestructiveLabel(ops, [1, 2])).toBe("Confirmar borrado/exportación");
  });

  it("parses times, appends answers, keeps a deduplicated history", () => {
    expect(parseAgentTime("3,5")).toBe(3.5);
    expect(parseAgentTime("2 s")).toBe(2);
    expect(parseAgentTime("inicio")).toBe("start");
    expect(parseAgentTime("cursor")).toBe("cursor");
    expect(parseAgentTime("mañana")).toBeUndefined();
    expect(appendAnswers("Cortá.", ["¿Cuál?", "¿Dónde?"], ["el 2", ""])).toBe(
      "Cortá. Respuestas: ¿Cuál? → el 2",
    );
    expect(pushHistory(["a", "b"], "a")).toEqual(["b", "a"]);
    expect(navigateHistory(2, 0, -1)).toBe(0);
    expect(navigateHistory(2, 1, 1)).toBe(2);
  });

  it("only offers scalar params inline (refs and style objects stay read-only)", () => {
    expect(
      editableParams({ op: "add_text", text: "x", t: { scene: 2 }, style: { color: "#fff" } }).map(
        (p) => p.key,
      ),
    ).toEqual(["text", "duration_s"]);
    expect(editableParams({ op: "set_canvas", preset: { w: 10, h: 10 } })).toEqual([]);
  });

  it("derives per-op states from the job and the result", () => {
    const running = { status: "running" as const, progress: 0.6, message: undefined };
    expect(opRunStates(3, [0, 2], running)).toEqual(["done", "skipped", "running"]);
    expect(
      opRunStates(
        3,
        [0, 1, 2],
        { status: "failed", progress: 0.5 },
        {
          applied: 1,
          failed: { index: 1, error: "x" },
          undoSnapshotId: "s",
          steps: [],
        },
      ),
    ).toEqual(["done", "failed", "pending"]);
  });

  it("normalizes eval results and plan records in their different shapes", () => {
    expect(normalizeEvalResults([{ model: "m", semantic_rate: 0.5, failures: [] }])).toEqual([
      { model: "m", semantic_rate: 0.5, failures: [] },
    ]);
    expect(normalizeEvalResults({ results: { m2: { p50_latency_ms: 10 } } })).toEqual([
      { model: "m2", p50_latency_ms: 10 },
    ]);
    const nested = normalizePlanRecord({ plan: plan(), latency_ms: 5 });
    expect(nested.id).toBe("plan1");
    expect(nested.plan?.summary_es).toContain("Agrego");
  });

  it("parses the drafted markdown with bold headings too", () => {
    const d = parseDraftedReport(
      "**Título:** Falla el TTS\n**Pasos:**\n1. Escribí texto\n**Esperado:** Oír la voz\n**Pasó:** Silencio",
    );
    expect(d).toEqual({
      title: "Falla el TTS",
      steps: "1. Escribí texto",
      expected: "Oír la voz",
      actual: "Silencio",
    });
    expect(composeSteps({}, "original")).toBe("original");
  });
});
