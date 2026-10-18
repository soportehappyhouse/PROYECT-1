import type { AgentPlanRecord, ImportSuggestion, Job } from "@studio/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobsIndicator } from "@/components/dashboard/JobsIndicator";
import { AssistantPanel } from "@/components/panels/AssistantPanel";
import { SuggestionsSection } from "@/components/suggestions/SuggestionCard";
import { SuggestionSettingsSection } from "@/components/suggestions/SuggestionSettingsSection";
import { handleFinished, shouldToastSuccess } from "@/hooks/use-job-events";
import { lastOpenPlan, useAgentStore } from "@/stores/agent-store";
import { useJobsStore } from "@/stores/jobs-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { analyzingText, useSuggestionsStore } from "@/stores/suggestions-store";

/** Sprint 6 M3 (web): «Sugerencias» cards in the Asistente. The api is mocked. */

type Reply = { status?: number; json?: unknown } | undefined;
interface Call {
  path: string;
  method: string;
  body: unknown;
}

function mockFetch(handler: (path: string, method: string, body: unknown) => Reply): Call[] {
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

const now = "2026-10-18T12:00:00.000Z";

function card(
  id: string,
  kind: ImportSuggestion["kind"],
  over: Partial<ImportSuggestion> = {},
): ImportSuggestion {
  const projectId = useProjectStore.getState().project.id;
  return {
    id,
    projectId,
    assetId: "a1",
    clipIds: ["c1"],
    kind,
    status: "open",
    title_es:
      kind === "silences"
        ? "3 silencios largos = 3,5 s de 12 s"
        : kind === "low_voice"
          ? "La voz está baja (-30 LUFS)"
          : "El audio satura (pico de -0,5 dBTP)",
    detail_es: "detalle",
    impact:
      kind === "silences"
        ? { seconds_saved: 3.5, count: 3 }
        : { gain_db: kind === "clipping" ? -0.5 : 11 },
    ...(kind === "silences" && {
      evidence: {
        ranges: [
          { start: 2, end: 3.5 },
          { start: 5.5, end: 6.5 },
        ],
      },
    }),
    plan:
      kind === "silences"
        ? {
            version: 1,
            summary_es: "Cortar 3 silencios largos",
            ops: [{ op: "cut_silences", clip: { id: "c1" }, min_silence_ms: 500, fillers: false }],
          }
        : {
            version: 1,
            summary_es: "Subir la voz",
            ops: [{ op: "set_volume", clip: { id: "c1" }, volume_db: 11 }],
          },
    params_version: 1,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function planRecord(s: ImportSuggestion): AgentPlanRecord {
  return {
    id: `plan-${s.id}`,
    projectId: s.projectId,
    command: s.title_es,
    status: "proposed",
    created_at: now,
    model: null,
    route: "deterministic",
    latency_ms: 0,
    attempts: 0,
    warnings: [`suggestion:${s.id}`],
    ok: true,
    plan: s.plan,
    resolved: s.plan.ops,
    preview_es: ["Cambiar el volumen de «clip.mp4» a +11 dB"],
    risks: [],
    unresolved: [],
    errors: [],
    added: [],
    choices: [],
  } as AgentPlanRecord;
}

const initialAgent = useAgentStore.getState();

beforeEach(() => {
  useProjectStore.getState().loadProject(createEmptyProject("Demo"));
  useAgentStore.setState({ ...initialAgent, plans: [], undone: {}, draft: undefined });
  useJobsStore.setState({ jobs: {}, intents: {}, handled: {}, connection: "live" });
  useSuggestionsStore.setState({
    projectId: undefined,
    suggestions: [],
    analyzing: [],
    busy: undefined,
    error: undefined,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("Sugerencias (Asistente)", () => {
  it("shows at most 4 cards, open before stale; hidden when there is nothing", async () => {
    const pid = useProjectStore.getState().project.id;
    const list = [
      card("s1", "silences"),
      card("s2", "low_voice"),
      card("s3", "clipping"),
      card("s4", "silences", { assetId: "a2", status: "stale" }),
      card("s5", "low_voice", { assetId: "a2", status: "applied" }),
      card("s6", "silences", { assetId: "a3", status: "dismissed" }),
    ];
    mockFetch((path) =>
      path === `/api/projects/${pid}/suggestions`
        ? { json: { suggestions: list, analyzing: [] } }
        : undefined,
    );
    render(<SuggestionsSection />);
    await waitFor(() => expect(screen.getAllByTestId("suggestion-card")).toHaveLength(4));
    const cards = screen.getAllByTestId("suggestion-card");
    expect(cards.at(-1)!.textContent).toContain("El clip cambió desde el análisis");
    expect(screen.getAllByText("3 silencios largos = 3,5 s de 12 s")).toHaveLength(2);
    expect(screen.queryByText(/dismissed/)).toBeNull();
    // the stale card cannot be applied
    expect(
      (within(cards.at(-1)!).getByTestId("suggestion-apply") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("nothing to show and nothing analyzing → no section", async () => {
    const pid = useProjectStore.getState().project.id;
    const calls = mockFetch((path) =>
      path === `/api/projects/${pid}/suggestions`
        ? { json: { suggestions: [], analyzing: [] } }
        : undefined,
    );
    const { container } = render(<SuggestionsSection />);
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/suggestions"))).toBe(true));
    expect(container.textContent).toBe("");
  });

  it("«Analizando 2 medios…» is one aggregated line in the Trabajos indicator", () => {
    const bg = (id: string) =>
      ({
        id,
        type: "suggest.analyze",
        status: "running",
        progress: 0.3,
        attempts: 1,
        createdAt: "2026-10-18T10:00:00.000Z",
      }) as unknown as Job;
    useJobsStore.setState({ jobs: { a1: bg("a1"), a2: bg("a2") } });
    render(<JobsIndicator />);
    const ind = screen.getByTestId("jobs-indicator");
    // background analyses are not the user's jobs
    expect(ind.getAttribute("data-active")).toBe("0");
    expect(screen.getByTestId("jobs-indicator-analyzing").textContent).toBe("Analizando 2 medios…");
    expect(analyzingText(1)).toBe("Analizando 1 medio…");
    expect(analyzingText(0)).toBeNull();
    expect(shouldToastSuccess("suggest.analyze", true)).toBe(false);
    useJobsStore.setState({ jobs: {} });
  });

  it("«Aplicar» asks the api for the plan and opens it in the Asistente (preview, -14 LUFS)", async () => {
    const pid = useProjectStore.getState().project.id;
    const low = card("s2", "low_voice");
    const calls = mockFetch((path, method) => {
      if (path === `/api/projects/${pid}/suggestions`)
        return { json: { suggestions: [low], analyzing: [] } };
      if (path === `/api/projects/${pid}/suggestions/s2/plan` && method === "POST")
        return { status: 201, json: planRecord(low) };
      if (path === "/api/agent/plans") return { json: [] };
      return undefined;
    });
    render(<AssistantPanel />);
    await waitFor(() => expect(screen.getAllByTestId("suggestion-card")).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId("suggestion-apply"));
    });
    await waitFor(() => expect(screen.getByTestId("agent-plan")).toBeTruthy());
    expect(calls.some((c) => c.path.endsWith("/suggestions/s2/plan") && c.method === "POST")).toBe(
      true,
    );
    expect(useAgentStore.getState().draft?.record.id).toBe("plan-s2");
    expect(useAgentStore.getState().plans.map((p) => p.id)).toContain("plan-s2");
    expect(screen.getByTestId("agent-plan").textContent).toContain("Subir la voz");
  });

  it("«Ignorar» removes the card; «No sugerir más» sends muteKind", async () => {
    const pid = useProjectStore.getState().project.id;
    const list = [card("s1", "silences"), card("s2", "low_voice")];
    const calls = mockFetch((path, method, body) => {
      if (path === `/api/projects/${pid}/suggestions`)
        return { json: { suggestions: list, analyzing: [] } };
      if (path.endsWith("/dismiss") && method === "POST") {
        const id = path.split("/").at(-2)!;
        return { json: { ...list.find((s) => s.id === id)!, status: "dismissed", body } };
      }
      return undefined;
    });
    render(<SuggestionsSection />);
    await waitFor(() => expect(screen.getAllByTestId("suggestion-card")).toHaveLength(2));
    const first = screen
      .getAllByTestId("suggestion-card")
      .find((c) => c.dataset.kind === "silences")!;
    await act(async () => {
      fireEvent.click(within(first).getByTestId("suggestion-dismiss"));
    });
    await waitFor(() => expect(screen.getAllByTestId("suggestion-card")).toHaveLength(1));
    const dismiss = calls.find((c) => c.path.endsWith("/s1/dismiss"))!;
    expect(dismiss.body).toEqual({ muteKind: false });
    await act(async () => {
      fireEvent.click(screen.getByTestId("suggestion-mute"));
    });
    expect(calls.find((c) => c.path.endsWith("/s2/dismiss"))!.body).toEqual({ muteKind: true });
  });

  it("background analyses never toast, not even when they fail (handleFinished)", async () => {
    const job: Job = {
      id: "j1",
      type: "suggest.analyze",
      status: "failed",
      progress: 1,
      payload: { assetId: "a1" },
      createdAt: now,
      error: "Los workers no están corriendo",
      errorCode: "WORKERS_UNAVAILABLE",
    };
    const err = vi.spyOn(toast, "error");
    const ok = vi.spyOn(toast, "success");
    await handleFinished(job);
    expect(useJobsStore.getState().handled.j1).toBe(true);
    expect(err).not.toHaveBeenCalled();
    expect(ok).not.toHaveBeenCalled();
  });
});

describe("Ajustes → Sugerencias al importar (integration S6)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists the silenced kinds and «Volver a sugerir» saves them without that kind", async () => {
    const calls = mockFetch((path, method, body) => {
      if (path === "/api/suggestions/settings" && method === "GET")
        return { json: { enabled: true, mutedKinds: ["low_voice", "clipping"] } };
      if (path === "/api/suggestions/settings" && method === "PUT") return { json: body };
      return undefined;
    });
    render(<SuggestionSettingsSection />);
    await waitFor(() => expect(screen.getAllByTestId("muted-kind")).toHaveLength(2));
    expect(screen.getAllByTestId("muted-kind")[0]!.textContent).toContain("Voz baja");
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("unmute-kind")[0]!);
    });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ enabled: true, mutedKinds: ["clipping"] });
    await waitFor(() => expect(screen.getAllByTestId("muted-kind")).toHaveLength(1));
  });
});

describe("H18: reopen the last plan after a reload", () => {
  it("lastOpenPlan picks the newest proposed plan that was never undone", () => {
    const base = planRecord(card("s1", "low_voice"));
    const plans = [
      { ...base, id: "old", created_at: "2026-10-18T10:00:00.000Z" },
      { ...base, id: "undone", created_at: "2026-10-18T11:00:00.000Z" },
      {
        ...base,
        id: "applied",
        status: "applied" as const,
        created_at: "2026-10-18T12:00:00.000Z",
      },
      {
        ...base,
        id: "undone2",
        undoneAt: "2026-10-18T13:30:00.000Z",
        created_at: "2026-10-18T13:00:00.000Z",
      },
    ];
    expect(lastOpenPlan(plans, { undone: true })?.id).toBe("old");
    expect(lastOpenPlan([], {})).toBeUndefined();
  });

  it("loadHistory reopens it when there is no draft", async () => {
    const pid = useProjectStore.getState().project.id;
    const rec = planRecord(card("s1", "low_voice", { projectId: pid }));
    mockFetch((path) => (path === "/api/agent/plans" ? { json: [rec] } : undefined));
    await useAgentStore.getState().loadHistory();
    expect(useAgentStore.getState().draft?.record.id).toBe(rec.id);
  });
});
