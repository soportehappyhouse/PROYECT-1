import type { CreateReportResponse, Job } from "@studio/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobsPanel } from "@/components/panels/JobsPanel";
import { AppErrorBoundary } from "@/components/report/AppErrorBoundary";
import { ReportDialog } from "@/components/report/ReportDialog";
import { api, apiFetch } from "@/lib/api";
import { installGlobalErrorCapture } from "@/lib/global-errors";
import { STEPS_TEMPLATE } from "@/lib/report";
import {
  addBreadcrumb,
  getBreadcrumbs,
  MAX_BREADCRUMBS,
  useBreadcrumbsStore,
} from "@/stores/breadcrumbs-store";
import { useJobsStore } from "@/stores/jobs-store";
import { createEmptyProject, useProjectStore } from "@/stores/project-store";
import { openReport, useReportStore } from "@/stores/report-store";
import { useSettingsStore } from "@/stores/settings-store";

function failedJob(id: string): Job {
  return {
    id,
    type: "project.export",
    status: "failed",
    progress: 0.4,
    payload: {},
    error: "ffmpeg terminó con código 1",
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  useBreadcrumbsStore.getState().clear();
  useReportStore.setState({ open: false, prefill: {}, result: undefined });
  useJobsStore.setState({ jobs: {}, intents: {}, handled: {}, connection: "live" });
  useProjectStore.getState().loadProject(createEmptyProject("Demo"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("breadcrumbs store", () => {
  it("keeps only the last 50 entries (ring buffer)", () => {
    useBreadcrumbsStore.getState().clear();
    for (let i = 0; i < 60; i++) addBreadcrumb("ui", `acción ${i}`);
    const crumbs = getBreadcrumbs();
    expect(MAX_BREADCRUMBS).toBe(50);
    expect(crumbs).toHaveLength(50);
    expect(crumbs[0]!.message).toBe("acción 10");
    expect(crumbs[49]!.message).toBe("acción 59");
    expect(crumbs[0]).not.toHaveProperty("key");
  });

  it("coalesces repeated events with the same key (drags)", () => {
    useBreadcrumbsStore.getState().clear();
    addBreadcrumb("clip", "Movió a 1", undefined, "move:c1");
    addBreadcrumb("clip", "Movió a 2", undefined, "move:c1");
    addBreadcrumb("clip", "Movió a 3", undefined, "move:c2");
    expect(getBreadcrumbs().map((c) => c.message)).toEqual(["Movió a 2", "Movió a 3"]);
  });

  it("records store actions, settings changes and api errors with status + route", async () => {
    useBreadcrumbsStore.getState().clear();
    useProjectStore.getState().addTextClip({ text: "Hola" });
    useSettingsStore.getState().setTheme("dark");
    useJobsStore.getState().track("job1", "project.export", { kind: "export" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "BOOM", message: "falló" } }), { status: 500 }),
    );
    await expect(apiFetch("/api/projects/:id", { params: { id: "p1" } })).rejects.toThrow("falló");
    const crumbs = getBreadcrumbs();
    expect(crumbs.map((c) => c.category)).toEqual(["clip", "settings", "job", "api"]);
    expect(crumbs[3]!.message).toContain("GET /api/projects/:id → 500");
    expect(crumbs[3]!.data).toMatchObject({
      status: 500,
      route: "/api/projects/:id",
      code: "BOOM",
    });
  });

  it("captures window errors and unhandled rejections", () => {
    useBreadcrumbsStore.getState().clear();
    const uninstall = installGlobalErrorCapture();
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "x is undefined",
        error: new TypeError("x is undefined"),
      }),
    );
    window.dispatchEvent(
      new ErrorEvent("error", { message: "ResizeObserver loop limit exceeded" }),
    );
    const rejection = new Event("unhandledrejection") as PromiseRejectionEvent;
    Object.defineProperty(rejection, "reason", { value: new Error("fetch roto") });
    window.dispatchEvent(rejection);
    uninstall();
    const messages = getBreadcrumbs().map((c) => c.message);
    expect(messages).toEqual([
      "Error JS: x is undefined",
      "Promesa rechazada sin manejar: Error: fetch roto",
    ]);
  });
});

describe("ReportDialog", () => {
  const response: CreateReportResponse = {
    id: "20261004-153012-exportar-falla",
    title: "Exportar falla",
    severity: "high",
    createdAt: new Date().toISOString(),
    dir: "C:\\dev\\studio\\storage\\reports\\20261004-153012-exportar-falla",
    zipPath: "C:\\dev\\studio\\storage\\reports\\20261004-153012-exportar-falla.zip",
    relativeDir: "reports/20261004-153012-exportar-falla",
    zipBytes: 1234,
    markdown: "# Reporte de error — Exportar falla\n\n## Prompt para Claude",
    prompt: "Hola Claude. ## Contexto ...",
    files: ["reporte.md"],
  };

  it("renders the form prefilled from a failed job and shows the result", async () => {
    addBreadcrumb("panel", "Abrió el panel Exportar");
    const create = vi.spyOn(api, "createReport").mockResolvedValue(response);
    act(() => openReport({ title: "Falló: Exportación", jobIds: ["job-9"], source: "trabajos" }));
    render(<ReportDialog />);

    expect(screen.getByRole("dialog", { name: "Reportar error" })).toBeTruthy();
    expect((screen.getByLabelText("Título") as HTMLInputElement).value).toBe("Falló: Exportación");
    const steps = screen.getByLabelText(/¿Qué intentabas hacer\?/) as HTMLTextAreaElement;
    expect(steps.value).toBe(STEPS_TEMPLATE);
    expect(steps.value).toContain("Esperaba que…");
    expect(screen.getByLabelText("Severidad")).toBeTruthy();
    expect(screen.getByLabelText("Incluir medios pequeños")).toBeTruthy();
    expect(screen.getByText(/1 trabajo\(s\) fallido\(s\)/)).toBeTruthy();

    fireEvent.change(steps, { target: { value: "1. Exporté\nEsperaba un MP4\nPasó: error" } });
    fireEvent.click(screen.getByLabelText("Incluir medios pequeños"));
    fireEvent.click(screen.getByRole("button", { name: /Generar reporte/ }));

    await waitFor(() => expect(screen.getByTestId("report-result")).toBeTruthy());
    const body = create.mock.calls[0]![0];
    expect(body.title).toBe("Falló: Exportación");
    expect(body.jobIds).toEqual(["job-9"]);
    expect(body.includeMedia).toBe(true);
    expect(body.steps).toContain("Exporté");
    expect(body.projectId).toBe(useProjectStore.getState().project.id);
    expect(body.uiBreadcrumbs?.some((b) => b.message === "Abrió el panel Exportar")).toBe(true);
    expect(body.uiState).toHaveProperty("browser");
    expect(body.uiState).toHaveProperty("settings");
    expect((body.uiState!.settings as Record<string, unknown>).layout).toBeUndefined();

    expect(screen.getByRole("button", { name: /Copiar prompt para Claude/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Descargar \.zip/ })).toBeTruthy();
    expect(screen.getByText(response.dir)).toBeTruthy();
    expect(screen.getByText(/Hola Claude/)).toBeTruthy();
  });

  it("requires a title and shows api errors with the offline fallback", async () => {
    vi.spyOn(api, "createReport").mockRejectedValue(new Error("Sin conexión con la API"));
    act(() => openReport());
    render(<ReportDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Generar reporte/ }));
    expect(screen.getByText(/Escribí un título corto/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Título"), { target: { value: "No exporta" } });
    fireEvent.click(screen.getByRole("button", { name: /Generar reporte/ }));
    await waitFor(() => expect(screen.getByText(/No se pudo generar el reporte/)).toBeTruthy());
    expect(screen.getByText(/reportar-error\.cmd/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copiar diagnóstico del navegador/ })).toBeTruthy();
  });
});

describe("entry points", () => {
  it("offers 'Reportar' on failed jobs, prefilled with that job", () => {
    useJobsStore.setState({ jobs: { j1: failedJob("j1") } });
    render(<JobsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Reportar error de este trabajo" }));
    const s = useReportStore.getState();
    expect(s.open).toBe(true);
    expect(s.prefill.jobIds).toEqual(["j1"]);
    expect(s.prefill.title).toBe("Falló: Exportación");
  });

  it("the error boundary replaces a crash with a 'Reportar error' screen", () => {
    const Boom = () => {
      throw new Error("render roto");
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByText("Algo salió mal en Studio")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reportar error/ }));
    const s = useReportStore.getState();
    expect(s.open).toBe(true);
    expect(s.prefill.clientError?.message).toContain("render roto");
    expect(getBreadcrumbs().some((c) => c.category === "error")).toBe(true);
  });
});
